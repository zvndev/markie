//! A client bound to one server origin. The token it sends is the one stored
//! for that origin and no other, and only while the origin is trusted. This is
//! the Rust shape of electron/server-request.js plus the per-origin `serverApi`
//! in src/lib/server-sessions.ts.
use crate::error::{CloudError, Result};
use crate::http::{Answer, Body, Method, Request, Transport};
use crate::origin::{Trust, canonical_cloud_origin};
use crate::tokens::{self, Session, TokenStore};
use serde_json::Value;
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// A shared view of the trusted list. The server registry writes it; every
/// client reads it at the moment of each request, so removing a server stops
/// its token at once.
pub type TrustHandle = Arc<RwLock<Trust>>;

#[derive(Clone)]
pub struct CloudClient {
    origin: String,
    trust: TrustHandle,
    tokens: Arc<dyn TokenStore>,
    transport: Transport,
    expected_user: Option<String>,
}

/// Options for one call.
pub struct Call<'a> {
    pub method: Method,
    pub path: &'a str,
    pub body: Body,
    /// Send this origin's token. Sign-in calls go without one.
    pub auth: bool,
    pub max_bytes: usize,
    pub timeout: Duration,
    pub if_none_match: Option<&'a str>,
}

impl<'a> Call<'a> {
    pub fn new(method: Method, path: &'a str) -> Self {
        Self { method, path, body: Body::None, auth: true, max_bytes: crate::http::MAX_RESPONSE_BYTES, timeout: crate::http::TIMEOUT, if_none_match: None }
    }
    pub fn json(mut self, v: Value) -> Self {
        self.body = Body::Json(v);
        self
    }
    pub fn anonymous(mut self) -> Self {
        self.auth = false;
        self
    }
    pub fn max_bytes(mut self, n: usize) -> Self {
        self.max_bytes = n;
        self
    }
}

impl CloudClient {
    /// A client for `origin`. Refused when the origin is not trusted.
    pub fn new(origin: &str, trust: TrustHandle, tokens: Arc<dyn TokenStore>, transport: Transport) -> Result<Self> {
        let origin = canonical_cloud_origin(origin.trim_end_matches('/'));
        if !trust.read().unwrap().is_allowed_server_origin(&origin) {
            return Err(CloudError::NotTrusted);
        }
        Ok(Self { origin, trust, tokens, transport, expected_user: None })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn tokens(&self) -> &Arc<dyn TokenStore> {
        &self.tokens
    }

    pub fn session(&self) -> Option<Session> {
        tokens::session_for(self.tokens.as_ref(), &self.origin).filter(|session| {
            self.expected_user.as_ref().is_none_or(|user| session.user_id.as_ref() == Some(user))
        })
    }

    /// Bind a multi-request operation to the confirmed account it started in.
    pub fn for_user(mut self, user: &str) -> Self {
        self.expected_user = Some(user.into());
        self
    }

    pub fn token(&self) -> Option<String> {
        self.session().map(|s| s.token)
    }

    pub fn set_token(&self, token: Option<&str>) -> Result<()> {
        tokens::set_token(self.tokens.as_ref(), &self.origin, token)
    }

    fn trusted(&self) -> bool {
        self.trust.read().unwrap().is_allowed_server_origin(&self.origin)
    }

    /// Make one call. With `auth`, the stored token for this origin goes along;
    /// a rotated token in `set-auth-token` replaces it only if nothing else
    /// changed the session meanwhile.
    pub async fn call(&self, call: Call<'_>) -> Result<Answer> {
        if !self.trusted() {
            return Err(CloudError::NotTrusted);
        }
        let session = if call.auth { Some(self.session().ok_or(CloudError::NotSignedIn)?) } else { None };
        let mut req = Request::new(&self.origin, call.method, call.path);
        req.body = call.body;
        req.bearer = session.as_ref().map(|s| s.token.as_str());
        req.max_bytes = call.max_bytes;
        req.timeout = call.timeout;
        req.if_none_match = call.if_none_match;
        let answer = self.transport.send(req).await?;
        if let Some(sent) = session {
            if !self.trusted() || self.session().as_ref() != Some(&sent) {
                return Err(CloudError::StaleSession);
            }
            if answer.ok()
                && let Some(fresh) = answer.set_auth_token.as_deref()
                && fresh != sent.token
            {
                self.set_token(Some(fresh))?;
            }
        }
        Ok(answer)
    }

    pub async fn get(&self, path: &str) -> Result<Answer> {
        self.call(Call::new(Method::Get, path)).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Answer> {
        self.call(Call::new(Method::Post, path).json(body)).await
    }

    pub async fn put(&self, path: &str, body: Value) -> Result<Answer> {
        self.call(Call::new(Method::Put, path).json(body)).await
    }

    pub async fn delete(&self, path: &str) -> Result<Answer> {
        self.call(Call::new(Method::Delete, path)).await
    }
}

/// Percent-encode one path segment, as encodeURIComponent does.
pub fn seg(s: &str) -> String {
    use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
    const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
    utf8_percent_encode(s, COMPONENT).to_string()
}
