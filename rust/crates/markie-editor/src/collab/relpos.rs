//! Y.RelativePosition JSON, exactly as yjs writes and reads it.
//!
//! yjs keeps a relative position as `{type, tname, item, assoc}`: the type
//! that holds it (by its item id, or by root name), the item it sticks to,
//! and which side it leans to. Comment anchors are stored through
//! `Y.relativePositionToJSON`, which leaves out the empty fields. Cursors go
//! through awareness, which is `JSON.stringify` of the object itself, so all
//! four keys are there with nulls. `Y.createRelativePositionFromJSON` reads
//! both. yrs calls the same thing a `StickyIndex`; this module converts.
use serde_json::{Map, Value, json};
use yrs::block::ClientID;
use yrs::branch::BranchID;
use yrs::{Assoc, ID, IndexScope, StickyIndex};

fn id_json(id: &ID) -> Value {
    json!({ "client": id.client.get(), "clock": id.clock })
}

fn id_from(v: &Value) -> Option<ID> {
    let client = v.get("client")?.as_u64().or_else(|| v.get("client")?.as_f64().map(|f| f as u64))?;
    let clock = v.get("clock")?.as_u64().or_else(|| v.get("clock")?.as_f64().map(|f| f as u64))?;
    Some(ID::new(ClientID::new(client), clock as u32))
}

fn assoc_num(a: Assoc) -> i64 {
    match a {
        Assoc::After => 0,
        Assoc::Before => -1,
    }
}

/// The parts yjs keeps. `parent` is the type that holds an item position;
/// yjs records it alongside the item (`createRelativePosition(type, item)`).
fn parts(si: &StickyIndex, parent: Option<&BranchID>) -> (Option<Value>, Option<String>, Option<Value>, i64) {
    let assoc = assoc_num(si.assoc);
    let typed = |b: &BranchID| match b {
        BranchID::Nested(id) => (Some(id_json(id)), None),
        BranchID::Root(name) => (None, Some(name.to_string())),
    };
    match si.scope() {
        IndexScope::Relative(item) => {
            let (t, n) = parent.map(typed).unwrap_or((None, None));
            (t, n, Some(id_json(item)), assoc)
        }
        IndexScope::Nested(id) => (Some(id_json(id)), None, None, assoc),
        IndexScope::Root(name) => (None, Some(name.to_string()), None, assoc),
    }
}

/// `Y.relativePositionToJSON`: only the fields that are set.
pub fn to_json(si: &StickyIndex, parent: Option<&BranchID>) -> Value {
    let (t, n, item, assoc) = parts(si, parent);
    let mut m = Map::new();
    if let Some(t) = t {
        m.insert("type".into(), t);
    }
    if let Some(n) = n {
        m.insert("tname".into(), Value::String(n));
    }
    if let Some(i) = item {
        m.insert("item".into(), i);
    }
    m.insert("assoc".into(), json!(assoc));
    Value::Object(m)
}

/// `JSON.stringify(relativePosition)`: every field, nulls included. What
/// y-prosemirror's cursor plugin puts in awareness.
pub fn to_json_full(si: &StickyIndex, parent: Option<&BranchID>) -> Value {
    let (t, n, item, assoc) = parts(si, parent);
    json!({ "type": t, "tname": n, "item": item, "assoc": assoc })
}

/// `Y.createRelativePositionFromJSON`. An item wins over a type, a type
/// over a root name; a missing `assoc` is 0 (after).
pub fn from_json(v: &Value) -> Option<StickyIndex> {
    let assoc = match v.get("assoc").and_then(|a| a.as_i64().or_else(|| a.as_f64().map(|f| f as i64))) {
        Some(n) if n < 0 => Assoc::Before,
        _ => Assoc::After,
    };
    let item = v.get("item").filter(|x| !x.is_null()).and_then(id_from);
    let ty = v.get("type").filter(|x| !x.is_null()).and_then(id_from);
    let tname = v.get("tname").and_then(Value::as_str);
    let scope = if let Some(i) = item {
        IndexScope::Relative(i)
    } else if let Some(t) = ty {
        IndexScope::Nested(t)
    } else if let Some(n) = tname {
        IndexScope::Root(n.into())
    } else {
        return None;
    };
    Some(StickyIndex::new(scope, assoc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_both_shapes() {
        let item = StickyIndex::new(IndexScope::Relative(ID::new(ClientID::new(42), 7)), Assoc::Before);
        let parent = BranchID::Nested(ID::new(ClientID::new(42), 3));
        let j = to_json(&item, Some(&parent));
        assert_eq!(j, json!({ "type": { "client": 42, "clock": 3 }, "item": { "client": 42, "clock": 7 }, "assoc": -1 }));
        assert_eq!(from_json(&j), Some(item.clone()));
        let full = to_json_full(&item, Some(&parent));
        assert_eq!(full["tname"], Value::Null);
        assert_eq!(from_json(&full), Some(item));

        let root = StickyIndex::new(IndexScope::Root("default".into()), Assoc::Before);
        let j = to_json(&root, None);
        assert_eq!(j, json!({ "tname": "default", "assoc": -1 }));
        assert_eq!(from_json(&j), Some(root));

        // A position yjs made with `new RelativePosition(type, null, null)`: assoc 0.
        let end = from_json(&json!({ "type": { "client": 1, "clock": 2 }, "tname": null, "item": null, "assoc": 0 })).unwrap();
        assert_eq!(end, StickyIndex::new(IndexScope::Nested(ID::new(ClientID::new(1), 2)), Assoc::After));
        assert!(from_json(&json!({ "assoc": 0 })).is_none());
    }
}
