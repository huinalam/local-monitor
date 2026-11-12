//! Observation-only completion window, updated under Shared's write lock.
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
#[derive(Default)]
pub struct CompletionWindow {
    entries: HashMap<(String, String, String), Value>,
    coverage: Option<f64>,
    last: Option<(f64, f64)>,
    warnings: BTreeMap<String, f64>,
}
impl CompletionWindow {
    pub fn update(&mut self, now: f64, mono: f64, events: &[Value], healthy: bool, source_error: bool) -> Value {
        if let Some((wall, tick)) = self.last {
            if ((now-wall)-(mono-tick)).abs() > 5. {
                self.entries.clear(); self.warnings.clear(); self.coverage = None;
                self.warnings.insert("clock_jump".into(), now+1800.);
            }
            if mono-tick > 15. {
                self.coverage = None;
                self.warnings.insert("collector_gap".into(), now+1800.);
            }
        }
        self.last = Some((now, mono));
        if !healthy || source_error {
            self.coverage = None;
            self.warnings.insert(if source_error {"source_error"} else {"collector_gap"}.into(), now+1800.);
        } else if self.coverage.is_none() { self.coverage = Some(now); }
        self.entries.retain(|_, e| e["at"].as_f64().is_some_and(|at| at > now-1800. && at <= now));
        for e in events {
            let at = e["at"].as_f64();
            let valid = at.is_some_and(|t| t.is_finite() && t <= now)
                && matches!(e["provider"].as_str(), Some("codex"|"claude"|"antigravity"))
                && ["session_id","turn_id","id"].iter().all(|k| e[k].as_str().is_some_and(|s| !s.is_empty()));
            if !valid { self.warnings.insert("invalid_event".into(), now+1800.); continue; }
            let at = at.unwrap();
            if at <= now-1800. { continue; }
            let key = (e["provider"].as_str().unwrap().into(), e["session_id"].as_str().unwrap().into(), e["turn_id"].as_str().unwrap().into());
            if let Some(old) = self.entries.get(&key) {
                if old["at"].as_f64() != Some(at) { self.warnings.insert("invalid_event".into(), now+1800.); }
                continue;
            }
            let mut entry = json!({});
            for k in ["id","provider","session_id","turn_id","at"] { entry[k] = e[k].clone(); }
            for k in ["title","cwd"] { entry[k] = json!(e[k].as_str().unwrap_or("")); }
            self.entries.insert(key, entry);
        }
        let mut ordered: Vec<Value> = self.entries.values().cloned().collect();
        let seq = |e: &Value| e["id"].as_str().unwrap_or("").rsplit(':').next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        ordered.sort_by(|a,b| a["at"].as_f64().unwrap().total_cmp(&b["at"].as_f64().unwrap()).then(seq(a).cmp(&seq(b))).then(a["id"].as_str().cmp(&b["id"].as_str())));
        if ordered.len() > 10000 {
            let excess = ordered.len()-10000;
            let until = ordered[excess-1]["at"].as_f64().unwrap()+1800.;
            let warning = self.warnings.entry("capacity".into()).or_insert(until); *warning = warning.max(until);
            for e in ordered.drain(..excess) {
                self.entries.remove(&(e["provider"].as_str().unwrap().into(), e["session_id"].as_str().unwrap().into(), e["turn_id"].as_str().unwrap().into()));
            }
        }
        self.warnings.retain(|_, t| *t > now);
        let mut reasons: Vec<String> = self.warnings.keys().cloned().collect();
        if self.coverage.is_none_or(|t| now-t < 1800.) { reasons.push("warming_up".into()); }
        reasons.sort();
        json!({"schema":1,"seconds":1800,"as_of":now,"coverage_since":self.coverage,"partial":!reasons.is_empty(),"reasons":reasons,"entries":ordered})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(i: usize, at: f64) -> Value { json!({"id":format!("x:{i}"),"provider":"codex","session_id":"same","turn_id":i.to_string(),"at":at}) }
    #[test]
    fn shared_contract() {
        let steps: Vec<Value> = serde_json::from_str(include_str!("../../tests/fixtures/completion-window.json")).unwrap();
        let mut w = CompletionWindow::default();
        for s in steps {
            let events = s["events"].as_array().cloned().unwrap_or_default();
            let r = w.update(s["now"].as_f64().unwrap(),s["mono"].as_f64().unwrap(),&events,s["healthy"].as_bool().unwrap_or(true),false);
            assert_eq!(r["entries"].as_array().unwrap().len() as u64,s["count"].as_u64().unwrap());
            assert_eq!(r["partial"],s["partial"]);
            if s.get("reason").is_some() { assert!(r["reasons"].as_array().unwrap().contains(&s["reason"])); }
            if s.get("coverage").is_some() { assert_eq!(r["coverage_since"].as_f64(),s["coverage"].as_f64()); }
        }
    }
    #[test]
    fn coverage_expiry_capacity_and_duplicate() {
        let mut w = CompletionWindow::default();
        for t in (1000..=2800).step_by(5) {
            let events = if t==1005 {vec![event(1,1001.)]} else {vec![]};
            let r=w.update(t as f64,t as f64,&events,true,false);
            if t==2800 { assert_eq!(r["partial"],false); assert_eq!(r["entries"].as_array().unwrap().len(),1); }
        }
        assert_eq!(w.update(2801.,2801.,&[],true,false)["entries"],json!([]));
        let mut w=CompletionWindow::default();
        let events: Vec<_>=(0..10001).map(|i|event(i,1000.)).collect();
        let r=w.update(1000.,0.,&events,true,false);
        assert_eq!(r["entries"].as_array().unwrap().len(),10000);
        assert_eq!(r["entries"][0]["id"],"x:1");
        assert!(r["reasons"].as_array().unwrap().contains(&json!("capacity")));
        let r=w.update(1005.,5.,&[event(1,1003.)],true,true);
        assert_eq!(r["entries"][0]["at"],1000.);
        assert!(r["reasons"].as_array().unwrap().contains(&json!("invalid_event")));
        assert!(r["coverage_since"].is_null());
    }
}
