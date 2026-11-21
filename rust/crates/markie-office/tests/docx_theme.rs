//! Port of docx-theme.integration.test.ts with the docx-theme.fixture.ts package.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;

const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const THEME_PART: &str = "assets/themes/editorial.xml";
const SETTINGS_PART: &str = "word/preferences/theme-settings.xml";
const RETAINED_PART: &str = "customXml/retained.xml";
const MAIN: &str = "word/document.xml";
const STYLES: &str = "word/styles.xml";
const RELS: &str = "word/_rels/document.xml.rels";
const THEME_TYPE: &str = "application/vnd.openxmlformats-officedocument.theme+xml";

struct Themed { bytes: Vec<u8>, theme: String, settings: String, styles: String }
fn themed() -> Themed {
    let seed = apply(&create_docx("Themed heading\nTheme body Direct").unwrap(), &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: ParagraphFormat { style_id: Some(Some("Heading1".into())), ..Default::default() } }]);
    let mut parts = read_zip(&export(&seed), DEFAULT_ZIP_LIMITS).unwrap();
    let fill = r#"<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>"#;
    let theme = format!(r#"<a:theme xmlns:a="{A}" name="Markie synthetic editorial"><a:themeElements>
    <a:clrScheme name="Editorial colors">
      <a:dk1><a:sysClr val="windowText" lastClr="222222"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="444444"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:accent1><a:srgbClr val="336699"/></a:accent1><a:accent2><a:srgbClr val="808080"/></a:accent2>
      <a:accent3><a:srgbClr val="008000"/></a:accent3><a:accent4><a:srgbClr val="800080"/></a:accent4>
      <a:accent5><a:srgbClr val="008080"/></a:accent5><a:accent6><a:srgbClr val="800000"/></a:accent6>
      <a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Editorial fonts"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Editorial shapes"><a:fillStyleLst>{f3}</a:fillStyleLst><a:lnStyleLst>{ln}</a:lnStyleLst><a:effectStyleLst>{ef}</a:effectStyleLst><a:bgFillStyleLst>{f3}</a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements></a:theme>"#, f3 = fill.repeat(3), ln = format!(r#"<a:ln w="9525">{fill}<a:prstDash val="solid"/></a:ln>"#).repeat(3), ef = "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3));
    let settings = format!(r#"<w:settings xmlns:w="{W}"/>"#);
    let styles = format!(r#"<w:styles xmlns:w="{W}">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorAscii" w:hAnsiTheme="minorHAnsi"/><w:color w:val="999999" w:themeColor="text1"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Themed heading"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi"/><w:b/><w:color w:val="999999" w:themeColor="accent1"/><w:sz w:val="32"/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="ThemeAccent"><w:name w:val="Themed accent"/><w:rPr><w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi"/><w:color w:themeColor="accent3"/></w:rPr></w:style>
  </w:styles>"#);
    parts.iter_mut().find(|p| p.name == STYLES).unwrap().data = styles.clone().into_bytes();
    change_xml(&mut parts, MAIN, |x| {
        let a = x.find("<w:p>").unwrap(); let first = a + x[a..].find("</w:p>").unwrap() + 6;
        let second = first + x[first..].find("</w:p>").unwrap() + 6;
        format!("{}{}{}", &x[..a], r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Themed heading</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Theme body </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:color w:val="cc0000"/><w:sz w:val="18"/></w:rPr><w:t>Direct</w:t></w:r></w:p>"#, &x[second..])
    });
    change_xml(&mut parts, RELS, |x| x.replace("</Relationships>", &format!(r#"<Relationship Id="rTheme" Type="{R}/theme" Target="../assets/themes/editorial.xml"/><Relationship Id="rSettings" Type="{R}/settings" Target="preferences/theme-settings.xml"/></Relationships>"#)));
    parts.push(ZipEntry::new(THEME_PART, theme.clone())); parts.push(ZipEntry::new(SETTINGS_PART, settings.clone()));
    parts.push(ZipEntry::new(RETAINED_PART, r#"<retained xmlns="urn:markie:synthetic">Untouched original payload</retained>"#));
    change_xml(&mut parts, "[Content_Types].xml", |x| x.replace("</Types>", &format!(r#"<Override PartName="/{THEME_PART}" ContentType="{THEME_TYPE}"/><Override PartName="/{SETTINGS_PART}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>"#)));
    Themed { bytes: write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap(), theme, settings, styles }
}
type Change<'a> = &'a dyn Fn(&mut Vec<ZipEntry>);
fn rewrite(parts: &mut [ZipEntry], name: &str, change: impl FnOnce(&str) -> String) { change_xml(parts, name, change); }
fn package_variant(change: Change) -> (DocxDocument, Vec<u8>) {
    let mut parts = read_zip(&themed().bytes, DEFAULT_ZIP_LIMITS).unwrap();
    change(&mut parts);
    let bytes = write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap();
    (open(&bytes), bytes)
}
fn variant(change: Change) -> DocxDocument { package_variant(change).0 }
fn heading_package(properties: &str, extra: Change) -> (DocxDocument, Vec<u8>) {
    let p = properties.to_string();
    package_variant(&move |parts| { rewrite(parts, MAIN, |x| x.replacen("<w:r><w:t>Themed heading", &format!("<w:r><w:rPr>{p}</w:rPr><w:t>Themed heading"), 1)); extra(parts); })
}
fn heading(properties: &str) -> DocxDocument { heading_package(properties, &|_| {}).0 }
fn heading_with(properties: &str, extra: Change) -> DocxDocument { heading_package(properties, extra).0 }
fn rs(d: &DocxDocument, p: usize, r: usize) -> RunStyle { d.paragraphs[p].runs[r].resolved_style.clone().unwrap() }
fn upper(c: Option<String>) -> Option<String> { c.map(|x| x.to_uppercase()) }
fn heading_text(text: &'static str) -> impl Fn(&mut Vec<ZipEntry>) { move |parts| rewrite(parts, MAIN, |x| x.replacen("Themed heading</w:t>", &format!("{text}</w:t>"), 1)) }
fn settings_with(inner: &'static str) -> impl Fn(&mut Vec<ZipEntry>) { move |parts| rewrite(parts, SETTINGS_PART, |x| x.replacen("/>", &format!("><{inner}/></w:settings>"), 1)) }
/// `xml.replace(new RegExp(` w:${attr}="[^"]*"`, "g"), "")`
fn strip_attribute(xml: &str, attribute: &str) -> String {
    let needle = format!(" w:{attribute}=\"");
    let mut out = String::new(); let mut rest = xml;
    while let Some(s) = rest.find(&needle) {
        out.push_str(&rest[..s]);
        let after = &rest[s + needle.len()..];
        rest = &after[after.find('"').unwrap() + 1..];
    }
    out.push_str(rest); out
}
fn remove_rel(xml: &str, id: &str) -> String {
    let s = xml.find(&format!(r#"<Relationship Id="{id}""#)).unwrap(); let e = s + xml[s..].find("/>").unwrap() + 2;
    format!("{}{}", &xml[..s], &xml[e..])
}

#[test]
fn resolves_arbitrary_path_theme_defaults_and_named_styles_without_changing_bytes() {
    let t = themed(); let d = open(&t.bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics); assert_eq!(d.text, "Themed heading\nTheme body Direct");
    assert_eq!(d.paragraphs[0].runs[0].style, RunStyle::default());
    let r = rs(&d, 0, 0); assert_eq!((r.font_family.as_deref(), r.font_size_points, r.bold, r.color.as_deref()), (Some("Georgia"), Some(16.0), Some(true), Some("336699")));
    let r = rs(&d, 1, 0); assert_eq!((r.font_family.as_deref(), r.font_size_points, r.color.as_deref()), (Some("Arial"), Some(11.0), Some("222222")));
    let direct = &d.paragraphs[1].runs[1];
    assert_eq!((direct.style.font_family.as_deref(), direct.style.font_size_points, direct.style.color.as_deref()), (Some("Courier New"), Some(9.0), Some("cc0000")));
    let r = rs(&d, 1, 1); assert_eq!((r.font_family.as_deref(), r.font_size_points, r.color.as_deref()), (Some("Courier New"), Some(9.0), Some("cc0000")));
    assert_eq!(export(&d), t.bytes);
}
#[test]
fn preserves_theme_settings_styles_and_unknown_parts_after_edits() {
    let t = themed(); let d = open(&t.bytes);
    let changed = apply(&replace(&d, &d.paragraphs[0].runs[0].id, "An edited heading"), &[Operation::FormatParagraph { paragraph_id: d.paragraphs[1].id.clone(), format: ParagraphFormat { style_id: Some(Some("Heading1".into())), ..Default::default() } }]);
    let exported = export(&changed); let r = open(&exported);
    assert_eq!(r.paragraphs[0].text, "An edited heading");
    let a = rs(&r, 1, 0); assert_eq!((a.font_family.as_deref(), a.color.as_deref(), a.font_size_points), (Some("Georgia"), Some("336699"), Some(16.0)));
    let b = rs(&r, 1, 1); assert_eq!((b.font_family.as_deref(), b.color.as_deref(), b.font_size_points), (Some("Courier New"), Some("cc0000"), Some(9.0)));
    let (orig, next) = (read_zip(&t.bytes, DEFAULT_ZIP_LIMITS).unwrap(), read_zip(&exported, DEFAULT_ZIP_LIMITS).unwrap());
    for p in orig.iter().filter(|p| p.name != MAIN) { assert_eq!(next.iter().find(|x| x.name == p.name).unwrap().data, p.data); }
    assert_eq!(part(&exported, THEME_PART).unwrap(), t.theme); assert_eq!(part(&exported, SETTINGS_PART).unwrap(), t.settings); assert_eq!(part(&exported, STYLES).unwrap(), t.styles);
    assert!(part(&exported, RETAINED_PART).is_some());
    let main = document_xml(&exported);
    assert!(!main.contains(r#"w:ascii="Georgia""#) && !main.contains(r#"w:val="336699""#));
    assert_eq!(r.paragraphs[0].runs[0].style, RunStyle::default());
    assert_eq!(export(&d), t.bytes);
}
#[test]
fn only_stores_explicit_user_font_and_color_overrides() {
    let t = themed(); let d = open(&t.bytes);
    let exported = export(&apply(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| { f.font_family = Some(Some("Verdana".into())); f.color = Some(Some("123456".into())); }) }]));
    let r = open(&exported); let run = &r.paragraphs[0].runs[0];
    assert_eq!((run.style.font_family.as_deref(), run.style.color.as_deref()), (Some("Verdana"), Some("123456")));
    let x = rs(&r, 0, 0); assert_eq!((x.font_family.as_deref(), x.color.as_deref(), x.bold, x.font_size_points), (Some("Verdana"), Some("123456"), Some(true), Some(16.0)));
    let (orig, next) = (read_zip(&t.bytes, DEFAULT_ZIP_LIMITS).unwrap(), read_zip(&exported, DEFAULT_ZIP_LIMITS).unwrap());
    for p in orig.iter().filter(|p| p.name != MAIN) { assert_eq!(next.iter().find(|x| x.name == p.name).unwrap().data, p.data); }
}
#[test]
fn retains_raw_direct_theme_references_until_an_explicit_literal_choice() {
    let d = heading(r#"<w:rFonts w:ascii="Cached" w:asciiTheme="minorAscii" w:hAnsiTheme="minorHAnsi"/><w:color w:val="112233" w:themeColor="accent3"/>"#);
    let id = d.paragraphs[0].runs[0].id.clone();
    assert_eq!((d.paragraphs[0].runs[0].style.font_family.as_deref(), d.paragraphs[0].runs[0].style.color.as_deref()), (Some("Cached"), Some("112233")));
    let r = rs(&d, 0, 0); assert_eq!((r.font_family.as_deref(), r.color.as_deref()), (Some("Arial"), Some("008000")));
    let unrelated = apply(&d, &[Operation::FormatRun { run_id: id.clone(), style: fmt(|f| f.italic = Some(Some(true))) }]);
    let bytes = export(&unrelated); let src = document_xml(&bytes);
    assert!(src.contains(r#"w:asciiTheme="minorAscii""#) && src.contains(r#"w:themeColor="accent3""#));
    let r = rs(&open(&bytes), 0, 0); assert_eq!((r.font_family.as_deref(), r.color.as_deref(), r.italic), (Some("Arial"), Some("008000"), Some(true)));
    let chosen = export(&apply(&unrelated, &[Operation::FormatRun { run_id: id, style: fmt(|f| { f.font_family = Some(Some("Verdana".into())); f.color = Some(Some("123456".into())); }) }]));
    let src = document_xml(&chosen);
    assert!(!src.contains("asciiTheme") && !src.contains(r#"w:themeColor="accent3""#));
    let r = rs(&open(&chosen), 0, 0); assert_eq!((r.font_family.as_deref(), r.color.as_deref(), r.italic), (Some("Verdana"), Some("123456"), Some(true)));
}
#[test]
fn supports_strict_namespaces_at_the_same_arbitrary_paths() {
    let d = variant(&|parts| {
        let names: Vec<String> = parts.iter().filter(|e| e.name.ends_with(".xml") || e.name.ends_with(".rels")).map(|e| e.name.clone()).collect();
        for n in names { rewrite(parts, &n, |x| x.replace(W, "http://purl.oclc.org/ooxml/wordprocessingml/main").replace(R, "http://purl.oclc.org/ooxml/officeDocument/relationships").replace(A, "http://purl.oclc.org/ooxml/drawingml/main")); }
    });
    let a = rs(&d, 0, 0); assert_eq!((a.font_family.as_deref(), a.color.as_deref()), (Some("Georgia"), Some("336699")));
    let b = rs(&d, 1, 0); assert_eq!((b.font_family.as_deref(), b.color.as_deref()), (Some("Arial"), Some("222222")));
}
#[test]
fn applies_character_style_theme_selection_after_paragraph_styles() {
    let r = rs(&heading(r#"<w:rStyle w:val="ThemeAccent"/>"#), 0, 0);
    assert_eq!((r.font_family.as_deref(), r.color.as_deref(), r.font_size_points, r.bold), (Some("Georgia"), Some("008000"), Some(16.0), Some(true)));
}
#[test]
fn uses_layer_pair_replacement_rather_than_stale_lower_values() {
    for (props, font, color) in [(r#"<w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"/><w:color w:val="123456"/>"#, Some("Verdana"), Some("123456")),
        (r#"<w:rFonts w:ascii="Verdana" w:asciiTheme="minorAscii" w:hAnsiTheme="minorHAnsi"/><w:color w:val="123456" w:themeColor="accent3"/>"#, Some("Arial"), Some("008000")),
        (r#"<w:rFonts w:asciiTheme="unknown" w:hAnsiTheme="unknown"/><w:color w:val="123456" w:themeColor="unknown"/>"#, None, None)] {
        let r = rs(&heading(props), 0, 0);
        assert_eq!((r.font_family.as_deref(), r.color.as_deref(), r.bold), (font, color, Some(true)), "{props}");
    }
}
#[test]
fn resolves_ascii_and_high_ansi_slots_independently() {
    assert_eq!(rs(&heading_with(r#"<w:rFonts w:hAnsi="Verdana"/>"#, &heading_text("Résumé")), 0, 0).font_family, None);
    assert_eq!(rs(&heading(r#"<w:rFonts w:hAnsi="Verdana"/>"#), 0, 0).font_family.as_deref(), Some("Georgia"));
}
#[test]
fn applies_settings_mapping_once_per_slot() {
    for slot in ["text1", "dark1", "background1", "light1", "text2", "dark2", "background2", "light2", "accent1", "hyperlink", "followedHyperlink"] {
        let attribute = match slot { "text1" | "dark1" => "t1", "background1" | "light1" => "bg1", "text2" | "dark2" => "t2", "background2" | "light2" => "bg2", s => s };
        let mapping = format!(r#"w:clrSchemeMapping w:{attribute}="accent3" w:accent3="accent4""#);
        let d = heading_with(&format!(r#"<w:color w:themeColor="{slot}"/>"#), &move |parts| { let m = mapping.clone(); rewrite(parts, SETTINGS_PART, |x| x.replacen("/>", &format!("><{m}/></w:settings>"), 1)) });
        assert_eq!(rs(&d, 0, 0).color.as_deref(), Some("008000"), "{slot}");
    }
}
#[test]
fn uses_specification_default_mappings_when_settings_omit_them() {
    for (slot, color) in [("text1", "222222"), ("dark1", "222222"), ("background1", "FFFFFF"), ("light1", "FFFFFF"), ("text2", "444444"), ("dark2", "444444"), ("background2", "EEEEEE"), ("light2", "EEEEEE"), ("hyperlink", "0000FF"), ("followedHyperlink", "800080")] {
        assert_eq!(upper(rs(&heading(&format!(r#"<w:color w:themeColor="{slot}"/>"#)), 0, 0).color).as_deref(), Some(color), "{slot}");
    }
}
#[test]
fn uses_deterministic_hsl_endpoints_and_tint_precedence() {
    for (t, expected) in [(r#"w:themeTint="00""#, "FFFFFF"), (r#"w:themeTint="FF""#, "808080"), (r#"w:themeShade="00""#, "000000"), (r#"w:themeShade="FF""#, "808080"), (r#"w:themeShade="80""#, "404040"), (r#"w:themeTint="80""#, "BFBFBF"), (r#"w:themeShade="00" w:themeTint="FF""#, "808080")] {
        assert_eq!(upper(rs(&heading(&format!(r#"<w:color w:themeColor="accent2" {t}/>"#)), 0, 0).color).as_deref(), Some(expected), "{t}");
    }
}
#[test]
fn does_not_guess_malformed_transforms() {
    for t in [r#"w:themeTint="F""#, r#"w:themeShade="100""#, r#"w:themeTint="GG""#] {
        assert_eq!(rs(&heading(&format!(r#"<w:color w:val="123456" w:themeColor="accent2" {t}/>"#)), 0, 0).color, None, "{t}");
    }
}
#[test]
fn does_not_apply_theme_transforms_to_literal_only_colors() {
    assert_eq!(rs(&heading(r#"<w:color w:val="123456" w:themeTint="00"/>"#), 0, 0).color.as_deref(), Some("123456"));
}
#[test]
fn lets_inherited_theme_pairs_replace_lower_literals() {
    let normal_rpr = |parts: &mut Vec<ZipEntry>| rewrite(parts, STYLES, |x| x.replacen(r#"<w:name w:val="Normal"/>"#, r#"<w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:color w:val="ABCDEF"/></w:rPr>"#, 1));
    let r = rs(&heading_with(r#"<w:rStyle w:val="ThemeAccent"/><w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"/><w:color w:val="123456"/>"#, &normal_rpr), 0, 0);
    assert_eq!((r.font_family.as_deref(), r.color.as_deref()), (Some("Verdana"), Some("123456")));
    let r = rs(&variant(&normal_rpr), 0, 0);
    assert_eq!((r.font_family.as_deref(), r.color.as_deref()), (Some("Georgia"), Some("336699")));
}
#[test]
fn uses_the_high_ansi_slot_for_an_entirely_high_ansi_run() {
    assert_eq!(rs(&heading_with(r#"<w:rFonts w:hAnsi="Verdana"/>"#, &heading_text("éàü")), 0, 0).font_family.as_deref(), Some("Verdana"));
}
#[test]
fn masks_only_the_selected_slot_for_a_higher_unknown_theme() {
    assert_eq!(rs(&heading(r#"<w:rFonts w:ascii="Verdana" w:asciiTheme="unknown"/>"#), 0, 0).font_family, None);
    assert_eq!(rs(&heading_with(r#"<w:rFonts w:ascii="Verdana" w:asciiTheme="unknown"/>"#, &heading_text("éàü")), 0, 0).font_family.as_deref(), Some("Georgia"));
}
#[test]
fn keeps_color_unresolved_for_an_invalid_selected_mapping() {
    let d = variant(&settings_with(r#"w:clrSchemeMapping w:accent1="invalid""#));
    assert_eq!(rs(&d, 0, 0).color, None); assert_eq!(rs(&d, 1, 1).color.as_deref(), Some("cc0000"));
}
#[test]
fn does_not_guess_an_os_color_without_a_valid_last_color() {
    let d = variant(&|parts| rewrite(parts, THEME_PART, |x| x.replace(r#"lastClr="222222""#, r#"lastClr="invalid""#)));
    assert_eq!(rs(&d, 1, 0).color, None); assert_eq!(rs(&d, 0, 0).color.as_deref(), Some("336699"));
}
#[test]
fn uses_defaults_for_absent_settings_without_reading_unrelated_parts() {
    let d = variant(&|parts| { rewrite(parts, RELS, |x| remove_rel(x, "rSettings")); rewrite(parts, SETTINGS_PART, |x| x.replacen("/>", r#"><w:themeFontLang w:val="ja-JP"/><w:clrSchemeMapping w:accent1="accent3"/></w:settings>"#, 1)); });
    let r = rs(&d, 0, 0); assert_eq!((r.font_family.as_deref(), r.color.as_deref()), (Some("Georgia"), Some("336699")));
}
#[test]
fn does_not_guess_fonts_or_colors_for_untrusted_settings() {
    let cases: Vec<Box<dyn Fn(&mut Vec<ZipEntry>)>> = vec![
        Box::new(|p| rewrite(p, RELS, |x| x.replace("</Relationships>", &format!(r#"<Relationship Id="rSettings2" Type="{R}/settings" Target="preferences/theme-settings.xml"/></Relationships>"#)))),
        Box::new(|p| rewrite(p, SETTINGS_PART, |x| x.replace("w:settings ", "w:notSettings "))),
        Box::new(|p| rewrite(p, "[Content_Types].xml", |x| x.replace("application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml", "application/xml"))),
        Box::new(|p| rewrite(p, RELS, |x| x.replace(r#"Target="preferences/theme-settings.xml""#, r#"Target="https://example.test/settings.xml" TargetMode="External""#))),
    ];
    for (i, change) in cases.iter().enumerate() {
        let d = variant(change.as_ref());
        let r = rs(&d, 0, 0); assert_eq!((r.font_family, r.color), (None, None), "case {i}");
        let r = rs(&d, 1, 1); assert_eq!((r.font_family.as_deref(), r.color.as_deref()), (Some("Courier New"), Some("cc0000")));
    }
}
#[test]
fn keeps_supplied_theme_font_lang_selection_unresolved() {
    for language in ["ja-JP", "en-US", "ar-SA"] {
        let inner = format!(r#"w:themeFontLang w:val="{language}""#);
        let d = variant(&move |p| { let i = inner.clone(); rewrite(p, SETTINGS_PART, |x| x.replacen("/>", &format!("><{i}/></w:settings>"), 1)) });
        let r = rs(&d, 0, 0); assert_eq!((r.font_family, r.color.as_deref()), (None, Some("336699")), "{language}");
        assert_eq!(rs(&d, 1, 1).font_family.as_deref(), Some("Courier New"));
    }
}
#[test]
fn does_not_label_unsupported_or_mixed_scripts_as_the_latin_theme_font() {
    for text in ["日本語", "مرحبا", "English 日本語"] {
        let t = text.to_string();
        let d = variant(&move |p| { let t = t.clone(); rewrite(p, MAIN, |x| x.replacen("Themed heading</w:t>", &format!("{t}</w:t>"), 1)) });
        assert_eq!(rs(&d, 0, 0).font_family, None, "{text}");
    }
}
#[test]
fn does_not_claim_a_literal_latin_face_for_script_sensitive_runs() {
    let cases = [("日本語", r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="MS Mincho"/>"#, ""), ("مرحبا", r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Traditional Arabic"/>"#, ""),
        ("Themed heading", r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>"#, "<w:cs/>"), ("Themed heading", r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>"#, "<w:rtl/>"),
        ("Themed heading", r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:hint="eastAsia"/>"#, "")];
    for (text, properties, inherited) in cases {
        let (d, bytes) = heading_package(properties, &move |p| {
            rewrite(p, MAIN, |x| x.replacen("Themed heading</w:t>", &format!("{text}</w:t>"), 1));
            if !inherited.is_empty() { rewrite(p, STYLES, |x| x.replacen("<w:b/>", &format!("{inherited}<w:b/>"), 1)); }
        });
        let run = &d.paragraphs[0].runs[0];
        assert_eq!(run.style.font_family.as_deref(), Some("Georgia"));
        let r = rs(&d, 0, 0); assert_eq!((r.font_family, r.color.as_deref()), (None, Some("336699")), "{properties} {inherited}");
        assert_eq!(export(&d), bytes);
        let reopened = open(&bytes); assert_eq!(export(&reopened), bytes);
        assert_eq!(reopened.paragraphs[0].runs[0].style.font_family.as_deref(), Some("Georgia"));
        assert_eq!(rs(&reopened, 0, 0).font_family, None);
        assert!(document_xml(&bytes).contains(properties));
    }
}
#[test]
fn keeps_an_explicit_latin_literal_supported_under_unresolved_theme_font_lang() {
    let (d, bytes) = heading_package(r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>"#, &settings_with(r#"w:themeFontLang w:val="ja-JP""#));
    assert_eq!(d.paragraphs[0].runs[0].style.font_family.as_deref(), Some("Georgia"));
    let r = rs(&d, 0, 0); assert_eq!((r.font_family.as_deref(), r.color.as_deref()), (Some("Georgia"), Some("336699")));
    assert_eq!(export(&d), bytes); assert_eq!(export(&open(&bytes)), bytes);
}
#[test]
fn does_not_borrow_a_different_font_slot() {
    for (attribute, text) in [("hAnsiTheme", "éàü"), ("asciiTheme", "Themed heading"), ("hAnsiTheme", "Café"), ("asciiTheme", "Café")] {
        let (d, bytes) = package_variant(&move |p| {
            rewrite(p, STYLES, |x| strip_attribute(x, attribute));
            rewrite(p, MAIN, |x| x.replacen("Themed heading</w:t>", &format!("{text}</w:t>"), 1));
        });
        assert_eq!(d.paragraphs[0].runs[0].style, RunStyle::default());
        let r = rs(&d, 0, 0); assert_eq!((r.font_family, r.color.as_deref()), (None, Some("336699")), "{attribute} {text}");
        assert_eq!(export(&d), bytes);
        let reopened = open(&bytes); assert_eq!(rs(&reopened, 0, 0).font_family, None);
    }
}
#[test]
fn keeps_a_mixed_latin_run_unresolved_for_an_unknown_slot_theme() {
    for attribute in ["asciiTheme", "hAnsiTheme"] {
        let (d, bytes) = heading_package(&format!(r#"<w:rFonts w:ascii="Cached" w:hAnsi="Cached" w:{attribute}="unknown"/>"#), &heading_text("Café"));
        assert_eq!(d.paragraphs[0].runs[0].style.font_family.as_deref(), Some("Cached"));
        let r = rs(&d, 0, 0); assert_eq!((r.font_family, r.color.as_deref()), (None, Some("336699")));
        assert_eq!(export(&d), bytes);
    }
}
#[test]
fn does_not_invent_a_heading_theme_font_for_untrusted_themes() {
    let cases: Vec<Box<dyn Fn(&mut Vec<ZipEntry>)>> = vec![
        Box::new(|p| rewrite(p, RELS, |x| remove_rel(x, "rTheme"))),
        Box::new(|p| rewrite(p, RELS, |x| x.replace("</Relationships>", &format!(r#"<Relationship Id="rTheme2" Type="{R}/theme" Target="../assets/themes/editorial.xml"/></Relationships>"#)))),
        Box::new(|p| rewrite(p, THEME_PART, |x| x.replace("a:theme ", "a:notTheme ").replace("</a:theme>", "</a:notTheme>"))),
        Box::new(|p| rewrite(p, "[Content_Types].xml", |x| x.replace(THEME_TYPE, "application/xml"))),
        Box::new(|p| rewrite(p, THEME_PART, |x| x.replace(r#"typeface="Georgia""#, r#"typeface="""#))),
        Box::new(|p| rewrite(p, STYLES, |x| x.replace("majorAscii", "unknown").replace("majorHAnsi", "unknown"))),
    ];
    for (i, change) in cases.iter().enumerate() {
        let d = variant(change.as_ref());
        assert_eq!(rs(&d, 0, 0).font_family, None, "case {i}");
        assert_eq!(rs(&d, 1, 1).font_family.as_deref(), Some("Courier New"));
    }
}
#[test]
fn does_not_use_stale_literal_caches_for_invalid_palettes() {
    let cases: Vec<Box<dyn Fn(&str) -> String>> = vec![
        Box::new(|x| x.replace(r#"val="336699""#, r#"val="NOTRGB""#)),
        Box::new(|x| x.replace(r#"<a:accent1><a:srgbClr val="336699"/></a:accent1>"#, r#"<a:accent1><a:prstClr val="red"/></a:accent1>"#)),
        Box::new(|x| x.replace(r#"<a:srgbClr val="336699"/>"#, r#"<a:srgbClr val="336699"><a:alpha val="50000"/></a:srgbClr>"#)),
        Box::new(|x| x.replace("</a:clrScheme>", r#"<a:accent1><a:srgbClr val="123456"/></a:accent1></a:clrScheme>"#)),
    ];
    for (i, change) in cases.iter().enumerate() {
        let d = variant(&|p| rewrite(p, THEME_PART, |x| change(x)));
        assert_eq!(rs(&d, 0, 0).color, None, "case {i}"); assert_eq!(rs(&d, 1, 1).color.as_deref(), Some("cc0000"));
    }
}
#[test]
fn never_fetches_an_external_theme_and_keeps_the_read_only_diagnostic() {
    let d = variant(&|p| rewrite(p, RELS, |x| x.replace(r#"Target="../assets/themes/editorial.xml""#, r#"Target="https://example.test/theme.xml" TargetMode="External""#)));
    assert!(!d.can_edit); assert!(d.diagnostics.iter().any(|x| x.code == "external-relationship"));
    let r = rs(&d, 0, 0); assert_eq!((r.font_family, r.color), (None, None));
}
#[test]
fn preserves_preflight_rejection_for_a_missing_theme_target() {
    let mut parts = read_zip(&themed().bytes, DEFAULT_ZIP_LIMITS).unwrap();
    rewrite(&mut parts, RELS, |x| x.replace(r#"Target="../assets/themes/editorial.xml""#, r#"Target="../assets/themes/missing.xml""#));
    assert_eq!(open_docx(&write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap(), DEFAULT_ZIP_LIMITS).unwrap_err().code, "invalid-relationships");
}
