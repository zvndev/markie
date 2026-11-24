//! The font registry (`src/lib/fonts/registry.ts`): which typefaces Markie
//! knows, what each is called, what it paints and which files it ships as.
//!
//! - **System**: the nine faces Markie offered before it bundled any font.
//! - **Bundled**: 26 open-licensed families, the same woff2 files Electron
//!   ships (`src/assets/fonts`), embedded in the binary with their licenses.
//!   20 are offered for Markdown documents; 6 stand in for Office fonts that
//!   are not installed and are never offered.
//! - **Local**: a font installed on this computer, stored as
//!   `local:<bundled id>:<family>`, so a style synced from Electron means the
//!   same thing here, and a computer without the font shows the bundled face.
//!
//! `data/fonts.json` is generated from Electron's registry by
//! `rust/scripts/export-styles-fonts.mjs`.

use std::collections::HashSet;
use std::sync::{LazyLock, RwLock};

use regex::Regex;
use serde::Deserialize;

mod files;
pub mod native;

const FONTS_JSON: &str = include_str!("../../data/fonts.json");

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct FontFile {
    /// Path under `src/assets/fonts`.
    pub file: String,
    /// `normal` or `italic`.
    pub style: String,
    /// A CSS font-weight: one value, or the two ends of a variable range.
    pub weight: String,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundledFamily {
    pub id: String,
    pub family: String,
    pub license: String,
    pub license_file: String,
    pub version: String,
    /// `sans`, `serif` or `mono`.
    pub kind: String,
    pub group: String,
    /// `library` (offered for Markdown) or `substitute` (an Office stand-in).
    pub role: String,
    /// Office font names this family stands in for, lower case.
    pub stands_in_for: Vec<String>,
    /// The CSS a document set in this family paints.
    pub stack: String,
    pub files: Vec<FontFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
struct SystemFace {
    id: String,
    label: String,
    stack: String,
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    system: Vec<SystemFace>,
    group_labels: serde_json::Map<String, serde_json::Value>,
    bundled: Vec<BundledFamily>,
}

static REGISTRY: LazyLock<Registry> = LazyLock::new(|| serde_json::from_str(FONTS_JSON).expect("data/fonts.json"));

/// A face a Markdown document can be set in.
#[derive(Clone, Debug, PartialEq)]
pub struct Typeface {
    pub id: String,
    pub label: String,
    /// The CSS stack (an export writes it; the app never parses it).
    pub stack: String,
    pub kind: String,
    /// How a picker groups it: `system`, `sans`, `serif`, `mono`, `rounded`,
    /// `readable`, `display` or `local`.
    pub group: String,
    pub bundled: bool,
    pub local_only: bool,
}

/// `TYPEFACE_GROUP_LABELS`.
pub fn group_label(group: &str) -> &'static str {
    REGISTRY.group_labels.get(group).and_then(|v| v.as_str()).unwrap_or("")
}

/// The picker's group order.
pub const GROUP_ORDER: [&str; 8] = ["system", "sans", "serif", "mono", "rounded", "readable", "display", "local"];

/// Every family that ships with Markie, in picker order.
pub fn bundled_families() -> &'static [BundledFamily] {
    &REGISTRY.bundled
}

pub fn bundled_family(id: &str) -> Option<&'static BundledFamily> {
    REGISTRY.bundled.iter().find(|f| f.id == id)
}

/// The bundled family with exactly this name, whatever the case.
pub fn bundled_family_named(name: &str) -> Option<&'static BundledFamily> {
    let name = name.trim().to_lowercase();
    REGISTRY.bundled.iter().find(|f| f.family.to_lowercase() == name)
}

/// The families offered for Markdown documents.
pub fn library_families() -> impl Iterator<Item = &'static BundledFamily> {
    REGISTRY.bundled.iter().filter(|f| f.role == "library")
}

/// The bundled family that stands in for a document's font when that font is
/// not installed (`substituteFor`).
pub fn substitute_for(font_name: &str) -> Option<&'static BundledFamily> {
    let name = font_name.trim().to_lowercase();
    if name.is_empty() {
        return None;
    }
    REGISTRY.bundled.iter().find(|f| f.stands_in_for.contains(&name))
}

/// The bytes of a bundled file (`inter/Inter.woff2`).
pub fn bundled_file(file: &str) -> Option<&'static [u8]> {
    files::FILES.iter().find(|(name, _)| *name == file).map(|(_, bytes)| *bytes)
}

/// A bundled family's own license text, which ships in every build.
pub fn license_text(id: &str) -> Option<&'static str> {
    files::LICENSES.iter().find(|(name, _)| *name == id).map(|(_, text)| *text)
}

fn system_typeface(f: &SystemFace) -> Typeface {
    Typeface { id: f.id.clone(), label: f.label.clone(), stack: f.stack.clone(), kind: f.kind.clone(), group: "system".into(), bundled: false, local_only: false }
}

fn library_typeface(f: &BundledFamily) -> Typeface {
    Typeface { id: f.id.clone(), label: f.family.clone(), stack: f.stack.clone(), kind: f.kind.clone(), group: f.group.clone(), bundled: true, local_only: false }
}

/// The system faces, then the bundled library: `TYPEFACE_LIST` before any
/// local font is adopted.
pub fn typefaces() -> Vec<Typeface> {
    REGISTRY.system.iter().map(system_typeface).chain(library_families().map(library_typeface)).collect()
}

/// `findTypeface`, with a well-formed local id read as the face it names
/// (Electron adopts those as it meets them).
pub fn find_typeface(id: &str) -> Option<Typeface> {
    if let Some(f) = REGISTRY.system.iter().find(|f| f.id == id) {
        return Some(system_typeface(f));
    }
    if let Some(f) = library_families().find(|f| f.id == id) {
        return Some(library_typeface(f));
    }
    let (family, fallback) = parse_local_typeface_id(id)?;
    Some(Typeface {
        id: id.to_string(),
        label: format!("{family} (only on this computer)"),
        stack: format!("{}, {}", css_family_name(&family), fallback.stack),
        kind: fallback.kind.clone(),
        group: "local".into(),
        bundled: false,
        local_only: true,
    })
}

/// The typefaces fit for code: every monospace one.
pub fn code_typefaces() -> Vec<Typeface> {
    typefaces().into_iter().filter(|f| f.kind == "mono").collect()
}

/// `cleanCodeFont`: a monospace typeface id, or "" for anything else.
pub fn clean_code_font(id: &str) -> String {
    match find_typeface(id) {
        Some(f) if f.kind == "mono" => f.id,
        _ => String::new(),
    }
}

// ── Fonts installed on this computer ────────────────────────────────────────

const LOCAL_PREFIX: &str = "local:";

static LOCAL_FAMILY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9 ._+&-]{0,62}[A-Za-z0-9.+]$|^[A-Za-z0-9]$").unwrap());
static SERIF_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)serif|times|georgia|garamond|palatino|baskerville|bodoni|didot|caslon|cambria|charter|iowan|hoefler|minion|goudy|bookman|century|constantia|rockwell|sabon|plantin|cochin|athelas|new york|book antiqua|perpetua|merriweather|playfair").unwrap()
});
static SANS_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)sans[ -]?serif|sans").unwrap());
static MONO_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)mono|code|courier|consol|menlo|monaco|terminal|typewriter|fixed|andale").unwrap());

/// A guess at a local font's kind from its name (`localFontKind`).
pub fn local_font_kind(family: &str) -> &'static str {
    if MONO_NAME.is_match(family) {
        "mono"
    } else if SANS_NAME.is_match(family) {
        "sans"
    } else if SERIF_NAME.is_match(family) {
        "serif"
    } else {
        "sans"
    }
}

/// The id a local font is stored as: `local:<bundled id>:<family>`. The
/// bundled id is the face shown wherever the font is not installed; a font
/// Markie has a metric-compatible stand-in for names that stand-in.
pub fn local_typeface_id(family: &str) -> Option<String> {
    let name = family.split_whitespace().collect::<Vec<_>>().join(" ");
    if !LOCAL_FAMILY.is_match(&name) {
        return None;
    }
    let fallback = substitute_for(&name).map(|f| f.id.as_str()).unwrap_or(match local_font_kind(family) {
        "serif" => "source-serif",
        "mono" => "jetbrains-mono",
        _ => "inter",
    });
    Some(format!("{LOCAL_PREFIX}{fallback}:{name}"))
}

/// Reads a local id back, or None when it is not exactly one.
pub fn parse_local_typeface_id(id: &str) -> Option<(String, &'static BundledFamily)> {
    if id.len() > 160 {
        return None;
    }
    let rest = id.strip_prefix(LOCAL_PREFIX)?;
    let split = rest.find(':').filter(|i| *i >= 1)?;
    let fallback = bundled_family(&rest[..split])?;
    let family = &rest[split + 1..];
    let double_space = family.as_bytes().windows(2).any(|w| w[0].is_ascii_whitespace() && w[1].is_ascii_whitespace());
    if !LOCAL_FAMILY.is_match(family) || family != family.trim() || double_space {
        return None;
    }
    Some((family.to_string(), fallback))
}

/// A family list as the system reports it, de-duplicated and sorted
/// (`familiesFrom`): (family, kind, id to store or None).
pub fn local_families_from(names: impl IntoIterator<Item = String>) -> Vec<(String, &'static str, Option<String>)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for name in names {
        let family = name.trim().to_string();
        // A leading dot is how macOS names its private system faces. The
        // bundled families are registered for this process only; they are
        // not "installed" and are listed under their own groups.
        let registered = bundled_family_named(&family).is_some() || bundled_families().iter().any(|f| native::native_name(&f.id).as_deref() == Some(family.as_str()));
        if family.is_empty() || family.starts_with('.') || registered || !seen.insert(family.to_lowercase()) {
            continue;
        }
        let kind = local_font_kind(&family);
        let id = local_typeface_id(&family);
        out.push((family, kind, id));
    }
    out.sort_by_key(|a| a.0.to_lowercase());
    out
}

static INSTALLED: RwLock<Option<HashSet<String>>> = RwLock::new(None);

/// Tell the registry which families this computer has (lower-cased inside).
/// The app fills this once from the text system; until then a local font is
/// taken to be present.
pub fn set_installed_families(names: impl IntoIterator<Item = String>) {
    *INSTALLED.write().unwrap() = Some(names.into_iter().map(|n| n.trim().to_lowercase()).collect());
}

/// Whether a family is installed here. None when nobody has listed them.
pub fn is_installed(family: &str) -> Option<bool> {
    INSTALLED.read().unwrap().as_ref().map(|set| set.contains(&family.trim().to_lowercase()))
}

/// The native family a bundled or local typeface id paints with: the bundled
/// family's own name; for a local id the font itself when it is installed
/// here and the bundled face it names otherwise. None for system ids, which
/// the caller maps to macOS's own faces.
pub fn native_family(id: &str) -> Option<String> {
    let bundled = |f: &BundledFamily| native::native_name(&f.id).unwrap_or_else(|| f.family.clone());
    if let Some(f) = bundled_family(id) {
        return Some(bundled(f));
    }
    let (family, fallback) = parse_local_typeface_id(id)?;
    Some(if is_installed(&family) == Some(false) { bundled(fallback) } else { family })
}

// ── Fonts in Word, RTF and OpenDocument files ───────────────────────────────

/// Whether a document's font name is safe to paint at all.
pub fn is_paintable_font_name(name: &str) -> bool {
    !name.trim().is_empty() && name.encode_utf16().count() <= 200 && !name.chars().any(|c| c < '\u{20}' || c == '\u{7f}')
}

/// The families to try, in order, for a font a Word, RTF or OpenDocument file
/// names (`officeFontStack`): the document's own embedded copy if it carries
/// one, then the font by its real name (whatever is installed), and only then
/// the bundled stand-in. The name in the file is never touched.
pub fn office_font_families(font_name: &str, embedded_alias: Option<&str>) -> Vec<String> {
    if !is_paintable_font_name(font_name) {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(alias) = embedded_alias.filter(|a| !a.is_empty()) {
        out.push(alias.to_string());
    }
    out.push(font_name.trim().to_string());
    if let Some(sub) = substitute_for(font_name) {
        out.push(sub.family.clone());
    }
    out
}

/// The first family of [`office_font_families`] this computer can paint: the
/// embedded alias, the real font when installed, else the stand-in, else the
/// name itself (the text system then falls back as it always did).
pub fn office_native_family(font_name: &str, embedded_alias: Option<&str>) -> Option<String> {
    if !is_paintable_font_name(font_name) {
        return None;
    }
    if let Some(alias) = embedded_alias.filter(|a| !a.is_empty()) {
        return Some(alias.to_string());
    }
    let name = font_name.trim();
    if is_installed(name) == Some(false)
        && let Some(sub) = substitute_for(name)
    {
        return Some(native::native_name(&sub.id).unwrap_or_else(|| sub.family.clone()));
    }
    Some(name.to_string())
}

// ── CSS, for exported files ─────────────────────────────────────────────────

/// A font family name as one quoted CSS string (`cssFamilyName`): everything
/// outside letters, digits and spaces is a hex escape.
pub fn css_family_name(name: &str) -> String {
    let mut out = String::from("'");
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == ' ' {
            out.push(c);
        } else {
            out.push_str(&format!("\\{:x} ", c as u32));
        }
    }
    out.push('\'');
    out
}

/// `officeFontStack`: the CSS for [`office_font_families`].
pub fn office_font_stack(font_name: &str, embedded_alias: Option<&str>) -> String {
    office_font_families(font_name, embedded_alias).iter().map(|f| css_family_name(f)).collect::<Vec<_>>().join(", ")
}

/// `fontFaceRules`: the @font-face rules for some families. `url_for` turns a
/// file path into what the page can load; a file it has no URL for is left out.
pub fn font_face_rules(url_for: impl Fn(&str) -> Option<String>, families: &[&BundledFamily]) -> String {
    let mut rules = Vec::new();
    for family in families {
        for file in &family.files {
            let Some(url) = url_for(&file.file) else { continue };
            rules.push(format!(
                "@font-face{{font-family:{};font-style:{};font-weight:{};font-display:swap;src:url({}) format(\"woff2\")}}",
                css_family_name(&family.family),
                file.style,
                file.weight,
                serde_json::to_string(&url).unwrap_or_default()
            ));
        }
    }
    rules.join("\n")
}

/// `bundledFamiliesUsed`: the bundled families some typeface ids and document
/// font names would paint with, in registry order.
pub fn bundled_families_used(typeface_ids: &[&str], font_names: &[&str]) -> Vec<&'static BundledFamily> {
    let mut used: HashSet<&str> = HashSet::new();
    for id in typeface_ids {
        if let Some(f) = bundled_family(id).or_else(|| parse_local_typeface_id(id).map(|(_, f)| f)) {
            used.insert(f.id.as_str());
        }
    }
    for name in font_names {
        if let Some(f) = bundled_family_named(name).or_else(|| substitute_for(name)) {
            used.insert(f.id.as_str());
        }
    }
    REGISTRY.bundled.iter().filter(|f| used.contains(f.id.as_str())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("../../data/markdown-style-golden.json")).unwrap()
    }

    #[test]
    fn the_26_families_ship_with_the_same_bytes_as_electron() {
        let all = bundled_families();
        assert_eq!(all.len(), 26);
        assert_eq!(library_families().count(), 20);
        let mut files = 0;
        for family in all {
            assert!(license_text(&family.id).is_some_and(|t| t.len() > 500), "{} ships its license", family.id);
            for file in &family.files {
                let bytes = bundled_file(&file.file).unwrap_or_else(|| panic!("{} is embedded", file.file));
                assert_eq!(bytes.len(), file.bytes, "{}", file.file);
                let hash: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(hash, file.sha256, "{}", file.file);
                files += 1;
            }
        }
        assert_eq!(files, 54);
        assert_eq!(typefaces().len(), 29);
        assert_eq!(typefaces()[0].id, "system");
        assert_eq!(code_typefaces().iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["mono", "jetbrains-mono", "fira-code", "source-code", "atkinson-mono"]);
    }

    #[test]
    fn local_ids_match_electron() {
        let g = golden();
        for case in g["local"].as_array().unwrap() {
            let family = case["family"].as_str().unwrap();
            assert_eq!(local_font_kind(family), case["kind"].as_str().unwrap(), "{family}");
            assert_eq!(local_typeface_id(family).as_deref(), case["id"].as_str(), "{family}");
        }
        for case in g["localParse"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let got = parse_local_typeface_id(id);
            assert_eq!(got.as_ref().map(|(f, _)| f.as_str()), case["family"].as_str(), "{id}");
            assert_eq!(got.as_ref().map(|(_, f)| f.id.as_str()), case["fallback"].as_str(), "{id}");
        }
        let face = find_typeface("local:inter:Futura").unwrap();
        assert_eq!(face.label, "Futura (only on this computer)");
        assert!(face.local_only && face.group == "local");
        assert!(find_typeface("carlito").is_none(), "a stand-in is never offered");
    }

    #[test]
    fn office_fonts_take_the_stand_in_only_when_the_real_one_is_missing() {
        let g = golden();
        for case in g["office"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert_eq!(office_font_stack(name, None), case["stack"].as_str().unwrap(), "{name:?}");
            assert_eq!(office_font_stack(name, Some("markie-doc-1")), case["aliased"].as_str().unwrap(), "{name:?}");
            assert_eq!(substitute_for(name).map(|f| f.id.as_str()), case["substitute"].as_str(), "{name:?}");
        }
        assert_eq!(office_font_families("Calibri", Some("emb")), ["emb", "Calibri", "Carlito"]);
        // What this computer paints with: the real font when it is here, the
        // stand-in when it is not, and a document's own embedded copy first.
        set_installed_families(["Georgia".to_string()]);
        assert_eq!(office_native_family("Georgia", None).as_deref(), Some("Georgia"));
        assert_eq!(office_native_family("Cambria", None).as_deref(), Some("Caladea"));
        assert_eq!(office_native_family("Brand Sans", None).as_deref(), Some("Brand Sans"), "no stand-in: the name itself");
        // A document's own embedded copy comes first, under its private name.
        assert_eq!(office_native_family("Cambria", Some("Markie Doc 1 Cambria")).as_deref(), Some("Markie Doc 1 Cambria"));
        assert_eq!(office_native_family("x\u{1}", None), None);
    }

    #[test]
    fn local_listing_skips_private_and_bundled_names() {
        let got = local_families_from(["Zapfino", ".SF NS", "Inter", "futura", "Futura", "Bad;Name"].map(String::from));
        let names: Vec<_> = got.iter().map(|f| f.0.as_str()).collect();
        assert_eq!(names, ["Bad;Name", "futura", "Zapfino"]);
        assert_eq!(got[0].2, None);
        assert_eq!(got[1].2.as_deref(), Some("local:inter:futura"));
    }

    #[test]
    fn exported_font_faces_match_electron() {
        let inter = bundled_family("inter").unwrap();
        let rules = font_face_rules(|f| Some(format!("u/{f}")), &[inter]);
        assert_eq!(
            rules.lines().next().unwrap(),
            "@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url(\"u/inter/Inter.woff2\") format(\"woff2\")}"
        );
        let used = bundled_families_used(&["inter", "local:carlito:Calibri", "system"], &["Georgia", "Lora"]);
        assert_eq!(used.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["inter", "lora", "carlito", "gelasio"]);
    }
}
