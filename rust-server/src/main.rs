mod preview_summary;
mod preview;
mod bounded;
mod completion_window;
mod detector;
mod antigravity_lifecycle;
mod diagnostics;
mod metrics;
use axum::{
    body::to_bytes,
    extract::{Path as UrlPath, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    convert::Infallible,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, sync::broadcast};
pub(crate) fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
#[derive(Clone)]
struct Config {
    port: u16,
    runtime: PathBuf,
    hooks: PathBuf,
    codex: PathBuf,
    claude: PathBuf,
    web: PathBuf,
    root: PathBuf,
    python: PathBuf,
    usage_source: Option<String>,
    public_origin: Option<String>,
}
#[derive(Clone)]
struct Replay {
    revision: u64,
    payload: String,
}
struct Shared {
    completions: completion_window::CompletionWindow,
    completion_clock: Instant,
    instance: String,
    revision: u64,
    seq: u64,
    state: Value,
    last: Value,
    details: Vec<Value>,
    history: VecDeque<Arc<Replay>>,
}
impl Shared {
    fn new() -> Self {
        let instance = uuid::Uuid::new_v4().simple().to_string();
        let details=["codex","claude","antigravity"].into_iter().map(|p|json!({"provider":p,"status":"loading","windows":[],"observed_at":null,"error":null})).collect::<Vec<_>>();
        Self {
            completions: completion_window::CompletionWindow::default(),
            completion_clock: Instant::now(),
            state: json!({"instance":instance,"seq":0,"events":[],"snapshot":{"schema":1,"at":0,"sessions":[],"errors":[]},"collector_error":false,"usage":details,"system":{"status":"loading","observed_at":null,"cpu_percent":null},"system_history":[],"completion_window":{"schema":1,"seconds":1800,"as_of":now(),"coverage_since":null,"partial":true,"reasons":["warming_up"],"entries":[]}}),
            last: Value::Null,
            details,
            instance,
            revision: 0,
            seq: 0,
            history: VecDeque::new(),
        }
    }
    fn identifier(&self) -> String {
        format!("{}:{}", self.instance, self.revision)
    }
    fn snapshot(&self) -> Value {
        let mut state = self.state.clone();
        state["stream_id"] = json!(self.identifier());
        state["server_time"] = json!(now());
        state
    }
    fn publish(&mut self) -> Option<Arc<Replay>> {
        self.state["usage"] = summarize_usage(&self.details);
        let mut patch = json!({});
        if self.last.is_null() {
            patch = self.state.clone();
        } else {
            for key in ["usage", "system", "events", "seq", "collector_error", "completion_window"] {
                if self.last[key] != self.state[key] {
                    patch[key] = self.state[key].clone();
                }
            }
            if self.last["system_history"] != self.state["system_history"] {
                let before = self.last["system_history"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let points = self.state["system_history"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let upsert: Vec<_> = points
                    .iter()
                    .filter(|p| !before.iter().any(|b| b["at"] == p["at"] && b == *p))
                    .cloned()
                    .collect();
                patch["system_history_change"] = json!({"upsert":upsert,"after":points.first().map(|p|p["at"].clone()),"through":points.last().map(|p|p["at"].clone())});
            }
            let old = &self.last["snapshot"];
            let new = &self.state["snapshot"];
            if old["sessions"] != new["sessions"] || old["errors"] != new["errors"] {
                let before = old["sessions"].as_array().cloned().unwrap_or_default();
                let current = new["sessions"].as_array().cloned().unwrap_or_default();
                let key = |r: &Value| {
                    format!(
                        "{}:{}",
                        r["provider"].as_str().unwrap_or(""),
                        r["session_id"].as_str().unwrap_or("")
                    )
                };
                let upsert: Vec<_> = current
                    .iter()
                    .filter(|r| !before.iter().any(|b| key(b) == key(r) && b == *r))
                    .cloned()
                    .collect();
                let remove: Vec<_> = before
                    .iter()
                    .filter(|r| !current.iter().any(|c| key(c) == key(r)))
                    .map(|r| json!([r["provider"], r["session_id"]]))
                    .collect();
                patch["session_changes"] =
                    json!({"upsert":upsert,"remove":remove,"at":new["at"],"errors":new["errors"]});
            } else if old["at"] != new["at"] {
                patch["snapshot_at"] = new["at"].clone();
            }
        }
        if patch.as_object().is_some_and(|m| m.is_empty()) {
            return None;
        }
        self.revision += 1;
        let replay = Arc::new(Replay {
            revision: self.revision,
            payload: patch.to_string(),
        });
        self.history.push_back(replay.clone());
        while self.history.len() > 256 {
            self.history.pop_front();
        }
        self.last = self.state.clone();
        Some(replay)
    }
    fn messages(&self, cursor: Option<&str>) -> Vec<(String, u64, String)> {
        let revision = cursor
            .and_then(|c| c.rsplit_once(':'))
            .filter(|(i, _)| *i == self.instance)
            .and_then(|(_, r)| r.parse::<u64>().ok())
            .filter(|r| {
                *r <= self.revision
                    && self
                        .history
                        .front()
                        .is_none_or(|f| r.saturating_add(1) >= f.revision)
            });
        match revision {
            None => vec![("reset".into(), self.revision, self.snapshot().to_string())],
            Some(r) => self
                .history
                .iter()
                .filter(|v| v.revision > r)
                .map(|v| ("patch".into(), v.revision, v.payload.clone()))
                .collect(),
        }
    }
    fn events(&mut self, events: Vec<Value>) {
        let mut assigned = Vec::new();
        let mut existing = self.state["events"].as_array().cloned().unwrap_or_default();
        for mut e in events {
            self.seq += 1;
            e["seq"] = json!(self.seq);
            e["id"] = json!(format!("{}:{}", self.instance, self.seq));
            assigned.push(e.clone());
            existing.push(e);
        }
        if existing.len() > 200 {
            existing.drain(..existing.len() - 200);
        }
        self.state["events"] = json!(existing);
        self.state["seq"] = json!(self.seq);
        self.refresh_completions(&assigned);
    }
    fn refresh_completions(&mut self, events: &[Value]) {
        let healthy = !self.state["collector_error"].as_bool().unwrap_or(true);
        let source_error = self.state["snapshot"]["errors"].as_array().is_some_and(|e| !e.is_empty());
        self.state["completion_window"] = self.completions.update(now(), self.completion_clock.elapsed().as_secs_f64(), events, healthy, source_error);
    }
}
fn refresh_details(details: &mut [Value]) {
    let now = now();
    for row in details {
        let old = row["observed_at"]
            .as_f64()
            .is_some_and(|at| now - at > 600.);
        let error = !row["error"].is_null();
        if old && row["status"] == "ok" {
            row["status"] = json!("stale");
        }
        let mut any_stale = false;
        if let Some(windows) = row["windows"].as_array_mut() {
            for w in windows {
                let today = ((now + 10800.) / 86400.).floor() * 86400. - 10800.;
                if w["daily"]["day_start"]
                    .as_f64()
                    .is_some_and(|start| start != today)
                {
                    w["daily"] = json!({"status":"waiting"});
                }
                // Windows kept by a partial merge carry their own observation time.
                let kept_old = w["observed_at"].as_f64().is_some_and(|at| now - at > 600.);
                let stale = old
                    || kept_old
                    || error
                    || w["resets_at"].as_f64().is_some_and(|at| at <= now);
                any_stale |= stale;
                w["stale"] = json!(stale);
                if stale && w["daily"]["status"] == "ok" {
                    w["daily"]["status"] = json!("delayed");
                }
                if w["resets_at"].as_f64().is_some_and(|at| at <= now) && w["daily"].is_object() {
                    w["daily"]["recommended"] = Value::Null;
                    w["daily"]["available"] = Value::Null;
                    w["daily"]["gauge_baseline"] = Value::Null;
                }
            }
        }
        if any_stale {
            row["status"] = json!("stale");
        }
    }
}
fn summarize_usage(details: &[Value]) -> Value {
    let mut rows = details.to_vec();
    refresh_details(&mut rows);
    for r in &mut rows {
        r.as_object_mut().map(|m| m.remove("checked_at"));
        if let Some(ws) = r["windows"].as_array_mut() {
            for w in ws {
                if w["daily"].is_object() {
                    let d = &w["daily"];
                    let used = d["segments"]
                        .as_array()
                        .and_then(|s| s.last())
                        .map(|s| s["used"].clone());
                    let mut map = serde_json::Map::new();
                    for key in [
                        "status",
                        "used",
                        "recommended",
                        "available",
                        "partial",
                        "missing",
                        "storage_error",
                        "gauge_baseline",
                        "gauge_used",
                    ] {
                        if let Some(v) = d.get(key) {
                            map.insert(key.into(), v.clone());
                        }
                    }
                    if let Some(used) = used {
                        map.insert("gauge_used".into(), used);
                    }
                    w["daily"] = Value::Object(map);
                }
            }
        }
    }
    json!(rows)
}
#[derive(Clone)]
struct App {
    config: Config,
    shared: Arc<RwLock<Shared>>,
    updates: broadcast::Sender<Arc<Replay>>,
    diag: Arc<diagnostics::Diagnostics>,
    stop: Arc<AtomicBool>,
    children: Arc<Mutex<HashSet<i32>>>,
}
impl App {
    fn update(&self, f: impl FnOnce(&mut Shared)) {
        let mut s = self.shared.write().unwrap();
        f(&mut s);
        if let Some(v) = s.publish() {
            let _ = self.updates.send(v);
        }
    }
}
fn response(code: u16) -> Response {
    StatusCode::from_u16(code)
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
        .into_response()
}
async fn security(State(app): State<App>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host != format!("127.0.0.1:{}", app.config.port)
        && host != format!("localhost:{}", app.config.port)
    {
        return response(403);
    }
    let mut res = next.run(request).await;
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "*, Authorization".parse().unwrap(),
    );
    let streaming = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    h.insert(
        header::CACHE_CONTROL,
        if streaming {
            "no-store, no-transform"
        } else {
            "no-store"
        }
        .parse()
        .unwrap(),
    );
    if streaming {
        h.insert("x-accel-buffering", "no".parse().unwrap());
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert(header::CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://api.open-meteo.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'".parse().unwrap());
    res
}
async fn health() -> Json<Value> {
    Json(json!({"status":"ok","implementation":"rust"}))
}
async fn state(State(app): State<App>) -> Json<Value> {
    Json(app.shared.read().unwrap().snapshot())
}
async fn usage(State(app): State<App>, UrlPath(provider): UrlPath<String>) -> Response {
    let mut rows = app.shared.read().unwrap().details.clone();
    refresh_details(&mut rows);
    match rows.into_iter().find(|r| r["provider"] == provider) {
        Some(v) => Json(v).into_response(),
        None => response(404),
    }
}
async fn static_file(State(app): State<App>, request: Request) -> Response {
    if request.method() == axum::http::Method::OPTIONS {
        return response(204);
    }
    let name = match request.uri().path() {
        "/" => "index.html",
        "/favicon.ico" => return response(204),
        p => p.trim_start_matches('/'),
    };
    let content = match name {
        "index.html" => "text/html; charset=utf-8",
        "app.js" | "weather.js" | "theme.js" | "diagnostics.js" | "clock.js" | "workshop.js" | "folder-board.js" => {
            "text/javascript; charset=utf-8"
        }
        "style.css" | "weather.css" | "workshop.css" => "text/css; charset=utf-8",
        "fonts/neodgm.woff2" => "font/woff2",
        "fonts/OFL.txt" => "text/plain; charset=utf-8",
        _ => return response(404),
    };
    match fs::read(app.config.web.join(name)) {
        Ok(bytes) => ([(header::CONTENT_TYPE, content)], bytes).into_response(),
        Err(_) => response(404),
    }
}
async fn diag_read(
    State(app): State<App>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let limit = match query.get("limit") {
        Some(v) => match v.parse::<i64>() {
            Ok(n) => n.clamp(1, 1000) as usize,
            Err(_) => return response(400),
        },
        None => 200,
    };
    match tokio::task::spawn_blocking(move || app.diag.read(limit)).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(code)) => response(code),
        Err(_) => response(503),
    }
}
async fn diag_post(State(app): State<App>, request: Request) -> Response {
    let headers = request.headers();
    if let Some(origin) = headers.get(header::ORIGIN) {
        let Ok(origin) = origin.to_str() else {
            return response(403);
        };
        if origin != format!("http://127.0.0.1:{}", app.config.port)
            && origin != format!("http://localhost:{}", app.config.port)
            && app.config.public_origin.as_deref() != Some(origin)
        {
            return response(403);
        }
    }
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        != Some("application/json")
    {
        return response(415);
    }
    if headers.contains_key(header::TRANSFER_ENCODING) {
        return response(400);
    }
    let len = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    if len == 0 || len > 65536 {
        return response(413);
    }
    let body =
        match tokio::time::timeout(Duration::from_secs(3), to_bytes(request.into_body(), 65536))
            .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return response(400),
            Err(_) => return response(408),
        };
    if body.len() != len {
        return response(400);
    }
    let value = match serde_json::from_slice::<Value>(&body) {
        Ok(v) => v,
        Err(_) => return response(400),
    };
    match tokio::task::spawn_blocking(move || app.diag.ingest(value)).await {
        Ok(Ok(ack)) => Json(json!({"ack":ack})).into_response(),
        Ok(Err(code)) => response(code),
        Err(_) => response(503),
    }
}
/// Shared HTTPS origin from LM_PUBLIC_ORIGIN or the untracked local share config.
fn public_origin(root: &std::path::Path) -> Option<String> {
    if let Ok(v) = std::env::var("LM_PUBLIC_ORIGIN") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    let raw = fs::read(root.join("deploy/cloudflare/config.json")).ok()?;
    let host = serde_json::from_slice::<Value>(&raw).ok()?["hostname"]
        .as_str()?
        .to_owned();
    (!host.is_empty()).then(|| format!("https://{host}"))
}
fn event(kind: &str, id: Option<String>, payload: &str) -> Event {
    let mut content = serde_json::from_str::<Value>(payload).unwrap_or_else(|_| json!({}));
    content["server_time"] = json!(now());
    let e = Event::default().event(kind).data(content.to_string());
    if let Some(id) = id {
        e.id(id)
    } else {
        e
    }
}

async fn stream(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let mut receiver = app.updates.subscribe();
    let cursor = headers
        .get("Last-Event-ID")
        .and_then(|s| s.to_str().ok())
        .or(query.get("cursor").map(String::as_str))
        .map(str::to_owned);
    let initial = app.shared.read().unwrap().messages(cursor.as_deref());
    let instance = app.shared.read().unwrap().instance.clone();
    let output = async_stream::stream! {let mut revision=cursor.as_deref().and_then(|c|c.rsplit_once(':')).and_then(|(_,r)|r.parse::<u64>().ok()).unwrap_or(0);for(kind,r,payload)in initial{revision=r;yield Ok::<Event,Infallible>(event(&kind,Some(format!("{instance}:{r}")),&payload).retry(Duration::from_secs(3)));}
    loop{if app.stop.load(Ordering::Relaxed){break}match tokio::time::timeout(Duration::from_secs(10),receiver.recv()).await{
    Ok(Ok(v))=>{if v.revision>revision{revision=v.revision;yield Ok(event("patch",Some(format!("{instance}:{revision}")),&v.payload));}},Ok(Err(broadcast::error::RecvError::Lagged(_)))=>{let(snapshot,r)={let s=app.shared.read().unwrap();(s.snapshot(),s.revision)};revision=r;yield Ok(event("reset",Some(format!("{instance}:{revision}")),&snapshot.to_string()));},Ok(Err(_))=>break,Err(_)=>yield Ok(event("heartbeat",None,&json!({"at":now()}).to_string()))}
    }};
    Sse::new(output)
}
fn private_save(path: &Path, value: &Value) -> std::io::Result<()> {
    fs::create_dir_all(path.parent().unwrap())?;
    let temp = path.with_extension("tmp");
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temp)?;
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    f.write_all(value.to_string().as_bytes())?;
    f.sync_all()?;
    fs::rename(temp, path)
}
fn background(app: &App) {
    let a = app.clone();
    std::thread::spawn(move || {
        let mut detector = detector::Detector::new(
            Some(a.config.codex.clone()),
            a.config.claude.clone(),
            a.config.hooks.clone(),
        );
        let mut saved = Value::Null;
        let mut saved_at = Instant::now() - Duration::from_secs(61);
        while !a.stop.load(Ordering::Relaxed) {
            let (mut snapshot, events) = detector.full();
            preview_summary::apply(&mut snapshot, &a.config.runtime.join("preview-summaries.json"), now());
            let mut content = snapshot.clone();
            content.as_object_mut().map(|m| m.remove("at"));
            let persist = if content != saved || saved_at.elapsed() >= Duration::from_secs(60) {
                let result = private_save(&a.config.runtime.join("snapshot.json"), &snapshot);
                if result.is_ok() {
                    saved = content;
                    saved_at = Instant::now();
                }
                result.is_ok()
            } else {
                true
            };
            if persist {
                let logfile = a.config.runtime.join("events.jsonl");
                let mut storage_ok = true;
                if !events.is_empty() {
                    if let Ok(mut f) = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .mode(0o600)
                        .open(logfile)
                    {
                        for e in &events {
                            if writeln!(f, "{e}").is_err() {
                                storage_ok = false
                            }
                        }
                    } else {
                        storage_ok = false
                    }
                }
                a.update(|s| {
                    s.state["snapshot"] = snapshot;
                    s.state["collector_error"] = json!(!storage_ok);
                    s.events(events);
                });
            } else {
                a.update(|s| { s.state["collector_error"] = json!(true); s.refresh_completions(&[]); });
            }
            for _ in 0..25 {
                if a.stop.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    });
    let a = app.clone();
    std::thread::spawn(move || {
        let mut m = metrics::Metrics::new();
        while !a.stop.load(Ordering::Relaxed) {
            m.sample();
            a.update(|s| {
                s.state["system"] = m.value.clone();
                s.state["system_history"] = json!(m.history);
            });
            for _ in 0..50 {
                if a.stop.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    });
}
/// Bucket id prefix decides the family so model buckets (e.g. Argon) sit with it.
fn antigravity_names(key: &str) -> (String, Option<String>) {
    for (prefix, family) in [("gemini-", "Gemini"), ("3p-", "Claude · GPT")] {
        if let Some(rest) = key.strip_prefix(prefix) {
            let model = rest.split('-').next().unwrap_or("");
            let name = (!model.is_empty() && model != "weekly" && model != "5h").then(|| {
                let mut c = model.chars();
                c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
            });
            return (family.into(), name);
        }
    }
    (key.chars().take(100).collect(), None)
}
/// Update matching ids in place order; keep the rest with their own observation time.
fn merge_windows(current: &[Value], fresh: Vec<Value>, current_at: &Value) -> Vec<Value> {
    let mut fresh: Vec<Option<Value>> = fresh.into_iter().map(Some).collect();
    let mut out = Vec::new();
    for w in current {
        let found = fresh.iter_mut().find(|n| n.as_ref().is_some_and(|n| n["id"] == w["id"]));
        match found.and_then(Option::take) {
            None => {
                let mut kept = w.clone();
                if kept["observed_at"].is_null() {
                    kept["observed_at"] = current_at.clone();
                }
                out.push(kept);
            }
            Some(mut new) => {
                // statusLine has no CLI display names; keep the ones /usage supplied.
                for k in ["group", "name"] {
                    if !w[k].is_null() {
                        new[k] = w[k].clone();
                    }
                }
                out.push(new);
            }
        }
    }
    out.extend(fresh.into_iter().flatten());
    out
}
fn passive_usage(app: &App) {
    let path = app.config.hooks.join("usage-antigravity.json");
    let Ok(raw) = fs::read(path) else { return };
    if raw.len() > 1024 * 1024 {
        return;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&raw) else {
        return;
    };
    let Some(at) = payload["observed_at"]
        .as_f64()
        .filter(|at| *at > 0. && *at <= now() + 60.)
    else {
        return;
    };
    let mut state = app.shared.write().unwrap();
    let Some(row) = state
        .details
        .iter_mut()
        .find(|r| r["provider"] == "antigravity")
    else {
        return;
    };
    // Unattributed statusLine samples cannot replace account-bound daily usage.
    if row["account_bound"].as_bool() == Some(true) {
        return;
    }
    if row["observed_at"].as_f64().is_some_and(|old| old >= at) {
        return;
    }
    let Some(quota) = payload["quota"].as_object() else {
        return;
    };
    let mut windows = Vec::new();
    for (key, raw) in quota {
        let Some(fraction) = raw["remaining_fraction"]
            .as_f64()
            .filter(|x| *x >= 0. && *x <= 1.)
        else {
            continue;
        };
        let reset = raw["reset_time"].as_f64().or_else(|| {
            raw["reset_time"].as_str().and_then(|s| {
                chrono::DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|v| v.timestamp_millis() as f64 / 1000.)
            })
        });
        let remaining = (fraction * 10000.).round() / 100.;
        let (group, name) = antigravity_names(key);
        let mut w = json!({"id":key,"label":if key.contains("weekly"){"주간"}else if key.contains("5h"){"5시간"}else{"한도"},"used_percent":100.-remaining,"remaining_percent":remaining,"resets_at":reset,"group":group,"daily":{"status":"account_unknown"}});
        if let Some(name) = name {
            w["name"] = json!(name);
        }
        windows.push(w);
    }
    if !windows.is_empty() {
        // statusLine carries a subset of /usage buckets; keep the rest.
        let current = row["windows"].as_array().cloned().unwrap_or_default();
        row["windows"] = json!(merge_windows(&current, windows, &row["observed_at"]));
        row["observed_at"] = json!(at);
        row["error"] = Value::Null;
        row["status"] = json!("ok");
        if let Some(v) = state.publish() {
            let _ = app.updates.send(v);
        }
    }
}
async fn adapter(app: &App) -> Result<Vec<Value>, String> {
    let mut command = tokio::process::Command::new(&app.config.python);
    command
        .args(["-m", "local_monitor.rust_usage_adapter", "--runtime"])
        .arg(&app.config.runtime)
        .arg("--codex-home")
        .arg(&app.config.codex)
        .arg("--claude-home")
        .arg(&app.config.claude)
        .current_dir(&app.config.root)
        .env("LOCAL_MONITOR_AGY_USAGE", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn().map_err(|_| "adapter_unavailable")?;
    let pid = child.id().ok_or("adapter_unavailable")? as i32;
    app.children.lock().unwrap().insert(pid);
    let out = child.stdout.take().ok_or("adapter_unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        let mut bytes = Vec::new();
        let mut reader = out.take(2 * 1024 * 1024 + 1);
        let (status, read) = tokio::join!(child.wait(), reader.read_to_end(&mut bytes));
        read.map_err(|_| "adapter_failed")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("adapter_output_limit");
        }
        let status = status.map_err(|_| "adapter_failed")?;
        if !status.success() {
            return Err("adapter_failed");
        }
        let rows = serde_json::from_slice::<Vec<Value>>(&bytes).map_err(|_| "adapter_failed")?;
        if rows.len() != 3
            || rows
                .iter()
                .any(|r| !r["provider"].is_string() || !r["windows"].is_array())
        {
            return Err("adapter_invalid");
        }
        Ok(rows)
    })
    .await;
    if result.is_err() {
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    // Own process group: reap any private descendants even after adapter exit.
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    app.children.lock().unwrap().remove(&pid);
    match result {
        Ok(Ok(rows)) => Ok(rows),
        Ok(Err(e)) => Err(e.into()),
        Err(_) => Err("adapter_timeout".into()),
    }
}
async fn usage_worker(app: App) {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let mut retry_at = 0.;
    let mut fallback = 30.;
    let mut bridged_at = 0.;
    while !app.stop.load(Ordering::Relaxed) {
        passive_usage(&app);
        if let Some(source) = &app.config.usage_source {
            if now() - bridged_at >= 10. {
                let mut rows = Vec::new();
                for provider in ["codex", "claude", "antigravity"] {
                    if let Ok(reply) = client
                        .get(format!(
                            "{}/api/usage/{provider}",
                            source.trim_end_matches('/')
                        ))
                        .send()
                        .await
                    {
                        if reply.status().is_success() {
                            if let Ok(v) = reply.json::<Value>().await {
                                rows.push(v);
                            }
                        }
                    }
                }
                if rows.len() == 3 {
                    app.update(|s| s.details = rows);
                } else {
                    app.update(|s| {
                        for row in &mut s.details {
                            row["error"] = json!("usage_bridge_unavailable");
                            row["status"] = json!(if row["windows"]
                                .as_array()
                                .is_some_and(|w| !w.is_empty())
                            {
                                "stale"
                            } else {
                                "unavailable"
                            });
                        }
                    });
                }
                bridged_at = now();
            }
        } else {
            let due = app
                .shared
                .read()
                .unwrap()
                .details
                .iter()
                .any(|r| r["next_retry_at"].as_f64().is_none_or(|at| at <= now()));
            if due && now() >= retry_at {
                match adapter(&app).await {
                    Ok(rows) => {
                        app.update(|s| s.details = rows);
                        fallback = 30.;
                        retry_at = now() + 5.;
                    }
                    Err(_) => {
                        app.update(|s| {
                            for row in &mut s.details {
                                row["error"] = json!("usage_adapter_failed");
                                row["status"] = json!(if row["windows"]
                                    .as_array()
                                    .is_some_and(|w| !w.is_empty())
                                {
                                    "stale"
                                } else {
                                    "unavailable"
                                });
                            }
                        });
                        retry_at = now() + fallback;
                        fallback = (fallback * 2.).min(600.);
                    }
                }
            }
        }
        for _ in 0..5 {
            if app.stop.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}
fn config() -> Result<Config, String> {
    let args: Vec<_> = std::env::args().collect();
    let opt = |key: &str| {
        args.iter()
            .position(|s| s == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let root = std::env::current_dir().map_err(|_| "cwd unavailable")?;
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "home unavailable")?);
    let port = opt("--port")
        .unwrap_or("3011".into())
        .parse::<u16>()
        .map_err(|_| "invalid port")?;
    if port < 1024 {
        return Err("invalid port".into());
    }
    let usage_source = opt("--usage-source");
    if let Some(source) = &usage_source {
        let url = reqwest::Url::parse(source).map_err(|_| "invalid usage source")?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("usage source must be loopback HTTP".into());
        }
    }
    let runtime = PathBuf::from(
        opt("--runtime")
            .unwrap_or_else(|| root.join(".runtime/rust-qa").to_string_lossy().into_owned()),
    );
    Ok(Config {
        port,
        hooks: PathBuf::from(
            opt("--hooks-runtime")
                .unwrap_or_else(|| root.join(".runtime").to_string_lossy().into_owned()),
        ),
        runtime,
        codex: PathBuf::from(
            opt("--codex-home")
                .unwrap_or_else(|| home.join(".codex").to_string_lossy().into_owned()),
        ),
        claude: PathBuf::from(
            opt("--claude-home")
                .unwrap_or_else(|| home.join(".claude").to_string_lossy().into_owned()),
        ),
        web: root.join("local_monitor/web"),
        public_origin: public_origin(&root),
        root,
        python: PathBuf::from(opt("--python").unwrap_or("python3".into())),
        usage_source,
    })
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("Rust server error: {e}");
        std::process::exit(1)
    }
}
async fn run() -> Result<(), String> {
    let config = config()?;
    fs::create_dir_all(&config.runtime).map_err(|_| "runtime unavailable")?;
    fs::set_permissions(&config.runtime, fs::Permissions::from_mode(0o700))
        .map_err(|_| "runtime unavailable")?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .mode(0o600)
        .open(config.runtime.join("monitor.lock"))
        .map_err(|_| "monitor lock unavailable")?;
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("another monitor owns runtime".into());
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port))
        .await
        .map_err(|_| "port unavailable")?;
    let (updates, _) = broadcast::channel(256);
    let mut shared = Shared::new();
    if config.usage_source.is_none() {
        if let Ok(raw) = fs::read(config.runtime.join("rust/usage-state.json")) {
            if let Ok(v) = serde_json::from_slice::<Value>(&raw) {
                if let Some(rows) = v["rows"].as_array().filter(|r| r.len() == 3) {
                    shared.details = rows.clone();
                }
            }
        }
    }
    let app = App {
        diag: Arc::new(diagnostics::Diagnostics::new(
            config.runtime.join("client-diagnostics.sqlite"),
        )),
        config,
        shared: Arc::new(RwLock::new(shared)),
        updates,
        stop: Arc::new(AtomicBool::new(false)),
        children: Arc::new(Mutex::new(HashSet::new())),
    };
    let retention = app.clone();
    tokio::spawn(async move {
        while !retention.stop.load(Ordering::Relaxed) {
            let d = retention.diag.clone();
            let _ = tokio::task::spawn_blocking(move || d.read(1)).await;
            for _ in 0..3600 {
                if retention.stop.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    });
    background(&app);
    let task = tokio::spawn(usage_worker(app.clone()));
    let router = Router::new()
        .route("/health", get(health))
        .route("/api/state", get(state))
        .route("/api/usage/{provider}", get(usage))
        .route("/api/stream", get(stream))
        .route(
            "/api/diagnostics",
            get(diag_read)
                .post(diag_post)
                .options(|| async { StatusCode::NO_CONTENT }),
        )
        .fallback(static_file)
        .layer(middleware::from_fn_with_state(app.clone(), security))
        .with_state(app.clone());
    println!(
        "Local Monitor Rust: http://127.0.0.1:{} (5s detection)",
        app.config.port
    );
    let shutdown = app.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let mut terminate=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
            let mut hangup=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()).expect("signal handler");
            tokio::select!{_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{},_=hangup.recv()=>{}}
            shutdown.stop.store(true, Ordering::Relaxed);
            let _=shutdown.updates.send(Arc::new(Replay{revision:0,payload:"{}".into()}));
            let groups:Vec<_>=shutdown.children.lock().unwrap().iter().copied().collect();
            for pid in &groups {unsafe { libc::kill(-*pid, libc::SIGTERM) };}
            tokio::time::sleep(Duration::from_millis(200)).await;
            let owned=shutdown.children.lock().unwrap();
            for pid in groups {if owned.contains(&pid){unsafe{libc::kill(-pid,libc::SIGKILL)};}}
        })
        .await
        .map_err(|_| "HTTP server failed")?;
    app.stop.store(true, Ordering::Relaxed);
    task.abort();
    drop(lock);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_window_survives_notification_cap_and_replays() {
        let mut s = Shared::new();
        s.publish();
        let cursor = s.identifier();
        let at = now();
        s.events((0..201).map(|i|json!({"provider":"codex","session_id":"same","turn_id":i.to_string(),"at":at})).collect());
        s.publish();
        assert_eq!(s.state["events"].as_array().unwrap().len(),200);
        assert_eq!(s.state["completion_window"]["entries"].as_array().unwrap().len(),201);
        let patch: Value=serde_json::from_str(&s.messages(Some(&cursor))[0].2).unwrap();
        assert_eq!(patch["completion_window"],s.state["completion_window"]);
        let reset: Value=serde_json::from_str(&s.messages(None)[0].2).unwrap();
        assert_eq!(reset["completion_window"],patch["completion_window"]);
    }
    #[test]
    fn replay_and_summary() {
        let mut s = Shared::new();
        s.publish();
        assert_eq!(s.messages(None)[0].0, "reset");
        let cursor = s.identifier();
        s.state["snapshot"]["at"] = json!(1);
        s.publish();
        assert_eq!(s.messages(Some(&cursor))[0].0, "patch");
        for i in 2..270 {
            s.state["snapshot"]["at"] = json!(i);
            s.publish();
        }
        assert_eq!(s.history.len(), 256);
        assert_eq!(s.messages(Some(&cursor))[0].0, "reset");
        let rows = vec![
            json!({"provider":"codex","error":null,"observed_at":now(),"checked_at":1,"windows":[{"resets_at":now()+1000.,"daily":{"status":"ok","used":1,"recommended":5,"segments":[{"used":1}],"day_start":((now()+10800.)/86400.).floor()*86400.-10800.,"gauge_baseline":95}}]}),
        ];
        let summary = summarize_usage(&rows);
        assert!(summary[0].get("checked_at").is_none());
        assert!(summary[0]["windows"][0]["daily"].get("segments").is_none());
        assert_eq!(summary[0]["windows"][0]["daily"]["gauge_used"], 1);
        assert!(rows[0]["windows"][0]["daily"]["segments"].is_array());
    }
}
#[cfg(test)]
mod adapter_cleanup_tests {
    use super::*;
    #[tokio::test]
    async fn adapter_reaps_its_private_descendants() {
        let root = std::env::temp_dir().join(format!("rust-adapter-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let script = root.join("fake-python");
        let pidfile = root.join("child.pid");
        let body=format!("#!/bin/sh\nsleep 60 </dev/null >/dev/null 2>&1 &\necho $! > '{}'\nprintf '%s\\n' '[{{\"provider\":\"codex\",\"windows\":[]}},{{\"provider\":\"claude\",\"windows\":[]}},{{\"provider\":\"antigravity\",\"windows\":[]}}]'\n",pidfile.display());
        fs::write(&script, body).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let (updates, _) = broadcast::channel(256);
        let app = App {
            config: Config {
                port: 3012,
                runtime: root.clone(),
                hooks: root.clone(),
                codex: root.clone(),
                claude: root.clone(),
                web: root.clone(),
                root: root.clone(),
                python: script,
                usage_source: None,
                public_origin: None,
            },
            shared: Arc::new(RwLock::new(Shared::new())),
            updates,
            diag: Arc::new(diagnostics::Diagnostics::new(root.join("diag"))),
            stop: Arc::new(AtomicBool::new(false)),
            children: Arc::new(Mutex::new(HashSet::new())),
        };
        assert_eq!(adapter(&app).await.unwrap().len(), 3);
        let pid = fs::read_to_string(pidfile)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let status =
            bounded::text("ps", &["-p", &pid.to_string(), "-o", "stat="]).unwrap_or_default();
        let running = !status.trim().is_empty() && !status.trim().starts_with('Z');
        if running {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = fs::remove_dir_all(root);
        assert!(!running, "private child was not reaped");
        assert!(app.children.lock().unwrap().is_empty());
    }
}
#[cfg(test)]
mod quota_boundary_tests {
    use super::*;
    #[test]
    fn antigravity_family_names_and_partial_merge() {
        assert_eq!(antigravity_names("gemini-5h"), ("Gemini".into(), None));
        assert_eq!(
            antigravity_names("gemini-argon-wtu-weekly"),
            ("Gemini".into(), Some("Argon".into()))
        );
        assert_eq!(antigravity_names("3p-weekly"), ("Claude · GPT".into(), None));
        assert_eq!(antigravity_names("other-weekly"), ("other-weekly".into(), None));
        let old = now() - 900.;
        let current = vec![
            json!({"id":"gemini-weekly","group":"Gemini","remaining_percent":90}),
            json!({"id":"gemini-argon-wtu-weekly","group":"Gemini","name":"Argon","remaining_percent":0,"resets_at":now()+1000.}),
            json!({"id":"x-weekly","group":"CLI 이름","remaining_percent":50}),
        ];
        let fresh = vec![
            json!({"id":"x-weekly","group":"x-weekly","remaining_percent":40}),
            json!({"id":"gemini-weekly","group":"Gemini","remaining_percent":80}),
        ];
        let merged = merge_windows(&current, fresh, &json!(old));
        let ids: Vec<_> = merged.iter().map(|w| w["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["gemini-weekly", "gemini-argon-wtu-weekly", "x-weekly"]);
        assert_eq!(merged[0]["remaining_percent"], 80);
        assert!(merged[0]["observed_at"].is_null());
        assert_eq!(merged[1]["observed_at"], json!(old));
        assert_eq!(merged[2]["group"], "CLI 이름");
        let mut rows = vec![json!({"provider":"antigravity","status":"ok","error":null,"observed_at":now(),"windows":merged})];
        refresh_details(&mut rows);
        assert_eq!(rows[0]["windows"][0]["stale"], false);
        assert_eq!(rows[0]["windows"][1]["stale"], true);
        assert_eq!(rows[0]["status"], "stale");
    }
    #[test]
    fn expired_window_warns_and_hides_budget() {
        let today = ((now() + 10800.) / 86400.).floor() * 86400. - 10800.;
        let mut rows = vec![
            json!({"provider":"codex","status":"ok","error":null,"observed_at":now(),"windows":[{"resets_at":now()-1.,"daily":{"status":"ok","day_start":today,"recommended":10,"available":8,"gauge_baseline":95}}]}),
        ];
        refresh_details(&mut rows);
        assert_eq!(rows[0]["status"], "stale");
        assert_eq!(rows[0]["windows"][0]["stale"], true);
        assert_eq!(rows[0]["windows"][0]["daily"]["status"], "delayed");
        assert!(rows[0]["windows"][0]["daily"]["recommended"].is_null());
        assert!(rows[0]["windows"][0]["daily"]["gauge_baseline"].is_null());
    }
}
