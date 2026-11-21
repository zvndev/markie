//! Port of src/lib/office/xml.test.ts.
use markie_office::xml::*;

#[test]
fn resolves_namespaces_decodes_text_and_retains_exact_element_offsets() {
    let source = r#"<?xml version="1.0" encoding="UTF-8"?><q:p xmlns:q="urn:word"><q:t xml:space="preserve">Hi &amp; &#x1f600;<![CDATA[<>]]></q:t></q:p>"#;
    let root = parse_xml(source).unwrap();
    assert_eq!(root.namespace, "urn:word");
    let text = &root.children[0];
    assert_eq!(text.text, "Hi & 😀<>");
    assert_eq!(xml_attribute(text, "space", "http://www.w3.org/XML/1998/namespace"), Some("preserve"));
    assert_eq!(&source[text.start..text.end], r#"<q:t xml:space="preserve">Hi &amp; &#x1f600;<![CDATA[<>]]></q:t>"#);
    assert_eq!(xml_descendants(&root).len(), 2);
}

#[test]
fn rejects_malformed_entity_bearing_or_unsupported_xml() {
    // TypeScript also feeds a lone surrogate ("\ud800"); a Rust &str cannot hold one,
    // so that case is covered by UTF-8 decoding instead (see docx encoding tests).
    let cases = [
        r#"<!DOCTYPE p [<!ENTITY secret SYSTEM "file:///etc/passwd">]><p>&secret;</p>"#,
        "<p>&unknown;</p>", "<p>&#0;</p>", "<p>&#xD800;</p>", "<p>&unclosed</p>",
        r#"<p a="1" a="2"/>"#, r#"<p xmlns:a="urn:x" xmlns:b="urn:x" a:k="1" b:k="2"/>"#,
        r#"<p xmlns:xml="urn:wrong"/>"#, "<q:p/>", "<p></q>", "<p/><p/>", "<p>]]></p>",
        r#"<p a="<"/>"#, "<p><!--bad--comment--></p>", r#"<p><?xml version="1.0"?></p>"#,
        r#"<?xml version="1.0" encoding="UTF-32"?><p/>"#, r#"<?xml version="1.0" encoding="ISO-8859-1"?><p/>"#, "<p>\u{0}</p>",
        "<p></ p>", "<p></\np>", "<p></p extra>",
        r#"<?XML version="1.0"?><p/>"#, "<p\u{a0}a=\"b\"/>", "\u{a0}<p/>", "<p/>\u{a0}",
        "&#32;<p/>", "<p/>&#10;", "&#x9;<p/>",
    ];
    for source in cases {
        assert!(parse_xml(source).is_err(), "{source}");
    }
}

#[test]
fn skips_a_doctype_that_only_names_an_external_dtd() {
    let manifest = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE manifest:manifest PUBLIC \"-//OpenOffice.org//DTD Manifest 1.0//EN\" \"Manifest.dtd\">\n<manifest:manifest xmlns:manifest=\"urn:m\"><manifest:file-entry manifest:full-path=\"/\"/></manifest:manifest>";
    let root = parse_xml(manifest).unwrap();
    assert_eq!(root.local_name, "manifest");
    assert_eq!(root.children.len(), 1);
    assert_eq!(&manifest[root.start..root.start + 18], "<manifest:manifest");
    assert_eq!(parse_xml("<!DOCTYPE p>\n<p/>").unwrap().local_name, "p");
    assert_eq!(parse_xml("<!-- lead --><!DOCTYPE p SYSTEM 'p.dtd' ><!-- after --><p>x</p>").unwrap().text, "x");
    assert_eq!(parse_xml("<!DOCTYPE p PUBLIC '-//A (q)//EN' \"https://example.invalid/p.dtd\"><p/>").unwrap().local_name, "p");
}

#[test]
fn never_resolves_the_external_dtd() {
    assert_eq!(parse_xml(r#"<!DOCTYPE p SYSTEM "file:///etc/passwd"><p>plain</p>"#).unwrap().text, "plain");
    assert!(parse_xml(r#"<!DOCTYPE p SYSTEM "file:///etc/passwd"><p>&passwd;</p>"#).unwrap_err().message.contains("Custom XML entities"));
    assert!(parse_xml(r#"<!DOCTYPE p SYSTEM "https://example.invalid/x.dtd"><p a="&x;"/>"#).unwrap_err().message.contains("Custom XML entities"));
}

#[test]
fn still_refuses_hostile_or_declaring_dtds() {
    let cases = [
        r#"<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>"#,
        r#"<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>"#,
        r#"<!DOCTYPE foo [<!ENTITY % remote SYSTEM "https://example.invalid/evil.dtd">%remote;]><foo/>"#,
        "<!DOCTYPE p []><p/>",
        r#"<!DOCTYPE p SYSTEM "p.dtd" [<!ATTLIST p a CDATA "x">]><p/>"#,
        r#"<!DOCTYPE p PUBLIC "-//A//EN" "p.dtd" [ ]><p/>"#,
        r#"<!ENTITY x "y"><p/>"#,
        "<!ELEMENT p ANY><p/>",
        "<!doctype p><p/>",
        "<!DOCTYPE p><!DOCTYPE p><p/>",
        r#"<!DOCTYPE p><?xml version="1.0"?><p/>"#,
        "<p><!DOCTYPE p></p>",
        "<p/><!DOCTYPE p>",
        r#"<!DOCTYPE p PUBLIC "-//A//EN"><p/>"#,
        r#"<!DOCTYPE p SYSTEM "p.dtd""#,
        "<!DOCTYPE p SYSTEM p.dtd><p/>",
        r#"<!DOCTYPE p SYSTEM "a>[<!ENTITY x 'y'>]"><p/>"#,
        r#"<!DOCTYPE p PUBLIC "-//A{}//EN" "p.dtd"><p/>"#,
        "<!DOCTYPE p PUBLIC '-//A \"q\"//EN' 'p.dtd'><p/>",
    ];
    for source in cases {
        assert!(parse_xml(source).is_err(), "{source}");
    }
}

#[test]
fn accepts_a_utf16_declaration_on_already_decoded_text() {
    assert_eq!(parse_xml(r#"<?xml version="1.0" encoding="UTF-16" standalone="yes"?><p/>"#).unwrap().local_name, "p");
}

#[test]
fn bounds_document_size_and_depth() {
    assert!(parse_xml_limited("<p/>", 3).unwrap_err().message.contains("limit"));
    assert!(parse_xml(&("<p>".repeat(130) + &"</p>".repeat(130))).unwrap_err().message.contains("limit"));
}

#[test]
fn escapes_edits_without_allowing_markup_injection_or_changing_carriage_returns() {
    assert_eq!(escape_xml_text("<&>\r😀").unwrap(), "&lt;&amp;&gt;&#13;😀");
    assert_eq!(parse_xml(&format!("<t>{}</t>", escape_xml_text("<&>\r😀").unwrap())).unwrap().text, "<&>\r😀");
}

#[test]
fn normalizes_literal_crlf_before_attribute_whitespace() {
    let node = parse_xml("<p a=\"one\r\ntwo\rthree\tfour&#13;&#10;\"/>").unwrap();
    assert_eq!(xml_attribute(&node, "a", ""), Some("one two three four\r\n"));
}
