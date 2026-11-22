//! The one place requests leave this crate. No redirects (a redirect is how an
//! approved address turns into one the user did not approve), a timeout, and a
//! cap on how much of an answer is read. Port of electron/server-request.js.
use crate::error::{CloudError, Result};
use serde_json::Value;
use std::time::Duration;
use url::Url;

pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Document text can be larger than sign-in and sharing answers.
pub const MAX_DOC_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(15);
pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    fn reqwest(self) -> reqwest::Method {
        match self {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        }
    }
}

/// What a server answered. `status` 0 never happens here: no answer is `Err(Offline)`.
#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    pub data: Option<Value>,
    pub bytes: Vec<u8>,
    pub set_auth_token: Option<String>,
    pub etag: Option<String>,
    pub content_type: Option<String>,
}

impl Answer {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `{error, message}` from a JSON failure body, for the user.
    pub fn message(&self) -> Option<String> {
        let d = self.data.as_ref()?;
        d.get("message").or_else(|| d.get("error")).and_then(Value::as_str).map(str::to_string)
    }

    /// Err for a non-2xx, so typed calls can use `?`.
    pub fn into_ok(self) -> Result<Answer> {
        if self.ok() { Ok(self) } else { Err(CloudError::Status { status: self.status, message: self.message() }) }
    }

    /// The JSON body of a 2xx, or Unreadable.
    pub fn json(self) -> Result<Value> {
        let a = self.into_ok()?;
        a.data.ok_or(CloudError::Unreadable)
    }

    pub fn parse<T: serde::de::DeserializeOwned>(self) -> Result<T> {
        serde_json::from_value(self.json()?).map_err(|_| CloudError::Unreadable)
    }
}

/// The path and query to send, or None. The raw string is checked, then the
/// path the URL parser makes of it against the origin. A percent-encoded dot,
/// slash or backslash is refused outright.
pub fn checked_path(origin: &str, p: &str) -> Option<String> {
    let (route, query) = p.split_once('?').unwrap_or((p, ""));
    // A media ref is opaque query data, not a URL or a route. Embedded
    // directories and percent-decoded spaces must round-trip to the server.
    let asset_ref = route.strip_prefix("/api/docs/")
        .and_then(|tail| tail.split_once('/'))
        .is_some_and(|(id, ending)| !id.is_empty() && ending == "assets/file")
        && query.strip_prefix("ref=").is_some_and(|r| !r.is_empty() && !r.contains(['&', '=', '?']));
    let checked = if asset_ref { route } else { p };
    if p.len() > if asset_ref { 8192 } else { 4096 } {
        return None;
    }
    let allowed_raw = |c: char| c.is_ascii_alphanumeric() || "/_-.~%?=&".contains(c);
    let rest = p.strip_prefix("/api/").or_else(|| p.strip_prefix("/auth/"))?;
    if !rest.chars().all(allowed_raw) {
        return None;
    }
    let lower = checked.to_ascii_lowercase();
    if checked.contains("..") || lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") {
        return None;
    }
    let base = Url::parse(origin).ok()?;
    let u = base.join(p).ok()?;
    if u.origin() != base.origin() || u.fragment().is_some() || !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let path = u.path();
    let prest = path.strip_prefix("/api/").or_else(|| path.strip_prefix("/auth/"))?;
    if !prest.chars().all(|c| c.is_ascii_alphanumeric() || "/_-.~%".contains(c)) {
        return None;
    }
    if path.split('/').any(|s| s == "." || s == "..") {
        return None;
    }
    Some(match u.query() {
        Some(q) => format!("{path}?{q}"),
        None => path.to_string(),
    })
}

/// A request body.
pub enum Body {
    None,
    Json(Value),
    Raw { bytes: Vec<u8>, mime: String },
}

/// One request, already checked against the trusted list by the caller.
pub struct Request<'a> {
    pub origin: &'a str,
    pub method: Method,
    pub path: &'a str,
    pub body: Body,
    pub bearer: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
    pub max_bytes: usize,
    pub timeout: Duration,
}

impl<'a> Request<'a> {
    pub fn new(origin: &'a str, method: Method, path: &'a str) -> Self {
        Self { origin, method, path, body: Body::None, bearer: None, if_none_match: None, max_bytes: MAX_RESPONSE_BYTES, timeout: TIMEOUT }
    }
}

/// A reqwest client with redirects off.
#[derive(Clone)]
pub struct Transport {
    client: reqwest::Client,
}

impl Default for Transport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("MarkieRS/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self { client }
    }

    pub async fn send(&self, req: Request<'_>) -> Result<Answer> {
        let path = checked_path(req.origin, req.path).ok_or(CloudError::Refused)?;
        let url = format!("{}{}", req.origin, path);
        let mut rb = self.client.request(req.method.reqwest(), &url).timeout(req.timeout);
        if let Some(t) = req.bearer {
            rb = rb.bearer_auth(t);
        }
        if let Some(tag) = req.if_none_match {
            rb = rb.header("If-None-Match", tag);
        }
        rb = match req.body {
            Body::None => rb.header("Content-Type", "application/json"),
            Body::Json(v) => rb.header("Content-Type", "application/json").body(serde_json::to_vec(&v).unwrap_or_default()),
            Body::Raw { bytes, mime } => rb.header("Content-Type", mime).body(bytes),
        };
        let mut res = rb.send().await.map_err(|_| CloudError::Offline)?;
        let status = res.status().as_u16();
        // A 3xx is never followed. It reads as the status it is.
        let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
        let set_auth_token = header("set-auth-token").filter(|t| !t.is_empty() && t.len() <= 4096);
        let etag = header("etag");
        let content_type = header("content-type");
        if let Some(len) = res.content_length()
            && len as usize > req.max_bytes
        {
            return Err(CloudError::TooLarge);
        }
        let mut bytes = Vec::new();
        loop {
            match res.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len() + chunk.len() > req.max_bytes {
                        return Err(CloudError::TooLarge);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => return Err(CloudError::Offline),
            }
        }
        let data = serde_json::from_slice::<Value>(&bytes).ok();
        Ok(Answer { status, data, bytes, set_auth_token, etag, content_type })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SELF: &str = "https://docs.example.com";

    #[test]
    fn keeps_api_paths_and_queries() {
        assert_eq!(checked_path(SELF, "/api/docs/abc/shares?x=1&y=2").as_deref(), Some("/api/docs/abc/shares?x=1&y=2"));
        assert_eq!(checked_path(SELF, "/auth/sign-in/email").as_deref(), Some("/auth/sign-in/email"));
        assert_eq!(checked_path(SELF, "/api/./me").as_deref(), Some("/api/me"));
        let asset = "/api/docs/item/assets/file?ref=shots%2Fa%20b.png";
        assert_eq!(checked_path(SELF, asset).as_deref(), Some(asset));
        assert_eq!(checked_path(SELF, "/api/docs/item/assets/file?ref=shots%2Fa.png&next=%2Ffoo"), None);
    }

    #[test]
    fn refuses_encoded_dots_and_slashes() {
        for p in [
            "/api/%2e%2e/admin",
            "/api/%2E%2E/admin",
            "/api/.%2e/admin",
            "/api/%2fadmin",
            "/api/%2Fadmin",
            "/api/%5cadmin",
            "/api/%5Cadmin",
            "/api/docs?next=%2e%2e",
        ] {
            assert_eq!(checked_path(SELF, p), None, "{p}");
        }
    }

    #[test]
    fn refuses_paths_leaving_the_api() {
        for p in ["/api/../admin", "/api/./../admin", "/admin", "//evil.example/api/me", "/api\\..\\admin", "/api/me#x", "api/me", "", "https://evil.example/api/me"] {
            assert_eq!(checked_path(SELF, p), None, "{p}");
        }
    }
}
