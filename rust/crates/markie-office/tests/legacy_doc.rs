//! Port of legacy-doc.test.ts, legacy-doc-write.test.ts and legacy-doc-worker-client.test.ts.
#[path = "common/cfb_fixture.rs"]
mod cfb_fixture;
use cfb_fixture::*;
use markie_office::cfb::*;
use markie_office::legacy_doc::*;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;

#[derive(Clone)]
struct Piece { text: Vec<u16>, compressed: bool }
fn piece(text: &str, compressed: bool) -> Piece { Piece { text: text.encode_utf16().collect(), compressed } }
fn units(text: &str) -> Vec<u16> { text.encode_utf16().collect() }

#[derive(Default, Clone)]
struct Opts { version: Option<u16>, base_version: Option<u16>, which_table: bool, pieces: Option<Vec<Piece>>, main_chars: Option<u32>, sub_chars: Option<u32>, property: bool }
struct Parts { word: Vec<u8>, table: Vec<u8>, text_offsets: Vec<usize>, cp_at: usize, pcd_at: usize, extension_at: usize, table_name: &'static str }
fn w16(b: &mut [u8], at: usize, v: u16) { b[at..at + 2].copy_from_slice(&v.to_le_bytes()); }
fn w32(b: &mut [u8], at: usize, v: u32) { b[at..at + 4].copy_from_slice(&v.to_le_bytes()); }
fn parts(o: Opts) -> Parts {
    let version = o.version.unwrap_or(0xc1);
    let pairs = match version { 0xc1 => 0x5d, 0xd9 => 0x6c, 0x101 => 0x88, _ => 0xa4 };
    let mut word = vec![0u8; 4096];
    let pieces = o.pieces.clone().unwrap_or_else(|| vec![piece("Hello\r", true)]);
    w16(&mut word, 0, 0xa5ec); w16(&mut word, 2, o.base_version.unwrap_or(version)); w16(&mut word, 10, 0x1000 | if o.which_table { 0x200 } else { 0 }); w16(&mut word, 12, 0xbf);
    w16(&mut word, 32, 14); w16(&mut word, 62, 22); w16(&mut word, 152, pairs);
    let extension_at = 154 + pairs as usize * 8;
    w16(&mut word, extension_at, if version == 0xc1 { 0 } else { 2 });
    if version != 0xc1 { w16(&mut word, extension_at + 2, version); }
    let mut text_at = (extension_at + if version == 0xc1 { 2 } else { 6 } + 64).div_ceil(2) * 2;
    let mut text_offsets = vec![];
    for p in &pieces {
        text_offsets.push(text_at);
        for u in &p.text { if p.compressed { word[text_at] = *u as u8; text_at += 1; } else { w16(&mut word, text_at, *u); text_at += 2; } }
    }
    let total: usize = pieces.iter().map(|p| p.text.len()).sum();
    w32(&mut word, 64, text_at as u32); w32(&mut word, 76, o.main_chars.unwrap_or(total as u32)); w32(&mut word, 80, o.sub_chars.unwrap_or(0));
    let prefix: Vec<u8> = if o.property { vec![1, 2, 0, 0, 0] } else { vec![] };
    let plc_length = 4 + pieces.len() * 12;
    let mut table = vec![0u8; prefix.len() + 5 + plc_length];
    table[..prefix.len()].copy_from_slice(&prefix); table[prefix.len()] = 2; w32(&mut table, prefix.len() + 1, plc_length as u32);
    let cp_at = prefix.len() + 5; let pcd_at = cp_at + (pieces.len() + 1) * 4;
    let mut cp = 0u32;
    for (i, p) in pieces.iter().enumerate() {
        w32(&mut table, cp_at + i * 4, cp); cp += p.text.len() as u32;
        w32(&mut table, pcd_at + i * 8 + 2, if p.compressed { (text_offsets[i] * 2) as u32 + 0x40000000 } else { text_offsets[i] as u32 });
    }
    w32(&mut table, cp_at + pieces.len() * 4, cp);
    let tl = table.len() as u32;
    w32(&mut word, 154 + 33 * 8, 0); w32(&mut word, 154 + 33 * 8 + 4, tl);
    Parts { word, table, text_offsets, cp_at, pcd_at, extension_at, table_name: if o.which_table { "1Table" } else { "0Table" } }
}
fn wrap_v(p: &Parts, version: u16) -> Vec<u8> { make_cfb(&[("WordDocument", p.word.clone()), (p.table_name, p.table.clone())], version, false).bytes }
fn wrap(p: &Parts) -> Vec<u8> { wrap_v(p, 3) }
fn extract(bytes: &[u8]) -> Result<LegacyDocText, CfbError> { extract_legacy_doc_text(bytes, DEFAULT_LEGACY_DOC_LIMITS) }
fn ok(bytes: &[u8]) -> LegacyDocText { extract(bytes).unwrap_or_else(|e| panic!("{}", e.message)) }
fn code(r: Result<LegacyDocText, CfbError>) -> CfbErrorCode { r.err().expect("expected failure").code }
use CfbErrorCode::*;

#[test]
fn reads_the_supported_fib_versions() {
    for version in [0xc1, 0xd9, 0x101, 0x10c] {
        let r = ok(&wrap(&parts(Opts { version: Some(version), ..Default::default() })));
        assert_eq!(r.raw_text, units("Hello\r")); assert_eq!(r.text, "Hello\n");
        assert!(r.warnings.join(" ").contains("Text extraction only"));
    }
}
#[test]
fn uses_nfibnew_when_present() {
    assert_eq!(ok(&wrap(&parts(Opts { version: Some(0x10c), base_version: Some(0xc1), ..Default::default() }))).text, "Hello\n");
}
#[test]
fn selects_1table_using_the_fib_flag_and_reads_v4_cfb() {
    assert_eq!(ok(&wrap_v(&parts(Opts { which_table: true, ..Default::default() }), 4)).text, "Hello\n");
}
#[test]
fn extracts_mixed_pieces_in_cp_rather_than_physical_order() {
    let mut p = parts(Opts { pieces: Some(vec![piece("one ", true), piece("世界 😀\r", false)]), ..Default::default() });
    let first = p.word[p.text_offsets[0]..p.text_offsets[0] + 4].to_vec();
    p.word[3000..3004].copy_from_slice(&first); let at = p.pcd_at + 2; w32(&mut p.table, at, 3000 * 2 + 0x40000000); w32(&mut p.word, 64, 3004);
    assert_eq!(ok(&wrap(&p)).raw_text, units("one 世界 😀\r"));
}
#[test]
fn applies_the_spec_compressed_mapping_not_windows_1252() {
    let p = parts(Opts { pieces: Some(vec![Piece { text: vec![0x80, 0x82, 0x8e, 0x91, 0x9f, 13], compressed: true }]), ..Default::default() });
    assert_eq!(ok(&wrap(&p)).raw_text, units("\u{80}\u{201a}\u{8e}\u{2018}\u{178}\r"));
}
#[test]
fn retains_boms_lone_surrogates_and_control_characters() {
    let mut text = vec![0xfeff, 0xd800, 0x13]; text.extend(units("FIELD")); text.push(0x14); text.extend(units("value")); text.extend([0x15, 0x0b, 13]);
    let r = ok(&wrap(&parts(Opts { pieces: Some(vec![Piece { text: text.clone(), compressed: false }]), ..Default::default() })));
    assert_eq!(r.raw_text, text);
    // The lone surrogate is U+FFFD in `text`; rawText keeps the exact code units.
    assert_eq!(r.text, String::from_utf16_lossy(&text).replace('\r', "\n"));
}
#[test]
fn skips_bounded_clx_property_records() {
    assert_eq!(ok(&wrap(&parts(Opts { property: true, ..Default::default() }))).text, "Hello\n");
}
#[test]
fn stops_at_ccptext() {
    let p = parts(Opts { pieces: Some(vec![piece("Main\rFootnote!", true)]), main_chars: Some(5), sub_chars: Some(8), ..Default::default() });
    assert_eq!(ok(&wrap(&p)).raw_text, units("Main\r"));
}
#[test]
fn handles_an_empty_main_story_without_pieces() {
    assert!(ok(&wrap(&parts(Opts { pieces: Some(vec![]), ..Default::default() }))).raw_text.is_empty());
}
#[test]
fn returns_unsupported_for_word6_later_fibs_and_non_doc_compound_files() {
    let mut p = parts(Opts::default()); w16(&mut p.word, 2, 0x65); assert_eq!(code(extract(&wrap(&p))), Unsupported);
    let mut q = parts(Opts { version: Some(0x10c), ..Default::default() }); let at = q.extension_at + 2; w16(&mut q.word, at, 0x112); assert_eq!(code(extract(&wrap(&q))), Unsupported);
    assert_eq!(code(extract(&make_cfb(&[], 3, false).bytes)), Unsupported);
}
#[test]
fn refuses_encrypted_and_xor_obfuscated_doc() {
    for flags in [0x100, 0x8100] { let mut p = parts(Opts::default()); w16(&mut p.word, 10, flags); assert_eq!(code(extract(&wrap(&p))), Encrypted); }
    assert_eq!(code(extract(&make_cfb(&[("EncryptedPackage", vec![])], 3, false).bytes)), Encrypted);
}
#[test]
fn rejects_a_missing_selected_table_and_invalid_fib_counts() {
    let mut p = parts(Opts::default()); w16(&mut p.word, 10, 0x200); assert_eq!(code(extract(&wrap(&p))), Malformed);
    let mut q = parts(Opts::default()); w16(&mut q.word, 32, 0xffff); assert_eq!(code(extract(&wrap(&q))), Malformed);
    let mut r = parts(Opts::default()); w16(&mut r.word, 152, 92); assert_eq!(code(extract(&wrap(&r))), Malformed);
}
#[test]
fn rejects_negative_counts_and_bad_cbmac() {
    let mut p = parts(Opts::default()); w32(&mut p.word, 76, u32::MAX); assert_eq!(code(extract(&wrap(&p))), Malformed);
    let mut q = parts(Opts::default()); w32(&mut q.word, 64, 5000); assert_eq!(code(extract(&wrap(&q))), Malformed);
    let mut r = parts(Opts::default()); w32(&mut r.word, 64, 100); assert_eq!(code(extract(&wrap(&r))), Malformed);
}
#[test]
fn rejects_out_of_range_or_absent_clx_and_truncated_prc_pcdt() {
    let mut p = parts(Opts::default()); w32(&mut p.word, 154 + 33 * 8, 5000); assert_eq!(code(extract(&wrap(&p))), Malformed);
    let mut q = parts(Opts::default()); w32(&mut q.word, 154 + 33 * 8 + 4, 0); assert_eq!(code(extract(&wrap(&q))), Unsupported);
    let mut r = parts(Opts { property: true, ..Default::default() }); w16(&mut r.table, 1, 0xffff); assert_eq!(code(extract(&wrap(&r))), Malformed);
    let mut s = parts(Opts::default()); w32(&mut s.table, 1, 0xffffffff); assert_eq!(code(extract(&wrap(&s))), Malformed);
}
#[test]
fn rejects_unsorted_duplicate_nonzero_first_negative_and_uncovered_cps() {
    for value in [1u32, u32::MAX, 6] { let mut p = parts(Opts::default()); let at = p.cp_at; w32(&mut p.table, at, value); assert_eq!(code(extract(&wrap(&p))), Malformed); }
    let mut p = parts(Opts::default()); let at = p.cp_at + 4; w32(&mut p.table, at, 0); assert_eq!(code(extract(&wrap(&p))), Malformed);
    let mut q = parts(Opts::default()); let at = q.cp_at + 4; w32(&mut q.table, at, 7); assert_eq!(code(extract(&wrap(&q))), Malformed);
}
#[test]
fn rejects_text_before_the_fib_beyond_cbmac_and_fractional_compressed_fc() {
    for fc in [2u32, 4000, 0x40000001] { let mut p = parts(Opts::default()); let at = p.pcd_at + 2; w32(&mut p.table, at, fc); assert_eq!(code(extract(&wrap(&p))), Malformed); }
}
#[test]
fn checks_subdocument_pieces_too() {
    let mut p = parts(Opts { pieces: Some(vec![piece("Main\r", true), piece("Footnote!", false)]), main_chars: Some(5), sub_chars: Some(8), ..Default::default() });
    let at = p.pcd_at + 8 + 2; w32(&mut p.table, at, 4000); assert_eq!(code(extract(&wrap(&p))), Malformed);
}
#[test]
fn enforces_text_piece_clx_property_container_and_invalid_limit_budgets() {
    let input = wrap(&parts(Opts { property: true, ..Default::default() }));
    let d = DEFAULT_LEGACY_DOC_LIMITS;
    // Infinity is not representable; an over-safe usize stands in for it.
    for limits in [LegacyDocLimits { max_text_code_units: 2, ..d }, LegacyDocLimits { max_pieces: 0, ..d }, LegacyDocLimits { max_clx_bytes: 2, ..d },
        LegacyDocLimits { max_property_records: 0, ..d }, LegacyDocLimits { cfb: CfbLimits { max_input_bytes: 100, ..d.cfb }, ..d }, LegacyDocLimits { max_pieces: usize::MAX, ..d }] {
        assert_eq!(code(extract_legacy_doc_text(&input, limits)), LimitExceeded);
    }
}
#[test]
fn returns_typed_failures_instead_of_panicking_on_deterministic_corruptions() {
    let input = wrap(&parts(Opts { pieces: Some(vec![piece("Untrusted 世界\r", false)]), ..Default::default() }));
    let mut state: u32 = 13;
    let limits = LegacyDocLimits { cfb: CfbLimits { max_chain_sectors: 1000, ..DEFAULT_CFB_LIMITS }, ..DEFAULT_LEGACY_DOC_LIMITS };
    for _ in 0..200 {
        let mut changed = input.clone(); state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let at = state as usize % changed.len(); changed[at] ^= ((state >> 16) & 255) as u8;
        let _ = extract_legacy_doc_text(&changed, limits); // must not panic
    }
}

// ---- legacy-doc-write.test.ts ----
fn fixture(result: &LegacyDocPlainStoryFoundation) -> Vec<u8> { write_compound_file(&result.streams, DEFAULT_CFB_LIMITS).unwrap() }
fn serialize(text: &str) -> Result<LegacyDocPlainStoryFoundation, CfbError> { serialize_legacy_doc_plain_story_streams(text, Default::default()) }
fn r16(b: &[u8], at: usize) -> u16 { u16::from_le_bytes([b[at], b[at + 1]]) }
fn r32(b: &[u8], at: usize) -> u32 { u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) }
#[test]
fn roundtrips_with_explicit_paragraph_normalization() {
    for (input, expected, paragraphs, appended) in [("", "\r", 1, true), ("Hello", "Hello\r", 1, true), ("Hello\r", "Hello\r", 1, false),
        ("One\r\nTwo\nThree\r", "One\rTwo\rThree\r", 3, false), ("\n\n", "\r\r", 2, false),
        ("世界 😀 e\u{301}\tA\u{b}B\u{feff}", "世界 😀 e\u{301}\tA\u{b}B\u{feff}\r", 1, true)] {
        let result = serialize(input).unwrap();
        assert_eq!(ok(&fixture(&result)).raw_text, units(expected));
        assert_eq!(result.character_count, units(expected).len()); assert_eq!(result.paragraph_count, paragraphs); assert_eq!(result.appended_terminal_paragraph, appended);
        assert_eq!(result.missing_structures, ["stylesheet", "character-property-index", "paragraph-property-index"]);
        assert!(result.warnings.join(" ").contains("not a conforming DOC exporter"));
    }
}
#[test]
fn writes_counted_fib_fields_and_exact_one_piece_extents() {
    let input = "A😀\rB\r"; let n = units(input).len();
    let result = serialize(input).unwrap();
    let mut cfb = read_compound_file(&fixture(&result), DEFAULT_CFB_LIMITS).unwrap();
    let word = cfb.read_root_stream("WordDocument").unwrap(); let table = cfb.read_root_stream("0Table").unwrap();
    assert_eq!(word.len(), 1024 + n * 2); assert_eq!(table.len(), 21);
    assert_eq!(r16(&word, 0), 0xa5ec); assert_eq!(r16(&word, 2), 0xc1); assert_eq!(r16(&word, 10), 0x1000); assert_eq!(r16(&word, 12), 0xbf);
    assert_eq!(r32(&word, 14), 0); assert_eq!(r16(&word, 32), 14); assert_eq!(r16(&word, 62), 22); assert_eq!(r16(&word, 152), 93); assert_eq!(r16(&word, 898), 0);
    assert_eq!(r32(&word, 64) as usize, 1024 + n * 2); assert_eq!(r32(&word, 76) as usize, n);
    for index in [4, 5, 6, 7, 8, 9, 10] { assert_eq!(r32(&word, 64 + index * 4), 0); }
    for (i, u) in units(input).iter().enumerate() { assert_eq!(r16(&word, 1024 + i * 2), *u); }
    assert_eq!(table[0], 2); assert_eq!(r32(&table, 1), 16); assert_eq!(r32(&table, 5), 0); assert_eq!(r32(&table, 9) as usize, n);
    assert_eq!(r16(&table, 13), 0); assert_eq!(r32(&table, 15), 1024); assert_eq!(r16(&table, 19), 0);
    assert_eq!(r32(&word, 154 + 33 * 8), 0); assert_eq!(r32(&word, 154 + 33 * 8 + 4), 21);
    assert!(word[900..1024].iter().all(|b| *b == 0));
    for index in [1, 12, 13] { assert_eq!(r32(&word, 154 + index * 8 + 4), 0); }
}
#[test]
fn roundtrips_across_physical_stream_and_chunk_boundaries() {
    for length in [1535usize, 1536, 1537, 70000] {
        let input = "x".repeat(length - 1) + "\r";
        let result = serialize(&input).unwrap();
        assert_eq!(ok(&fixture(&result)).raw_text, units(&input));
        let mut cfb = read_compound_file(&fixture(&result), DEFAULT_CFB_LIMITS).unwrap();
        assert_eq!(r32(&cfb.read_root_stream("WordDocument").unwrap(), 64) as usize, 1024 + length * 2);
    }
}
#[test]
fn refuses_unsupported_control_and_object_content() {
    for input in ["\0", "\u{1}", "\u{7}", "\u{8}", "\u{c}", "\u{13}FIELD\u{14}x\u{15}", "\u{1f}", "\u{7f}", "\u{85}", "\u{fffc}"] {
        assert_eq!(serialize(input).unwrap_err().code, Unsupported, "{input:?}");
    }
}
#[test]
fn enforces_the_final_paragraph_input_clx_piece_and_stream_budgets() {
    let d = LegacyDocPlainStoryLimits::default();
    for limits in [LegacyDocPlainStoryLimits { max_text_code_units: 0, ..d }, LegacyDocPlainStoryLimits { max_pieces: 0, ..d }, LegacyDocPlainStoryLimits { max_clx_bytes: 20, ..d },
        LegacyDocPlainStoryLimits { max_stream_bytes: 1025, ..d }, LegacyDocPlainStoryLimits { max_total_stream_bytes: 1046, ..d }] {
        assert_eq!(serialize_legacy_doc_plain_story_streams("", limits).unwrap_err().code, LimitExceeded);
    }
    assert!(serialize_legacy_doc_plain_story_streams("a", LegacyDocPlainStoryLimits { max_text_code_units: 1, ..d }).is_err());
    assert!(serialize_legacy_doc_plain_story_streams("a\r", LegacyDocPlainStoryLimits { max_text_code_units: 2, ..d }).is_ok());
    assert!(serialize_legacy_doc_plain_story_streams("a\r", LegacyDocPlainStoryLimits { max_text_code_units: 1, ..d }).is_err());
    assert!(serialize_legacy_doc_plain_story_streams("", LegacyDocPlainStoryLimits { max_total_stream_bytes: 1047, ..d }).is_ok());
}
#[test]
fn is_deterministic_and_returns_independent_buffers() {
    let mut first = serialize("Same text").unwrap(); let second = serialize("Same text").unwrap();
    assert_eq!(first.streams, second.streams); first.streams[0].data.fill(0);
    assert_eq!(ok(&fixture(&second)).raw_text, units("Same text\r"));
}

// ---- legacy-doc-worker-client.test.ts ----
fn sample() -> LegacyDocText { LegacyDocText { text: "Synthetic text".into(), raw_text: units("Synthetic text"), warnings: vec![] } }
#[test]
fn hands_an_owned_copy_to_the_reader_and_returns_a_valid_result() {
    let source = vec![1u8, 2, 3];
    let result = run_legacy_doc_reader_off_thread(&source, DocImportOptions::default(), |owned| { assert_eq!(owned, vec![1, 2, 3]); Ok(sample()) });
    assert_eq!(result.unwrap(), sample()); assert_eq!(source, vec![1, 2, 3]);
}
#[test]
fn preserves_typed_unsupported_and_encrypted_outcomes() {
    let result = run_legacy_doc_reader_off_thread(&[], DocImportOptions::default(), |_| Err(CfbError { code: Encrypted, message: "Encrypted DOC is not supported.".into() }));
    assert_eq!(result.unwrap_err(), LegacyDocImportError::Doc(CfbError { code: Encrypted, message: "Encrypted DOC is not supported.".into() }));
}
#[test]
fn stops_waiting_for_a_hung_import_on_its_time_budget() {
    let options = DocImportOptions { timeout: Duration::from_millis(20), cancel: None };
    let err = run_legacy_doc_reader_off_thread(&[], options, |_| { std::thread::sleep(Duration::from_millis(300)); Ok(sample()) }).unwrap_err();
    assert!(err.to_string().contains("time budget"));
}
#[test]
fn cancels_without_touching_the_source() {
    let cancel = Arc::new(AtomicBool::new(false)); let source = vec![7u8];
    let flag = cancel.clone();
    std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(20)); flag.store(true, Ordering::SeqCst); });
    let err = run_legacy_doc_reader_off_thread(&source, DocImportOptions { timeout: Duration::from_millis(5000), cancel: Some(cancel) }, |_| { std::thread::sleep(Duration::from_millis(500)); Ok(sample()) }).unwrap_err();
    assert_eq!(err, LegacyDocImportError::Canceled); assert_eq!(source[0], 7);
}
#[test]
fn never_starts_a_reader_for_canceled_excessive_or_invalid_input() {
    let started = Arc::new(AtomicBool::new(false));
    let canceled = Arc::new(AtomicBool::new(true));
    let s = started.clone();
    assert_eq!(run_legacy_doc_reader_off_thread(&[], DocImportOptions { cancel: Some(canceled), ..Default::default() }, move |_| { s.store(true, Ordering::SeqCst); Ok(sample()) }).unwrap_err(), LegacyDocImportError::Canceled);
    let s = started.clone();
    assert!(run_legacy_doc_reader_off_thread(&vec![0; 32 * 1024 * 1024 + 1], DocImportOptions::default(), move |_| { s.store(true, Ordering::SeqCst); Ok(sample()) }).unwrap_err().to_string().contains("32 MiB"));
    let s = started.clone();
    assert!(run_legacy_doc_reader_off_thread(&[], DocImportOptions { timeout: Duration::ZERO, cancel: None }, move |_| { s.store(true, Ordering::SeqCst); Ok(sample()) }).unwrap_err().to_string().contains("time limit"));
    assert!(!started.load(Ordering::SeqCst));
}
#[test]
fn rejects_malformed_responses_and_reader_failures_without_leaking_content() {
    let oversized = LegacyDocText { text: "x".repeat(8 * 1024 * 1024 + 1), raw_text: vec![], warnings: vec![] };
    assert!(run_legacy_doc_reader_off_thread(&[], DocImportOptions::default(), move |_| Ok(oversized)).unwrap_err().to_string().contains("invalid result"));
    let err = run_legacy_doc_reader_off_thread(&[], DocImportOptions::default(), |_| panic!("private synthetic payload")).unwrap_err();
    assert!(err.to_string().contains("local DOC reader failed")); assert!(!err.to_string().contains("private"));
}
#[test]
fn extracts_a_real_synthetic_doc_off_thread() {
    let bytes = wrap(&parts(Opts::default()));
    assert_eq!(extract_legacy_doc_text_off_thread(&bytes, DocImportOptions::default()).unwrap().text, "Hello\n");
}
