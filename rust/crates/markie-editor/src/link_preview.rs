//! The link preview fetch: the networking half of `electron/link-preview.js`
//! (its parsing and address rules are `markie_core::link_preview`).
//!
//! * Every hop is checked: the address must pass `parse_target`, and every
//!   address its name resolves to must be public. The connection is pinned to
//!   those checked addresses, so DNS cannot change its answer in between.
//! * Redirects are followed by hand, at most four, each one checked again.
//! * Pages and pictures are capped at 512 KB, compressed bodies are refused,
//!   and the whole preview, picture included, has six seconds.
//! * No cookies, referrer or proxy. The user agent is Electron's.
//! * Results are kept in memory only, for 30 minutes, at most 200 entries
//!   and 8 MB, with at most four fetches at once.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use markie_core::link_preview::{self as lp, MAX_HTML_BYTES, MAX_IMAGE_BYTES, MAX_REDIRECTS, TIMEOUT_MS};
use url::Url;

const UA: &str = "Markie link preview (+https://markie.app)";
const TTL: Duration = Duration::from_secs(30 * 60);
const MAX_ENTRIES: usize = 200;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 4;

/// What a card shows (Electron's `LinkPreview`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkPreview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: String,
    /// The picture's bytes and its MIME type (png, jpeg, gif, webp or avif).
    pub image: Option<(Vec<u8>, String)>,
}

#[derive(Default)]
struct State {
    cache: HashMap<String, (Option<LinkPreview>, Instant, usize)>,
    order: Vec<String>,
    bytes: usize,
    in_flight: usize,
}

/// One per app. Cheap to clone.
#[derive(Clone, Default)]
pub struct Previews {
    state: Arc<Mutex<State>>,
    /// Only tests set this, to reach a page they serve themselves.
    pub allow_private: bool,
}

fn target(raw: &str, allow_private: bool) -> Option<Url> {
    if allow_private {
        let mut u = Url::parse(raw).ok()?;
        u.set_fragment(None);
        return matches!(u.scheme(), "http" | "https").then_some(u);
    }
    lp::parse_target(raw)
}

/// Resolve and check every address (`resolveAddresses`).
fn addresses(url: &Url, allow_private: bool) -> Option<Vec<SocketAddr>> {
    let host = url.host_str()?.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = url.port_or_known_default()?;
    let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => (host.as_str(), port).to_socket_addrs().ok()?.collect(),
    };
    if addrs.is_empty() || (!allow_private && addrs.iter().any(|a| lp::is_private_address(a.ip()))) {
        return None;
    }
    Some(addrs)
}

/// `fetchChecked`: (final url, content type, body).
fn fetch_checked(raw: &str, accept: &str, max: usize, deadline: Instant, allow_private: bool) -> Option<(Url, String, Vec<u8>)> {
    let mut url = target(raw, allow_private)?;
    for _ in 0..=MAX_REDIRECTS {
        let left = deadline.checked_duration_since(Instant::now())?;
        let addrs = addresses(&url, allow_private)?;
        let host = url.host_str()?.to_string();
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(left)
            .resolve_to_addrs(&host, &addrs)
            .build()
            .ok()?;
        let resp = client
            .get(url.clone())
            .header("user-agent", UA)
            .header("accept", accept)
            .header("accept-encoding", "identity")
            .send()
            .ok()?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp.headers().get("location")?.to_str().ok()?.to_string();
            url = target(url.join(&loc).ok()?.as_str(), allow_private)?;
            continue;
        }
        let enc = resp.headers().get("content-encoding").and_then(|v| v.to_str().ok()).map(|s| s.to_ascii_lowercase());
        if !status.is_success() || enc.is_some_and(|e| e != "identity") {
            return None;
        }
        if resp.content_length().is_some_and(|n| n as usize > max) {
            return None;
        }
        let ty = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let mut body = Vec::new();
        resp.take(max as u64 + 1).read_to_end(&mut body).ok()?;
        if body.len() > max {
            return None;
        }
        return Some((url, ty, body));
    }
    None
}

fn fetch_image(raw: &str, base: &Url, deadline: Instant, allow_private: bool) -> Option<(Vec<u8>, String)> {
    let abs = base.join(raw).ok()?;
    let (_, ty, bytes) = fetch_checked(abs.as_str(), "image/*", MAX_IMAGE_BYTES, deadline, allow_private)?;
    let ty = ty.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let ok = matches!(ty.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif");
    (ok && !bytes.is_empty()).then_some((bytes, ty))
}

/// `load`: the card for one checked address, or None.
fn load(key: &str, allow_private: bool) -> Option<LinkPreview> {
    let deadline = Instant::now() + Duration::from_millis(TIMEOUT_MS);
    let (url, ty, body) = fetch_checked(key, "text/html,application/xhtml+xml", MAX_HTML_BYTES, deadline, allow_private)?;
    let ty = ty.to_ascii_lowercase();
    if !ty.is_empty() && !ty.contains("html") && !ty.contains("xml") {
        return None;
    }
    let mut meta = lp::parse_meta(&String::from_utf8_lossy(&body));
    // An empty title tag reads as no title (`!meta.title`).
    meta.title = meta.title.filter(|t| !t.is_empty());
    if meta.title.is_none() && meta.description.is_none() {
        return None;
    }
    let image = meta.image_url.as_deref().and_then(|i| fetch_image(i, &url, deadline, allow_private));
    let site_name = meta.site_name.clone().unwrap_or_else(|| {
        let h = url.host_str().unwrap_or("");
        h.strip_prefix("www.").unwrap_or(h).to_string()
    });
    Some(LinkPreview { url: url.to_string(), title: meta.title, description: meta.description, site_name, image })
}

/// Rough size for the cache budget (Electron counts the key and the JSON).
fn size_of(key: &str, v: &Option<LinkPreview>) -> usize {
    key.len()
        + v.as_ref().map_or(4, |p| {
            p.url.len()
                + p.title.as_ref().map_or(0, |s| s.len())
                + p.description.as_ref().map_or(0, |s| s.len())
                + p.site_name.len()
                + p.image.as_ref().map_or(0, |(b, _)| b.len() * 4 / 3 + 32)
                + 64
        })
}

pub enum Lookup {
    /// Cached: the card, or None when the page had nothing to show.
    Ready(Option<LinkPreview>),
    /// Fetch it (blocking; run off the main thread with `fetch`).
    Fetch(String),
    /// Refused: not an address Markie may fetch, or too many in flight.
    Refused,
}

impl Previews {
    pub fn lookup(&self, raw: &str) -> Lookup {
        let Some(t) = target(raw, self.allow_private) else { return Lookup::Refused };
        let key = t.to_string();
        let mut st = self.state.lock().unwrap();
        if let Some((v, until, bytes)) = st.cache.get(&key).cloned() {
            if until > Instant::now() {
                return Lookup::Ready(v);
            }
            st.cache.remove(&key);
            st.order.retain(|k| *k != key);
            st.bytes -= bytes;
        }
        if st.in_flight >= MAX_IN_FLIGHT {
            return Lookup::Refused;
        }
        Lookup::Fetch(key)
    }

    /// Fetch `key` (from `Lookup::Fetch`) and remember the answer. Blocking.
    pub fn fetch(&self, key: &str) -> Option<LinkPreview> {
        self.state.lock().unwrap().in_flight += 1;
        let v = load(key, self.allow_private);
        let mut st = self.state.lock().unwrap();
        st.in_flight -= 1;
        let bytes = size_of(key, &v);
        while !st.order.is_empty() && (st.cache.len() >= MAX_ENTRIES || st.bytes + bytes > MAX_CACHE_BYTES) {
            let oldest = st.order.remove(0);
            if let Some((_, _, b)) = st.cache.remove(&oldest) {
                st.bytes -= b;
            }
        }
        if bytes <= MAX_CACHE_BYTES && !st.cache.contains_key(key) {
            st.cache.insert(key.to_string(), (v.clone(), Instant::now() + TTL, bytes));
            st.order.push(key.to_string());
            st.bytes += bytes;
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// A one-thread server answering each request from `pages` by path.
    fn serve(pages: Vec<(&'static str, String)>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in l.incoming().take(16) {
                let Ok(mut s) = s else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let resp = pages.iter().find(|(p, _)| *p == path).map(|(_, r)| r.clone()).unwrap_or_else(|| "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n".into());
                let _ = s.write_all(resp.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    fn html(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn refuses_what_electron_refuses() {
        let p = Previews::default();
        assert!(matches!(p.lookup("http://127.0.0.1/x"), Lookup::Refused));
        assert!(matches!(p.lookup("https://example.com/?token=x"), Lookup::Refused));
        assert!(matches!(p.lookup("ftp://example.com/"), Lookup::Refused));
        assert!(matches!(p.lookup("https://example.com/a"), Lookup::Fetch(_)));
    }

    #[test]
    fn fetches_follows_a_redirect_and_caches() {
        let page = r#"<html><head><title>T</title><meta property="og:description" content="D"></head></html>"#;
        let base = serve(vec![
            ("/a", "HTTP/1.1 302 Found\r\nlocation: /b\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into()),
            ("/b", html(page)),
            ("/big", html(&"x".repeat(MAX_HTML_BYTES + 10))),
            ("/gz", "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-encoding: gzip\r\ncontent-length: 2\r\nconnection: close\r\n\r\nxx".into()),
        ]);
        let p = Previews { allow_private: true, ..Previews::default() };
        let Lookup::Fetch(key) = p.lookup(&format!("{base}/a#frag")) else { panic!() };
        let card = p.fetch(&key).expect("a card");
        assert_eq!(card.title.as_deref(), Some("T"));
        assert_eq!(card.description.as_deref(), Some("D"));
        assert!(card.url.ends_with("/b"));
        assert_eq!(card.site_name, "127.0.0.1");
        assert!(matches!(p.lookup(&format!("{base}/a")), Lookup::Ready(Some(_))));
        let Lookup::Fetch(k) = p.lookup(&format!("{base}/big")) else { panic!() };
        assert!(p.fetch(&k).is_none(), "over 512 KB");
        let Lookup::Fetch(k) = p.lookup(&format!("{base}/gz")) else { panic!() };
        assert!(p.fetch(&k).is_none(), "compressed bodies are refused");
    }
}
