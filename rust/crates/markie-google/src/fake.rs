//! A fake Google on `127.0.0.1`, for tests and scenes. Never the real one.
//!
//! It speaks enough of each endpoint import and two-way sync use:
//! - `GET /o/oauth2/v2/auth`: checks the Picker parameters and redirects to the
//!   loopback address with a code, the state and `picked_file_ids`, as
//!   Google's desktop Picker does after the person picks;
//! - `POST /token`: the code exchange (PKCE checked) and refresh;
//! - `POST /revoke`;
//! - `GET /v1/documents/{id}`: the Doc from its model (`model.rs`), with
//!   indices, lists and inline suggestions;
//! - `POST /v1/documents/{id}:batchUpdate`: applies the requests as one write
//!   or refuses them all. `writeControl.requiredRevisionId` must be the
//!   latest; `targetRevisionId` may be older, and the requests are then moved
//!   past every collaborator edit since, as Google merges them;
//!   `writeMode: SUGGEST` records suggestions. Readers get 403, commenters
//!   may only suggest;
//! - `GET /drive/v3/files/{id}` with `ownedByMe` and `capabilities`,
//!   `GET /drive/v3/files/{id}/export`, `GET /drive/v3/files?q=...`,
//!   `GET /drive/v3/about`, `GET /drive/v3/changes/startPageToken`,
//!   `GET /drive/v3/changes`, all behind a bearer token.
//!
//! Knobs: `throttle` answers the next N API calls with 429; `trash` and
//! `unshare` end access; `changes_cover_picks: false` makes changes.list
//! leave picked files out, the unverified case; `offline` refuses connections.
//! Every Doc in it is made up.
use crate::model::{DocModel, Mode, Xf, map_point, transform_seq};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Role {
    #[default]
    Owner,
    Writer,
    Commenter,
    Reader,
}

#[derive(Clone, Default)]
pub struct FakeFile {
    pub meta: Value,
    /// A one-tab Doc lives in its model; anything else is served as written.
    pub model: Option<DocModel>,
    pub raw: Option<Value>,
    pub docx: Vec<u8>,
    /// Picked: `drive.file` covers it.
    pub granted: bool,
    pub parent: Option<String>,
    pub role: Role,
    /// The revision number; `revisionId` is `rev-<id>-<n>`.
    pub rev: u64,
    /// For each revision after the first kept one: what it did to positions,
    /// or None when it can't be merged past (a whole new body).
    pub log: Vec<(u64, Option<Vec<Xf>>)>,
    /// The model at each recent revision, for merging stale writes.
    pub snapshots: Vec<(u64, DocModel)>,
    /// Comment anchors (start, end), moved with every edit.
    pub comments: Vec<(usize, usize)>,
}

impl FakeFile {
    pub fn doc(&self) -> Option<Value> {
        let mut d = self.model.as_ref().map(DocModel::to_doc).or_else(|| self.raw.clone())?;
        d["revisionId"] = json!(self.revision_id());
        Some(d)
    }
    pub fn revision_id(&self) -> String {
        format!("rev-{}-{}", self.meta["id"].as_str().unwrap_or_default(), self.rev)
    }
    pub fn markdown(&self) -> String {
        self.doc().map(|d| crate::convert::doc_to_markdown(&d).markdown).unwrap_or_default()
    }
    /// The text a comment is anchored to now.
    pub fn anchored(&self, i: usize) -> String {
        let (s, e) = self.comments[i];
        let m = self.model.as_ref().unwrap();
        let cus: Vec<u16> = m.units[s..e.min(m.len())].iter().filter_map(|u| if let crate::model::UKind::Text(c) = u.kind { Some(c) } else { None }).collect();
        String::from_utf16_lossy(&cus)
    }
    fn bump(&mut self, xfs: Option<Vec<Xf>>) {
        if let Some(m) = &self.model {
            self.snapshots.push((self.rev, m.clone()));
            if self.snapshots.len() > 20 {
                self.snapshots.remove(0);
            }
        }
        self.rev += 1;
        if let Some(x) = &xfs {
            for c in &mut self.comments {
                c.0 = map_point(c.0, x, false);
                c.1 = map_point(c.1, x, true);
            }
        }
        self.log.push((self.rev, xfs));
        self.meta["version"] = json!(self.rev.to_string());
        self.meta["modifiedTime"] = json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
}

#[derive(Default)]
pub struct FakeState {
    pub files: HashMap<String, FakeFile>,
    /// What the next Picker visit returns.
    pub pick: Vec<String>,
    /// The next Picker visit says "no".
    pub deny: bool,
    /// Whether picking a folder grants the Docs inside it (the unverified question).
    pub folder_grants_children: bool,
    codes: HashMap<String, (String, String)>,
    pub refresh_tokens: Vec<String>,
    pub access_tokens: Vec<String>,
    /// Every request line, for assertions.
    pub log: Vec<String>,
    /// Every `batchUpdate` body, for assertions.
    pub writes: Vec<(String, Value)>,
    counter: u64,
    /// The next N API calls answer 429.
    pub throttle: usize,
    /// Whether changes.list lists files the app may see through `drive.file`.
    pub changes_cover_picks: bool,
    /// Drive's change log: (sequence, file).
    pub changes: Vec<(u64, String)>,
    /// Refuse every API call as if the network were down (the connection closes).
    pub offline: bool,
}

pub struct FakeGoogle {
    pub base: String,
    pub state: Arc<Mutex<FakeState>>,
    stop: Arc<AtomicBool>,
}

impl Drop for FakeGoogle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Give a hand-made Doc the indices Google would: the section break, then
/// each paragraph and table in order.
pub fn with_indices(doc: &Value) -> Value {
    let mut doc = doc.clone();
    let tabbed = doc.get("tabs").and_then(Value::as_array).is_some_and(|t| !t.is_empty());
    let tab = if tabbed { doc.pointer_mut("/tabs/0/documentTab").unwrap() } else { &mut doc };
    let Some(content) = tab.pointer_mut("/body/content").and_then(Value::as_array_mut) else { return doc };
    if content.first().is_some_and(|c| c.get("sectionBreak").is_none()) {
        content.insert(0, json!({"sectionBreak": {}}));
    }
    fn para(p: &mut Value, at: &mut i64) {
        let start = *at;
        if let Some(els) = p.pointer_mut("/paragraph/elements").and_then(Value::as_array_mut) {
            if !els.iter().any(|e| e.pointer("/textRun/content").and_then(Value::as_str).is_some_and(|c| c.ends_with('\n'))) {
                els.push(json!({"textRun": {"content": "\n", "textStyle": {}}}));
            }
            for e in els.iter_mut() {
                let n = e.pointer("/textRun/content").and_then(Value::as_str).map(|c| c.encode_utf16().count() as i64).unwrap_or(1);
                e["startIndex"] = json!(*at);
                *at += n;
                e["endIndex"] = json!(*at);
            }
        }
        p["startIndex"] = json!(start);
        p["endIndex"] = json!(*at);
    }
    fn elements(list: &mut [Value], at: &mut i64) {
        for el in list.iter_mut() {
            if el.get("sectionBreak").is_some() {
                if *at > 0 {
                    el["startIndex"] = json!(*at);
                }
                *at += 1;
                el["endIndex"] = json!(*at);
            } else if el.get("paragraph").is_some() {
                para(el, at);
            } else if el.get("table").is_some() {
                let start = *at;
                *at += 1;
                if let Some(rows) = el.pointer_mut("/table/tableRows").and_then(Value::as_array_mut) {
                    for row in rows {
                        let rs = *at;
                        *at += 1;
                        if let Some(cells) = row.get_mut("tableCells").and_then(Value::as_array_mut) {
                            for cell in cells {
                                let cs = *at;
                                *at += 1;
                                if let Some(c) = cell.get_mut("content").and_then(Value::as_array_mut) {
                                    elements(c, at);
                                }
                                cell["startIndex"] = json!(cs);
                                cell["endIndex"] = json!(*at);
                            }
                        }
                        row["startIndex"] = json!(rs);
                        row["endIndex"] = json!(*at);
                    }
                }
                *at += 1;
                el["startIndex"] = json!(start);
                el["endIndex"] = json!(*at);
            }
        }
    }
    let mut at = 0;
    elements(content, &mut at);
    // A table is never last in a body.
    if content.last().is_some_and(|c| c.get("table").is_some()) {
        let mut p = json!({"paragraph": {"elements": [{"textRun": {"content": "\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}});
        para(&mut p, &mut at);
        content.push(p);
    }
    doc
}

impl FakeGoogle {
    pub fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("a local port");
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(FakeState { changes_cover_picks: true, ..Default::default() }));
        let stop = Arc::new(AtomicBool::new(false));
        let (s, st) = (state.clone(), stop.clone());
        std::thread::spawn(move || {
            while !st.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let s = s.clone();
                        std::thread::spawn(move || serve(stream, &s));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self { base, state, stop }
    }

    pub fn config(&self) -> crate::config::ClientConfig {
        crate::config::ClientConfig::fake(&self.base)
    }

    /// Add a made-up Doc at revision (and Drive version) `version`.
    pub fn add_doc(&self, id: &str, title: &str, version: u64, doc: Value) {
        let modified = if version <= 1 { "2026-11-25T09:00:00.000Z".to_string() } else { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) };
        let meta = json!({"id": id, "name": title, "mimeType": crate::DOC_MIME, "version": version.to_string(), "modifiedTime": modified, "trashed": false});
        let mut doc = with_indices(&doc);
        doc["documentId"] = json!(id);
        doc["title"] = json!(title);
        let tabs = doc.get("tabs").and_then(Value::as_array).map_or(1, Vec::len);
        let model = (tabs <= 1).then(|| DocModel::from_doc(&doc).ok()).flatten();
        let docx = format!("PK fake docx for {title} v{version}").into_bytes();
        let mut s = self.state.lock().unwrap();
        let (granted, parent, role) = s.files.get(id).map(|f| (f.granted, f.parent.clone(), f.role)).unwrap_or_default();
        let raw = model.is_none().then_some(doc);
        s.files.insert(id.into(), FakeFile { meta, model, raw, docx, granted, parent, role, rev: version, ..Default::default() });
        push_change(&mut s, id);
    }

    /// Replace a Doc's whole body in "Google" at a new version. Writes based
    /// on an earlier revision can't be merged past this one.
    pub fn edit_doc(&self, id: &str, version: u64, doc: Value) {
        let title = self.state.lock().unwrap().files[id].meta["name"].as_str().unwrap().to_string();
        let (comments, log) = {
            let s = self.state.lock().unwrap();
            (s.files[id].comments.clone(), s.files[id].log.clone())
        };
        self.add_doc(id, &title, version, doc);
        let mut s = self.state.lock().unwrap();
        let f = s.files.get_mut(id).unwrap();
        f.comments = comments;
        f.log = log;
        f.log.push((version, None));
    }

    /// A collaborator edits the Doc in Google with Docs requests.
    pub fn collaborate(&self, id: &str, requests: &[Value]) {
        let mut s = self.state.lock().unwrap();
        let f = s.files.get_mut(id).unwrap();
        let mut m = f.model.clone().expect("a one-tab Doc");
        let mut xfs = Vec::new();
        for r in requests {
            xfs.extend(m.apply(r, Mode::Edit, "").expect("a valid collaborator edit"));
        }
        f.model = Some(m);
        f.bump(Some(xfs));
        push_change(&mut s, id);
    }

    /// The owner accepts or rejects every suggestion.
    pub fn resolve_suggestions(&self, id: &str, accept: bool) {
        let mut s = self.state.lock().unwrap();
        let f = s.files.get_mut(id).unwrap();
        let mut m = f.model.clone().unwrap();
        m.resolve_suggestions(accept);
        f.model = Some(m);
        f.bump(None);
        push_change(&mut s, id);
    }

    /// A comment anchored to the first `text` in the Doc. Returns its number.
    pub fn add_comment(&self, id: &str, text: &str) -> usize {
        let mut s = self.state.lock().unwrap();
        let f = s.files.get_mut(id).unwrap();
        let m = f.model.as_ref().unwrap();
        let all: Vec<u16> = m.units.iter().map(|u| if let crate::model::UKind::Text(c) = u.kind { c } else { 0 }).collect();
        let needle: Vec<u16> = text.encode_utf16().collect();
        let at = all.windows(needle.len()).position(|w| w == needle.as_slice()).expect("the anchor text");
        f.comments.push((at, at + needle.len()));
        f.comments.len() - 1
    }

    pub fn file(&self, id: &str) -> FakeFile {
        self.state.lock().unwrap().files[id].clone()
    }

    pub fn markdown(&self, id: &str) -> String {
        self.file(id).markdown()
    }

    pub fn set_role(&self, id: &str, role: Role) {
        self.state.lock().unwrap().files.get_mut(id).unwrap().role = role;
    }

    pub fn add_folder(&self, id: &str, name: &str, children: &[&str]) {
        let mut s = self.state.lock().unwrap();
        s.files.insert(id.into(), FakeFile { meta: json!({"id": id, "name": name, "mimeType": crate::FOLDER_MIME, "trashed": false}), ..Default::default() });
        for c in children {
            if let Some(f) = s.files.get_mut(*c) {
                f.parent = Some(id.into());
            }
        }
    }

    pub fn add_other(&self, id: &str, name: &str, mime: &str) {
        self.state.lock().unwrap().files.insert(id.into(), FakeFile { meta: json!({"id": id, "name": name, "mimeType": mime}), ..Default::default() });
    }

    pub fn set_pick(&self, ids: &[&str]) {
        self.state.lock().unwrap().pick = ids.iter().map(|s| s.to_string()).collect();
    }

    pub fn trash(&self, id: &str) {
        let mut s = self.state.lock().unwrap();
        s.files.get_mut(id).unwrap().meta["trashed"] = json!(true);
        push_change(&mut s, id);
    }

    /// The owner stops sharing the Doc with this account.
    pub fn unshare(&self, id: &str) {
        self.state.lock().unwrap().files.get_mut(id).unwrap().granted = false;
    }

    pub fn log(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
    }

    pub fn writes(&self) -> Vec<(String, Value)> {
        self.state.lock().unwrap().writes.clone()
    }

    /// Plays the browser: visits the consent page and follows its redirect to
    /// the loopback address, as the system browser would after a pick.
    pub fn browse(url: &str) {
        let http = crate::oauth::http_client();
        let resp = http.get(url).send().expect("the fake consent page");
        if let Some(location) = resp.headers().get("location").and_then(|l| l.to_str().ok()) {
            let _ = http.get(location).send();
        }
    }
}

fn push_change(s: &mut FakeState, id: &str) {
    let seq = s.changes.len() as u64 + 1;
    s.changes.push((seq, id.to_string()));
}

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let headers: HashMap<String, String> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let url = url::Url::parse(&format!("http://fake{target}")).ok()?;
    let query = url.query_pairs().into_owned().collect();
    Some(Request { method, path: url.path().to_string(), query, headers, body: String::from_utf8_lossy(&body).to_string() })
}

fn send(stream: &mut TcpStream, status: u16, content_type: &str, extra: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        429 => "Too Many Requests",
        _ => "Not Found",
    };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn send_json(stream: &mut TcpStream, status: u16, v: &Value) {
    send(stream, status, "application/json", "", v.to_string().as_bytes());
}

fn google_error(stream: &mut TcpStream, status: u16, message: &str) {
    send_json(stream, status, &json!({"error": {"code": status, "message": message}}));
}

fn serve(mut stream: TcpStream, state: &Mutex<FakeState>) {
    let Some(req) = read_request(&mut stream) else { return };
    state.lock().unwrap().log.push(format!("{} {}", req.method, req.path));
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/o/oauth2/v2/auth") => authorize(&mut stream, &req, state),
        ("POST", "/token") => token(&mut stream, &req, state),
        ("POST", "/revoke") => {
            let form: HashMap<String, String> = url::form_urlencoded::parse(req.body.as_bytes()).into_owned().collect();
            let t = form.get("token").cloned().unwrap_or_default();
            state.lock().unwrap().refresh_tokens.retain(|r| *r != t);
            send_json(&mut stream, 200, &json!({}));
        }
        _ => api(&mut stream, &req, state),
    }
}

fn authorize(stream: &mut TcpStream, req: &Request, state: &Mutex<FakeState>) {
    let q = &req.query;
    let ok = q.get("scope").map(String::as_str) == Some(crate::DRIVE_FILE_SCOPE)
        && q.get("trigger_onepick").map(String::as_str) == Some("true")
        && q.get("code_challenge_method").map(String::as_str) == Some("S256")
        && q.get("response_type").map(String::as_str) == Some("code")
        && q.get("redirect_uri").is_some_and(|r| r.starts_with("http://127.0.0.1:"));
    if !ok {
        return send(stream, 400, "text/plain", "", b"bad authorize request");
    }
    let redirect = q["redirect_uri"].clone();
    let st = q.get("state").cloned().unwrap_or_default();
    let mut s = state.lock().unwrap();
    let location = if s.deny {
        format!("{redirect}?error=access_denied&state={st}")
    } else {
        s.counter += 1;
        let code = format!("code-{}", s.counter);
        s.codes.insert(code.clone(), (q.get("code_challenge").cloned().unwrap_or_default(), redirect.clone()));
        let picked = s.pick.clone();
        let folder_grants = s.folder_grants_children;
        for id in &picked {
            if let Some(f) = s.files.get_mut(id) {
                f.granted = true;
            }
            if folder_grants {
                for f in s.files.values_mut().filter(|f| f.parent.as_deref() == Some(id.as_str())) {
                    f.granted = true;
                }
            }
        }
        format!("{redirect}?state={st}&code={code}&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&picked_file_ids={}", picked.join(","))
    };
    send(stream, 302, "text/plain", &format!("Location: {location}\r\n"), b"");
}

fn token(stream: &mut TcpStream, req: &Request, state: &Mutex<FakeState>) {
    let form: HashMap<String, String> = url::form_urlencoded::parse(req.body.as_bytes()).into_owned().collect();
    let mut s = state.lock().unwrap();
    if form.get("client_id").is_none_or(|c| c.is_empty()) {
        return send_json(stream, 401, &json!({"error": "invalid_client"}));
    }
    s.counter += 1;
    let n = s.counter;
    match form.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let code = form.get("code").cloned().unwrap_or_default();
            let Some((challenge, redirect)) = s.codes.remove(&code) else {
                return send_json(stream, 400, &json!({"error": "invalid_grant"}));
            };
            let verifier = form.get("code_verifier").cloned().unwrap_or_default();
            if crate::oauth::s256(&verifier) != challenge || form.get("redirect_uri") != Some(&redirect) {
                return send_json(stream, 400, &json!({"error": "invalid_grant"}));
            }
            let (access, refresh) = (format!("access-{n}"), format!("refresh-{n}"));
            s.access_tokens.push(access.clone());
            s.refresh_tokens.push(refresh.clone());
            send_json(stream, 200, &json!({"access_token": access, "refresh_token": refresh, "expires_in": 3599, "scope": crate::DRIVE_FILE_SCOPE, "token_type": "Bearer"}));
        }
        Some("refresh_token") => {
            let refresh = form.get("refresh_token").cloned().unwrap_or_default();
            if !s.refresh_tokens.contains(&refresh) {
                return send_json(stream, 400, &json!({"error": "invalid_grant"}));
            }
            let access = format!("access-{n}");
            s.access_tokens.push(access.clone());
            send_json(stream, 200, &json!({"access_token": access, "expires_in": 3599, "scope": crate::DRIVE_FILE_SCOPE, "token_type": "Bearer"}));
        }
        _ => send_json(stream, 400, &json!({"error": "unsupported_grant_type"})),
    }
}

fn file_json(f: &FakeFile) -> Value {
    let mut meta = f.meta.clone();
    if meta["mimeType"] == crate::DOC_MIME {
        meta["ownedByMe"] = json!(f.role == Role::Owner);
        meta["capabilities"] = json!({"canEdit": matches!(f.role, Role::Owner | Role::Writer), "canComment": f.role != Role::Reader});
    }
    meta
}

fn api(stream: &mut TcpStream, req: &Request, state: &Mutex<FakeState>) {
    let bearer = req.headers.get("authorization").and_then(|a| a.strip_prefix("Bearer ")).unwrap_or_default().to_string();
    let mut s = state.lock().unwrap();
    if s.offline {
        // The connection drops, as with no network.
        return;
    }
    if !s.access_tokens.contains(&bearer) {
        drop(s);
        return google_error(stream, 401, "Request had invalid authentication credentials.");
    }
    if s.throttle > 0 {
        s.throttle -= 1;
        drop(s);
        return send(stream, 429, "application/json", "Retry-After: 1\r\n", json!({"error": {"code": 429, "message": "Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user'.", "status": "RESOURCE_EXHAUSTED"}}).to_string().as_bytes());
    }
    let parts: Vec<String> = req.path.trim_start_matches('/').split('/').map(str::to_string).collect();
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    let granted = |s: &FakeState, id: &str| s.files.get(id).filter(|f| f.granted).cloned();
    match (req.method.as_str(), parts.as_slice()) {
        ("POST", ["v1", "documents"]) => {
            // documents.create: a new Doc this app made, so drive.file covers it.
            let title = serde_json::from_str::<Value>(&req.body).ok().and_then(|b| b.get("title").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| "Untitled document".into());
            s.counter += 1;
            let id = format!("made{}", s.counter);
            let doc = with_indices(&json!({"tabs": [{"tabProperties": {"tabId": "t.0", "title": "Tab 1"}, "documentTab": {"body": {"content": [{"paragraph": {"elements": [{"textRun": {"content": "\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}]}}}]}));
            let meta = json!({"id": id, "name": title, "mimeType": crate::DOC_MIME, "version": "1", "modifiedTime": "2026-11-26T09:00:00.000Z", "trashed": false});
            let mut d = doc.clone();
            d["documentId"] = json!(id);
            d["title"] = json!(title);
            let model = DocModel::from_doc(&d).ok();
            s.files.insert(id.clone(), FakeFile { meta, model, granted: true, rev: 1, ..Default::default() });
            push_change(&mut s, &id);
            let mut out = s.files[&id].doc().unwrap();
            out["documentId"] = json!(id);
            send_json(stream, 200, &out);
        }
        ("PATCH", ["drive", "v3", "files", id]) => {
            let body: Value = serde_json::from_str(&req.body).unwrap_or_default();
            // Metadata only: this fake refuses content here, as Markie never sends any.
            if body.as_object().is_none_or(|o| o.keys().any(|k| k != "trashed")) {
                return google_error(stream, 400, "this fake takes only {trashed}");
            }
            match s.files.get_mut(*id).filter(|f| f.granted) {
                Some(f) => {
                    f.meta["trashed"] = body["trashed"].clone();
                    let meta = f.meta.clone();
                    let id = id.to_string();
                    push_change(&mut s, &id);
                    send_json(stream, 200, &meta);
                }
                None => google_error(stream, 404, "File not found."),
            }
        }
        ("POST", ["v1", "documents", tail]) if tail.ends_with(":batchUpdate") => {
            let id = tail.trim_end_matches(":batchUpdate").to_string();
            batch_update(stream, &mut s, &id, &req.body);
        }
        ("GET", ["v1", "documents", id]) => match granted(&s, id).and_then(|f| f.doc()) {
            Some(doc) if req.query.get("includeTabsContent").map(String::as_str) == Some("true") => send_json(stream, 200, &doc),
            Some(_) => google_error(stream, 400, "this fake only answers includeTabsContent=true"),
            None => google_error(stream, 404, "Requested entity was not found."),
        },
        ("GET", ["drive", "v3", "about"]) => send_json(stream, 200, &json!({"user": {"displayName": "Sample Person", "emailAddress": "sample.person@example.com"}})),
        ("GET", ["drive", "v3", "changes", "startPageToken"]) => {
            let t = s.changes.len() + 1;
            send_json(stream, 200, &json!({"startPageToken": t.to_string()}));
        }
        ("GET", ["drive", "v3", "changes"]) => {
            let from: u64 = req.query.get("pageToken").and_then(|t| t.parse().ok()).unwrap_or(1);
            let cover = s.changes_cover_picks;
            let list: Vec<Value> = s
                .changes
                .iter()
                .filter(|(seq, id)| *seq >= from && cover && s.files.get(id).is_some_and(|f| f.granted))
                .map(|(_, id)| json!({"fileId": id, "removed": false, "file": {"name": s.files[id].meta["name"], "mimeType": s.files[id].meta["mimeType"]}}))
                .collect();
            send_json(stream, 200, &json!({"changes": list, "newStartPageToken": (s.changes.len() + 1).to_string()}));
        }
        ("GET", ["drive", "v3", "files", id]) => match granted(&s, id) {
            Some(f) => send_json(stream, 200, &file_json(&f)),
            None => google_error(stream, 404, &format!("File not found: {id}.")),
        },
        ("GET", ["drive", "v3", "files", id, "export"]) => match granted(&s, id) {
            Some(f) if req.query.get("mimeType").map(String::as_str) == Some(crate::DOCX_MIME) => send(stream, 200, crate::DOCX_MIME, "", &f.docx),
            Some(_) => google_error(stream, 400, "unsupported export type"),
            None => google_error(stream, 404, "File not found."),
        },
        ("GET", ["drive", "v3", "files"]) => {
            let q = req.query.get("q").cloned().unwrap_or_default();
            let parent = q.split('\'').nth(1).unwrap_or_default().to_string();
            let files: Vec<Value> = s
                .files
                .values()
                .filter(|f| f.granted && f.parent.as_deref() == Some(parent.as_str()) && f.meta["mimeType"] == crate::DOC_MIME)
                .map(file_json)
                .collect();
            send_json(stream, 200, &json!({"files": files}));
        }
        _ => google_error(stream, 404, "not found"),
    }
}

/// Indices of one request moved past `c` (collaborator edits since the
/// revision it was planned on). A delete may become two.
fn map_request(req: &Value, c: &[Xf]) -> Vec<Value> {
    let mut req = req.clone();
    let Some((kind, body)) = req.as_object_mut().and_then(|o| o.iter_mut().next()) else { return vec![req] };
    let kind = kind.clone();
    if kind == "insertText" {
        if let Some(i) = body.pointer("/location/index").and_then(Value::as_u64) {
            body["location"]["index"] = json!(map_point(i as usize, c, false));
        }
        return vec![req];
    }
    let (Some(s), Some(e)) = (body.pointer("/range/startIndex").and_then(Value::as_u64), body.pointer("/range/endIndex").and_then(Value::as_u64)) else { return vec![req] };
    let (s, e) = (s as usize, e as usize);
    if kind == "deleteContentRange" {
        let (moved, _) = transform_seq(&[Xf::Del { start: s, end: e }], c, false);
        return moved
            .into_iter()
            .filter_map(|x| match x {
                Xf::Del { start, end } if end > start => Some(json!({"deleteContentRange": {"range": {"startIndex": start, "endIndex": end}}})),
                _ => None,
            })
            .collect();
    }
    let (s2, e2) = (map_point(s, c, false), map_point(e, c, true));
    if e2 <= s2 {
        return Vec::new();
    }
    body["range"]["startIndex"] = json!(s2);
    body["range"]["endIndex"] = json!(e2);
    vec![req]
}

fn batch_update(stream: &mut TcpStream, s: &mut FakeState, id: &str, body: &str) {
    let Some(f) = s.files.get(id).filter(|f| f.granted).cloned() else {
        return google_error(stream, 404, "Requested entity was not found.");
    };
    let Ok(body) = serde_json::from_str::<Value>(body) else {
        return google_error(stream, 400, "Invalid JSON payload received.");
    };
    let wc = body.get("writeControl").cloned().unwrap_or_else(|| json!({}));
    let suggest = wc.get("writeMode").and_then(Value::as_str) == Some("SUGGEST");
    match f.role {
        Role::Reader => return google_error(stream, 403, "The caller does not have permission"),
        Role::Commenter if !suggest => return google_error(stream, 403, "The caller does not have permission"),
        _ => {}
    }
    let Some(model) = f.model.clone() else {
        return google_error(stream, 400, "This fake writes only one-tab Docs.");
    };
    if wc.get("targetRevisionId").is_some() && wc.get("requiredRevisionId").is_some() {
        return google_error(stream, 400, "Only one of targetRevisionId and requiredRevisionId may be set.");
    }
    let current = f.revision_id();
    let rev_of = |r: &str| r.rsplit('-').next().and_then(|n| n.parse::<u64>().ok());
    if let Some(r) = wc.get("requiredRevisionId").and_then(Value::as_str)
        && r != current
    {
        return google_error(stream, 400, "The required revision ID does not match the latest revision.");
    }
    let requests = body.get("requests").and_then(Value::as_array).cloned().unwrap_or_default();
    if requests.is_empty() {
        return google_error(stream, 400, "Must specify at least one request.");
    }
    let mode = if suggest { Mode::Suggest } else { Mode::Edit };
    s.counter += 1;
    let sugg_id = format!("suggest.{}", s.counter);
    // Collaborator edits since the target revision, if it's older.
    let target = wc.get("targetRevisionId").and_then(Value::as_str).map(|r| r.to_string());
    let mut actual = model.clone();
    let mut applied: Vec<Xf> = Vec::new();
    let result: Result<(), String> = (|| {
        match target.as_deref().and_then(rev_of) {
            Some(r) if r < f.rev => {
                let since: Vec<&(u64, Option<Vec<Xf>>)> = f.log.iter().filter(|(n, _)| *n > r).collect();
                if since.iter().any(|(_, x)| x.is_none()) {
                    return Err("The target revision is too old to merge with.".into());
                }
                let mut c: Vec<Xf> = since.into_iter().flat_map(|(_, x)| x.clone().unwrap()).collect();
                let mut ours = f.snapshots.iter().find(|(n, _)| *n == r).map(|(_, m)| m.clone()).ok_or("The target revision is too old.")?;
                for req in &requests {
                    for m in map_request(req, &c) {
                        applied.extend(actual.apply(&m, mode, &sugg_id)?);
                    }
                    let prims = ours.apply(req, mode, &sugg_id)?;
                    c = transform_seq(&c, &prims, true).0;
                }
            }
            Some(r) if r > f.rev => return Err("The target revision ID is invalid.".into()),
            None if target.is_some() => return Err("The target revision ID is invalid.".into()),
            _ => {
                for req in &requests {
                    applied.extend(actual.apply(req, mode, &sugg_id)?);
                }
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        return google_error(stream, 400, &format!("Invalid requests: {e}"));
    }
    s.writes.push((id.to_string(), body.clone()));
    let f = s.files.get_mut(id).unwrap();
    f.model = Some(actual);
    f.bump(Some(applied));
    let rev = f.revision_id();
    push_change(s, id);
    send_json(stream, 200, &json!({"documentId": id, "replies": requests.iter().map(|_| json!({})).collect::<Vec<_>>(), "writeControl": {"requiredRevisionId": rev}}));
}
