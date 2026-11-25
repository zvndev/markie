//! A fake Google on `127.0.0.1`, for tests and scenes. Never the real one.
//!
//! It speaks just enough of each endpoint import uses:
//! - `GET /o/oauth2/v2/auth`: checks the Picker parameters and redirects to the
//!   loopback address with a code, the state and `picked_file_ids`, as
//!   Google's desktop Picker does after the person picks;
//! - `POST /token`: the code exchange (PKCE checked) and refresh;
//! - `POST /revoke`;
//! - `GET /v1/documents/{id}`, `GET /drive/v3/files/{id}`,
//!   `GET /drive/v3/files/{id}/export`, `GET /drive/v3/files?q=...`,
//!   `GET /drive/v3/about`, all behind a bearer token.
//!
//! Every Doc in it is made up.
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
pub struct FakeFile {
    pub meta: Value,
    pub doc: Option<Value>,
    pub docx: Vec<u8>,
    /// Picked: `drive.file` covers it.
    pub granted: bool,
    pub parent: Option<String>,
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
    counter: u64,
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

impl FakeGoogle {
    pub fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("a local port");
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(FakeState::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (s, st) = (state.clone(), stop.clone());
        std::thread::spawn(move || {
            while !st.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let s = s.clone();
                        std::thread::spawn(move || serve(stream, &s));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        Self { base, state, stop }
    }

    pub fn config(&self) -> crate::config::ClientConfig {
        crate::config::ClientConfig::fake(&self.base)
    }

    /// Add a made-up Doc. `version` is Drive's version string.
    pub fn add_doc(&self, id: &str, title: &str, version: u64, doc: Value) {
        let meta = json!({"id": id, "name": title, "mimeType": crate::DOC_MIME, "version": version.to_string(), "modifiedTime": "2026-11-25T09:00:00.000Z", "trashed": false});
        let mut doc = doc;
        doc["documentId"] = json!(id);
        doc["title"] = json!(title);
        doc["revisionId"] = json!(format!("rev-{id}-{version}"));
        let docx = format!("PK fake docx for {title} v{version}").into_bytes();
        self.state.lock().unwrap().files.insert(id.into(), FakeFile { meta, doc: Some(doc), docx, granted: false, parent: None });
    }

    /// Change a Doc in "Google": a new body and a higher version.
    pub fn edit_doc(&self, id: &str, version: u64, doc: Value) {
        let title = self.state.lock().unwrap().files[id].meta["name"].as_str().unwrap().to_string();
        let (granted, parent) = {
            let s = self.state.lock().unwrap();
            (s.files[id].granted, s.files[id].parent.clone())
        };
        self.add_doc(id, &title, version, doc);
        let mut s = self.state.lock().unwrap();
        let f = s.files.get_mut(id).unwrap();
        f.granted = granted;
        f.parent = parent;
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
        self.state.lock().unwrap().files.get_mut(id).unwrap().meta["trashed"] = json!(true);
    }

    pub fn log(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
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
    let mut chunk = [0u8; 4096];
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

fn api(stream: &mut TcpStream, req: &Request, state: &Mutex<FakeState>) {
    let bearer = req.headers.get("authorization").and_then(|a| a.strip_prefix("Bearer ")).unwrap_or_default().to_string();
    let s = state.lock().unwrap();
    if !s.access_tokens.contains(&bearer) {
        drop(s);
        return google_error(stream, 401, "Request had invalid authentication credentials.");
    }
    let parts: Vec<&str> = req.path.trim_start_matches('/').split('/').collect();
    let granted = |id: &str| s.files.get(id).filter(|f| f.granted).cloned();
    match parts.as_slice() {
        ["v1", "documents", id] => match granted(id).and_then(|f| f.doc) {
            Some(doc) if req.query.get("includeTabsContent").map(String::as_str) == Some("true") => send_json(stream, 200, &doc),
            Some(_) => google_error(stream, 400, "this fake only answers includeTabsContent=true"),
            None => google_error(stream, 404, "Requested entity was not found."),
        },
        ["drive", "v3", "about"] => send_json(stream, 200, &json!({"user": {"displayName": "Sample Person", "emailAddress": "sample.person@example.com"}})),
        ["drive", "v3", "files", id] => match granted(id) {
            Some(f) => send_json(stream, 200, &f.meta),
            None => google_error(stream, 404, &format!("File not found: {id}.")),
        },
        ["drive", "v3", "files", id, "export"] => match granted(id) {
            Some(f) if req.query.get("mimeType").map(String::as_str) == Some(crate::DOCX_MIME) => send(stream, 200, crate::DOCX_MIME, "", &f.docx),
            Some(_) => google_error(stream, 400, "unsupported export type"),
            None => google_error(stream, 404, "File not found."),
        },
        ["drive", "v3", "files"] => {
            let q = req.query.get("q").cloned().unwrap_or_default();
            let parent = q.split('\'').nth(1).unwrap_or_default().to_string();
            let files: Vec<Value> = s
                .files
                .values()
                .filter(|f| f.granted && f.parent.as_deref() == Some(parent.as_str()) && f.meta["mimeType"] == crate::DOC_MIME)
                .map(|f| f.meta.clone())
                .collect();
            send_json(stream, 200, &json!({"files": files}));
        }
        _ => google_error(stream, 404, "not found"),
    }
}
