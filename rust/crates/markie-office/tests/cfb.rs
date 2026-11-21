//! Port of src/lib/office/cfb.test.ts and cfb-write.test.ts.
mod common;
#[path = "common/cfb_fixture.rs"]
mod cfb_fixture;
use cfb_fixture::*;
use markie_office::cfb::*;

fn read(bytes: &[u8]) -> Result<CompoundFile, CfbError> { read_compound_file(bytes, DEFAULT_CFB_LIMITS) }
fn file(bytes: &[u8]) -> CompoundFile { read(bytes).unwrap_or_else(|e| panic!("{}", e.message)) }
fn code<T>(r: Result<T, CfbError>) -> CfbErrorCode { match r { Ok(_) => panic!("expected failure"), Err(e) => e.code } }
use CfbErrorCode::*;

#[test]
fn reads_version_3_and_4_fat_and_minifat_streams_with_exact_lengths() {
    for version in [3, 4] {
        let large: Vec<u8> = (0..5003).map(|i| (i % 251) as u8).collect();
        let small: Vec<u8> = (0..137).map(|i| (255 - i) as u8).collect();
        let f = make_cfb(&[("WordDocument", large.clone()), ("1Table", small.clone()), ("Empty", vec![])], version, false);
        let mut parsed = file(&f.bytes);
        assert_eq!(parsed.major_version, version);
        assert_eq!(parsed.root_stream_names().len(), 3);
        assert_eq!(parsed.read_root_stream("worddocument").unwrap(), large);
        assert_eq!(parsed.read_root_stream("1TABLE").unwrap(), small);
        assert_eq!(parsed.read_root_stream("Empty").unwrap().len(), 0);
    }
}
#[test]
fn follows_an_external_difat_sector() {
    let f = make_cfb(&[("Data", vec![42; 4096])], 3, true);
    assert_eq!(file(&f.bytes).read_root_stream("Data").unwrap()[4095], 42);
}
#[test]
fn handles_noncontiguous_normal_sector_chains() {
    let mut f = make_cfb(&[("Data", vec![1; 4096])], 3, false);
    let ids = f.stream_sectors[0].clone();
    let (a, b) = (f.sector_offset(ids[0]), f.sector_offset(ids[1]));
    let first = f.bytes[a..a + 512].to_vec();
    f.bytes.copy_within(b..b + 512, a);
    f.bytes[b..b + 512].copy_from_slice(&first);
    let at = f.entry_offsets[1] + 116; f.w32(at, ids[1] as u32);
    f.set_fat(ids[1], ids[0] as u32); f.set_fat(ids[0], ids[2] as u32);
    assert_eq!(file(&f.bytes).read_root_stream("Data").unwrap(), vec![1; 4096]);
}
#[test]
fn takes_a_snapshot_and_returns_independent_stream_copies() {
    let mut f = make_cfb(&[("Data", vec![23; 4096])], 3, false);
    let mut parsed = file(&f.bytes); f.bytes.fill(0);
    let mut first = parsed.read_root_stream("Data").unwrap(); assert_eq!(first[0], 23); first.fill(0);
    assert_eq!(parsed.read_root_stream("Data").unwrap()[0], 23);
}
#[test]
fn copies_buffer_inputs_instead_of_retaining_aliases() {
    // Rust borrows cannot alias a later mutation; this mirrors the Node Buffer case.
    let mut source = make_cfb(&[("Data", vec![23; 4096])], 3, false).bytes;
    let mut parsed = file(&source); source.fill(0);
    assert_eq!(parsed.read_root_stream("Data").unwrap()[0], 23);
}
#[test]
fn looks_only_in_the_root_storage_and_rejects_unsupported_name_matching() {
    let f = make_cfb(&[("Data", vec![])], 3, false);
    let mut parsed = file(&f.bytes);
    assert_eq!(code(parsed.read_root_stream("missing")), Unsupported);
    assert_eq!(code(parsed.read_root_stream("é")), Unsupported);
}
#[test]
fn does_not_expose_a_nested_storage_word_document_stream_at_the_root() {
    let mut f = make_cfb(&[("Storage", vec![]), ("WordDocument", vec![0; 4096])], 3, false);
    let (storage, nested) = (f.entry_offsets[1], f.entry_offsets[2]);
    let root = f.entry_offsets[0] + 76; f.w32(root, 1); f.bytes[storage + 66] = 1;
    f.w32(storage + 68, CFB_FREE); f.w32(storage + 72, CFB_FREE); f.w32(storage + 76, 2); f.w32(storage + 116, 0);
    f.w32(nested + 68, CFB_FREE); f.w32(nested + 72, CFB_FREE);
    let mut parsed = file(&f.bytes);
    assert!(parsed.root_stream_names().is_empty());
    assert_eq!(code(parsed.read_root_stream("WordDocument")), Unsupported);
}
#[test]
fn reads_directory_and_minifat_chains_spanning_multiple_sectors() {
    let streams: Vec<(String, Vec<u8>)> = (0..6).map(|i| (format!("Data{i}"), vec![(i + 1) as u8; 3000])).collect();
    let refs: Vec<(&str, Vec<u8>)> = streams.iter().map(|(n, d)| (n.as_str(), d.clone())).collect();
    let f = make_cfb(&refs, 3, false);
    assert!(f.directory_ids.len() > 1); assert!(f.mini_fat_ids.len() > 1);
    let mut parsed = file(&f.bytes);
    for (name, data) in &streams { assert_eq!(&parsed.read_root_stream(name).unwrap(), data); }
}
#[test]
fn rejects_truncated_headers_signatures_sectors_and_illegal_geometry() {
    assert_eq!(code(read(&[0; 30])), Malformed);
    let mut f = make_cfb(&[], 3, false);
    assert_eq!(code(read(&f.bytes[..f.bytes.len() - 1])), Malformed);
    f.w16(30, 15); assert_eq!(code(read(&f.bytes)), Malformed);
}
#[test]
fn rejects_unsupported_versions() {
    let mut f = make_cfb(&[], 3, false); f.w16(26, 2); assert_eq!(code(read(&f.bytes)), Unsupported);
}
#[test]
fn rejects_duplicate_fat_ids_and_fat_sectors_with_wrong_markers() {
    let mut f = make_cfb(&[], 3, false); f.w32(80, 0); assert_eq!(code(read(&f.bytes)), Malformed);
    let mut g = make_cfb(&[], 3, false); g.set_fat(0, CFB_END); assert_eq!(code(read(&g.bytes)), Malformed);
}
#[test]
fn rejects_difat_cycles_out_of_file_ids_and_count_mismatches() {
    let mut f = make_cfb(&[], 3, true); f.w32(72, 2); let at = f.sector_offset(f.difat_ids[0]) + 508; let v = f.difat_ids[0] as u32; f.w32(at, v); assert_eq!(code(read(&f.bytes)), Malformed);
    let mut g = make_cfb(&[], 3, false); g.w32(76, 3000); assert_eq!(code(read(&g.bytes)), Malformed);
    let mut h = make_cfb(&[], 3, true); let at = h.sector_offset(h.difat_ids[0]); h.w32(at, CFB_FREE); assert_eq!(code(read(&h.bytes)), Malformed);
}
#[test]
fn rejects_cyclic_directory_chains_cyclic_siblings_and_unterminated_names() {
    let mut f = make_cfb(&[], 3, false); let d = f.directory_ids[0]; f.set_fat(d, d as u32); assert_eq!(code(read(&f.bytes)), Malformed);
    let mut g = make_cfb(&[("Data", vec![])], 3, false); let at = g.entry_offsets[1] + 72; g.w32(at, 1); assert_eq!(code(read(&g.bytes)), Malformed);
    let mut h = make_cfb(&[("Data", vec![])], 3, false); let at = h.entry_offsets[1] + 8; h.w16(at, 65); assert_eq!(code(read(&h.bytes)), Malformed);
}
#[test]
fn rejects_duplicate_sibling_names_shared_by_a_storage_and_stream() {
    let mut f = make_cfb(&[("Data", vec![0; 4096]), ("data", vec![])], 3, false);
    let e = f.entry_offsets[2]; f.bytes[e + 66] = 1; f.w32(e + 116, 0);
    assert_eq!(code(read(&f.bytes)), Malformed);
}
#[test]
fn rejects_duplicate_nested_sibling_names_without_merging_separate_parents() {
    let mut f = make_cfb(&[("Storage", vec![]), ("Data", vec![]), ("data", vec![])], 3, false);
    let (s, e2, e3) = (f.entry_offsets[1], f.entry_offsets[2], f.entry_offsets[3]);
    f.bytes[s + 66] = 1; let r = f.entry_offsets[0] + 76; f.w32(r, 1);
    f.w32(s + 68, CFB_FREE); f.w32(s + 72, CFB_FREE); f.w32(s + 76, 2); f.w32(s + 116, 0);
    f.w32(e2 + 68, CFB_FREE); f.w32(e2 + 72, 3); f.w32(e3 + 68, CFB_FREE); f.w32(e3 + 72, CFB_FREE);
    assert_eq!(code(read(&f.bytes)), Malformed);
}
#[test]
fn rejects_normal_stream_cycles_truncation_and_metadata_overlap_on_read() {
    let mut f = make_cfb(&[("Data", vec![0; 4096])], 3, false); let s = f.stream_sectors[0][0]; f.set_fat(s, s as u32);
    assert_eq!(code(file(&f.bytes).read_root_stream("Data")), Malformed);
    let mut g = make_cfb(&[("Data", vec![0; 4096])], 3, false); let s = g.stream_sectors[0][0]; g.set_fat(s, CFB_END);
    assert_eq!(code(file(&g.bytes).read_root_stream("Data")), Malformed);
    let mut h = make_cfb(&[("Data", vec![0; 4096])], 3, false); let at = h.entry_offsets[1] + 116; let d = h.directory_ids[0] as u32; h.w32(at, d);
    assert_eq!(code(file(&h.bytes).read_root_stream("Data")), Malformed);
}
#[test]
fn rejects_minifat_cycles_truncation_and_out_of_mini_stream_references() {
    for value in [0, CFB_END, 50] {
        let mut f = make_cfb(&[("Data", vec![0; 130])], 3, false); f.set_mini_fat(0, value);
        assert_eq!(code(file(&f.bytes).read_root_stream("Data")), Malformed);
    }
}
#[test]
fn rejects_stream_cross_links_when_both_streams_are_accessed() {
    let mut f = make_cfb(&[("One", vec![0; 4096]), ("Two", vec![0; 4096])], 3, false);
    let at = f.entry_offsets[2] + 116; let s = f.stream_sectors[0][0] as u32; f.w32(at, s);
    let mut parsed = file(&f.bytes); assert!(parsed.read_root_stream("One").is_ok()); assert_eq!(code(parsed.read_root_stream("Two")), Malformed);
}
#[test]
fn rejects_mini_stream_cross_links_when_both_streams_are_accessed() {
    let mut f = make_cfb(&[("One", vec![0; 130]), ("Two", vec![0; 130])], 3, false);
    let at = f.entry_offsets[2] + 116; f.w32(at, 0);
    let mut parsed = file(&f.bytes); assert!(parsed.read_root_stream("One").is_ok()); assert_eq!(code(parsed.read_root_stream("Two")), Malformed);
}
#[test]
fn rejects_v4_unsafe_64_bit_stream_sizes_without_allocating() {
    let mut f = make_cfb(&[("Data", vec![0; 4096])], 4, false); let at = f.entry_offsets[1] + 124; f.w32(at, 0x200000);
    assert_eq!(code(read(&f.bytes)), LimitExceeded);
}
#[test]
fn ignores_the_historically_uninitialized_v3_high_size_dword() {
    let mut f = make_cfb(&[("Data", vec![0; 4096])], 3, false); let at = f.entry_offsets[1] + 124; f.w32(at, 0x98765432);
    assert_eq!(file(&f.bytes).read_root_stream("Data").unwrap().len(), 4096);
}
#[test]
fn enforces_input_sector_chain_directory_stream_and_cumulative_budgets() {
    let f = make_cfb(&[("Data", vec![0; 4096])], 3, false);
    let d = DEFAULT_CFB_LIMITS;
    // TypeScript also passes NaN; Rust limits are integers, so an over-safe value stands in.
    for limits in [CfbLimits { max_input_bytes: 100, ..d }, CfbLimits { max_sectors: 1, ..d }, CfbLimits { max_chain_sectors: 0, ..d },
        CfbLimits { max_directory_entries: 0, ..d }, CfbLimits { max_input_bytes: usize::MAX, ..d }] {
        assert_eq!(code(read_compound_file(&f.bytes, limits)), LimitExceeded);
    }
    assert_eq!(code(read_compound_file(&f.bytes, CfbLimits { max_stream_bytes: 4000, ..d }).unwrap().read_root_stream("Data")), LimitExceeded);
    let mut parsed = read_compound_file(&f.bytes, CfbLimits { max_total_stream_bytes: 4096, ..d }).unwrap();
    assert!(parsed.read_root_stream("Data").is_ok()); assert_eq!(code(parsed.read_root_stream("Data")), LimitExceeded);
    assert_eq!(code(read_compound_file(&f.bytes, CfbLimits { max_chain_sectors: 4, ..d }).unwrap().read_root_stream("Data")), LimitExceeded);
}

// ---- cfb-write.test.ts ----
fn s(name: &str, data: Vec<u8>) -> CfbWriteStream { CfbWriteStream { name: name.into(), data } }
fn payload(length: usize) -> Vec<u8> { (0..length).map(|i| ((i * 31 + 17) % 256) as u8).collect() }
fn r32(b: &[u8], at: usize) -> u32 { u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) }
fn round_trip(streams: &[CfbWriteStream]) -> Vec<u8> {
    let output = write_compound_file(streams, DEFAULT_CFB_LIMITS).unwrap();
    let mut parsed = read(&output).unwrap();
    assert_eq!(parsed.major_version, 3);
    let mut names: Vec<String> = parsed.root_stream_names().to_vec(); names.sort();
    let mut expected: Vec<String> = streams.iter().map(|s| s.name.clone()).collect(); expected.sort();
    assert_eq!(names, expected);
    for stream in streams { assert_eq!(parsed.read_root_stream(&stream.name.to_lowercase()).unwrap(), stream.data); }
    output
}
#[test]
fn writes_the_minimal_empty_container() {
    let output = round_trip(&[]);
    assert_eq!(output.len(), 1536);
    assert_eq!(&output[..8], &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert_eq!(r32(&output, 40), 0); assert_eq!(r32(&output, 44), 1);
    for at in [60, 68] { assert_eq!(r32(&output, at), 0xfffffffe); }
    for at in [64, 72] { assert_eq!(r32(&output, at), 0); }
    assert!(output[8..24].iter().all(|v| *v == 0));
}
#[test]
fn preserves_all_payload_bytes_across_allocation_boundaries() {
    for length in [0, 1, 63, 64, 65, 511, 512, 513, 4095, 4096, 4097, 5003] {
        let output = round_trip(&[s("WordDocument", payload(length))]);
        let directory = (r32(&output, 48) as usize + 1) * 512;
        assert_eq!(r32(&output, directory + 128 + 120) as usize, length);
        assert_eq!(r32(&output, 64) > 0, length > 0 && length < 4096);
        if length == 0 { assert_eq!(r32(&output, directory + 128 + 116), 0xfffffffe); }
    }
}
#[test]
fn mixes_empty_mini_and_normal_streams() {
    let streams: Vec<CfbWriteStream> = (0..17).map(|i| s(&format!("Stream{i}"), payload(if i == 0 { 0 } else if i % 2 == 1 { 3001 } else { 5003 }))).collect();
    round_trip(&streams);
}
#[test]
fn writes_exact_subviews_without_surrounding_bytes() {
    let mut source = vec![251u8, 1, 2, 3, 252];
    let output = write_compound_file(&[s("Data", source[1..4].to_vec())], DEFAULT_CFB_LIMITS).unwrap();
    let original = output.clone(); source.fill(0);
    assert_eq!(output, original);
    assert_eq!(read(&output).unwrap().read_root_stream("Data").unwrap(), vec![1, 2, 3]);
}
#[test]
fn canonicalizes_stream_order_and_preserves_property_stream_prefixes() {
    let first = s("z", payload(2)); let second = s("\u{5}SummaryInformation", payload(5000));
    assert_eq!(write_compound_file(&[first.clone(), second.clone()], DEFAULT_CFB_LIMITS).unwrap(), write_compound_file(&[second.clone(), first.clone()], DEFAULT_CFB_LIMITS).unwrap());
    round_trip(&[first, second]);
    round_trip(&[s(&"X".repeat(31), payload(1))]);
}
#[test]
fn rejects_illegal_names() {
    for name in ["", &"X".repeat(32), "a/b", "a\\b", "a:b", "a!b", "a\0b"] {
        assert_eq!(code(write_compound_file(&[s(name, payload(0))], DEFAULT_CFB_LIMITS)), Malformed, "{name:?}");
    }
}
#[test]
fn rejects_case_insensitive_duplicates() {
    assert_eq!(code(write_compound_file(&[s("Data", payload(1)), s("dATA", payload(2))], DEFAULT_CFB_LIMITS)), Malformed);
}
#[test]
fn explicitly_rejects_unsupported_unicode_names() {
    for name in ["é", "ß", "😀", "\u{80}"] {
        assert_eq!(code(write_compound_file(&[s(name, payload(0))], DEFAULT_CFB_LIMITS)), Unsupported);
    }
}
#[test]
fn rejects_invalid_limits_before_writing() {
    // NaN, Infinity, -1 and 0.5 cannot be expressed as usize; only the over-safe value applies.
    assert_eq!(code(write_compound_file(&[], CfbLimits { max_input_bytes: (1usize << 53) + 1, ..DEFAULT_CFB_LIMITS })), LimitExceeded);
}
#[test]
fn enforces_padded_directory_output_sector_stream_chain_and_cumulative_limits() {
    let streams = [s("Data", payload(4096))];
    let d = DEFAULT_CFB_LIMITS;
    for limits in [CfbLimits { max_input_bytes: 100, ..d }, CfbLimits { max_sectors: 1, ..d }, CfbLimits { max_directory_entries: 3, ..d },
        CfbLimits { max_stream_bytes: 4095, ..d }, CfbLimits { max_chain_sectors: 7, ..d }, CfbLimits { max_total_stream_bytes: 4095, ..d }] {
        assert_eq!(code(write_compound_file(&streams, limits)), LimitExceeded);
    }
    assert_eq!(code(write_compound_file(&[s("Tiny", payload(1))], CfbLimits { max_total_stream_bytes: 64, ..d })), LimitExceeded);
    assert_eq!(code(write_compound_file(&[s("Tiny", payload(1))], CfbLimits { max_stream_bytes: 63, ..d })), LimitExceeded);
    let output = write_compound_file(&streams, d).unwrap();
    assert!(write_compound_file(&streams, CfbLimits { max_input_bytes: output.len(), ..d }).is_ok());
    assert!(write_compound_file(&streams, CfbLimits { max_input_bytes: output.len() - 1, ..d }).is_err());
    assert!(write_compound_file(&[], CfbLimits { max_chain_sectors: 0, ..d }).is_err());
}
#[test]
fn writes_large_files_with_correctly_chained_external_difat_sectors() {
    for size in [8usize, 16] {
        let output = round_trip(&[s("Data", payload(size * 1024 * 1024))]);
        let (fat_count, difat_count) = (r32(&output, 44), r32(&output, 72));
        assert!(fat_count > 109);
        assert_eq!(difat_count, if size == 8 { 1 } else { 2 });
        let mut id = r32(&output, 68);
        for i in 0..difat_count {
            let at = (id as usize + 1) * 512;
            assert_eq!(r32(&output, at), 109 + i * 127);
            id = r32(&output, at + 508);
        }
        assert_eq!(id, 0xfffffffe);
    }
}
#[test]
fn zeroes_stream_sector_padding_and_unused_fat_entries() {
    let output = round_trip(&[s("Small", payload(65)), s("Large", payload(4097))]);
    let directory = (r32(&output, 48) as usize + 1) * 512;
    for i in 1..=2 {
        let at = directory + i * 128; let size = r32(&output, at + 120) as usize; let start = r32(&output, at + 116) as usize;
        let small = size < 4096;
        let base = if small { (r32(&output, directory + 116) as usize + 1) * 512 + start * 64 } else { (start + 1) * 512 };
        let unit = if small { 64 } else { 512 };
        let padded = size.div_ceil(unit) * unit;
        assert!(output[base + size..base + padded].iter().all(|v| *v == 0));
        assert_eq!(r32(&output, at + 124), 0);
    }
    let mini_fat = (r32(&output, 60) as usize + 1) * 512;
    assert_eq!(r32(&output, mini_fat + 8), 0xffffffff);
    let sector_count = output.len() / 512 - 1;
    assert_eq!(r32(&output, 512 + sector_count * 4), 0xffffffff);
}
#[test]
fn builds_correctly_ordered_balanced_red_black_sibling_trees() {
    for count in 1..=65usize {
        let streams: Vec<CfbWriteStream> = (0..count).map(|i| s(&format!("S{i}"), payload(0))).collect();
        let output = write_compound_file(&streams, DEFAULT_CFB_LIMITS).unwrap();
        let directory = (r32(&output, 48) as usize + 1) * 512;
        let mut names: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        fn visit(o: &[u8], dir: usize, id: u32, red_parent: bool, names: &mut Vec<String>, seen: &mut std::collections::HashSet<u32>) -> usize {
            if id == 0xffffffff { return 1; }
            assert!(seen.insert(id));
            let at = dir + id as usize * 128; let red = o[at + 67] == 0;
            assert!(!(red && red_parent));
            let left = visit(o, dir, u32::from_le_bytes(o[at + 68..at + 72].try_into().unwrap()), red, names, seen);
            let len = u16::from_le_bytes([o[at + 64], o[at + 65]]) as usize - 2;
            let units: Vec<u16> = (0..len).step_by(2).map(|i| u16::from_le_bytes([o[at + i], o[at + i + 1]])).collect();
            names.push(String::from_utf16(&units).unwrap());
            let right = visit(o, dir, u32::from_le_bytes(o[at + 72..at + 76].try_into().unwrap()), red, names, seen);
            assert_eq!(left, right);
            left + usize::from(!red)
        }
        let root = r32(&output, directory + 76);
        assert_eq!(output[directory + root as usize * 128 + 67], 1);
        visit(&output, directory, root, false, &mut names, &mut seen);
        assert_eq!(seen.len(), count);
        let mut sorted = names.clone(); sorted.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
        assert_eq!(names, sorted);
    }
}
