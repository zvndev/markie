//! Original bounded ZIP implementation from PKWARE APPNOTE 6.3.10, sections 4.3 and 4.4.
//! <https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT>
//! Ported from `src/lib/office/zip.ts`. ZIP64, encryption and split archives are
//! deliberately unsupported. Raw DEFLATE uses `miniz_oxide`, the generic
//! primitive standing in for the browser's `DecompressionStream`.

use crate::error::{OfficeError, Result};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZipLimits {
    pub max_archive_bytes: usize,
    pub max_entry_bytes: usize,
    pub max_expanded_bytes: usize,
    pub max_entries: usize,
    pub max_compression_ratio: usize,
}

pub const DEFAULT_ZIP_LIMITS: ZipLimits = ZipLimits {
    max_archive_bytes: 32 * 1024 * 1024,
    max_entry_bytes: 16 * 1024 * 1024,
    max_expanded_bytes: 64 * 1024 * 1024,
    max_entries: 2048,
    max_compression_ratio: 1000,
};

impl Default for ZipLimits {
    fn default() -> Self {
        DEFAULT_ZIP_LIMITS
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    pub data: Vec<u8>,
}

impl ZipEntry {
    pub fn new(name: impl Into<String>, data: impl Into<Vec<u8>>) -> Self {
        Self { name: name.into(), data: data.into() }
    }
}

/// Rust has no "unsafe integer" values, so only zero is an invalid limit.
pub fn resolve_zip_limits(limits: ZipLimits) -> Result<ZipLimits> {
    for (name, value) in [
        ("maxArchiveBytes", limits.max_archive_bytes),
        ("maxEntryBytes", limits.max_entry_bytes),
        ("maxExpandedBytes", limits.max_expanded_bytes),
        ("maxEntries", limits.max_entries),
        ("maxCompressionRatio", limits.max_compression_ratio),
    ] {
        if value == 0 || value > (1usize << 53) {
            return Err(OfficeError::zip("invalid-limit", format!("{name} must be a positive safe integer.")));
        }
    }
    Ok(limits)
}

fn unsafe_path_char(c: char) -> bool {
    c == '\\' || (c as u32) <= 0x20 || c == '\u{7f}' || matches!(c, ':' | '%' | '?' | '#')
}

/// Rejects aliases as well as traversal. We never extract to disk, but a
/// package must not have two names that another consumer treats as one part.
pub fn validate_zip_path(name: &str) -> Result<()> {
    let pieces: Vec<&str> = name.split('/').collect();
    let bad = name.is_empty()
        || name.starts_with('/')
        || name.chars().any(unsafe_path_char)
        || pieces
            .iter()
            .enumerate()
            .any(|(i, piece)| *piece == "." || *piece == ".." || (piece.is_empty() && i != pieces.len() - 1));
    if bad {
        let shown: String = name.chars().take(160).collect();
        return Err(OfficeError::zip("unsafe-path", format!("Unsafe ZIP part name: {shown}")));
    }
    Ok(())
}

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut bit = 0;
        while bit < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            bit += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}
static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32 from APPNOTE 4.4.7 (the same polynomial PNG uses).
pub fn zip_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc = CRC_TABLE[((crc ^ byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn inflate(data: &[u8], expected: usize) -> Result<Vec<u8>> {
    use miniz_oxide::inflate::{TINFLStatus, decompress_to_vec_with_limit};
    match decompress_to_vec_with_limit(data, expected) {
        Ok(out) => {
            if out.len() != expected {
                return Err(OfficeError::zip("size-mismatch", "ZIP entry size does not match its header."));
            }
            Ok(out)
        }
        Err(e) if e.status == TINFLStatus::HasMoreOutput => {
            Err(OfficeError::zip("expansion-limit", "ZIP entry expanded beyond its declared size."))
        }
        Err(_) => Err(OfficeError::zip("invalid-deflate", "ZIP entry contains invalid DEFLATE data.")),
    }
}

struct Record {
    name: String,
    method: u16,
    size: usize,
    crc: u32,
    start: usize,
    end: usize,
    data_start: usize,
    compressed: usize,
}

pub fn read_zip(input: &[u8], limits: ZipLimits) -> Result<Vec<ZipEntry>> {
    let limits = resolve_zip_limits(limits)?;
    if input.len() > limits.max_archive_bytes {
        return Err(OfficeError::zip("archive-limit", "DOCX exceeds the archive size limit."));
    }
    let bytes = input;
    let require = |offset: usize, length: usize| -> Result<()> {
        if offset.checked_add(length).is_none_or(|e| e > bytes.len()) {
            return Err(OfficeError::zip("truncated-zip", "Truncated ZIP structure."));
        }
        Ok(())
    };
    let check_extra = |mut offset: usize, length: usize| -> Result<()> {
        let end = offset + length;
        while offset < end {
            if offset + 4 > end {
                return Err(OfficeError::zip("invalid-extra", "Truncated ZIP extra field."));
            }
            let id = u16_at(bytes, offset);
            let size = u16_at(bytes, offset + 2) as usize;
            if offset + 4 + size > end {
                return Err(OfficeError::zip("invalid-extra", "ZIP extra field exceeds its header."));
            }
            if [0x0001, 0x0017, 0x9901, 0x7075].contains(&id) {
                return Err(OfficeError::zip(
                    "unsupported-zip",
                    "ZIP64, encryption and alternate-name extra fields are unsupported.",
                ));
            }
            offset += 4 + size;
        }
        Ok(())
    };
    if bytes.len() < 22 {
        return Err(OfficeError::zip("invalid-zip", "Not a supported ZIP package."));
    }
    let mut end: Option<usize> = None;
    let lowest = bytes.len().saturating_sub(65557);
    let mut offset = bytes.len() - 22;
    loop {
        if u32_at(bytes, offset) == 0x0605_4b50 && offset + 22 + u16_at(bytes, offset + 20) as usize == bytes.len() {
            end = Some(offset);
            break;
        }
        if offset == lowest {
            break;
        }
        offset -= 1;
    }
    let Some(end) = end else {
        return Err(OfficeError::zip("invalid-zip", "ZIP end record is missing or trailing data is present."));
    };
    let count = u16_at(bytes, end + 10) as usize;
    let directory_size = u32_at(bytes, end + 12);
    let directory_start = u32_at(bytes, end + 16);
    if u16_at(bytes, end + 4) != 0
        || u16_at(bytes, end + 6) != 0
        || u16_at(bytes, end + 8) as usize != count
        || count == 0xffff
        || directory_size == 0xffff_ffff
        || directory_start == 0xffff_ffff
    {
        return Err(OfficeError::zip("unsupported-zip", "Split and ZIP64 archives are not supported."));
    }
    let (directory_size, directory_start) = (directory_size as usize, directory_start as usize);
    if count > limits.max_entries {
        return Err(OfficeError::zip("entry-limit", "DOCX contains too many ZIP entries."));
    }
    if directory_start + directory_size != end {
        return Err(OfficeError::zip("invalid-directory", "ZIP directory bounds are invalid."));
    }
    let mut names = HashSet::new();
    let mut records: Vec<Record> = Vec::new();
    let mut cursor = directory_start;
    let mut expanded = 0usize;
    for _ in 0..count {
        require(cursor, 46)?;
        if cursor + 46 > end || u32_at(bytes, cursor) != 0x0201_4b50 {
            return Err(OfficeError::zip("invalid-directory", "Invalid ZIP directory entry."));
        }
        let flags = u16_at(bytes, cursor + 8);
        let method = u16_at(bytes, cursor + 10);
        let crc = u32_at(bytes, cursor + 16);
        let compressed = u32_at(bytes, cursor + 20);
        let size = u32_at(bytes, cursor + 24);
        let name_size = u16_at(bytes, cursor + 28) as usize;
        let extra_size = u16_at(bytes, cursor + 30) as usize;
        let comment_size = u16_at(bytes, cursor + 32) as usize;
        let start = u32_at(bytes, cursor + 42);
        let next = cursor + 46 + name_size + extra_size + comment_size;
        require(cursor, next - cursor)?;
        if next > end
            || u16_at(bytes, cursor + 34) != 0
            || u16_at(bytes, cursor + 6) > 20
            || (flags & !0x080e) != 0
            || (method != 0 && method != 8)
            || start == 0xffff_ffff
            || compressed == 0xffff_ffff
            || size == 0xffff_ffff
        {
            return Err(OfficeError::zip(
                "unsupported-zip",
                "Encrypted, ZIP64 or unsupported ZIP entries are not accepted.",
            ));
        }
        let (compressed, size, start) = (compressed as usize, size as usize, start as usize);
        let raw_name = &bytes[cursor + 46..cursor + 46 + name_size];
        check_extra(cursor + 46 + name_size, extra_size)?;
        if flags & 0x0800 == 0 && raw_name.iter().any(|b| *b > 127) {
            return Err(OfficeError::zip("unsupported-name", "Non-UTF-8 ZIP names are unsupported."));
        }
        // A leading U+FEFF is part of the name: from_utf8 never strips it.
        let name = std::str::from_utf8(raw_name)
            .map_err(|_| OfficeError::zip("invalid-name", "Invalid UTF-8 ZIP name."))?
            .to_string();
        validate_zip_path(&name)?;
        if !names.insert(js_lower(&name)) {
            return Err(OfficeError::zip("duplicate-part", "ZIP contains duplicate or ambiguous part names."));
        }
        expanded += size;
        if size > limits.max_entry_bytes
            || expanded > limits.max_expanded_bytes
            || size > compressed.max(1).saturating_mul(limits.max_compression_ratio)
        {
            return Err(OfficeError::zip("expansion-limit", "DOCX exceeds the ZIP expansion limit."));
        }
        if method == 0 && compressed != size {
            return Err(OfficeError::zip("size-mismatch", "Stored ZIP entry has inconsistent sizes."));
        }
        let unix_mode = u32_at(bytes, cursor + 38) >> 16;
        if unix_mode & 0xf000 == 0xa000 {
            return Err(OfficeError::zip("unsafe-path", "ZIP symlinks are not accepted."));
        }
        require(start, 30)?;
        let local_name_size = u16_at(bytes, start + 26) as usize;
        let local_extra_size = u16_at(bytes, start + 28) as usize;
        let data_start = start + 30 + local_name_size + local_extra_size;
        require(start, data_start - start + compressed)?;
        check_extra(start + 30 + local_name_size, local_extra_size)?;
        if u32_at(bytes, start) != 0x0403_4b50
            || u16_at(bytes, start + 6) != flags
            || u16_at(bytes, start + 8) != method
            || u16_at(bytes, start + 4) != u16_at(bytes, cursor + 6)
            || local_name_size != name_size
            || raw_name.iter().enumerate().any(|(i, b)| bytes[start + 30 + i] != *b)
        {
            return Err(OfficeError::zip("header-mismatch", "ZIP local and central headers disagree."));
        }
        let mut entry_end = data_start + compressed;
        if flags & 8 != 0 {
            let (lc, lz, ls) = (u32_at(bytes, start + 14), u32_at(bytes, start + 18), u32_at(bytes, start + 22));
            if (lc != 0 && lc != crc) || (lz != 0 && lz as usize != compressed) || (ls != 0 && ls as usize != size) {
                return Err(OfficeError::zip(
                    "header-mismatch",
                    "ZIP streamed local header disagrees with its directory.",
                ));
            }
            require(entry_end, 12)?;
            let descriptor = if u32_at(bytes, entry_end) == 0x0807_4b50 { entry_end + 4 } else { entry_end };
            require(descriptor, 12)?;
            if u32_at(bytes, descriptor) != crc
                || u32_at(bytes, descriptor + 4) as usize != compressed
                || u32_at(bytes, descriptor + 8) as usize != size
            {
                return Err(OfficeError::zip("header-mismatch", "ZIP data descriptor disagrees with the directory."));
            }
            entry_end = descriptor + 12;
        } else if u32_at(bytes, start + 14) != crc
            || u32_at(bytes, start + 18) as usize != compressed
            || u32_at(bytes, start + 22) as usize != size
        {
            return Err(OfficeError::zip("header-mismatch", "ZIP entry sizes or CRC disagree."));
        }
        if entry_end > directory_start {
            return Err(OfficeError::zip("overlapping-entry", "ZIP entry overlaps its directory."));
        }
        if name.ends_with('/') && size != 0 {
            return Err(OfficeError::zip("invalid-directory", "ZIP directory entry contains data."));
        }
        records.push(Record { name, method, size, crc, start, end: entry_end, data_start, compressed });
        cursor = next;
    }
    if cursor != end {
        return Err(OfficeError::zip("invalid-directory", "ZIP directory contains unsupported records."));
    }
    let mut ordered: Vec<&Record> = records.iter().collect();
    ordered.sort_by_key(|r| r.start);
    let mut local_end = 0;
    for record in ordered {
        if record.start != local_end {
            return Err(OfficeError::zip("overlapping-entry", "ZIP has overlapping, hidden or prefixed records."));
        }
        local_end = record.end;
    }
    if local_end != directory_start {
        return Err(OfficeError::zip("invalid-directory", "ZIP contains unaccounted local data."));
    }
    let mut entries = Vec::with_capacity(records.len());
    for record in records {
        let compressed = &bytes[record.data_start..record.data_start + record.compressed];
        let data = if record.method == 0 { compressed.to_vec() } else { inflate(compressed, record.size)? };
        if zip_crc32(&data) != record.crc {
            return Err(OfficeError::zip("crc-mismatch", format!("ZIP integrity check failed for {}.", record.name)));
        }
        entries.push(ZipEntry { name: record.name, data });
    }
    Ok(entries)
}

/// JavaScript `toLowerCase` folds full Unicode; Rust's `to_lowercase` is the same mapping.
pub(crate) fn js_lower(s: &str) -> String {
    s.to_lowercase()
}

/// Writes conventional stored entries; unrelated part contents are unchanged.
pub fn write_zip(entries: &[ZipEntry], limits: ZipLimits) -> Result<Vec<u8>> {
    let limits = resolve_zip_limits(limits)?;
    if entries.len() > limits.max_entries.min(65534) {
        return Err(OfficeError::zip("entry-limit", "Too many ZIP entries."));
    }
    let mut names = HashSet::new();
    let mut expanded = 0usize;
    let mut records = Vec::with_capacity(entries.len());
    for entry in entries {
        validate_zip_path(&entry.name)?;
        if !names.insert(js_lower(&entry.name)) {
            return Err(OfficeError::zip("duplicate-part", "Duplicate ZIP part."));
        }
        let encoded = entry.name.as_bytes();
        expanded += entry.data.len();
        if encoded.len() > 65535 || entry.data.len() > limits.max_entry_bytes || expanded > limits.max_expanded_bytes {
            return Err(OfficeError::zip("expansion-limit", "ZIP output exceeds its limits."));
        }
        records.push((encoded, &entry.data, zip_crc32(&entry.data)));
    }
    let total = records.iter().fold(22, |size, r| size + 76 + 2 * r.0.len() + r.1.len());
    if total > limits.max_archive_bytes {
        return Err(OfficeError::zip("archive-limit", "ZIP output exceeds the archive size limit."));
    }
    let mut out = Vec::with_capacity(total);
    let p16 = |o: &mut Vec<u8>, v: u16| o.extend_from_slice(&v.to_le_bytes());
    let p32 = |o: &mut Vec<u8>, v: u32| o.extend_from_slice(&v.to_le_bytes());
    let mut offsets = Vec::with_capacity(records.len());
    for (name, data, crc) in &records {
        offsets.push(out.len() as u32);
        p32(&mut out, 0x0403_4b50);
        p16(&mut out, 20);
        p16(&mut out, 0x0800);
        p16(&mut out, 0);
        p16(&mut out, 0);
        p16(&mut out, 0x21); // 1980-01-01; deterministic generated archive.
        p32(&mut out, *crc);
        p32(&mut out, data.len() as u32);
        p32(&mut out, data.len() as u32);
        p16(&mut out, name.len() as u16);
        p16(&mut out, 0);
        out.extend_from_slice(name);
        out.extend_from_slice(data);
    }
    let directory = out.len();
    for (i, (name, data, crc)) in records.iter().enumerate() {
        p32(&mut out, 0x0201_4b50);
        p16(&mut out, 20);
        p16(&mut out, 20);
        p16(&mut out, 0x0800);
        p16(&mut out, 0);
        p16(&mut out, 0);
        p16(&mut out, 0x21);
        p32(&mut out, *crc);
        p32(&mut out, data.len() as u32);
        p32(&mut out, data.len() as u32);
        p16(&mut out, name.len() as u16);
        out.extend_from_slice(&[0u8; 12]);
        p32(&mut out, offsets[i]);
        out.extend_from_slice(name);
    }
    let directory_size = out.len() - directory;
    p32(&mut out, 0x0605_4b50);
    p16(&mut out, 0);
    p16(&mut out, 0);
    p16(&mut out, records.len() as u16);
    p16(&mut out, records.len() as u16);
    p32(&mut out, directory_size as u32);
    p32(&mut out, directory as u32);
    p16(&mut out, 0);
    debug_assert_eq!(out.len(), total);
    Ok(out)
}
