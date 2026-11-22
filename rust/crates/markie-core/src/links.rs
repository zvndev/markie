//! What a click on a link inside a document may do. A port of
//! `electron/local-open-policy.js`, `electron/external-web.cjs` and the
//! target rules of `src/lib/local-link.ts`.
//!
//! A link is written by whoever wrote the document, and a README in a cloned
//! repository is written by a stranger. So only ordinary web addresses reach
//! the browser, and a local file opens directly only when opening it is
//! passive. Scripts, apps, installers and bundles are shown in Finder instead.

use std::path::{Path, PathBuf};

const PASSIVE_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdx", "txt", "text", "log", "csv", "tsv", "json", "yaml", "yml", "xml", "wd", "html", "htm", "pdf", "rtf", "rtfd",
    "doc", "docx", "odt", "ods", "odp", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "epub", "png", "jpg", "jpeg", "gif",
    "webp", "heic", "heif", "svg", "bmp", "tif", "tiff", "ico", "mp3", "m4a", "wav", "aac", "flac", "ogg", "opus", "aiff", "mp4", "mov",
    "m4v", "webm", "avi", "mkv",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAction {
    Open,
    Reveal,
}

/// `localOpenAction`: a plain folder opens; a folder with an extension is a
/// bundle (`.app`, `.pkg`) and is only shown.
pub fn local_open_action(path: &Path, is_directory: bool) -> OpenAction {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if is_directory {
        return if ext.is_empty() { OpenAction::Open } else { OpenAction::Reveal };
    }
    if PASSIVE_EXTENSIONS.contains(&ext.as_str()) { OpenAction::Open } else { OpenAction::Reveal }
}

/// `externalWebTarget`: http and https only, with a host, no credentials,
/// no whitespace or controls, at most 8192 characters.
pub fn external_web_target(raw: &str) -> Option<String> {
    let lower = raw.get(..8).unwrap_or(raw).to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || raw.len() > 8192 {
        return None;
    }
    if raw.chars().any(|c| (c as u32) <= 0x20 || c == '\u{7f}' || c == '\\' || c.is_whitespace()) {
        return None;
    }
    let u = url::Url::parse(raw).ok()?;
    let ok = matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()) && u.username().is_empty() && u.password().is_none();
    ok.then(|| u.to_string())
}

/// `localLinkTarget`: the href when it names a file beside the document, or
/// None for anchors, protocol-relative links and every scheme handled elsewhere.
pub fn local_link_target(href: &str) -> Option<String> {
    let raw = href.trim();
    if raw.is_empty() || raw.starts_with('#') || raw.starts_with("//") {
        return None;
    }
    const ELSEWHERE: &[&str] = &["http:", "https:", "mailto:", "markie:", "markie-rs:", "markie-asset:", "data:", "blob:", "javascript:", "file:"];
    let lower = raw.to_ascii_lowercase();
    if ELSEWHERE.iter().any(|s| lower.starts_with(s)) {
        return None;
    }
    // Any other scheme ("x-apple.systempreferences:", "vscode:") is not a file either.
    if let Some(colon) = raw.find(':') {
        let scheme = &raw[..colon];
        if !scheme.is_empty() && scheme.len() > 1 && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
            return None;
        }
    }
    Some(raw.to_string())
}

/// What a click on `href` in a document in `doc_dir` does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkClick {
    /// Hand to the system browser.
    Web(String),
    Open(PathBuf),
    /// Show in Finder; never run it.
    Reveal(PathBuf),
    /// Tell the user, with Electron's words.
    Refuse(&'static str),
    /// Not a link this rule handles (an anchor, `mailto:`, another app's scheme).
    Ignore,
}

/// The file a relative link names: query and fragment dropped, percent
/// escapes decoded, resolved against the document's folder.
pub fn candidate_path(href: &str, doc_dir: &Path) -> Option<PathBuf> {
    let path = href.split(['?', '#']).next().unwrap_or("");
    if path.is_empty() {
        return None;
    }
    let decoded = percent_decode(path)?;
    if decoded.contains('\0') {
        return None;
    }
    let p = Path::new(&decoded);
    Some(if p.is_absolute() { p.to_path_buf() } else { doc_dir.join(p) })
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The whole rule. `doc_dir` is None for an unsaved document. A local file is
/// allowed only inside the document's own folder; Electron also allows the
/// workspace folders it holds grants for.
pub fn classify_click(href: &str, doc_dir: Option<&Path>) -> LinkClick {
    if let Some(web) = external_web_target(href.trim()) {
        return LinkClick::Web(web);
    }
    let Some(local) = local_link_target(href) else { return LinkClick::Ignore };
    let Some(dir) = doc_dir else { return LinkClick::Refuse("Save this document first, then the link will work.") };
    let Some(target) = candidate_path(&local, dir) else { return LinkClick::Refuse("That link does not point at a file.") };
    let (Ok(real), Ok(root)) = (target.canonicalize(), dir.canonicalize()) else {
        return LinkClick::Refuse("That link does not point at a file.");
    };
    if !real.starts_with(&root) {
        return LinkClick::Refuse("Markie only opens files that sit beside the document or inside your workspace.");
    }
    match local_open_action(&real, real.is_dir()) {
        OpenAction::Open => LinkClick::Open(real),
        OpenAction::Reveal => LinkClick::Reveal(real),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passive_files_open_and_programs_are_shown() {
        assert_eq!(local_open_action(Path::new("a/spec.PDF"), false), OpenAction::Open);
        assert_eq!(local_open_action(Path::new("setup.command"), false), OpenAction::Reveal);
        assert_eq!(local_open_action(Path::new("run.sh"), false), OpenAction::Reveal);
        assert_eq!(local_open_action(Path::new("noext"), false), OpenAction::Reveal);
        assert_eq!(local_open_action(Path::new("Folder"), true), OpenAction::Open);
        assert_eq!(local_open_action(Path::new("Tool.app"), true), OpenAction::Reveal);
    }

    #[test]
    fn only_plain_web_addresses_reach_the_browser() {
        assert_eq!(external_web_target("https://markiedocs.com/a").as_deref(), Some("https://markiedocs.com/a"));
        assert_eq!(external_web_target("HTTP://example.com").as_deref(), Some("http://example.com/"));
        assert_eq!(external_web_target("https://u:p@example.com"), None);
        assert_eq!(external_web_target("https://exa mple.com"), None);
        assert_eq!(external_web_target("file:///etc/passwd"), None);
        assert_eq!(external_web_target("vscode://open"), None);
        assert_eq!(external_web_target(&format!("https://a.com/{}", "x".repeat(8200))), None);
    }

    #[test]
    fn local_targets() {
        assert_eq!(local_link_target(" spec.pdf ").as_deref(), Some("spec.pdf"));
        assert_eq!(local_link_target("#top"), None);
        assert_eq!(local_link_target("//cdn.example.com/x"), None);
        assert_eq!(local_link_target("markie-rs://open?token=t"), None);
        assert_eq!(local_link_target("javascript:alert(1)"), None);
        assert_eq!(local_link_target("x-apple.systempreferences:com.apple"), None);
        assert_eq!(local_link_target("../notes/plan.md").as_deref(), Some("../notes/plan.md"));
    }

    #[test]
    fn clicks_in_a_real_folder() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join("spec one.pdf"), b"%PDF").unwrap();
        std::fs::write(d.join("setup.command"), b"echo hi").unwrap();
        let real = d.canonicalize().unwrap();
        assert_eq!(classify_click("spec%20one.pdf#page=2", Some(d)), LinkClick::Open(real.join("spec one.pdf")));
        assert_eq!(classify_click("./setup.command", Some(d)), LinkClick::Reveal(real.join("setup.command")));
        assert!(matches!(classify_click("../../../etc/hosts", Some(d)), LinkClick::Refuse(_)));
        assert!(matches!(classify_click("missing.md", Some(d)), LinkClick::Refuse(_)));
        assert!(matches!(classify_click("spec.pdf", None), LinkClick::Refuse(_)));
        assert_eq!(classify_click("https://example.com", Some(d)), LinkClick::Web("https://example.com/".into()));
        assert_eq!(classify_click("mailto:a@b.c", Some(d)), LinkClick::Ignore);
    }
}
