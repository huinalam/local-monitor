//! Optional, source-bound summaries from the local Codex SDK worker.
use serde_json::{json, Value};
use std::{fs::File, io::Read, path::Path};
const LIMIT: u64 = 4 * 1024 * 1024;
pub fn apply(snapshot: &mut Value, path: &Path, now: f64) {
    let Ok(file) = File::open(path) else { return };
    let mut bytes = Vec::new();
    if file.take(LIMIT + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > LIMIT { return }
    let Ok(cache) = serde_json::from_slice::<Value>(&bytes) else { return };
    merge(snapshot, &cache, now);
}
fn merge(snapshot: &mut Value, cache: &Value, now: f64) {
    if cache["schema"] != 1 || cache["version"] != 3 || cache["model"] != "gpt-6-luna" { return }
    let (Some(rows), Some(entries)) = (snapshot["sessions"].as_array_mut(), cache["entries"].as_array()) else { return };
    for row in rows {
        if !matches!(row["status"].as_str(),Some("completed"|"waiting_input")) || !row["preview"].is_object() { continue }
        let source=json!({"status":row["status"],"preview":row["preview"]});
        for entry in entries.iter().rev().take(128) {
            if entry["provider"] != row["provider"] || entry["session_id"] != row["session_id"] || entry["source"] != source { continue }
            let Some(created) = entry["created_at"].as_f64() else { continue };
            if !created.is_finite() || created > now + 60. || now-created >= 86400. { continue }
            if entry["failed"] == true {
                row["preview_summary"]=json!({"status":"failed","model":"gpt-6-luna"});break;
            }
            let Some(lines) = entry["lines"].as_array() else { continue };
            if lines.len()!=2 || !lines.iter().all(|v|v.as_str().is_some_and(|s| !s.is_empty() && s.trim()==s && s.chars().count()<=40 && !s.chars().any(char::is_control))) { continue }
            row["preview_summary"]=json!({"lines":lines,"model":"gpt-6-luna"});break;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_status_expiry_and_invalid_cache() {
        let row=json!({"provider":"codex","session_id":"a","status":"completed","preview":{"text":"result"}});
        let mut snapshot=json!({"sessions":[row.clone()]});
        let cache=json!({"schema":1,"version":3,"model":"gpt-6-luna","entries":[{"provider":"codex","session_id":"a","source":{"status":"completed","preview":row["preview"]},"created_at":100.,"lines":["완료","원문 확인"]}]});
        merge(&mut snapshot,&cache,101.);assert_eq!(snapshot["sessions"][0]["preview_summary"]["lines"][0],"완료");
        for variant in [json!({"text":"new"}),Value::Null] {
            let mut r=row.clone();r["preview"]=variant;let mut s=json!({"sessions":[r]});merge(&mut s,&cache,101.);assert!(s["sessions"][0]["preview_summary"].is_null());
        }
        let mut r=row.clone();r["status"]=json!("running");let mut s=json!({"sessions":[r]});merge(&mut s,&cache,101.);assert!(s["sessions"][0]["preview_summary"].is_null());
        let mut s=json!({"sessions":[row]});merge(&mut s,&cache,90000.);assert!(s["sessions"][0]["preview_summary"].is_null());
        let mut old=cache.clone();old["version"]=json!(2);merge(&mut s,&old,101.);assert!(s["sessions"][0]["preview_summary"].is_null());
        let mut bad=cache.clone();bad["entries"][0]["lines"]=json!(["bad\nline","ok"]);merge(&mut s,&bad,101.);assert!(s["sessions"][0]["preview_summary"].is_null());
        bad["entries"][0]["failed"]=json!(true);merge(&mut s,&bad,101.);assert_eq!(s["sessions"][0]["preview_summary"]["status"],"failed");
        s["sessions"][0].as_object_mut().unwrap().remove("preview_summary");
        s["sessions"][0]["preview"]=json!({"text":"changed"});merge(&mut s,&bad,101.);assert!(s["sessions"][0]["preview_summary"].is_null());
    }
}
