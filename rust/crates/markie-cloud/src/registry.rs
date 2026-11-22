//! The servers this app talks to with a session: Markie Cloud, always, and any
//! server the user added on purpose. A port of electron/servers.js.
//!
//! Nothing may put an origin on this list except an add the user confirmed,
//! from a check this store made itself. A link or a document cannot.
use crate::client::TrustHandle;
use crate::error::{CloudError, Result};
use crate::http::{Answer, Method, Request, Transport};
use crate::origin::{CLOUD_ALIASES, DEFAULT_SERVER, Trust, canonical_cloud_origin, is_cloud_origin, parse_server_origin};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

pub const DEFAULT_NAME: &str = "Markie Cloud";
pub const SUPPORTED_API_VERSION: i64 = 1;
const MAX_NAME: usize = 80;
const MAX_INFO_BYTES: usize = 64 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// A check the user does not act on goes stale.
pub const PROBE_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SignupMode {
    #[default]
    Open,
    Invite,
    Closed,
}

/// The sign-in methods a server offers, reduced to what this app understands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignIn {
    pub email: bool,
    pub google: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub apple: bool,
    pub signup: SignupMode,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl SignIn {
    /// What a default server that predates /api/server-info is assumed to offer.
    pub fn cloud_default() -> Self {
        Self { email: true, google: true, apple: false, signup: SignupMode::Open }
    }

    pub fn from_json(v: Option<&Value>) -> Self {
        let get = |k: &str| v.and_then(|s| s.get(k));
        let signup = match get("signup").and_then(Value::as_str) {
            Some("invite") => SignupMode::Invite,
            Some("closed") => SignupMode::Closed,
            _ => SignupMode::Open,
        };
        Self {
            email: get("email").and_then(Value::as_bool) != Some(false),
            google: get("google").and_then(Value::as_bool) == Some(true),
            apple: get("apple").and_then(Value::as_bool) == Some(true),
            signup,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    pub name: String,
    pub version: Option<String>,
    pub sign_in: SignIn,
}

/// A server on the list, as shown in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Server {
    pub origin: String,
    pub name: String,
    #[serde(rename = "signIn")]
    pub sign_in: SignIn,
    pub version: Option<String>,
    #[serde(rename = "addedAt")]
    pub added_at: Option<String>,
    #[serde(skip)]
    pub is_default: bool,
}

const CONFUSABLE: &[(char, char)] = &[
    ('0', 'o'), ('1', 'i'), ('l', 'i'), ('|', 'i'), ('!', 'i'), ('3', 'e'), ('4', 'a'), ('@', 'a'), ('5', 's'), ('$', 's'), ('7', 't'),
    // Cyrillic
    ('а', 'a'), ('е', 'e'), ('і', 'i'), ('ї', 'i'), ('ӏ', 'i'), ('к', 'k'), ('м', 'm'), ('о', 'o'), ('р', 'p'), ('с', 'c'), ('у', 'y'), ('х', 'x'), ('ԁ', 'd'),
    // Greek
    ('α', 'a'), ('ε', 'e'), ('ι', 'i'), ('κ', 'k'), ('μ', 'm'), ('ο', 'o'), ('ρ', 'p'), ('ν', 'v'), ('τ', 't'),
    // dotless i
    ('ı', 'i'),
];

/// A name reduced to the Latin letters it reads as. Only for comparing.
fn name_skeleton(value: &str) -> String {
    let folded: String = value
        .nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase();
    let mut out = String::new();
    for ch in folded.chars() {
        let mapped = CONFUSABLE.iter().find(|(k, _)| *k == ch).map(|(_, v)| *v).unwrap_or(ch);
        if mapped.is_ascii_lowercase() {
            out.push(mapped);
        }
    }
    out.replace("rn", "m")
}

/// Whether a server's name reads as Markie Cloud's.
pub fn is_reserved_name(value: &str) -> bool {
    let core = name_skeleton("markie");
    let sk = name_skeleton(value);
    if !sk.contains(&core) {
        return false;
    }
    if sk.contains(&name_skeleton("markie cloud")) || sk.contains(&name_skeleton("cloud markie")) {
        return true;
    }
    let mut fillers: Vec<String> = ["the", "official", "cloud", "app", "server", "servers", "docs", "desktop", "sync", "team", "service", "hq"]
        .iter()
        .map(|w| name_skeleton(w))
        .collect();
    fillers.sort_by_key(|w| std::cmp::Reverse(w.len()));
    let mut rest = sk.replacen(&core, "", 1);
    let mut changed = true;
    while changed && !rest.is_empty() {
        changed = false;
        for w in &fillers {
            if rest.contains(w.as_str()) {
                rest = rest.replacen(w.as_str(), "", 1);
                changed = true;
            }
        }
    }
    rest.is_empty()
}

fn clean_name(value: Option<&str>, fallback: &str) -> String {
    let Some(value) = value else { return fallback.to_string() };
    let bad = |c: char| (c as u32) <= 0x1f || c == '\u{7f}' || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
    let name: String = value.chars().filter(|c| !bad(*c)).collect();
    let name = name.trim();
    if name.is_empty() {
        return fallback.to_string();
    }
    if name.chars().count() > MAX_NAME {
        let cut: String = name.chars().take(MAX_NAME - 1).collect();
        format!("{cut}…")
    } else {
        name.to_string()
    }
}

/// The name an added server is shown under. One that passes for Markie Cloud
/// is replaced by its host, so it cannot collect a password meant for Cloud.
pub fn server_name(value: Option<&str>, host: &str) -> String {
    let name = clean_name(value, host);
    if is_reserved_name(&name) { host.to_string() } else { name }
}

fn host_of(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(|h| match u.port() {
            Some(p) => format!("{h}:{p}"),
            None => h.to_string(),
        }))
        .unwrap_or_else(|| origin.to_string())
}

/// Check a /api/server-info body. The server's own `origin` must match the
/// address asked, so a proxy cannot get one address added under another's name.
pub fn parse_server_info(body: &Value, origin: &str) -> std::result::Result<ServerInfo, String> {
    let not_markie = || "That address isn't a Markie server.".to_string();
    if !body.is_object() || body.get("product").and_then(Value::as_str) != Some("markie-server") {
        return Err(not_markie());
    }
    if body.get("apiVersion").and_then(Value::as_i64) != Some(SUPPORTED_API_VERSION) || !body["apiVersion"].is_i64() {
        return Err("That server runs a version of Markie this app doesn't support.".into());
    }
    if let Some(reported_raw) = body.get("origin").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let reported = crate::origin::origin_of(reported_raw);
        let same = reported.as_deref() == Some(origin);
        let both_cloud = reported.as_deref().is_some_and(is_cloud_origin) && is_cloud_origin(origin);
        if !same && !both_cloud {
            let shown: String = reported_raw.chars().take(200).collect();
            return Err(format!("That server says its address is {shown}. Use that address instead."));
        }
    }
    let host = host_of(origin);
    Ok(ServerInfo {
        name: server_name(body.get("name").and_then(Value::as_str), &host),
        version: body.get("version").and_then(Value::as_str).map(|v| v.chars().take(40).collect()),
        sign_in: SignIn::from_json(body.get("signIn").filter(|v| v.is_object())),
    })
}

/// How the probe reaches a server. The real one is HTTP; tests hand in answers.
pub trait InfoSource {
    fn server_info(&self, origin: &str) -> impl std::future::Future<Output = Result<Answer>> + Send;
}

impl InfoSource for Transport {
    async fn server_info(&self, origin: &str) -> Result<Answer> {
        let mut req = Request::new(origin, Method::Get, "/api/server-info");
        req.max_bytes = MAX_INFO_BYTES;
        req.timeout = PROBE_TIMEOUT;
        self.send(req).await
    }
}

/// Ask a server who it is: no credentials, no redirects, a size cap. The
/// default server may not have the route yet, so a 404 from it reads as the defaults.
pub async fn probe_server_info<S: InfoSource>(source: &S, origin: &str) -> std::result::Result<ServerInfo, String> {
    let is_default = is_cloud_origin(origin);
    let answer = match source.server_info(origin).await {
        Ok(a) => a,
        Err(CloudError::TooLarge) => return Err("That address isn't a Markie server.".into()),
        Err(_) => return Err("Couldn't reach that server.".into()),
    };
    if answer.status != 200 {
        if is_default && answer.status == 404 {
            return Ok(ServerInfo { name: DEFAULT_NAME.into(), version: None, sign_in: SignIn::cloud_default() });
        }
        return Err("That address isn't a Markie server.".into());
    }
    let Some(body) = answer.data else { return Err("That address isn't a Markie server.".into()) };
    let mut info = parse_server_info(&body, origin)?;
    if is_default {
        info.name = DEFAULT_NAME.into();
    }
    Ok(info)
}

/// The answer to step one of adding a server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub probe_id: String,
    pub origin: String,
    pub host: String,
    pub info: ServerInfo,
    pub already_added: bool,
}

struct Pending {
    origin: String,
    info: ServerInfo,
    at: u64,
}

#[derive(Serialize, Deserialize)]
struct FileBody {
    version: u32,
    servers: Vec<Value>,
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

fn system_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("csprng");
    hex::encode(b)
}

/// The trusted list, persisted as JSON. Markie Cloud is always first and is
/// never written to or removed from the file.
pub struct ServerStore {
    file: Option<PathBuf>,
    allow_dev: bool,
    added: Vec<Server>,
    /// Servers on this computer trusted for this run only, never written to
    /// the file: the test server `MARKIE_RS_CLOUD_SERVER` names.
    pinned: Vec<Server>,
    default_sign_in: SignIn,
    default_version: Option<String>,
    default_checked_at: Option<u64>,
    default_known: bool,
    probes: HashMap<String, Pending>,
    now: Clock,
    trust: TrustHandle,
}

impl ServerStore {
    pub fn open(file: Option<PathBuf>, allow_dev: bool) -> Self {
        Self::with_clock(file, allow_dev, Arc::new(system_now))
    }

    pub fn with_clock(file: Option<PathBuf>, allow_dev: bool, now: Clock) -> Self {
        let mut s = Self {
            file,
            allow_dev,
            added: Vec::new(),
            pinned: Vec::new(),
            default_sign_in: SignIn::cloud_default(),
            default_version: None,
            default_checked_at: None,
            default_known: false,
            probes: HashMap::new(),
            now,
            trust: Arc::new(RwLock::new(Trust::new([], allow_dev))),
        };
        s.added = s.load();
        s.publish();
        s
    }

    /// The handle every CloudClient reads trust from.
    pub fn trust_handle(&self) -> TrustHandle {
        self.trust.clone()
    }

    fn publish(&self) {
        *self.trust.write().unwrap() =
            Trust::new(self.added.iter().chain(&self.pinned).map(|s| s.origin.clone()), self.allow_dev);
    }

    fn load(&self) -> Vec<Server> {
        let Some(file) = &self.file else { return Vec::new() };
        let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
        let list = parsed.get("servers").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut seen: Vec<String> = std::iter::once(DEFAULT_SERVER).chain(CLOUD_ALIASES.iter().copied()).map(str::to_string).collect();
        let mut out = Vec::new();
        for s in list {
            let Some(origin) = s.get("origin").and_then(Value::as_str) else { continue };
            // A stored entry has to pass the same check a typed one does.
            let Ok(check) = parse_server_origin(origin, self.allow_dev) else { continue };
            if check.origin != origin || seen.contains(&check.origin) {
                continue;
            }
            seen.push(check.origin.clone());
            out.push(Server {
                name: server_name(s.get("name").and_then(Value::as_str), &check.host),
                origin: check.origin,
                sign_in: SignIn::from_json(s.get("signIn")),
                version: s.get("version").and_then(Value::as_str).map(str::to_string),
                added_at: s.get("addedAt").and_then(Value::as_str).map(str::to_string),
                is_default: false,
            });
        }
        out
    }

    fn save(&self) -> std::io::Result<()> {
        let Some(file) = &self.file else { return Ok(()) };
        let body = FileBody { version: 1, servers: self.added.iter().map(|s| serde_json::to_value(s).unwrap()).collect() };
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&tmp, serde_json::to_vec_pretty(&body).unwrap())?;
        std::fs::rename(tmp, file)
    }

    pub fn list(&self) -> Vec<Server> {
        let mut out = vec![Server {
            origin: DEFAULT_SERVER.into(),
            name: DEFAULT_NAME.into(),
            sign_in: self.default_sign_in.clone(),
            version: self.default_version.clone(),
            added_at: None,
            is_default: true,
        }];
        out.extend(self.added.iter().cloned());
        out.extend(self.pinned.iter().cloned());
        out
    }

    /// Trust a server on this computer for this run, without asking it who it
    /// is and without writing it to the list. Only a store opened for
    /// development takes one, and only a loopback address.
    pub fn pin_local(&mut self, origin: &str) -> std::result::Result<String, String> {
        if !self.allow_dev {
            return Err("Markie can't use a server on this computer.".into());
        }
        let typed = parse_server_origin(origin, true)?;
        let local = url::Url::parse(&typed.origin)
            .ok()
            .and_then(|u| u.host().map(|h| crate::origin::is_loopback_host(&h)))
            .unwrap_or(false);
        if !local {
            return Err("Only a server on this computer can be pinned.".into());
        }
        if !self.list().iter().any(|s| s.origin == typed.origin) {
            self.pinned.push(Server {
                name: server_name(None, &typed.host),
                origin: typed.origin.clone(),
                sign_in: SignIn::cloud_default(),
                version: None,
                added_at: None,
                is_default: false,
            });
            self.publish();
        }
        Ok(typed.origin)
    }

    pub fn origins(&self) -> Vec<String> {
        self.list().into_iter().map(|s| s.origin).collect()
    }

    pub fn is_trusted(&self, origin: &str) -> bool {
        self.origins().contains(&canonical_cloud_origin(origin))
    }

    pub fn get(&self, origin: &str) -> Option<Server> {
        let o = canonical_cloud_origin(origin);
        self.list().into_iter().find(|s| s.origin == o)
    }

    fn prune(&mut self) {
        let cutoff = (self.now)().saturating_sub(PROBE_TTL_MS);
        self.probes.retain(|_, p| p.at >= cutoff);
    }

    /// Step one of adding: check the address and ask the server who it is.
    pub async fn probe<S: InfoSource>(&mut self, source: &S, input: &str) -> std::result::Result<Probe, String> {
        let typed = parse_server_origin(input, self.allow_dev)?;
        let (origin, host) = if is_cloud_origin(&typed.origin) {
            (DEFAULT_SERVER.to_string(), host_of(DEFAULT_SERVER))
        } else {
            (typed.origin, typed.host)
        };
        let info = probe_server_info(source, &origin).await?;
        self.prune();
        let probe_id = random_id();
        self.probes.insert(probe_id.clone(), Pending { origin: origin.clone(), info: info.clone(), at: (self.now)() });
        Ok(Probe { probe_id, already_added: self.is_trusted(&origin), origin, host, info })
    }

    /// Step two: the user confirmed what the probe showed them.
    pub fn add(&mut self, probe_id: &str) -> std::result::Result<Server, String> {
        self.prune();
        let Some(p) = self.probes.remove(probe_id) else {
            return Err("Check the server again, then add it.".into());
        };
        if p.origin == DEFAULT_SERVER {
            self.default_sign_in = p.info.sign_in;
            self.default_version = p.info.version;
            return Ok(self.get(DEFAULT_SERVER).unwrap());
        }
        let entry = Server {
            origin: p.origin.clone(),
            name: p.info.name,
            sign_in: p.info.sign_in,
            version: p.info.version,
            added_at: Some(iso_now((self.now)())),
            is_default: false,
        };
        let before = self.added.clone();
        if let Some(at) = self.added.iter().position(|s| s.origin == p.origin) {
            let added_at = self.added[at].added_at.clone().or(entry.added_at.clone());
            self.added[at] = Server { added_at, ..entry };
        } else {
            self.added.push(entry);
        }
        if let Err(e) = self.save() {
            self.added = before;
            return Err(format!("Couldn't save the server list ({e})."));
        }
        self.publish();
        Ok(self.get(&p.origin).unwrap())
    }

    /// Remove an added server. Returns whether anything was removed. The
    /// caller also forgets that origin's session.
    pub fn remove(&mut self, origin: &str) -> std::result::Result<bool, String> {
        if is_cloud_origin(origin) {
            return Err("Markie Cloud can't be removed.".into());
        }
        let before = self.added.clone();
        self.added.retain(|s| s.origin != origin);
        if self.added.len() == before.len() {
            return Ok(false);
        }
        if let Err(e) = self.save() {
            self.added = before;
            return Err(format!("Couldn't save the server list ({e})."));
        }
        self.publish();
        Ok(true)
    }

    /// Ask Markie Cloud whether it offers Apple, at most once per PROBE_TTL_MS.
    /// Only `apple` is taken from the answer. A failed try keeps the last answer.
    pub async fn refresh_default<S: InfoSource>(&mut self, source: &S) -> bool {
        let now = (self.now)();
        if let Some(at) = self.default_checked_at
            && now.saturating_sub(at) < PROBE_TTL_MS
        {
            return self.default_known;
        }
        self.default_checked_at = Some(now);
        match probe_server_info(source, DEFAULT_SERVER).await {
            Ok(info) => {
                self.default_sign_in.apple = info.sign_in.apple;
                self.default_known = true;
                true
            }
            Err(_) => self.default_known,
        }
    }
}

fn iso_now(ms: u64) -> String {
    // A small UTC formatter so the crate needs no date library.
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{:03}Z", ms % 1000)
}

pub(crate) fn iso_now_system() -> String {
    iso_now(system_now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn info() -> Value {
        json!({
            "product": "markie-server", "apiVersion": 1, "version": "1.2.3", "name": "Team docs",
            "origin": "https://docs.example.com", "signIn": { "email": true, "google": false }
        })
    }
    const SELF: &str = "https://docs.example.com";
    const RAILWAY: &str = "https://api-production-602f.up.railway.app";

    #[test]
    fn a_pinned_local_server_is_trusted_for_the_run_and_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("servers.json");
        let mut store = ServerStore::open(Some(file.clone()), true);
        let origin = store.pin_local("http://localhost:18787").unwrap();
        assert_eq!(origin, "http://localhost:18787");
        assert!(store.is_trusted(&origin));
        assert!(store.trust_handle().read().unwrap().is_allowed_server_origin(&origin));
        assert_eq!(store.origins(), vec![DEFAULT_SERVER.to_string(), origin.clone()]);
        // Pinning twice keeps one row; nothing reaches the file.
        store.pin_local("http://localhost:18787/").unwrap();
        assert_eq!(store.origins().len(), 2);
        assert!(!file.exists());
        assert!(ServerStore::open(Some(file), true).origins() == vec![DEFAULT_SERVER.to_string()]);
        // Never a real server, and never in a store opened for production.
        assert!(store.pin_local(SELF).is_err());
        assert!(ServerStore::open(None, false).pin_local("http://localhost:18787").is_err());
    }

    /// A fake server answering every probe with one status and body, counting calls.
    struct Fake {
        answer: Mutex<std::result::Result<(u16, Value), ()>>,
        calls: Mutex<Vec<String>>,
    }
    impl Fake {
        fn new(status: u16, body: Value) -> Self {
            Self { answer: Mutex::new(Ok((status, body))), calls: Mutex::new(Vec::new()) }
        }
        fn down() -> Self {
            Self { answer: Mutex::new(Err(())), calls: Mutex::new(Vec::new()) }
        }
        fn set(&self, a: std::result::Result<(u16, Value), ()>) {
            *self.answer.lock().unwrap() = a;
        }
        fn calls(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }
    impl InfoSource for Fake {
        async fn server_info(&self, origin: &str) -> Result<Answer> {
            self.calls.lock().unwrap().push(origin.to_string());
            match self.answer.lock().unwrap().clone() {
                Ok((status, data)) => Ok(Answer { status, data: Some(data), bytes: vec![], set_auth_token: None, etag: None, content_type: None }),
                Err(()) => Err(CloudError::Offline),
            }
        }
    }

    fn with(v: &Value, k: &str, x: Value) -> Value {
        let mut v = v.clone();
        v[k] = x;
        v
    }

    #[test]
    fn server_info_contract() {
        let r = parse_server_info(&info(), SELF).unwrap();
        assert_eq!(r, ServerInfo { name: "Team docs".into(), version: Some("1.2.3".into()), sign_in: SignIn { email: true, google: false, apple: false, signup: SignupMode::Open } });
        for (mode, want) in [("open", SignupMode::Open), ("invite", SignupMode::Invite), ("closed", SignupMode::Closed), ("maybe", SignupMode::Open)] {
            let body = with(&info(), "signIn", json!({ "email": true, "signup": mode }));
            assert_eq!(parse_server_info(&body, SELF).unwrap().sign_in.signup, want);
        }
        assert!(parse_server_info(&with(&info(), "product", json!("other")), SELF).is_err());
        assert!(parse_server_info(&Value::Null, SELF).is_err());
        assert!(parse_server_info(&json!("hi"), SELF).is_err());
        assert!(parse_server_info(&with(&info(), "apiVersion", json!(2)), SELF).is_err());
        assert!(parse_server_info(&with(&info(), "apiVersion", json!("1")), SELF).is_err());
        assert!(parse_server_info(&with(&info(), "origin", json!("https://elsewhere.example.com")), SELF).is_err());
    }

    #[test]
    fn cloud_old_and_new_addresses_are_one_server() {
        assert!(parse_server_info(&with(&info(), "origin", json!(RAILWAY)), DEFAULT_SERVER).is_ok());
        assert!(parse_server_info(&with(&info(), "origin", json!(DEFAULT_SERVER)), RAILWAY).is_ok());
        assert!(parse_server_info(&with(&info(), "origin", json!(RAILWAY)), SELF).is_err());
        assert!(parse_server_info(&with(&info(), "origin", json!(SELF)), DEFAULT_SERVER).is_err());
    }

    #[test]
    fn names_are_cleaned_and_reserved_ones_replaced() {
        let mut body = info();
        body.as_object_mut().unwrap().remove("name");
        assert_eq!(parse_server_info(&body, SELF).unwrap().name, "docs.example.com");
        assert_eq!(parse_server_info(&with(&info(), "name", json!("Team\u{202e} docs\n")), SELF).unwrap().name, "Team docs");
        for name in [
            "Markie Cloud",
            "Markie",
            "  markie   CLOUD ",
            "M a r k i e  C l o u d",
            "Mаrkie Cloud",
            "Markіe",
            "Mark1e Cloud",
            "Ｍａｒｋｉｅ Ｃｌｏｕｄ",
            "Mar\u{200b}kie Cloud",
            "Markie Cloud (official)",
            "The Markie Cloud",
            "markie.cloud",
            "rnarkie",
        ] {
            assert!(is_reserved_name(name), "{name}");
            assert_eq!(parse_server_info(&with(&info(), "name", json!(name)), SELF).unwrap().name, "docs.example.com", "{name}");
        }
        for name in ["Acme's Markie", "Markie at Acme", "Team docs", "Cloud"] {
            assert!(!is_reserved_name(name), "{name}");
        }
        assert_eq!(parse_server_info(&with(&info(), "name", json!("Markie at Acme")), SELF).unwrap().name, "Markie at Acme");
    }

    #[test]
    fn google_off_unless_said_and_apple_only_when_true() {
        let mut body = info();
        body.as_object_mut().unwrap().remove("signIn");
        let s = parse_server_info(&body, SELF).unwrap().sign_in;
        assert!(s.email && !s.google && !s.apple);
        let s = parse_server_info(&with(&info(), "signIn", json!({ "email": true, "google": false, "apple": "yes" })), SELF).unwrap().sign_in;
        assert!(!s.apple);
    }

    #[tokio::test]
    async fn probe_rules() {
        let r = probe_server_info(&Fake::new(404, json!("Not found")), DEFAULT_SERVER).await.unwrap();
        assert_eq!(r.name, "Markie Cloud");
        assert_eq!(r.sign_in, SignIn::cloud_default());
        assert!(probe_server_info(&Fake::new(404, json!("Not found")), SELF).await.is_err());
        assert!(probe_server_info(&Fake::down(), SELF).await.is_err());
        assert!(probe_server_info(&Fake::new(200, json!("<html>")), SELF).await.is_err());
    }

    fn clock(start: u64) -> (Clock, Arc<AtomicU64>) {
        let t = Arc::new(AtomicU64::new(start));
        let c = t.clone();
        (Arc::new(move || c.load(Ordering::SeqCst)), t)
    }

    #[tokio::test]
    async fn the_trusted_list() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("servers.json");
        let mut store = ServerStore::open(Some(file.clone()), false);
        assert_eq!(store.origins(), vec![DEFAULT_SERVER]);
        assert!(store.list()[0].is_default);
        assert!(store.remove(DEFAULT_SERVER).is_err());
        assert!(store.is_trusted(DEFAULT_SERVER));

        let fake = Fake::new(200, info());
        let checked = store.probe(&fake, SELF).await.unwrap();
        assert_eq!(checked.info.name, "Team docs");
        // Checking is not adding.
        assert!(!store.is_trusted(SELF));
        assert!(!store.trust_handle().read().unwrap().is_allowed_server_origin(SELF));
        let added = store.add(&checked.probe_id).unwrap();
        assert_eq!(added.origin, SELF);
        assert!(store.is_trusted(SELF));
        assert!(store.trust_handle().read().unwrap().is_allowed_server_origin(SELF));
        assert_eq!(ServerStore::open(Some(file.clone()), false).origins(), vec![DEFAULT_SERVER, SELF]);
        // Used probe ids are gone.
        assert!(store.add(&checked.probe_id).is_err());
        assert!(store.add("made-up").is_err());

        assert_eq!(store.remove(SELF), Ok(true));
        assert!(!store.is_trusted(SELF));
        assert!(!store.trust_handle().read().unwrap().is_allowed_server_origin(SELF));
        assert_eq!(ServerStore::open(Some(file), false).origins(), vec![DEFAULT_SERVER]);
    }

    #[tokio::test]
    async fn a_stale_probe_cannot_be_added_and_bad_input_is_never_probed() {
        let (c, t) = clock(1_000_000);
        let mut store = ServerStore::with_clock(None, false, c);
        let fake = Fake::new(200, info());
        let p = store.probe(&fake, SELF).await.unwrap();
        t.fetch_add(PROBE_TTL_MS + 1, Ordering::SeqCst);
        assert!(store.add(&p.probe_id).is_err());
        assert!(!store.is_trusted(SELF));
        let calls = fake.calls();
        for bad in ["http://docs.example.com", "https://a:b@docs.example.com", "https://localhost:8787"] {
            assert!(store.probe(&fake, bad).await.is_err());
        }
        assert_eq!(fake.calls(), calls);
    }

    #[test]
    fn stored_entries_pass_the_typed_check() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("servers.json");
        std::fs::write(
            &file,
            json!({ "version": 1, "servers": [
                { "origin": "http://plain.example.com", "name": "x" },
                { "origin": "https://docs.example.com/path", "name": "x" },
                { "origin": "https://u:p@docs.example.com", "name": "x" },
                { "origin": "http://localhost:8787", "name": "dev" },
                { "origin": DEFAULT_SERVER, "name": "Fake cloud" },
                { "origin": RAILWAY, "name": "Old cloud" },
                { "origin": "https://ok.example.com", "name": "Fine" },
                { "origin": "https://ok.example.com", "name": "Duplicate" },
                { "origin": "https://evil.example.com", "name": "Markie Cloud" },
            ]})
            .to_string(),
        )
        .unwrap();
        let store = ServerStore::open(Some(file.clone()), false);
        assert_eq!(store.origins(), vec![DEFAULT_SERVER, "https://ok.example.com", "https://evil.example.com"]);
        assert_eq!(store.get("https://evil.example.com").unwrap().name, "evil.example.com");
        assert_eq!(ServerStore::open(Some(file.clone()), true).origins()[1], "http://localhost:8787");
        // The old address is Markie Cloud: trusted, default, not removable.
        assert!(store.is_trusted(RAILWAY));
        assert!(store.get(RAILWAY).unwrap().is_default);
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(ServerStore::open(Some(file), false).origins(), vec![DEFAULT_SERVER]);
    }

    #[tokio::test]
    async fn the_old_cloud_address_probes_as_cloud() {
        let fake = Fake::new(200, with(&with(&info(), "name", json!("Markie Cloud")), "origin", json!(RAILWAY)));
        let mut store = ServerStore::open(None, false);
        let p = store.probe(&fake, RAILWAY).await.unwrap();
        assert_eq!((p.origin.as_str(), p.host.as_str(), p.info.name.as_str(), p.already_added), (DEFAULT_SERVER, "api.markiedocs.com", "Markie Cloud", true));
        assert_eq!(fake.calls.lock().unwrap()[0], DEFAULT_SERVER);
        assert!(store.add(&p.probe_id).unwrap().is_default);
        assert_eq!(store.origins(), vec![DEFAULT_SERVER]);
    }

    #[tokio::test]
    async fn apple_on_cloud_follows_cloud_and_survives_outages() {
        let (c, t) = clock(1_000_000);
        let mut store = ServerStore::with_clock(None, false, c);
        let cloud = |apple: bool| {
            let mut s = json!({ "email": false, "google": false, "signup": "closed" });
            if apple {
                s["apple"] = json!(true);
            }
            with(&with(&with(&info(), "name", json!("Markie Cloud")), "origin", json!(DEFAULT_SERVER)), "signIn", s)
        };
        let fake = Fake::new(200, cloud(true));
        assert_eq!(store.get(DEFAULT_SERVER).unwrap().sign_in, SignIn::cloud_default());
        assert!(store.refresh_default(&fake).await);
        // Apple from the answer; everything else stays the defaults.
        assert_eq!(store.get(DEFAULT_SERVER).unwrap().sign_in, SignIn { apple: true, ..SignIn::cloud_default() });
        t.fetch_add(PROBE_TTL_MS - 1, Ordering::SeqCst);
        assert!(store.refresh_default(&fake).await);
        assert_eq!(fake.calls(), 1);
        fake.set(Ok((200, cloud(false))));
        t.fetch_add(1, Ordering::SeqCst);
        assert!(store.refresh_default(&fake).await);
        assert!(!store.get(DEFAULT_SERVER).unwrap().sign_in.apple);
        fake.set(Ok((200, cloud(true))));
        t.fetch_add(PROBE_TTL_MS, Ordering::SeqCst);
        store.refresh_default(&fake).await;
        fake.set(Err(()));
        t.fetch_add(PROBE_TTL_MS, Ordering::SeqCst);
        assert!(store.refresh_default(&fake).await);
        assert!(store.get(DEFAULT_SERVER).unwrap().sign_in.apple);
        assert_eq!(fake.calls(), 4);
    }

    #[tokio::test]
    async fn unreachable_cloud_leaves_apple_off() {
        let (c, t) = clock(1_000_000);
        let mut store = ServerStore::with_clock(None, false, c);
        let fake = Fake::down();
        assert!(!store.refresh_default(&fake).await);
        assert!(!store.refresh_default(&fake).await);
        assert_eq!(fake.calls(), 1);
        t.fetch_add(PROBE_TTL_MS, Ordering::SeqCst);
        store.refresh_default(&fake).await;
        assert_eq!(fake.calls(), 2);
        assert_eq!(store.get(DEFAULT_SERVER).unwrap().sign_in, SignIn::cloud_default());
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_now(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_now(1_763_683_200_123), "2025-11-21T00:00:00.123Z");
    }
}
