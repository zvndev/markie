//! One entry point over the three rich codecs. Ported from `rich-document.ts`.
//! Each codec owns its source; nothing travels through another format.

use crate::docx::{self, DocxDocument};
use crate::error::{OfficeError, Result};
use crate::model::*;
use crate::odt::{self, OdtDocument};
use crate::rtf::{self, RtfDocument};
use crate::zip::DEFAULT_ZIP_LIMITS;

#[derive(Clone, Debug)]
pub enum OfficeDocument {
    Docx(DocxDocument),
    Rtf(RtfDocument),
    Odt(OdtDocument),
}

impl std::ops::Deref for OfficeDocument {
    type Target = RichDocument;
    fn deref(&self) -> &RichDocument {
        match self {
            Self::Docx(d) => d,
            Self::Rtf(d) => d,
            Self::Odt(d) => d,
        }
    }
}

/// What the editor may offer for a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub run_formatting: bool,
    pub paragraph_formatting: bool,
    pub page_layout: bool,
    pub tables: bool,
    pub images: bool,
    pub lists: bool,
    pub hyperlinks: bool,
    pub page_breaks: bool,
    pub review: bool,
    pub named_styles: bool,
}

pub fn rich_capabilities(document: &OfficeDocument) -> Capabilities {
    let editable = document.can_edit;
    let word = editable && matches!(document, OfficeDocument::Docx(_));
    Capabilities {
        run_formatting: editable,
        paragraph_formatting: editable,
        page_layout: editable,
        tables: word,
        images: word,
        lists: word,
        hyperlinks: word,
        page_breaks: word,
        review: word,
        named_styles: word,
    }
}

pub fn open_rich_document(format: Format, bytes: &[u8]) -> Result<OfficeDocument> {
    Ok(match format {
        Format::Docx => OfficeDocument::Docx(docx::open_docx(bytes, DEFAULT_ZIP_LIMITS)?),
        Format::Rtf => OfficeDocument::Rtf(rtf::open_rtf(bytes)?),
        Format::Odt => OfficeDocument::Odt(odt::open_odt_for_display(bytes)?),
    })
}

pub fn create_rich_document(format: Format, text: &str) -> Result<OfficeDocument> {
    Ok(match format {
        Format::Docx => OfficeDocument::Docx(docx::create_docx(text)?),
        Format::Rtf => OfficeDocument::Rtf(rtf::create_rtf(text)?),
        Format::Odt => OfficeDocument::Odt(odt::create_odt(text)?),
    })
}

const SIMPLE: &[&str] = &["format-run", "format-range", "replace-paragraph", "insert-paragraph", "delete-paragraph", "format-paragraph", "set-page-layout"];

pub fn apply_rich_operations(document: &OfficeDocument, operations: &[Operation]) -> Result<OfficeDocument> {
    if !matches!(document, OfficeDocument::Docx(_)) && operations.iter().any(|op| !SIMPLE.contains(&op.name())) {
        return Err(OfficeError::docx("unsupported-operation", "This format does not support that editing command."));
    }
    Ok(match document {
        OfficeDocument::Docx(d) => OfficeDocument::Docx(docx::apply_docx_operations(d, operations)?),
        OfficeDocument::Rtf(d) => OfficeDocument::Rtf(rtf::apply_rtf_operations(d, operations)?),
        OfficeDocument::Odt(d) => OfficeDocument::Odt(odt::apply_odt_operations(d, operations)?),
    })
}

pub fn replace_rich_text(document: &OfficeDocument, edits: &[TextEdit]) -> Result<OfficeDocument> {
    Ok(match document {
        OfficeDocument::Docx(d) => OfficeDocument::Docx(docx::replace_docx_text(d, edits)?),
        OfficeDocument::Rtf(d) => OfficeDocument::Rtf(rtf::replace_rtf_text(d, edits)?),
        OfficeDocument::Odt(d) => OfficeDocument::Odt(odt::replace_odt_text(d, edits)?),
    })
}

/// Source-preserving structural range edits exist for DOCX only.
pub fn replace_rich_range(document: &OfficeDocument, range: &TextRange, text: &str) -> Result<(OfficeDocument, TextRange)> {
    match document {
        OfficeDocument::Docx(d) => {
            let edit = docx::replace_docx_range(d, range, text)?;
            Ok((OfficeDocument::Docx(edit.document), edit.selection))
        }
        _ => Err(OfficeError::docx("unsupported-operation", "Source-preserving structural range edits are not yet supported for this format.")),
    }
}

pub fn export_rich_document(document: &OfficeDocument) -> Result<Vec<u8>> {
    match document {
        OfficeDocument::Docx(d) => docx::export_docx(d),
        OfficeDocument::Rtf(d) => rtf::export_rtf(d),
        OfficeDocument::Odt(d) => odt::export_odt(d),
    }
}

pub fn rich_image_bytes(document: &OfficeDocument, image_id: &str) -> Result<Vec<u8>> {
    match document {
        OfficeDocument::Docx(d) => docx::get_docx_image_bytes(d, image_id),
        _ => Err(OfficeError::docx("unsupported-operation", "Images are not supported in this document format.")),
    }
}

/// New snapshots may only replace snapshots from their own opened source lineage.
/// DOCX snapshots are value-owned, so any two DOCX snapshots qualify, as in TypeScript.
pub fn same_rich_source(a: &OfficeDocument, b: &OfficeDocument) -> bool {
    match (a, b) {
        (OfficeDocument::Rtf(x), OfficeDocument::Rtf(y)) => rtf::is_same_rtf_source(x, y),
        (OfficeDocument::Odt(x), OfficeDocument::Odt(y)) => odt::is_same_odt_source(x, y),
        (OfficeDocument::Docx(_), OfficeDocument::Docx(_)) => true,
        _ => false,
    }
}
