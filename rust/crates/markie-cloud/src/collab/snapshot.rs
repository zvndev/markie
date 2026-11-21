//! Writing a live room's text back as the stored copy. The text-room half of
//! src/lib/live-snapshot.ts: who writes, the `storedCopy` record in the room's
//! meta map, and the 409 rules that keep a room from saving over an outside edit.
use crate::collab::META_MAP;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use yrs::{Any, Doc, Map, Out, Transact};

/// The awareness field a client sets when it may write the stored copy.
pub const SNAPSHOT_WRITER_FIELD: &str = "markieSnapshotWriter";
/// The key in the room's meta map.
pub const STORED_RECORD_KEY: &str = "storedCopy";

/// The exact 53-bit fingerprint src/lib/live-snapshot.ts computes, in base 36.
pub fn text_fingerprint(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let len = units.len() as u32;
    let mut h1: u32 = 0xdeadbeef ^ len;
    let mut h2: u32 = 0x41c6ce57 ^ len;
    for ch in units {
        h1 = (h1 ^ ch as u32).wrapping_mul(2654435761);
        h2 = (h2 ^ ch as u32).wrapping_mul(1597334677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2246822507) ^ (h2 ^ (h2 >> 13)).wrapping_mul(3266489909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2246822507) ^ (h1 ^ (h1 >> 13)).wrapping_mul(3266489909);
    let value = 4294967296u64 * (2097151 & h2) as u64 + h1 as u64;
    to_base36(value)
}

fn to_base36(mut v: u64) -> String {
    if v == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while v > 0 {
        out.push(digits[(v % 36) as usize]);
        v /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// The client that writes the stored copy: the lowest id that offered to.
pub fn snapshot_writer<'a>(states: impl IntoIterator<Item = (u64, &'a serde_json::Value)>) -> Option<u64> {
    states
        .into_iter()
        .filter(|(_, s)| s.get(SNAPSHOT_WRITER_FIELD).and_then(serde_json::Value::as_bool) == Some(true))
        .map(|(id, _)| id)
        .min()
}

/// The stored copy a room last knew about: its version and fingerprint, and
/// the fingerprint of a write in flight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRecord {
    pub version: i64,
    pub hash: String,
    pub next: Option<String>,
}

pub fn read_stored_record(doc: &Doc) -> Option<StoredRecord> {
    let meta = doc.get_or_insert_map(META_MAP);
    let txn = doc.transact();
    let Some(Out::Any(Any::Map(m))) = meta.get(&txn, STORED_RECORD_KEY) else { return None };
    let version = match m.get("version")? {
        Any::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))?,
        _ => return None,
    };
    let hash = match m.get("hash")? {
        Any::String(s) => s.to_string(),
        _ => return None,
    };
    let next = match m.get("next") {
        Some(Any::String(s)) => Some(s.to_string()),
        _ => None,
    };
    Some(StoredRecord { version, hash, next })
}

/// Write the record unless it already says exactly this.
pub fn write_stored_record(doc: &Doc, record: &StoredRecord) {
    if read_stored_record(doc).as_ref() == Some(record) {
        return;
    }
    let meta = doc.get_or_insert_map(META_MAP);
    let mut m = std::collections::HashMap::new();
    m.insert("version".to_string(), Any::from(record.version));
    m.insert("hash".to_string(), Any::from(record.hash.clone()));
    m.insert("next".to_string(), record.next.clone().map(Any::from).unwrap_or(Any::Null));
    meta.insert(&mut doc.transact_mut(), STORED_RECORD_KEY, Any::Map(Arc::new(m)));
}

/// Whether the record vouches for the stored copy: the same version and text,
/// or a later version whose text is the write the record was making.
pub fn record_covers(record: Option<&StoredRecord>, stored_content: &str, stored_version: i64) -> bool {
    let Some(r) = record else { return false };
    let hash = text_fingerprint(stored_content);
    if stored_version == r.version && hash == r.hash {
        return true;
    }
    r.next.as_deref() == Some(hash.as_str()) && stored_version > r.version
}

/// How the room's text relates to the stored copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveBase {
    /// The same text.
    RoomState,
    /// The room moved on from a stored copy it knows.
    Ahead,
    /// Someone saved outside the room. Never save over it.
    Diverged,
}

pub fn classify_text_room(room_text: &str, stored_content: &str, stored_version: i64, record: Option<&StoredRecord>) -> LiveBase {
    if room_text == stored_content {
        return LiveBase::RoomState;
    }
    if record_covers(record, stored_content, stored_version) { LiveBase::Ahead } else { LiveBase::Diverged }
}

/// The texts this client has seen in the room, newest last, bounded.
pub struct RoomTexts {
    seen: VecDeque<String>,
    set: HashSet<String>,
    limit: usize,
}

impl Default for RoomTexts {
    fn default() -> Self {
        Self::new(512)
    }
}

impl RoomTexts {
    pub fn new(limit: usize) -> Self {
        Self { seen: VecDeque::new(), set: HashSet::new(), limit }
    }
    pub fn add(&mut self, text: &str) {
        let k = text_fingerprint(text);
        if self.set.contains(&k) {
            self.seen.retain(|x| *x != k);
        }
        self.set.insert(k.clone());
        self.seen.push_back(k);
        while self.seen.len() > self.limit {
            if let Some(old) = self.seen.pop_front() {
                self.set.remove(&old);
            }
        }
    }
    pub fn has(&self, text: &str) -> bool {
        self.set.contains(&text_fingerprint(text))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveConflictAnswer {
    /// The server already holds exactly this: take its version.
    Adopt,
    /// A state of this room: save the room's text over it.
    Write,
    /// Written from outside the room: stop and ask.
    Conflict,
}

pub fn resolve_live_conflict(server: (&str, &str), mine: (&str, &str), room: &RoomTexts) -> LiveConflictAnswer {
    let ((s_content, s_name), (m_content, m_name)) = (server, mine);
    if s_content == m_content && s_name == m_name {
        return LiveConflictAnswer::Adopt;
    }
    if s_name == m_name && room.has(s_content) {
        return LiveConflictAnswer::Write;
    }
    LiveConflictAnswer::Conflict
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveSnapshotResult {
    Saved { version: i64 },
    Conflict { server_version: Option<i64> },
}

/// How a snapshot write reaches the server.
pub trait SnapshotIo {
    /// `Ok(version)`, `Err(None)` for a 409, `Err(Some(message))` for anything else.
    fn save(&mut self, content: &str, base_version: i64) -> impl std::future::Future<Output = Result<i64, Option<String>>>;
    /// The stored copy: `(content, name, version)`.
    fn read(&mut self) -> impl std::future::Future<Output = Option<(String, String, i64)>>;
}

/// Save the room's text, and on a 409 decide whether the server's copy is one
/// of this room's states (save over it) or an outside edit (stop).
pub async fn write_live_snapshot<I: SnapshotIo>(io: &mut I, content: &str, name: &str, version: i64, room: &mut RoomTexts, doc: Option<&Doc>) -> Result<LiveSnapshotResult, String> {
    let hash = text_fingerprint(content);
    let before = doc.and_then(read_stored_record);
    if let Some(d) = doc {
        write_stored_record(d, &StoredRecord { version: before.as_ref().map(|b| b.version).unwrap_or(version), hash: before.as_ref().map(|b| b.hash.clone()).unwrap_or_default(), next: Some(hash.clone()) });
    }
    let landed = |v: i64, room: &mut RoomTexts| {
        room.add(content);
        if let Some(d) = doc {
            write_stored_record(d, &StoredRecord { version: v, hash: hash.clone(), next: None });
        }
        LiveSnapshotResult::Saved { version: v }
    };
    match io.save(content, version).await {
        Ok(v) => return Ok(landed(v, room)),
        Err(Some(e)) => return Err(e),
        Err(None) => {}
    }
    let Some((s_content, s_name, s_version)) = io.read().await else { return Ok(LiveSnapshotResult::Conflict { server_version: None }) };
    match resolve_live_conflict((&s_content, &s_name), (content, name), room) {
        LiveConflictAnswer::Adopt => Ok(landed(s_version, room)),
        LiveConflictAnswer::Conflict => Ok(LiveSnapshotResult::Conflict { server_version: Some(s_version) }),
        LiveConflictAnswer::Write => match io.save(content, s_version).await {
            Ok(v) => Ok(landed(v, room)),
            Err(None) => Ok(LiveSnapshotResult::Conflict { server_version: None }),
            Err(Some(e)) => Err(e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fingerprints_match_the_js() {
        // Reference values computed with src/lib/live-snapshot.ts textFingerprint.
        assert_eq!(text_fingerprint(""), "wvjl67o803");
        assert_eq!(text_fingerprint("hello"), "25ee6eppygw");
        assert_eq!(text_fingerprint("héllo 😀"), "mfoe9xh814");
        assert_eq!(text_fingerprint("# Title\n\nBody text\n"), "13ps845yro7");
    }

    #[test]
    fn the_lowest_offering_client_writes() {
        let a = json!({ "markieSnapshotWriter": true });
        let b = json!({ "markieSnapshotWriter": false });
        let c = json!({ "user": { "name": "x" } });
        assert_eq!(snapshot_writer([(9, &a), (3, &b), (5, &a), (1, &c)]), Some(5));
        assert_eq!(snapshot_writer([(3, &b)]), None);
    }

    #[test]
    fn stored_record_round_trips_in_the_meta_map() {
        let doc = crate::collab::text::new_doc();
        assert_eq!(read_stored_record(&doc), None);
        let r = StoredRecord { version: 3, hash: "abc".into(), next: None };
        write_stored_record(&doc, &r);
        assert_eq!(read_stored_record(&doc), Some(r.clone()));
        assert!(record_covers(Some(&r), "x", 3) == (text_fingerprint("x") == "abc"));
        let ahead = StoredRecord { version: 3, hash: "old".into(), next: Some(text_fingerprint("new")) };
        assert!(record_covers(Some(&ahead), "new", 4));
        assert!(!record_covers(Some(&ahead), "new", 3));
        assert_eq!(classify_text_room("a", "a", 1, None), LiveBase::RoomState);
        assert_eq!(classify_text_room("a", "b", 1, None), LiveBase::Diverged);
        assert_eq!(classify_text_room("room", "new", 4, Some(&ahead)), LiveBase::Ahead);
    }

    struct FakeIo {
        server: (String, String, i64),
        saves: Vec<i64>,
    }
    impl SnapshotIo for FakeIo {
        async fn save(&mut self, content: &str, base: i64) -> Result<i64, Option<String>> {
            self.saves.push(base);
            if base != self.server.2 {
                return Err(None);
            }
            self.server = (content.into(), self.server.1.clone(), base + 1);
            Ok(base + 1)
        }
        async fn read(&mut self) -> Option<(String, String, i64)> {
            Some(self.server.clone())
        }
    }

    #[tokio::test]
    async fn a_409_from_this_rooms_own_state_is_written_over() {
        let mut room = RoomTexts::default();
        room.add("v1 text");
        let mut io = FakeIo { server: ("v1 text".into(), "a.txt".into(), 5), saves: vec![] };
        let doc = crate::collab::text::new_doc();
        let r = write_live_snapshot(&mut io, "v2 text", "a.txt", 4, &mut room, Some(&doc)).await.unwrap();
        assert_eq!(r, LiveSnapshotResult::Saved { version: 6 });
        assert_eq!(io.saves, vec![4, 5]);
        assert_eq!(read_stored_record(&doc), Some(StoredRecord { version: 6, hash: text_fingerprint("v2 text"), next: None }));
    }

    #[tokio::test]
    async fn a_409_from_an_outside_edit_stops() {
        let mut room = RoomTexts::default();
        let mut io = FakeIo { server: ("someone else".into(), "a.txt".into(), 5), saves: vec![] };
        let r = write_live_snapshot(&mut io, "mine", "a.txt", 4, &mut room, None).await.unwrap();
        assert_eq!(r, LiveSnapshotResult::Conflict { server_version: Some(5) });
        let mut io = FakeIo { server: ("mine".into(), "a.txt".into(), 5), saves: vec![] };
        assert_eq!(write_live_snapshot(&mut io, "mine", "a.txt", 4, &mut room, None).await.unwrap(), LiveSnapshotResult::Saved { version: 5 });
    }
}
