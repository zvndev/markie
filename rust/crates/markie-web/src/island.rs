//! Web islands: system web views (WKWebView on macOS) hosted inside a
//! Markie RS window through `wry`, each locked down to what Electron allows
//! the same content.
//!
//! - [`DarkmownFrame`]: a host page holding one sandboxed `srcdoc` iframe,
//!   exactly the frame Electron's editor renders (`sandbox` of
//!   `allow-scripts` or nothing, opaque origin, no navigation, no popups).
//!   The host page runs one pinned script that believes a link message only
//!   from that frame, with a user activation, in the bridge's exact shape,
//!   and Rust checks the URL again before the browser sees it.
//! - [`Compiler`]: a hidden, disposable web view that runs Darkmown's pinned
//!   compiler once and is destroyed, the counterpart of Electron's worker.
//! - [`SitePreview`]: a Live Docs dev server's pages, allowed to navigate only
//!   inside the server's origin; web links go to the browser.
//! - [`VideoPlayer`]: a YouTube or Vimeo player for a video card.
//!
//! Every island is non-persistent (no cookies or storage survive), has no
//! devtools, no clipboard access, no autoplay unless asked, and refuses new
//! windows.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use raw_window_handle::HasWindowHandle;
use wry::http::{Request, Response};
use wry::{NewWindowResponse, Rect, WebView, WebViewBuilder, dpi};

use crate::darkmown::links::{darkmown_link_target, relative_ref};
use crate::darkmown::preview::{self, csp_hash};
use crate::json::{self, Json};
use crate::live_docs::runner::{Navigation, external_web_target, navigation_decision};

/// A rectangle in window points, from the window's top-left.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn rect(b: Bounds) -> Rect {
    Rect { position: dpi::LogicalPosition::new(b.x, b.y).into(), size: dpi::LogicalSize::new(b.width.max(0.0), b.height.max(0.0)).into() }
}

pub type Error = wry::Error;

/// Opens a URL the island decided may leave the app, in the user's browser.
fn open_external(url: &str) {
    let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
}

// ── Darkmown preview frame ─────────────────────────────────────────────

/// The host page's only script. Kept free of document data: everything
/// arrives through `markieSetPreview` from Rust.
const DARKMOWN_HOST_JS: &str = r#"(() => {
  "use strict";
  let frame = null;
  window.markieSetPreview = (srcDoc, sandbox, scheme) => {
    if (frame) frame.remove();
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", sandbox);
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "Darkmown document preview");
    frame.style.colorScheme = scheme;
    frame.addEventListener("load", () => window.markieTheme(scheme));
    frame.srcdoc = srcDoc;
    document.body.appendChild(frame);
  };
  window.markieClearPreview = () => { if (frame) frame.remove(); frame = null; };
  window.markieTheme = (theme) => {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "markie:preview-theme", theme: theme === "dark" ? "dark" : "light" }, "*");
  };
  window.addEventListener("message", (event) => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== "null") return;
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const keys = Object.keys(data);
    if (keys.length !== 2 || !keys.includes("type") || !keys.includes("href")) return;
    if (data.type !== "markie:wd-link" || typeof data.href !== "string") return;
    if (!(navigator.userActivation && navigator.userActivation.isActive)) return;
    window.ipc.postMessage(JSON.stringify({ link: data.href }));
  });
})();"#;

/// What the Darkmown frame reports.
#[derive(Clone, Debug, PartialEq)]
pub enum FrameEvent {
    /// A link a person clicked in the preview, already checked; opened in the browser.
    LinkOpened(String),
}

/// Picture scopes: one random `markie-asset://wd-<hex>` host per document folder.
#[derive(Clone, Default)]
pub struct PictureScopes(Arc<Mutex<HashMap<String, PathBuf>>>);

impl PictureScopes {
    /// The scope for `doc_dir`, made once and reused.
    pub fn scope_for(&self, doc_dir: &std::path::Path) -> Option<String> {
        let real = std::fs::canonicalize(doc_dir).ok().filter(|p| p.is_dir())?;
        let mut map = self.0.lock().ok()?;
        if let Some((host, _)) = map.iter().find(|(_, d)| **d == real) {
            return Some(format!("markie-asset://{host}"));
        }
        let mut b = [0u8; 16];
        std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom").ok()?, &mut b).ok()?;
        let host = format!("wd-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>());
        map.insert(host.clone(), real);
        while map.len() > 64 {
            let first = map.keys().next().cloned()?;
            map.remove(&first);
        }
        Some(format!("markie-asset://{host}"))
    }

    /// The picture for a request on a scope host, by the same rules main uses.
    fn resolve(&self, host: &str, path: &str) -> Option<(Vec<u8>, &'static str)> {
        let dir = self.0.lock().ok()?.get(host).cloned()?;
        let raw = crate::darkmown::links::encode_uri_component("");
        let _ = raw;
        let decoded = percent_decode(path.strip_prefix('/')?)?;
        let reference = relative_ref(&decoded)?;
        let (file, mime) = markie_export::assets::resolve_image(reference, &dir, &Default::default())?;
        Some((std::fs::read(file).ok()?, mime))
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    Response::builder().status(404).body(Cow::Borrowed(&[][..])).unwrap()
}

pub struct DarkmownFrame {
    webview: WebView,
}

impl DarkmownFrame {
    /// Builds the frame host inside `window`. `on_event` runs on the main thread.
    pub fn new<W: HasWindowHandle>(window: &W, bounds: Bounds, scopes: PictureScopes, on_event: impl Fn(FrameEvent) + 'static) -> Result<Self, Error> {
        // The host page's CSP must allow what the frame runs: a srcdoc frame
        // inherits its parent's policy on top of its own.
        let hashes = [csp_hash(DARKMOWN_HOST_JS), preview::runtime_sha256(), preview::bootstrap_sha256(), preview::link_bridge_sha256()];
        let script_src = hashes.iter().map(|h| format!("'sha256-{h}'")).collect::<Vec<_>>().join(" ");
        let csp = format!("default-src 'none'; script-src {script_src}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src markie-asset:; connect-src 'none'; form-action 'none'; base-uri 'none'");
        let html = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\"><style>html,body{{margin:0;height:100%;background:transparent;overflow:hidden}}iframe{{border:0;width:100%;height:100%;display:block}}</style></head><body><script>{DARKMOWN_HOST_JS}</script></body></html>"
        );
        let last_link = Rc::new(RefCell::new(std::time::Instant::now() - Duration::from_secs(10)));
        let webview = WebViewBuilder::new()
            .with_html(html)
            .with_bounds(rect(bounds))
            .with_incognito(true)
            .with_devtools(false)
            .with_clipboard(false)
            .with_autoplay(false)
            .with_hotkeys_zoom(false)
            .with_back_forward_navigation_gestures(false)
            .with_transparent(true)
            // A preview only ever replaces itself with new srcdoc.
            .with_navigation_handler(|url| url == "about:blank" || url == "about:srcdoc" || url.starts_with("about:srcdoc") || url.starts_with("data:"))
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_custom_protocol("markie-asset".into(), move |_, request: Request<Vec<u8>>| {
                let uri = request.uri();
                let host = uri.host().unwrap_or("");
                match scopes.resolve(host, uri.path()) {
                    Some((bytes, mime)) => Response::builder().header("Content-Type", mime).header("Cache-Control", "no-store").body(Cow::Owned(bytes)).unwrap(),
                    None => not_found(),
                }
            })
            .with_ipc_handler(move |request: Request<String>| {
                let Some(msg) = json::parse(request.body()) else { return };
                let Some(href) = msg.get("link").and_then(Json::as_str) else { return };
                // One link per click (createLinkGate), and main's own check of the URL.
                let mut last = last_link.borrow_mut();
                if last.elapsed() < Duration::from_millis(400) {
                    return;
                }
                if let Some(target) = darkmown_link_target(href) {
                    *last = std::time::Instant::now();
                    open_external(&target);
                    on_event(FrameEvent::LinkOpened(target));
                }
            })
            .build_as_child(window)?;
        Ok(Self { webview })
    }

    /// Shows a built preview document. `sandbox` is `allow-scripts` or empty.
    pub fn set_preview(&self, src_doc: &str, sandbox: &str, dark: bool) -> Result<(), Error> {
        let script = format!(
            "window.markieSetPreview({}, {}, {})",
            json::stringify(&Json::Str(src_doc.to_string())),
            json::stringify(&Json::Str(sandbox.to_string())),
            json::stringify(&Json::Str(if dark { "dark" } else { "light" }.into()))
        );
        self.webview.evaluate_script(&script)
    }

    pub fn clear(&self) -> Result<(), Error> {
        self.webview.evaluate_script("window.markieClearPreview()")
    }

    /// The one-way appearance message into a running frame.
    pub fn project_theme(&self, dark: bool) -> Result<(), Error> {
        self.webview.evaluate_script(if dark { "window.markieTheme(\"dark\")" } else { "window.markieTheme(\"light\")" })
    }

    pub fn set_bounds(&self, bounds: Bounds) -> Result<(), Error> {
        self.webview.set_bounds(rect(bounds))
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), Error> {
        self.webview.set_visible(visible)
    }
}

// ── The Darkmown compiler ───────────────────────────────────────────────

const COMPILER_SOURCE: &str = include_str!("../../../../src/lib/darkmown/vendor/compiler-browser.mjs");

/// The pinned compiler as a classic script that leaves `compileFromMemory` on
/// the page, plus the driver that calls it once and posts the result.
fn compiler_scripts() -> Option<(String, String)> {
    let at = COMPILER_SOURCE.rfind("export{")?;
    let tail = &COMPILER_SOURCE[at..];
    let name = tail.strip_prefix("export{")?.split(" as compileFromMemory").next()?.trim().to_string();
    let compiler = format!("{}window.__markieCompileFromMemory={name};", &COMPILER_SOURCE[..at]);
    let driver = r#"window.markieCompile = (id, source) => {
  try {
    const entry = "site/pages/document.wd";
    const c = window.__markieCompileFromMemory({ [entry]: source }, entry, { cwd: "/" });
    window.ipc.postMessage(JSON.stringify({ id, ok: true, html: c.html, title: String(c.meta.title || "Interactive document"), warnings: [...c.warnings].map(String) }));
  } catch (error) {
    window.ipc.postMessage(JSON.stringify({ id, ok: false, error: String((error && error.message) || error).slice(0, 4096) }));
  }
};"#
        .to_string();
    Some((compiler, driver))
}

pub struct CompileOutput {
    pub compiled: Result<preview::Compiled, String>,
}

/// A disposable compiler web view: built for one compile, then dropped.
pub struct Compiler {
    webview: WebView,
    pub result: Rc<RefCell<Option<Result<preview::Compiled, String>>>>,
}

impl Compiler {
    /// Starts compiling `source`. Poll [`Compiler::result`]; drop the compiler
    /// after 10 s without one (the same budget as Electron's worker).
    pub fn start<W: HasWindowHandle>(window: &W, source: &str) -> Result<Self, String> {
        crate::darkmown::limits::validate_preview_source(source)?;
        let (compiler, driver) = compiler_scripts().ok_or("The bundled Darkmown compiler is not the expected build.")?;
        if compiler.to_ascii_lowercase().contains("</script") || driver.contains("</script") {
            return Err("The bundled Darkmown compiler cannot be embedded safely".into());
        }
        let csp = format!(
            "default-src 'none'; script-src 'sha256-{}' 'sha256-{}' 'sha256-{}'; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'",
            csp_hash(&compiler),
            csp_hash(&driver),
            csp_hash(&kick(source))
        );
        let html = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\"></head><body><script>{compiler}</script><script>{driver}</script><script>{}</script></body></html>",
            kick(source)
        );
        let result = Rc::new(RefCell::new(None));
        let slot = result.clone();
        let webview = WebViewBuilder::new()
            .with_html(html)
            .with_bounds(rect(Bounds { x: 0.0, y: 0.0, width: 1.0, height: 1.0 }))
            .with_visible(false)
            .with_incognito(true)
            .with_devtools(false)
            .with_clipboard(false)
            .with_navigation_handler(|url| url == "about:blank")
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_ipc_handler(move |request: Request<String>| {
                let body = request.body();
                if body.len() > 4_000_000 {
                    *slot.borrow_mut() = Some(Err("The local preview compiler returned an invalid result.".into()));
                    return;
                }
                *slot.borrow_mut() = Some(parse_compile_reply(body));
            })
            .build_as_child(window)
            .map_err(|_| "A local preview worker is unavailable. Your source remains available to edit and save.".to_string())?;
        Ok(Self { webview, result })
    }

    pub fn take(&self) -> Option<Result<preview::Compiled, String>> {
        let _ = &self.webview;
        self.result.borrow_mut().take()
    }
}

/// The script that calls the driver with this source.
fn kick(source: &str) -> String {
    format!("window.markieCompile(1, {});", json::stringify(&Json::Str(source.to_string())).replace("</", "<\\/"))
}

/// The compiler's reply, validated as `compiler-worker-client.ts` validates it.
pub fn parse_compile_reply(body: &str) -> Result<preview::Compiled, String> {
    let invalid = || "The local preview compiler returned an invalid result.".to_string();
    let v = json::parse(body).ok_or_else(invalid)?;
    match v.get("ok") {
        Some(Json::Bool(true)) => {
            let html = v.get("html").and_then(Json::as_str).ok_or_else(invalid)?;
            let title = v.get("title").and_then(Json::as_str).ok_or_else(invalid)?;
            let warnings: Vec<String> = v.get("warnings").and_then(Json::as_arr).ok_or_else(invalid)?.iter().filter_map(|w| w.as_str().map(str::to_string)).collect();
            if json::js_len(title) > 128_000 || warnings.len() > 5_000 {
                return Err(invalid());
            }
            preview::split_compiled_html(html, Some(title), warnings)
        }
        Some(Json::Bool(false)) => Err(v.get("error").and_then(Json::as_str).filter(|e| e.len() <= 4096).map(str::to_string).ok_or_else(invalid)?),
        _ => Err(invalid()),
    }
}

// ── Live Docs site preview ──────────────────────────────────────────────

pub struct SitePreview {
    webview: WebView,
    pub origin: String,
}

impl SitePreview {
    pub fn new<W: HasWindowHandle>(window: &W, bounds: Bounds, origin: &str) -> Result<Self, Error> {
        let nav_origin = origin.to_string();
        let new_window_origin = origin.to_string();
        let webview = WebViewBuilder::new()
            .with_url(format!("{origin}/"))
            .with_bounds(rect(bounds))
            .with_incognito(true)
            .with_devtools(false)
            .with_clipboard(false)
            .with_autoplay(false)
            .with_navigation_handler(move |url| match navigation_decision(&url, &nav_origin) {
                Navigation::Allow => true,
                Navigation::External => {
                    if let Some(t) = external_web_target(&url) {
                        open_external(&t);
                    }
                    false
                }
                Navigation::Block => url == "about:blank",
            })
            .with_new_window_req_handler(move |url, _| {
                if navigation_decision(&url, &new_window_origin) == Navigation::External
                    && let Some(t) = external_web_target(&url)
                {
                    open_external(&t);
                }
                NewWindowResponse::Deny
            })
            .with_download_started_handler(|_, _| false)
            .build_as_child(window)?;
        Ok(Self { webview, origin: origin.to_string() })
    }

    pub fn reload(&self) -> Result<(), Error> {
        self.webview.load_url(&format!("{}/", self.origin))
    }

    pub fn set_bounds(&self, bounds: Bounds) -> Result<(), Error> {
        self.webview.set_bounds(rect(bounds))
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), Error> {
        self.webview.set_visible(visible)
    }
}

// ── Video player ────────────────────────────────────────────────────────

pub struct VideoPlayer {
    webview: WebView,
}

impl VideoPlayer {
    /// Plays a YouTube or Vimeo embed in place. Only the provider's player
    /// origin may load in the frame; links out of it open in the browser.
    pub fn new<W: HasWindowHandle>(window: &W, bounds: Bounds, embed: &markie_export::embeds::Embed) -> Result<Self, Error> {
        let frame = embed.frame_url();
        let origin = embed.frame_origin().to_string();
        let html = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; frame-src {origin}; style-src 'unsafe-inline'\"><meta name=\"referrer\" content=\"strict-origin-when-cross-origin\"><style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}iframe{{border:0;width:100%;height:100%;display:block}}</style></head><body><iframe src=\"{}\" title=\"{} video\" allow=\"autoplay; encrypted-media; picture-in-picture; fullscreen\" allowfullscreen referrerpolicy=\"strict-origin-when-cross-origin\"></iframe></body></html>",
            markie_export::hast::escape_attr(&frame),
            embed.label()
        );
        let webview = WebViewBuilder::new()
            .with_html(html)
            .with_bounds(rect(bounds))
            .with_incognito(true)
            .with_devtools(false)
            .with_clipboard(false)
            .with_autoplay(true)
            .with_navigation_handler(move |url| {
                if url == "about:blank" || url.starts_with(&origin) {
                    return true;
                }
                // The player's own links (the title, "Watch on YouTube").
                if let Some(t) = external_web_target(&url) {
                    open_external(&t);
                }
                false
            })
            .with_new_window_req_handler(|url, _| {
                if let Some(t) = external_web_target(&url) {
                    open_external(&t);
                }
                NewWindowResponse::Deny
            })
            .build_as_child(window)?;
        Ok(Self { webview })
    }

    pub fn set_bounds(&self, bounds: Bounds) -> Result<(), Error> {
        self.webview.set_bounds(rect(bounds))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiler_script_exposes_the_pinned_entry() {
        let (compiler, driver) = compiler_scripts().unwrap();
        assert!(compiler.ends_with("window.__markieCompileFromMemory=wb;"), "{}", &compiler[compiler.len() - 80..]);
        assert!(!compiler.contains("export{"));
        assert!(driver.contains("window.ipc.postMessage"));
    }

    #[test]
    fn compile_replies_are_validated() {
        let ok = r#"{"id":1,"ok":true,"html":"<html><body>\n<p>x</p>\n</body></html>","title":"T","warnings":[]}"#;
        let c = parse_compile_reply(ok).unwrap();
        assert_eq!((c.body_html.as_str(), c.title.as_str()), ("<p>x</p>", "T"));
        assert_eq!(parse_compile_reply(r#"{"ok":false,"error":"[WD201] Malformed :state"}"#).unwrap_err(), "[WD201] Malformed :state");
        assert!(parse_compile_reply("nope").is_err());
    }
}
