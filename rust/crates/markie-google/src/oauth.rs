//! Connecting: Google's desktop Picker flow with PKCE and a loopback redirect.
//!
//! 1. `PickFlow::start` binds `127.0.0.1` on a free port and makes a PKCE pair
//!    and a state value.
//! 2. `authorize_url` is the consent page with the Picker on it:
//!    `scope=drive.file` alone, `trigger_onepick=true`,
//!    `allow_folder_selection=true`, `prompt=consent`, `access_type=offline`.
//!    The app opens it in the system browser. No web view.
//! 3. Google redirects the browser to the loopback address with `code`,
//!    `state` and `picked_file_ids`. `wait` answers that one request.
//! 4. `exchange_code` trades the code and the PKCE verifier for tokens.
//!
//! Only `drive.file` is ever asked for, and this grant is separate from
//! Markie Cloud sign-in: the Picker flow refuses any other scope.
use crate::config::ClientConfig;
use crate::error::{GoogleError, Result};
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// How long Markie waits for the person to finish in the browser.
pub const PICK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the system random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// RFC 7636: a 43-character verifier and its S256 challenge.
pub struct Pkce {
    pub verifier: Zeroizing<String>,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Self {
        Self::from_verifier(random_token(32))
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = s256(&verifier);
        Self { verifier: Zeroizing::new(verifier), challenge }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

pub fn s256(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// What the browser brought back.
#[derive(Clone, PartialEq, Eq)]
pub struct Redirect {
    pub code: Zeroizing<String>,
    pub picked_file_ids: Vec<String>,
}

impl std::fmt::Debug for Redirect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Redirect").field("picked_file_ids", &self.picked_file_ids).finish_non_exhaustive()
    }
}

/// One connect-and-pick attempt.
pub struct PickFlow {
    listener: TcpListener,
    pub state: String,
    pub pkce: Pkce,
    redirect_uri: String,
}

impl PickFlow {
    pub fn start() -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, state: random_token(16), pkce: Pkce::new(), redirect_uri: format!("http://127.0.0.1:{port}/") })
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    /// The page the system browser opens: consent plus the Picker.
    pub fn authorize_url(&self, cfg: &ClientConfig, login_hint: Option<&str>) -> String {
        let mut url = url::Url::parse(&cfg.endpoints.auth).expect("a valid auth endpoint");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("client_id", &cfg.client_id)
                .append_pair("redirect_uri", &self.redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", crate::DRIVE_FILE_SCOPE)
                .append_pair("code_challenge", &self.pkce.challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &self.state)
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent")
                .append_pair("trigger_onepick", "true")
                .append_pair("allow_folder_selection", "true");
            if let Some(hint) = login_hint.filter(|h| !h.is_empty()) {
                q.append_pair("login_hint", hint);
            }
        }
        url.into()
    }

    /// Answer the browser's redirect. Returns when it arrives, the person
    /// cancels in Markie (`cancel`), or `timeout` passes. Other requests to the
    /// port (a favicon) get a 404 and are ignored.
    pub fn wait(&self, timeout: Duration, cancel: &AtomicBool) -> Result<Redirect> {
        let deadline = Instant::now() + timeout;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(GoogleError::Cancelled);
            }
            if Instant::now() > deadline {
                return Err(GoogleError::Timeout);
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(result) = self.answer(stream) {
                        return result;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(e.into()),
            }
        }
    }

    fn answer(&self, mut stream: TcpStream) -> Option<Result<Redirect>> {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let target = read_request_target(&mut stream)?;
        let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
        let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let get = |key: &str| pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        if get("code").is_none() && get("error").is_none() {
            respond(&mut stream, "404 Not Found", "");
            return None;
        }
        if get("state").as_deref() != Some(self.state.as_str()) {
            respond(&mut stream, "400 Bad Request", &page("This answer didn't come from the connection Markie started. Go back to Markie and try again."));
            return Some(Err(GoogleError::State));
        }
        if let Some(error) = get("error") {
            respond(&mut stream, "200 OK", &page("Markie didn't get access. You can close this tab."));
            return Some(Err(if error == "access_denied" { GoogleError::Cancelled } else { GoogleError::Http { status: 400, message: error } }));
        }
        let code = get("code").unwrap_or_default();
        let picked = parse_picked(pairs.iter().filter(|(k, _)| k == "picked_file_ids").map(|(_, v)| v.as_str()));
        respond(&mut stream, "200 OK", &page("Markie is importing your Google Docs. You can close this tab and go back to Markie."));
        Some(Ok(Redirect { code: Zeroizing::new(code), picked_file_ids: picked }))
    }
}

/// `picked_file_ids` may come comma-separated, repeated, or both. Anything
/// that is not a Drive ID is dropped.
pub fn parse_picked<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        for id in value.split([',', ' ']).map(str::trim).filter(|s| !s.is_empty()) {
            if valid_file_id(id) && !out.iter().any(|o| o == id) {
                out.push(id.to_string());
            }
        }
    }
    out
}

pub fn valid_file_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let line = text.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    (method == "GET" && target.starts_with('/')).then(|| target.to_string())
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

fn page(message: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>Markie</title><body style=\"font:15px -apple-system,sans-serif;margin:15vh auto;max-width:28em;padding:0 16px;color-scheme:light dark\"><p>{message}</p></body>"
    )
}

/// Google's token answer. `refresh_token` comes with the first consent.
#[derive(Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenResponse").field("expires_in", &self.expires_in).field("scope", &self.scope).finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
}

pub fn http_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("{}/{}", markie_core::paths::APP_NAME, markie_core::paths::APP_VERSION))
        .build()
        .expect("an HTTP client")
}

fn token_call(http: &reqwest::blocking::Client, cfg: &ClientConfig, form: &[(&str, &str)]) -> Result<TokenResponse> {
    let mut form: Vec<(&str, &str)> = form.to_vec();
    form.push(("client_id", &cfg.client_id));
    if let Some(secret) = &cfg.client_secret {
        form.push(("client_secret", secret));
    }
    let resp = http.post(&cfg.endpoints.token).form(&form).send()?;
    let status = resp.status();
    let body = resp.text()?;
    if status.is_success() {
        return serde_json::from_str(&body).map_err(|e| GoogleError::Parse(e.to_string()));
    }
    let error = serde_json::from_str::<TokenError>(&body).map(|e| e.error).unwrap_or_default();
    Err(match error.as_str() {
        "invalid_grant" => GoogleError::Reconnect,
        _ => GoogleError::Http { status: status.as_u16(), message: error },
    })
}

pub fn exchange_code(http: &reqwest::blocking::Client, cfg: &ClientConfig, flow: &PickFlow, code: &str) -> Result<TokenResponse> {
    token_call(
        http,
        cfg,
        &[("grant_type", "authorization_code"), ("code", code), ("code_verifier", &flow.pkce.verifier), ("redirect_uri", flow.redirect_uri())],
    )
}

pub fn refresh_access(http: &reqwest::blocking::Client, cfg: &ClientConfig, refresh_token: &str) -> Result<TokenResponse> {
    token_call(http, cfg, &[("grant_type", "refresh_token"), ("refresh_token", refresh_token)])
}

/// Best effort on disconnect: Google forgets the grant too.
pub fn revoke(http: &reqwest::blocking::Client, cfg: &ClientConfig, token: &str) -> Result<()> {
    let resp = http.post(&cfg.endpoints.revoke).form(&[("token", token)]).send()?;
    if resp.status().is_success() || resp.status().as_u16() == 400 { Ok(()) } else { Err(GoogleError::Http { status: resp.status().as_u16(), message: String::new() }) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pkce_challenge_is_s256_of_the_verifier() {
        // RFC 7636 appendix B.
        let p = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let fresh = Pkce::new();
        assert_eq!(fresh.verifier.len(), 43);
    }

    #[test]
    fn the_authorize_url_asks_for_drive_file_and_the_picker_only() {
        let flow = PickFlow::start().unwrap();
        let cfg = ClientConfig::fake("http://127.0.0.1:9");
        let url = url::Url::parse(&flow.authorize_url(&cfg, None)).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["scope"], crate::DRIVE_FILE_SCOPE);
        assert_eq!(q["trigger_onepick"], "true");
        assert_eq!(q["allow_folder_selection"], "true");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], flow.pkce.challenge);
        assert_eq!(q["state"], flow.state);
        assert!(q["redirect_uri"].starts_with("http://127.0.0.1:"));
        assert!(!q.contains_key("client_secret"));
    }

    #[test]
    fn picked_ids_are_split_deduplicated_and_checked() {
        let ids = parse_picked(["a1,b2", "b2", "c_3 d-4", "../etc", ""].into_iter());
        assert_eq!(ids, ["a1", "b2", "c_3", "d-4"]);
    }

    #[test]
    fn a_redirect_with_the_wrong_state_is_refused_and_a_favicon_is_ignored() {
        let flow = PickFlow::start().unwrap();
        let uri = flow.redirect_uri().to_string();
        let t = std::thread::spawn(move || {
            let http = http_client();
            let _ = http.get(format!("{uri}favicon.ico")).send();
            let _ = http.get(format!("{uri}?code=abc&state=wrong")).send();
        });
        let got = flow.wait(Duration::from_secs(10), &AtomicBool::new(false));
        t.join().unwrap();
        assert_eq!(got.unwrap_err(), GoogleError::State);
    }

    #[test]
    fn saying_no_in_the_browser_is_a_cancel_and_markie_can_cancel_too() {
        let flow = PickFlow::start().unwrap();
        let uri = format!("{}?error=access_denied&state={}", flow.redirect_uri(), flow.state);
        let t = std::thread::spawn(move || {
            let _ = http_client().get(uri).send();
        });
        assert_eq!(flow.wait(Duration::from_secs(10), &AtomicBool::new(false)).unwrap_err(), GoogleError::Cancelled);
        t.join().unwrap();
        let flow = PickFlow::start().unwrap();
        assert_eq!(flow.wait(Duration::from_secs(10), &AtomicBool::new(true)).unwrap_err(), GoogleError::Cancelled);
        assert_eq!(flow.wait(Duration::from_millis(1), &AtomicBool::new(false)).unwrap_err(), GoogleError::Timeout);
    }
}
