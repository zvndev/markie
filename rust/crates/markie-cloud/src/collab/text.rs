//! The binding between a whole-string text editor and the room's Y.Text.
//! Indices are UTF-16 code units, like Yjs in the browser, so the document is
//! created with `OffsetKind::Utf16`.
use yrs::{Doc, GetString, OffsetKind, Options, Text, TextRef, Transact};

/// A Yjs document configured the way the web and phone clients index text.
pub fn new_doc() -> Doc {
    Doc::with_options(Options { offset_kind: OffsetKind::Utf16, ..Options::default() })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextDiff {
    pub index: u32,
    pub delete_count: u32,
    pub insert: String,
}

fn is_high(u: u16) -> bool {
    (0xd800..=0xdbff).contains(&u)
}
fn is_low(u: u16) -> bool {
    (0xdc00..=0xdfff).contains(&u)
}

/// The single-span edit that turns `prev` into `next`: common prefix, common
/// suffix, replace the middle. Never splits a surrogate pair.
pub fn diff_text(prev: &str, next: &str) -> Option<TextDiff> {
    if prev == next {
        return None;
    }
    let p: Vec<u16> = prev.encode_utf16().collect();
    let n: Vec<u16> = next.encode_utf16().collect();
    let mut prefix = 0;
    let max_prefix = p.len().min(n.len());
    while prefix < max_prefix && p[prefix] == n[prefix] {
        prefix += 1;
    }
    if prefix > 0 && prefix < p.len() && is_high(p[prefix - 1]) && is_low(p[prefix]) {
        prefix -= 1;
    }
    let mut suffix = 0;
    let max_suffix = (p.len() - prefix).min(n.len() - prefix);
    while suffix < max_suffix && p[p.len() - 1 - suffix] == n[n.len() - 1 - suffix] {
        suffix += 1;
    }
    if suffix > 0 {
        let at = p.len() - suffix;
        if at > prefix && is_low(p[at]) && is_high(p[at - 1]) {
            suffix -= 1;
        }
    }
    Some(TextDiff {
        index: prefix as u32,
        delete_count: (p.len() - prefix - suffix) as u32,
        insert: String::from_utf16_lossy(&n[prefix..n.len() - suffix]),
    })
}

/// Local edits go in as one span per change; remote edits come out as the
/// whole new string. `last` is the text both sides last agreed on.
///
/// Local edits are taken only once the room has synced. Before that the Y.Text
/// is empty while the editor shows the local file, and the first keystroke
/// would insert the entire file into the room.
pub struct TextBinding {
    text: TextRef,
    last: String,
    synced: bool,
}

impl TextBinding {
    pub fn new(doc: &Doc, text: TextRef) -> Self {
        let last = text.get_string(&doc.transact());
        Self { text, last, synced: false }
    }

    pub fn text(&self) -> &str {
        &self.last
    }

    pub fn synced(&self) -> bool {
        self.synced
    }

    pub fn mark_synced(&mut self, doc: &Doc) {
        self.synced = true;
        self.last = self.text.get_string(&doc.transact());
    }

    /// After a remote update: the new text when it changed.
    pub fn remote_changed(&mut self, doc: &Doc) -> Option<String> {
        let now = self.text.get_string(&doc.transact());
        if now == self.last {
            return None;
        }
        self.last = now.clone();
        Some(now)
    }

    /// Push one local whole-string edit. The merged room text, or None before sync.
    pub fn apply_local(&mut self, doc: &Doc, next: &str) -> Option<String> {
        if !self.synced {
            return None;
        }
        if let Some(op) = diff_text(&self.last, next) {
            let mut txn = doc.transact_mut();
            if op.delete_count > 0 {
                self.text.remove_range(&mut txn, op.index, op.delete_count);
            }
            if !op.insert.is_empty() {
                self.text.insert(&mut txn, op.index, &op.insert);
            }
        }
        self.last = self.text.get_string(&doc.transact());
        Some(self.last.clone())
    }

    /// Seed an empty room from the local file, inside the caller's transaction.
    pub fn seed_if_empty(&mut self, txn: &mut yrs::TransactionMut, text: &str) -> bool {
        if self.text.len(txn) > 0 || text.is_empty() {
            return false;
        }
        self.text.insert(txn, 0, text);
        self.last = self.text.get_string(txn);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, StateVector, Update};

    #[test]
    fn single_span_diffs() {
        assert_eq!(diff_text("abc", "abc"), None);
        assert_eq!(diff_text("hello world", "hello brave world"), Some(TextDiff { index: 6, delete_count: 0, insert: "brave ".into() }));
        assert_eq!(diff_text("abcdef", "abef"), Some(TextDiff { index: 2, delete_count: 2, insert: "".into() }));
        assert_eq!(diff_text("", "x"), Some(TextDiff { index: 0, delete_count: 0, insert: "x".into() }));
    }

    #[test]
    fn surrogate_pairs_travel_whole() {
        // 😀 U+1F600 and 😁 U+1F601 share their high surrogate.
        let d = diff_text("a😀b", "a😁b").unwrap();
        assert_eq!(d, TextDiff { index: 1, delete_count: 2, insert: "😁".into() });
        let d = diff_text("😀", "😀😀").unwrap();
        assert_eq!(d.insert, "😀");
    }

    #[test]
    fn two_bindings_merge_concurrent_edits() {
        let a = new_doc();
        let b = new_doc();
        let ta = a.get_or_insert_text("content");
        let tb = b.get_or_insert_text("content");
        let mut ba = TextBinding::new(&a, ta.clone());
        let mut bb = TextBinding::new(&b, tb.clone());
        assert_eq!(ba.apply_local(&a, "ignored"), None, "not synced yet");
        ba.mark_synced(&a);
        {
            let mut txn = a.transact_mut();
            assert!(ba.seed_if_empty(&mut txn, "one two three"));
        }
        let sync = |from: &Doc, to: &Doc| {
            let u = from.transact().encode_state_as_update_v1(&to.transact().state_vector());
            to.transact_mut().apply_update(Update::decode_v1(&u).unwrap()).unwrap();
        };
        sync(&a, &b);
        bb.mark_synced(&b);
        assert_eq!(bb.text(), "one two three");
        ba.apply_local(&a, "ONE two three");
        bb.apply_local(&b, "one two three 😀");
        sync(&a, &b);
        sync(&b, &a);
        assert_eq!(ba.remote_changed(&a).as_deref(), Some("ONE two three 😀"));
        assert_eq!(bb.remote_changed(&b).as_deref(), Some("ONE two three 😀"));
        let _ = StateVector::default();
    }
}
