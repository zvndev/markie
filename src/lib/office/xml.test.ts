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
