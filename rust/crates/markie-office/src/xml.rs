//! Original, non-validating bounded XML subset reader. W3C XML 1.0 and Namespaces:
//! <https://www.w3.org/TR/xml/> and <https://www.w3.org/TR/xml-names/>.
//! Ported from `src/lib/office/xml.ts`. Source offsets (UTF-8 byte offsets here,
//! UTF-16 code units in TypeScript) let DOCX edits leave unrelated XML untouched.
//! No DTD, external entities, network access or executable markup is used. A
//! DOCTYPE naming only an external identifier is skipped unread; any internal
//! subset or markup declaration is rejected.

use crate::error::{OfficeError, Result};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XmlAttribute {
    pub name: String,
    pub local_name: String,
    pub namespace: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XmlElement {
    pub name: String,
    pub local_name: String,
    pub namespace: String,
    pub attributes: Vec<XmlAttribute>,
    pub children: Vec<XmlElement>,
    /// Direct character data (not descendants), entity-decoded.
    pub text: String,
    pub start: usize,
    pub start_tag_end: usize,
    /// For a self-closing element this is the offset of its `/`, which is
    /// smaller than `start_tag_end`; callers test that to detect `<x/>`.
    pub end_tag_start: usize,
    pub end: usize,
}

impl XmlElement {
    pub fn self_closing(&self) -> bool {
        self.end_tag_start < self.start_tag_end
    }
    pub fn attr(&self, local_name: &str, namespace: &str) -> Option<&str> {
        xml_attribute(self, local_name, namespace)
    }
    /// Unqualified attribute.
    pub fn plain(&self, local_name: &str) -> Option<&str> {
        xml_attribute(self, local_name, "")
    }
    /// Attribute in the element's own namespace (the `w:val` idiom).
    pub fn own(&self, local_name: &str) -> Option<&str> {
        xml_attribute(self, local_name, &self.namespace)
    }
    pub fn descendants(&self) -> Vec<&XmlElement> {
        xml_descendants(self)
    }
    pub fn has_child(&self, start: usize) -> bool {
        self.children.iter().any(|c| c.start == start)
    }
    pub fn raw<'a>(&self, source: &'a str) -> &'a str {
        &source[self.start..self.end]
    }
}

pub const XML_NAMESPACE: &str = "http://www.w3.org/XML/1998/namespace";
pub const XMLNS_NAMESPACE: &str = "http://www.w3.org/2000/xmlns/";

fn xml_err(message: &str) -> OfficeError {
    OfficeError::xml(message)
}

fn valid_code_point(point: u32) -> bool {
    point == 9
        || point == 10
        || point == 13
        || (32..=0xd7ff).contains(&point)
        || (0xe000..=0xfffd).contains(&point)
        || (0x10000..=0x10ffff).contains(&point)
}

pub fn assert_xml_text(text: &str) -> Result<()> {
    if text.chars().any(|c| !valid_code_point(c as u32)) {
        return Err(xml_err("XML contains an invalid character."));
    }
    Ok(())
}

pub fn escape_xml_text(text: &str) -> Result<String> {
    assert_xml_text(text)?;
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\r' => out.push_str("&#13;"),
            _ => out.push(c),
        }
    }
    Ok(out)
}

/// Attribute-value escaping used by the DOCX writers (`xmlAttributeText`).
pub fn xml_attribute_text(text: &str) -> Result<String> {
    Ok(escape_xml_text(text)?.replace('"', "&quot;").replace('\n', "&#10;").replace('\t', "&#9;"))
}

fn decode_entities(text: &str) -> Result<String> {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    loop {
        let Some(rel) = text[cursor..].find('&') else {
            output.push_str(&text[cursor..]);
            return Ok(output);
        };
        let amp = cursor + rel;
        output.push_str(&text[cursor..amp]);
        let end = text[amp + 1..].find(';').map(|e| amp + 1 + e);
        // TypeScript bounds the entity at 32 UTF-16 units; the entity bodies we
        // accept are ASCII, so bytes and units agree for every valid entity.
        let Some(end) = end.filter(|e| utf16_len(&text[amp..*e]) <= 32) else {
            return Err(xml_err("Invalid XML entity."));
        };
        let entity = &text[amp + 1..end];
        match entity {
            "amp" => output.push('&'),
            "lt" => output.push('<'),
            "gt" => output.push('>'),
            "quot" => output.push('"'),
            "apos" => output.push('\''),
            _ => {
                let numeric = entity.strip_prefix('#').and_then(|rest| {
                    if let Some(hex) = rest.strip_prefix('x') {
                        (!hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| u32::from_str_radix(hex, 16).ok())
                    } else {
                        (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())).then(|| rest.parse::<u32>().ok())
                    }
                });
                match numeric {
                    Some(point) => {
                        let point = point.filter(|p| valid_code_point(*p)).and_then(char::from_u32);
                        match point {
                            Some(c) => output.push(c),
                            None => return Err(xml_err("Invalid XML character reference.")),
                        }
                    }
                    None => return Err(xml_err("Custom XML entities are not supported.")),
                }
            }
        }
        cursor = end + 1;
    }
}

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

pub fn xml_attribute<'a>(node: &'a XmlElement, local_name: &str, namespace: &str) -> Option<&'a str> {
    node.attributes
        .iter()
        .find(|a| a.local_name == local_name && a.namespace == namespace)
        .map(|a| a.value.as_str())
}

/// Pre-order (document order) list of the node and all its descendants.
pub fn xml_descendants(node: &XmlElement) -> Vec<&XmlElement> {
    let mut result = Vec::new();
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        result.push(current);
        for child in current.children.iter().rev() {
            stack.push(child);
        }
    }
    result
}

/// The element whose direct child starts at `start`.
pub fn xml_parent(root: &XmlElement, start: usize) -> Option<&XmlElement> {
    xml_descendants(root).into_iter().find(|n| n.has_child(start))
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}
pub(crate) fn only_ws(s: &str) -> bool {
    s.bytes().all(is_ws)
}
fn name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}
fn name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')
}
fn ncname(s: &[u8]) -> bool {
    !s.is_empty() && name_start(s[0]) && s[1..].iter().all(|b| name_char(*b))
}
/// `^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$`
pub(crate) fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    match b.iter().position(|c| *c == b':') {
        None => ncname(b),
        Some(i) => ncname(&b[..i]) && ncname(&b[i + 1..]),
    }
}

/// Normalizes CRLF and lone CR to LF.
fn normalize_newlines(s: &str) -> String {
    if !s.contains('\r') {
        return s.to_string();
    }
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// Matches `<?xml ...?>` declaration content (between `<?` and `?>`).
fn valid_declaration(instruction: &str) -> bool {
    let b = instruction.as_bytes();
    let mut i = 0;
    let ws = |i: &mut usize| -> usize {
        let s = *i;
        while *i < b.len() && is_ws(b[*i]) {
            *i += 1;
        }
        *i - s
    };
    let lit = |i: &mut usize, word: &str| -> bool {
        if b[*i..].starts_with(word.as_bytes()) {
            *i += word.len();
            true
        } else {
            false
        }
    };
    // Parses `S name S? = S? quoted` and returns the quoted value.
    let pseudo = |i: &mut usize, name: &str| -> Option<String> {
        let save = *i;
        if ws(i) == 0 || !lit(i, name) {
            *i = save;
            return None;
        }
        ws(i);
        if !lit(i, "=") {
            *i = save;
            return None;
        }
        ws(i);
        let q = *b.get(*i)?;
        if q != b'"' && q != b'\'' {
            *i = save;
            return None;
        }
        let close = b[*i + 1..].iter().position(|c| *c == q)?;
        let value = String::from_utf8_lossy(&b[*i + 1..*i + 1 + close]).to_string();
        *i += close + 2;
        Some(value)
    };
    if !lit(&mut i, "xml") {
        return false;
    }
    match pseudo(&mut i, "version") {
        Some(v) if v == "1.0" => {}
        _ => return false,
    }
    let save = i;
    if let Some(enc) = pseudo(&mut i, "encoding") {
        let e = enc.as_bytes();
        let ok = e.len() >= 5 && e[..4].eq_ignore_ascii_case(b"utf-") && {
            let rest = &e[4..];
            rest == b"8" || rest == b"16" || (rest.len() == 4 && &rest[..2] == b"16" && matches!(&rest[2..].to_ascii_lowercase()[..], b"le" | b"be"))
        };
        if !ok {
            return false;
        }
    } else {
        i = save;
    }
    let save = i;
    if let Some(sa) = pseudo(&mut i, "standalone") {
        if sa != "yes" && sa != "no" {
            return false;
        }
    } else {
        i = save;
    }
    ws(&mut i);
    i == b.len()
}

/// `<!DOCTYPE Name ExternalID? S? >` with no internal subset. Returns the end offset.
fn match_doctype(source: &str, cursor: usize) -> Option<usize> {
    let b = source.as_bytes();
    let mut i = cursor + "<!DOCTYPE".len();
    let ws = |i: &mut usize| -> usize {
        let s = *i;
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\r' | b'\n') {
            *i += 1;
        }
        *i - s
    };
    if ws(&mut i) == 0 {
        return None;
    }
    let name_start_at = i;
    while i < b.len() && !matches!(b[i], b' ' | b'\t' | b'\r' | b'\n' | b'>' | b'[') {
        i += 1;
    }
    if i == name_start_at || !valid_name(&source[name_start_at..i]) {
        return None;
    }
    let system_literal = |i: &mut usize| -> bool {
        let Some(&q) = b.get(*i) else { return false };
        if q != b'"' && q != b'\'' {
            return false;
        }
        let mut j = *i + 1;
        while j < b.len() && b[j] != q {
            if matches!(b[j], b'<' | b'>' | b'[' | b']') {
                return false;
            }
            j += 1;
        }
        if j >= b.len() {
            return false;
        }
        *i = j + 1;
        true
    };
    let pubid_literal = |i: &mut usize| -> bool {
        let Some(&q) = b.get(*i) else { return false };
        if q != b'"' && q != b'\'' {
            return false;
        }
        let mut j = *i + 1;
        while j < b.len() && b[j] != q {
            let c = b[j];
            let ok = c == b' '
                || c == b'\r'
                || c == b'\n'
                || c.is_ascii_alphanumeric()
                || b"-()+,./:=?;!*#@$_%".contains(&c)
                || (q == b'"' && c == b'\'');
            if !ok {
                return false;
            }
            j += 1;
        }
        if j >= b.len() {
            return false;
        }
        *i = j + 1;
        true
    };
    let save = i;
    let mut external = false;
    if ws(&mut i) > 0 {
        if b[i..].starts_with(b"SYSTEM") {
            let mut j = i + 6;
            if ws(&mut j) > 0 && system_literal(&mut j) {
                i = j;
                external = true;
            }
        } else if b[i..].starts_with(b"PUBLIC") {
            let mut j = i + 6;
            if ws(&mut j) > 0 && pubid_literal(&mut j) && ws(&mut j) > 0 && system_literal(&mut j) {
                i = j;
                external = true;
            }
        }
    }
    if !external {
        i = save;
    }
    ws(&mut i);
    if b.get(i) == Some(&b'>') { Some(i + 1) } else { None }
}

struct Frame {
    node: XmlElement,
    namespaces: HashMap<String, String>,
}

pub fn parse_xml(source: &str) -> Result<XmlElement> {
    parse_xml_limited(source, 8 * 1024 * 1024)
}

/// `max_characters` counts UTF-16 code units, matching the TypeScript limit.
pub fn parse_xml_limited(source: &str, max_characters: usize) -> Result<XmlElement> {
    if source.len() > max_characters && utf16_len(source) > max_characters {
        return Err(xml_err("XML exceeds the character limit."));
    }
    assert_xml_text(source)?;
    let b = source.as_bytes();
    let mut stack: Vec<Frame> = Vec::new();
    let mut root: Option<XmlElement> = None;
    let mut cursor = if source.starts_with('\u{feff}') { 3 } else { 0 };
    let declaration_offset = cursor;
    let mut node_count = 0usize;
    let mut doctype_seen = false;
    // Closing a frame attaches the node to its parent or makes it the root.
    fn attach(stack: &mut [Frame], root: &mut Option<XmlElement>, node: XmlElement) -> Result<()> {
        if let Some(parent) = stack.last_mut() {
            parent.node.children.push(node);
        } else if root.is_some() {
            return Err(xml_err("XML contains multiple root elements."));
        } else {
            *root = Some(node);
        }
        Ok(())
    }
    while cursor < b.len() {
        if b[cursor] != b'<' {
            let end = source[cursor..].find('<').map_or(source.len(), |n| cursor + n);
            let raw = &source[cursor..end];
            if raw.contains("]]>") {
                return Err(xml_err("Invalid XML text delimiter."));
            }
            // XML Misc permits literal S outside the document element, not entity or
            // character references that merely decode into whitespace.
            if stack.is_empty() && !only_ws(raw) {
                return Err(xml_err("XML text is outside its root element."));
            }
            let text = decode_entities(&normalize_newlines(raw))?;
            if let Some(top) = stack.last_mut() {
                top.node.text.push_str(&text);
            }
            cursor = end;
            continue;
        }
        let rest = &source[cursor..];
        if rest.starts_with("<!--") {
            let end = source[cursor + 4..].find("-->").map(|e| cursor + 4 + e);
            match end {
                Some(end) if !source[cursor + 4..end].contains("--") && b[end - 1] != b'-' => cursor = end + 3,
                _ => return Err(xml_err("Malformed XML comment.")),
            }
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            let end = source[cursor + 9..].find("]]>").map(|e| cursor + 9 + e);
            let (Some(end), Some(top)) = (end, stack.last_mut()) else {
                return Err(xml_err("Malformed XML CDATA."));
            };
            top.node.text.push_str(&normalize_newlines(&source[cursor + 9..end]));
            cursor = end + 3;
            continue;
        }
        if rest.starts_with("<?") {
            let Some(end) = source[cursor + 2..].find("?>").map(|e| cursor + 2 + e) else {
                return Err(xml_err("Unterminated XML instruction."));
            };
            // Only a leading UTF-8/UTF-16 XML declaration belongs to the supported
            // subset; callers decode bytes first and verify the declaration agrees.
            if cursor != declaration_offset || !valid_declaration(&source[cursor + 2..end]) {
                return Err(xml_err("Unsupported XML instruction or encoding."));
            }
            cursor = end + 2;
            continue;
        }
        if rest.starts_with("<!DOCTYPE") {
            if !stack.is_empty() || root.is_some() || doctype_seen {
                return Err(xml_err("A DOCTYPE is only allowed once, before the root element."));
            }
            let Some(end) = match_doctype(source, cursor) else {
                return Err(xml_err("DTD internal subsets and markup declarations are forbidden."));
            };
            doctype_seen = true;
            cursor = end;
            continue;
        }
        if rest.starts_with("<!") {
            return Err(xml_err("DTD and XML declarations are forbidden."));
        }
        if rest.starts_with("</") {
            let Some(end) = source[cursor + 2..].find('>').map(|e| cursor + 2 + e) else {
                return Err(xml_err("Unterminated closing XML tag."));
            };
            let closing = &source[cursor + 2..end];
            let name_len = closing.bytes().take_while(|c| !is_ws(*c)).count();
            let name = &closing[..name_len];
            if !valid_name(name) || !only_ws(&closing[name_len..]) {
                return Err(xml_err("Invalid closing XML tag."));
            }
            let Some(mut frame) = stack.pop() else {
                return Err(xml_err("Mismatched XML tags."));
            };
            if frame.node.name != name {
                return Err(xml_err("Mismatched XML tags."));
            }
            frame.node.end_tag_start = cursor;
            frame.node.end = end + 1;
            cursor = end + 1;
            attach(&mut stack, &mut root, frame.node)?;
            continue;
        }
        let mut end = cursor + 1;
        let mut quote = 0u8;
        while end < b.len() {
            let c = b[end];
            if quote != 0 {
                if c == quote {
                    quote = 0;
                }
            } else if c == b'"' || c == b'\'' {
                quote = c;
            } else if c == b'>' {
                break;
            } else if c == b'<' {
                return Err(xml_err("Invalid XML start tag."));
            }
            end += 1;
        }
        if end == b.len() {
            return Err(xml_err("Unterminated XML start tag."));
        }
        let self_closing = b[end - 1] == b'/';
        let inside = &source[cursor + 1..if self_closing { end - 1 } else { end }];
        let name_len = inside.bytes().take_while(|c| !is_ws(*c) && *c != b'/').count();
        let name = &inside[..name_len];
        if name.is_empty() || !valid_name(name) {
            return Err(xml_err("Unsupported or invalid XML name."));
        }
        let mut raw_attributes: Vec<(String, String)> = Vec::new();
        let mut attr_names = HashSet::new();
        let ib = inside.as_bytes();
        let mut offset = name_len;
        while offset < ib.len() {
            if only_ws(&inside[offset..]) {
                break;
            }
            let bad = || xml_err("Invalid or duplicate XML attribute.");
            let mut i = offset;
            let ws_start = i;
            while i < ib.len() && is_ws(ib[i]) {
                i += 1;
            }
            if i == ws_start {
                return Err(bad());
            }
            let an_start = i;
            while i < ib.len() && !is_ws(ib[i]) && ib[i] != b'=' {
                i += 1;
            }
            let attr_name = &inside[an_start..i];
            while i < ib.len() && is_ws(ib[i]) {
                i += 1;
            }
            if ib.get(i) != Some(&b'=') {
                return Err(bad());
            }
            i += 1;
            while i < ib.len() && is_ws(ib[i]) {
                i += 1;
            }
            let Some(&q) = ib.get(i).filter(|q| **q == b'"' || **q == b'\'') else {
                return Err(bad());
            };
            let Some(close) = ib[i + 1..].iter().position(|c| *c == q).map(|c| i + 1 + c) else {
                return Err(bad());
            };
            let raw_value = &inside[i + 1..close];
            if attr_name.is_empty() || !valid_name(attr_name) || raw_value.contains('<') || attr_names.contains(attr_name) {
                return Err(bad());
            }
            attr_names.insert(attr_name.to_string());
            let normalized = normalize_newlines(raw_value).replace(['\t', '\n'], " ");
            raw_attributes.push((attr_name.to_string(), decode_entities(&normalized)?));
            if raw_attributes.len() > 128 {
                return Err(xml_err("XML attribute count exceeds its limit."));
            }
            offset = close + 1;
        }
        let mut namespaces = match stack.last() {
            Some(top) => top.namespaces.clone(),
            None => HashMap::from([("xml".to_string(), XML_NAMESPACE.to_string())]),
        };
        for (attr_name, value) in &raw_attributes {
            if attr_name == "xmlns" || attr_name.starts_with("xmlns:") {
                let prefix = if attr_name == "xmlns" { "" } else { &attr_name[6..] };
                if prefix == "xmlns"
                    || value == XMLNS_NAMESPACE
                    || (prefix == "xml") != (value == XML_NAMESPACE)
                    || (!prefix.is_empty() && value.is_empty())
                {
                    return Err(xml_err("Invalid namespace declaration."));
                }
                namespaces.insert(prefix.to_string(), value.clone());
            }
        }
        let qualify = |qualified: &str, is_attribute: bool| -> Result<(String, String)> {
            let colon = qualified.find(':');
            if qualified == "xmlns" || qualified.starts_with("xmlns:") {
                let local = match colon {
                    None => "xmlns".to_string(),
                    Some(c) => qualified[c + 1..].to_string(),
                };
                return Ok((local, XMLNS_NAMESPACE.to_string()));
            }
            let prefix = colon.map_or("", |c| &qualified[..c]);
            let namespace = if colon.is_none() && is_attribute {
                String::new()
            } else {
                namespaces.get(prefix).cloned().unwrap_or_default()
            };
            if colon.is_some() && namespace.is_empty() {
                return Err(xml_err("Unbound XML namespace prefix."));
            }
            let local = colon.map_or(qualified, |c| &qualified[c + 1..]).to_string();
            Ok((local, namespace))
        };
        if name == "xmlns" || name.starts_with("xmlns:") {
            return Err(xml_err("Reserved XML namespace name."));
        }
        let mut attributes = Vec::with_capacity(raw_attributes.len());
        let mut expanded_names = HashSet::new();
        for (attr_name, value) in raw_attributes {
            let (local_name, namespace) = qualify(&attr_name, true)?;
            if !expanded_names.insert(format!("{namespace}|{local_name}")) {
                return Err(xml_err("Duplicate expanded XML attribute."));
            }
            attributes.push(XmlAttribute { name: attr_name, local_name, namespace, value });
        }
        let (local_name, namespace) = qualify(name, false)?;
        let node = XmlElement {
            name: name.to_string(),
            local_name,
            namespace,
            attributes,
            children: Vec::new(),
            text: String::new(),
            start: cursor,
            start_tag_end: end + 1,
            end_tag_start: if self_closing { end - 1 } else { usize::MAX },
            end: if self_closing { end + 1 } else { usize::MAX },
        };
        node_count += 1;
        if node_count > 100_000 || stack.len() >= 128 {
            return Err(xml_err("XML structure exceeds its limits."));
        }
        if stack.is_empty() && root.is_some() {
            return Err(xml_err("XML contains multiple root elements."));
        }
        cursor = end + 1;
        if self_closing {
            attach(&mut stack, &mut root, node)?;
        } else {
            stack.push(Frame { node, namespaces });
        }
    }
    match root {
        Some(root) if stack.is_empty() => Ok(root),
        _ => Err(xml_err("Incomplete XML document.")),
    }
}
