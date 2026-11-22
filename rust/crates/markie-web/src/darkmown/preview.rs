//! `compileDarkmownPreview` after the compiler: the srcdoc a preview frame
//! loads. Only the pinned interpreter, the host's form and appearance adapter
//! and (opted in) the link bridge may run, each named by its SHA-256 in the
//! document's own Content-Security-Policy. The scripts and their pinned hashes
//! are Electron's files, read in at build time, so they cannot drift.

use base64::Engine;
use sha2::{Digest, Sha256};

use super::links::is_darkmown_picture_base;
use super::security::{SanitizeOptions, sanitize_darkmown_body};

pub const RUNTIME_SOURCE: &str = include_str!("../../../../../src/lib/darkmown/vendor/runtime.js.txt");
pub const LOCAL_FORM_BOOTSTRAP_SOURCE: &str = include_str!("../../../../../src/lib/darkmown/local-form-bootstrap.js.txt");
pub const LINK_BRIDGE_SOURCE: &str = include_str!("../../../../../src/lib/darkmown/link-bridge.js.txt");
const RUNTIME_POLICY: &str = include_str!("../../../../../electron/darkmown-runtime-policy.json");
const LINK_BRIDGE_POLICY: &str = include_str!("../../../../../electron/darkmown-link-bridge-policy.json");

const STYLE: &str = ":root{font:16px/1.7 system-ui,sans-serif;color:light-dark(#27272a,#e4e4e7);background:light-dark(#fff,#18181b)}*{box-sizing:border-box}body{margin:0;padding:32px;overflow-wrap:anywhere}main{max-width:760px;margin:auto}h1,h2,h3{line-height:1.25;letter-spacing:-.02em}button,input,select,textarea{font:inherit;color:inherit;background:light-dark(#fafafa,#27272a);border:1px solid light-dark(#d4d4d8,#52525b);border-radius:6px;padding:6px 10px}button{cursor:pointer}button:disabled,input:disabled,select:disabled,textarea:disabled{cursor:default;opacity:.6}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #8b5cf6;outline-offset:3px}pre,blockquote{padding:12px;background:light-dark(#f4f4f5,#27272a);border-radius:6px}pre{overflow:auto}table{border-collapse:collapse}td,th{border:1px solid light-dark(#d4d4d8,#52525b);padding:6px 10px}input[type=range]{padding:0;vertical-align:middle}hr{border:0;border-top:1px solid light-dark(#d4d4d8,#52525b)}";

/// The theme message a host may send into a running frame.
pub const THEME_MESSAGE: &str = "markie:preview-theme";
/// The one message the link bridge sends.
pub const LINK_MESSAGE: &str = "markie:wd-link";

fn policy(json: &str, key: &str) -> String {
    let v = crate::json::parse(json).expect("pinned policy is JSON");
    v.get(key).and_then(|x| x.as_str()).expect("pinned hash").to_string()
}

pub fn runtime_sha256() -> String {
    policy(RUNTIME_POLICY, "runtimeSha256")
}
pub fn bootstrap_sha256() -> String {
    policy(RUNTIME_POLICY, "bootstrapSha256")
}
pub fn link_bridge_sha256() -> String {
    policy(LINK_BRIDGE_POLICY, "linkBridgeSha256")
}

/// SHA-256 of a script, as a CSP hash source writes it.
pub fn csp_hash(script: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(script.as_bytes()))
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorScheme {
    Light,
    Dark,
}

#[derive(Clone, Debug, Default)]
pub struct PreviewOptions {
    pub color_scheme: Option<ColorScheme>,
    /// Keep http(s) and mailto links and add the pinned link bridge.
    pub links: bool,
    /// A picture scope the host issued for the document's folder.
    pub picture_base: Option<String>,
}

/// What the compiler gives back (`CompiledDarkmownDocument`).
#[derive(Clone, Debug, PartialEq)]
pub struct Compiled {
    pub body_html: String,
    pub title: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Preview {
    pub src_doc: String,
    pub warnings: Vec<String>,
}

/// The frame's sandbox attribute: scripts only when something pinned must run.
pub fn frame_sandbox(trusted: bool, links: bool) -> &'static str {
    if trusted || links { "allow-scripts" } else { "" }
}

/// Builds the preview document from compiler output.
pub fn build_preview(compiled: &Compiled, trusted: bool, options: &PreviewOptions) -> Result<Preview, String> {
    let links = options.links;
    let picture_base = options.picture_base.clone().filter(|b| is_darkmown_picture_base(b));
    let clean = sanitize_darkmown_body(&compiled.body_html, trusted, &SanitizeOptions { links, picture_base: picture_base.clone() })?;
    if [RUNTIME_SOURCE, LOCAL_FORM_BOOTSTRAP_SOURCE, LINK_BRIDGE_SOURCE].iter().any(|s| s.to_ascii_lowercase().contains("</script")) {
        return Err("The bundled Darkmown runtime cannot be embedded safely".into());
    }
    let mut hashes = Vec::new();
    if links {
        hashes.push(link_bridge_sha256());
    }
    if trusted {
        hashes.push(runtime_sha256());
        hashes.push(bootstrap_sha256());
    }
    let script_src = if hashes.is_empty() { "'none'".to_string() } else { hashes.iter().map(|h| format!("'sha256-{h}'")).collect::<Vec<_>>().join(" ") };
    let csp = [
        "default-src 'none'".to_string(),
        format!("script-src {script_src}"),
        "script-src-attr 'none'".into(),
        "style-src 'unsafe-inline'".into(),
        format!("img-src {}", picture_base.as_deref().unwrap_or("'none'")),
        "media-src 'none'".into(),
        "font-src 'none'".into(),
        "connect-src 'none'".into(),
        "frame-src 'none'".into(),
        "worker-src 'none'".into(),
        "object-src 'none'".into(),
        "form-action 'none'".into(),
        "base-uri 'none'".into(),
    ]
    .join("; ");
    let seeds: String = if trusted { clean.seeds.iter().map(|s| format!("<script type=\"application/json\" data-wd-state>{s}</script>")).collect() } else { String::new() };
    let mut runtime = String::new();
    if links {
        runtime.push_str(&format!("<script>{LINK_BRIDGE_SOURCE}</script>"));
    }
    if trusted {
        runtime.push_str(&format!("<script>{RUNTIME_SOURCE}</script><script>{LOCAL_FORM_BOOTSTRAP_SOURCE}</script>"));
    }
    let scheme = if options.color_scheme == Some(ColorScheme::Dark) { "dark" } else { "light" };
    let src_doc = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{}\"><meta name=\"referrer\" content=\"no-referrer\"><title>{}</title><style>:root{{color-scheme:{scheme}}}{STYLE}</style></head><body>{}{seeds}{runtime}</body></html>",
        escape_html(&csp),
        escape_html(&compiled.title),
        clean.body_html
    );
    let mut warnings = compiled.warnings.clone();
    warnings.extend(clean.warnings);
    Ok(Preview { src_doc, warnings })
}

/// The compiler's raw HTML page to the body and title `compileDarkmown` returns.
pub fn split_compiled_html(html: &str, title: Option<&str>, warnings: Vec<String>) -> Result<Compiled, String> {
    if html.len() > super::limits::DARKMOWN_OUTPUT_LIMIT {
        return Err("This interactive preview is too large. Your source remains available to edit and save.".into());
    }
    let start = html.find("<body>\n").ok_or("Darkmown did not produce a document body.")?;
    let end = html.rfind("\n</body>").ok_or("Darkmown did not produce a document body.")?;
    if end <= start {
        return Err("Darkmown did not produce a document body.".into());
    }
    Ok(Compiled {
        body_html: html[start + 7..end].to_string(),
        title: title.filter(|t| !t.is_empty()).unwrap_or("Interactive document").to_string(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned hashes in Electron's policy files are the scripts' hashes.
    #[test]
    fn pinned_hashes_match_the_scripts() {
        assert_eq!(csp_hash(RUNTIME_SOURCE), runtime_sha256());
        assert_eq!(csp_hash(LOCAL_FORM_BOOTSTRAP_SOURCE), bootstrap_sha256());
        assert_eq!(csp_hash(LINK_BRIDGE_SOURCE), link_bridge_sha256());
    }

    #[test]
    fn sandbox_tokens() {
        assert_eq!(frame_sandbox(false, false), "");
        assert_eq!(frame_sandbox(true, false), "allow-scripts");
        assert_eq!(frame_sandbox(false, true), "allow-scripts");
    }
}
