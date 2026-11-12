use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::Mutex,
};
const EVENTS: &[&str] = &[
    "start",
    "sample",
    "warning",
    "recovery",
    "sse_open",
    "sse_error",
    "sse_reset",
    "sse_parse_error",
    "sse_watchdog",
    "http_ok",
    "http_error",
    "online",
    "offline",
    "visibility",
    "pagehide",
];
fn id(v: &Value) -> Result<String, u16> {
    let s = v.as_str().ok_or(400u16)?;
    let parsed = uuid::Uuid::parse_str(s).map_err(|_| 400u16)?;
    if parsed.to_string() != s {
        return Err(400);
    }
    Ok(s.into())
}
fn clean(v: &Value) -> Result<Value, u16> {
    let mut row = Map::new();
    let event = v["event"]
        .as_str()
        .filter(|x| EVENTS.contains(x))
        .ok_or(400u16)?;
    row.insert("entry_id".into(), json!(id(&v["entry_id"])?));
    row.insert("event".into(), json!(event));
    for key in [
        "at",
        "snapshot_at",
        "snapshot_age_s",
        "raw_snapshot_age_s",
        "message_age_s",
        "failure_count",
        "session_error_count",
        "duration_ms",
        "clock_delta_ms",
        "server_clock_offset_ms",
    ] {
        if let Some(n) = v[key].as_f64().filter(|x| x.is_finite() && x.abs() <= 1e16) {
            row.insert(key.into(), json!(n));
        }
    }
    if !row.contains_key("at") {
        return Err(400);
    }
    for key in ["collector_error", "fallback", "warning", "online"] {
        if v[key].is_boolean() {
            row.insert(key.into(), v[key].clone());
        }
    }
    for (key, options) in [
        (
            "reason",
            &[
                "none",
                "collector",
                "stale",
                "sessions",
                "auth",
                "disconnected",
                "unknown",
                "timeout",
                "network",
                "invalid_json",
                "unavailable",
            ][..],
        ),
        ("visibility", &["visible", "hidden", "prerender"]),
        ("stream", &["none", "connecting", "open", "closed"]),
        ("endpoint", &["state", "usage"]),
        ("clock_source", &["server", "http_date", "unknown"]),
    ] {
        if let Some(s) = v[key].as_str().filter(|s| options.contains(s)) {
            row.insert(key.into(), json!(s));
        }
    }
    if let Some(status) = v["http_status"].as_u64().filter(|x| *x <= 599) {
        row.insert("http_status".into(), json!(status));
    }
    Ok(Value::Object(row))
}
pub struct Diagnostics {
    path: PathBuf,
    requests: Mutex<VecDeque<f64>>,
    lock: Mutex<()>,
}
impl Diagnostics {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            requests: Mutex::new(VecDeque::new()),
            lock: Mutex::new(()),
        }
    }
    fn connection(&self) -> Result<Connection, u16> {
        fs::create_dir_all(self.path.parent().ok_or(503u16)?).map_err(|_| 503u16)?;
        if self.path.is_symlink() {
            return Err(503);
        }
        OpenOptions::new()
            .create(true)
            .write(true)
            .mode(0o600)
            .open(&self.path)
            .map_err(|_| 503u16)?;
        fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600)).map_err(|_| 503u16)?;
        let db = Connection::open(&self.path).map_err(|_| 503u16)?;
        db.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| 503u16)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS records (client TEXT, entry TEXT, received REAL, payload TEXT, PRIMARY KEY(client,entry));").map_err(|_|503u16)?;
        Ok(db)
    }
    fn prune(db: &Connection) -> Result<(), u16> {
        db.execute(
            "DELETE FROM records WHERE received < ?",
            [crate::now() - 7. * 86400.],
        )
        .map_err(|_| 503u16)?;
        db.execute("DELETE FROM records WHERE rowid NOT IN (SELECT rowid FROM records ORDER BY received DESC,rowid DESC LIMIT 10000)",[]).map_err(|_|503u16)?;
        Ok(())
    }
    pub fn ingest(&self, payload: Value) -> Result<Vec<String>, u16> {
        if payload["version"].as_u64() != Some(1) {
            return Err(400);
        }
        let client = id(&payload["client_id"])?;
        let raw = payload["records"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 50)
            .ok_or(400u16)?;
        let rows = raw.iter().map(clean).collect::<Result<Vec<_>, _>>()?;
        let now = crate::now();
        {
            let mut req = self.requests.lock().map_err(|_| 503u16)?;
            while req.front().is_some_and(|at| *at < now - 60.) {
                req.pop_front();
            }
            if req.len() >= 120 {
                return Err(429);
            }
            req.push_back(now);
        }
        let _guard = self.lock.lock().map_err(|_| 503u16)?;
        let mut db = self.connection()?;
        let tx = db.transaction().map_err(|_| 503u16)?;
        let mut ack = Vec::new();
        for row in rows {
            let entry = id(&row["entry_id"])?;
            tx.execute(
                "INSERT OR IGNORE INTO records VALUES (?,?,?,?)",
                params![client, entry, now, row.to_string()],
            )
            .map_err(|_| 503u16)?;
            ack.push(entry);
        }
        Self::prune(&tx)?;
        tx.commit().map_err(|_| 503u16)?;
        Ok(ack)
    }
    pub fn read(&self, limit: usize) -> Result<Value, u16> {
        let _guard = self.lock.lock().map_err(|_| 503u16)?;
        let db = self.connection()?;
        Self::prune(&db)?;
        let total: i64 = db
            .query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0))
            .map_err(|_| 503u16)?;
        let mut q=db.prepare("SELECT client,received,payload FROM records ORDER BY received DESC,rowid DESC LIMIT ?").map_err(|_|503u16)?;
        let rows = q
            .query_map([limit.clamp(1, 1000) as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| 503u16)?;
        let mut result = Vec::new();
        for row in rows {
            let (client, at, raw) = row.map_err(|_| 503u16)?;
            let mut v: Value = serde_json::from_str(&raw).map_err(|_| 503u16)?;
            v["client_id"] = json!(client);
            v["received_at"] = json!(at);
            result.push(v);
        }
        Ok(json!({"total":total,"records":result}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privacy() {
        let v = json!({"entry_id":uuid::Uuid::new_v4().to_string(),"event":"sample","at":1,"prompt":"SECRET","url":"SECRET","http_status":200,"online":true});
        let cleaned = clean(&v).unwrap();
        assert!(!cleaned.to_string().contains("SECRET"));
        assert_eq!(cleaned["http_status"], 200);
        assert!(clean(&json!({"entry_id":"invalid","event":"sample","at":1})).is_err());
    }
}
