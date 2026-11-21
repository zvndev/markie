//! OASIS OpenDocument 1.3 Part 2 sections 3.2 to 3.4; Part 3 sections 3.4, 5.1, 5.5 and 6.1.
//! Ported from `src/lib/document-import/odt.ts`: main-body text to a new text copy.

use super::{DocumentImportError, DocumentImportLimits, ImportErrorCode, ImportResult, ImportedDocumentText, TextAccumulator, decode_import_text};
use crate::error::{ErrorKind, OfficeError};
use crate::xml::{XmlElement, parse_xml_limited, xml_attribute, xml_descendants};
use crate::zip::{ZipLimits, read_zip};
use std::collections::HashMap;

const MIME: &str = "application/vnd.oasis.opendocument.text";
const OFFICE: &str = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TEXT: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const TABLE: &str = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const MANIFEST: &str = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const OMIT_TEXT: &[&str] = &["tracked-changes", "changed-region", "deletion", "note", "hidden-text", "hidden-paragraph", "conditional-text", "script"];

fn err(code: ImportErrorCode, message: &str) -> DocumentImportError {
    DocumentImportError::new(code, message)
}

fn map_office(error: OfficeError) -> DocumentImportError {
    match error.kind {
        ErrorKind::Zip => {
            let code = if error.code.contains("limit") || error.code.contains("expansion") {
                ImportErrorCode::LimitExceeded
            } else if error.code.contains("unsupported") || error.code.contains("platform") {
                ImportErrorCode::Unsupported
            } else {
                ImportErrorCode::Malformed
            };
            err(code, "ODT package could not be safely decoded.")
        }
        ErrorKind::Xml => err(
            if error.message.contains("limit") { ImportErrorCode::LimitExceeded } else { ImportErrorCode::Malformed },
            "ODT XML is invalid or exceeds the supported safe subset.",
        ),
        _ => err(ImportErrorCode::Malformed, "ODT text could not be safely converted."),
    }
}

/// Matches ODF `1.0` to `1.4`.
pub(crate) fn supported_version(version: &str) -> bool {
    matches!(version, "1.0" | "1.1" | "1.2" | "1.3" | "1.4")
}

pub fn extract_odt_text(bytes: &[u8], limits: DocumentImportLimits) -> ImportResult<ImportedDocumentText> {
    let le16 = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    if bytes.len() < 38
        || u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != 0x0403_4b50
        || le16(8) != 0
        || le16(26) != 8
        || le16(28) != 0
        || decode_import_text(&bytes[30..38], true).ok().as_deref() != Some("mimetype")
    {
        return Err(err(
            ImportErrorCode::Malformed,
            "ODT must begin with an uncompressed mimetype entry without ZIP extra fields.",
        ));
    }
    let entries = read_zip(
        bytes,
        ZipLimits {
            max_archive_bytes: limits.max_input_bytes,
            max_entry_bytes: limits.max_input_bytes,
            max_expanded_bytes: limits.max_expanded_bytes,
            max_entries: limits.max_archive_entries,
            max_compression_ratio: limits.max_compression_ratio,
        },
    )
    .map_err(map_office)?;
    let parts: HashMap<&str, &[u8]> = entries.iter().map(|e| (e.name.as_str(), e.data.as_slice())).collect();
    let mimetype = parts.get("mimetype").map(|m| decode_import_text(m, true)).transpose()?;
    if mimetype.as_deref() != Some(MIME) {
        return Err(err(ImportErrorCode::Unsupported, "This is not an OpenDocument Text package."));
    }
    let (Some(manifest_bytes), Some(content)) = (parts.get("META-INF/manifest.xml"), parts.get("content.xml")) else {
        return Err(err(ImportErrorCode::Malformed, "ODT requires a manifest and content.xml."));
    };
    let manifest = parse_xml_limited(&decode_import_text(manifest_bytes, true)?, limits.max_input_bytes).map_err(map_office)?;
    if manifest.namespace != MANIFEST || manifest.local_name != "manifest" {
        return Err(err(ImportErrorCode::Malformed, "ODT manifest namespace is invalid."));
    }
    if xml_descendants(&manifest)
        .iter()
        .any(|n| n.namespace == MANIFEST && (n.local_name == "encryption-data" || n.local_name == "encrypted-key"))
    {
        return Err(err(ImportErrorCode::Encrypted, "Encrypted ODT packages are not converted."));
    }
    let entries_for = |path: &str| -> Vec<&XmlElement> {
        manifest
            .children
            .iter()
            .filter(|n| n.namespace == MANIFEST && n.local_name == "file-entry" && xml_attribute(n, "full-path", MANIFEST) == Some(path))
            .collect()
    };
    let (root_entries, content_entries) = (entries_for("/"), entries_for("content.xml"));
    if root_entries.len() != 1
        || xml_attribute(root_entries[0], "media-type", MANIFEST) != Some(MIME)
        || content_entries.len() != 1
        || xml_attribute(content_entries[0], "media-type", MANIFEST) != Some("text/xml")
    {
        return Err(err(ImportErrorCode::Malformed, "ODT manifest media types or content references are invalid."));
    }
    let source = decode_import_text(content, true)?;
    let root = parse_xml_limited(&source, limits.max_input_bytes).map_err(map_office)?;
    let mut budget: Vec<(&XmlElement, usize)> = vec![(&manifest, 1), (&root, 1)];
    let mut structural = 0usize;
    while let Some((node, depth)) = budget.pop() {
        structural += 1;
        if structural > limits.max_nodes || depth > limits.max_depth {
            return Err(err(ImportErrorCode::LimitExceeded, "ODT XML structure exceeds the import budget."));
        }
        for child in &node.children {
            budget.push((child, depth + 1));
        }
    }
    if root.namespace != OFFICE || root.local_name != "document-content" {
        return Err(err(ImportErrorCode::Malformed, "ODT content root namespace is invalid."));
    }
    // TextEdit writes ODF 1.0 and current LibreOffice writes 1.4; the text elements read here are the same.
    if let Some(version) = xml_attribute(&root, "version", OFFICE)
        && !supported_version(version)
    {
        return Err(err(ImportErrorCode::Unsupported, "Only OpenDocument 1.0 to 1.4 text is converted."));
    }
    let bodies: Vec<&XmlElement> = root.children.iter().filter(|n| n.namespace == OFFICE && n.local_name == "body").collect();
    let texts: Vec<&XmlElement> = if bodies.len() == 1 {
        bodies[0].children.iter().filter(|n| n.namespace == OFFICE && n.local_name == "text").collect()
    } else {
        vec![]
    };
    if texts.len() != 1 {
        return Err(err(ImportErrorCode::Malformed, "ODT requires exactly one office:text body."));
    }
    enum Task<'a> {
        Node { node: &'a XmlElement, depth: usize, paragraph: bool },
        Raw { raw: &'a str, paragraph: bool },
        Newline,
    }
    let mut output = TextAccumulator::new(&limits);
    let mut stack = vec![Task::Node { node: texts[0], depth: 1, paragraph: false }];
    let (mut count, mut omitted) = (0usize, false);
    while let Some(task) = stack.pop() {
        let (node, depth, paragraph) = match task {
            Task::Newline => {
                output.append("\n")?;
                continue;
            }
            Task::Raw { raw, paragraph } => {
                if paragraph && !raw.is_empty() {
                    let wrapped = format!("<t>{raw}</t>");
                    let decoded = parse_xml_limited(&wrapped, wrapped.len() + 7).map_err(map_office)?.text;
                    output.append(&collapse_xml_space(&decoded))?;
                }
                continue;
            }
            Task::Node { node, depth, paragraph } => (node, depth, paragraph),
        };
        count += 1;
        if count > limits.max_nodes || depth > limits.max_depth {
            return Err(err(ImportErrorCode::LimitExceeded, "ODT structure exceeds the import budget."));
        }
        let display = xml_attribute(node, "display", TEXT);
        if (node.namespace == TEXT
            && (OMIT_TEXT.contains(&node.local_name.as_str())
                || display == Some("none")
                || display == Some("condition")
                || xml_attribute(node, "condition", TEXT).is_some()))
            || (node.namespace == OFFICE && node.local_name != "text")
            || ![TEXT, TABLE, OFFICE].contains(&node.namespace.as_str())
        {
            omitted = true;
            continue;
        }
        let is_paragraph = node.namespace == TEXT && (node.local_name == "p" || node.local_name == "h");
        let paragraph = paragraph || is_paragraph;
        if node.namespace == TEXT && node.local_name == "s" {
            let raw = xml_attribute(node, "c", TEXT).unwrap_or("1");
            let valid = !raw.is_empty() && raw.len() <= 10 && raw.bytes().all(|b| b.is_ascii_digit()) && !raw.starts_with('0');
            let count = if valid { raw.parse::<usize>().ok() } else { None };
            let Some(count) = count.filter(|c| *c <= limits.max_text_code_units) else {
                return Err(err(ImportErrorCode::LimitExceeded, "ODT repeated spaces exceed the text budget."));
            };
            if paragraph {
                output.append(&" ".repeat(count))?;
            }
            continue;
        }
        if node.namespace == TEXT && (node.local_name == "tab" || node.local_name == "line-break") {
            if paragraph {
                output.append(if node.local_name == "tab" { "\t" } else { "\n" })?;
            }
            continue;
        }
        let mut work: Vec<Task> = Vec::new();
        let mut cursor = node.start_tag_end;
        for child in &node.children {
            if cursor < child.start {
                work.push(Task::Raw { raw: &source[cursor..child.start], paragraph });
            }
            work.push(Task::Node { node: child, depth: depth + 1, paragraph });
            cursor = child.end;
        }
        if !node.self_closing() && cursor < node.end_tag_start {
            work.push(Task::Raw { raw: &source[cursor..node.end_tag_start], paragraph });
        }
        if is_paragraph {
            work.push(Task::Newline);
        }
        while let Some(t) = work.pop() {
            stack.push(t);
        }
    }
    let mut text = output.result();
    if text.ends_with('\n') {
        text.pop();
    }
    let mut warnings = vec![
        "ODT was converted to a new plain-text copy. Styles, page layout, table geometry, links, fields, media and embedded objects are not preserved; no external resources are loaded.".to_string(),
        "Only main-body paragraph/heading text is converted. Tracked-deleted text, comments, notes, hidden/conditional content and scripts are excluded; revision history is not preserved.".to_string(),
    ];
    if omitted {
        warnings.push("Unsupported, private annotation/history or embedded content was omitted.".into());
    }
    Ok(ImportedDocumentText { text, warnings })
}

/// `replace(/[\t\n\r ]+/g, " ")`
pub(crate) fn collapse_xml_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if matches!(c, '\t' | '\n' | '\r' | ' ') {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}
