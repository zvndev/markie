//! A minimal, read-only LevelDB reader for the copies of Chromium's stores.
//!
//! It opens nothing for writing, takes no lock and runs no compaction. It reads
//! `CURRENT`, replays the `MANIFEST` to find the live table files and the live
//! log, reads every table (`.ldb`, snappy or uncompressed blocks) and every
//! live log, and keeps the entry with the highest sequence number per key.
//! Deletions hide older values. The comparator is never needed, because
//! nothing is looked up by order: the whole store is read once.
//!
//! Why not a crate: `rusty-leveldb` (MIT, maintained) opens a database for
//! writing, needs Chromium's IndexedDB comparator to be re-implemented before
//! it will open that store, and recovers logs into new tables. A reader that
//! only reads is smaller than adapting it, and cannot touch the copy.
use crate::error::{MigrateError, Result};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

/// (user key, sequence number, value or deletion).
type Entry = (Vec<u8>, u64, Option<Vec<u8>>);

const TABLE_MAGIC: u64 = 0xdb47_7524_8b80_fb57;
const LOG_BLOCK: usize = 32 * 1024;
const LOG_HEADER: usize = 7;

fn corrupt(what: impl Into<String>) -> MigrateError {
    MigrateError::Corrupt(what.into())
}

// ── CRC-32C (Castagnoli), as LevelDB masks it ───────────────────────────────

fn crc32c_table() -> &'static [u32; 256] {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0x82f6_3b78 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        table
    })
}

fn crc32c(parts: &[&[u8]]) -> u32 {
    let table = crc32c_table();
    let mut crc = !0u32;
    for part in parts {
        for &b in *part {
            crc = table[((crc ^ u32::from(b)) & 0xff) as usize] ^ (crc >> 8);
        }
    }
    !crc
}

fn unmask(masked: u32) -> u32 {
    let rot = masked.wrapping_sub(0xa282_ead8);
    rot.rotate_left(15)
}

// ── Varints ─────────────────────────────────────────────────────────────────

pub(crate) fn varint(data: &[u8], pos: &mut usize) -> Result<u64> {
    let mut result = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *data.get(*pos).ok_or_else(|| corrupt("truncated varint"))?;
        *pos += 1;
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    Err(corrupt("varint too long"))
}

fn slice<'a>(data: &'a [u8], pos: &mut usize, len: usize) -> Result<&'a [u8]> {
    let end = pos.checked_add(len).filter(|&e| e <= data.len()).ok_or_else(|| corrupt("truncated field"))?;
    let out = &data[*pos..end];
    *pos = end;
    Ok(out)
}

fn length_prefixed<'a>(data: &'a [u8], pos: &mut usize) -> Result<&'a [u8]> {
    let len = varint(data, pos)? as usize;
    slice(data, pos, len)
}

// ── Log files (the write-ahead log and the MANIFEST share this framing) ─────

/// Physical records reassembled into logical ones. A torn or corrupt tail ends
/// the log, as LevelDB's own recovery does; `torn` says whether that happened.
fn log_records(data: &[u8]) -> (Vec<Vec<u8>>, bool) {
    let mut records = Vec::new();
    let mut pending: Option<Vec<u8>> = None;
    let mut pos = 0;
    while pos < data.len() {
        let in_block = LOG_BLOCK - pos % LOG_BLOCK;
        if in_block < LOG_HEADER {
            pos += in_block;
            continue;
        }
        if pos + LOG_HEADER > data.len() {
            return (records, true);
        }
        let header = &data[pos..pos + LOG_HEADER];
        let crc = u32::from_le_bytes(header[0..4].try_into().unwrap());
        let len = usize::from(u16::from_le_bytes(header[4..6].try_into().unwrap()));
        let kind = header[6];
        if kind == 0 && len == 0 {
            // Zero padding from a preallocated or reused file: the rest of this block is empty.
            pos += in_block;
            continue;
        }
        let start = pos + LOG_HEADER;
        if start + len > data.len() || len > in_block - LOG_HEADER {
            return (records, true);
        }
        let payload = &data[start..start + len];
        if unmask(crc) != crc32c(&[&[kind], payload]) {
            return (records, true);
        }
        pos = start + len;
        match kind {
            1 => {
                pending = None;
                records.push(payload.to_vec());
            }
            2 => pending = Some(payload.to_vec()),
            3 => match pending.as_mut() {
                Some(p) => p.extend_from_slice(payload),
                None => return (records, true),
            },
            4 => match pending.take() {
                Some(mut p) => {
                    p.extend_from_slice(payload);
                    records.push(p);
                }
                None => return (records, true),
            },
            _ => return (records, true),
        }
    }
    (records, pending.is_some())
}

// ── MANIFEST ────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct Version {
    comparator: Option<String>,
    log_number: Option<u64>,
    prev_log_number: Option<u64>,
    files: BTreeSet<u64>,
}

fn replay_manifest(data: &[u8]) -> Result<Version> {
    let (records, torn) = log_records(data);
    if torn && records.is_empty() {
        return Err(corrupt("MANIFEST has no readable record"));
    }
    let mut version = Version::default();
    for record in records {
        let mut pos = 0;
        while pos < record.len() {
            match varint(&record, &mut pos)? {
                1 => version.comparator = Some(String::from_utf8_lossy(length_prefixed(&record, &mut pos)?).into_owned()),
                2 => version.log_number = Some(varint(&record, &mut pos)?),
                3 | 4 => {
                    varint(&record, &mut pos)?;
                }
                5 => {
                    varint(&record, &mut pos)?;
                    length_prefixed(&record, &mut pos)?;
                }
                6 => {
                    varint(&record, &mut pos)?;
                    let number = varint(&record, &mut pos)?;
                    version.files.remove(&number);
                }
                7 => {
                    varint(&record, &mut pos)?;
                    let number = varint(&record, &mut pos)?;
                    varint(&record, &mut pos)?;
                    length_prefixed(&record, &mut pos)?;
                    length_prefixed(&record, &mut pos)?;
                    version.files.insert(number);
                }
                9 => version.prev_log_number = Some(varint(&record, &mut pos)?),
                tag => return Err(corrupt(format!("unknown MANIFEST tag {tag}"))),
            }
        }
    }
    Ok(version)
}

// ── Tables ──────────────────────────────────────────────────────────────────

fn block_handle(data: &[u8], pos: &mut usize) -> Result<(usize, usize)> {
    Ok((varint(data, pos)? as usize, varint(data, pos)? as usize))
}

fn read_block(file: &[u8], (offset, size): (usize, usize)) -> Result<Vec<u8>> {
    let end = offset.checked_add(size).and_then(|e| e.checked_add(5)).filter(|&e| e <= file.len());
    let end = end.ok_or_else(|| corrupt("block outside its table"))?;
    let contents = &file[offset..offset + size];
    let kind = file[offset + size];
    let crc = u32::from_le_bytes(file[offset + size + 1..end].try_into().unwrap());
    if unmask(crc) != crc32c(&[contents, &[kind]]) {
        return Err(corrupt("table block checksum mismatch"));
    }
    match kind {
        0 => Ok(contents.to_vec()),
        1 => snap::raw::Decoder::new().decompress_vec(contents).map_err(|e| corrupt(format!("snappy: {e}"))),
        other => Err(MigrateError::Unsupported(format!("table block compression {other}"))),
    }
}

/// Every (key, value) in one block, keys restored from their shared prefixes.
fn block_entries(block: &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
    if block.len() < 4 {
        return Err(corrupt("block too short"));
    }
    let restarts = u32::from_le_bytes(block[block.len() - 4..].try_into().unwrap()) as usize;
    let limit = block.len().checked_sub(4 + restarts * 4).ok_or_else(|| corrupt("bad restart count"))?;
    let data = &block[..limit];
    let mut entries = Vec::new();
    let mut key: Vec<u8> = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let shared = varint(data, &mut pos)? as usize;
        let unshared = varint(data, &mut pos)? as usize;
        let value_len = varint(data, &mut pos)? as usize;
        if shared > key.len() {
            return Err(corrupt("bad shared key length"));
        }
        key.truncate(shared);
        key.extend_from_slice(slice(data, &mut pos, unshared)?);
        entries.push((key.clone(), slice(data, &mut pos, value_len)?.to_vec()));
    }
    Ok(entries)
}

/// Internal-key entries of one table: (user key, sequence, value or deletion).
fn table_entries(file: &[u8]) -> Result<Vec<Entry>> {
    if file.len() < 48 {
        return Err(corrupt("table too short"));
    }
    let footer = &file[file.len() - 48..];
    if u64::from_le_bytes(footer[40..48].try_into().unwrap()) != TABLE_MAGIC {
        return Err(corrupt("not a LevelDB table"));
    }
    let mut pos = 0;
    let _metaindex = block_handle(footer, &mut pos)?;
    let index = block_handle(footer, &mut pos)?;
    let mut out = Vec::new();
    for (_, handle) in block_entries(&read_block(file, index)?)? {
        let mut p = 0;
        let data = read_block(file, block_handle(&handle, &mut p)?)?;
        for (internal, value) in block_entries(&data)? {
            if internal.len() < 8 {
                return Err(corrupt("internal key too short"));
            }
            let (user, tag) = internal.split_at(internal.len() - 8);
            let tag = u64::from_le_bytes(tag.try_into().unwrap());
            match tag & 0xff {
                1 => out.push((user.to_vec(), tag >> 8, Some(value))),
                0 => out.push((user.to_vec(), tag >> 8, None)),
                t => return Err(corrupt(format!("unknown value type {t}"))),
            }
        }
    }
    Ok(out)
}

/// Write batches in one log: (user key, sequence, value or deletion).
fn log_entries(data: &[u8]) -> Result<(Vec<Entry>, bool)> {
    let (records, torn) = log_records(data);
    let mut out = Vec::new();
    for batch in records {
        if batch.len() < 12 {
            return Err(corrupt("write batch too short"));
        }
        let first = u64::from_le_bytes(batch[0..8].try_into().unwrap());
        let count = u32::from_le_bytes(batch[8..12].try_into().unwrap());
        let mut pos = 12;
        for seq in (first..).take(count as usize) {
            let kind = *batch.get(pos).ok_or_else(|| corrupt("truncated write batch"))?;
            pos += 1;
            let key = length_prefixed(&batch, &mut pos)?.to_vec();
            match kind {
                1 => out.push((key, seq, Some(length_prefixed(&batch, &mut pos)?.to_vec()))),
                0 => out.push((key, seq, None)),
                t => return Err(corrupt(format!("unknown batch record {t}"))),
            }
        }
    }
    Ok((out, torn))
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReadStats {
    pub tables: usize,
    pub logs: usize,
    pub live_keys: usize,
    /// A log whose tail was torn or failed its checksum; the tail was dropped, as LevelDB does.
    pub torn_logs: usize,
    pub comparator: Option<String>,
}

/// The live contents of one LevelDB directory, sorted by key bytes.
#[derive(Debug, Default)]
pub struct Snapshot {
    pub entries: BTreeMap<Vec<u8>, Vec<u8>>,
    pub stats: ReadStats,
}

fn file_number(name: &str, ext: &str) -> Option<u64> {
    name.strip_suffix(ext)?.parse().ok()
}

/// Reads a LevelDB directory without changing it.
pub fn read_dir(dir: &Path) -> Result<Snapshot> {
    fn io(path: &Path) -> impl FnOnce(std::io::Error) -> MigrateError + '_ {
        move |e| MigrateError::Io(path.display().to_string(), e)
    }
    let current_path = dir.join("CURRENT");
    let current = std::fs::read_to_string(&current_path).map_err(io(&current_path))?;
    let manifest_name = current.trim_end_matches('\n');
    if !manifest_name.starts_with("MANIFEST-") || manifest_name.contains('/') {
        return Err(corrupt("CURRENT does not name a MANIFEST"));
    }
    let manifest_path = dir.join(manifest_name);
    let version = replay_manifest(&std::fs::read(&manifest_path).map_err(io(&manifest_path))?)?;

    let mut tables: HashMap<u64, PathBuf> = HashMap::new();
    let mut logs: Vec<(u64, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(io(dir))? {
        let entry = entry.map_err(io(dir))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(n) = file_number(&name, ".ldb").or_else(|| file_number(&name, ".sst")) {
            tables.insert(n, entry.path());
        } else if let Some(n) = file_number(&name, ".log") {
            logs.push((n, entry.path()));
        }
    }
    let mut stats = ReadStats { comparator: version.comparator.clone(), ..Default::default() };
    let mut best: HashMap<Vec<u8>, (u64, Option<Vec<u8>>)> = HashMap::new();
    let mut merge = |key: Vec<u8>, seq: u64, value: Option<Vec<u8>>| {
        match best.get(&key) {
            Some((s, _)) if *s >= seq => {}
            _ => {
                best.insert(key, (seq, value));
            }
        }
    };
    for number in &version.files {
        let path = tables.get(number).ok_or_else(|| corrupt(format!("live table {number} is missing from the copy")))?;
        for (key, seq, value) in table_entries(&std::fs::read(path).map_err(io(path))?)? {
            merge(key, seq, value);
        }
        stats.tables += 1;
    }
    // Live logs: the current one and its predecessor. Older ones are already in tables.
    let floor = version.log_number.unwrap_or(0);
    logs.sort();
    for (number, path) in logs {
        if number < floor && Some(number) != version.prev_log_number {
            continue;
        }
        let (entries, torn) = log_entries(&std::fs::read(&path).map_err(io(&path))?)?;
        for (key, seq, value) in entries {
            merge(key, seq, value);
        }
        stats.logs += 1;
        stats.torn_logs += usize::from(torn);
    }
    let entries: BTreeMap<Vec<u8>, Vec<u8>> = best.into_iter().filter_map(|(k, (_, v))| v.map(|v| (k, v))).collect();
    stats.live_keys = entries.len();
    Ok(Snapshot { entries, stats })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_record(kind: u8, payload: &[u8]) -> Vec<u8> {
        let crc = crc32c(&[&[kind], payload]);
        let masked = (crc.rotate_right(15)).wrapping_add(0xa282_ead8);
        let mut out = masked.to_le_bytes().to_vec();
        out.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        out.push(kind);
        out.extend_from_slice(payload);
        out
    }

    fn batch(seq: u64, ops: &[(&[u8], Option<&[u8]>)]) -> Vec<u8> {
        let mut out = seq.to_le_bytes().to_vec();
        out.extend_from_slice(&(ops.len() as u32).to_le_bytes());
        for (k, v) in ops {
            out.push(u8::from(v.is_some()));
            out.push(k.len() as u8);
            out.extend_from_slice(k);
            if let Some(v) = v {
                out.push(v.len() as u8);
                out.extend_from_slice(v);
            }
        }
        out
    }

    #[test]
    fn crc32c_known_value() {
        assert_eq!(crc32c(&[b"123456789"]), 0xe306_9283);
    }

    #[test]
    fn logs_apply_in_sequence_order_and_a_torn_tail_is_dropped() {
        let mut log = log_record(1, &batch(1, &[(b"a", Some(b"1")), (b"b", Some(b"2"))]));
        log.extend(log_record(1, &batch(3, &[(b"a", None), (b"c", Some(b"3"))])));
        let mut torn = log_record(1, &batch(5, &[(b"c", Some(b"torn"))]));
        torn.truncate(torn.len() - 2);
        log.extend(torn);
        let (entries, was_torn) = log_entries(&log).unwrap();
        assert!(was_torn);
        assert_eq!(entries.len(), 4);
        let mut best: BTreeMap<Vec<u8>, (u64, Option<Vec<u8>>)> = BTreeMap::new();
        for (k, s, v) in entries {
            if best.get(&k).is_none_or(|(bs, _)| *bs < s) {
                best.insert(k, (s, v));
            }
        }
        assert_eq!(best[&b"a".to_vec()].1, None);
        assert_eq!(best[&b"c".to_vec()].1.as_deref(), Some(&b"3"[..]));
    }

    #[test]
    fn records_split_across_blocks_are_joined() {
        let payload = vec![7u8; LOG_BLOCK];
        let first = LOG_BLOCK - LOG_HEADER;
        let mut log = log_record(2, &payload[..first]);
        log.extend(log_record(4, &payload[first..]));
        let (records, torn) = log_records(&log);
        assert!(!torn);
        assert_eq!(records, vec![payload]);
    }
}
