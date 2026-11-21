//! Origin pinning. A port of electron/share-origin.js and the address check in
//! electron/servers.js.
//!
//! A bearer token, the sync engine and authenticated share fetches only ever go
//! to an origin on the trusted list: Markie Cloud, plus servers the user added
//! on purpose. Everything here is pure so it tests without a network.
use std::net::{Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

/// Markie Cloud's address. Mirrors electron/cloud-origin.json.
pub const DEFAULT_SERVER: &str = "https://api.markiedocs.com";
/// Markie Cloud's old addresses: the same server under an older name.
pub const CLOUD_ALIASES: &[&str] = &["https://api-production-602f.up.railway.app"];
/// Where Markie Cloud's documents are read (`/d/<id>`, `/s/<token>`).
pub const CLOUD_DOCS_ORIGIN: &str = "https://markiedocs.com";

/// Whether `origin` is Markie Cloud under its current name or an old one. Exact match.
pub fn is_cloud_origin(origin: &str) -> bool {
    origin == DEFAULT_SERVER || CLOUD_ALIASES.contains(&origin)
}

/// The exact origin of a URL string (`https://host[:port]`), or None.
pub fn origin_of(value: &str) -> Option<String> {
    let u = Url::parse(value).ok()?;
    let o = u.origin();
    if !o.is_tuple() {
        return None;
    }
    Some(o.ascii_serialization())
}

/// Markie Cloud's current origin for any of its old ones; anything else,
/// including a value that is not an origin at all, comes back unchanged.
pub fn canonical_cloud_origin(origin: &str) -> String {
    match origin_of(origin) {
        Some(parsed) if CLOUD_ALIASES.contains(&parsed.as_str()) => DEFAULT_SERVER.to_string(),
        _ => origin.to_string(),
    }
}

/// The link origin for documents on `server`: markiedocs.com for Markie Cloud,
/// the server itself for anything else.
pub fn doc_link_origin(server: &str) -> String {
    let trimmed = server.trim_end_matches('/');
    if is_cloud_origin(&canonical_cloud_origin(trimmed)) {
        CLOUD_DOCS_ORIGIN.to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_loose(src: &str) -> Option<Url> {
    let lower = src.to_ascii_lowercase();
    let with = if lower.starts_with("http://") || lower.starts_with("https://") {
        src.to_string()
    } else {
        format!("https://{src}")
    };
    Url::parse(&with).ok()
}

/// `localhost` or `127.0.0.1`, with any port. The dev-only allowance.
fn is_localhost(u: &Url) -> bool {
    matches!(u.host(), Some(Host::Domain("localhost")))
        || matches!(u.host(), Some(Host::Ipv4(a)) if a == Ipv4Addr::LOCALHOST)
}

fn has_credentials(u: &Url) -> bool {
    !u.username().is_empty() || u.password().is_some()
}

fn is_loopback_v4(a: Ipv4Addr) -> bool {
    let o = a.octets();
    o[0] == 127 || o[0] == 0
}

fn is_loopback_v6(a: Ipv6Addr) -> bool {
    let g = a.segments();
    let zeros = |from: usize, to: usize| g[from..to].iter().all(|x| *x == 0);
    if zeros(0, 7) && (g[7] == 0 || g[7] == 1) {
        return true;
    }
    let v4 = Ipv4Addr::new((g[6] >> 8) as u8, (g[6] & 255) as u8, (g[7] >> 8) as u8, (g[7] & 255) as u8);
    let mapped = zeros(0, 5) && g[5] == 0xffff;
    let translated = zeros(0, 4) && g[4] == 0xffff && g[5] == 0;
    if (mapped || translated) && is_loopback_v4(v4) {
        return true;
    }
    zeros(0, 6) && (g[6] >> 8) == 127
}

/// Whether a host is this computer: localhost by any spelling, 127.0.0.0/8,
/// 0.0.0.0/8, ::1, ::, and an IPv4 loopback written as IPv6.
pub fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => {
            let h = d.to_ascii_lowercase();
            let name = h.strip_suffix('.').unwrap_or(&h);
            name == "localhost" || name.ends_with(".localhost")
        }
        Host::Ipv4(a) => is_loopback_v4(*a),
        Host::Ipv6(a) => is_loopback_v6(*a),
    }
}

/// The same check on hostname text as a URL parser writes it (`[::1]`, `127.0.0.1`).
pub fn is_loopback_hostname(hostname: &str) -> bool {
    if hostname.is_empty() {
        return false;
    }
    match Host::parse(hostname) {
        Ok(Host::Domain(d)) => is_loopback_host(&Host::Domain(d.as_str())),
        Ok(Host::Ipv4(a)) => is_loopback_v4(a),
        Ok(Host::Ipv6(a)) => is_loopback_v6(a),
        Err(_) => false,
    }
}

/// A host a link from outside may name as a server to ask: public DNS names only.
pub fn is_public_hostname(hostname: &str) -> bool {
    let h = hostname.to_ascii_lowercase();
    if h.is_empty() || h.starts_with('[') || h.contains(':') {
        return false;
    }
    if h.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return false;
    }
    if !h.contains('.') {
        return false;
    }
    const LOCAL: &[&str] = &["local", "localhost", "internal", "lan", "home", "arpa", "test", "invalid", "example"];
    if let Some(tld) = h.rsplit('.').next()
        && LOCAL.contains(&tld)
    {
        return false;
    }
    h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// An address the user typed, reduced to an exact origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedOrigin {
    pub origin: String,
    /// host[:port], as shown to the user.
    pub host: String,
}

/// What the user typed, reduced to an exact origin, or the reason it is not
/// one. https only, no credentials, nothing after the host but an optional
/// trailing slash. This computer only in a dev build, over http or https.
pub fn parse_server_origin(input: &str, allow_dev: bool) -> Result<TypedOrigin, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter a server address.".into());
    }
    if raw.len() > 2048 {
        return Err("That address is too long.".into());
    }
    if raw.chars().any(char::is_whitespace) {
        return Err("That isn't a valid address.".into());
    }
    let has_scheme = {
        let mut chars = raw.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
            && raw
                .find("://")
                .is_some_and(|i| raw[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)))
    };
    let with_scheme = if has_scheme { raw.to_string() } else { format!("https://{raw}") };
    let u = Url::parse(&with_scheme).map_err(|_| "That isn't a valid address.".to_string())?;
    if has_credentials(&u) {
        return Err("Leave the user name and password out of the address.".into());
    }
    let Some(host) = u.host() else {
        return Err("That isn't a valid address.".into());
    };
    let local = is_loopback_host(&host);
    if local && !allow_dev {
        return Err("Markie can't use a server on this computer.".into());
    }
    if u.scheme() != "https" && !(local && u.scheme() == "http") {
        return Err("The address has to start with https://.".into());
    }
    let path_extra = u.path() != "/" && !u.path().is_empty();
    let query_extra = u.query().is_some_and(|q| !q.is_empty());
    let frag_extra = u.fragment().is_some_and(|f| !f.is_empty());
    if path_extra || query_extra || frag_extra {
        return Err("Use just the server's address, with nothing after it.".into());
    }
    let origin = u.origin().ascii_serialization();
    let host_text = match u.port() {
        Some(p) => format!("{}:{p}", u.host_str().unwrap_or_default()),
        None => u.host_str().unwrap_or_default().to_string(),
    };
    Ok(TypedOrigin { origin, host: host_text })
}

/// The trusted list at one moment: Markie Cloud always, plus the servers the
/// user added. `allow_dev` lets a dev build talk to localhost.
#[derive(Debug, Clone, Default)]
pub struct Trust {
    added: Vec<String>,
    pub allow_dev: bool,
}

impl Trust {
    pub fn new(added: impl IntoIterator<Item = String>, allow_dev: bool) -> Self {
        Self { added: added.into_iter().collect(), allow_dev }
    }

    /// Markie Cloud only, packaged-build rules.
    pub fn cloud_only() -> Self {
        Self::default()
    }

    pub fn origins(&self) -> Vec<String> {
        let mut out = vec![DEFAULT_SERVER.to_string()];
        out.extend(self.added.iter().cloned());
        out
    }

    pub fn is_trusted_origin(&self, origin: &str) -> bool {
        is_cloud_origin(origin) || self.added.iter().any(|o| o == origin)
    }

    /// May the bearer token go to this server URL? Only to a trusted https
    /// origin (or localhost in dev), compared exactly, never with credentials.
    pub fn is_allowed_server_origin(&self, server_url: &str) -> bool {
        let Ok(u) = Url::parse(server_url) else { return false };
        if has_credentials(&u) {
            return false;
        }
        let origin = u.origin().ascii_serialization();
        if u.scheme() == "https" && self.is_trusted_origin(&origin) {
            return true;
        }
        if self.allow_dev && is_localhost(&u) {
            return true;
        }
        // A localhost server the user added in a dev build is on the list as http.
        self.allow_dev && u.scheme() == "http" && self.added.iter().any(|o| *o == origin)
    }

    /// The base origin to fetch a shared document from. A deep link's `src` is
    /// honored only when it is a trusted origin; anything else falls back to
    /// Markie Cloud (defeats `markie://open?src=<attacker>`).
    pub fn share_base_from_src(&self, src: Option<&str>) -> String {
        if let Some(src) = src.filter(|s| !s.is_empty())
            && let Some(u) = parse_loose(src)
            && !has_credentials(&u)
        {
            let ok_proto = u.scheme() == "https" || (self.allow_dev && u.scheme() == "http");
            let origin = u.origin().ascii_serialization();
            let ok_host = self.is_trusted_origin(&origin) || (self.allow_dev && is_localhost(&u));
            if ok_host && ok_proto {
                return canonical_cloud_origin(&origin);
            }
        }
        DEFAULT_SERVER.to_string()
    }

    /// The origin a link names when it is a plausible Markie server the user
    /// has not added. The caller has to ask before fetching anything from it.
    pub fn untrusted_share_origin(&self, src: Option<&str>) -> Option<String> {
        let src = src.filter(|s| !s.is_empty())?;
        let u = parse_loose(src)?;
        if u.scheme() != "https" || has_credentials(&u) {
            return None;
        }
        let origin = u.origin().ascii_serialization();
        if self.is_trusted_origin(&origin) {
            return None;
        }
        if self.allow_dev && is_localhost(&u) {
            return None;
        }
        if !is_public_hostname(u.host_str().unwrap_or_default()) {
            return None;
        }
        Some(origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOUD: &str = "https://api.markiedocs.com";
    const RAILWAY: &str = "https://api-production-602f.up.railway.app";
    const SELF: &str = "https://docs.example.com";

    fn base(src: &str) -> String {
        Trust::cloud_only().share_base_from_src(Some(src))
    }

    #[test]
    fn share_base_honours_only_trusted_origins() {
        assert_eq!(base(CLOUD), CLOUD);
        assert_eq!(base(RAILWAY), CLOUD);
        assert_eq!(base("api-production-602f.up.railway.app"), CLOUD);
        assert_eq!(base(&format!("{RAILWAY}/")), CLOUD);
        for evil in [
            "evil.com",
            "169.254.169.254",
            "http://api-production-602f.up.railway.app",
            "https://api-production-602f.up.railway.app.evil.com",
            "http://api.markiedocs.com",
            "https://api.markiedocs.com.evil.com",
            "",
            "::::",
        ] {
            assert_eq!(base(evil), DEFAULT_SERVER, "{evil}");
        }
        let dev = Trust::new([], true);
        assert_eq!(dev.share_base_from_src(Some("http://localhost:8787")), "http://localhost:8787");
        assert_eq!(base("http://localhost:8787"), DEFAULT_SERVER);
    }

    #[test]
    fn allowed_server_origin() {
        let t = Trust::cloud_only();
        assert!(t.is_allowed_server_origin(CLOUD));
        assert!(t.is_allowed_server_origin(RAILWAY));
        assert!(!t.is_allowed_server_origin("http://api.markiedocs.com"));
        assert!(!t.is_allowed_server_origin("https://evil.com"));
        assert!(!t.is_allowed_server_origin("http://api-production-602f.up.railway.app"));
        assert!(!t.is_allowed_server_origin(""));
        assert!(Trust::new([], true).is_allowed_server_origin("http://localhost:8787"));
        assert!(!t.is_allowed_server_origin("http://localhost:8787"));
    }

    #[test]
    fn trusted_list_replaces_the_pin() {
        assert!(!Trust::cloud_only().is_allowed_server_origin(SELF));
        let t = Trust::new([SELF.to_string()], false);
        assert!(t.is_allowed_server_origin(SELF));
        assert!(t.is_allowed_server_origin(&format!("{SELF}/")));
        assert_eq!(t.share_base_from_src(Some(SELF)), SELF);
        assert!(!t.is_allowed_server_origin("https://docs.example.com:8443"));
        assert!(!t.is_allowed_server_origin("http://docs.example.com"));
        assert!(!t.is_allowed_server_origin("https://docs.example.com.evil.com"));
        assert_eq!(t.share_base_from_src(Some("https://docs.example.com.evil.com")), DEFAULT_SERVER);
        // Never to a URL carrying credentials.
        assert!(!t.is_allowed_server_origin("https://u:p@docs.example.com"));
        assert_eq!(t.share_base_from_src(Some("https://u:p@docs.example.com")), DEFAULT_SERVER);
        // The default server is always trusted.
        assert!(Trust::new([], false).is_allowed_server_origin(DEFAULT_SERVER));
    }

    #[test]
    fn untrusted_share_origin_rules() {
        let t = Trust::cloud_only();
        assert_eq!(t.untrusted_share_origin(Some(SELF)).as_deref(), Some(SELF));
        assert_eq!(t.untrusted_share_origin(Some("docs.example.com")).as_deref(), Some(SELF));
        assert_eq!(t.untrusted_share_origin(Some(DEFAULT_SERVER)), None);
        assert_eq!(Trust::new([SELF.to_string()], false).untrusted_share_origin(Some(SELF)), None);
        for bad in [
            "",
            "http://docs.example.com",
            "https://u:p@docs.example.com",
            "169.254.169.254",
            "https://10.0.0.5",
            "https://[::1]",
            "https://intranet",
            "https://printer.local",
            "https://localhost:8787",
        ] {
            assert_eq!(t.untrusted_share_origin(Some(bad)), None, "{bad}");
        }
        assert_eq!(t.untrusted_share_origin(None), None);
        // The old address is trusted even when only the new one is listed.
        assert_eq!(t.untrusted_share_origin(Some(RAILWAY)), None);
        assert!(t.is_trusted_origin(RAILWAY));
        assert_eq!(
            t.untrusted_share_origin(Some("https://api-production-602f.up.railway.app.evil.com")).as_deref(),
            Some("https://api-production-602f.up.railway.app.evil.com")
        );
    }

    fn host_of(address: &str) -> bool {
        let u = Url::parse(address).unwrap();
        is_loopback_host(&u.host().unwrap())
    }

    #[test]
    fn loopback_in_every_form() {
        for a in [
            "https://localhost",
            "https://localhost.",
            "https://x.localhost",
            "https://127.0.0.1",
            "https://127.9.9.9",
            "https://0.0.0.0",
            "https://[::1]",
            "https://[::]",
            "https://[::ffff:127.0.0.1]",
            "https://[::ffff:7f00:1]",
            "https://[::ffff:0:0]",
            "https://[::7f00:1]",
            "https://[::ffff:0:7f00:1]",
        ] {
            assert!(host_of(a), "{a}");
        }
        for a in [
            "https://docs.example.com",
            "https://localhost.example.com",
            "https://10.0.0.1",
            "https://128.0.0.1",
            "https://[::2]",
            "https://[::ffff:a00:1]",
            "https://[2001:db8::1]",
            "https://[fe80::1]",
        ] {
            assert!(!host_of(a), "{a}");
        }
        assert!(!is_loopback_hostname(""));
        assert!(is_loopback_hostname("[::1]"));
        assert!(is_loopback_hostname("127.0.0.1"));
    }

    #[test]
    fn cloud_addresses() {
        assert!(is_cloud_origin(CLOUD));
        assert!(is_cloud_origin(RAILWAY));
        assert!(!is_cloud_origin("http://api-production-602f.up.railway.app"));
        assert!(!is_cloud_origin("https://other-production-602f.up.railway.app"));
        assert_eq!(canonical_cloud_origin(RAILWAY), CLOUD);
        assert_eq!(canonical_cloud_origin(&format!("{RAILWAY}/")), CLOUD);
        assert_eq!(canonical_cloud_origin(CLOUD), CLOUD);
        assert_eq!(canonical_cloud_origin(SELF), SELF);
        assert_eq!(canonical_cloud_origin("http://localhost:8787"), "http://localhost:8787");
        assert_eq!(canonical_cloud_origin("not a url"), "not a url");
        assert_eq!(doc_link_origin(CLOUD), CLOUD_DOCS_ORIGIN);
        assert_eq!(doc_link_origin(RAILWAY), CLOUD_DOCS_ORIGIN);
        assert_eq!(doc_link_origin("https://docs.example.com/"), SELF);
    }

    #[test]
    fn parse_server_origin_exact_https() {
        let ok = |s: &str| parse_server_origin(s, false).map(|o| o.origin);
        assert_eq!(ok("https://docs.example.com").unwrap(), SELF);
        assert_eq!(ok("  https://Docs.Example.com/ ").unwrap(), SELF);
        assert_eq!(ok("docs.example.com").unwrap(), SELF);
        assert_eq!(ok("https://docs.example.com:8443").unwrap(), "https://docs.example.com:8443");
        assert_eq!(ok("https://docs.example.com:443").unwrap(), SELF);
        for bad in [
            "http://docs.example.com",
            "ftp://docs.example.com",
            "javascript:alert(1)",
            "https://user:pass@docs.example.com",
            "https://user@docs.example.com",
            "https://docs.example.com/api",
            "https://docs.example.com/?x=1",
            "https://docs.example.com/#a",
            "",
            "   ",
            "https://docs example.com",
            "https://",
        ] {
            assert!(parse_server_origin(bad, false).is_err(), "{bad}");
        }
    }

    #[test]
    fn parse_server_origin_localhost_only_in_dev() {
        assert!(parse_server_origin("http://localhost:8787", false).is_err());
        assert!(parse_server_origin("https://localhost:8787", false).is_err());
        assert_eq!(parse_server_origin("http://localhost:8787", true).unwrap().origin, "http://localhost:8787");
        assert!(parse_server_origin("http://127.0.0.1:8787", true).is_ok());
        assert!(parse_server_origin("http://docs.example.com", true).is_err());
        for a in [
            "https://localhost",
            "https://localhost.",
            "https://LocalHost.:8443",
            "https://app.localhost",
            "https://127.0.0.1",
            "https://127.1",
            "https://127.255.255.254",
            "https://0x7f000001",
            "https://2130706433",
            "https://0.0.0.0",
            "https://0",
            "https://[::1]",
            "https://[0:0:0:0:0:0:0:1]",
            "https://[::]",
            "https://[::ffff:127.0.0.1]",
            "https://[::ffff:7f00:1]",
            "https://[::ffff:0.0.0.0]",
            "https://[::127.0.0.1]",
        ] {
            assert_eq!(
                parse_server_origin(a, false),
                Err("Markie can't use a server on this computer.".to_string()),
                "{a}"
            );
        }
        for a in ["https://10.0.0.5", "https://100.64.1.2", "https://[2001:db8::1]", "https://localhost.example.com"] {
            assert!(parse_server_origin(a, false).is_ok(), "{a}");
        }
    }
}
