//! The vault's wire format, exactly as `src/lib/vault/envelope.ts` writes it.
//!
//! Every serialized form has one canonical encoding: a value is parsed, then
//! re-serialized in the fixed key order, and must come back byte-identical.
//! That rejects duplicate keys, other key orders, whitespace and number
//! spellings the TypeScript would also reject.
use crate::error::{VaultError, VaultErrorCode};
use serde_json::{Map, Value};

/// `VAULT_LIMITS` in envelope.ts. Character counts are UTF-16 code units, like JavaScript's `length`.
pub mod limits {
    pub const CONTENT_BYTES: usize = 8 * 1024 * 1024;
    pub const METADATA_BYTES: usize = 4096;
    pub const HEADER_CHARACTERS: usize = 4096;
    pub const DOCUMENT_CHARACTERS: usize = 12 * 1024 * 1024;
    pub const PASSPHRASE_BYTES: usize = 1024;
    pub const MINIMUM_PASSPHRASE_CODE_POINTS: usize = 16;
    pub const KDF_ITERATIONS: u32 = 600_000;
    pub const MAXIMUM_KDF_ITERATIONS: u32 = 1_000_000;
}

/// Bumped only if the device slot's cryptographic binding changes.
pub const VAULT_DEVICE_SLOT_VERSION: u32 = 1;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url without padding, as `encodeBase64` writes it.
pub fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn sextet(c: u8) -> Option<u32> {
    ALPHABET.iter().position(|&a| a == c).map(|p| p as u32)
}

/// Decodes base64url without padding. Accepts only the canonical encoding of
/// `minimum..=maximum` bytes, with the same error codes as `base64()` in envelope.ts.
pub fn decode_base64_checked(value: &str, minimum: usize, maximum: usize) -> Result<Vec<u8>, VaultError> {
    if value.len() > (maximum * 4).div_ceil(3) {
        return Err(VaultErrorCode::LimitExceeded.into());
    }
    let bytes = value.as_bytes();
    let remainder = bytes.len() % 4;
    let decoded_len = bytes.len() * 3 / 4;
    let invalid = || VaultError::from(VaultErrorCode::InvalidEnvelope);
    if bytes.is_empty() || remainder == 1 || decoded_len < minimum || decoded_len > maximum {
        return Err(invalid());
    }
    let mut values = Vec::with_capacity(bytes.len());
    for &c in bytes {
        values.push(sextet(c).ok_or_else(invalid)?);
    }
    let last = *values.last().unwrap();
    if (remainder == 2 && last & 15 != 0) || (remainder == 3 && last & 3 != 0) {
        return Err(invalid());
    }
    let mut out = Vec::with_capacity(decoded_len);
    for chunk in values.chunks(4) {
        let mut n = 0u32;
        for (i, v) in chunk.iter().enumerate() {
            n |= v << (18 - 6 * i);
        }
        for i in 0..chunk.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    Ok(out)
}

/// A canonical 16-byte base64url ID (vault and document IDs).
pub fn validate_vault_id(value: &str) -> Result<(), VaultError> {
    decode_base64_checked(value, 16, 16).map(|_| ())
}

/// JavaScript's `length`: UTF-16 code units.
pub fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `JSON.stringify(string)`: the same escapes, byte for byte.
pub fn js_json_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Builds a JSON object string in a fixed key order, the way `JSON.stringify` would.
pub(crate) struct JsObject(String);

impl JsObject {
    pub fn new() -> Self {
        Self(String::from("{"))
    }
    fn key(&mut self, key: &str) {
        if self.0.len() > 1 {
            self.0.push(',');
        }
        js_json_string(key, &mut self.0);
        self.0.push(':');
    }
    pub fn str(mut self, key: &str, value: &str) -> Self {
        self.key(key);
        js_json_string(value, &mut self.0);
        self
    }
    pub fn num(mut self, key: &str, value: u64) -> Self {
        self.key(key);
        self.0.push_str(&value.to_string());
        self
    }
    pub fn raw(mut self, key: &str, json: &str) -> Self {
        self.key(key);
        self.0.push_str(json);
        self
    }
    pub fn finish(mut self) -> String {
        self.0.push('}');
        self.0
    }
}

/// `JSON.stringify` of a flat array of strings and integers.
pub(crate) fn js_array(items: &[JsItem<'_>]) -> String {
    let mut out = String::from("[");
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match item {
            JsItem::S(s) => js_json_string(s, &mut out),
            JsItem::N(n) => out.push_str(&n.to_string()),
        }
    }
    out.push(']');
    out
}

pub(crate) enum JsItem<'a> {
    S(&'a str),
    N(u64),
}

/// `json()` in envelope.ts: a size check in UTF-16 units, then a parse.
pub(crate) fn parse_json(serialized: &str, maximum: usize) -> Result<Value, VaultError> {
    if serialized.len() > maximum && js_length(serialized) > maximum {
        return Err(VaultErrorCode::LimitExceeded.into());
    }
    serde_json::from_str(serialized).map_err(|_| VaultErrorCode::InvalidEnvelope.into())
}

/// `object()` in envelope.ts: a plain object with exactly these keys.
pub(crate) fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let map = value.as_object()?;
    (map.len() == keys.len() && keys.iter().all(|k| map.contains_key(*k))).then_some(map)
}

fn obj<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, VaultError> {
    exact_object(value, keys).ok_or_else(|| VaultErrorCode::InvalidEnvelope.into())
}

fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, VaultError> {
    map.get(key).and_then(Value::as_str).ok_or_else(|| VaultErrorCode::InvalidEnvelope.into())
}

fn b64_field(map: &Map<String, Value>, key: &str, min: usize, max: usize) -> Result<String, VaultError> {
    let value = string(map, key)?;
    decode_base64_checked(value, min, max)?;
    Ok(value.to_string())
}

fn is_const(map: &Map<String, Value>, key: &str, expected: &str) -> bool {
    map.get(key).and_then(Value::as_str) == Some(expected)
}

fn is_one(map: &Map<String, Value>, key: &str) -> bool {
    map.get(key).and_then(Value::as_u64) == Some(1) && map.get(key).is_some_and(|v| v.is_u64())
}

fn canonical<T>(value: T, serialized: &str, again: impl Fn(&T) -> String) -> Result<T, VaultError> {
    if again(&value) == serialized { Ok(value) } else { Err(VaultErrorCode::InvalidEnvelope.into()) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultHeader {
    pub vault_id: String,
    pub kdf_iterations: u32,
    pub kdf_salt: String,
    pub wrap_iv: String,
    pub wrap_ciphertext: String,
}

impl VaultHeader {
    pub fn serialize(&self) -> String {
        let kdf = JsObject::new()
            .str("name", "PBKDF2")
            .str("hash", "SHA-256")
            .num("iterations", u64::from(self.kdf_iterations))
            .str("salt", &self.kdf_salt)
            .finish();
        let wrap = JsObject::new()
            .str("name", "AES-GCM")
            .str("iv", &self.wrap_iv)
            .str("ciphertext", &self.wrap_ciphertext)
            .finish();
        JsObject::new()
            .str("kind", "markie-vault")
            .num("version", 1)
            .str("vaultId", &self.vault_id)
            .raw("kdf", &kdf)
            .raw("wrap", &wrap)
            .finish()
    }

    pub fn parse(serialized: &str) -> Result<Self, VaultError> {
        let value = parse_json(serialized, limits::HEADER_CHARACTERS)?;
        let top = obj(&value, &["kind", "version", "vaultId", "kdf", "wrap"])?;
        let kdf = obj(&top["kdf"], &["name", "hash", "iterations", "salt"])?;
        let wrap = obj(&top["wrap"], &["name", "iv", "ciphertext"])?;
        let iterations = kdf.get("iterations").and_then(Value::as_u64);
        let iterations_ok = iterations.is_some_and(|i| {
            (u64::from(limits::KDF_ITERATIONS)..=u64::from(limits::MAXIMUM_KDF_ITERATIONS)).contains(&i)
        });
        if !is_const(top, "kind", "markie-vault")
            || !is_one(top, "version")
            || !is_const(kdf, "name", "PBKDF2")
            || !is_const(kdf, "hash", "SHA-256")
            || !is_const(wrap, "name", "AES-GCM")
            || !iterations_ok
        {
            return Err(VaultErrorCode::InvalidEnvelope.into());
        }
        let header = VaultHeader {
            vault_id: b64_field(top, "vaultId", 16, 16)?,
            kdf_iterations: iterations.unwrap() as u32,
            kdf_salt: b64_field(kdf, "salt", 16, 16)?,
            wrap_iv: b64_field(wrap, "iv", 12, 12)?,
            wrap_ciphertext: b64_field(wrap, "ciphertext", 48, 48)?,
        };
        canonical(header, serialized, Self::serialize)
    }

    /// `headerContext`: the AES-GCM additional data for the passphrase slot.
    pub fn context(&self) -> Vec<u8> {
        js_array(&[
            JsItem::S("markie-vault"),
            JsItem::N(1),
            JsItem::S(&self.vault_id),
            JsItem::S("PBKDF2"),
            JsItem::S("SHA-256"),
            JsItem::N(u64::from(self.kdf_iterations)),
            JsItem::S(&self.kdf_salt),
            JsItem::S("AES-GCM"),
            JsItem::S(&self.wrap_iv),
        ])
        .into_bytes()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultDocumentEnvelope {
    pub vault_id: String,
    pub document_id: String,
    pub wrapped_key: String,
    pub iv: String,
    pub ciphertext: String,
}

impl VaultDocumentEnvelope {
    pub fn serialize(&self) -> String {
        JsObject::new()
            .str("kind", "markie-vault-document")
            .num("version", 1)
            .str("vaultId", &self.vault_id)
            .str("documentId", &self.document_id)
            .str("cipher", "AES-GCM")
            .str("keyWrap", "AES-KW")
            .str("wrappedKey", &self.wrapped_key)
            .str("iv", &self.iv)
            .str("ciphertext", &self.ciphertext)
            .finish()
    }

    pub fn parse(serialized: &str) -> Result<Self, VaultError> {
        let value = parse_json(serialized, limits::DOCUMENT_CHARACTERS)?;
        let top = obj(
            &value,
            &["kind", "version", "vaultId", "documentId", "cipher", "keyWrap", "wrappedKey", "iv", "ciphertext"],
        )?;
        if !is_const(top, "kind", "markie-vault-document")
            || !is_one(top, "version")
            || !is_const(top, "cipher", "AES-GCM")
            || !is_const(top, "keyWrap", "AES-KW")
        {
            return Err(VaultErrorCode::InvalidEnvelope.into());
        }
        let envelope = VaultDocumentEnvelope {
            vault_id: b64_field(top, "vaultId", 16, 16)?,
            document_id: b64_field(top, "documentId", 16, 16)?,
            wrapped_key: b64_field(top, "wrappedKey", 40, 40)?,
            iv: b64_field(top, "iv", 12, 12)?,
            ciphertext: b64_field(top, "ciphertext", 20, limits::CONTENT_BYTES + limits::METADATA_BYTES + 20)?,
        };
        canonical(envelope, serialized, Self::serialize)
    }

    /// `documentContext`: the AES-GCM additional data for the content.
    pub fn context(&self) -> Vec<u8> {
        js_array(&[
            JsItem::S("markie-vault-document"),
            JsItem::N(1),
            JsItem::S(&self.vault_id),
            JsItem::S(&self.document_id),
            JsItem::S("AES-GCM"),
            JsItem::S("AES-KW"),
            JsItem::S(&self.wrapped_key),
            JsItem::S(&self.iv),
        ])
        .into_bytes()
    }
}

/// The second key slot: the vault key under a random 32-byte device secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultDeviceSlot {
    pub vault_id: String,
    pub iv: String,
    pub ciphertext: String,
}

impl VaultDeviceSlot {
    pub fn serialize(&self) -> String {
        JsObject::new()
            .str("kind", "markie-vault-device-slot")
            .num("version", u64::from(VAULT_DEVICE_SLOT_VERSION))
            .str("vaultId", &self.vault_id)
            .str("iv", &self.iv)
            .str("ciphertext", &self.ciphertext)
            .finish()
    }

    pub fn parse(serialized: &str) -> Result<Self, VaultError> {
        let value = parse_json(serialized, limits::HEADER_CHARACTERS)?;
        let top = obj(&value, &["kind", "version", "vaultId", "iv", "ciphertext"])?;
        if !is_const(top, "kind", "markie-vault-device-slot") || !is_one(top, "version") {
            return Err(VaultErrorCode::InvalidEnvelope.into());
        }
        let slot = VaultDeviceSlot {
            vault_id: b64_field(top, "vaultId", 16, 16)?,
            iv: b64_field(top, "iv", 12, 12)?,
            ciphertext: b64_field(top, "ciphertext", 48, 48)?,
        };
        canonical(slot, serialized, Self::serialize)
    }

    /// `deviceSlotContext`: binds the slot to its vault and slot version.
    pub fn context(vault_id: &str, iv: &str) -> Vec<u8> {
        js_array(&[
            JsItem::S("markie-vault-device-slot"),
            JsItem::N(u64::from(VAULT_DEVICE_SLOT_VERSION)),
            JsItem::S(vault_id),
            JsItem::S(iv),
        ])
        .into_bytes()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultDocumentMetadata {
    pub name: String,
    pub media_type: String,
}

fn media_type_ok(value: &str) -> bool {
    let token = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b));
    match value.split_once('/') {
        Some((a, b)) => token(a) && token(b),
        None => false,
    }
}

impl VaultDocumentMetadata {
    /// `metadataBytes`: the UTF-8 of `{"name":…,"mediaType":…}`.
    pub fn to_bytes(&self) -> Result<Vec<u8>, VaultError> {
        if js_length(&self.name) > 1024 || js_length(&self.media_type) > 255 || !media_type_ok(&self.media_type) {
            return Err(VaultErrorCode::InvalidEnvelope.into());
        }
        let encoded = JsObject::new().str("name", &self.name).str("mediaType", &self.media_type).finish().into_bytes();
        if encoded.len() > limits::METADATA_BYTES {
            return Err(VaultErrorCode::LimitExceeded.into());
        }
        Ok(encoded)
    }

    /// `parseMetadata`: strict UTF-8, exact keys, canonical bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, VaultError> {
        if bytes.len() > limits::METADATA_BYTES {
            return Err(VaultErrorCode::LimitExceeded.into());
        }
        let invalid = || VaultError::from(VaultErrorCode::InvalidEnvelope);
        let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
        // TextDecoder drops one leading byte-order mark; the canonical check then rejects it.
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let value: Value = serde_json::from_str(text).map_err(|_| invalid())?;
        let map = obj(&value, &["name", "mediaType"])?;
        let metadata = VaultDocumentMetadata {
            name: string(map, "name")?.to_string(),
            media_type: string(map, "mediaType")?.to_string(),
        };
        if metadata.to_bytes()? != bytes {
            return Err(invalid());
        }
        Ok(metadata)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip_and_canonical_rules() {
        for len in 0..40 {
            let bytes: Vec<u8> = (0..len as u8).map(|b| b.wrapping_mul(37)).collect();
            let encoded = encode_base64(&bytes);
            assert!(!encoded.contains('='));
            if len > 0 {
                assert_eq!(decode_base64_checked(&encoded, 0, 64).unwrap(), bytes);
            }
        }
        // 16 bytes: the last character carries 2 spare bits that must be zero.
        let id = encode_base64(&[0xff; 16]);
        assert_eq!(id.len(), 22);
        validate_vault_id(&id).unwrap();
        let mut bad = id.clone();
        bad.pop();
        bad.push('_');
        assert_eq!(validate_vault_id(&bad).unwrap_err().code(), Some(VaultErrorCode::InvalidEnvelope));
        assert_eq!(validate_vault_id("AAAA+AAAAAAAAAAAAAAAAA").unwrap_err().code(), Some(VaultErrorCode::InvalidEnvelope));
        assert_eq!(validate_vault_id(&"A".repeat(30)).unwrap_err().code(), Some(VaultErrorCode::LimitExceeded));
    }

    #[test]
    fn js_string_escapes_match_json_stringify() {
        let mut out = String::new();
        js_json_string("a\"b\\c\n\r\t\u{08}\u{0c}\u{01}\u{1f}/\u{7f}\u{2028}é🔐", &mut out);
        assert_eq!(out, "\"a\\\"b\\\\c\\n\\r\\t\\b\\f\\u0001\\u001f/\u{7f}\u{2028}é🔐\"");
    }

    #[test]
    fn header_rejects_non_canonical_forms() {
        let header = VaultHeader {
            vault_id: encode_base64(&[1; 16]),
            kdf_iterations: 600_000,
            kdf_salt: encode_base64(&[2; 16]),
            wrap_iv: encode_base64(&[3; 12]),
            wrap_ciphertext: encode_base64(&[4; 48]),
        };
        let s = header.serialize();
        assert_eq!(VaultHeader::parse(&s).unwrap(), header);
        assert!(VaultHeader::parse(&format!(" {s}")).is_err());
        assert!(VaultHeader::parse(&s.replace("600000", "6e5")).is_err());
        assert!(VaultHeader::parse(&s.replace("600000", "599999")).is_err());
        assert!(VaultHeader::parse(&s.replace("600000", "1000001")).is_err());
        assert!(VaultHeader::parse(&s.replace("\"version\":1", "\"version\":1.0")).is_err());
        let reordered = s.replacen("\"kind\":\"markie-vault\",\"version\":1", "\"version\":1,\"kind\":\"markie-vault\"", 1);
        assert!(VaultHeader::parse(&reordered).is_err());
    }

    #[test]
    fn metadata_is_canonical() {
        let m = VaultDocumentMetadata { name: "a \"b\".env".into(), media_type: "text/plain".into() };
        let bytes = m.to_bytes().unwrap();
        assert_eq!(VaultDocumentMetadata::from_bytes(&bytes).unwrap(), m);
        assert!(VaultDocumentMetadata::from_bytes(b"{\"mediaType\":\"text/plain\",\"name\":\"x\"}").is_err());
        assert!(VaultDocumentMetadata { name: "x".into(), media_type: "text".into() }.to_bytes().is_err());
        assert!(VaultDocumentMetadata { name: "x".repeat(1025), media_type: "a/b".into() }.to_bytes().is_err());
    }
}
