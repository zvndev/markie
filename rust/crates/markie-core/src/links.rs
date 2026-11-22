//! What a click on a link inside a document may do. A port of
//! `electron/local-open-policy.js`, `electron/external-web.cjs` and the
//! target rules of `src/lib/local-link.ts`.
//!
//! A link is written by whoever wrote the document, and a README in a cloned
//! repository is written by a stranger. So only ordinary web addresses reach
//! the browser, and a local file opens directly only when opening it is
//! passive. Scripts, apps, installers and bundles are shown in Finder instead.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

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
    // A literal percent in a filename is not a broken URL in Electron.
    let decoded = percent_decode(path).unwrap_or_else(|| path.to_string());
    if decoded.contains('\0') {
        return None;
    }
    let p = Path::new(&decoded);
    absolute_lexical(&doc_dir.join(p)).ok()
}

fn absolute_lexical(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut resolved = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => { resolved.pop(); }
            Component::CurDir => {}
            _ => resolved.push(part),
        }
    }
    Ok(resolved)
}

/// Session grants. Opening a legacy text document grants its directory for
/// assets, whereas an attachment grants only its exact location. An href
/// never grants anything, including the folder used to resolve it.
#[derive(Clone, Default)]
pub struct FileGrants {
    opened: HashSet<PathBuf>,
    attached: HashSet<PathBuf>,
}

impl FileGrants {
    pub fn grant_document(&mut self, path: &Path) {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        if !name.rsplit_once('.').is_some_and(|(_, ext)| {
            matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx" | "txt" | "text" | "log" | "csv")
        }) {
            return;
        }
        if let Ok(real) = path.canonicalize() {
            self.opened.insert(real);
        }
    }

    pub fn grant_attachment(&mut self, path: &Path) {
        if let Ok(real) = path.canonicalize() {
            self.attached.insert(real);
        }
    }

    pub fn move_document(&mut self, old: &Path, new: &Path) {
        let before = old.canonicalize().ok().or_else(|| {
            Some(old.parent()?.canonicalize().ok()?.join(old.file_name()?))
        });
        if before.is_some_and(|path| self.opened.remove(&path)) {
            self.grant_document(new);
        }
    }

    pub fn asset_path(&self, target: &Path, workspace_roots: &[PathBuf]) -> Option<PathBuf> {
        let real = target.canonicalize().ok()?;
        let exact = self.opened.iter().chain(&self.attached)
            .any(|grant| grant.canonicalize().is_ok_and(|p| p == real));
        let root = self.opened.iter().filter_map(|p| p.parent()).chain(workspace_roots.iter().map(PathBuf::as_path))
            .filter_map(|p| p.canonicalize().ok())
            .any(|p| p != real && real.starts_with(p));
        (exact || root).then_some(real)
    }

    pub fn classify(&self, href: &str, doc_dir: Option<&Path>, roots: &[PathBuf]) -> LinkClick {
        if let Some(web) = external_web_target(href.trim()) {
            return LinkClick::Web(web);
        }
        let Some(local) = local_link_target(href) else { return LinkClick::Ignore };
        let Some(dir) = doc_dir else { return LinkClick::Refuse("Save this document first, then the link will work.") };
        let Some(target) = candidate_path(&local, dir) else { return LinkClick::Refuse("That link does not point at a file.") };
        let Some(real) = self.asset_path(&target, roots) else {
            return LinkClick::Refuse("Markie only opens files that sit beside the document or inside your workspace.");
        };
        match local_open_action(&real, real.is_dir()) {
            OpenAction::Open => LinkClick::Open(real),
            OpenAction::Reveal => LinkClick::Reveal(real),
        }
    }
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

/// The local policy with only the document's folder granted.
pub fn classify_click(href: &str, doc_dir: Option<&Path>) -> LinkClick {
    classify_click_with_roots(href, doc_dir, &[])
}

/// The document's folder and explicit workspace roots are the only directory
/// grants. Check resolved targets, not the link's lexical spelling.
pub fn classify_click_with_roots(href: &str, doc_dir: Option<&Path>, workspace_roots: &[PathBuf]) -> LinkClick {
    if let Some(web) = external_web_target(href.trim()) {
        return LinkClick::Web(web);
    }
    let Some(local) = local_link_target(href) else { return LinkClick::Ignore };
    let Some(dir) = doc_dir else { return LinkClick::Refuse("Save this document first, then the link will work.") };
    let Some(target) = candidate_path(&local, dir) else { return LinkClick::Refuse("That link does not point at a file.") };
    let (Ok(real), Ok(root)) = (target.canonicalize(), dir.canonicalize()) else {
        return LinkClick::Refuse("That link does not point at a file.");
    };
    if !real.starts_with(&root)
        && !workspace_roots.iter().filter_map(|p| p.canonicalize().ok()).any(|p| real.starts_with(p))
    {
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
    fn attachment_grants_are_exact_and_opened_document_grants_follow_moves() {
        let temp = tempfile::tempdir().unwrap();
        let make = |dir: &str| {
            let path = temp.path().join(dir);
            std::fs::create_dir(&path).unwrap();
            path.canonicalize().unwrap()
        };
        let current = make("current");
        let former = make("former");
        let attachments = make("attachments");
        let workspace = make("workspace");
        let put = |dir: &Path, name: &str| {
            let path = dir.join(name);
            std::fs::write(&path, []).unwrap();
            path
        };
        let doc = put(&former, "first.md");
        let neighbor = put(&former, "neighbor.pdf");
        let report = put(&attachments, "100%.pdf");
        let other = put(&attachments, "other.pdf");
        let command = put(&workspace, "setup.command");
        let mut grants = FileGrants::default();
        grants.grant_document(&doc);
        grants.grant_attachment(&report);
        let roots = vec![workspace.clone()];
        assert_eq!(grants.classify("../former/neighbor.pdf", Some(&current), &roots), LinkClick::Open(neighbor.clone()));
        assert_eq!(grants.classify("../attachments/100%.pdf", Some(&current), &roots), LinkClick::Open(report));
        assert_eq!(grants.classify("../workspace/setup.command", Some(&current), &roots), LinkClick::Reveal(command));
        assert!(grants.asset_path(&other, &roots).is_none());
        assert!(grants.asset_path(&workspace, &roots).is_none());
        let new = current.join("first.md");
        std::fs::rename(&doc, &new).unwrap();
        grants.move_document(&doc, &new);
        assert!(grants.asset_path(&neighbor, &roots).is_none());
        assert_eq!(grants.asset_path(&new, &roots), Some(new));
    }

    #[test]
    fn workspace_roots_grant_passive_files_and_never_turn_scripts_into_opens() {
        let temp = tempfile::tempdir().unwrap();
        let notes = temp.path().join("notes");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&notes).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let report = workspace.join("100%.pdf");
        let setup = workspace.join("setup.command");
        std::fs::write(&report, []).unwrap();
        std::fs::write(&setup, []).unwrap();
        let roots = &[workspace];
        let classify = |href| classify_click_with_roots(href, Some(&notes), roots);
        assert!(matches!(classify_click("../workspace/100%.pdf", Some(&notes)), LinkClick::Refuse(_)));
        assert_eq!(classify("../workspace/100%.pdf"), LinkClick::Open(report.canonicalize().unwrap()));
        assert_eq!(classify("../workspace/setup.command"), LinkClick::Reveal(setup.canonicalize().unwrap()));
        #[cfg(unix)]
        {
            let outside = temp.path().join("outside.pdf");
            std::fs::write(&outside, []).unwrap();
            std::os::unix::fs::symlink(outside, roots[0].join("escape.pdf")).unwrap();
            assert!(matches!(classify("../workspace/escape.pdf"), LinkClick::Refuse(_)));
        }
    }

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
