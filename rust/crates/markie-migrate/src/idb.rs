//! Chromium's IndexedDB on LevelDB (`content/browser/indexed_db`), read only.
//!
//! Every key starts with a prefix naming (database, object store, index).
//! - (0,0,0) + 201: a database name, mapped to its numeric ID.
//! - (db,0,0) + 50 + store + 0: an object store's name.
//! - (db,store,1) + IDB key: a record. Its value is a varint version, then
//!   Blink's serialized value, possibly wrapped.
//! - (db,store,3) + IDB key: the blob list for a record whose value was moved
//!   to a file (values over 64 KiB). The file lives in
//!   `<origin>.indexeddb.blob/<db>/<xx>/<blob number>`.
use crate::error::{MigrateError, Result};
use crate::leveldb::{read_dir, varint, ReadStats};
use crate::v8::{deserialize, JsValue};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const DATABASE_NAME_TYPE: u8 = 201;
const OBJECT_STORE_META_TYPE: u8 = 50;
const OBJECT_STORE_DATA_INDEX: u64 = 1;
const BLOB_ENTRY_INDEX: u64 = 3;
/// Blink's `IDBValueWrapper` marker bytes.
const REQUIRES_PROCESSING: u8 = 0x11;
const REPLACE_WITH_BLOB: u8 = 0x01;
const COMPRESSED_WITH_SNAPPY: u8 = 0x02;

fn corrupt(what: impl Into<String>) -> MigrateError {
    MigrateError::Corrupt(format!("IndexedDB: {}", what.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Prefix {
    database: u64,
    store: u64,
    index: u64,
}

fn le_int(bytes: &[u8]) -> u64 {
    bytes.iter().rev().fold(0, |acc, &b| (acc << 8) | u64::from(b))
}

fn decode_prefix(key: &[u8]) -> Option<(Prefix, usize)> {
    let first = *key.first()?;
    let db_len = usize::from((first >> 5) & 7) + 1;
    let store_len = usize::from((first >> 2) & 7) + 1;
    let index_len = usize::from(first & 3) + 1;
    let total = 1 + db_len + store_len + index_len;
    if key.len() < total {
        return None;
    }
    let database = le_int(&key[1..1 + db_len]);
    let store = le_int(&key[1 + db_len..1 + db_len + store_len]);
    let index = le_int(&key[1 + db_len + store_len..total]);
    Some((Prefix { database, store, index }, total))
}

fn utf16_be(bytes: &[u8]) -> Result<String> {
    if !bytes.len().is_multiple_of(2) {
        return Err(corrupt("odd UTF-16 string"));
    }
    let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    String::from_utf16(&units).map_err(|_| corrupt("bad UTF-16 string"))
}

fn string_with_length(data: &[u8], pos: &mut usize) -> Result<String> {
    let units = varint(data, pos)? as usize;
    let end = pos.checked_add(units * 2).filter(|&e| e <= data.len()).ok_or_else(|| corrupt("truncated string"))?;
    let s = utf16_be(&data[*pos..end])?;
    *pos = end;
    Ok(s)
}

/// An IndexedDB key, as Markie's stores use them.
#[derive(Debug, Clone, PartialEq)]
pub enum IdbKey {
    String(String),
    Number(f64),
    Date(f64),
    Binary(Vec<u8>),
    Array(Vec<IdbKey>),
}

fn decode_key(data: &[u8], pos: &mut usize) -> Result<IdbKey> {
    let tag = *data.get(*pos).ok_or_else(|| corrupt("truncated key"))?;
    *pos += 1;
    let double = |pos: &mut usize| -> Result<f64> {
        let raw = data.get(*pos..*pos + 8).ok_or_else(|| corrupt("truncated number key"))?;
        *pos += 8;
        Ok(f64::from_le_bytes(raw.try_into().unwrap()))
    };
    Ok(match tag {
        1 => IdbKey::String(string_with_length(data, pos)?),
        2 => IdbKey::Date(double(pos)?),
        3 => IdbKey::Number(double(pos)?),
        4 => {
            let len = varint(data, pos)? as usize;
            let mut items = Vec::with_capacity(len.min(64));
            for _ in 0..len {
                items.push(decode_key(data, pos)?);
            }
            IdbKey::Array(items)
        }
        6 => {
            let len = varint(data, pos)? as usize;
            let raw = data.get(*pos..*pos + len).ok_or_else(|| corrupt("truncated binary key"))?;
            *pos += len;
            IdbKey::Binary(raw.to_vec())
        }
        other => return Err(MigrateError::Unsupported(format!("IndexedDB key type {other}"))),
    })
}

/// One stored external object (a blob file a large value was moved to).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ExternalObject {
    blob_number: u64,
    size: u64,
}

/// The blob list value. Chromium writes, per object: a type byte (0 blob,
/// 1 file, 2 file system access handle), the blob number, the MIME type, the
/// size, and for files a name and modification time. Only blobs are accepted:
/// Markie never stores files or handles.
fn decode_external_objects(data: &[u8]) -> Result<Vec<ExternalObject>> {
    let mut pos = 0;
    let mut out = Vec::new();
    while pos < data.len() {
        let kind = data[pos];
        pos += 1;
        if kind != 0 {
            return Err(MigrateError::Unsupported(format!("IndexedDB external object type {kind}")));
        }
        let blob_number = varint(data, &mut pos)?;
        string_with_length(data, &mut pos)?;
        let size = varint(data, &mut pos)?;
        out.push(ExternalObject { blob_number, size });
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct IdbRecord {
    pub key: IdbKey,
    pub value: JsValue,
    /// True when the value came from a blob file.
    pub from_blob: bool,
}

#[derive(Debug, Default)]
pub struct IdbDatabase {
    pub id: u64,
    /// Object store name to its records, in key order.
    pub stores: BTreeMap<String, Vec<IdbRecord>>,
}

#[derive(Debug, Default)]
pub struct IdbOrigin {
    /// Database name to contents, for the databases asked for.
    pub databases: BTreeMap<String, IdbDatabase>,
    /// Every database name found, asked for or not.
    pub all_database_names: Vec<String>,
    pub stats: ReadStats,
}

fn blob_path(blob_dir: &Path, database: u64, blob_number: u64) -> PathBuf {
    blob_dir.join(format!("{database:x}")).join(format!("{:02x}", (blob_number >> 8) & 0xff)).join(format!("{blob_number:x}"))
}

/// Unwraps Blink's IndexedDB value wrappers, then deserializes.
fn decode_value(mut bits: Vec<u8>, blobs: &[ExternalObject], blob_dir: &Path, database: u64) -> Result<(JsValue, bool)> {
    let mut from_blob = false;
    for _ in 0..3 {
        if bits.len() >= 3 && bits[0] == 0xff && bits[1] == REQUIRES_PROCESSING {
            match bits[2] {
                REPLACE_WITH_BLOB => {
                    let mut pos = 3;
                    let size = varint(&bits, &mut pos)?;
                    let index = varint(&bits, &mut pos)? as usize;
                    let object = blobs.get(index).ok_or_else(|| corrupt("wrapped value names a missing blob"))?;
                    if object.size != size {
                        return Err(corrupt("wrapped value size disagrees with its blob entry"));
                    }
                    let path = blob_path(blob_dir, database, object.blob_number);
                    let data = std::fs::read(&path).map_err(|e| MigrateError::Io(path.display().to_string(), e))?;
                    if data.len() as u64 != size {
                        return Err(corrupt("blob file size disagrees with its entry"));
                    }
                    bits = data;
                    from_blob = true;
                    continue;
                }
                COMPRESSED_WITH_SNAPPY => {
                    bits = snap::raw::Decoder::new().decompress_vec(&bits[3..]).map_err(|e| corrupt(format!("snappy value: {e}")))?;
                    continue;
                }
                other => return Err(MigrateError::Unsupported(format!("IndexedDB value wrapper {other}"))),
            }
        }
        return Ok((deserialize(&bits)?, from_blob));
    }
    Err(corrupt("value wrapped too many times"))
}

/// Reads one origin's IndexedDB from a copy: `<copy>/IndexedDB/<origin>.indexeddb.leveldb`
/// and its `.blob` sibling. Only the named databases are decoded.
pub fn read_origin(leveldb_dir: &Path, blob_dir: &Path, wanted: &[&str]) -> Result<IdbOrigin> {
    let snapshot = read_dir(leveldb_dir)?;
    let mut names: BTreeMap<u64, String> = BTreeMap::new();
    let mut store_names: BTreeMap<(u64, u64), String> = BTreeMap::new();
    for (key, value) in &snapshot.entries {
        let Some((prefix, mut pos)) = decode_prefix(key) else { continue };
        if prefix == (Prefix { database: 0, store: 0, index: 0 }) && key.get(pos) == Some(&DATABASE_NAME_TYPE) {
            pos += 1;
            let _origin = string_with_length(key, &mut pos)?;
            let name = string_with_length(key, &mut pos)?;
            names.insert(le_int(value), name);
        } else if prefix.database != 0 && prefix.store == 0 && prefix.index == 0 && key.get(pos) == Some(&OBJECT_STORE_META_TYPE) {
            pos += 1;
            let store = varint(key, &mut pos)?;
            if key.get(pos) == Some(&0) && pos + 1 == key.len() {
                store_names.insert((prefix.database, store), utf16_be(value)?);
            }
        }
    }
    let mut out = IdbOrigin { all_database_names: names.values().cloned().collect(), stats: snapshot.stats.clone(), ..Default::default() };
    for (&database, name) in &names {
        if !wanted.contains(&name.as_str()) {
            continue;
        }
        let mut db = IdbDatabase { id: database, ..Default::default() };
        let mut blob_lists: BTreeMap<(u64, Vec<u8>), Vec<ExternalObject>> = BTreeMap::new();
        for (key, value) in &snapshot.entries {
            let Some((prefix, pos)) = decode_prefix(key) else { continue };
            if prefix.database == database && prefix.store != 0 && prefix.index == BLOB_ENTRY_INDEX {
                blob_lists.insert((prefix.store, key[pos..].to_vec()), decode_external_objects(value)?);
            }
        }
        for (key, value) in &snapshot.entries {
            let Some((prefix, mut pos)) = decode_prefix(key) else { continue };
            if prefix.database != database || prefix.store == 0 || prefix.index != OBJECT_STORE_DATA_INDEX {
                continue;
            }
            let store = store_names.get(&(database, prefix.store)).cloned().ok_or_else(|| corrupt("record in an unnamed object store"))?;
            let key_bytes = key[pos..].to_vec();
            let idb_key = decode_key(key, &mut pos)?;
            let mut vpos = 0;
            varint(value, &mut vpos)?; // record version
            let blobs = blob_lists.get(&(prefix.store, key_bytes)).map(Vec::as_slice).unwrap_or(&[]);
            let (decoded, from_blob) = decode_value(value[vpos..].to_vec(), blobs, blob_dir, database)?;
            db.stores.entry(store).or_default().push(IdbRecord { key: idb_key, value: decoded, from_blob });
        }
        for (&(d, _), store) in &store_names {
            if d == database {
                db.stores.entry(store.clone()).or_default();
            }
        }
        out.databases.insert(name.clone(), db);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_and_keys() {
        // database 1, store 2, index 1: one byte each.
        let mut key = vec![0x00, 1, 2, 1];
        key.extend([1, 2, 0, b'i', 0, b'd']);
        let (prefix, pos) = decode_prefix(&key).unwrap();
        assert_eq!(prefix, Prefix { database: 1, store: 2, index: 1 });
        let mut p = pos;
        assert_eq!(decode_key(&key, &mut p).unwrap(), IdbKey::String("id".into()));
        let mut array = vec![4, 2, 1, 1, 0, b'a', 3];
        array.extend(2.0f64.to_le_bytes());
        let mut p = 0;
        assert_eq!(decode_key(&array, &mut p).unwrap(), IdbKey::Array(vec![IdbKey::String("a".into()), IdbKey::Number(2.0)]));
    }

    #[test]
    fn blob_paths_follow_chromium() {
        assert_eq!(blob_path(Path::new("b"), 1, 2), PathBuf::from("b/1/00/2"));
        assert_eq!(blob_path(Path::new("b"), 0x1a, 0x1234), PathBuf::from("b/1a/12/1234"));
    }
}
