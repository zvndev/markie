//! Port of src/lib/document-import/{html,rtf,odt,index}.test.ts.
use markie_office::document_import::*;
use markie_office::zip::{DEFAULT_ZIP_LIMITS, ZipEntry, write_zip};

fn limits() -> DocumentImportLimits { DEFAULT_DOCUMENT_IMPORT_LIMITS }
fn html(text: &str) -> ImportedDocumentText { extract_html_text(text.as_bytes(), limits()).unwrap() }
fn html_with(text: &str, l: DocumentImportLimits) -> ImportResult<ImportedDocumentText> { extract_html_text(text.as_bytes(), l) }

// ---- html.test.ts ----
#[test]
fn html_extracts_paragraph_heading_inline_text_and_character_references_in_order() {
    assert_eq!(html("<h1>Title</h1><p>Alpha <strong>bold</strong> tail</p><p>Next &amp; &#x1F600; &NotEqualTilde;</p>").text, "Title\nAlpha bold tail\nNext & 😀 ≂̸");
}
#[test]
fn html_flattens_table_cells_and_breaks_while_preserving_preformatted_text() {
    assert_eq!(html("<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table><pre>  x\n y</pre><p>a<br>b</p>").text, "A\tB\nC\tD\n  x\n y\na\nb");
}
#[test]
fn html_does_not_execute_scripts_custom_elements_handlers_forms_or_fetch() {
    // There is no script engine, network or live DOM here; the visible text must still match.
    let result = html(r#"<script>globalThis.__importExecuted=true</script><import-probe>safe custom text</import-probe><form><p>private form</p></form><img src="https://invalid.example/image" onerror="globalThis.__importExecuted=true"><iframe src="https://invalid.example/frame">private frame</iframe><p>visible</p>"#);
    assert_eq!(result.text, "safe custom text\nvisible");
}
#[test]
fn html_omits_explicit_hidden_metadata_foreign_and_closed_content() {
    let result = html(r#"<html><head><title>private title</title><style>.hidden{display:none}</style></head><body><p hidden>hidden</p><p aria-hidden="true">aria</p><p style="display:none">css</p><p style="visibility:hidden">visibility</p><svg><text>foreign secret</text></svg><dialog>closed</dialog><details><summary>Summary</summary>closed body</details><p>Visible</p></body></html>"#);
    assert_eq!(result.text, "Summary\nVisible");
    assert!(result.warnings.join(" ").contains("stylesheet class rules"));
    assert!(result.warnings.join(" ").contains("omitted"));
}
#[test]
fn html_reads_bom_utf16_and_rejects_invalid_or_unlabelled_legacy_encoding() {
    let mut utf16 = vec![255u8, 254];
    for u in "<p>世界</p>".encode_utf16() { utf16.extend(u.to_le_bytes()); }
    assert_eq!(extract_html_text(&utf16, limits()).unwrap().text, "世界");
    assert!(extract_html_text(&[0xff], limits()).is_err());
}
#[test]
fn html_budgets_visible_and_omitted_template_nodes_depth_comments_and_output() {
    let d = limits();
    for (source, l) in [("<p><span>text</span></p>", DocumentImportLimits { max_nodes: 2, ..d }), ("<p><span>text</span></p>", DocumentImportLimits { max_depth: 2, ..d }),
        ("<template><p>hidden</p></template>", DocumentImportLimits { max_nodes: 2, ..d }), ("<!--a--><!--b--><!--c-->", DocumentImportLimits { max_nodes: 2, ..d }),
        ("<p>1234</p>", DocumentImportLimits { max_text_code_units: 3, ..d })] {
        assert!(html_with(source, l).is_err(), "{source}");
    }
}
#[test]
fn html_keeps_raw_script_and_literal_less_than_from_bypassing_preflight() {
    assert_eq!(html(r#"<script>var less = "<";</script><p>Visible &lt; 3</p>"#).text, "Visible < 3");
    assert!(html_with(&("<p>literal < 3</p>".to_string() + &"<i>x</i>".repeat(30)), DocumentImportLimits { max_nodes: 10, ..limits() }).is_err());
    assert!(html_with("<!--unterminated", limits()).is_err());
}

// ---- rtf.test.ts ----
fn rtf(source: &str) -> ImportedDocumentText { rtf_with(source, limits()).unwrap_or_else(|e| panic!("{source}: {}", e.message)) }
fn rtf_with(source: &str, l: DocumentImportLimits) -> ImportResult<ImportedDocumentText> {
    // Each JS char code is one byte, as in the TypeScript fixture encoder.
    let bytes: Vec<u8> = source.chars().map(|c| c as u32 as u8).collect();
    extract_rtf_text(&bytes, l)
}
fn rtf_fails(source: &str, code: ImportErrorCode, l: DocumentImportLimits) {
    assert_eq!(rtf_with(source, l).err().map(|e| e.code), Some(code), "{source}");
}
#[test]
fn rtf_extracts_literal_body_text_groups_and_boundaries() {
    let result = rtf(r"{\rtf1\ansi Hello {\b bold} and {\i italic}.\par Next\line line\tab tab}");
    assert_eq!(result.text, "Hello bold and italic.\nNext\nline\ttab");
    assert!(result.warnings.join(" ").contains("new plain-text copy"));
    assert!(result.warnings.join(" ").contains("not preserved"));
}
#[test]
fn rtf_honors_one_delimiter_space_and_explicit_escapes() {
    assert_eq!(rtf("{\\rtf1\r\n\\ansi  One\r\nTwo\\b  spaces}").text, " OneTwo spaces");
    assert_eq!(rtf(r"{\rtf1 \{brace\} \\ path\~space\-soft\_join}").text, "{brace} \\ path\u{a0}space\u{ad}soft\u{2011}join");
    assert_eq!(rtf(r"{\rtf1 A\emdash B\endash C\lquote D\rquote\ldblquote E\rdblquote\bullet}").text, "A—B–C‘D’“E”•");
}
#[test]
fn rtf_decodes_raw_and_escaped_windows_1252() {
    assert_eq!(rtf(r"{\rtf1\ansi\ansicpg1252 caf\'e9 \'27literal}").text, "café 'literal");
    assert_eq!(rtf("{\\rtf1\\ansi\\ansicpg1252 raw \u{e9} \\'80 \\'93quoted\\'94}").text, "raw é € “quoted”");
}
#[test]
fn rtf_decodes_signed_unicode_scoped_fallback_and_surrogate_pairs() {
    assert_eq!(rtf(r"{\rtf1\uc1 A\u28450?{\uc0\u233}B\u233?}").text, "A漢éBé");
    assert_eq!(rtf(r"{\rtf1\uc1 \u-10179?\u-8704?}").text, "😀");
    assert_eq!(rtf(r"{\rtf1\uc2 \u233\'3f?Z}").text, "éZ");
    assert_eq!(rtf(r"{\rtf1\uc1 \u233\~Z}").text, "éZ");
    assert_eq!(rtf(r"{\rtf1\uc1 \u233\b Z}").text, "éZ");
    assert_eq!(rtf(r"{\rtf1\uc2 \u233{X}Y}").text, "éXY");
}
#[test]
fn rtf_omits_metadata_tables_field_instructions_comments_and_ignorable_groups() {
    let result = rtf(r#"{\rtf1\ansi\deff0{\fonttbl{\f0\fcharset0 Example Font;}}{\colortbl;\red0\green0\blue0;}{\info{\author Secret Author}{\title Secret Title}}Body{\*\unknownDestination hidden {nested} \'e9}{\annotation private comment}{\header Page header}{\footer Page footer}{\footnote Note}{\field{\*\fldinst HYPERLINK "https://invalid.example"}{\fldrslt Visible link}}}"#);
    assert_eq!(result.text, "BodyVisible link");
    assert!(result.warnings.join(" ").contains("non-body destinations"));
}
#[test]
fn rtf_omits_hex_image_and_object_payloads() {
    assert_eq!(rtf(r"{\rtf1 Body{\pict\pngblip 89504e470d0a}{\object{\*\objdata 01020304}{\result object fallback}}Tail}").text, "BodyTail");
}
#[test]
fn rtf_does_not_expose_metadata_destinations_outside_info() {
    assert_eq!(rtf(r"{\rtf1{\title Private title}{\author Private author}{\company Private company}Body}").text, "Body");
}
#[test]
fn rtf_recognizes_visible_destinations_even_when_marked_ignorable() {
    assert_eq!(rtf(r"{\rtf1{\field{\*\fldinst SECRET INSTRUCTION}{\*\fldrslt Visible}}}").text, "Visible");
}
#[test]
fn rtf_scopes_hidden_text_and_resets_with_plain() {
    let result = rtf(r"{\rtf1 A{\v hidden}B\v secret\plain C\v0 D}");
    assert_eq!(result.text, "ABCD");
    assert!(result.warnings.join(" ").contains("Hidden RTF text"));
}
#[test]
fn rtf_flattens_table_rows_and_cells_with_a_warning() {
    let result = rtf(r"{\rtf1\trowd\intbl A\cell B\cell\row C\nestcell D\nestrow}");
    assert_eq!(result.text, "A\tB\t\nC\tD\n");
    assert!(result.warnings.join(" ").contains("tables were flattened"));
}
#[test]
fn rtf_tracks_font_table_codepage_overrides() {
    assert_eq!(rtf(r"{\rtf1\deff0{\fonttbl{\f0\fcharset0 Standard;}{\f1\fcharset204 Foreign;}}\f0 caf\'e9}").text, "café");
    assert_eq!(rtf(r"{\rtf1{\fonttbl{\f0\fcharset204\cpg1252 Override;}}\f0 caf\'e9}").text, "café");
    assert_eq!(rtf(r"{\rtf1{\fonttbl{\f0\fcharset128 Japanese;}}\f0\uc0\u28450}").text, "漢");
    rtf_fails(r"{\rtf1{\fonttbl{\f1\fcharset204 Cyrillic;}}\f1\'e9}", ImportErrorCode::Unsupported, limits());
    rtf_fails(r"{\rtf1{\fonttbl{\f1\fcharset2 Symbol;}}\f1 ABC}", ImportErrorCode::Unsupported, limits());
}
#[test]
fn rtf_warns_for_unknown_controls_and_respects_case() {
    let result = rtf(r"{\rtf1 A\futureword12 B\PAR C}");
    assert_eq!(result.text, "ABC");
    assert!(result.warnings.join(" ").contains("Unrecognized"));
}
#[test]
fn rtf_rejects_unsupported_encoding_binary_alternate_and_revision_semantics() {
    for source in [r"{\rtf1\mac x}", r"{\rtf1\pc x}", r"{\rtf1\pca x}", r"{\rtf1\ansicpg1251 x}", r"{\rtf1\cpg932 x}", r"{\rtf1\fromhtml1 body}", r"{\rtf1\htmlrtf1 body}",
        r"{\rtf1\upr{ANSI}{\*\ud Unicode}}", r"{\rtf1{\*\ud Unicode}}", r"{\rtf1\deleted old}", r"{\rtf1\revised new}", r"{\rtf1\bin3 abc}", r"{\rtf1{\pict\bin3 abc}}", r"{\rtf2 future}"] {
        rtf_fails(source, ImportErrorCode::Unsupported, limits());
    }
}
#[test]
fn rtf_rejects_malformed_structure_or_unicode_without_a_partial_result() {
    for source in ["", "plain text", "{}", r"{\RTF1 x}", r"{\rtf1 x", r"{\rtf1 x}}", r"{\rtf1 x}junk", r"{\rtf1\'f}", r"{\rtf1\'gg}", r"{\rtf1\u}", r"{\rtf1\uc-1 x}", r"{\rtf1\uc x}",
        r"{\rtf1\u65535?}", r"{\rtf1\u-10179?}", r"{\rtf1\u-8704?}", r"{\rtf1\bin-1 x}", r"{\rtf1\fs- x}", r"{\rtf1 x\fonttbl secret}", r"{\rtf1{\* ignored}}", r"{\rtf1\* x}",
        "{\\rtf1 nul\u{0}}", r"{\rtf1\u0?}", r"{\rtf1{\rtf1 nested}}", r"{\rtf1\'81}", r"{\rtf1\fcharset204 text}", r"{\rtf1{\fonttbl{\f0\fcharset256 Bad;}}body}",
        r"{\rtf1{\fonttbl{\f0\cpg0 Bad;}}body}", r"{\rtf1{\fonttbl{\f0 Valid;}}\f99 unknown}"] {
        rtf_fails(source, ImportErrorCode::Malformed, limits());
    }
}
#[test]
fn rtf_bounds_bytes_output_nesting_tokens_names_and_parameters() {
    let d = limits();
    rtf_fails(r"{\rtf1 Body}", ImportErrorCode::LimitExceeded, DocumentImportLimits { max_input_bytes: 3, ..d });
    rtf_fails(r"{\rtf1 12345}", ImportErrorCode::LimitExceeded, DocumentImportLimits { max_text_code_units: 4, ..d });
    rtf_fails(r"{\rtf1{{{{deep}}}}}", ImportErrorCode::LimitExceeded, DocumentImportLimits { max_depth: 3, ..d });
    rtf_fails(r"{\rtf1\b\i\ul\strike x}", ImportErrorCode::LimitExceeded, DocumentImportLimits { max_control_words: 3, ..d });
    rtf_fails(r"{\rtf1{}{}{}}", ImportErrorCode::LimitExceeded, DocumentImportLimits { max_nodes: 3, ..d });
    rtf_fails(&format!("{{\\rtf1\\{} x}}", "a".repeat(33)), ImportErrorCode::LimitExceeded, d);
    rtf_fails(r"{\rtf1\fs12345678901 x}", ImportErrorCode::LimitExceeded, d);
    rtf_fails(r"{\rtf1\fs2147483648 x}", ImportErrorCode::Malformed, d);
}
#[test]
fn rtf_handles_large_runs_and_deterministic_warnings() {
    let body = "Generated text ".repeat(5000);
    let source = format!("{{\\rtf1 {body}}}").into_bytes();
    let original = source.clone();
    assert_eq!(extract_rtf_text(&source, limits()).unwrap().text, body);
    assert_eq!(source, original);
    assert_eq!(rtf(r"{\rtf1 A\future1 B\future2 C}").warnings, rtf(r"{\rtf1 A\future1 B\future2 C}").warnings);
}

// ---- odt.test.ts ----
const MIME: &str = "application/vnd.oasis.opendocument.text";
const OFFICE: &str = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TEXT: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const MANIFEST: &str = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
#[derive(Default)]
struct OdtOpts<'a> { mime: Option<&'a str>, office: Option<&'a str>, version: Option<&'a str>, manifest_extra: Option<&'a str>, manifest: Option<String>, content: Option<String>, extra: Vec<ZipEntry> }
fn make_odt(body: &str, o: OdtOpts) -> markie_office::Result<Vec<u8>> {
    let manifest = o.manifest.unwrap_or_else(|| format!(r#"<manifest:manifest xmlns:manifest="{MANIFEST}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="{MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>{}</manifest:manifest>"#, o.manifest_extra.unwrap_or("")));
    let content = o.content.unwrap_or_else(|| format!(r#"<office:document-content xmlns:office="{}" xmlns:text="{TEXT}" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="{}"><office:body><office:text>{body}</office:text></office:body></office:document-content>"#, o.office.unwrap_or(OFFICE), o.version.unwrap_or("1.3")));
    let mut entries = vec![ZipEntry::new("mimetype", o.mime.unwrap_or(MIME)), ZipEntry::new("META-INF/manifest.xml", manifest), ZipEntry::new("content.xml", content)];
    entries.extend(o.extra);
    write_zip(&entries, DEFAULT_ZIP_LIMITS)
}
fn odt(body: &str) -> Vec<u8> { make_odt(body, OdtOpts::default()).unwrap() }
fn extract(bytes: &[u8]) -> ImportResult<ImportedDocumentText> { extract_odt_text(bytes, limits()) }
#[test]
fn odt_converts_real_producer_output() {
    for bytes in [&include_bytes!("fixtures/textedit-report.odt")[..], &include_bytes!("fixtures/libreoffice-report.odt")[..]] {
        let text = extract(bytes).unwrap().text;
        assert!(text.contains("Quarterly Report\nThis is bold and italic text.\nItems\nStep one\nStep two\nFirst item\nSecond item\nName\nQty\nApples\n3\nPears\n5\nAfter the table."), "{text}");
    }
}
#[test]
fn odt_keeps_mixed_order_headings_entities_tabs_breaks_and_spaces() {
    let result = extract(&odt(r#"<text:h>Title</text:h><text:p>Before <text:span>bold</text:span> after &amp;<text:s text:c="3"/>gap<text:tab/>tab<text:line-break/>line</text:p>"#)).unwrap();
    assert_eq!(result.text, "Title\nBefore bold after &   gap\ttab\nline");
    assert!(result.warnings.join(" ").contains("new plain-text copy"));
}
#[test]
fn odt_excludes_deleted_comments_notes_scripts_foreign_hidden_and_link_targets() {
    let result = extract(&odt(r#"<text:tracked-changes><text:changed-region><text:deletion><text:p>deleted secret</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>Keep<office:annotation><text:p>private comment</text:p></office:annotation><text:note><text:p>note secret</text:p></text:note><text:hidden-text>hidden</text:hidden-text><text:script>script</text:script><text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://invalid.example/private"> link label</text:a><foreign xmlns="urn:foreign"><text:p>foreign secret</text:p></foreign></text:p>"#)).unwrap();
    assert_eq!(result.text, "Keep link label");
    assert!(result.warnings.join(" ").contains("excluded"));
}
#[test]
fn odt_handles_cdata_and_comments_between_spans() {
    assert_eq!(extract(&odt("<text:p>A<![CDATA[ <B> ]]><text:span>C</text:span><!-- ignored -->D</text:p>")).unwrap().text, "A <B> CD");
}
#[test]
fn odt_excludes_hidden_and_conditional_sections_and_fields() {
    let result = extract(&odt(r#"<text:section text:display="none"><text:p>hidden section</text:p></text:section><text:section text:display="condition"><text:p>conditional section</text:p></text:section><text:section text:condition="true()"><text:p>unevaluated section</text:p></text:section><text:section text:display="true"><text:p>Shown<text:variable-set text:display="none">hidden field</text:variable-set> tail</text:p></text:section>"#)).unwrap();
    assert_eq!(result.text, "Shown tail");
}
#[test]
fn odt_rejects_wrong_mimetype_namespace_contract_and_versions() {
    for source in [make_odt("<text:p>Hello</text:p>", OdtOpts { mime: Some("application/zip"), ..Default::default() }), make_odt("<text:p>Hello</text:p>", OdtOpts { office: Some("urn:wrong"), ..Default::default() }),
        make_odt("<text:p>Hello</text:p>", OdtOpts { version: Some("2.0"), ..Default::default() }), make_odt("<text:p>Hello</text:p>", OdtOpts { manifest: Some(r#"<manifest xmlns="urn:wrong"/>"#.into()), ..Default::default() }),
        make_odt("<text:p>Hello</text:p>", OdtOpts { content: Some(format!(r#"<office:document-content xmlns:office="{OFFICE}" office:version="1.3"/>"#)), ..Default::default() })] {
        assert!(extract(&source.unwrap()).is_err());
    }
    let reordered = write_zip(&[ZipEntry::new("content.xml", "x"), ZipEntry::new("mimetype", MIME)], DEFAULT_ZIP_LIMITS).unwrap();
    assert!(extract(&reordered).is_err());
}
#[test]
fn odt_rejects_encrypted_dtd_corrupt_and_unsafe_parts() {
    let encrypted = make_odt("<text:p>Hello</text:p>", OdtOpts { manifest_extra: Some(r#"<manifest:file-entry manifest:full-path="secret"><manifest:encryption-data/></manifest:file-entry>"#), ..Default::default() }).unwrap();
    assert_eq!(extract(&encrypted).unwrap_err().code, ImportErrorCode::Encrypted);
    let dtd = make_odt("", OdtOpts { content: Some(r#"<!DOCTYPE x [<!ENTITY external SYSTEM "https://invalid.example/entity">]><x>&external;</x>"#.into()), ..Default::default() }).unwrap();
    assert_eq!(extract(&dtd).unwrap_err().code, ImportErrorCode::Malformed);
    let mut corrupt = odt("<text:p>Hello</text:p>"); corrupt[40] ^= 255; assert!(extract(&corrupt).is_err());
    assert!(make_odt("<text:p>Hello</text:p>", OdtOpts { extra: vec![ZipEntry::new("../escape", "x")], ..Default::default() }).is_err());
}
#[test]
fn odt_bounds_archive_xml_expansion_spaces_and_text() {
    assert_eq!(extract(&odt(r#"<text:p>12345<text:s text:c="9999999999"/></text:p>"#)).unwrap_err().code, ImportErrorCode::LimitExceeded);
    let simple = odt("<text:p>Hello</text:p>");
    let d = limits();
    for l in [DocumentImportLimits { max_archive_entries: 2, ..d }, DocumentImportLimits { max_expanded_bytes: 10, ..d }, DocumentImportLimits { max_depth: 2, ..d },
        DocumentImportLimits { max_nodes: 2, ..d }, DocumentImportLimits { max_text_code_units: 3, ..d }] {
        assert_eq!(extract_odt_text(&simple, l).unwrap_err().code, ImportErrorCode::LimitExceeded);
    }
}

// ---- index.test.ts ----
fn input<'a>(name: &'a str, bytes: &'a [u8], format: AdditionalDocumentFormat) -> AdditionalDocumentInput<'a> { AdditionalDocumentInput { name, bytes, format } }
#[test]
fn index_never_relabels_or_mutates_html_and_returns_utf8_copy_bytes() {
    let bytes = b"<p>Original &amp; text</p>".to_vec(); let original = bytes.clone();
    let converted = convert_additional_document(&input("source.html", &bytes, AdditionalDocumentFormat::Html), limits()).unwrap();
    assert_eq!(converted.source_format, AdditionalDocumentFormat::Html);
    assert_eq!(converted.name, "source converted.txt"); assert_eq!(converted.text, "Original & text");
    assert!(!ConvertedTextCopy::CAN_WRITE_ORIGINAL);
    assert_eq!(bytes, original); assert_eq!(converted.bytes, converted.text.as_bytes()); assert!(!converted.warnings.is_empty());
}
#[test]
fn index_snapshots_odt_input_before_conversion() {
    let bytes = write_zip(&[ZipEntry::new("mimetype", MIME),
        ZipEntry::new("META-INF/manifest.xml", r#"<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry m:full-path="/" m:media-type="application/vnd.oasis.opendocument.text"/><m:file-entry m:full-path="content.xml" m:media-type="text/xml"/></m:manifest>"#),
        ZipEntry::new("content.xml", r#"<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0" o:version="1.3"><o:body><o:text><t:p>Original text</t:p></o:text></o:body></o:document-content>"#)], DEFAULT_ZIP_LIMITS).unwrap();
    let converted = convert_additional_document(&input("source.odt", &bytes, AdditionalDocumentFormat::Odt), limits()).unwrap();
    assert_eq!(converted.source_format, AdditionalDocumentFormat::Odt); assert_eq!(converted.name, "source converted.txt"); assert_eq!(converted.text, "Original text");
}
#[test]
fn index_removes_unsafe_control_characters_only_in_the_warned_copy() {
    let bytes = b"<p>A&#1;B&#11;C</p>".to_vec(); let original = bytes.clone();
    let result = convert_additional_document(&input("controls.html", &bytes, AdditionalDocumentFormat::Html), limits()).unwrap();
    assert_eq!(result.text, "AB\nC"); assert_eq!(bytes, original);
    assert!(result.warnings.join(" ").contains("control characters"));
}
#[test]
fn index_returns_typed_failures_without_mutating_sources() {
    let bytes = b"not a ZIP".to_vec(); let original = bytes.clone();
    assert_eq!(convert_additional_document(&input("bad.odt", &bytes, AdditionalDocumentFormat::Odt), limits()).unwrap_err().code, ImportErrorCode::Malformed);
    assert_eq!(bytes, original);
    assert_eq!(convert_additional_document(&input("bad.html", &[255], AdditionalDocumentFormat::Html), limits()).unwrap_err().code, ImportErrorCode::Unsupported);
    // The TypeScript "platform-unavailable" case needs a missing DOM; the Rust parser is built in.
}
#[test]
fn index_enforces_limits_and_never_returns_source_names() {
    let bytes = "<p>😀😀</p>".as_bytes();
    let d = limits();
    for l in [DocumentImportLimits { max_input_bytes: 2, ..d }, DocumentImportLimits { max_output_bytes: 4, ..d }, DocumentImportLimits { max_text_code_units: 2, ..d }, DocumentImportLimits { max_depth: 0, ..d }] {
        assert_eq!(convert_additional_document(&input("source.html", bytes, AdditionalDocumentFormat::Html), l).unwrap_err().code, ImportErrorCode::LimitExceeded);
    }
    for name in ["source.html", "source.rtf", "source.odt", ".html"] {
        let converted = convert_additional_document(&input(name, bytes, AdditionalDocumentFormat::Html), d).unwrap();
        assert!(converted.name.ends_with(" converted.txt")); assert_ne!(converted.name, name);
    }
}
