//! Chromium's localStorage on LevelDB (`components/services/storage/dom_storage`).
//!
//! Keys are `_<origin>\0<key>` and `META:<origin>` / `METAACCESS:<origin>`,
//! plus `VERSION`. A key or value starts with one byte saying how the rest is
//! encoded: 0 for UTF-16LE, 1 for Latin-1.
use crate::error::{MigrateError, Result};
use crate::leveldb::{read_dir, ReadStats};
use std::collections::BTreeMap;
use std::path::Path;

fn decode(bytes: &[u8]) -> Result<String> {
    match bytes.split_first() {
        Some((0, rest)) if rest.len().is_multiple_of(2) => {
            let units: Vec<u16> = rest.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16(&units).map_err(|_| MigrateError::Unsupported("localStorage string with a lone surrogate".into()))
        }
        Some((1, rest)) => Ok(rest.iter().map(|&b| b as char).collect()),
        _ => Err(MigrateError::Corrupt("localStorage string with an unknown encoding".into())),
    }
}

#[derive(Debug, Default)]
pub struct LocalStorage {
    /// Origin (for example `app://markie`) to its key/value pairs.
    pub origins: BTreeMap<String, BTreeMap<String, String>>,
    pub version: Option<String>,
    pub stats: ReadStats,
}

/// Reads `<copy>/Local Storage/leveldb`.
pub fn read(dir: &Path) -> Result<LocalStorage> {
    let snapshot = read_dir(dir)?;
    let mut out = LocalStorage { stats: snapshot.stats.clone(), ..Default::default() };
    for (key, value) in &snapshot.entries {
        if key.as_slice() == b"VERSION" {
            out.version = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        let Some(rest) = key.strip_prefix(b"_") else { continue };
        let Some(split) = rest.iter().position(|&b| b == 0) else {
            return Err(MigrateError::Corrupt("localStorage key without an origin separator".into()));
        };
        let origin = String::from_utf8(rest[..split].to_vec()).map_err(|_| MigrateError::Corrupt("localStorage origin is not UTF-8".into()))?;
        out.origins.entry(origin).or_default().insert(decode(&rest[split + 1..])?, decode(value)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_encodings() {
        assert_eq!(decode(b"\x01caf\xe9").unwrap(), "café");
        let mut utf16 = vec![0u8];
        for u in "🔐 秘".encode_utf16() {
            utf16.extend(u.to_le_bytes());
        }
        assert_eq!(decode(&utf16).unwrap(), "🔐 秘");
        assert!(decode(b"\x02x").is_err());
    }
}
