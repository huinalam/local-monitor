//! Read-only Claude/Antigravity subset, deliberately not a production server.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
struct Row {
    provider: String,
    sid: String,
    cwd: String,
    title: String,
    preview: crate::preview::Preview,
    preview_since: f64,
    preview_refresh: bool,
    preview_retry_at: f64,
    preview_error: Option<&'static str>,
    source: String,
    status: String,
    at: f64,
    turn: Option<String>,
    completed: Option<f64>,
    completed_turn: Option<String>,
    notifications: Vec<(String, f64)>,
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
            preview: Default::default(),
            preview_since: 0.,
            preview_refresh: false,
            preview_retry_at: 0.,
            preview_error: None,
            source: String::new(),
            status: "unknown".into(),
            at: 0.,
            turn: None,
            completed: None,
            completed_turn: None,
            notifications: Vec::new(),
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
            if ready && at >= started {
                if let Some(t) = &turn {
                    self.notifications.push((t.clone(), at));
                }
            }
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
    if fs::metadata(path).ok()?.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
type Signature = (u64, u64, i64, i64, i64, i64);
pub(crate) struct Detector {
    lifecycle: crate::antigravity_lifecycle::Lifecycle,
    excluded: HashSet<String>,
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
    codex: Option<PathBuf>,
    tails: HashMap<String, Tail>,
    emitted: HashSet<(String, String, String)>,
    pub(crate) errors: Vec<String>,
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
                let mut command = Command::new("ps");
                command
                    .args(["-axo", "pid=,lstart=,comm="])
                    .env("TZ", "UTC")
                    .env("LC_ALL", "C");
                crate::bounded::run(command, 8 * 1024 * 1024, Duration::from_secs(2))
                    .ok()
                    .map(|x| String::from_utf8_lossy(&x).into_owned())
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
        self.errors.clear();
        for row in self.rows.values_mut() {
            row.notifications.clear();
            // Registry verification is valid only for the current scan.
            if row.provider == "claude" {
                row.verified = None;
            }
        }
        self.scan_codex();
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
                let Some(v) = load(&path) else {
                    self.errors.push("claude_registry_invalid".into());
                    continue;
                };
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
                let Some(v) = load(&path) else {
                    self.errors.push(format!("{provider}_hook_invalid"));
                    continue;
                };
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
                if event == "UserPromptSubmit" {
                    row.preview.clear(); row.preview_since = at; row.preview_refresh = true;
                }
                if provider == "claude" && state == Some("completed") { row.preview_refresh = true; }
                if let Some(state) = state {
                    row.transition(state, at, turn, now, ready, started);
                }
            }
        }
        self.scan_claude_previews();
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
        let ids: Vec<_> = self
            .rows
            .values()
            .filter(|r| r.provider == "antigravity")
            .map(|r| r.sid.clone())
            .collect();
        let (excluded, errors) = self.lifecycle.scan(&ids);
        for row in self
            .rows
            .values_mut()
            .filter(|r| r.provider == "antigravity")
        {
            row.title = self
                .lifecycle
                .titles
                .get(&row.sid)
                .cloned()
                .unwrap_or_else(|| {
                    Path::new(&row.cwd)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&row.sid)
                        .to_owned()
                });
        }
        self.excluded = excluded;
        self.errors.extend(errors);
        self.ready = true;
        let mut rows: Vec<_> = self
            .rows
            .values()
            .filter(|r| r.provider != "antigravity" || !self.excluded.contains(&r.sid))
            .map(|r| r.normalized(now))
            .collect();
        rows.sort_by(|a, b| {
            text(a, "provider")
                .cmp(text(b, "provider"))
                .then(text(a, "session_id").cmp(text(b, "session_id")))
        });
        rows
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
            let root = std::env::temp_dir().join(format!(
                "rust-monitor-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(root.join("runtime/antigravity-hooks")).unwrap();
            let detector = Detector {
                lifecycle: crate::antigravity_lifecycle::Lifecycle::new(
                    root.join("agy"),
                    root.join("runtime/antigravity-lifecycle.json"),
                ),
                excluded: HashSet::new(),
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
                codex: None,
                tails: HashMap::new(),
                emitted: HashSet::new(),
                errors: Vec::new(),
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
    fn removed_registry_clears_verification_without_fabricated_end() {
        let mut f = Fixture::new();
        let dir = f.root.join("claude/sessions");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        let processes = f.root.join("processes");
        let start = "Wed Oct 14 06:28:49 2026";
        fs::write(&processes, format!("43 {start} /bin/claude\n")).unwrap();
        f.detector.fixture = Some(processes);
        let record = json!({"sessionId":"c1","pid":43,"procStart":start,"status":"busy","updatedAt":1000000});
        fs::write(&path, record.to_string()).unwrap();
        assert_eq!(f.detector.full().0["sessions"][0]["process_verified"], true);
        fs::remove_file(&path).unwrap();
        let (snap, events) = f.detector.full();
        assert!(snap["sessions"][0].get("process_verified").is_none());
        assert_eq!(snap["sessions"][0]["status"], "running");
        assert!(events.is_empty());
        f.detector.fixed_now = Some(1601.);
        assert_eq!(
            f.detector.full().0["sessions"][0]["reason"],
            "no_recent_evidence"
        );
        fs::write(&path, record.to_string()).unwrap();
        assert_eq!(f.detector.full().0["sessions"][0]["process_verified"], true);
        fs::write(&path, "invalid").unwrap();
        assert!(f.detector.full().0["sessions"][0]
            .get("process_verified")
            .is_none());
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
    fn desktop_lifecycle_filters_snapshot_and_events_without_resetting_completion() {
        let mut f = Fixture::new();
        let db = f.root.join("agy/conversations/test.db");
        let annotation = f.root.join("agy/annotations/test.pbtxt");
        fs::create_dir_all(db.parent().unwrap()).unwrap();
        fs::create_dir_all(annotation.parent().unwrap()).unwrap();
        fs::write(&db, b"fixture").unwrap();
        fs::write(&annotation, "title:\"실제 대화 제목\" archived:false").unwrap();
        f.detector.full();
        f.event(1, "PreInvocation", json!({}));
        f.detector.full();
        f.event(
            2,
            "Stop",
            json!({"termination_reason":"NO_TOOL_CALL","fully_idle":true}),
        );
        let (s, e) = f.detector.full();
        assert_eq!(s["sessions"][0]["completed_at"], 1000.);
        assert_eq!(e.len(), 1);
        assert_eq!(s["sessions"][0]["title"], "실제 대화 제목");
        assert_eq!(e[0]["title"], "실제 대화 제목");
        assert_eq!(s["sessions"][0]["cwd"], "/fixture");
        fs::write(&annotation, "archived:true").unwrap();
        assert!(f.detector.full().0["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
        f.event(
            3,
            "Stop",
            json!({"termination_reason":"NO_TOOL_CALL","fully_idle":true}),
        );
        assert!(f.detector.full().1.is_empty());
        fs::write(&annotation, "archived:false").unwrap();
        let (s, e) = f.detector.full();
        assert_eq!(s["sessions"][0]["completed_at"], 1000.);
        assert!(e.is_empty());
        fs::remove_file(db).unwrap();
        fs::remove_file(annotation).unwrap();
        f.detector.full();
        assert!(f.detector.full().0["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
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

#[derive(Default)]
struct Tail {
    identity: Option<(u64, u64)>,
    offset: u64,
    scanned_len: Option<u64>,
}
impl Tail {
    fn read(&mut self, path: &Path) -> std::io::Result<(Vec<Value>, bool)> {
        let meta = fs::metadata(path)?;
        let identity = (meta.dev(), meta.ino());
        let baseline = self.identity != Some(identity) || meta.len() < self.offset;
        if !baseline && self.scanned_len == Some(meta.len()) {
            return Ok((Vec::new(), false));
        }
        let mut file = BufReader::new(fs::File::open(path)?);
        if baseline {
            self.offset = meta.len().saturating_sub(2 * 1024 * 1024);
            file.seek(SeekFrom::Start(self.offset))?;
            if self.offset > 0 {
                let mut skip = Vec::new();
                self.offset += file.read_until(b'\n', &mut skip)? as u64;
            }
        } else {
            file.seek(SeekFrom::Start(self.offset))?;
        }
        let mut values = Vec::new();
        let mut budget = 8 * 1024 * 1024usize;
        while budget > 0 {
            let mut line = Vec::new();
            let count = file
                .by_ref()
                .take((budget + 1) as u64)
                .read_until(b'\n', &mut line)?;
            if count == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                if count > budget {
                    // Discard an oversized record in bounded chunks, then resume next poll.
                    let mut consumed = count as u64;
                    let mut complete = false;
                    loop {
                        line.clear();
                        let read = file.by_ref().take(65536).read_until(b'\n', &mut line)?;
                        if read == 0 {
                            break;
                        }
                        consumed += read as u64;
                        if line.last() == Some(&b'\n') {
                            complete = true;
                            break;
                        }
                    }
                    if complete {
                        self.offset += consumed;
                    }
                }
                break;
            }
            self.offset += count as u64;
            budget = budget.saturating_sub(count);
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                if v.is_object() {
                    values.push(v)
                }
            }
        }
        self.identity = Some(identity);
        self.scanned_len = if file.stream_position()? >= meta.len() {
            Some(meta.len())
        } else {
            None
        };
        Ok((values, baseline))
    }
}
impl Detector {
    pub(crate) fn new(codex: Option<PathBuf>, claude: PathBuf, runtime: PathBuf) -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        Self {
            lifecycle: crate::antigravity_lifecycle::Lifecycle::new(
                home.join(".gemini/antigravity"),
                runtime.join("antigravity-lifecycle.json"),
            ),
            excluded: HashSet::new(),
            claude,
            runtime,
            rows: HashMap::new(),
            seen: HashSet::new(),
            signatures: HashMap::new(),
            processes: None,
            fixture: None,
            fixed_now: None,
            ready: false,
            started: crate::now(),
            codex,
            tails: HashMap::new(),
            emitted: HashSet::new(),
            errors: Vec::new(),
        }
    }
    fn scan_claude_previews(&mut self) {
        let rows:Vec<_>=self.rows.values().filter(|r|r.provider=="claude").map(|r|(r.sid.clone(),r.cwd.clone())).collect();
        for (sid,cwd) in rows {
            if sid.is_empty() || !sid.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_') {continue;}
            let project:String=cwd.chars().map(|c|if c.is_ascii_alphanumeric(){c}else{'-'}).collect();
            let path=self.claude.join("projects").join(project).join(format!("{sid}.jsonl"));
            let key=format!("claude:{sid}");
            let now=self.now();
            let row=self.rows.get_mut(&key).unwrap();
            let recent_complete=row.status=="completed" && row.completed.is_some_and(|at| now>=at && now-at<1800.);
            if row.preview_refresh || (recent_complete && row.preview.output().is_none() && now>=row.preview_retry_at) {
                self.tails.remove(&key);
                row.preview_refresh=false;
                row.preview_retry_at=now+30.;
            }
            let read=self.tails.entry(key.clone()).or_default().read(&path);
            let row=self.rows.get_mut(&key).unwrap();
            match read {
                Ok((items,baseline))=>{
                    if baseline {row.preview.clear();}
                    for item in items {
                        let at=chrono::DateTime::parse_from_rfc3339(text(&item,"timestamp")).map(|t|t.timestamp() as f64+t.timestamp_subsec_nanos() as f64/1e9).unwrap_or(0.);
                        if at >= row.preview_since {row.preview.claude(&item);}
                    }
                    row.preview_error=if row.preview.output().is_none(){Some("no_message")}else{None};
                },
                Err(error)=>{
                    row.preview.clear();
                    row.preview_error=Some(if error.kind()==std::io::ErrorKind::NotFound {"missing"} else {"read_failed"});
                    // Cursor and excerpt are a pair: a recovered unchanged file must be read again.
                    self.tails.remove(&key);
                },
            }
        }
    }
    fn scan_codex(&mut self) {
        let Some(home) = self.codex.clone() else {
            return;
        };
        let db = fs::read_dir(&home)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter_map(|p| {
                let name = p.file_stem()?.to_str()?;
                let version = name.strip_prefix("state_")?.parse::<u64>().ok()?;
                if p.extension()? == "sqlite" {
                    Some((version, p))
                } else {
                    None
                }
            })
            .max_by_key(|(v, _)| *v);
        let Some((_, path)) = db else {
            self.errors.push("codex_database_missing".into());
            return;
        };
        let records = (|| -> rusqlite::Result<Vec<(String, String, String, String, String)>> {
            let db = rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            db.busy_timeout(Duration::from_secs(1))?;
            let names: Vec<String> = db
                .prepare("PRAGMA table_info(threads)")?
                .query_map([], |r| r.get(1))?
                .collect::<Result<_, _>>()?;
            let title = if names.iter().any(|n| n == "name") {
                "COALESCE(NULLIF(name,''),title)"
            } else {
                "title"
            };
            let mut query=db.prepare(&format!("SELECT id,cwd,{title},rollout_path,source FROM threads WHERE archived=0 AND source IN ('vscode','cli','exec') ORDER BY updated_at DESC LIMIT 100"))?;
            let rows = query
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        r.get(4)?,
                    ))
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })();
        let Ok(records) = records else {
            self.errors.push("codex_database_unavailable".into());
            return;
        };
        let now = self.now();
        let ready = self.ready;
        let started = self.started;
        for (sid, cwd, title, path, source) in records {
            let rollout = Path::new(&path);
            let compressed_only = if path.ends_with(".jsonl.zst") {
                rollout.is_file()
            } else {
                matches!(fs::metadata(rollout), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
                    && PathBuf::from(format!("{path}.zst")).is_file()
            };
            if compressed_only {
                self.rows.remove(&format!("codex:{sid}"));
                self.tails.remove(&sid);
                continue;
            }
            let tail = self
                .tails
                .entry(sid.clone())
                .or_default()
                .read(Path::new(&path));
            let row = self.row("codex", &sid, &cwd);
            if !title.is_empty() {
                row.title = title;
            }
            row.source = source;
            let Ok((items, baseline)) = tail else {
                row.status = "unknown".into();
                row.preview.clear();
                self.errors.push("rollout_unavailable".into());
                continue;
            };
            if baseline {
                row.status = "unknown".into();
                row.turn = None;
                row.at = 0.;
                row.preview.clear();
            }
            for item in items {
                let at = chrono::DateTime::parse_from_rfc3339(text(&item, "timestamp"))
                    .map(|t| t.timestamp() as f64 + t.timestamp_subsec_nanos() as f64 / 1e9)
                    .unwrap_or(0.);
                row.at = row.at.max(at);
                let event_turn = item["payload"]["turn_id"].as_str();
                if event_turn.is_some() && row.turn.is_some() && event_turn != row.turn.as_deref()
                    && ["task_complete", "agent_message"].contains(&text(&item["payload"], "type")) { continue; }
                if text(&item["payload"], "type") != "task_complete" || row.status != "interrupted" {
                    if let Some(state) = row.preview.codex(&item) {
                        row.transition(state, at, row.turn.clone(), now, false, started);
                    }
                }
                if text(&item, "type") != "event_msg" || !item["payload"].is_object() {
                    continue;
                }
                let payload = &item["payload"];
                let turn = payload["turn_id"]
                    .as_str()
                    .map(str::to_owned)
                    .or(row.turn.clone());
                match text(payload, "type") {
                    "task_started" => row.transition("running", at, turn, now, false, started),
                    "task_complete" => {
                        if row.turn.is_some() && turn != row.turn || row.status == "interrupted" {
                            continue;
                        }
                        row.transition(
                            "completed",
                            at,
                            turn,
                            now,
                            ready && !(baseline && at < started),
                            started,
                        );
                    }
                    "turn_aborted" => {
                        if row.turn.is_none() || turn == row.turn {
                            row.transition("interrupted", at, turn, now, false, started)
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    pub(crate) fn full(&mut self) -> (Value, Vec<Value>) {
        self.poll();
        let now = self.now();
        let mut rows = Vec::new();
        let mut events = Vec::new();
        for row in self.rows.values() {
            if row.provider == "antigravity" && self.excluded.contains(&row.sid) {
                continue;
            }
            let mut v = row.normalized(now);
            v["cwd"] = json!(row.cwd);
            v["title"] = json!(row.title);
            v["source"] = json!(row.source);
            if let Some(preview) = row.preview.output() { v["preview"] = preview; }
            if let Some(error) = row.preview_error { v["preview_error"] = json!(error); }
            if let Some(b) = row.verified {
                v["process_verified"] = json!(b);
            }
            if v["status"] == "unknown"
                && ["running", "waiting_input", "background"].contains(&row.status.as_str())
            {
                v["reason"] = json!("no_recent_evidence");
            }
            if let Some(t) = &row.completed_turn {
                v["completed_turn"] = json!(t);
            }
            rows.push(v);
            for (turn, at) in &row.notifications {
                if self
                    .emitted
                    .insert((row.provider.clone(), row.sid.clone(), turn.clone()))
                {
                    events.push(json!({"event":"response_completed","provider":row.provider,"session_id":row.sid,"turn_id":turn,"title":row.title,"cwd":row.cwd,"at":at}));
                }
            }
        }
        rows.sort_by(|a, b| {
            b["observed_at"]
                .as_f64()
                .unwrap_or(0.)
                .total_cmp(&a["observed_at"].as_f64().unwrap_or(0.))
        });
        self.errors.sort();
        self.errors.dedup();
        (
            json!({"schema":1,"at":now,"sessions":rows,"errors":self.errors}),
            events,
        )
    }
}

#[cfg(test)]
mod codex_tests {
    use super::*;
    fn fixture() -> (PathBuf, Detector, PathBuf) {
        let root = std::env::temp_dir().join(format!("rust-codex-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("codex")).unwrap();
        let log = root.join("rollout.jsonl");
        fs::write(&log, "").unwrap();
        let db = rusqlite::Connection::open(root.join("codex/state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,name TEXT,rollout_path TEXT,source TEXT,archived INT,updated_at INT)").unwrap();
        db.execute("INSERT INTO threads VALUES ('one','/fixture','Fallback','Preferred',?,'vscode',0,1000)",[log.to_string_lossy().as_ref()]).unwrap();
        db.execute(
            "INSERT INTO threads VALUES ('hidden','/fixture','Hidden',NULL,?,'unknown',0,1001)",
            [log.to_string_lossy().as_ref()],
        )
        .unwrap();
        let mut d = Detector::new(
            Some(root.join("codex")),
            root.join("claude"),
            root.join("runtime"),
        );
        d.fixed_now = Some(1000.);
        d.started = 1000.;
        (root, d, log)
    }
    fn item(kind: &str, turn: &str, at: f64) -> String {
        let seconds = at as i64;
        let nanos = ((at - seconds as f64) * 1e9).round() as u32;
        json!({"timestamp":chrono::DateTime::<chrono::Utc>::from_timestamp(seconds,nanos).unwrap().to_rfc3339(),"type":"event_msg","payload":{"type":kind,"turn_id":turn}}).to_string()
    }
    fn append(path: &Path, value: &str) {
        use std::io::Write;
        let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(value.as_bytes()).unwrap();
    }
    #[test]
    fn claude_preview_recovers_unchanged_file_after_transient_missing() {
        let (root,mut d,_)=fixture();d.row("claude","c1","/fixture");
        let path=root.join("claude/projects/-fixture/c1.jsonl");fs::create_dir_all(path.parent().unwrap()).unwrap();
        let msg=json!({"type":"assistant","message":{"content":[{"type":"text","text":"Recovered"}]}});
        fs::write(&path,format!("{msg}\n")).unwrap();d.scan_claude_previews();
        let parked=path.with_extension("parked");fs::rename(&path,&parked).unwrap();d.scan_claude_previews();
        assert!(d.rows["claude:c1"].preview.output().is_none());
        assert_eq!(d.rows["claude:c1"].preview_error,Some("missing"));
        fs::rename(&parked,&path).unwrap();d.scan_claude_previews();
        assert_eq!(d.rows["claude:c1"].preview.output().unwrap()["text"],"Recovered");
        assert_eq!(d.rows["claude:c1"].preview_error,None);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn claude_stop_rehydrates_consumed_transcript_without_duplicate_completion() {
        let (root,mut d,_)=fixture();let row=d.row("claude","c1","/fixture");row.turn=Some("t1".into());
        let path=root.join("claude/projects/-fixture/c1.jsonl");fs::create_dir_all(path.parent().unwrap()).unwrap();
        let msg=json!({"type":"assistant","message":{"content":[{"type":"text","text":"Final"}]}});
        fs::write(&path,format!("{msg}\n")).unwrap();d.full();
        d.rows.get_mut("claude:c1").unwrap().preview.clear();
        let hooks=root.join("runtime/hooks");fs::create_dir_all(&hooks).unwrap();
        fs::write(hooks.join("001.json"),json!({"session_id":"c1","event":"Stop","at":1000.,"cwd":"/fixture"}).to_string()).unwrap();
        let (_,events)=d.full();assert_eq!(events.len(),1);
        let row=&d.rows["claude:c1"];assert_eq!(row.status,"completed");assert_eq!(row.preview.output().unwrap()["text"],"Final");
        let completed=row.completed;
        let (_,events)=d.full();assert!(events.is_empty());assert_eq!(d.rows["claude:c1"].completed,completed);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn claude_missing_completion_retries_bounded_but_valid_preview_stays_incremental() {
        let (root,mut d,_)=fixture();let row=d.row("claude","c1","/fixture");row.status="completed".into();row.completed=Some(1000.);
        let path=root.join("claude/projects/-fixture/c1.jsonl");fs::create_dir_all(path.parent().unwrap()).unwrap();
        let msg=json!({"type":"ignoredxx","message":{"content":[{"type":"text","text":"Delayed"}]}}).to_string();
        fs::write(&path,format!("{msg}\n")).unwrap();d.scan_claude_previews();
        assert_eq!(d.rows["claude:c1"].preview_error,Some("no_message"));
        fs::write(&path,format!("{}\n",msg.replace("ignoredxx","assistant"))).unwrap();
        d.fixed_now=Some(1005.);d.scan_claude_previews();assert!(d.rows["claude:c1"].preview.output().is_none());
        d.fixed_now=Some(1035.);d.scan_claude_previews();assert_eq!(d.rows["claude:c1"].preview.output().unwrap()["text"],"Delayed");
        fs::write(&path,format!("{msg}\n")).unwrap();
        d.fixed_now=Some(1070.);d.scan_claude_previews();assert_eq!(d.rows["claude:c1"].preview.output().unwrap()["text"],"Delayed");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn claude_preview_filters_prior_turn_and_invalidates_missing_file() {
        let (root,mut d,_)=fixture();
        let row=d.row("claude","c1","/fixture");row.preview_since=1000.;
        let path=root.join("claude/projects/-fixture/c1.jsonl");fs::create_dir_all(path.parent().unwrap()).unwrap();
        let old=json!({"timestamp":"1970-01-01T00:16:39Z","type":"assistant","message":{"content":[{"type":"text","text":"Old"}]}});
        fs::write(&path,format!("{old}\n")).unwrap();d.scan_claude_previews();
        assert!(d.rows["claude:c1"].preview.output().is_none());
        let new=json!({"timestamp":"1970-01-01T00:16:41Z","type":"assistant","message":{"content":[{"type":"text","text":"New"}]}});
        append(&path,&format!("{new}\n"));d.scan_claude_previews();
        assert_eq!(d.rows["claude:c1"].preview.output().unwrap()["text"],"New");
        fs::remove_file(&path).unwrap();d.scan_claude_previews();
        assert!(d.rows["claude:c1"].preview.output().is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn previews_follow_question_completion_and_restart() {
        let (root,mut d,log)=fixture();
        append(&log,&format!("{}\n",item("task_started","t1",1000.)));
        let question=json!({"timestamp":"1970-01-01T00:16:41Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"q","arguments":json!({"questions":[{"question":"Which?","options":[{"label":"A"}]}]}).to_string()}});
        append(&log,&format!("{question}\n"));
        let (s,_)=d.full();assert_eq!(s["sessions"][0]["status"],"waiting_input");assert_eq!(s["sessions"][0]["preview"]["questions"][0]["question"],"Which?");
        let done=json!({"timestamp":"1970-01-01T00:16:42Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"Finished"}});
        append(&log,&format!("{done}\n"));
        let (s,_)=d.full();assert_eq!(s["sessions"][0]["status"],"completed");assert_eq!(s["sessions"][0]["preview"]["text"],"Finished");
        append(&log,&format!("{}\n{done}\n",item("task_started","t2",1003.)));
        let (s,_)=d.full();assert_eq!(s["sessions"][0]["status"],"running");assert!(s["sessions"][0]["preview"].is_null());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cli_sources_follow_turn_lifecycle() {
        for source in ["cli", "exec"] {
            let (root, mut d, log) = fixture();
            let db = rusqlite::Connection::open(root.join("codex/state_5.sqlite")).unwrap();
            db.execute("UPDATE threads SET source=? WHERE id='one'", [source]).unwrap();
            db.execute("INSERT INTO threads VALUES ('sub','/fixture','Sub',NULL,?,'{\"subagent\":{}}',0,1000)", [log.to_string_lossy().as_ref()]).unwrap();
            append(&log, &format!("{}\n", item("task_complete", "old", 900.)));
            assert!(d.full().1.is_empty());
            append(&log, &format!("{}\n", item("task_started", "t1", 1001.)));
            let (s, _) = d.full();
            assert_eq!(s["sessions"].as_array().unwrap().len(), 1);
            assert_eq!(s["sessions"][0]["source"], source);
            assert_eq!(s["sessions"][0]["status"], "running");
            append(&log, &format!("{}\n", item("task_complete", "t1", 1002.)));
            let (s, e) = d.full();
            assert_eq!(s["sessions"][0]["status"], "completed");
            assert_eq!(e.len(), 1);
            assert!(d.full().1.is_empty());
            append(&log, &format!("{}\n{}\n", item("task_started", "next", 1003.), item("turn_aborted", "next", 1004.)));
            assert_eq!(d.full().0["sessions"][0]["status"], "interrupted");
            db.execute("UPDATE threads SET archived=1 WHERE id='one'", []).unwrap();
            let mut fresh = Detector::new(Some(root.join("codex")), root.join("claude"), root.join("runtime2"));
            assert!(fresh.full().0["sessions"].as_array().unwrap().is_empty());
            let _ = fs::remove_dir_all(root);
        }
    }
    #[test]
    fn compressed_only_is_excluded_and_restored_original_is_detected() {
        let (root, mut d, log) = fixture();
        let compressed = log.with_extension("jsonl.zst");
        fs::write(&compressed, b"not read or decompressed").unwrap();
        fs::remove_file(&log).unwrap();
        let (s, e) = d.full();
        assert!(s["sessions"].as_array().unwrap().is_empty());
        assert!(s["errors"].as_array().unwrap().is_empty());
        assert!(e.is_empty());

        fs::write(
            &log,
            format!(
                "{}\n{}\n",
                item("task_started", "old", 900.),
                item("task_complete", "old", 901.)
            ),
        )
        .unwrap();
        let (s, e) = d.full();
        assert_eq!(s["sessions"][0]["status"], "completed");
        assert!(e.is_empty());
        assert!(s["errors"].as_array().unwrap().is_empty());

        fs::remove_file(&log).unwrap();
        let (s, e) = d.full();
        assert!(s["sessions"].as_array().unwrap().is_empty());
        assert!(s["errors"].as_array().unwrap().is_empty());
        assert!(e.is_empty());
        assert!(!d.tails.contains_key("one"));

        fs::remove_file(&compressed).unwrap();
        let (s, _) = d.full();
        assert_eq!(s["errors"], json!(["rollout_unavailable"]));
        assert_eq!(s["sessions"][0]["status"], "unknown");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn compressed_database_path_is_excluded() {
        let (root, mut d, log) = fixture();
        let compressed = log.with_extension("jsonl.zst");
        fs::write(&compressed, b"not read").unwrap();
        let db = rusqlite::Connection::open(root.join("codex/state_5.sqlite")).unwrap();
        db.execute(
            "UPDATE threads SET rollout_path=? WHERE id='one'",
            [compressed.to_string_lossy().as_ref()],
        )
        .unwrap();
        let (s, e) = d.full();
        assert!(s["sessions"].as_array().unwrap().is_empty());
        assert!(s["errors"].as_array().unwrap().is_empty());
        assert!(e.is_empty());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn history_partial_live_completion_and_late_abort() {
        let (root, mut d, log) = fixture();
        append(
            &log,
            &format!(
                "{}\n{}\n",
                item("task_started", "old", 900.),
                item("task_complete", "old", 901.)
            ),
        );
        let (s, e) = d.full();
        assert!(e.is_empty());
        assert_eq!(s["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(s["sessions"][0]["title"], "Preferred");
        assert_eq!(s["sessions"][0]["completed_at"], 901.);
        d.fixed_now = Some(1001.);
        append(&log, &format!("{}\n", item("task_started", "new", 1001.)));
        assert_eq!(d.full().0["sessions"][0]["status"], "running");
        let complete = item("task_complete", "new", 1001.125456);
        append(&log, &complete[..20]);
        assert!(d.full().1.is_empty());
        append(&log, &format!("{}\n", &complete[20..]));
        let (s, e) = d.full();
        assert_eq!(e.len(), 1);
        assert_eq!(s["sessions"][0]["status"], "completed");
        assert!(d.full().1.is_empty());
        append(
            &log,
            &format!(
                "{}\n{}\n{}\n",
                item("task_started", "third", 1002.),
                item("turn_aborted", "third", 1002.1),
                item("task_complete", "third", 1002.2)
            ),
        );
        let (s, e) = d.full();
        assert_eq!(s["sessions"][0]["status"], "interrupted");
        assert!(e.is_empty());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn rotation_and_truncation() {
        let (root, mut d, log) = fixture();
        append(&log, &format!("{}\n", item("task_started", "old", 999.)));
        d.full();
        fs::rename(&log, root.join("old.log")).unwrap();
        fs::write(
            &log,
            format!("{}\n", item("task_started", "rotated", 1000.)),
        )
        .unwrap();
        assert_eq!(d.full().0["sessions"][0]["turn_id"], "rotated");
        fs::write(&log, "").unwrap();
        assert_eq!(d.full().0["sessions"][0]["status"], "unknown");
        let _ = fs::remove_dir_all(root);
    }
}
#[cfg(test)]
mod tail_bounds_tests {
    use super::*;
    #[test]
    fn oversized_live_line_does_not_block_later_records() {
        let root = std::env::temp_dir().join(format!("rust-tail-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("log");
        fs::write(&file, "").unwrap();
        let mut tail = Tail::default();
        tail.read(&file).unwrap();
        let mut append = fs::OpenOptions::new().append(true).open(&file).unwrap();
        use std::io::Write;
        append.write_all(&vec![b'x'; 9 * 1024 * 1024]).unwrap();
        append
            .write_all(b"\n{\"type\":\"after_large_record\"}\n")
            .unwrap();
        assert!(tail.read(&file).unwrap().0.is_empty());
        assert_eq!(tail.read(&file).unwrap().0[0]["type"], "after_large_record");
        let _ = fs::remove_dir_all(root);
    }
}
