//! Which documents Markie can open, and lossless text decoding.
//!
//! Mirrors `src/lib/document-formats.ts`. Keep the extension table in step with
//! it and with `electron/mdindex.js`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum FormatKind {
    Markdown,
    Darkmown,
    Text,
    Csv,
    Json,
    Yaml,
    Xml,
    Docx,
    Doc,
    Rtf,
    Html,
    Odt,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Representation {
    Text,
    Bytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Editing {
    Text,
    Engine,
    Unsupported,
}

impl FormatKind {
    /// Every kind the explorer can filter by, in display order.
    pub const OPENABLE: [FormatKind; 12] = [
        FormatKind::Markdown,
        FormatKind::Text,
        FormatKind::Docx,
        FormatKind::Doc,
        FormatKind::Rtf,
        FormatKind::Odt,
        FormatKind::Csv,
        FormatKind::Json,
        FormatKind::Yaml,
        FormatKind::Xml,
        FormatKind::Html,
        FormatKind::Darkmown,
    ];

    pub fn label(self) -> &'static str {
        match self {
            FormatKind::Markdown => "Markdown",
            FormatKind::Darkmown => "Darkmown",
            FormatKind::Text => "Text",
            FormatKind::Csv => "CSV",
            FormatKind::Json => "JSON",
            FormatKind::Yaml => "YAML",
            FormatKind::Xml => "XML",
            FormatKind::Docx => "Word",
            FormatKind::Doc => "Word 97",
            FormatKind::Rtf => "RTF",
            FormatKind::Html => "HTML",
            FormatKind::Odt => "OpenDocument",
            FormatKind::Unsupported => "Other",
        }
    }

    pub fn representation(self) -> Representation {
        match self {
            FormatKind::Markdown
            | FormatKind::Darkmown
            | FormatKind::Text
            | FormatKind::Csv
            | FormatKind::Json
            | FormatKind::Yaml
            | FormatKind::Xml => Representation::Text,
            _ => Representation::Bytes,
        }
    }

    pub fn editing(self) -> Editing {
        match self {
            FormatKind::Docx | FormatKind::Doc | FormatKind::Rtf | FormatKind::Odt => Editing::Engine,
            FormatKind::Html | FormatKind::Unsupported => Editing::Unsupported,
            _ => Editing::Text,
        }
    }

    pub fn mime_type(self) -> &'static str {
        match self {
            FormatKind::Markdown => "text/markdown",
            FormatKind::Csv => "text/csv",
            FormatKind::Json => "application/json",
            FormatKind::Docx => {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
            FormatKind::Doc => "application/msword",
            FormatKind::Rtf => "application/rtf",
            FormatKind::Html => "text/html",
            FormatKind::Odt => "application/vnd.oasis.opendocument.text",
            FormatKind::Unsupported => "application/octet-stream",
            _ => "text/plain",
        }
    }

    /// The editor grammar for a text format, by tree-sitter language name.
    pub fn editor_language(self) -> &'static str {
        match self {
            FormatKind::Markdown => "markdown",
            FormatKind::Json => "json",
            FormatKind::Yaml => "yaml",
            FormatKind::Xml | FormatKind::Html => "html",
            _ => "text",
        }
    }
}

/// Filename classification. Never falls back to Markdown or trusts a MIME hint.
pub fn classify(name: &str) -> FormatKind {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let Some(dot) = base.rfind('.') else {
        return FormatKind::Unsupported;
    };
    kind_for_extension(&base[dot + 1..])
}

pub fn kind_for_extension(ext: &str) -> FormatKind {
    match ext.to_ascii_lowercase().as_str() {
        "md" | "markdown" | "mdx" => FormatKind::Markdown,
        "wd" => FormatKind::Darkmown,
        "txt" | "text" | "log" => FormatKind::Text,
        // A .tsv is the same table with tabs between its cells (csv_table.rs).
        "csv" | "tsv" => FormatKind::Csv,
        "json" => FormatKind::Json,
        "yaml" | "yml" => FormatKind::Yaml,
        "xml" => FormatKind::Xml,
        "docx" => FormatKind::Docx,
        "doc" => FormatKind::Doc,
        "rtf" => FormatKind::Rtf,
        "html" | "htm" => FormatKind::Html,
        "odt" => FormatKind::Odt,
        _ => FormatKind::Unsupported,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Newline {
    Lf,
    Crlf,
    Cr,
    Mixed,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedText {
    pub text: String,
    pub encoding: TextEncoding,
    pub bom: bool,
    pub newline: Newline,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TextError {
    BinaryContent(&'static str),
    InvalidText(String),
    UnsupportedEncoding(&'static str),
}

impl std::fmt::Display for TextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TextError::BinaryContent(m) | TextError::UnsupportedEncoding(m) => f.write_str(m),
            TextError::InvalidText(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for TextError {}

fn newline_of(text: &str) -> Newline {
    let bytes = text.as_bytes();
    let mut kind = Newline::None;
    let mut i = 0;
    while i < bytes.len() {
        let next = match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                i += 1;
                Newline::Crlf
            }
            b'\r' => Newline::Cr,
            b'\n' => Newline::Lf,
            _ => {
                i += 1;
                continue;
            }
        };
        if kind != Newline::None && kind != next {
            return Newline::Mixed;
        }
        kind = next;
        i += 1;
    }
    kind
}

/// Tabs, newlines and form feeds are text. NULs and the other C0 controls are
/// a strong binary sign, not something to replace.
fn assert_text(text: &str) -> Result<(), TextError> {
    if text
        .chars()
        .any(|c| (c as u32) < 32 && !matches!(c, '\t' | '\n' | '\x0c' | '\r'))
    {
        return Err(TextError::BinaryContent(
            "This file contains binary control characters and cannot be edited as text.",
        ));
    }
    Ok(())
}

/// Decode without replacing invalid bytes or changing any line endings.
pub fn decode_text(bytes: &[u8]) -> Result<DecodedText, TextError> {
    if bytes.starts_with(&[0xff, 0xfe, 0, 0]) || bytes.starts_with(&[0, 0, 0xfe, 0xff]) {
        return Err(TextError::UnsupportedEncoding(
            "UTF-32 text is not supported. Convert a copy to UTF-8 first.",
        ));
    }
    const BINARY: [&[u8]; 6] = [
        &[0x50, 0x4b, 3, 4],
        &[0x50, 0x4b, 5, 6],
        &[0x50, 0x4b, 7, 8],
        &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
        &[0x89, 0x50, 0x4e, 0x47],
        &[0x25, 0x50, 0x44, 0x46, 0x2d],
    ];
    if BINARY.iter().any(|p| bytes.starts_with(p)) {
        return Err(TextError::BinaryContent(
            "This is a binary document, not a text file.",
        ));
    }
    let (encoding, offset) = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        (TextEncoding::Utf8, 3)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        (TextEncoding::Utf16Le, 2)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        (TextEncoding::Utf16Be, 2)
    } else {
        (TextEncoding::Utf8, 0)
    };
    let body = &bytes[offset..];
    let text = match encoding {
        TextEncoding::Utf8 => String::from_utf8(body.to_vec())
            .map_err(|_| TextError::InvalidText("The file is not valid UTF-8 text. No bytes were replaced.".into()))?,
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            if body.len() % 2 != 0 {
                return Err(TextError::InvalidText(
                    "The file is not valid UTF-16 text. No bytes were replaced.".into(),
                ));
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| match encoding {
                    TextEncoding::Utf16Le => u16::from_le_bytes([c[0], c[1]]),
                    _ => u16::from_be_bytes([c[0], c[1]]),
                })
                .collect();
            String::from_utf16(&units).map_err(|_| {
                TextError::InvalidText("The file is not valid UTF-16 text. No bytes were replaced.".into())
            })?
        }
    };
    assert_text(&text)?;
    Ok(DecodedText {
        newline: newline_of(&text),
        text,
        encoding,
        bom: offset > 0,
    })
}

/// Encode exactly the supplied text. Callers must not normalize newlines.
pub fn encode_text(text: &str, encoding: TextEncoding, bom: bool) -> Result<Vec<u8>, TextError> {
    assert_text(text)?;
    let mut out = Vec::with_capacity(text.len() + 3);
    match encoding {
        TextEncoding::Utf8 => {
            if bom {
                out.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            }
            out.extend_from_slice(text.as_bytes());
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            let le = encoding == TextEncoding::Utf16Le;
            if bom {
                out.extend_from_slice(if le { &[0xff, 0xfe] } else { &[0xfe, 0xff] });
            }
            for unit in text.encode_utf16() {
                out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_like_the_electron_table() {
        assert_eq!(classify("notes/Plan.MD"), FormatKind::Markdown);
        assert_eq!(classify("C:\\docs\\letter.docx"), FormatKind::Docx);
        assert_eq!(classify("a.yml"), FormatKind::Yaml);
        assert_eq!(classify("README"), FormatKind::Unsupported);
        assert_eq!(classify("photo.png"), FormatKind::Unsupported);
        assert_eq!(classify("page.htm"), FormatKind::Html);
    }

    #[test]
    fn round_trips_bom_encoding_and_newlines() {
        for (encoding, bom) in [
            (TextEncoding::Utf8, false),
            (TextEncoding::Utf8, true),
            (TextEncoding::Utf16Le, true),
            (TextEncoding::Utf16Be, true),
        ] {
            let source = "# Title\r\nbody \u{1F600}\r\n";
            let bytes = encode_text(source, encoding, bom).unwrap();
            let decoded = decode_text(&bytes).unwrap();
            assert_eq!(decoded.text, source);
            assert_eq!(decoded.encoding, encoding);
            assert_eq!(decoded.bom, bom);
            assert_eq!(decoded.newline, Newline::Crlf);
            assert_eq!(encode_text(&decoded.text, decoded.encoding, decoded.bom).unwrap(), bytes);
        }
    }

    #[test]
    fn refuses_binary_and_invalid_bytes() {
        assert!(matches!(decode_text(b"PK\x03\x04rest"), Err(TextError::BinaryContent(_))));
        assert!(matches!(decode_text(b"a\x00b"), Err(TextError::BinaryContent(_))));
        assert!(matches!(decode_text(&[0x61, 0xff, 0x62]), Err(TextError::InvalidText(_))));
    }

    #[test]
    fn detects_mixed_newlines() {
        assert_eq!(decode_text(b"a\nb\r\nc").unwrap().newline, Newline::Mixed);
        assert_eq!(decode_text(b"abc").unwrap().newline, Newline::None);
    }
}
