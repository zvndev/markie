//! Port of src/lib/office/zip.test.ts.
use markie_office::zip::*;

fn le16(b: &mut [u8], o: usize, v: u16) { b[o..o + 2].copy_from_slice(&v.to_le_bytes()); }
fn le32(b: &mut [u8], o: usize, v: u32) { b[o..o + 4].copy_from_slice(&v.to_le_bytes()); }
fn rd32(b: &[u8], o: usize) -> u32 { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }

fn one_entry(name: &str, text: &str) -> markie_office::Result<Vec<u8>> {
    write_zip(&[ZipEntry::new(name, text.as_bytes())], DEFAULT_ZIP_LIMITS)
}
fn deflated(text: &str, descriptor: bool) -> Vec<u8> {
    let source = text.as_bytes();
    let compressed = miniz_oxide::deflate::compress_to_vec(source, 6);
    let stored = one_entry("part.xml", text).unwrap();
    let header_length = 30 + "part.xml".len();
    let central_start = header_length + source.len();
    let descriptor_length = if descriptor { 16 } else { 0 };
    let mut bytes = vec![0u8; stored.len() - source.len() + compressed.len() + descriptor_length];
    bytes[..header_length].copy_from_slice(&stored[..header_length]);
    bytes[header_length..header_length + compressed.len()].copy_from_slice(&compressed);
    let new_central = header_length + compressed.len() + descriptor_length;
    bytes[new_central..].copy_from_slice(&stored[central_start..]);
    let n = bytes.len();
    le16(&mut bytes, 8, 8);
    le32(&mut bytes, 18, compressed.len() as u32);
    le16(&mut bytes, new_central + 10, 8);
    le32(&mut bytes, new_central + 20, compressed.len() as u32);
    le32(&mut bytes, n - 6, new_central as u32);
    if descriptor {
        le16(&mut bytes, 6, 0x0808);
        le16(&mut bytes, new_central + 8, 0x0808);
        le32(&mut bytes, 14, 0);
        le32(&mut bytes, 18, 0);
        le32(&mut bytes, 22, 0);
        let start = header_length + compressed.len();
        le32(&mut bytes, start, 0x08074b50);
        le32(&mut bytes, start + 4, zip_crc32(source));
        le32(&mut bytes, start + 8, compressed.len() as u32);
        le32(&mut bytes, start + 12, source.len() as u32);
    }
    bytes
}
fn msg(r: markie_office::Result<Vec<ZipEntry>>) -> String { r.unwrap_err().message }

#[test]
fn implements_the_published_crc32_check_value() {
    assert_eq!(zip_crc32(b"123456789"), 0xcbf43926);
}

#[test]
fn writes_and_reads_unicode_part_contents_and_independent_owned_buffers() {
    let bytes = one_entry("word/document.xml", "Hello 😀").unwrap();
    let mut result = read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap();
    assert_eq!(String::from_utf8(result[0].data.clone()).unwrap(), "Hello 😀");
    result[0].data.fill(0);
    assert_eq!(String::from_utf8(read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap()[0].data.clone()).unwrap(), "Hello 😀");
}

#[test]
fn never_strips_a_leading_filename_bom_or_aliases_it() {
    let bytes = write_zip(&[ZipEntry::new("\u{feff}part.xml", "x"), ZipEntry::new("part.xml", "y")], DEFAULT_ZIP_LIMITS).unwrap();
    let names: Vec<String> = read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap().into_iter().map(|p| p.name).collect();
    assert_eq!(names, vec!["\u{feff}part.xml", "part.xml"]);
}

#[test]
fn reads_platform_deflate_entries_with_and_without_descriptor() {
    for descriptor in [false, true] {
        let text = "Generated fixture α".repeat(80);
        let bytes = deflated(&text, descriptor);
        assert_eq!(String::from_utf8(read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap()[0].data.clone()).unwrap(), text);
    }
}

#[test]
fn rejects_unsafe_paths() {
    for name in ["../word.xml", "/word.xml", "word\\x.xml", "word//x.xml", "word/./x.xml", "word/%2e%2e/x.xml", "word/a:b.xml", "a\u{0}.xml"] {
        assert!(one_entry(name, "hello").is_err(), "{name}");
    }
}

#[test]
fn rejects_unsafe_paths_in_input_as_well_as_output() {
    let mut bytes = one_entry("ok/x", "hello").unwrap();
    for i in 0..bytes.len() - 3 {
        if &bytes[i..i + 4] == b"ok/x" { bytes[i] = b'.'; bytes[i + 1] = b'.'; }
    }
    assert!(msg(read_zip(&bytes, DEFAULT_ZIP_LIMITS)).contains("Unsafe"));
}

#[test]
fn rejects_duplicate_case_aliased_paths() {
    let err = write_zip(&[ZipEntry::new("a.xml", ""), ZipEntry::new("A.xml", "")], DEFAULT_ZIP_LIMITS).unwrap_err();
    assert!(err.message.contains("Duplicate"));
}

#[test]
fn checks_crc_before_exposing_entries() {
    let mut bytes = one_entry("word/document.xml", "hello").unwrap();
    bytes[30 + "word/document.xml".len()] ^= 1;
    assert!(msg(read_zip(&bytes, DEFAULT_ZIP_LIMITS)).contains("integrity"));
}

#[test]
fn rejects_encrypted_flags_truncated_headers_trailing_junk_and_mismatches() {
    let bytes = one_entry("word/document.xml", "hello").unwrap();
    let mut encrypted = bytes.clone();
    let central = 30 + "word/document.xml".len() + 5;
    le16(&mut encrypted, 6, 0x0801);
    le16(&mut encrypted, central + 8, 0x0801);
    assert!(msg(read_zip(&encrypted, DEFAULT_ZIP_LIMITS)).contains("Encrypted"));
    assert!(read_zip(&bytes[..bytes.len() - 8], DEFAULT_ZIP_LIMITS).is_err());
    let mut junk = bytes.clone();
    junk.push(0);
    assert!(msg(read_zip(&junk, DEFAULT_ZIP_LIMITS)).contains("trailing"));
    let mut mismatch = bytes.clone();
    mismatch[30] ^= 1;
    assert!(msg(read_zip(&mismatch, DEFAULT_ZIP_LIMITS)).contains("disagree"));
}

#[test]
fn preflights_declared_expansion_entry_counts_invalid_limits_and_inflated_size() {
    let one = one_entry("word/document.xml", "hello").unwrap();
    assert!(msg(read_zip(&one, ZipLimits { max_archive_bytes: 2, ..DEFAULT_ZIP_LIMITS })).contains("size limit"));
    assert!(msg(read_zip(&one, ZipLimits { max_entry_bytes: 2, ..DEFAULT_ZIP_LIMITS })).contains("expansion"));
    assert!(msg(read_zip(&deflated(&"a".repeat(1000), false), ZipLimits { max_compression_ratio: 2, ..DEFAULT_ZIP_LIMITS })).contains("expansion"));
    // TypeScript passes -1; an unsigned limit's only invalid value is zero.
    assert!(msg(read_zip(&one, ZipLimits { max_entries: 0, ..DEFAULT_ZIP_LIMITS })).contains("positive"));
    let mut bomb = deflated(&"a".repeat(1000), false);
    let n = bomb.len();
    let central = rd32(&bomb, n - 6) as usize;
    le32(&mut bomb, 22, 1);
    le32(&mut bomb, central + 24, 1);
    assert!(msg(read_zip(&bomb, DEFAULT_ZIP_LIMITS)).contains("beyond"));
}

#[test]
fn rejects_overlapping_or_hidden_local_records_before_inflation() {
    let mut bytes = write_zip(&[ZipEntry::new("a", "abc"), ZipEntry::new("b", "abc")], DEFAULT_ZIP_LIMITS).unwrap();
    let n = bytes.len();
    let central = rd32(&bytes, n - 6) as usize;
    le32(&mut bytes, central + 47 + 42, 0);
    assert!(read_zip(&bytes, DEFAULT_ZIP_LIMITS).is_err());
}
