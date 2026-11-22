//! Timestamps in the formats the Electron app writes, so files on disk stay
//! interchangeable: ISO 8601 with milliseconds, and the snapshot "stamp" form
//! with the colons swapped for dashes.

use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// `2026-11-21T10:34:12.345Z`, like JavaScript's `toISOString()`.
pub fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_iso(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// A snapshot file stem: the ISO time with `:` replaced by `-`.
pub fn stamp(ms: i64) -> String {
    iso(ms).replace(':', "-")
}

/// Reverse of [`stamp`], tolerating the `-2` collision suffix. `None` when the
/// name cannot be dated, which retention treats as "never drop".
pub fn ms_for_stamp(stamp: &str) -> Option<i64> {
    let b = stamp.as_bytes();
    if b.len() < 20 || b[13] != b'-' || b[16] != b'-' {
        return None;
    }
    let mut iso = String::with_capacity(stamp.len());
    iso.push_str(&stamp[..13]);
    iso.push(':');
    iso.push_str(&stamp[14..16]);
    iso.push(':');
    iso.push_str(&stamp[17..]);
    if let Some(ms) = parse_iso(&iso) {
        return Some(ms);
    }
    let trimmed = iso.rfind("Z-").map(|i| &iso[..=i])?;
    parse_iso(trimmed)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Node's `path.resolve`: absolute, with `.` and `..` folded away by name
/// (no symlinks are followed), so `a/b/../c.md` hashes as `a/c.md`.
pub fn resolve(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = std::path::PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `<sha256(abs path)[:8]>-<basename>`: the per-document folder name used by
/// snapshots, drafts and doc-meta in the Electron app.
pub fn slug_for(path: &std::path::Path) -> String {
    let abs = resolve(path);
    let hash = sha256_hex(abs.to_string_lossy().as_bytes());
    let base: String = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .encode_utf16()
        .take(60)
        .map(|u| char::from_u32(u as u32).unwrap_or('_'))
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' ') { c } else { '_' })
        .collect();
    let base = if base.is_empty() { "document".into() } else { base };
    format!("{}-{base}", &hash[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_round_trip() {
        let ms = 1_763_721_252_345;
        assert_eq!(iso(ms), "2025-11-21T10:34:12.345Z");
        assert_eq!(stamp(ms), "2025-11-21T10-34-12.345Z");
        assert_eq!(ms_for_stamp(&stamp(ms)), Some(ms));
        assert_eq!(ms_for_stamp("2025-11-21T10-34-12.345Z-2"), Some(ms));
        assert_eq!(ms_for_stamp("garbage"), None);
    }

    #[test]
    fn slug_matches_electron() {
        // The same input through electron/snapshots.js slugFor gives this.
        let slug = slug_for(std::path::Path::new("/Users/me/Notes/plan é.md"));
        assert_eq!(slug, "f636a5ea-plan _.md");
    }
}
