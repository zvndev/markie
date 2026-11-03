import { describe, expect, it } from "vitest";
import { escapeXmlText, parseXml, xmlAttribute, xmlDescendants } from "./xml";

describe("original bounded XML reader", () => {
  it("resolves namespaces, decodes text and retains exact element offsets", () => {
    const source = '<?xml version="1.0" encoding="UTF-8"?><q:p xmlns:q="urn:word"><q:t xml:space="preserve">Hi &amp; &#x1f600;<![CDATA[<>]]></q:t></q:p>';
    const root = parseXml(source);
    expect(root.namespace).toBe("urn:word");
    const text = root.children[0];
    expect(text.text).toBe("Hi & 😀<>");
    expect(xmlAttribute(text, "space", "http://www.w3.org/XML/1998/namespace")).toBe("preserve");
    expect(source.slice(text.start, text.end)).toBe('<q:t xml:space="preserve">Hi &amp; &#x1f600;<![CDATA[<>]]></q:t>');
    expect(xmlDescendants(root)).toHaveLength(2);
  });

  it.each([
    '<!DOCTYPE p [<!ENTITY secret SYSTEM "file:///etc/passwd">]><p>&secret;</p>',
    '<p>&unknown;</p>', '<p>&#0;</p>', '<p>&#xD800;</p>', '<p>&unclosed</p>',
    '<p a="1" a="2"/>', '<p xmlns:a="urn:x" xmlns:b="urn:x" a:k="1" b:k="2"/>',
    '<p xmlns:xml="urn:wrong"/>', '<q:p/>', '<p></q>', '<p/><p/>', '<p>]]></p>',
    '<p a="<"/>', '<p><!--bad--comment--></p>', '<p><?xml version="1.0"?></p>',
    '<?xml version="1.0" encoding="UTF-32"?><p/>', '<?xml version="1.0" encoding="ISO-8859-1"?><p/>', '<p>\u0000</p>', '<p>\ud800</p>',
    '<p></ p>', '<p></\np>', '<p></p extra>',
    '<?XML version="1.0"?><p/>', '<p\u00a0a="b"/>', '\u00a0<p/>', '<p/>\u00a0',
    '&#32;<p/>', '<p/>&#10;', '&#x9;<p/>',
  ])("rejects malformed, entity-bearing or unsupported XML: %s", (source) => {
    expect(() => parseXml(source)).toThrow();
  });

  it("skips a DOCTYPE that only names an external DTD, as TextEdit and OpenOffice manifests do", () => {
    const manifest = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE manifest:manifest PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "Manifest.dtd">\n<manifest:manifest xmlns:manifest="urn:m"><manifest:file-entry manifest:full-path="/"/></manifest:manifest>';
    const root = parseXml(manifest);
    expect(root.localName).toBe("manifest");
    expect(root.children).toHaveLength(1);
    expect(manifest.slice(root.start, root.start + 18)).toBe("<manifest:manifest");
    expect(parseXml("<!DOCTYPE p>\n<p/>").localName).toBe("p");
    expect(parseXml("<!-- lead --><!DOCTYPE p SYSTEM 'p.dtd' ><!-- after --><p>x</p>").text).toBe("x");
    expect(parseXml("<!DOCTYPE p PUBLIC '-//A (q)//EN' \"https://example.invalid/p.dtd\"><p/>").localName).toBe("p");
  });

  it("never resolves the external DTD: a file:/// system identifier is inert and its entities stay unknown", () => {
    expect(parseXml('<!DOCTYPE p SYSTEM "file:///etc/passwd"><p>plain</p>').text).toBe("plain");
    expect(() => parseXml('<!DOCTYPE p SYSTEM "file:///etc/passwd"><p>&passwd;</p>')).toThrow(/Custom XML entities/);
    expect(() => parseXml('<!DOCTYPE p SYSTEM "https://example.invalid/x.dtd"><p a="&x;"/>')).toThrow(/Custom XML entities/);
  });

  it.each([
    ["billion laughs", '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>'],
    ["external entity to /etc/passwd", '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>'],
    ["parameter entity", '<!DOCTYPE foo [<!ENTITY % remote SYSTEM "https://example.invalid/evil.dtd">%remote;]><foo/>'],
    ["empty internal subset", '<!DOCTYPE p []><p/>'],
    ["external id plus internal subset", '<!DOCTYPE p SYSTEM "p.dtd" [<!ATTLIST p a CDATA "x">]><p/>'],
    ["external id plus spaced internal subset", '<!DOCTYPE p PUBLIC "-//A//EN" "p.dtd" [ ]><p/>'],
    ["bare ENTITY declaration", '<!ENTITY x "y"><p/>'],
    ["bare ELEMENT declaration", '<!ELEMENT p ANY><p/>'],
    ["lower-case doctype", '<!doctype p><p/>'],
    ["two DOCTYPEs", '<!DOCTYPE p><!DOCTYPE p><p/>'],
    ["DOCTYPE before the XML declaration", '<!DOCTYPE p><?xml version="1.0"?><p/>'],
    ["DOCTYPE inside the root", '<p><!DOCTYPE p></p>'],
    ["DOCTYPE after the root", '<p/><!DOCTYPE p>'],
    ["PUBLIC without a system literal", '<!DOCTYPE p PUBLIC "-//A//EN"><p/>'],
    ["unterminated DOCTYPE", '<!DOCTYPE p SYSTEM "p.dtd"'],
    ["unquoted system id", '<!DOCTYPE p SYSTEM p.dtd><p/>'],
    ["markup inside the system literal", '<!DOCTYPE p SYSTEM "a>[<!ENTITY x \'y\'>]"><p/>'],
    ["invalid public id character", '<!DOCTYPE p PUBLIC "-//A{}//EN" "p.dtd"><p/>'],
    ["double quote inside a single-quoted public id", "<!DOCTYPE p PUBLIC '-//A \"q\"//EN' 'p.dtd'><p/>"],
  ])("still refuses hostile or declaring DTDs: %s", (_name, source) => {
    expect(() => parseXml(source)).toThrow();
  });

  it("accepts a UTF-16 declaration on already-decoded text; byte/declaration agreement is checked by the package decoder", () => {
    expect(parseXml('<?xml version="1.0" encoding="UTF-16" standalone="yes"?><p/>').localName).toBe("p");
  });

  it("bounds document size and depth", () => {
    expect(() => parseXml("<p/>", 3)).toThrow(/limit/);
    expect(() => parseXml("<p>".repeat(130) + "</p>".repeat(130))).toThrow(/limit/);
  });

  it("escapes edits without allowing markup injection or changing carriage returns", () => {
    expect(escapeXmlText('<&>\r😀')).toBe("&lt;&amp;&gt;&#13;😀");
    expect(parseXml(`<t>${escapeXmlText('<&>\r😀')}</t>`).text).toBe('<&>\r😀');
  });

  it("normalizes literal CRLF before attribute whitespace, preserving referenced whitespace", () => {
    const node = parseXml('<p a="one\r\ntwo\rthree\tfour&#13;&#10;"/>');
    expect(xmlAttribute(node, "a")).toBe("one two three four\r\n");
  });
});
