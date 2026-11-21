//! Original, bounded implementation of Microsoft [MS-CFB], sections 2.2 to 2.7 and 2.9.
//! Provenance: public specification only; no document-engine implementation used.
//! <https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/53989ce4-7b05-4f8d-829b-d08d6148375b>
//! Ported from `cfb.ts` (reader) and `cfb-write.ts` (v3 root-stream writer).

use std::collections::{HashMap, HashSet};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CfbErrorCode {
    Malformed,
    Unsupported,
    Encrypted,
    LimitExceeded,
}

impl CfbErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Unsupported => "unsupported",
            Self::Encrypted => "encrypted",
            Self::LimitExceeded => "limit-exceeded",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CfbError {
    pub code: CfbErrorCode,
    pub message: String,
}

impl fmt::Display for CfbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for CfbError {}

pub(crate) fn fail<T>(code: CfbErrorCode, message: &str) -> Result<T, CfbError> {
    Err(CfbError { code, message: message.to_string() })
}
use CfbErrorCode::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CfbLimits {
    pub max_input_bytes: usize,
    pub max_sectors: usize,
    pub max_chain_sectors: usize,
    pub max_directory_entries: usize,
    pub max_stream_bytes: usize,
    /// Cumulative returned stream bytes, including repeated reads and the mini stream.
    pub max_total_stream_bytes: usize,
}

pub const DEFAULT_CFB_LIMITS: CfbLimits = CfbLimits {
    max_input_bytes: 64 * 1024 * 1024,
    max_sectors: 131072,
    max_chain_sectors: 65536,
    max_directory_entries: 16384,
    max_stream_bytes: 32 * 1024 * 1024,
    max_total_stream_bytes: 64 * 1024 * 1024,
};

impl Default for CfbLimits {
    fn default() -> Self {
        DEFAULT_CFB_LIMITS
    }
}

const SAFE_INTEGER: usize = (1usize << 53) - 1;

fn check_limits(limits: &CfbLimits) -> Result<(), CfbError> {
    let values = [
        limits.max_input_bytes,
        limits.max_sectors,
        limits.max_chain_sectors,
        limits.max_directory_entries,
        limits.max_stream_bytes,
        limits.max_total_stream_bytes,
    ];
    if values.iter().any(|v| *v > SAFE_INTEGER) {
        return fail(LimitExceeded, "CFB limits must be nonnegative safe integers.");
    }
    Ok(())
}

const FREE: u32 = 0xffff_ffff;
const END: u32 = 0xffff_fffe;
const FAT_SECTOR: u32 = 0xffff_fffd;
const DIFAT_SECTOR: u32 = 0xffff_fffc;
const SIGNATURE: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

#[derive(Clone, Debug)]
struct Entry {
    name: String,
    kind: u8,
    left: u32,
    right: u32,
    child: u32,
    start: u32,
    size: u64,
}

fn ascii_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| (1..=0x7f).contains(&b))
}
fn fold_ascii(name: &str) -> String {
    name.to_ascii_uppercase()
}

fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// A parsed container. Reads mutate its budgets, so they take `&mut self`.
pub struct CompoundFile {
    pub major_version: u16,
    root_stream_names: Vec<String>,
    bytes: Vec<u8>,
    sector_size: usize,
    sector_count: usize,
    fat: Vec<u32>,
    mini_fat: Vec<u32>,
    root: Entry,
    root_streams: HashMap<String, (Entry, usize)>,
    owners: HashMap<u32, String>,
    mini_stream: Option<Vec<u8>>,
    mini_owners: HashMap<u32, usize>,
    total_stream_bytes: usize,
    limits: CfbLimits,
}

impl CompoundFile {
    pub fn root_stream_names(&self) -> &[String] {
        &self.root_stream_names
    }

    fn sector(&self, id: u32) -> Result<&[u8], CfbError> {
        if (id as usize) >= self.sector_count {
            return fail(Malformed, "Sector points outside the compound file.");
        }
        let at = (id as usize + 1) * self.sector_size;
        Ok(&self.bytes[at..at + self.sector_size])
    }

    fn allocate(&mut self, size: usize) -> Result<Vec<u8>, CfbError> {
        if size > self.limits.max_stream_bytes || size > self.limits.max_total_stream_bytes - self.total_stream_bytes {
            return fail(LimitExceeded, "Stream exceeds the byte budget.");
        }
        self.total_stream_bytes += size;
        Ok(vec![0; size])
    }

    fn read_normal(&mut self, entry: &Entry, owner: &str) -> Result<Vec<u8>, CfbError> {
        if entry.size as usize > self.limits.max_stream_bytes {
            return fail(LimitExceeded, "Stream exceeds the byte budget.");
        }
        let ids = chain(
            entry.start,
            &self.fat,
            self.sector_count,
            Some((&mut self.owners, owner)),
            self.limits.max_chain_sectors,
        )?;
        let size = entry.size as usize;
        if ids.len() * self.sector_size < size {
            return fail(Malformed, "Truncated stream sector chain.");
        }
        let mut data = self.allocate(size)?;
        for (i, id) in ids.iter().enumerate() {
            let at = i * self.sector_size;
            if at < data.len() {
                let n = self.sector_size.min(data.len() - at);
                let sector = self.sector(*id)?;
                data[at..at + n].copy_from_slice(&sector[..n]);
            }
        }
        Ok(data)
    }

    /// ASCII case-insensitive root lookup only; nested storages are not searched.
    pub fn read_root_stream(&mut self, name: &str) -> Result<Vec<u8>, CfbError> {
        if !ascii_name(name) {
            return fail(Unsupported, "Only ASCII root stream names can be looked up by this reader.");
        }
        let Some((entry, id)) = self.root_streams.get(&fold_ascii(name)).cloned() else {
            return fail(Unsupported, "Requested root stream was not found.");
        };
        if entry.size >= 4096 {
            return self.read_normal(&entry, &format!("stream:{id}"));
        }
        if entry.size == 0 {
            if entry.start != END {
                return fail(Malformed, "Empty stream has an allocated starting sector.");
            }
            return self.allocate(0);
        }
        // [MS-CFB] 2.4: mini-sector byte offsets are id * 64 within the root mini stream.
        if self.mini_stream.is_none() {
            let root = self.root.clone();
            self.mini_stream = Some(self.read_normal(&root, "mini stream")?);
        }
        let mini_len = self.mini_stream.as_ref().map_or(0, Vec::len);
        let ids = chain(entry.start, &self.mini_fat, mini_len / 64, None, self.limits.max_chain_sectors)?;
        let size = entry.size as usize;
        if ids.len() * 64 < size {
            return fail(Malformed, "Truncated mini stream chain.");
        }
        for mini_id in &ids {
            if let Some(owner) = self.mini_owners.get(mini_id)
                && *owner != id
            {
                return fail(Malformed, "Mini stream chains overlap.");
            }
            self.mini_owners.insert(*mini_id, id);
        }
        let mut data = self.allocate(size)?;
        let mini = self.mini_stream.as_ref().expect("mini stream");
        for (i, mini_id) in ids.iter().enumerate() {
            let at = i * 64;
            if at < data.len() {
                let n = 64.min(data.len() - at);
                let from = *mini_id as usize * 64;
                data[at..at + n].copy_from_slice(&mini[from..from + n]);
            }
        }
        Ok(data)
    }
}

fn reserve(owners: &mut HashMap<u32, String>, sector_count: usize, id: u32, owner: &str) -> Result<(), CfbError> {
    if id as usize >= sector_count {
        return fail(Malformed, "Invalid allocated sector.");
    }
    if let Some(previous) = owners.get(&id)
        && previous != owner
    {
        return fail(Malformed, "Compound file sector chains overlap.");
    }
    owners.insert(id, owner.to_string());
    Ok(())
}

fn chain(
    start: u32,
    table: &[u32],
    available: usize,
    mut owners: Option<(&mut HashMap<u32, String>, &str)>,
    max_chain: usize,
) -> Result<Vec<u32>, CfbError> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut id = start;
    while id != END {
        if id as usize >= available || id as usize >= table.len() {
            return fail(Malformed, "Sector chain points outside its storage.");
        }
        if seen.contains(&id) {
            return fail(Malformed, "Sector chain cycle.");
        }
        if ids.len() >= max_chain {
            return fail(LimitExceeded, "Sector chain exceeds the traversal budget.");
        }
        if let Some((owners, owner)) = owners.as_mut() {
            reserve(owners, available, id, owner)?;
        }
        seen.insert(id);
        ids.push(id);
        id = table[id as usize];
    }
    Ok(ids)
}

/// Structural metadata is checked eagerly; user stream chains are checked on read.
pub fn read_compound_file(input: &[u8], limits: CfbLimits) -> Result<CompoundFile, CfbError> {
    check_limits(&limits)?;
    if input.len() > limits.max_input_bytes {
        return fail(LimitExceeded, "Compound file exceeds the input budget.");
    }
    if input.len() < 512 || input[..8] != SIGNATURE {
        return fail(Malformed, "Invalid compound file signature or truncated header.");
    }
    // Own a snapshot: later caller mutations must not change validated metadata.
    let bytes = input.to_vec();
    let major_version = le16(&bytes, 26);
    if major_version != 3 && major_version != 4 {
        return fail(Unsupported, "Only CFB versions 3 and 4 are supported.");
    }
    // [MS-CFB] 2.2: fixed little endian, 512/4096-byte sectors, 64-byte mini sectors.
    if le16(&bytes, 28) != 0xfffe
        || le16(&bytes, 30) != if major_version == 3 { 9 } else { 12 }
        || le16(&bytes, 32) != 6
        || le32(&bytes, 56) != 4096
    {
        return fail(Malformed, "Invalid compound file sector parameters.");
    }
    let sector_size = if major_version == 3 { 512 } else { 4096 };
    if bytes.len() < sector_size * 3 || !bytes.len().is_multiple_of(sector_size) {
        return fail(Malformed, "Truncated or unaligned compound file.");
    }
    if bytes[8..24].iter().any(|v| *v != 0)
        || bytes[34..40].iter().any(|v| *v != 0)
        || (major_version == 4 && bytes[512..4096].iter().any(|v| *v != 0))
    {
        return fail(Malformed, "Invalid reserved header bytes.");
    }
    let sector_count = bytes.len() / sector_size - 1;
    if sector_count > limits.max_sectors {
        return fail(LimitExceeded, "Compound file exceeds the sector budget.");
    }
    let sector_at = |id: u32| -> Result<&[u8], CfbError> {
        if id as usize >= sector_count {
            return fail(Malformed, "Sector points outside the compound file.");
        }
        let at = (id as usize + 1) * sector_size;
        Ok(&bytes[at..at + sector_size])
    };
    let directory_count = le32(&bytes, 40) as usize;
    let fat_count = le32(&bytes, 44) as usize;
    let mini_fat_count = le32(&bytes, 64) as usize;
    let difat_count = le32(&bytes, 72) as usize;
    if major_version == 3 && directory_count != 0 {
        return fail(Malformed, "Version 3 directory sector count must be zero.");
    }
    for count in [fat_count, mini_fat_count, difat_count, directory_count] {
        if count > sector_count {
            return fail(Malformed, "Metadata sector count exceeds the file.");
        }
        if count > limits.max_chain_sectors {
            return fail(LimitExceeded, "Metadata exceeds the chain budget.");
        }
    }
    if fat_count == 0 {
        return fail(Malformed, "Missing FAT.");
    }
    let mut owners: HashMap<u32, String> = HashMap::new();
    // [MS-CFB] 2.5: 109 header entries, then sectorSize/4 - 1 entries per DIFAT sector.
    let mut fat_ids: Vec<u32> = Vec::new();
    let mut seen_fat: HashSet<u32> = HashSet::new();
    let mut add_fat = |id: u32, owners: &mut HashMap<u32, String>| -> Result<(), CfbError> {
        if id == FREE {
            return Ok(());
        }
        if fat_ids.len() >= fat_count || seen_fat.contains(&id) {
            return fail(Malformed, "Invalid or duplicate DIFAT entry.");
        }
        reserve(owners, sector_count, id, "FAT")?;
        seen_fat.insert(id);
        fat_ids.push(id);
        Ok(())
    };
    for i in 0..109 {
        add_fat(le32(&bytes, 76 + 4 * i), &mut owners)?;
    }
    let mut difat = le32(&bytes, 68);
    let mut difat_ids: Vec<u32> = Vec::new();
    for _ in 0..difat_count {
        if difat_ids.contains(&difat) {
            return fail(Malformed, "DIFAT cycle.");
        }
        reserve(&mut owners, sector_count, difat, "DIFAT")?;
        difat_ids.push(difat);
        let d = sector_at(difat)?;
        for j in 0..sector_size / 4 - 1 {
            add_fat(le32(d, j * 4), &mut owners)?;
        }
        difat = le32(d, sector_size - 4);
    }
    if difat != END || fat_ids.len() != fat_count {
        return fail(Malformed, "DIFAT count or termination mismatch.");
    }
    let per = sector_size / 4;
    let mut fat = vec![0u32; fat_count * per];
    for (i, id) in fat_ids.iter().enumerate() {
        let d = sector_at(*id)?;
        for j in 0..per {
            fat[i * per + j] = le32(d, j * 4);
        }
    }
    if fat.len() < sector_count {
        return fail(Malformed, "FAT does not cover the file.");
    }
    if fat_ids.iter().any(|id| fat[*id as usize] != FAT_SECTOR) {
        return fail(Malformed, "FAT sector is not marked FATSECT.");
    }
    if difat_ids.iter().any(|id| fat[*id as usize] != DIFAT_SECTOR) {
        return fail(Malformed, "DIFAT sector is not marked DIFSECT.");
    }
    if fat[sector_count..].iter().any(|v| *v != FREE) {
        return fail(Malformed, "FAT allocates beyond end of file.");
    }
    let directory_ids = chain(
        le32(&bytes, 48),
        &fat,
        sector_count,
        Some((&mut owners, "directory")),
        limits.max_chain_sectors,
    )?;
    if directory_ids.is_empty() || (major_version == 4 && directory_ids.len() != directory_count) {
        return fail(Malformed, "Directory sector count mismatch.");
    }
    let entry_count = directory_ids.len() * sector_size / 128;
    if entry_count > limits.max_directory_entries {
        return fail(LimitExceeded, "Directory exceeds the entry budget.");
    }
    let mut entries: Vec<Entry> = Vec::with_capacity(entry_count);
    // [MS-CFB] 2.6.1: 128-byte entries, name + length/type at 64/66, pointers at 68/72/76.
    for id in &directory_ids {
        let d = sector_at(*id)?;
        for at in (0..sector_size).step_by(128) {
            let kind = d[at + 66];
            if ![0, 1, 2, 5].contains(&kind) {
                return fail(Malformed, "Invalid directory object type.");
            }
            let mut name = String::new();
            if kind != 0 {
                let length = le16(d, at + 64) as usize;
                if !(2..=64).contains(&length) || !length.is_multiple_of(2) || le16(d, at + length - 2) != 0 || d[at + 67] > 1 {
                    return fail(Malformed, "Invalid directory entry name or color.");
                }
                let units: Vec<u16> = (0..length - 2).step_by(2).map(|p| le16(d, at + p)).collect();
                name = String::from_utf16_lossy(&units);
                if name.is_empty() || name.contains(['\0', '/', '\\', ':', '!']) {
                    return fail(Malformed, "Invalid storage or stream name.");
                }
            }
            let low = le32(d, at + 120) as u64;
            let high = le32(d, at + 124) as u64;
            // [MS-CFB] 2.6.3: ignore the historically uninitialized high DWORD in v3.
            let size = low + if major_version == 4 { high << 32 } else { 0 };
            if size > SAFE_INTEGER as u64 {
                return fail(LimitExceeded, "Stream size exceeds safe integer precision.");
            }
            entries.push(Entry {
                name,
                kind,
                left: le32(d, at + 68),
                right: le32(d, at + 72),
                child: le32(d, at + 76),
                start: le32(d, at + 116),
                size,
            });
        }
    }
    let root = entries[0].clone();
    if root.kind != 5 || root.name != "Root Entry" || root.left != FREE || root.right != FREE {
        return fail(Malformed, "Missing or invalid root directory entry.");
    }
    let mut root_streams: HashMap<String, (Entry, usize)> = HashMap::new();
    let mut root_stream_names = Vec::new();
    let mut sibling_names: HashMap<usize, HashSet<String>> = HashMap::new();
    let mut seen_entries: HashSet<usize> = HashSet::from([0]);
    let mut pending: Vec<(u32, usize)> = vec![(root.child, 0)];
    while let Some((id, parent)) = pending.pop() {
        if id == FREE {
            continue;
        }
        let id = id as usize;
        if id >= entries.len() || seen_entries.contains(&id) {
            return fail(Malformed, "Invalid or cyclic directory tree.");
        }
        seen_entries.insert(id);
        let entry = &entries[id];
        if entry.kind != 1 && entry.kind != 2 {
            return fail(Malformed, "Directory references a non-object entry.");
        }
        // [MS-CFB] 2.6.4 uniqueness applies to every sibling object, not only streams.
        let key = if ascii_name(&entry.name) { fold_ascii(&entry.name) } else { entry.name.clone() };
        if !sibling_names.entry(parent).or_default().insert(key.clone()) {
            return fail(Malformed, "Duplicate sibling directory name.");
        }
        pending.push((entry.left, parent));
        pending.push((entry.right, parent));
        if entry.kind == 1 {
            pending.push((entry.child, id));
        } else if entry.child != FREE {
            return fail(Malformed, "Stream directory entry has children.");
        }
        if parent == 0 && entry.kind == 2
            && root_streams.insert(key, (entry.clone(), id)).is_none() {
                root_stream_names.push(entry.name.clone());
            }
    }
    for (i, entry) in entries.iter().enumerate().skip(1) {
        if entry.kind != 0 && !seen_entries.contains(&i) {
            return fail(Malformed, "Unreachable directory object.");
        }
    }
    let mini_fat_ids = chain(
        le32(&bytes, 60),
        &fat,
        sector_count,
        Some((&mut owners, "miniFAT")),
        limits.max_chain_sectors,
    )?;
    if mini_fat_ids.len() != mini_fat_count {
        return fail(Malformed, "MiniFAT count mismatch.");
    }
    let mut mini_fat = vec![0u32; mini_fat_count * per];
    for (i, id) in mini_fat_ids.iter().enumerate() {
        let d = sector_at(*id)?;
        for j in 0..per {
            mini_fat[i * per + j] = le32(d, j * 4);
        }
    }
    Ok(CompoundFile {
        major_version,
        root_stream_names,
        bytes,
        sector_size,
        sector_count,
        fat,
        mini_fat,
        root,
        root_streams,
        owners,
        mini_stream: None,
        mini_owners: HashMap::new(),
        total_stream_bytes: 0,
        limits,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CfbWriteStream {
    pub name: String,
    pub data: Vec<u8>,
}

/// Creates a new, deterministic v3 container with root streams only, named
/// with 1 to 31 ASCII code units. Limits include metadata and padded entries.
/// `max_total_stream_bytes` covers all payloads plus the root mini stream once,
/// so every output stream can be read once under the same reader limits.
pub fn write_compound_file(streams: &[CfbWriteStream], limits: CfbLimits) -> Result<Vec<u8>, CfbError> {
    const SECTOR: usize = 512;
    const MINI: usize = 64;
    const CUTOFF: usize = 4096;
    check_limits(&limits)?;
    let directory_count = (streams.len() + 1).div_ceil(4);
    if directory_count * 4 > limits.max_directory_entries {
        return fail(LimitExceeded, "Directory exceeds the entry budget.");
    }
    struct Item<'a> {
        name: &'a str,
        key: String,
        data: &'a [u8],
        count: usize,
        start: u32,
    }
    let (mut mini_count, mut normal_count, mut total_bytes) = (0usize, 0usize, 0usize);
    let mut names = HashSet::new();
    let mut ordered: Vec<Item> = Vec::with_capacity(streams.len());
    for stream in streams {
        let name = stream.name.as_str();
        if name.is_empty() || name.encode_utf16().count() > 31 || name.contains(['\0', '/', '\\', ':', '!']) {
            return fail(Malformed, "Invalid CFB stream name.");
        }
        if !ascii_name(name) {
            return fail(Unsupported, "Only ASCII root stream names can be written.");
        }
        let key = fold_ascii(name);
        if !names.insert(key.clone()) {
            return fail(Malformed, "Duplicate root stream name.");
        }
        let data = stream.data.as_slice();
        if data.len() > limits.max_stream_bytes || data.len() >= 0x8000_0000 {
            return fail(LimitExceeded, "Stream exceeds the byte budget.");
        }
        if data.len() > limits.max_total_stream_bytes - total_bytes {
            return fail(LimitExceeded, "Streams exceed the cumulative byte budget.");
        }
        total_bytes += data.len();
        let small = data.len() < CUTOFF;
        let count = data.len().div_ceil(if small { MINI } else { SECTOR });
        if count > limits.max_chain_sectors {
            return fail(LimitExceeded, "Stream exceeds the chain budget.");
        }
        if small {
            mini_count += count;
        } else {
            normal_count += count;
        }
        ordered.push(Item { name, key, data, count, start: END });
    }
    ordered.sort_by(|a, b| a.key.len().cmp(&b.key.len()).then_with(|| a.key.cmp(&b.key)));
    let mini_bytes = mini_count * MINI;
    let mini_root_count = mini_bytes.div_ceil(SECTOR);
    let mini_fat_count = mini_count.div_ceil(128);
    if mini_bytes > limits.max_stream_bytes || mini_bytes >= 0x8000_0000 || total_bytes + mini_bytes > limits.max_total_stream_bytes {
        return fail(LimitExceeded, "Streams exceed the cumulative byte budget.");
    }
    let base_count = directory_count + mini_fat_count + mini_root_count + normal_count;
    // FAT must cover itself and DIFAT too. The monotone fixed point terminates quickly.
    let (mut fat_count, mut difat_count) = (1usize, 0usize);
    loop {
        let next_fat = (base_count + fat_count + difat_count).div_ceil(128);
        let next_difat = next_fat.saturating_sub(109).div_ceil(127);
        if next_fat == fat_count && next_difat == difat_count {
            break;
        }
        fat_count = next_fat;
        difat_count = next_difat;
    }
    let sector_count = base_count + fat_count + difat_count;
    let output_bytes = (sector_count + 1) * SECTOR;
    if output_bytes > limits.max_input_bytes || output_bytes > 0x8000_0000 || sector_count > limits.max_sectors {
        return fail(LimitExceeded, "Compound file exceeds the output budget.");
    }
    for count in [directory_count, mini_fat_count, mini_root_count, fat_count, difat_count] {
        if count > limits.max_chain_sectors {
            return fail(LimitExceeded, "Metadata exceeds the chain budget.");
        }
    }
    let mut bytes = vec![0u8; output_bytes];
    fn w16(b: &mut [u8], at: usize, v: u32) {
        b[at..at + 2].copy_from_slice(&(v as u16).to_le_bytes());
    }
    fn w32(b: &mut [u8], at: usize, v: u32) {
        b[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
    let offset = |id: usize| (id + 1) * SECTOR;
    let directory_at = fat_count + difat_count;
    let mini_fat_at = directory_at + directory_count;
    let mini_root_at = mini_fat_at + mini_fat_count;
    let mut normal_at = mini_root_at + mini_root_count;
    let mut mini_at = 0usize;
    let set_fat = |b: &mut [u8], id: usize, value: u32| w32(b, offset(id / 128) + (id % 128) * 4, value);
    let link = |b: &mut [u8], start: usize, count: usize| {
        for i in 0..count {
            set_fat(b, start + i, if i + 1 == count { END } else { (start + i + 1) as u32 });
        }
    };
    bytes[..8].copy_from_slice(&SIGNATURE);
    w16(&mut bytes, 24, 0x3e);
    w16(&mut bytes, 26, 3);
    w16(&mut bytes, 28, 0xfffe);
    w16(&mut bytes, 30, 9);
    w16(&mut bytes, 32, 6);
    w32(&mut bytes, 44, fat_count as u32);
    w32(&mut bytes, 48, directory_at as u32);
    w32(&mut bytes, 56, CUTOFF as u32);
    w32(&mut bytes, 60, if mini_fat_count > 0 { mini_fat_at as u32 } else { END });
    w32(&mut bytes, 64, mini_fat_count as u32);
    w32(&mut bytes, 68, if difat_count > 0 { fat_count as u32 } else { END });
    w32(&mut bytes, 72, difat_count as u32);
    for i in 0..109 {
        w32(&mut bytes, 76 + i * 4, if i < fat_count { i as u32 } else { FREE });
    }
    for i in 0..fat_count * 128 {
        w32(&mut bytes, SECTOR + i * 4, FREE);
    }
    for i in 0..fat_count {
        set_fat(&mut bytes, i, FAT_SECTOR);
    }
    for i in 0..difat_count {
        let id = fat_count + i;
        set_fat(&mut bytes, id, DIFAT_SECTOR);
        for j in 0..127 {
            let fat_id = 109 + i * 127 + j;
            w32(&mut bytes, offset(id) + j * 4, if fat_id < fat_count { fat_id as u32 } else { FREE });
        }
        w32(&mut bytes, offset(id) + 508, if i + 1 == difat_count { END } else { (id + 1) as u32 });
    }
    link(&mut bytes, directory_at, directory_count);
    link(&mut bytes, mini_fat_at, mini_fat_count);
    link(&mut bytes, mini_root_at, mini_root_count);
    for i in 0..mini_fat_count * 128 {
        w32(&mut bytes, offset(mini_fat_at) + i * 4, FREE);
    }
    for stream in ordered.iter_mut() {
        if stream.data.len() >= CUTOFF {
            stream.start = normal_at as u32;
            link(&mut bytes, normal_at, stream.count);
            let at = offset(normal_at);
            bytes[at..at + stream.data.len()].copy_from_slice(stream.data);
            normal_at += stream.count;
        } else if stream.count > 0 {
            stream.start = mini_at as u32;
            for i in 0..stream.count {
                let value = if i + 1 == stream.count { END } else { (mini_at + i + 1) as u32 };
                w32(&mut bytes, offset(mini_fat_at) + (mini_at + i) * 4, value);
            }
            let at = offset(mini_root_at) + mini_at * MINI;
            bytes[at..at + stream.data.len()].copy_from_slice(stream.data);
            mini_at += stream.count;
        }
    }
    let entry_offset = |id: usize| offset(directory_at) + id * 128;
    // All unallocated directory entries have zero fields except absent pointers.
    for i in 0..directory_count * 4 {
        let at = entry_offset(i);
        w32(&mut bytes, at + 68, FREE);
        w32(&mut bytes, at + 72, FREE);
        w32(&mut bytes, at + 76, FREE);
    }
    let entry = |b: &mut [u8], id: usize, name: &str, kind: u8, start: u32, size: usize| {
        let at = entry_offset(id);
        let units: Vec<u16> = name.encode_utf16().collect();
        for (i, unit) in units.iter().enumerate() {
            w16(b, at + i * 2, *unit as u32);
        }
        w16(b, at + 64, ((units.len() + 1) * 2) as u32);
        b[at + 66] = kind;
        b[at + 67] = 1;
        w32(b, at + 116, start);
        w32(b, at + 120, size as u32);
    };
    entry(&mut bytes, 0, "Root Entry", 5, if mini_root_count > 0 { mini_root_at as u32 } else { END }, mini_bytes);
    for (i, stream) in ordered.iter().enumerate() {
        entry(&mut bytes, i + 1, stream.name, 2, stream.start, stream.data.len());
    }
    // Median split balances siblings. Only the incomplete bottom level is red,
    // keeping equal black heights and preventing adjacent red nodes [2.6.4].
    let red_depth = (ordered.len() + 1).ilog2() as usize;
    fn tree(b: &mut [u8], lo: isize, hi: isize, depth: usize, red_depth: usize, entry_offset: &dyn Fn(usize) -> usize) -> u32 {
        if lo > hi {
            return FREE;
        }
        let mid = (lo + hi).div_euclid(2);
        let id = (mid + 1) as usize;
        let at = entry_offset(id);
        b[at + 67] = if depth == red_depth { 0 } else { 1 };
        let left = tree(b, lo, mid - 1, depth + 1, red_depth, entry_offset);
        w32(b, at + 68, left);
        let right = tree(b, mid + 1, hi, depth + 1, red_depth, entry_offset);
        w32(b, at + 72, right);
        id as u32
    }
    let root_child = tree(&mut bytes, 0, ordered.len() as isize - 1, 0, red_depth, &entry_offset);
    w32(&mut bytes, entry_offset(0) + 76, root_child);
    Ok(bytes)
}
