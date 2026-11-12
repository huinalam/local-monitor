//! Read-only Claude/Antigravity subset, deliberately not a production server.
use serde_json::{json, Value};
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
struct Row {
    provider: String,
    sid: String,
    cwd: String,
    title: String,
    source: String,
    status: String,
    at: f64,
    turn: Option<String>,
    completed: Option<f64>,
    completed_turn: Option<String>,
    hook: bool,
    owner: Option<(i64, String)>,
    verified: Option<bool>,
}
impl Row {
    fn new(provider: &str, sid: &str, cwd: &str) -> Self {
        Self {
            provider: provider.into(),
            sid: sid.into(),
            cwd: cwd.into(),
            title: Path::new(cwd)
                .file_name()
                .and_then(|x| x.to_str())
                .unwrap_or(sid)
                .into(),
            source: String::new(),
            status: "unknown".into(),
            at: 0.,
            turn: None,
            completed: None,
            completed_turn: None,
            hook: false,
            owner: None,
            verified: None,
        }
    }
    fn transition(
        &mut self,
        state: &str,
        at: f64,
        turn: Option<String>,
        now: f64,
        ready: bool,
        started: f64,
    ) {
        if state == "completed" {
            if self.completed.is_none() || self.completed_turn != turn {
                self.completed = Some(if ready && at >= started { now } else { at });
                self.completed_turn = turn.clone();
            }
        } else if state != "disconnected" {
            self.completed = None;
            self.completed_turn = None;
        }
        self.status = state.into();
        self.at = at;
        self.turn = turn;
    }
    fn normalized(&self, now: f64) -> Value {
        let stale = ["running", "background", "waiting_input"].contains(&self.status.as_str())
            && now - self.at > 600.;
        let mut v = json!({"provider":self.provider,"session_id":self.sid,"status":if stale {"unknown"}else{&self.status},"observed_at":self.at,"turn_id":self.turn});
        if let Some(t) = self.completed {
            v["completed_at"] = json!(t);
        }
        v
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn load(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
type Signature = (u64, u64, i64, i64, i64, i64);
struct Detector {
    claude: PathBuf,
    runtime: PathBuf,
    rows: HashMap<String, Row>,
    seen: HashSet<String>,
    signatures: HashMap<PathBuf, Signature>,
    processes: Option<HashMap<i64, (String, String)>>,
    fixture: Option<PathBuf>,
    fixed_now: Option<f64>,
    ready: bool,
    started: f64,
}
impl Detector {
    fn now(&self) -> f64 {
        self.fixed_now.unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs_f64()
        })
    }
    fn paths(&mut self, path: &Path, prefix: &str) -> Vec<PathBuf> {
        let Ok(m) = fs::metadata(path) else {
            self.signatures.remove(path);
            return vec![];
        };
        let signature = (
            m.dev(),
            m.ino(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        );
        if self.signatures.get(path) == Some(&signature) {
            return vec![];
        }
        let Ok(entries) = fs::read_dir(path) else {
            return vec![];
        };
        let mut paths: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|e| e == "json")
                    && !self.seen.contains(&format!(
                        "{}{}",
                        prefix,
                        p.file_name().unwrap().to_string_lossy()
                    ))
            })
            .collect();
        paths.sort();
        self.signatures.insert(path.to_owned(), signature);
        paths
    }
    fn alive(&mut self, pid: i64, start: &str, provider: &str) -> bool {
        if self.processes.is_none() {
            let output = if let Some(p) = &self.fixture {
                fs::read_to_string(p).unwrap_or_default()
            } else {
                Command::new("ps")
                    .args(["-axo", "pid=,lstart=,comm="])
                    .env("TZ", "UTC")
                    .env("LC_ALL", "C")
                    .output()
                    .ok()
                    .filter(|x| x.status.success())
                    .map(|x| String::from_utf8_lossy(&x.stdout).into_owned())
                    .unwrap_or_default()
            };
            let mut table = HashMap::new();
            for line in output.lines() {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() >= 7 {
                    if let Ok(p) = fields[0].parse::<i64>() {
                        table.insert(p, (fields[1..6].join(" "), fields[6..].join(" ")));
                    }
                }
            }
            self.processes = Some(table);
        }
        let Some((actual, command)) = self.processes.as_ref().unwrap().get(&pid) else {
            return false;
        };
        let allowed = if provider == "claude" {
            command.to_lowercase().contains("claude") || command.contains("/versions/")
        } else {
            Path::new(command)
                .file_name()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x == "agy" || x == "antigravity")
        };
        pid > 0
            && !start.is_empty()
            && *actual == start.split_whitespace().collect::<Vec<_>>().join(" ")
            && allowed
    }
    fn row(&mut self, provider: &str, sid: &str, cwd: &str) -> &mut Row {
        let row = self
            .rows
            .entry(format!("{provider}:{sid}"))
            .or_insert_with(|| Row::new(provider, sid, cwd));
        if !cwd.is_empty() {
            row.cwd = cwd.into();
        }
        row
    }
    fn poll(&mut self) -> Vec<Value> {
        self.processes = None;
        let now = self.now();
        let ready = self.ready;
        let started = self.started;
        let registry_dir = self.claude.join("sessions");
        let mut registry = HashMap::new();
        if let Ok(entries) = fs::read_dir(registry_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|x| x != "json") {
                    continue;
                }
                let Some(v) = load(&path) else { continue };
                let sid = text(&v, "sessionId");
                if sid.is_empty() {
                    continue;
                }
                let alive = self.alive(
                    v["pid"].as_i64().unwrap_or(0),
                    text(&v, "procStart"),
                    "claude",
                );
                let row = self.row("claude", sid, text(&v, "cwd"));
                row.source = text(&v, "entrypoint").into();
                if !text(&v, "name").is_empty() {
                    row.title = text(&v, "name").into();
                }
                row.verified = Some(alive);
                if !alive {
                    row.status = "disconnected".into();
                } else if !row.hook {
                    let at = v["updatedAt"]
                        .as_f64()
                        .filter(|x| x.is_finite() && *x > 0. && *x / 1000. <= now + 60.)
                        .unwrap_or(0.)
                        / 1000.;
                    row.at = at;
                    row.status = match text(&v, "status") {
                        "idle" => "idle",
                        "busy" if at > 0. => "running",
                        _ => "unknown",
                    }
                    .into();
                }
                registry.insert(sid.to_owned(), v);
            }
        }
        for provider in ["claude", "antigravity"] {
            let prefix = if provider == "claude" {
                ""
            } else {
                "antigravity:"
            };
            let dir = self.runtime.join(if provider == "claude" {
                "hooks"
            } else {
                "antigravity-hooks"
            });
            for path in self.paths(&dir, prefix) {
                self.seen.insert(format!(
                    "{}{}",
                    prefix,
                    path.file_name().unwrap().to_string_lossy()
                ));
                let Some(v) = load(&path) else { continue };
                let sid = text(&v, "session_id");
                let Some(at) = v["at"].as_f64() else { continue };
                if sid.is_empty()
                    || !at.is_finite()
                    || (provider == "antigravity" && (at <= 0. || at > now + 60.))
                {
                    continue;
                }
                let row = self.row(provider, sid, text(&v, "cwd"));
                row.hook = true;
                if provider == "antigravity" {
                    row.source = "antigravity-hook".into();
                    if let (Some(pid), Some(start)) = (v["pid"].as_i64(), v["procStart"].as_str()) {
                        row.owner = Some((pid, start.into()));
                    }
                } else {
                    row.source = registry
                        .get(sid)
                        .map(|r| text(r, "entrypoint"))
                        .unwrap_or("hook-unclassified")
                        .into();
                }
                let mut turn = row.turn.clone();
                let event = text(&v, "event");
                let state = if provider == "claude" {
                    match event {
                        "UserPromptSubmit" => {
                            turn = Some(if text(&v, "turn_id").is_empty() {
                                path.file_stem().unwrap().to_string_lossy().into_owned()
                            } else {
                                text(&v, "turn_id").into()
                            });
                            Some("running")
                        }
                        "SessionStart" => Some("idle"),
                        "Stop" => Some(if v["background_active"] == true {
                            "background"
                        } else {
                            "completed"
                        }),
                        "StopFailure" => Some("failed"),
                        "SessionEnd" => Some("disconnected"),
                        "PermissionRequest" => Some("waiting_input"),
                        "Notification"
                            if ["permission_prompt", "idle_prompt", "elicitation_dialog"]
                                .contains(&text(&v, "notification_type")) =>
                        {
                            Some("waiting_input")
                        }
                        "PreToolUse" | "PostToolUse" => Some("running"),
                        _ => None,
                    }
                } else {
                    match event {
                        "SessionStart" => Some("idle"),
                        "PreInvocation" | "PreToolUse" | "PostToolUse" => {
                            if !["running", "background", "waiting_input"]
                                .contains(&row.status.as_str())
                                || turn.is_none()
                            {
                                turn =
                                    Some(path.file_stem().unwrap().to_string_lossy().into_owned());
                            }
                            Some("running")
                        }
                        "Stop" => {
                            let reason = text(&v, "termination_reason")
                                .trim_start_matches("EXECUTOR_TERMINATION_REASON_");
                            Some(
                                if v["has_error"] == true || ["ERROR", "error"].contains(&reason) {
                                    "failed"
                                } else if ["USER_CANCELED", "user_canceled"].contains(&reason) {
                                    "interrupted"
                                } else if ["NO_TOOL_CALL", "model_stop"].contains(&reason) {
                                    if v["fully_idle"] == true {
                                        "completed"
                                    } else {
                                        "background"
                                    }
                                } else {
                                    "unknown"
                                },
                            )
                        }
                        _ => None,
                    }
                };
                if let Some(state) = state {
                    row.transition(state, at, turn, now, ready, started);
                }
            }
        }
        for (sid, _) in registry {
            if let Some(row) = self.rows.get_mut(&format!("claude:{sid}")) {
                if row.verified == Some(false) {
                    row.status = "disconnected".into();
                }
            }
        }
        let owners: Vec<_> = self
            .rows
            .iter()
            .filter(|(_, r)| r.provider == "antigravity")
            .filter_map(|(key, r)| r.owner.clone().map(|owner| (key.clone(), owner)))
            .collect();
        for (key, (pid, start)) in owners {
            let alive = self.alive(pid, &start, "antigravity");
            let row = self.rows.get_mut(&key).unwrap();
            row.verified = Some(alive);
            if !alive {
                row.status = "disconnected".into();
            }
        }
        self.ready = true;
        let mut rows: Vec<_> = self.rows.values().map(|r| r.normalized(now)).collect();
        rows.sort_by(|a, b| {
            text(a, "provider")
                .cmp(text(b, "provider"))
                .then(text(a, "session_id").cmp(text(b, "session_id")))
        });
        rows
    }
}
fn main() {
    let args: Vec<_> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: probe CLAUDE_HOME RUNTIME [--once | --seconds N] [--interval N]");
        std::process::exit(2);
    }
    let option = |key: &str| {
        args.iter()
            .position(|a| a == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let now = option("--now").and_then(|x| x.parse().ok());
    let started = now.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
    });
    let mut d = Detector {
        claude: args[1].clone().into(),
        runtime: args[2].clone().into(),
        rows: HashMap::new(),
        seen: HashSet::new(),
        signatures: HashMap::new(),
        processes: None,
        fixture: option("--processes").map(PathBuf::from),
        fixed_now: now,
        ready: false,
        started,
    };
    let seconds = option("--seconds")
        .and_then(|x| x.parse::<f64>().ok())
        .unwrap_or(0.);
    let interval = option("--interval")
        .and_then(|x| x.parse::<f64>().ok())
        .unwrap_or(5.);
    assert!(interval > 0. && seconds >= 0.);
    if !args.iter().any(|a| a == "--once") {
        println!("{}", json!({"pid":std::process::id()}));
        io::stdout().flush().unwrap();
    }
    let start = Instant::now();
    let mut polls = 0;
    loop {
        let rows = d.poll();
        polls += 1;
        if args.iter().any(|a| a == "--once") {
            println!("{}", json!(rows));
            break;
        }
        if start.elapsed().as_secs_f64() >= seconds {
            println!(
                "{}",
                json!({"polls":polls,"rows":rows.len(),"elapsed":start.elapsed().as_secs_f64()})
            );
            break;
        }
        thread::sleep(Duration::from_secs_f64(interval));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        detector: Detector,
    }
    impl Fixture {
        fn new() -> Self {
            let root = env::temp_dir().join(format!(
                "rust-monitor-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(root.join("runtime/antigravity-hooks")).unwrap();
            let detector = Detector {
                claude: root.join("claude"),
                runtime: root.join("runtime"),
                rows: HashMap::new(),
                seen: HashSet::new(),
                signatures: HashMap::new(),
                processes: None,
                fixture: None,
                fixed_now: Some(1000.),
                ready: false,
                started: 1000.,
            };
            Self { root, detector }
        }
        fn event(&self, n: u32, event: &str, extra: Value) {
            let mut v = json!({"session_id":"test","cwd":"/fixture","event":event,"at":1000.});
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            let temp = self.root.join("runtime/antigravity-hooks/pending.tmp");
            fs::write(&temp, v.to_string()).unwrap();
            fs::rename(
                temp,
                self.root
                    .join(format!("runtime/antigravity-hooks/{n:03}.json")),
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn incremental_atomic_events_duplicate_stop_and_resume() {
        let mut f = Fixture::new();
        assert!(f.detector.poll().is_empty());
        f.event(1, "PreInvocation", json!({}));
        let first = f.detector.poll();
        assert_eq!(first[0]["status"], "running");
        assert_eq!(f.detector.poll(), first);
        f.detector.fixed_now = Some(1001.);
        f.event(
            2,
            "Stop",
            json!({"at":1001.,"termination_reason":"NO_TOOL_CALL","fully_idle":true}),
        );
        let done = f.detector.poll();
        assert_eq!(done[0]["status"], "completed");
        assert_eq!(done[0]["completed_at"], 1001.);
        f.detector.fixed_now = Some(1002.);
        f.event(
            3,
            "Stop",
            json!({"at":1002.,"termination_reason":"NO_TOOL_CALL","fully_idle":true}),
        );
        assert_eq!(f.detector.poll()[0]["completed_at"], 1001.);
        f.event(4, "PreInvocation", json!({"at":1002.}));
        let next = f.detector.poll();
        assert_eq!(next[0]["status"], "running");
        assert!(next[0].get("completed_at").is_none());
        assert_ne!(next[0]["turn_id"], first[0]["turn_id"]);
    }
    #[test]
    fn active_evidence_expires_without_fabricated_completion() {
        let mut f = Fixture::new();
        f.event(1, "PreInvocation", json!({}));
        f.detector.poll();
        f.detector.fixed_now = Some(1601.);
        let rows = f.detector.poll();
        assert_eq!(rows[0]["status"], "unknown");
        assert!(rows[0].get("completed_at").is_none());
    }
    #[test]
    fn process_snapshot_refresh_rejects_pid_reuse() {
        let mut f = Fixture::new();
        let path = f.root.join("processes");
        let start = "Wed Oct 14 06:28:49 2026";
        fs::write(&path, format!("43 {start} /bin/agy\n")).unwrap();
        f.detector.fixture = Some(path.clone());
        f.event(1, "PreInvocation", json!({"pid":43,"procStart":start}));
        assert_eq!(f.detector.poll()[0]["status"], "running");
        fs::write(path, "43 Wed Oct 14 07:28:49 2026 /bin/agy\n").unwrap();
        assert_eq!(f.detector.poll()[0]["status"], "disconnected");
    }
}
