//! `markie-rs://` links: `electron/deep-links.js`, `share-open.js` and the
//! deep-link half of `main.js`, on Markie RS's own scheme.
//!
//!   markie-rs://auth?token=…&state=…   sign-in coming back from the browser,
//!                                      owned by the cloud sign-in code
//!   markie-rs://open?token=…&src=…     a public link: fetched with the link's
//!                                      own token, no account needed
//!   markie-rs://doc?id=…&src=…         a document shared with this account:
//!                                      fetched with the signed-in session
//!
//! `open` carries its authority in the URL. `doc` carries none, so a stranger
//! who gets hold of it opens nothing. A shared document lands in Downloads
//! under a collision-safe name and then opens like any other file.

use std::path::{Path, PathBuf};
use std::time::Duration;

use markie_cloud::origin::Trust;

pub const SCHEME: &str = "markie-rs://";
/// The same ceiling a document opened from disk has (`doc-tiers.js`).
pub const MAX_DOC_BYTES: usize = 100_000_000;
/// The whole exchange, answer and body.
pub const TIMEOUT: Duration = Duration::from_secs(120);

/// `classifyDeepLink`. The prefix test is the JavaScript's `startsWith`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Ignore,
    SharedToken,
    CloudDoc,
    /// Everything else on the scheme, `auth` among them.
    Renderer,
}

pub fn classify(link: &str) -> Kind {
    if !link.starts_with(SCHEME) {
        return Kind::Ignore;
    }
    if link.starts_with(&format!("{SCHEME}open")) {
        return Kind::SharedToken;
    }
    if link.starts_with(&format!("{SCHEME}doc")) {
        return Kind::CloudDoc;
    }
    Kind::Renderer
}

/// `isAuthDeepLink`: the sign-in hand-back, routed to the cloud sign-in code.
pub fn is_auth(link: &str) -> bool {
    classify(link) == Kind::Renderer && url::Url::parse(link).ok().and_then(|u| u.host_str().map(str::to_string)).as_deref() == Some("auth")
}

fn param(link: &str, name: &str) -> Option<String> {
    let u = url::Url::parse(link).ok()?;
    u.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// `cloudDocId`: the only thing a `doc` link may contribute.
pub fn cloud_doc_id(link: &str) -> Option<String> {
    (classify(link) == Kind::CloudDoc).then(|| param(link, "id")).flatten().filter(|id| !id.is_empty())
}

/// `sourceHint`: picks between trusted servers only, never fetched directly.
pub fn source_hint(link: &str) -> Option<String> {
    param(link, "src")
}

/// What a share link asks for, before anything touches the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SharePlan {
    Ignore,
    Fetch { base: String, token: String },
    /// A server the user has not added: ask, then fetch anonymously.
    Confirm { origin: String, host: String, token: String },
}

/// `planShareOpen`. `trusted_only` is a build locked to one server.
pub fn plan_share_open(link: &str, trust: &Trust, trusted_only: bool) -> SharePlan {
    if url::Url::parse(link).is_err() {
        return SharePlan::Ignore;
    }
    let Some(token) = param(link, "token").filter(|t| !t.is_empty()) else { return SharePlan::Ignore };
    let src = source_hint(link);
    if trusted_only && src.as_deref().is_some_and(|s| !s.is_empty() && !src_is_trusted(s, trust)) {
        return SharePlan::Ignore;
    }
    if let Some(origin) = trust.untrusted_share_origin(src.as_deref()) {
        let host = url::Url::parse(&origin).ok().map(|u| match u.port() {
            Some(p) => format!("{}:{p}", u.host_str().unwrap_or_default()),
            None => u.host_str().unwrap_or_default().to_string(),
        });
        return SharePlan::Confirm { origin, host: host.unwrap_or_default(), token };
    }
    SharePlan::Fetch { base: trust.share_base_from_src(src.as_deref()), token }
}

fn src_is_trusted(src: &str, trust: &Trust) -> bool {
    let base = trust.share_base_from_src(Some(src));
    let lower = src.to_ascii_lowercase();
    let with = if lower.starts_with("http://") || lower.starts_with("https://") { src.to_string() } else { format!("https://{src}") };
    url::Url::parse(&with)
        .map(|u| markie_cloud::origin::canonical_cloud_origin(&u.origin().ascii_serialization()) == base)
        .unwrap_or(false)
}

/// `docLinkServer`: a `doc` link's src as a trusted origin, or None for the primary.
pub fn doc_link_server(src: Option<&str>, trust: &Trust) -> Option<String> {
    let src = src.filter(|s| !s.is_empty())?;
    let lower = src.to_ascii_lowercase();
    let with = if lower.starts_with("http://") || lower.starts_with("https://") { src.to_string() } else { format!("https://{src}") };
    let origin = url::Url::parse(&with).ok()?.origin().ascii_serialization();
    trust.is_allowed_server_origin(&origin).then(|| markie_cloud::origin::canonical_cloud_origin(&origin))
}

/// `SAFE_DOC_EXTENSION` from `electron/doc-names.js`.
pub fn with_safe_doc_extension(name: &str) -> String {
    const SAFE: &[&str] = &["md", "markdown", "mdx", "txt", "text", "log", "csv", "wd"];
    let ok = name.rsplit_once('.').is_some_and(|(_, ext)| SAFE.iter().any(|s| s.eq_ignore_ascii_case(ext)));
    if ok { name.to_string() } else { format!("{name}.md") }
}

fn basename(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

/// `filenameFromDisposition`.
pub fn filename_from_disposition(cd: Option<&str>) -> Option<String> {
    let cd = cd?;
    let lower = cd.to_ascii_lowercase();
    if let Some(i) = lower.find("filename*=utf-8''") {
        let rest = &cd[i + "filename*=utf-8''".len()..];
        let value = rest.split(';').next().unwrap_or("");
        if !value.is_empty()
            && let Ok(decoded) = percent_decode(value)
        {
            return Some(basename(&decoded).to_string());
        }
    }
    let i = lower.find("filename=")?;
    let rest = cd[i + "filename=".len()..].trim_start_matches('"');
    let value: String = rest.chars().take_while(|c| *c != '"' && *c != ';').collect();
    let value = value.trim();
    (!value.is_empty()).then(|| basename(value).to_string())
}

/// `decodeURIComponent`, which throws on a malformed escape or bad UTF-8.
fn percent_decode(s: &str) -> Result<String, ()> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or(())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// `downloadsUniquePath`: `name`, `name (2)` … `name (200)`, then a time stamp.
pub fn downloads_unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let cleaned: String = basename(name).replace(['\\', '/', ':'], "_");
    let mut safe = cleaned.trim().to_string();
    if safe.is_empty() {
        safe = "Shared document".into();
    }
    let safe = with_safe_doc_extension(&safe);
    let (stem, ext) = match safe.rfind('.') {
        Some(i) if i > 0 => (safe[..i].to_string(), safe[i..].to_string()),
        _ => (safe.clone(), String::new()),
    };
    let mut candidate = dir.join(&safe);
    let mut i = 2;
    while exists(&candidate) && i <= 200 {
        candidate = dir.join(format!("{stem} ({i}){ext}"));
        i += 1;
    }
    if exists(&candidate) {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        candidate = dir.join(format!("{stem} ({}){ext}", radix36(stamp)));
    }
    candidate
}

fn radix36(mut n: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Where shared documents land. `MARKIE_RS_DOWNLOADS_DIR` points a test run
/// at a scratch folder, like Electron's `MARKIE_E2E_DOWNLOADS`.
pub fn downloads_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MARKIE_RS_DOWNLOADS_DIR") {
        return PathBuf::from(dir);
    }
    dirs::download_dir().unwrap_or_else(|| markie_core::paths::home_dir().join("Downloads"))
}

/// The trusted list as the cloud code would have it. Until Settings › Servers
/// is ported this is Markie Cloud only, with localhost in a debug build.
pub fn trust() -> Trust {
    Trust::new(Vec::new(), cfg!(debug_assertions))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub content: String,
    pub disposition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    Status(u16),
    TooLarge,
    Failed,
}

/// `GET <base>/s/<token>/raw`. No redirects either way: an approved public
/// host must not hand the request on. Anonymous adds the Accept header and,
/// like the trusted fetch, sends no cookies (this client keeps none).
pub async fn fetch_shared_raw(base: &str, token: &str, anonymous: bool, max_bytes: usize) -> Result<Fetched, FetchError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("MarkieRS/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| FetchError::Failed)?;
    let token = percent_encoding_component(token);
    let mut rb = client.get(format!("{base}/s/{token}/raw")).timeout(TIMEOUT);
    if anonymous {
        rb = rb.header("Accept", "text/markdown, text/plain, */*");
    }
    let mut res = rb.send().await.map_err(|_| FetchError::Failed)?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(FetchError::Status(status));
    }
    let disposition = res.headers().get("content-disposition").and_then(|v| v.to_str().ok()).map(str::to_string);
    if res.content_length().is_some_and(|n| n as usize > max_bytes) {
        return Err(FetchError::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| FetchError::Failed)? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err(FetchError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    // `res.text()` decodes as UTF-8 with replacement, as fetch does.
    Ok(Fetched { content: String::from_utf8_lossy(&bytes).into_owned(), disposition })
}

/// `encodeURIComponent`.
fn percent_encoding_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Run a future on a private current-thread runtime, off the UI thread.
pub fn block_on<F: std::future::Future>(f: F) -> Option<F::Output> {
    tokio::runtime::Builder::new_current_thread().enable_all().build().ok().map(|rt| rt.block_on(f))
}

/// Write a landed document atomically: a temp file next to it, then rename.
pub fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.markie-rs.tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("download")));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ── App side ──

use gpui_kit::{AnyWindowHandle, App, AsyncApp, Entity, PromptLevel};

use crate::workspace::Workspace;

/// `deliverDeepLink` for everything but `auth`. Raises the window, then works
/// in the background and opens what landed.
pub fn deliver(link: String, window: AnyWindowHandle, workspace: Entity<Workspace>, cx: &mut App) {
    match classify(&link) {
        Kind::Ignore => {}
        Kind::SharedToken => {
            cx.spawn(async move |cx| {
                if let Err(err) = open_shared(&link, window, workspace, cx).await {
                    crate::logs::log_crash("deep-link-shared-failed", &err);
                    show_failure(window, cx);
                }
            })
            .detach();
        }
        Kind::CloudDoc => {
            cx.spawn(async move |cx| {
                if let Err(err) = open_cloud_doc(&link, window, workspace, cx).await {
                    crate::logs::log_crash("deep-link-cloud-doc-failed", &err);
                    show_failure(window, cx);
                }
            })
            .detach();
        }
        // Electron hands these to the renderer, which knows only `auth`. The
        // sign-in code claims `auth` before this; anything else just raises
        // the window, as Electron does.
        Kind::Renderer => {
            let _ = window.update(cx, |_, window, cx| crate::open_urls::bring_to_front(window, cx));
        }
    }
}

async fn prompt(window: AnyWindowHandle, cx: &mut AsyncApp, level: PromptLevel, message: String, detail: String, answers: &'static [&'static str]) -> Option<usize> {
    let rx = window.update(cx, |_, window, cx| window.prompt(level, &message, Some(&detail), answers, cx)).ok()?;
    rx.await.ok()
}

fn show_failure(window: AnyWindowHandle, cx: &mut AsyncApp) {
    let _ = window.update(cx, |_, window, cx| {
        let _ = window.prompt(
            PromptLevel::Warning,
            "Couldn't open that link",
            Some("Markie hit an unexpected error opening the document. Try the link again, or open the file directly."),
            &["OK"],
            cx,
        );
    });
}

fn raise(window: AnyWindowHandle, cx: &mut AsyncApp) {
    let _ = window.update(cx, |_, window, cx| crate::open_urls::bring_to_front(window, cx));
}

fn open_landed(path: PathBuf, window: AnyWindowHandle, workspace: Entity<Workspace>, cx: &mut AsyncApp) {
    let _ = window.update(cx, move |_, window, cx| {
        crate::open_urls::bring_to_front(window, cx);
        workspace.update(cx, |ws, cx| ws.open_external(vec![path], window, cx));
    });
}

/// `openSharedFromDeepLink`.
async fn open_shared(link: &str, window: AnyWindowHandle, workspace: Entity<Workspace>, cx: &mut AsyncApp) -> Result<(), String> {
    raise(window, cx);
    let (base, token, anonymous) = match plan_share_open(link, &trust(), false) {
        SharePlan::Ignore => return Ok(()),
        SharePlan::Fetch { base, token } => (base, token, false),
        SharePlan::Confirm { origin, host, token } => {
            // Asked natively, so nothing in the document can answer it.
            let answer = prompt(
                window,
                cx,
                PromptLevel::Info,
                format!("Open a document from {host}?"),
                "This server isn't in your Markie servers. Markie will download a copy without signing in. To work on this server, add it in Settings > Servers.".into(),
                &["Open", "Cancel"],
            )
            .await;
            if answer != Some(0) {
                return Ok(());
            }
            (origin, token, true)
        }
    };
    let fetched = cx
        .background_executor()
        .spawn(async move { block_on(fetch_shared_raw(&base, &token, anonymous, MAX_DOC_BYTES)).unwrap_or(Err(FetchError::Failed)) })
        .await;
    match fetched {
        Ok(doc) => {
            let name = filename_from_disposition(doc.disposition.as_deref()).unwrap_or_else(|| "Shared document.md".into());
            let dest = downloads_unique_path(&downloads_dir(), &name, Path::exists);
            write_atomic(&dest, &doc.content).map_err(|e| format!("write failed: {e}"))?;
            open_landed(dest, window, workspace, cx);
        }
        Err(err) => {
            crate::logs::crash_log().log("markie-rs://open failed:", &format!("{err:?}"));
            prompt(
                window,
                cx,
                PromptLevel::Warning,
                "Couldn't open the shared document".into(),
                "The link may have expired, or you're offline. Try opening it again from the email.".into(),
                &["OK"],
            )
            .await;
        }
    }
    Ok(())
}

/// `openCloudDocFromDeepLink`. The session is this app's own, from its own
/// Keychain service; the link contributes only the id and a trusted-server hint.
async fn open_cloud_doc(link: &str, window: AnyWindowHandle, workspace: Entity<Workspace>, cx: &mut AsyncApp) -> Result<(), String> {
    let Some(id) = cloud_doc_id(link) else { return Ok(()) };
    let trust = trust();
    let server = doc_link_server(source_hint(link).as_deref(), &trust).unwrap_or_else(|| markie_cloud::DEFAULT_SERVER.to_string());
    raise(window, cx);

    // Electron waits up to 15 s for the renderer to hand over a session on a
    // cold start. Markie RS reads the Keychain directly, so a short wait is
    // enough for a sign-in that is finishing at this moment.
    let server_for_wait = server.clone();
    let signed_in = cx
        .background_executor()
        .spawn(async move {
            for _ in 0..8 {
                if session_store().get(&server_for_wait).ok().flatten().is_some() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            false
        })
        .await;
    if !signed_in {
        prompt(
            window,
            cx,
            PromptLevel::Info,
            "Sign in to open this document".into(),
            "This document was shared with your Markie account. Sign in, then open the link from your email again.".into(),
            &["OK"],
        )
        .await;
        return Ok(());
    }

    let landed = cx
        .background_executor()
        .spawn(async move {
            block_on(async move {
                use std::sync::{Arc, RwLock};
                let tokens = session_store();
                let client = markie_cloud::CloudClient::new(&server, Arc::new(RwLock::new(trust)), tokens, markie_cloud::http::Transport::new())
                    .map_err(|e| e.to_string())?;
                let doc = markie_cloud::docs::DocsClient::new(&client).get(&id).await.map_err(|e| e.to_string())?;
                let name = markie_cloud::sync::landing_name(&doc.name);
                let dest = downloads_unique_path(&downloads_dir(), &name, Path::exists);
                write_atomic(&dest, &doc.content).map_err(|e| e.to_string())?;
                Ok::<PathBuf, String>(dest)
            })
            .unwrap_or_else(|| Err("no runtime".into()))
        })
        .await;
    match landed {
        Ok(path) => open_landed(path, window, workspace, cx),
        Err(_) => {
            prompt(
                window,
                cx,
                PromptLevel::Warning,
                "Couldn't open the shared document".into(),
                "It may have been unshared, or you're signed in with a different account than it was shared with.".into(),
                &["OK"],
            )
            .await;
        }
    }
    Ok(())
}

/// Markie RS's own sign-ins: the one store the sign-in sheet writes
/// (`account::shared_tokens`), never the Electron app's.
pub fn session_store() -> std::sync::Arc<dyn markie_cloud::tokens::TokenStore> {
    crate::workspace::account::shared_tokens()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_like_electron_on_our_scheme() {
        assert_eq!(classify("markie-rs://open?token=t"), Kind::SharedToken);
        assert_eq!(classify("markie-rs://doc?id=1"), Kind::CloudDoc);
        assert_eq!(classify("markie-rs://auth?token=t&state=s"), Kind::Renderer);
        assert_eq!(classify("markie-rs://openly"), Kind::SharedToken, "startsWith, as the JavaScript");
        assert_eq!(classify("markie://open?token=t"), Kind::Ignore, "never the Electron scheme");
        assert_eq!(classify("https://markiedocs.com/s/t"), Kind::Ignore);
        assert!(is_auth("markie-rs://auth?token=t&state=s"));
        assert!(!is_auth("markie-rs://open?token=t"));
        assert!(!is_auth("markie-rs://other"));
    }

    #[test]
    fn doc_links_carry_only_an_id() {
        assert_eq!(cloud_doc_id("markie-rs://doc?id=abc&src=x").as_deref(), Some("abc"));
        assert_eq!(cloud_doc_id("markie-rs://doc?id="), None);
        assert_eq!(cloud_doc_id("markie-rs://doc"), None);
        assert_eq!(cloud_doc_id("markie-rs://open?id=abc"), None);
        let t = Trust::cloud_only();
        assert_eq!(doc_link_server(Some("https://evil.example.org"), &t), None);
        assert_eq!(doc_link_server(Some("api.markiedocs.com"), &t).as_deref(), Some("https://api.markiedocs.com"));
        assert_eq!(doc_link_server(Some("https://api-production-602f.up.railway.app"), &t).as_deref(), Some("https://api.markiedocs.com"));
        assert_eq!(doc_link_server(None, &t), None);
    }

    #[test]
    fn share_plans() {
        let t = Trust::cloud_only();
        assert_eq!(plan_share_open("markie-rs://open", &t, false), SharePlan::Ignore);
        assert_eq!(plan_share_open("markie-rs://open?token=", &t, false), SharePlan::Ignore);
        assert_eq!(
            plan_share_open("markie-rs://open?token=abc", &t, false),
            SharePlan::Fetch { base: "https://api.markiedocs.com".into(), token: "abc".into() }
        );
        assert_eq!(
            plan_share_open("markie-rs://open?token=abc&src=docs.example.org", &t, false),
            SharePlan::Confirm { origin: "https://docs.example.org".into(), host: "docs.example.org".into(), token: "abc".into() }
        );
        // An address inside the user's network falls back to Markie Cloud, never asked.
        assert_eq!(
            plan_share_open("markie-rs://open?token=abc&src=http://192.168.1.5", &t, false),
            SharePlan::Fetch { base: "https://api.markiedocs.com".into(), token: "abc".into() }
        );
        assert_eq!(plan_share_open("markie-rs://open?token=abc&src=docs.example.org", &t, true), SharePlan::Ignore);
        assert_eq!(
            plan_share_open("markie-rs://open?token=abc&src=api.markiedocs.com", &t, true),
            SharePlan::Fetch { base: "https://api.markiedocs.com".into(), token: "abc".into() }
        );
    }

    #[test]
    fn landing_names() {
        assert_eq!(with_safe_doc_extension("notes.md"), "notes.md");
        assert_eq!(with_safe_doc_extension("run.command"), "run.command.md");
        assert_eq!(with_safe_doc_extension("Plan.WD"), "Plan.WD");
        assert_eq!(filename_from_disposition(Some("attachment; filename=\"Q3 plan.md\"")).as_deref(), Some("Q3 plan.md"));
        assert_eq!(filename_from_disposition(Some("attachment; filename*=UTF-8''Caf%C3%A9.md")).as_deref(), Some("Café.md"));
        assert_eq!(filename_from_disposition(Some("attachment; filename=\"../../etc/x.md\"")).as_deref(), Some("x.md"));
        assert_eq!(filename_from_disposition(Some("inline")), None);
        assert_eq!(filename_from_disposition(None), None);
        let dir = Path::new("/d");
        let taken = |p: &Path| p == Path::new("/d/a.md") || p == Path::new("/d/a (2).md");
        assert_eq!(downloads_unique_path(dir, "a.md", taken), PathBuf::from("/d/a (3).md"));
        assert_eq!(downloads_unique_path(dir, "", |_| false), PathBuf::from("/d/Shared document.md"));
        assert_eq!(downloads_unique_path(dir, "x:y.sh", |_| false), PathBuf::from("/d/x_y.sh.md"));
        let all = downloads_unique_path(dir, "a.md", |p| !p.to_string_lossy().contains("(2") || p.to_string_lossy().contains("(2"));
        assert!(all.to_string_lossy().starts_with("/d/a ("));
    }

    #[test]
    fn encodes_the_token_like_encode_uri_component() {
        assert_eq!(percent_encoding_component("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(percent_encoding_component("Az09-_.!~*'()"), "Az09-_.!~*'()");
    }

    #[test]
    fn fetches_a_public_link_without_following_redirects() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for answer in [
                "HTTP/1.1 200 OK\r\nContent-Type: text/markdown\r\nContent-Disposition: attachment; filename=\"Shared.md\"\r\nContent-Length: 7\r\nConnection: close\r\n\r\n# Hello",
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n01234567890123456789",
            ] {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).into_owned());
                s.write_all(answer.as_bytes()).unwrap();
            }
            seen
        });
        let base = format!("http://127.0.0.1:{port}");
        let ok = block_on(fetch_shared_raw(&base, "tok en", true, MAX_DOC_BYTES)).unwrap().unwrap();
        assert_eq!(ok.content, "# Hello");
        assert_eq!(filename_from_disposition(ok.disposition.as_deref()).as_deref(), Some("Shared.md"));
        assert_eq!(block_on(fetch_shared_raw(&base, "t", false, MAX_DOC_BYTES)).unwrap(), Err(FetchError::Status(302)));
        assert_eq!(block_on(fetch_shared_raw(&base, "t", false, 10)).unwrap(), Err(FetchError::TooLarge));
        let seen = server.join().unwrap();
        assert!(seen[0].starts_with("GET /s/tok%20en/raw "), "{}", seen[0]);
        assert!(seen[0].to_ascii_lowercase().contains("accept: text/markdown, text/plain, */*"));
        assert!(!seen[0].to_ascii_lowercase().contains("cookie"));
        assert!(!seen[0].to_ascii_lowercase().contains("authorization"));
    }
}
