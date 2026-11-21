//! Port of docx-theme.test.ts (the resolvers are crate-private, so these are unit tests).
use super::State;
use super::parts::{StyleResolver, ThemeResolver};
use crate::model::RunStyle;
use crate::xml::{XmlElement, parse_xml};
use crate::zip::ZipEntry;

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn props(content: &str) -> XmlElement { parse_xml(&format!(r#"<w:rPr xmlns:w="{W}">{content}</w:rPr>"#)).unwrap() }
fn state_with(theme: &str, settings: &str, relationships: &str) -> State {
    let parts = [
        ("[Content_Types].xml", r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/parts/colors.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/parts/options.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>"#.to_string()),
        ("word/_rels/document.xml.rels", format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="theme" Type="{R}/theme" Target="../parts/colors.xml"/><Relationship Id="settings" Type="{R}/settings" Target="../parts/options.xml"/>{relationships}</Relationships>"#)),
        ("parts/colors.xml", format!(r#"<a:theme xmlns:a="{A}"><a:themeElements><a:clrScheme name="Test">{theme}</a:clrScheme><a:fontScheme name="Test"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#)),
        ("parts/options.xml", format!(r#"<w:settings xmlns:w="{W}">{settings}</w:settings>"#)),
    ];
    State::parts_only(parts.into_iter().map(|(n, s)| ZipEntry::new(n, s)).collect(), "word/document.xml")
}
const ACCENT: &str = r#"<a:accent1><a:srgbClr val="336699"/></a:accent1>"#;
fn state() -> State { state_with(ACCENT, "", "") }
fn resolved_text(s: &State, content: &str, text: &str) -> RunStyle {
    let p = props(content);
    StyleResolver::new(s).unwrap().run(None, None, &RunStyle::default(), Some(&p), text)
}
fn resolved(s: &State, content: &str) -> RunStyle { resolved_text(s, content, "Latin") }
fn replace_part(s: &State, name: &str, transform: impl Fn(&str) -> String) -> State {
    let entries: Vec<ZipEntry> = s.entries.iter().map(|e| if e.name == name { ZipEntry::new(name, transform(&String::from_utf8(e.data.clone()).unwrap())) } else { e.clone() }).collect();
    State::parts_only(entries, &s.main_part)
}
fn fc(r: &RunStyle) -> (Option<&str>, Option<&str>) { (r.font_family.as_deref(), r.color.as_deref()) }

#[test]
fn resolves_latin_theme_font_pairs_and_colors_ahead_of_cached_literals() {
    let r = resolved(&state(), r#"<w:rFonts w:ascii="Cached" w:asciiTheme="majorAscii"/><w:color w:val="ffffff" w:themeColor="accent1"/>"#);
    assert_eq!(fc(&r), (Some("Georgia"), Some("336699")));
}
#[test]
fn maps_aliases_and_uses_stored_system_fallback() {
    let s = state_with(r#"<a:dk1><a:srgbClr val="111111"/></a:dk1><a:accent1><a:sysClr val="windowText" lastClr="223344"/></a:accent1>"#, r#"<w:clrSchemeMapping w:t1="accent1" w:accent1="dark1"/>"#, "");
    assert_eq!(resolved(&s, r#"<w:color w:themeColor="dark1"/>"#).color.as_deref(), Some("223344"));
    assert_eq!(resolved(&s, r#"<w:color w:themeColor="accent1"/>"#).color.as_deref(), Some("111111"));
}
#[test]
fn uses_hsl_transforms_exact_hex_and_tint_precedence() {
    assert_eq!(resolved(&state_with(r#"<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>"#, "", ""), r#"<w:color w:themeColor="accent1" w:themeTint="99"/>"#).color.as_deref(), Some("95b3d7"));
    for (attrs, expected) in [(r#"themeShade="00""#, "000000"), (r#"themeTint="00""#, "ffffff"), (r#"themeTint="FF""#, "336699"), (r#"themeShade="FF""#, "336699"), (r#"themeTint="00" w:themeShade="00""#, "ffffff")] {
        assert_eq!(resolved(&state(), &format!(r#"<w:color w:themeColor="accent1" w:{attrs}/>"#)).color.as_deref(), Some(expected), "{attrs}");
    }
    assert_eq!(resolved(&state(), r#"<w:color w:themeColor="accent1" w:themeTint="9"/>"#).color, None);
    assert_eq!(resolved(&state(), r#"<w:color w:val="336699" w:themeTint="00"/>"#).color.as_deref(), Some("336699"));
}
#[test]
fn keeps_language_and_script_sensitive_themes_unresolved_but_allows_literals() {
    let lang = state_with("", r#"<w:themeFontLang w:val="en-US"/>"#, "");
    assert_eq!(resolved(&lang, r#"<w:rFonts w:asciiTheme="majorAscii"/>"#).font_family, None);
    for content in ["<w:cs/>", "<w:rtl/>", r#"<w:rFonts w:hint="eastAsia" w:asciiTheme="majorAscii"/>"#] {
        assert_eq!(resolved(&state(), &format!(r#"<w:rFonts w:asciiTheme="majorAscii"/>{content}"#)).font_family, None, "{content}");
    }
    assert_eq!(resolved_text(&state(), r#"<w:rFonts w:asciiTheme="majorAscii"/>"#, "日本語").font_family, None);
    assert_eq!(resolved(&lang, r#"<w:rFonts w:ascii="Courier New"/>"#).font_family.as_deref(), Some("Courier New"));
}
#[test]
fn resolves_per_layer_pairs_without_reviving_masked_values() {
    let styles = format!(r#"<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Baseline" w:hAnsi="Baseline"/><w:color w:val="111111"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Theme"><w:rPr><w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi"/><w:color w:themeColor="accent1"/></w:rPr></w:style><w:style w:type="character" w:styleId="Literal"><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:color w:val="cc0000"/></w:rPr></w:style></w:styles>"#);
    let s = replace_part(&state(), "word/_rels/document.xml.rels", |x| x.replace("</Relationships>", &format!(r#"<Relationship Id="styles" Type="{R}/styles" Target="styles.xml"/></Relationships>"#)));
    let mut entries: Vec<ZipEntry> = s.entries.to_vec();
    entries.push(ZipEntry::new("word/styles.xml", styles));
    let s = State::parts_only(entries, "word/document.xml");
    let resolver = StyleResolver::new(&s).unwrap();
    let run = |p: Option<&str>, c: Option<&str>, direct: Option<XmlElement>| resolver.run(p, c, &RunStyle::default(), direct.as_ref(), "Latin");
    assert_eq!(fc(&run(Some("Theme"), None, None)), (Some("Georgia"), Some("336699")));
    assert_eq!(fc(&run(Some("Theme"), Some("Literal"), None)), (Some("Courier New"), Some("cc0000")));
    assert_eq!(run(Some("Theme"), Some("Literal"), Some(props(r#"<w:rFonts w:asciiTheme="unknown"/><w:color w:themeColor="unknown"/>"#))), RunStyle::default());
    assert_eq!(fc(&run(Some("Theme"), None, Some(props(r#"<w:rFonts w:ascii="Explicit"/><w:color w:val="abcdef"/>"#)))), (Some("Explicit"), Some("abcdef")));
}
#[test]
fn does_not_collapse_distinct_ascii_and_hansi_theme_families() {
    let fonts = r#"<w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="minorHAnsi"/>"#;
    assert_eq!(resolved_text(&state(), fonts, "ASCII").font_family.as_deref(), Some("Georgia"));
    assert_eq!(resolved_text(&state(), fonts, "é").font_family.as_deref(), Some("Arial"));
    assert_eq!(resolved_text(&state(), fonts, "Café").font_family, None);
}
#[test]
fn does_not_claim_one_literal_latin_family_for_script_sensitive_text() {
    for (fonts, text) in [(r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="MS Mincho"/>"#, "日本語"), (r#"<w:rFonts w:ascii="Georgia" w:cs="Arabic Typesetting"/>"#, "مرحبا"),
        (r#"<w:rFonts w:ascii="Georgia"/><w:cs/>"#, "ABC"), (r#"<w:rFonts w:ascii="Georgia"/><w:rtl/>"#, "ABC"), (r#"<w:rFonts w:ascii="Georgia" w:hint="eastAsia"/>"#, "ABC"),
        (r#"<w:rFonts w:ascii="Georgia" w:hint="cs"/>"#, "ABC"), (r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Arial"/>"#, "Café")] {
        let r = resolved_text(&state(), &format!(r#"{fonts}<w:color w:themeColor="accent1"/>"#), text);
        assert_eq!(fc(&r), (None, Some("336699")), "{fonts}");
    }
}
#[test]
fn guards_inherited_literal_fonts_under_theme_font_lang() {
    let resolver = ThemeResolver::new(&state_with("", r#"<w:themeFontLang w:val="en-US"/>"#, ""));
    let inherited = props(r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:color w:val="cc0000"/>"#);
    let (cs, cs0, courier) = (props("<w:cs/>"), props(r#"<w:cs w:val="0"/>"#), props(r#"<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>"#));
    let r = resolver.run(&[Some(&inherited), Some(&cs)], "ABC");
    assert_eq!((r.font_family, r.color), (None, Some(Some("cc0000".into()))));
    let r = resolver.run(&[Some(&inherited), Some(&courier)], "Café");
    assert_eq!((r.font_family.as_deref(), r.color), (Some("Courier New"), Some(Some("cc0000".into()))));
    assert_eq!(resolver.run(&[Some(&inherited), Some(&cs), Some(&cs0)], "ABC").font_family.as_deref(), Some("Georgia"));
}
#[test]
fn does_not_borrow_a_missing_font_slot() {
    for (fonts, text) in [(r#"<w:rFonts w:asciiTheme="majorAscii"/>"#, "éàü"), (r#"<w:rFonts w:hAnsiTheme="majorHAnsi"/>"#, "ASCII"), (r#"<w:rFonts w:asciiTheme="majorAscii"/>"#, "Café"),
        (r#"<w:rFonts w:hAnsiTheme="majorHAnsi"/>"#, "Café"), (r#"<w:rFonts w:ascii="Georgia"/>"#, "éàü"), (r#"<w:rFonts w:hAnsi="Georgia"/>"#, "ASCII")] {
        assert_eq!(resolved_text(&state(), fonts, text).font_family, None, "{fonts} {text}");
    }
}
#[test]
fn resolves_many_runs_against_a_large_supplemental_font_list() {
    // The TypeScript spies on attribute reads; Rust validates the theme once in ThemeResolver::new,
    // so this checks the observable result over many runs.
    let large = replace_part(&state(), "parts/colors.xml", |x| x.replacen(r#"<a:latin typeface="Georgia"/>"#, &format!("{}{}", r#"<a:font script="Latn" typeface="Supplemental"/>"#.repeat(5000), r#"<a:latin typeface="Georgia"/>"#), 1));
    let resolver = ThemeResolver::new(&large);
    let layer = props(r#"<w:rFonts w:asciiTheme="majorAscii"/><w:color w:themeColor="accent1" w:themeTint="ff"/>"#);
    for _ in 0..100 {
        let r = resolver.run(&[Some(&layer)], "ASCII");
        assert_eq!((r.font_family.as_deref(), r.color), (Some("Georgia"), Some(Some("336699".into()))));
    }
}
#[test]
fn leaves_untrusted_dependencies_unresolved() {
    let cases: Vec<(&str, Box<dyn Fn(&str) -> String>)> = vec![
        ("word/_rels/document.xml.rels", Box::new(|s| s.replace(r#"Id="theme""#, r#"Id="theme" TargetMode="External""#))),
        ("word/_rels/document.xml.rels", Box::new(|s| s.replace(r#"Id="settings""#, r#"Id="theme""#))),
        ("word/_rels/document.xml.rels", Box::new(|s| s.replace("../parts/colors.xml", "../parts/%63olors.xml"))),
        ("word/_rels/document.xml.rels", Box::new(|s| s.replace("../parts/colors.xml", "../../parts/colors.xml"))),
        ("[Content_Types].xml", Box::new(|s| s.replace("application/vnd.openxmlformats-officedocument.theme+xml", "application/xml"))),
        ("[Content_Types].xml", Box::new(|s| s.replace("</Types>", r#"<Override PartName="/parts/colors.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>"#))),
        ("parts/colors.xml", Box::new(|s| s.replace("a:theme ", "a:other ").replace("</a:theme>", "</a:other>"))),
        ("parts/colors.xml", Box::new(|s| s.replace(A, "urn:untrusted"))),
    ];
    for (i, (name, transform)) in cases.into_iter().enumerate() {
        let s = replace_part(&state(), name, |x| transform(x));
        assert_eq!(resolved(&s, r#"<w:rFonts w:asciiTheme="majorAscii"/><w:color w:val="cached" w:themeColor="accent1"/>"#), RunStyle::default(), "case {i}");
    }
}
#[test]
fn supports_strict_theme_and_relationship_namespaces() {
    let s = replace_part(&state(), "parts/colors.xml", |x| x.replace(A, "http://purl.oclc.org/ooxml/drawingml/main"));
    let s = replace_part(&s, "word/_rels/document.xml.rels", |x| x.replace(R, "http://purl.oclc.org/ooxml/officeDocument/relationships"));
    assert_eq!(fc(&resolved(&s, r#"<w:rFonts w:asciiTheme="minorAscii"/><w:color w:themeColor="accent1"/>"#)), (Some("Arial"), Some("336699")));
}
#[test]
fn does_not_trust_ambiguous_dependencies_or_transformed_colors() {
    let duplicate = state_with(ACCENT, "", &format!(r#"<Relationship Id="other" Type="{R}/theme" Target="../parts/colors.xml"/>"#));
    assert_eq!(resolved(&duplicate, r#"<w:rFonts w:asciiTheme="majorAscii"/><w:color w:themeColor="accent1"/>"#).font_family, None);
    for color in [r#"<a:accent1><a:srgbClr val="336699"><a:tint val="50000"/></a:srgbClr></a:accent1>"#, r#"<a:accent1><a:srgbClr val="wrong"/></a:accent1>"#,
        r#"<a:accent1><a:sysClr val="windowText"/></a:accent1>"#, r#"<a:accent1><a:srgbClr val="336699"/><a:srgbClr val="000000"/></a:accent1>"#] {
        assert_eq!(resolved(&state_with(color, "", ""), r#"<w:color w:themeColor="accent1"/>"#).color, None, "{color}");
    }
}
