//! Which local files an export may read, and folding pictures into the file.
//! Ports `electron/local-assets.js` (the one rule for what may be read) and
//! `electron/inline-images.js` (data: URIs for a document that travels).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 30 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

pub fn media_mime(path: &Path) -> Option<(&'static str, MediaKind)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ("image/png", MediaKind::Image),
        "jpg" | "jpeg" => ("image/jpeg", MediaKind::Image),
        "gif" => ("image/gif", MediaKind::Image),
        "webp" => ("image/webp", MediaKind::Image),
        "svg" => ("image/svg+xml", MediaKind::Image),
        "avif" => ("image/avif", MediaKind::Image),
        "bmp" => ("image/bmp", MediaKind::Image),
        "ico" => ("image/x-icon", MediaKind::Image),
        "mp4" | "m4v" => ("video/mp4", MediaKind::Video),
        "webm" => ("video/webm", MediaKind::Video),
        "ogv" => ("video/ogg", MediaKind::Video),
        "mov" => ("video/quicktime", MediaKind::Video),
        "mp3" => ("audio/mpeg", MediaKind::Audio),
        "m4a" => ("audio/mp4", MediaKind::Audio),
        "aac" => ("audio/aac", MediaKind::Audio),
        "wav" => ("audio/wav", MediaKind::Audio),
        "flac" => ("audio/flac", MediaKind::Audio),
        "oga" | "opus" => ("audio/ogg", MediaKind::Audio),
        _ => return None,
    })
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

/// `candidatePath`: the absolute path a reference names, or None for a
/// remote, schemed or empty one.
pub fn candidate_path(src: &str, doc_dir: &Path) -> Option<PathBuf> {
    let raw = src.trim();
    if raw.is_empty() || raw.starts_with("//") {
        return None;
    }
    if raw.len() > 7 && raw[..7].eq_ignore_ascii_case("file://") {
        let bare = raw.split('#').next()?.split('?').next()?;
        return url::Url::parse(bare).ok()?.to_file_path().ok();
    }
    let schemed = raw.find(':').is_some_and(|c| {
        c > 0 && raw[..c].chars().enumerate().all(|(i, ch)| if i == 0 { ch.is_ascii_alphabetic() } else { ch.is_ascii_alphanumeric() || "+.-".contains(ch) })
    });
    if schemed {
        return None;
    }
    let bare = raw.split('#').next()?.split('?').next()?;
    if bare.is_empty() {
        return None;
    }
    // A stray % is not a reason to drop the image.
    let rel = percent_decode(bare).unwrap_or_else(|| bare.to_string());
    Some(normalize(&doc_dir.join(rel)))
}

/// `path.resolve` without touching the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn contained_in(dir: &Path, file: &Path) -> bool {
    file != dir && file.starts_with(dir)
}

/// Where an export may read from, besides the document's own folder.
#[derive(Clone, Debug, Default)]
pub struct Grants {
    pub roots: Vec<PathBuf>,
    pub files: Vec<PathBuf>,
}

/// `allowedRealPath`: the real path to read, when it is inside the document's
/// folder or a granted root, or is a granted file.
pub fn allowed_real_path(abs: &Path, doc_dir: &Path, grants: &Grants) -> Option<PathBuf> {
    let real = std::fs::canonicalize(abs).ok()?;
    if grants.files.iter().any(|f| std::fs::canonicalize(f).ok().as_deref() == Some(real.as_path())) {
        return Some(real);
    }
    let bounds = std::iter::once(doc_dir).chain(grants.roots.iter().map(PathBuf::as_path)).filter_map(|d| std::fs::canonicalize(d).ok());
    for bound in bounds {
        if contained_in(&bound, &real) {
            return Some(real);
        }
    }
    None
}

/// `resolveMedia`: a reference to a file that may be shown or played.
pub fn resolve_media(src: &str, doc_dir: &Path, grants: &Grants) -> Option<(PathBuf, &'static str, MediaKind)> {
    let abs = candidate_path(src, doc_dir)?;
    media_mime(&abs)?;
    let real = allowed_real_path(&abs, doc_dir, grants)?;
    let (mime, kind) = media_mime(&real)?;
    Some((real, mime, kind))
}

pub fn resolve_image(src: &str, doc_dir: &Path, grants: &Grants) -> Option<(PathBuf, &'static str)> {
    match resolve_media(src, doc_dir, grants)? {
        (path, mime, MediaKind::Image) => Some((path, mime)),
        _ => None,
    }
}

/// `inlineLocalImages`: every quoted local `<img src>` that may be read and
/// fits the size budget becomes a data: URI. Everything else stays as written.
pub fn inline_local_images(html: &str, doc_dir: Option<&Path>, grants: &Grants) -> String {
    let Some(doc_dir) = doc_dir else { return html.to_string() };
    if !html.contains("<img") {
        return html.to_string();
    }
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    let mut total = 0usize;
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = find_img(rest) {
        out.push_str(&rest[..at]);
        let tag_end = rest[at..].find('>').map(|e| at + e + 1).unwrap_or(rest.len());
        let tag = &rest[at..tag_end];
        out.push_str(&rewrite_tag(tag, doc_dir, grants, &mut cache, &mut total));
        rest = &rest[tag_end..];
    }
    out.push_str(rest);
    out
}

/// `/<img\b[^>]*>/gi`
fn find_img(s: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<img") {
        let at = from + i;
        let next = lower[at + 4..].chars().next();
        if next.is_none_or(|c| !(c.is_alphanumeric() || c == '_')) {
            return Some(at);
        }
        from = at + 4;
    }
    None
}

/// `/(\ssrc\s*=\s*)(["'])([^"']*)\2/i` on one tag.
fn rewrite_tag(tag: &str, doc_dir: &Path, grants: &Grants, cache: &mut HashMap<String, Option<String>>, total: &mut usize) -> String {
    let lower = tag.to_ascii_lowercase();
    let mut search = 0;
    while let Some(i) = lower[search..].find("src") {
        let at = search + i;
        search = at + 3;
        if at == 0 || !lower.as_bytes()[at - 1].is_ascii_whitespace() {
            continue;
        }
        let mut j = at + 3;
        let b = tag.as_bytes();
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= b.len() || b[j] != b'=' {
            continue;
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= b.len() || (b[j] != b'"' && b[j] != b'\'') {
            continue;
        }
        let quote = b[j];
        let start = j + 1;
        let Some(len) = tag[start..].find(|c: char| c == '"' || c == '\'') else { return tag.to_string() };
        if tag.as_bytes()[start + len] != quote {
            continue;
        }
        let src = &tag[start..start + len];
        let uri = cache.entry(src.to_string()).or_insert_with(|| data_uri(src, doc_dir, grants, total)).clone();
        return match uri {
            Some(uri) => format!("{}{}{}", &tag[..start], uri, &tag[start + len..]),
            None => tag.to_string(),
        };
    }
    tag.to_string()
}

fn data_uri(src: &str, doc_dir: &Path, grants: &Grants, total: &mut usize) -> Option<String> {
    let (path, mime) = resolve_image(src, doc_dir, grants)?;
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > MAX_IMAGE_BYTES || *total + bytes.len() > MAX_TOTAL_BYTES {
        return None;
    }
    *total += bytes.len();
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_what_local_assets_refuses() {
        let dir = Path::new("/docs");
        assert!(candidate_path("https://x/a.png", dir).is_none());
        assert!(candidate_path("//x/a.png", dir).is_none());
        assert!(candidate_path("data:image/png;base64,xx", dir).is_none());
        assert_eq!(candidate_path("a%20b.png?x#y", dir).unwrap(), PathBuf::from("/docs/a b.png"));
        assert_eq!(candidate_path("../up.png", dir).unwrap(), PathBuf::from("/up.png"));
    }

    #[test]
    fn inlines_inside_the_folder_only() {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        std::fs::write(docs.join("a.png"), b"png").unwrap();
        std::fs::write(dir.path().join("secret.png"), b"no").unwrap();
        let html = r#"<p><img src="a.png" alt="x"><img src="../secret.png"><img alt='y' src='a.png'></p>"#;
        let out = inline_local_images(html, Some(&docs), &Grants::default());
        assert_eq!(out, r#"<p><img src="data:image/png;base64,cG5n" alt="x"><img src="../secret.png"><img alt='y' src='data:image/png;base64,cG5n'></p>"#);
    }
}
