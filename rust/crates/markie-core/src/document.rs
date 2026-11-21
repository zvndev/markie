//! Opening and saving one document, with the bytes-in, bytes-out guarantee:
//! a text file comes back with the encoding, BOM and line endings it had.

use std::path::{Path, PathBuf};

use crate::formats::{DecodedText, Editing, FormatKind, Representation, TextEncoding, classify, decode_text, encode_text};
use crate::save::atomic_write;

/// What the document pane needs to show a file.
#[derive(Clone, Debug)]
pub enum Content {
    /// Editable text, with how to write it back.
    Text { text: String, encoding: TextEncoding, bom: bool },
    /// A format this build can show but not edit yet (Office documents).
    Engine,
    /// HTML: shown, never edited, matching the Electron app.
    Html(String),
}

#[derive(Clone, Debug)]
pub struct Document {
    pub path: PathBuf,
    pub format: FormatKind,
    pub content: Content,
}

#[derive(Debug)]
pub enum OpenError {
    Io(std::io::Error),
    Text(crate::formats::TextError),
    Unsupported,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Io(e) => write!(f, "Markie could not read this file: {e}"),
            OpenError::Text(e) => write!(f, "{e}"),
            OpenError::Unsupported => f.write_str("Markie does not open this kind of file."),
        }
    }
}

impl std::error::Error for OpenError {}

pub fn open(path: &Path) -> Result<Document, OpenError> {
    // One spelling per file: a relative path from the command line must not
    // become a second registry row or a confusing status bar.
    let path = &std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let format = classify(&path.to_string_lossy());
    let content = match (format, format.representation(), format.editing()) {
        (FormatKind::Unsupported, ..) => return Err(OpenError::Unsupported),
        (FormatKind::Html, ..) => {
            let bytes = std::fs::read(path).map_err(OpenError::Io)?;
            Content::Html(String::from_utf8_lossy(&bytes).into_owned())
        }
        (_, Representation::Text, _) => {
            let bytes = std::fs::read(path).map_err(OpenError::Io)?;
            let DecodedText { text, encoding, bom, .. } = decode_text(&bytes).map_err(OpenError::Text)?;
            Content::Text { text, encoding, bom }
        }
        (_, _, Editing::Engine) => Content::Engine,
        _ => return Err(OpenError::Unsupported),
    };
    Ok(Document { path: path.to_path_buf(), format, content })
}

/// Write `text` back in the document's own encoding.
pub fn save_text(path: &Path, text: &str, encoding: TextEncoding, bom: bool) -> anyhow::Result<()> {
    let bytes = encode_text(text, encoding, bom)?;
    atomic_write(path, &bytes)?;
    Ok(())
}

/// A name for a new document that does not collide with one in `dir`.
pub fn untitled_path(dir: &Path, extension: &str) -> PathBuf {
    let first = dir.join(format!("Untitled.{extension}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("Untitled {n}.{extension}")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_round_trips_through_open_and_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let original = b"\xef\xbb\xbf# Hi\r\nthere\r\n";
        std::fs::write(&path, original).unwrap();
        let doc = open(&path).unwrap();
        let Content::Text { text, encoding, bom } = doc.content else { panic!("text") };
        assert_eq!(doc.format, FormatKind::Markdown);
        save_text(&path, &text, encoding, bom).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn office_and_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        let docx = dir.path().join("a.docx");
        std::fs::write(&docx, b"PK\x03\x04").unwrap();
        assert!(matches!(open(&docx).unwrap().content, Content::Engine));
        assert!(matches!(open(&dir.path().join("a.png")), Err(OpenError::Unsupported)));
    }

    #[test]
    fn untitled_names_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(untitled_path(dir.path(), "md").file_name().unwrap(), "Untitled.md");
        std::fs::write(dir.path().join("Untitled.md"), "").unwrap();
        assert_eq!(untitled_path(dir.path(), "md").file_name().unwrap(), "Untitled 2.md");
    }
}
