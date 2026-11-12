//! Desktop lifecycle evidence, independent of hook execution state.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

fn annotation(raw: &str) -> Result<(bool, Option<String>), ()> {
    let mut chars = raw.chars().peekable();
    let mut tokens = Vec::new();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '"' {
            let mut closed = false;
            let mut literal = String::from("\"");
            while let Some(c) = chars.next() {
                literal.push(c);
                if c == '\\' {
                    literal.push(chars.next().ok_or(())?);
                } else if c == '"' {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err(());
            }
            tokens.push(literal);
        } else if c.is_ascii_alphabetic() || c == '_' {
            let mut word = c.to_string();
            while chars
                .peek()
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
            {
                word.push(chars.next().unwrap());
            }
            tokens.push(word);
        } else {
            tokens.push(c.to_string());
        }
    }
    if tokens.is_empty() || !tokens.iter().any(|t| t == ":") {
        return Err(());
    }
    let mut depth = Vec::new();
    let mut flag = None;
    let mut title = None;
    for (i, t) in tokens.iter().enumerate() {
        match t.as_str() {
            "{" | "<" => depth.push(t.as_str()),
            "}" | ">" => {
                if depth.pop() != Some(if t == "}" { "{" } else { "<" }) {
                    return Err(());
                }
            }
            "title" if depth.is_empty() && tokens.get(i + 1).map(String::as_str) == Some(":") => {
                title = tokens
                    .get(i + 2)
                    .and_then(|t| serde_json::from_str::<String>(t).ok())
                    .map(|s| {
                        s.split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .chars()
                            .take(512)
                            .collect::<String>()
                    })
                    .filter(|s| !s.is_empty());
            }
            "archived" if depth.is_empty() => {
                if flag.is_some() || tokens.get(i + 1).map(String::as_str) != Some(":") {
                    return Err(());
                }
                flag = Some(match tokens.get(i + 2).map(String::as_str) {
                    Some("true") => true,
                    Some("false") => false,
                    _ => return Err(()),
                });
            }
            _ => {}
        }
    }
    if !depth.is_empty() {
        return Err(());
    }
    Ok((flag.unwrap_or(false), title))
}
#[cfg(test)]
fn archived(raw: &str) -> Result<bool, ()> {
    annotation(raw).map(|v| v.0)
}
fn names(path: &Path) -> std::io::Result<HashSet<String>> {
    fs::read_dir(path)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect()
}
fn bounded(path: &Path, limit: u64) -> std::io::Result<String> {
    let mut raw = String::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_string(&mut raw)?;
    if raw.len() as u64 > limit {
        return Err(std::io::Error::other("oversized evidence"));
    }
    Ok(raw)
}
pub(crate) struct Lifecycle {
    pub(crate) titles: HashMap<String, String>,
    root: PathBuf,
    cli: PathBuf,
    ledger: PathBuf,
    records: serde_json::Map<String, Value>,
    missing: HashMap<String, u32>,
    load_failed: bool,
    dirty: bool,
}
impl Lifecycle {
    pub(crate) fn new(root: PathBuf, ledger: PathBuf) -> Self {
        let cli = root
            .parent()
            .unwrap_or(Path::new("."))
            .join("antigravity-cli");
        let mut s = Self {
            titles: HashMap::new(),
            root,
            cli,
            ledger,
            records: Default::default(),
            missing: Default::default(),
            load_failed: false,
            dirty: false,
        };
        match bounded(&s.ledger, 4 * 1024 * 1024) {
            Ok(raw) => {
                let parsed = serde_json::from_str::<Value>(&raw).ok();
                if let Some(v) = parsed.filter(|v| {
                    v["schema"] == 1
                        && v["root"] == s.root.to_string_lossy().as_ref()
                        && v["records"].as_object().is_some_and(|r| {
                            r.values().all(|r| {
                                r["excluded"].is_boolean()
                                    && r["identity"].as_array().is_some_and(|a| {
                                        a.len() == 4 && a.iter().all(|x| x.as_u64().is_some())
                                    })
                            })
                        })
                }) {
                    s.records = v["records"].as_object().unwrap().clone();
                } else {
                    s.load_failed = true;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => s.load_failed = true,
        }
        s
    }
    pub(crate) fn scan(&mut self, ids: &[String]) -> (HashSet<String>, Vec<String>) {
        self.titles.clear();
        let mut excluded: HashSet<_> = ids
            .iter()
            .filter(|id| self.records.get(*id).is_some_and(|r| r["excluded"] == true))
            .cloned()
            .collect();
        let mut errors = Vec::new();
        if self.load_failed {
            errors.push("antigravity_lifecycle_ledger_invalid".into());
        }
        if ids.is_empty() {
            return (excluded, errors);
        }
        let dirs = [
            self.root.join("conversations"),
            self.root.join("annotations"),
        ];
        let scan = || -> std::io::Result<_> {
            let mut identity = Vec::new();
            let mut listings = Vec::new();
            for d in &dirs {
                let m = fs::metadata(d)?;
                identity.extend([m.dev(), m.ino()]);
                listings.push(names(d)?);
            }
            let cli = match names(&self.cli.join("conversations")) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashSet::new(),
                Err(e) => return Err(e),
            };
            Ok((json!(identity), listings, cli))
        };
        let Ok((identity, listings, cli)) = scan() else {
            self.missing.clear();
            if !self.records.is_empty() {
                errors.push("antigravity_lifecycle_unavailable".into());
            }
            return (excluded, errors);
        };
        let before = self.records.clone();
        for sid in ids {
            if sid.is_empty()
                || sid.len() > 200
                || !sid
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            {
                continue;
            }
            if cli.contains(&format!("{sid}.db")) {
                self.missing.remove(sid);
                excluded.remove(sid);
                if listings[0].contains(&format!("{sid}.db")) || self.records.contains_key(sid) {
                    errors.push("antigravity_lifecycle_ambiguous".into());
                }
                continue;
            }
            let db = listings[0].contains(&format!("{sid}.db"));
            let has_annotation = listings[1].contains(&format!("{sid}.pbtxt"));
            if db && has_annotation {
                let flag = bounded(&dirs[1].join(format!("{sid}.pbtxt")), 65536)
                    .ok()
                    .and_then(|s| annotation(&s).ok());
                self.missing.remove(sid);
                if let Some((flag, title)) = flag {
                    if let Some(title) = title {
                        self.titles.insert(sid.clone(), title);
                    }
                    self.records
                        .insert(sid.clone(), json!({"identity":identity,"excluded":flag}));
                    if flag {
                        excluded.insert(sid.clone());
                    } else {
                        excluded.remove(sid);
                    }
                } else {
                    errors.push("antigravity_lifecycle_annotation_invalid".into());
                }
            } else if !db
                && !has_annotation
                && self
                    .records
                    .get(sid)
                    .is_some_and(|r| r["identity"] == identity)
            {
                let n = self.missing.entry(sid.clone()).or_default();
                *n = (*n + 1).min(2);
                if *n >= 2 {
                    self.records.get_mut(sid).unwrap()["excluded"] = json!(true);
                    excluded.insert(sid.clone());
                }
            } else {
                self.missing.remove(sid);
            }
        }
        self.dirty |= before != self.records;
        if self.dirty {
            if self.save().is_err() {
                errors.push("antigravity_lifecycle_save_failed".into());
            } else {
                self.dirty = false;
                self.load_failed = false;
            }
        }
        (excluded, errors)
    }
    fn save(&self) -> std::io::Result<()> {
        fs::create_dir_all(self.ledger.parent().unwrap())?;
        let temp = self.ledger.with_extension("tmp");
        let mut f = fs::File::create(&temp)?;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(
            json!({"schema":1,"root":self.root,"records":self.records})
                .to_string()
                .as_bytes(),
        )?;
        fs::rename(temp, &self.ledger)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        base: PathBuf,
        life: Lifecycle,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("agy-life-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(base.join("antigravity/conversations")).unwrap();
            fs::create_dir_all(base.join("antigravity/annotations")).unwrap();
            let life = Lifecycle::new(
                base.join("antigravity"),
                base.join("runtime/antigravity-lifecycle.json"),
            );
            Self { base, life }
        }
        fn files(&self, raw: &str) {
            fs::write(
                self.base.join("antigravity/conversations/task.db"),
                b"fixture",
            )
            .unwrap();
            self.annotation(raw);
        }
        fn annotation(&self, raw: &str) {
            fs::write(self.base.join("antigravity/annotations/task.pbtxt"), raw).unwrap();
        }
        fn scan(&mut self) -> bool {
            self.life.scan(&["task".into()]).0.contains("task")
        }
        fn delete(&self) {
            fs::remove_file(self.base.join("antigravity/conversations/task.db")).unwrap();
            fs::remove_file(self.base.join("antigravity/annotations/task.pbtxt")).unwrap();
        }
        fn restart(&mut self) {
            self.life = Lifecycle::new(
                self.base.join("antigravity"),
                self.base.join("runtime/antigravity-lifecycle.json"),
            );
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    #[test]
    fn titles_rename_and_fallback() {
        let raw = format!(
            "title:{} archived:false nested:{{title:\"ignore\"}}",
            json!("한글 \"제목\" archived:true")
        );
        assert_eq!(
            annotation(&raw),
            Ok((false, Some("한글 \"제목\" archived:true".into())))
        );
        let mut f = Fixture::new();
        f.files(&raw);
        f.scan();
        assert_eq!(f.life.titles["task"], "한글 \"제목\" archived:true");
        f.annotation("title:\"변경된 제목\"");
        f.scan();
        assert_eq!(f.life.titles["task"], "변경된 제목");
        for raw in [
            "title:\"  \"",
            "archived:false",
            "title:123",
            r#"title:"bad\q""#,
        ] {
            f.annotation(raw);
            f.scan();
            assert!(!f.life.titles.contains_key("task"));
        }
        f.delete();
        f.scan();
        assert!(!f.life.titles.contains_key("task"));
    }

    #[test]
    fn lifecycle_and_restart() {
        let mut f = Fixture::new();
        assert!(!f.scan());
        assert!(!f.scan());
        f.files("title:\"test\"");
        assert!(!f.scan());
        f.annotation("archived:true");
        assert!(f.scan());
        f.annotation("archived:false");
        assert!(!f.scan());
        f.delete();
        f.restart();
        assert!(!f.scan());
        assert!(f.scan());
        f.restart();
        assert!(f.scan());
        f.files("archived:false");
        assert!(!f.scan());
    }
    #[test]
    fn incomplete_and_replaced_roots() {
        let mut f = Fixture::new();
        f.files("archived:false");
        f.scan();
        fs::remove_file(f.base.join("antigravity/annotations/task.pbtxt")).unwrap();
        assert!(!f.scan());
        assert!(!f.scan());
        fs::rename(f.base.join("antigravity/conversations"), f.base.join("old")).unwrap();
        fs::create_dir(f.base.join("antigravity/conversations")).unwrap();
        assert!(!f.scan());
        assert!(!f.scan());
    }
    #[test]
    fn invalid_and_unavailable_preserve_exclusion() {
        let mut f = Fixture::new();
        f.files("archived:true");
        assert!(f.scan());
        f.annotation("archived:banana");
        assert!(f.scan());
        fs::rename(f.base.join("antigravity"), f.base.join("unavailable")).unwrap();
        assert!(f.scan());
        assert!(f
            .life
            .scan(&["task".into()])
            .1
            .contains(&"antigravity_lifecycle_unavailable".into()));
    }
    #[test]
    fn cli_collision_and_invalid_id() {
        let mut f = Fixture::new();
        f.files("archived:true");
        fs::create_dir_all(f.base.join("antigravity-cli/conversations")).unwrap();
        fs::write(f.base.join("antigravity-cli/conversations/task.db"), b"").unwrap();
        assert!(!f.scan());
        assert!(f.life.scan(&["../task".into()]).0.is_empty());
    }
    #[test]
    fn parse_flags() {
        for (raw, want) in [
            ("title:\"archived:true\"", false),
            ("nested:{archived:true}", false),
            ("archived : true", true),
            ("archived:false", false),
        ] {
            assert_eq!(archived(raw), Ok(want));
        }
        for raw in [
            "",
            "garbage",
            "archived:no",
            "archived:true archived:false",
            "title:\"unterminated",
            "nested:{",
            "}",
        ] {
            assert!(archived(raw).is_err());
        }
    }
}
