//! Conversion of RTF, HTML and ODT into a NEW, explicitly named UTF-8 text copy.
//! Ported from `src/lib/document-import`. The source is never written or relabeled.

mod html;
mod html_entities;
mod odt;
mod rtf;

pub use html::extract_html_text;
pub use odt::extract_odt_text;
pub use rtf::extract_rtf_text;

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdditionalDocumentFormat {
    Rtf,
    Html,
    Odt,
}

impl AdditionalDocumentFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rtf => "rtf",
            Self::Html => "html",
            Self::Odt => "odt",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportErrorCode {
    Malformed,
    Unsupported,
    Encrypted,
    LimitExceeded,
    /// Kept for parity with the TypeScript codes. The Rust importers carry
    /// their own HTML parser and Windows-1252 table, so they never return it.
    PlatformUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentImportError {
    pub code: ImportErrorCode,
    pub message: String,
}

impl DocumentImportError {
    pub fn new(code: ImportErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl fmt::Display for DocumentImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for DocumentImportError {}

pub type ImportResult<T> = std::result::Result<T, DocumentImportError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DocumentImportLimits {
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
    pub max_text_code_units: usize,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_archive_entries: usize,
    pub max_expanded_bytes: usize,
    pub max_compression_ratio: usize,
    pub max_control_words: usize,
}

pub const DEFAULT_DOCUMENT_IMPORT_LIMITS: DocumentImportLimits = DocumentImportLimits {
    max_input_bytes: 16 * 1024 * 1024,
    max_output_bytes: 32 * 1024 * 1024,
    max_text_code_units: 8 * 1024 * 1024,
    max_depth: 128,
    max_nodes: 100_000,
    max_archive_entries: 2048,
    max_expanded_bytes: 32 * 1024 * 1024,
    max_compression_ratio: 1000,
    max_control_words: 1_000_000,
};

impl Default for DocumentImportLimits {
    fn default() -> Self {
        DEFAULT_DOCUMENT_IMPORT_LIMITS
    }
}

pub fn resolve_document_import_limits(limits: DocumentImportLimits) -> ImportResult<DocumentImportLimits> {
    let values = [
        limits.max_input_bytes,
        limits.max_output_bytes,
        limits.max_text_code_units,
        limits.max_depth,
        limits.max_nodes,
        limits.max_archive_entries,
        limits.max_expanded_bytes,
        limits.max_compression_ratio,
        limits.max_control_words,
    ];
    if values.iter().any(|v| *v < 1 || *v > (1usize << 53) - 1) {
        return Err(DocumentImportError::new(
            ImportErrorCode::LimitExceeded,
            "Document import limits must be positive safe integers.",
        ));
    }
    Ok(limits)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedDocumentText {
    pub text: String,
    pub warnings: Vec<String>,
}

pub(crate) fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// UTF-8, or BOM-labelled UTF-16 (fatal on any invalid sequence).
pub fn decode_import_text(bytes: &[u8], utf8_only: bool) -> ImportResult<String> {
    let fail = || {
        DocumentImportError::new(
            ImportErrorCode::Unsupported,
            if utf8_only {
                "This package requires valid UTF-8 XML."
            } else {
                "HTML text must use UTF-8 or BOM-labelled UTF-16; other encodings are not converted."
            },
        )
    };
    let utf16 = |little: bool| -> ImportResult<String> {
        if utf8_only || bytes.len() % 2 != 0 {
            return Err(fail());
        }
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| if little { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16(&units).map_err(|_| fail())
    };
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe {
        return utf16(true);
    }
    if bytes.len() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff {
        return utf16(false);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| fail())?;
    // TextDecoder strips a leading UTF-8 BOM by default.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(text).to_string())
}

/// Collects output while budgeting UTF-16 code units, as the TypeScript does.
pub(crate) struct TextAccumulator {
    out: String,
    length: usize,
    max: usize,
}

impl TextAccumulator {
    pub(crate) fn new(limits: &DocumentImportLimits) -> Self {
        Self { out: String::new(), length: 0, max: limits.max_text_code_units }
    }
    pub(crate) fn append(&mut self, text: &str) -> ImportResult<()> {
        let units = utf16_len(text);
        if units > self.max - self.length {
            return Err(DocumentImportError::new(
                ImportErrorCode::LimitExceeded,
                "Converted text exceeds the character budget.",
            ));
        }
        self.length += units;
        self.out.push_str(text);
        Ok(())
    }
    pub(crate) fn last_char(&self) -> Option<char> {
        self.out.chars().next_back()
    }
    pub(crate) fn result(self) -> String {
        self.out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdditionalDocumentInput<'a> {
    pub name: &'a str,
    pub bytes: &'a [u8],
    pub format: AdditionalDocumentFormat,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConvertedTextCopy {
    pub source_format: AdditionalDocumentFormat,
    /// Always `<stem> converted.txt`, never the source name.
    pub name: String,
    pub text: String,
    /// UTF-8 bytes of `text`, owned by the caller.
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
}

impl ConvertedTextCopy {
    /// The original file is never written by this conversion.
    pub const CAN_WRITE_ORIGINAL: bool = false;
}

/// Creates an explicitly named new UTF-8 text copy. Never writes or relabels the source.
pub fn convert_additional_document(input: &AdditionalDocumentInput, limits: DocumentImportLimits) -> ImportResult<ConvertedTextCopy> {
    let limits = resolve_document_import_limits(limits)?;
    let name = input.name;
    if name.trim().is_empty() || utf16_len(name) > 256 || name.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}' || c == '/' || c == '\\') {
        return Err(DocumentImportError::new(ImportErrorCode::Unsupported, "Choose a named RTF, HTML or ODT source file."));
    }
    if input.bytes.len() > limits.max_input_bytes {
        return Err(DocumentImportError::new(
            ImportErrorCode::LimitExceeded,
            "Source exceeds the document-import byte budget.",
        ));
    }
    let bytes = input.bytes.to_vec();
    let result = match input.format {
        AdditionalDocumentFormat::Rtf => extract_rtf_text(&bytes, limits)?,
        AdditionalDocumentFormat::Html => extract_html_text(&bytes, limits)?,
        AdditionalDocumentFormat::Odt => extract_odt_text(&bytes, limits)?,
    };
    if utf16_len(&result.text) > limits.max_text_code_units {
        return Err(DocumentImportError::new(ImportErrorCode::LimitExceeded, "Converted text exceeds the character budget."));
    }
    let mut warnings = result.warnings.clone();
    let text = normalize_copy_text(&result.text);
    if text != result.text {
        warnings.push(
            "Source control characters/newline encoding were normalized or omitted for a safe editable UTF-8 text copy.".into(),
        );
    }
    let output = text.as_bytes().to_vec();
    if output.len() > limits.max_output_bytes {
        return Err(DocumentImportError::new(
            ImportErrorCode::LimitExceeded,
            "Converted UTF-8 text exceeds the output byte budget.",
        ));
    }
    let without_extension = match name.rfind('.') {
        Some(dot) => &name[..dot],
        None => name,
    };
    let mut stem = String::new();
    let mut units = 0;
    for c in without_extension.chars() {
        let n = c.len_utf16();
        if units + n > 220 {
            // JavaScript slice() would cut a surrogate pair; toWellFormed() makes it U+FFFD.
            if units < 220 {
                stem.push('\u{fffd}');
            }
            break;
        }
        units += n;
        stem.push(c);
    }
    if stem.is_empty() {
        stem = "Document".into();
    }
    Ok(ConvertedTextCopy {
        source_format: input.format,
        name: format!("{stem} converted.txt"),
        text,
        bytes: output,
        warnings,
    })
}

fn normalize_copy_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\u{b}' => out.push('\n'),
            '\u{c}' => out.push_str("\n\n"),
            '\u{0}'..='\u{8}' | '\u{e}'..='\u{1f}' | '\u{7f}' => {}
            _ => out.push(c),
        }
    }
    out
}
