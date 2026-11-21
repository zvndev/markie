//! One error type for every codec. `code` keeps the TypeScript error codes so
//! the UI and tests can match on them; `message` keeps the TypeScript wording.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Zip,
    Xml,
    Docx,
    Cfb,
    Doc,
    Rtf,
    Odt,
    Import,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfficeError {
    pub kind: ErrorKind,
    pub code: String,
    pub message: String,
}

impl OfficeError {
    pub fn new(kind: ErrorKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { kind, code: code.into(), message: message.into() }
    }
    pub fn zip(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Zip, code, message)
    }
    pub fn xml(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Xml, "invalid-xml", message)
    }
    pub fn docx(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Docx, code, message)
    }
}

impl fmt::Display for OfficeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for OfficeError {}

pub type Result<T> = std::result::Result<T, OfficeError>;
