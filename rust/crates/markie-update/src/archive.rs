//! A look at a ZIP's table of contents before anything unpacks it.
//!
//! The download already matches the feed's SHA-512, and the bundle inside is
//! signature-checked after unpacking. This check sits between the two so that
//! unpacking itself cannot write outside the folder it was given: every entry
//! must sit inside `Markie Nightly.app/`, and nothing may be written through a
//! symlink. Only the central directory is read; no entry is decompressed.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};

/// More files than any real bundle has, far fewer than a ZIP can claim.
pub const MAX_ENTRIES: usize = 50_000;
/// The most the archive may unpack to: four times the download cap.
pub const MAX_EXPANDED_BYTES: u64 = 4 * crate::feed::MAX_ARTIFACT_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ArchiveError {
    #[error("the download is not a ZIP archive this app can read")]
    Format,
    #[error("the download has too many files or unpacks too large")]
    Bounds,
    #[error("the download holds a file outside {}", crate::BUNDLE_NAME)]
    Escape,
    #[error("the download holds an encrypted or repeated entry")]
    Entry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contents {
    pub entries: usize,
    pub expanded_bytes: u64,
    pub symlinks: usize,
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Whether a name stays inside the bundle: `Markie Nightly.app/…`, no empty,
/// `.` or `..` parts, no backslash, no control character.
fn inside_bundle(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(crate::BUNDLE_NAME).and_then(|r| r.strip_prefix('/')) else { return false };
    if name.chars().any(|c| c == '\\' || c.is_control()) {
        return false;
    }
    // A directory entry ends in one slash.
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    rest.is_empty() || rest.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Check the archive's central directory. `reader` is the whole file.
pub fn inspect<R: Read + Seek>(reader: &mut R) -> Result<Contents, ArchiveError> {
    let length = reader.seek(SeekFrom::End(0)).map_err(|_| ArchiveError::Format)?;
    // The end record is 22 bytes plus a comment of at most 65,535.
    let tail_length = length.min(22 + 65_535);
    if tail_length < 22 {
        return Err(ArchiveError::Format);
    }
    let mut tail = vec![0u8; tail_length as usize];
    reader.seek(SeekFrom::Start(length - tail_length)).map_err(|_| ArchiveError::Format)?;
    reader.read_exact(&mut tail).map_err(|_| ArchiveError::Format)?;
    let end = (0..=tail.len() - 22)
        .rev()
        .find(|&at| tail[at..at + 4] == [0x50, 0x4b, 0x05, 0x06] && u16_at(&tail, at + 20).is_some_and(|comment| at + 22 + comment as usize == tail.len()))
        .ok_or(ArchiveError::Format)?;
    let field16 = |at| u16_at(&tail, end + at).ok_or(ArchiveError::Format);
    let field32 = |at| u32_at(&tail, end + at).ok_or(ArchiveError::Format);
    let (disk, directory_disk, here, total) = (field16(4)?, field16(6)?, field16(8)?, field16(10)?);
    let (size, offset) = (field32(12)?, field32(16)?);
    // One disk, and no ZIP64: a download capped at 512 MiB never needs it, and
    // an archive that claims to is not one the release script wrote.
    if disk != 0 || directory_disk != 0 || here != total || total == u16::MAX || size == u32::MAX || offset == u32::MAX {
        return Err(ArchiveError::Format);
    }
    if total == 0 || total as usize > MAX_ENTRIES {
        return Err(ArchiveError::Bounds);
    }
    if u64::from(offset) + u64::from(size) > length - tail_length + end as u64 {
        return Err(ArchiveError::Format);
    }
    let mut directory = vec![0u8; size as usize];
    reader.seek(SeekFrom::Start(u64::from(offset))).map_err(|_| ArchiveError::Format)?;
    reader.read_exact(&mut directory).map_err(|_| ArchiveError::Format)?;

    let mut names: HashSet<String> = HashSet::new();
    let mut symlinks: Vec<String> = Vec::new();
    let mut expanded: u64 = 0;
    let mut at = 0usize;
    for _ in 0..total {
        if directory.get(at..at + 4) != Some(&[0x50, 0x4b, 0x01, 0x02]) {
            return Err(ArchiveError::Format);
        }
        let made_by = u16_at(&directory, at + 4).ok_or(ArchiveError::Format)?;
        let flags = u16_at(&directory, at + 8).ok_or(ArchiveError::Format)?;
        let unpacked = u32_at(&directory, at + 24).ok_or(ArchiveError::Format)?;
        let name_length = u16_at(&directory, at + 28).ok_or(ArchiveError::Format)? as usize;
        let extra_length = u16_at(&directory, at + 30).ok_or(ArchiveError::Format)? as usize;
        let comment_length = u16_at(&directory, at + 32).ok_or(ArchiveError::Format)? as usize;
        let external = u32_at(&directory, at + 38).ok_or(ArchiveError::Format)?;
        let name = directory.get(at + 46..at + 46 + name_length).ok_or(ArchiveError::Format)?;
        let name = std::str::from_utf8(name).map_err(|_| ArchiveError::Escape)?;
        if flags & 1 != 0 || unpacked == u32::MAX {
            return Err(ArchiveError::Entry);
        }
        if !inside_bundle(name) {
            return Err(ArchiveError::Escape);
        }
        // "a" and "a/" are one place on disk.
        let key = name.strip_suffix('/').unwrap_or(name).to_string();
        // Unix mode sits in the high half when the entry was made on Unix.
        let symlink = made_by >> 8 == 3 && (external >> 16) & 0o170000 == 0o120000;
        if symlink {
            // A link target is a path, never a large file.
            if unpacked >= 4096 {
                return Err(ArchiveError::Entry);
            }
            symlinks.push(key.clone());
        }
        if !names.insert(key) {
            return Err(ArchiveError::Entry);
        }
        expanded += u64::from(unpacked);
        if expanded > MAX_EXPANDED_BYTES {
            return Err(ArchiveError::Bounds);
        }
        at += 46 + name_length + extra_length + comment_length;
    }
    if at != directory.len() {
        return Err(ArchiveError::Format);
    }
    // Nothing is unpacked through a link: no entry lives under a symlink's name.
    for link in &symlinks {
        let under = format!("{link}/");
        if names.iter().any(|name| name.starts_with(&under)) {
            return Err(ArchiveError::Escape);
        }
    }
    Ok(Contents { entries: total as usize, expanded_bytes: expanded, symlinks: symlinks.len() })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;

    pub(crate) struct Entry<'a> {
        pub name: &'a str,
        pub data: &'a [u8],
        pub symlink: bool,
        pub flags: u16,
    }

    pub(crate) fn file<'a>(name: &'a str, data: &'a [u8]) -> Entry<'a> {
        Entry { name, data, symlink: false, flags: 0 }
    }

    pub(crate) fn link<'a>(name: &'a str, target: &'a str) -> Entry<'a> {
        Entry { name, data: target.as_bytes(), symlink: true, flags: 0 }
    }

    /// A stored (uncompressed) ZIP, enough for the table of contents and for
    /// `ditto` to unpack. CRCs are zero: only the names and sizes are tested.
    pub(crate) fn zip(entries: &[Entry]) -> Vec<u8> {
        let (mut out, mut directory) = (Vec::new(), Vec::new());
        for e in entries {
            let offset = out.len() as u32;
            let mode: u32 = if e.symlink { 0o120755 } else if e.name.ends_with('/') { 0o040755 } else { 0o100644 };
            let crc = crc32(e.data);
            out.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04, 20, 0]);
            out.extend_from_slice(&e.flags.to_le_bytes());
            out.extend_from_slice(&[0u8; 6]); // method, time, date
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(e.name.as_bytes());
            out.extend_from_slice(e.data);
            directory.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02, 20, 3, 20, 0]);
            directory.extend_from_slice(&e.flags.to_le_bytes());
            directory.extend_from_slice(&[0u8; 6]);
            directory.extend_from_slice(&crc.to_le_bytes());
            directory.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            directory.extend_from_slice(&[0u8; 8]); // extra, comment, disk, internal
            directory.extend_from_slice(&(mode << 16).to_le_bytes());
            directory.extend_from_slice(&offset.to_le_bytes());
            directory.extend_from_slice(e.name.as_bytes());
        }
        let offset = out.len() as u32;
        out.extend_from_slice(&directory);
        out.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    fn check(entries: &[Entry]) -> Result<Contents, ArchiveError> {
        inspect(&mut Cursor::new(zip(entries)))
    }

    #[test]
    fn a_bundle_shaped_archive_passes() {
        let contents = check(&[
            file("Markie Nightly.app/", b""),
            file("Markie Nightly.app/Contents/", b""),
            file("Markie Nightly.app/Contents/Info.plist", b"<plist/>"),
            file("Markie Nightly.app/Contents/MacOS/markie-rs", b"binary"),
            link("Markie Nightly.app/Contents/Frameworks/Current", "A"),
        ])
        .unwrap();
        assert_eq!(contents, Contents { entries: 5, expanded_bytes: 15, symlinks: 1 });
    }

    #[test]
    fn anything_outside_the_bundle_is_refused() {
        for name in [
            "evil.sh",
            "../Markie Nightly.app/Contents/Info.plist",
            "Markie Nightly.app/../../Library/LaunchAgents/evil.plist",
            "Markie Nightly.app/Contents/../../evil",
            "Markie Nightly.app/./Contents/Info.plist",
            "Markie Nightly.app//Contents/Info.plist",
            "/Applications/Markie Nightly.app/Contents/Info.plist",
            "Markie Nightly.app\\Contents\\Info.plist",
            "Markie Nightly.app/Contents/a\\..\\b",
            "Markie Nightly.app/Contents/new\nline",
            "Markie Nightly.app",
            "Markie Nightly.app.evil/Contents/Info.plist",
            "Markie.app/Contents/Info.plist",
            "Markie RS.app/Contents/Info.plist",
            "__MACOSX/Markie Nightly.app/._Info.plist",
            "",
        ] {
            assert_eq!(check(&[file("Markie Nightly.app/Contents/Info.plist", b"ok"), file(name, b"x")]), Err(ArchiveError::Escape), "{name:?}");
        }
    }

    #[test]
    fn nothing_is_unpacked_through_a_symlink() {
        assert_eq!(
            check(&[link("Markie Nightly.app/Contents/Resources", "/tmp"), file("Markie Nightly.app/Contents/Resources/evil", b"x")]),
            Err(ArchiveError::Escape)
        );
        // Order does not matter, and a directory entry of the same name is a repeat.
        assert_eq!(
            check(&[file("Markie Nightly.app/Contents/Resources/evil", b"x"), link("Markie Nightly.app/Contents/Resources", "/tmp")]),
            Err(ArchiveError::Escape)
        );
        assert_eq!(
            check(&[link("Markie Nightly.app/Contents/Resources", "/tmp"), file("Markie Nightly.app/Contents/Resources/", b"")]),
            Err(ArchiveError::Entry)
        );
        let long = "a".repeat(4096);
        assert_eq!(check(&[link("Markie Nightly.app/Contents/link", &long)]), Err(ArchiveError::Entry));
    }

    #[test]
    fn repeats_encryption_and_bad_framing_are_refused() {
        let plist = "Markie Nightly.app/Contents/Info.plist";
        assert_eq!(check(&[file(plist, b"a"), file(plist, b"b")]), Err(ArchiveError::Entry));
        assert_eq!(check(&[Entry { name: plist, data: b"a", symlink: false, flags: 1 }]), Err(ArchiveError::Entry));
        assert_eq!(check(&[]), Err(ArchiveError::Bounds));
        for bytes in [Vec::new(), b"not a zip".to_vec(), vec![0u8; 100], b"PK\x05\x06".to_vec()] {
            assert_eq!(inspect(&mut Cursor::new(bytes)), Err(ArchiveError::Format));
        }
        // A directory that is cut short, or claims more entries than it holds.
        let good = zip(&[file(plist, b"a")]);
        let mut claims_two = good.clone();
        let end = claims_two.len() - 22;
        claims_two[end + 8] = 2;
        claims_two[end + 10] = 2;
        assert_eq!(inspect(&mut Cursor::new(claims_two)), Err(ArchiveError::Format));
        let mut zip64 = good.clone();
        zip64[end + 16..end + 20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(inspect(&mut Cursor::new(zip64)), Err(ArchiveError::Format));
        let mut truncated = good.clone();
        truncated.truncate(good.len() - 5);
        assert_eq!(inspect(&mut Cursor::new(truncated)), Err(ArchiveError::Format));
    }

    #[test]
    fn a_zip_bomb_by_declared_size_is_refused() {
        let plist = "Markie Nightly.app/Contents/Info.plist";
        let mut bytes = zip(&[file(plist, b"a"), file("Markie Nightly.app/Contents/b", b"b"), file("Markie Nightly.app/Contents/c", b"c")]);
        // Rewrite each central entry's unpacked size to just under 4 GiB.
        let mut at = 0;
        while let Some(found) = bytes[at..].windows(4).position(|w| w == [0x50, 0x4b, 0x01, 0x02]) {
            let entry = at + found;
            bytes[entry + 24..entry + 28].copy_from_slice(&(u32::MAX - 1).to_le_bytes());
            at = entry + 4;
        }
        assert_eq!(inspect(&mut Cursor::new(bytes)), Err(ArchiveError::Bounds));
    }
}
