//! Reads the structured-clone values Markie stores in IndexedDB: Blink's
//! envelope around V8's `ValueSerializer` format.
//!
//! Only the shapes Markie writes are accepted: plain objects, dense and sparse
//! arrays, strings, numbers, booleans, null, undefined and `Uint8Array`.
//! Anything else (dates, maps, other typed arrays, host objects) fails loudly
//! with `Unsupported`, so an unexpected shape stops the migration instead of
//! silently dropping data.
use crate::error::{MigrateError, Result};
use crate::leveldb::varint;

#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    /// Properties in insertion order.
    Object(Vec<(String, JsValue)>),
    Uint8Array(Vec<u8>),
}

impl JsValue {
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Object(props) => props.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The JSON shape, for values with no bytes: integral numbers become JSON integers.
    pub fn to_json(&self) -> Result<serde_json::Value> {
        use serde_json::Value;
        Ok(match self {
            JsValue::Null => Value::Null,
            JsValue::Bool(b) => Value::Bool(*b),
            JsValue::Number(n) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 => {
                if *n < 0.0 { Value::from(*n as i64) } else { Value::from(*n as u64) }
            }
            JsValue::Number(n) => serde_json::Number::from_f64(*n).map(Value::Number).ok_or_else(|| unsupported("non-finite number"))?,
            JsValue::String(s) => Value::String(s.clone()),
            JsValue::Array(items) => Value::Array(items.iter().map(JsValue::to_json).collect::<Result<_>>()?),
            JsValue::Object(props) => {
                let mut map = serde_json::Map::new();
                for (k, v) in props {
                    map.insert(k.clone(), v.to_json()?);
                }
                Value::Object(map)
            }
            JsValue::Undefined => return Err(unsupported("undefined has no JSON form")),
            JsValue::Uint8Array(_) => return Err(unsupported("bytes have no JSON form")),
        })
    }
}

fn unsupported(what: &str) -> MigrateError {
    MigrateError::Unsupported(what.to_string())
}

fn corrupt(what: &str) -> MigrateError {
    MigrateError::Corrupt(format!("structured clone: {what}"))
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    /// Objects by their back-reference ID, as V8 numbers them.
    objects: Vec<Option<JsValue>>,
    depth: usize,
    /// The V8 format version from the header; views carry a flags field from 14 on.
    version: u32,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8> {
        let b = *self.data.get(self.pos).ok_or_else(|| corrupt("truncated"))?;
        self.pos += 1;
        Ok(b)
    }
    fn varint(&mut self) -> Result<u64> {
        varint(self.data, &mut self.pos)
    }
    fn bytes(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(len).filter(|&e| e <= self.data.len()).ok_or_else(|| corrupt("truncated"))?;
        let out = &self.data[self.pos..end];
        self.pos = end;
        Ok(out)
    }
    /// Skips padding, as V8's ReadTag does.
    fn tag(&mut self) -> Result<u8> {
        loop {
            let b = self.byte()?;
            if b != 0 {
                return Ok(b);
            }
        }
    }
    fn peek_tag(&mut self) -> Result<u8> {
        let save = self.pos;
        let t = self.tag()?;
        self.pos = save;
        Ok(t)
    }

    fn string_body(&mut self, tag: u8) -> Result<String> {
        let len = self.varint()? as usize;
        let raw = self.bytes(len)?;
        match tag {
            b'"' => Ok(raw.iter().map(|&b| b as char).collect()),
            b'c' => {
                if !len.is_multiple_of(2) {
                    return Err(corrupt("odd two-byte string"));
                }
                let units: Vec<u16> = raw.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                String::from_utf16(&units).map_err(|_| unsupported("string with a lone surrogate"))
            }
            b'S' => String::from_utf8(raw.to_vec()).map_err(|_| corrupt("bad UTF-8 string")),
            _ => unreachable!(),
        }
    }

    fn key(&mut self) -> Result<String> {
        match self.tag()? {
            t @ (b'"' | b'c' | b'S') => self.string_body(t),
            b'I' => Ok(zigzag(self.varint()?).to_string()),
            b'U' => Ok(self.varint()?.to_string()),
            b'N' => Ok(js_number_key(f64::from_le_bytes(self.bytes(8)?.try_into().unwrap()))),
            _ => Err(unsupported("object key that is not a string or number")),
        }
    }

    fn properties(&mut self, end: u8) -> Result<Vec<(String, JsValue)>> {
        let mut props = Vec::new();
        loop {
            if self.peek_tag()? == end {
                self.tag()?;
                let count = self.varint()? as usize;
                if count != props.len() {
                    return Err(corrupt("property count mismatch"));
                }
                return Ok(props);
            }
            let key = self.key()?;
            let value = self.value()?;
            props.push((key, value));
        }
    }

    fn begin(&mut self) -> usize {
        self.objects.push(None);
        self.objects.len() - 1
    }

    fn value(&mut self) -> Result<JsValue> {
        self.depth += 1;
        if self.depth > 64 {
            return Err(unsupported("nesting deeper than 64"));
        }
        let value = self.value_inner();
        self.depth -= 1;
        value
    }

    fn value_inner(&mut self) -> Result<JsValue> {
        let tag = self.tag()?;
        Ok(match tag {
            b'_' => JsValue::Undefined,
            b'0' => JsValue::Null,
            b'T' => JsValue::Bool(true),
            b'F' => JsValue::Bool(false),
            b'I' => JsValue::Number(zigzag(self.varint()?) as f64),
            b'U' => JsValue::Number(self.varint()? as f64),
            b'N' => JsValue::Number(f64::from_le_bytes(self.bytes(8)?.try_into().unwrap())),
            b'"' | b'c' | b'S' => JsValue::String(self.string_body(tag)?),
            b'^' => {
                let id = self.varint()? as usize;
                self.objects.get(id).cloned().flatten().ok_or_else(|| unsupported("reference to an unfinished object"))?
            }
            b'o' => {
                let id = self.begin();
                let value = JsValue::Object(self.properties(b'{')?);
                self.objects[id] = Some(value.clone());
                value
            }
            b'A' => {
                let id = self.begin();
                let len = self.varint()? as usize;
                let mut items = Vec::with_capacity(len.min(1 << 16));
                for _ in 0..len {
                    if self.peek_tag()? == b'-' {
                        self.tag()?;
                        items.push(JsValue::Undefined);
                    } else {
                        items.push(self.value()?);
                    }
                }
                let extra = self.properties(b'$')?;
                if !extra.is_empty() {
                    return Err(unsupported("array with named properties"));
                }
                let declared = self.varint()? as usize;
                if declared != len {
                    return Err(corrupt("dense array length mismatch"));
                }
                let value = JsValue::Array(items);
                self.objects[id] = Some(value.clone());
                value
            }
            b'a' => {
                let id = self.begin();
                let len = self.varint()? as usize;
                let props = self.properties(b'@')?;
                if self.varint()? as usize != len {
                    return Err(corrupt("sparse array length mismatch"));
                }
                let mut items = vec![JsValue::Undefined; len.min(1 << 20)];
                for (k, v) in props {
                    let index: usize = k.parse().map_err(|_| unsupported("array with named properties"))?;
                    *items.get_mut(index).ok_or_else(|| corrupt("sparse index out of range"))? = v;
                }
                let value = JsValue::Array(items);
                self.objects[id] = Some(value.clone());
                value
            }
            b'B' => {
                let id = self.begin();
                let len = self.varint()? as usize;
                let buffer = self.bytes(len)?.to_vec();
                // A buffer is only accepted as the backing store of the Uint8Array that follows.
                if self.peek_tag().ok() != Some(b'V') {
                    return Err(unsupported("bare ArrayBuffer"));
                }
                self.tag()?;
                let view_id = self.begin();
                let subtag = self.byte()?;
                let offset = self.varint()? as usize;
                let length = self.varint()? as usize;
                if self.version >= 14 {
                    self.varint()?; // flags
                }
                if subtag != b'B' {
                    return Err(unsupported("typed array other than Uint8Array"));
                }
                let end = offset.checked_add(length).filter(|&e| e <= buffer.len()).ok_or_else(|| corrupt("view outside buffer"))?;
                let value = JsValue::Uint8Array(buffer[offset..end].to_vec());
                self.objects[id] = None;
                self.objects[view_id] = Some(value.clone());
                value
            }
            other => return Err(MigrateError::Unsupported(format!("structured clone tag {:?}", other as char))),
        })
    }
}

fn zigzag(n: u64) -> i64 {
    ((n >> 1) as i64) ^ -((n & 1) as i64)
}

fn js_number_key(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 { format!("{}", n as i64) } else { format!("{n}") }
}

/// Decodes a Blink-serialized value (as stored by IndexedDB, after unwrapping).
pub fn deserialize(data: &[u8]) -> Result<JsValue> {
    let mut pos = 0;
    // Blink's envelope: 0xFF, its version, then an optional trailer-offset tag.
    if data.first() != Some(&0xff) {
        return Err(corrupt("missing Blink version"));
    }
    pos += 1;
    varint(data, &mut pos)?;
    if data.get(pos) == Some(&0xfe) {
        pos += 1 + 8 + 4;
    }
    if data.get(pos) != Some(&0xff) {
        return Err(corrupt("missing V8 version"));
    }
    pos += 1;
    let v8_version = varint(data, &mut pos)? as u32;
    if !(13..=15).contains(&v8_version) {
        return Err(MigrateError::Unsupported(format!("V8 serializer version {v8_version}")));
    }
    let mut reader = Reader { data, pos, objects: Vec::new(), depth: 0, version: v8_version };
    let value = reader.value()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(body: &[u8]) -> Vec<u8> {
        // Blink v21 with an empty trailer, then V8 v15.
        let mut out = vec![0xff, 0x15, 0xfe];
        out.extend([0; 12]);
        out.extend([0xff, 0x0f]);
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn objects_strings_numbers_arrays_and_bytes() {
        // {a: 1, "é": "x", s: [, true], b: Uint8Array[2,3], r: <ref to s>}
        let mut body = vec![b'o'];
        body.extend([b'"', 1, b'a', b'I', 2]);
        body.extend([b'"', 1, 0xe9, 0, b'c', 2, b'x', 0]);
        body.extend([b'"', 1, b's', b'a', 2, b'I', 2, b'T', b'@', 1, 2]);
        body.extend([b'"', 1, b'b', b'B', 3, 1, 2, 3, b'V', b'B', 1, 2, 0]);
        body.extend([b'"', 1, b'r', b'^', 1]);
        body.extend([b'{', 5]);
        let v = deserialize(&wrap(&body)).unwrap();
        assert_eq!(v.get("a"), Some(&JsValue::Number(1.0)));
        assert_eq!(v.get("é"), Some(&JsValue::String("x".into())));
        let sparse = JsValue::Array(vec![JsValue::Undefined, JsValue::Bool(true)]);
        assert_eq!(v.get("s"), Some(&sparse));
        assert_eq!(v.get("b"), Some(&JsValue::Uint8Array(vec![2, 3])));
        assert_eq!(v.get("r"), Some(&sparse));
    }

    #[test]
    fn unsupported_shapes_fail_loudly() {
        // A Date.
        let mut date = vec![b'D'];
        date.extend(0f64.to_le_bytes());
        assert!(matches!(deserialize(&wrap(&date)), Err(MigrateError::Unsupported(_))));
        // A Uint16Array.
        let view = [b'B', 2, 0, 0, b'V', b'W', 0, 2, 0];
        assert!(matches!(deserialize(&wrap(&view)), Err(MigrateError::Unsupported(_))));
        // A wrong property count.
        assert!(deserialize(&wrap(&[b'o', b'"', 1, b'a', b'0', b'{', 2])).is_err());
        assert!(deserialize(&[0x00]).is_err());
    }
}
