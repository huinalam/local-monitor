//! Bounded assistant excerpts; raw user input, tool output and reasoning are excluded.
use serde_json::{json, Value};
#[derive(Clone, Default)]
pub(crate) struct Preview {
    text: String,
    questions: Vec<Value>,
    pending: Option<String>,
    truncated: bool,
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str { v[k].as_str().unwrap_or("") }
fn bounded(s: &str, n: usize) -> String { s.chars().take(n).collect() }
fn questions(v: &Value) -> Vec<Value> {
    v.as_array().into_iter().flatten().take(3).filter_map(|q| {
        let title=q["question"].as_str().or(q["title"].as_str()).unwrap_or("");
        if title.trim().is_empty() { return None; }
        let options:Vec<_>=q["options"].as_array().into_iter().flatten().take(6).filter_map(|o| {
            let label=o.as_str().or(o["label"].as_str())?;
            Some(json!({"label":bounded(label,200),"description":bounded(text(o,"description"),500)}))
        }).collect();
        Some(json!({"question":bounded(title,1000),"options":options}))
    }).collect()
}
impl Preview {
    pub(crate) fn clear(&mut self) { *self=Self::default(); }
    pub(crate) fn message(&mut self, value: &str) {
        let value=value.trim();
        if !value.is_empty() {
            self.clear(); self.text=bounded(value,8000);self.truncated=value.chars().count()>8000;
        }
    }
    pub(crate) fn output(&self) -> Option<Value> {
        if self.text.is_empty() && self.questions.is_empty() {None} else {Some(json!({"text":self.text,"questions":self.questions,"truncated":self.truncated}))}
    }
    pub(crate) fn codex(&mut self, item:&Value) -> Option<&'static str> {
        let p=&item["payload"];let kind=text(p,"type");
        match text(item,"type") {
            "event_msg" => match kind {
                "task_started"=>self.clear(),
                "agent_message"=>self.message(text(p,"message")),
                "task_complete"=>self.message(text(p,"last_agent_message")),
                _=>{}
            },
            "response_item" => match kind {
                "message" if text(p,"role")=="assistant" => {
                    let parts:Vec<_>=p["content"].as_array().into_iter().flatten().filter(|c| ["output_text","text"].contains(&text(c,"type"))).map(|c| text(c,"text")).collect();
                    self.message(&parts.join("\n"));
                },
                "function_call" => {
                    let name=text(p,"name").rsplit('.').next().unwrap_or("");
                    if ["request_user_input","request_user_input_async"].contains(&name) {
                        if let Ok(args)=serde_json::from_str::<Value>(text(p,"arguments")) {
                            let qs=questions(&args["questions"]);
                            if !qs.is_empty() {
                                self.clear();self.questions=qs;
                                if name=="request_user_input" && !text(p,"call_id").is_empty() {
                                    self.pending=Some(text(p,"call_id").into());return Some("waiting_input");
                                }
                            }
                        }
                    }
                },
                "function_call_output" if self.pending.as_deref().is_some_and(|id| id==text(p,"call_id")) => {
                    self.clear();return Some("running");
                },
                _=>{}
            },
            _=>{}
        }
        None
    }
    pub(crate) fn claude(&mut self,item:&Value) {
        let content=&item["message"]["content"];
        match text(item,"type") {
            "user" if content.is_string() || content.as_array().is_some_and(|a| a.iter().any(|c| ["text","tool_result"].contains(&text(c,"type"))))=>self.clear(),
            "assistant"=>{
                let parts:Vec<_>=content.as_array().into_iter().flatten().filter(|c|text(c,"type")=="text").map(|c|text(c,"text")).collect();
                self.message(&parts.join("\n"));
                for c in content.as_array().into_iter().flatten() {
                    if text(c,"type")=="tool_use" && text(c,"name")=="AskUserQuestion" {
                        let qs=questions(&c["input"]["questions"]);if !qs.is_empty(){self.questions=qs;}
                    }
                }
            },_=>{}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assistant_only_bounded_and_new_turn_clears() {
        let mut p=Preview::default();
        p.codex(&json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"private prompt"}]}}));
        assert!(p.output().is_none());
        p.codex(&json!({"type":"event_msg","payload":{"type":"agent_message","message":"가".repeat(9000)}}));
        assert_eq!(p.output().unwrap()["text"].as_str().unwrap().chars().count(),8000);
        assert_eq!(p.output().unwrap()["truncated"],true);
        p.codex(&json!({"type":"event_msg","payload":{"type":"task_started"}}));
        assert!(p.output().is_none());
    }
    #[test]
    fn question_waits_only_until_matching_result() {
        let mut p=Preview::default();
        let q=json!({"questions":[{"question":"Choose?","options":[{"label":"A","description":"First"}]}]}).to_string();
        assert_eq!(p.codex(&json!({"type":"response_item","payload":{"type":"function_call","name":"functions.request_user_input","call_id":"q","arguments":q}})),Some("waiting_input"));
        assert_eq!(p.output().unwrap()["questions"][0]["options"][0]["label"],"A");
        assert_eq!(p.codex(&json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"other","output":"SECRET"}})),None);
        assert_eq!(p.codex(&json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"q","output":"SECRET"}})),Some("running"));
        assert!(p.output().is_none());
    }
    #[test]
    fn claude_excludes_thinking_and_results() {
        let mut p=Preview::default();
        p.claude(&json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"Done"},{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"Next?","options":[{"label":"Review"}]}]}}]}}));
        assert_eq!(p.output().unwrap()["text"],"Done");
        assert_eq!(p.output().unwrap()["questions"].as_array().unwrap().len(),1);
        p.claude(&json!({"type":"user","message":{"content":[{"type":"tool_result","content":"private"}]}}));
        assert!(p.output().is_none());
    }
    #[test]
    fn malformed_inputs_do_not_panic_or_replace_message() {
        let mut p=Preview::default();p.message("kept");
        for args in ["{", "null", "42", "{\"questions\":[null,3]}"] {
            p.codex(&json!({"type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":args}}));
        }
        assert_eq!(p.output().unwrap()["text"],"kept");
        p.claude(&json!({"type":"user","message":{"content":42}}));
    }
}
