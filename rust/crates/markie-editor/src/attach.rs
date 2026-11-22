//! Dropping a file onto a document, as `src/lib/attach.ts` does it: link
//! the file where it already lives. A relative link when it sits under the
//! document's folder, an absolute path otherwise. Pictures, clips and sound
//! get the picture syntax; any other file is a link.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentKind {
    Media,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub kind: AttachmentKind,
    /// What goes into the Markdown.
    pub href: String,
    /// The alt text, or the link's words.
    pub label: String,
}

const EMBEDDABLE: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "mp4", "m4v", "webm", "ogv", "mov", "mp3", "m4a", "aac", "wav",
    "flac", "oga", "opus",
];

/// The types Markie opens as documents (attach.ts `OPENS_AS_DOCUMENT`).
const OPENS_AS_DOCUMENT: &[&str] = &["md", "markdown", "mdx", "txt", "text", "log", "csv"];

fn ext_of(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    Some(name[dot + 1..].to_ascii_lowercase())
}

pub fn opens_as_document(name: &str) -> bool {
    ext_of(name).is_some_and(|e| OPENS_AS_DOCUMENT.contains(&e.as_str()))
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/")
}

/// attach.ts `hrefFor`.
pub fn href_for(abs: &str, doc_dir: Option<&str>) -> String {
    let abs = normalize(abs);
    let Some(dir) = doc_dir else { return abs };
    let dir = normalize(dir);
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        return abs;
    }
    let windows = |s: &str| s.len() > 1 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic();
    let fold = |s: &str| if windows(&abs) || windows(dir) { s.to_lowercase() } else { s.to_string() };
    if !fold(&abs).starts_with(&format!("{}/", fold(dir))) {
        return abs;
    }
    let rest = &abs[dir.len() + 1..];
    if rest.is_empty() { abs.clone() } else { rest.to_string() }
}

/// attach.ts `attachmentFor`.
pub fn attachment_for(abs: &Path, doc_dir: Option<&Path>) -> Attachment {
    let abs_s = abs.to_string_lossy().to_string();
    let name = normalize(&abs_s).rsplit('/').next().unwrap_or(&abs_s).to_string();
    let href = href_for(&abs_s, doc_dir.map(|d| d.to_string_lossy().to_string()).as_deref());
    let embeddable = ext_of(&name).is_some_and(|e| EMBEDDABLE.contains(&e.as_str()));
    if !embeddable {
        return Attachment { kind: AttachmentKind::File, href, label: name };
    }
    let stem = match name.rfind('.') {
        Some(d) if d > 0 => name[..d].to_string(),
        _ => name.clone(),
    };
    Attachment { kind: AttachmentKind::Media, href, label: stem }
}

/// `externalWebTarget` (external-link.ts): an http(s) address with a host
/// and no user name or password, or nothing.
pub fn external_web_target(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &raw[8..]
    } else if lower.starts_with("http://") {
        &raw[7..]
    } else {
        return None;
    };
    if raw.len() > 8192 || raw.chars().any(|c| c.is_whitespace() || (c as u32) <= 0x20 || c == '\u{7f}' || c == '\\') {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority);
    if host.is_empty() {
        return None;
    }
    Some(raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hrefs_like_attach_ts() {
        assert_eq!(href_for("/docs/a/pic.png", Some("/docs/a")), "pic.png");
        assert_eq!(href_for("/docs/a/sub/pic.png", Some("/docs/a/")), "sub/pic.png");
        assert_eq!(href_for("/other/pic.png", Some("/docs/a")), "/other/pic.png");
        assert_eq!(href_for("/docs/ab/pic.png", Some("/docs/a")), "/docs/ab/pic.png");
        assert_eq!(href_for("/x/y.zip", None), "/x/y.zip");
        assert_eq!(href_for("C:\\Docs\\a.png", Some("c:/docs")), "a.png");
    }

    #[test]
    fn attachments() {
        let a = attachment_for(Path::new("/d/Holiday Photo.JPG"), Some(Path::new("/d")));
        assert_eq!(a, Attachment { kind: AttachmentKind::Media, href: "Holiday Photo.JPG".into(), label: "Holiday Photo".into() });
        let z = attachment_for(Path::new("/e/archive.zip"), Some(Path::new("/d")));
        assert_eq!(z, Attachment { kind: AttachmentKind::File, href: "/e/archive.zip".into(), label: "archive.zip".into() });
        assert!(opens_as_document("Notes.MD"));
        assert!(!opens_as_document("pic.png"));
    }

    #[test]
    fn web_targets() {
        assert!(external_web_target("https://example.com/a?b").is_some());
        assert!(external_web_target("http://x.org").is_some());
        assert!(external_web_target("https://user:pw@example.com").is_none());
        assert!(external_web_target("https://exa mple.com").is_none());
        assert!(external_web_target("ftp://example.com").is_none());
        assert!(external_web_target("https://").is_none());
    }
}
