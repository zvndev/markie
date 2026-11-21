//! Room nodes in and out of a `yrs` document: `XmlFragment("default")`,
//! exactly as TipTap's Collaboration extension binds it.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use yrs::types::text::YChange;
use yrs::types::Attrs as YAttrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, GetString, Out, ReadTxn, StateVector, Text, Transact, TransactionMut, Update, Xml, XmlElementPrelim,
    XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut, XmlTextPrelim, XmlTextRef,
};

use crate::room::{Attrs, RoomError, RoomNode};

/// The fragment TipTap's Collaboration extension uses by default.
pub const FRAGMENT: &str = "default";

pub fn fragment(doc: &Doc) -> XmlFragmentRef {
    doc.get_or_insert_xml_fragment(FRAGMENT)
}

pub fn json_to_any(v: &Value) -> Any {
    match v {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Any::from(i),
            None => Any::from(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Any::String(Arc::from(s.as_str())),
        Value::Array(a) => Any::Array(a.iter().map(json_to_any).collect::<Vec<_>>().into()),
        Value::Object(o) => {
            Any::Map(Arc::new(o.iter().map(|(k, v)| (k.clone(), json_to_any(v))).collect::<HashMap<_, _>>()))
        }
    }
}

pub fn any_to_json(a: &Any) -> Value {
    match a {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(n) => match n.as_i64() {
            Some(i) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => Value::from(i),
            _ => serde_json::Number::from_f64(n.as_f64().unwrap_or(0.0)).map(Value::Number).unwrap_or(Value::Null),
        },
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(_) => Value::Null,
        Any::Array(a) => Value::Array(a.iter().map(any_to_json).collect()),
        Any::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), any_to_json(v))).collect()),
    }
}

fn yattrs(a: &Attrs) -> YAttrs {
    a.iter().map(|(k, v)| (Arc::from(k.as_str()), json_to_any(v))).collect()
}

/// Append room nodes to a fragment (or element) in one transaction.
pub fn write_children<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, nodes: &[RoomNode]) {
    for n in nodes {
        insert_node(txn, parent, parent.len(txn), n);
    }
}

pub fn insert_node<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, index: u32, n: &RoomNode) {
    match n {
        RoomNode::Element { name, attrs, children } => {
            let e: XmlElementRef = parent.insert(txn, index, XmlElementPrelim::empty(name.as_str()));
            for (k, v) in attrs {
                e.insert_attribute(txn, k.as_str(), json_to_any(v));
            }
            write_children(txn, &e, children);
        }
        RoomNode::Text(runs) => {
            let t: XmlTextRef = parent.insert(txn, index, XmlTextPrelim::new(""));
            let mut at = 0u32;
            for (s, a) in runs {
                t.insert_with_attributes(txn, at, s, yattrs(a));
                at += utf16_len(s);
            }
        }
    }
}

/// Yjs text offsets count UTF-16 code units, and yrs is set to match.
pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

pub fn read_children<T: ReadTxn, F: XmlFragment>(txn: &T, parent: &F) -> Result<Vec<RoomNode>, RoomError> {
    let mut out = Vec::new();
    for child in parent.children(txn) {
        out.push(read_node(txn, child)?);
    }
    Ok(out)
}

fn read_node<T: ReadTxn>(txn: &T, n: XmlOut) -> Result<RoomNode, RoomError> {
    Ok(match n {
        XmlOut::Element(e) => {
            let mut attrs = Attrs::new();
            for (k, v) in e.attributes(txn) {
                match v {
                    Out::Any(a) => {
                        let j = any_to_json(&a);
                        if !j.is_null() {
                            attrs.insert(k.to_string(), j);
                        }
                    }
                    other => return Err(RoomError(format!("attribute `{k}` holds a shared type: {other:?}"))),
                }
            }
            RoomNode::Element { name: e.tag().to_string(), attrs, children: read_children(txn, &e)? }
        }
        XmlOut::Text(t) => {
            let mut runs: Vec<(String, Attrs)> = Vec::new();
            for d in t.diff(txn, YChange::identity) {
                let s = match d.insert {
                    Out::Any(Any::String(s)) => s.to_string(),
                    other => return Err(RoomError(format!("embedded value in text: {other:?}"))),
                };
                let a: Attrs = d
                    .attributes
                    .map(|m| {
                        m.iter()
                            .filter(|(_, v)| !matches!(v, Any::Null))
                            .map(|(k, v)| (k.to_string(), any_to_json(v)))
                            .collect()
                    })
                    .unwrap_or_default();
                match runs.last_mut() {
                    Some((ps, pa)) if *pa == a => ps.push_str(&s),
                    _ => runs.push((s, a)),
                }
            }
            RoomNode::Text(runs)
        }
        XmlOut::Fragment(f) => {
            return Err(RoomError(format!("nested fragment: {}", f.get_string(txn))));
        }
    })
}

/// A new document holding `nodes`, written by client `client_id`.
pub fn doc_with(nodes: &[RoomNode], client_id: u64) -> Doc {
    let doc = Doc::with_client_id(client_id);
    let frag = fragment(&doc);
    {
        let mut txn = doc.transact_mut();
        write_children(&mut txn, &frag, nodes);
    }
    doc
}

pub fn encode_state(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

pub fn encode_since(doc: &Doc, since: &StateVector) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(since)
}

pub fn apply(doc: &Doc, update: &[u8]) -> Result<(), RoomError> {
    let u = Update::decode_v1(update).map_err(|e| RoomError(format!("decode: {e}")))?;
    doc.transact_mut().apply_update(u).map_err(|e| RoomError(format!("apply: {e}")))
}

pub fn read_doc(doc: &Doc) -> Result<Vec<RoomNode>, RoomError> {
    let frag = fragment(doc);
    let txn = doc.transact();
    read_children(&txn, &frag)
}
