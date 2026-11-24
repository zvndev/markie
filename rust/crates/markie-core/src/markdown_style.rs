//! Markdown styles (`src/lib/markdown-style.ts` and
//! `markdown-style-schema.ts`): how a document's Markdown is drawn, apart from
//! its colours and faces. A style is a preset plus what was changed on top of
//! it. This module holds the schema, the six presets, the transitions the
//! editor makes on the account's store, and the stylesheet an export writes.
//!
//! A style travels: it syncs with the account, and an owner can pin it to a
//! document. So a stored style is somebody else's data. It is never CSS: a
//! preset id, option ids from closed lists, and numbers held in ranges.
//! Anything else is dropped by [`sanitize`], and every reader goes through it.
//!
//! The lists, presets, labels and CSS rules are `data/markdown-style.json`,
//! generated from the Electron sources by `rust/scripts/export-styles-fonts.mjs`,
//! so the two apps cannot drift. The tests hold every function here to what
//! Electron's own functions answer (`data/markdown-style-golden.json`).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fonts;

const SCHEMA_JSON: &str = include_str!("../data/markdown-style.json");

#[derive(Debug, Deserialize)]
pub struct ChoiceDef {
    pub key: String,
    /// The option ids; the first is what Spacious uses.
    pub options: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct NumberDef {
    pub key: String,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub default: f64,
}

#[derive(Debug, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    /// One line under the name on its card.
    pub description: String,
    pub choices: BTreeMap<String, String>,
    pub numbers: BTreeMap<String, f64>,
}

/// One element of a document, as the editor lists it.
#[derive(Debug, Deserialize)]
pub struct Group {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub choices: Vec<String>,
    pub numbers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChoiceLabel {
    pub label: String,
    pub options: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct Limits {
    profiles: usize,
    name: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Schema {
    preset_ids: Vec<String>,
    choices: Vec<ChoiceDef>,
    numbers: Vec<NumberDef>,
    limits: Limits,
    presets: Vec<Preset>,
    groups: Vec<Group>,
    choice_labels: BTreeMap<String, ChoiceLabel>,
    number_labels: BTreeMap<String, String>,
    choice_order: Vec<String>,
    paren_counter: String,
    rules: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

static SCHEMA: LazyLock<Schema> = LazyLock::new(|| serde_json::from_str(SCHEMA_JSON).expect("data/markdown-style.json"));

pub const FONT_KEYS: [&str; 3] = ["bodyFont", "headingFont", "codeFont"];

/// `MARKDOWN_STYLE_PRESETS`: Spacious first.
pub fn presets() -> &'static [Preset] {
    &SCHEMA.presets
}

pub fn find_preset(id: &str) -> Option<&'static Preset> {
    SCHEMA.presets.iter().find(|p| p.id == id)
}

/// `MARKDOWN_STYLE_CHOICES`, in schema order.
pub fn choices() -> &'static [ChoiceDef] {
    &SCHEMA.choices
}

pub fn choice_options(key: &str) -> &'static [String] {
    SCHEMA.choices.iter().find(|c| c.key == key).map(|c| c.options.as_slice()).unwrap_or(&[])
}

/// `MARKDOWN_STYLE_NUMBERS`, in schema order.
pub fn numbers() -> &'static [NumberDef] {
    &SCHEMA.numbers
}

pub fn number_def(key: &str) -> Option<&'static NumberDef> {
    SCHEMA.numbers.iter().find(|n| n.key == key)
}

/// `MARKDOWN_STYLE_GROUPS`: the elements, in the order the editor lists them.
pub fn groups() -> &'static [Group] {
    &SCHEMA.groups
}

/// A choice's label ("Borders") and an option's ("Row lines").
pub fn choice_label(key: &str) -> &'static str {
    SCHEMA.choice_labels.get(key).map(|l| l.label.as_str()).unwrap_or("")
}

/// An option's label. A typeface is named as the font registry names it.
pub fn option_label(key: &str, option: &str) -> String {
    if let Some(l) = SCHEMA.choice_labels.get(key).and_then(|l| l.options.get(option)) {
        return l.clone();
    }
    fonts::find_typeface(option).map(|f| f.label).unwrap_or_else(|| option.to_string())
}

pub fn number_label(key: &str) -> &'static str {
    SCHEMA.number_labels.get(key).map(String::as_str).unwrap_or("")
}

/// `MARKDOWN_STYLE_NUMBER_LABELS[key].format`.
pub fn format_number(key: &str, value: f64) -> String {
    match key {
        "listIndent" | "listItemGap" => {
            let s = if value.fract() == 0.0 { format!("{value:.0}") } else { format!("{value:.2}") };
            let s = s.strip_suffix('0').unwrap_or(&s).to_string();
            format!("{s} em")
        }
        "imageRadius" => format!("{} px", js_round(value) as i64),
        _ => format!("{value:.2}×"),
    }
}

/// JavaScript's `Math.round`: halves go up.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

fn round3(v: f64) -> f64 {
    js_round(v * 1000.0) / 1000.0
}

// ── The stored shapes ───────────────────────────────────────────────────────

/// A style as it is stored: a preset and what was changed on top of it. A
/// choice or number that is absent is the preset's own.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarkdownStyle {
    pub base: String,
    /// What its maker called it. Never used for anything but showing it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub choices: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty", serialize_with = "numbers_as_js")]
    pub numbers: BTreeMap<String, f64>,
}

/// A whole number is written as JavaScript writes it (`8`, not `8.0`), so a
/// style saved here is the same JSON Electron would have sent.
fn js_number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 1e15 { Value::from(v as i64) } else { Value::from(v) }
}

fn numbers_as_js<S: serde::Serializer>(numbers: &BTreeMap<String, f64>, s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut map = s.serialize_map(Some(numbers.len()))?;
    for (k, v) in numbers {
        map.serialize_entry(k, &js_number(*v))?;
    }
    map.end()
}

impl Default for MarkdownStyle {
    /// `DEFAULT_MARKDOWN_STYLE`.
    fn default() -> Self {
        Self::preset("spacious")
    }
}

impl MarkdownStyle {
    pub fn preset(id: &str) -> Self {
        Self { base: id.to_string(), name: None, choices: BTreeMap::new(), numbers: BTreeMap::new() }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

impl<'de> Deserialize<'de> for MarkdownStyle {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Value::deserialize(d)?;
        sanitize(&raw).ok_or_else(|| serde::de::Error::custom("not a Markdown style"))
    }
}

/// A style somebody saved under a name.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub style: MarkdownStyle,
}

/// The account's styles: the saved profiles, which one is in use, and edits
/// not yet saved. It rides inside the theme store (`ThemeStore.markdownStyle`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleStore {
    /// A preset id or a profile id.
    pub active_id: String,
    pub profiles: Vec<Profile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<MarkdownStyle>,
}

impl Default for StyleStore {
    /// `EMPTY_MARKDOWN_STYLE_STORE`.
    fn default() -> Self {
        Self { active_id: "spacious".into(), profiles: Vec::new(), draft: None }
    }
}

fn is_preset_id(id: &str) -> bool {
    SCHEMA.preset_ids.iter().any(|p| p == id)
}

/// `PROFILE_ID`: `^[a-z0-9][a-z0-9-]{0,47}$`.
fn profile_id_shape(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 48
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `isMarkdownStyleProfileId`: could be a profile's id. Preset ids are not.
pub fn is_profile_id(id: &str) -> bool {
    profile_id_shape(id) && !is_preset_id(id)
}

/// `cleanMarkdownStyleName`: one line, printable, short.
pub fn clean_name(value: &str, fallback: &str) -> String {
    let mut text = String::new();
    let mut gap = false;
    for c in value.chars() {
        let space = c.is_whitespace() || c < '\u{20}' || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}' || c == '\u{feff}';
        if space {
            gap = true;
        } else {
            if gap && !text.is_empty() {
                text.push(' ');
            }
            gap = false;
            text.push(c);
        }
    }
    let cut: String = text.chars().take(SCHEMA.limits.name).collect();
    let cut = cut.trim();
    if cut.is_empty() { fallback.to_string() } else { cut.to_string() }
}

fn clean_name_value(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(s) => clean_name(s, fallback),
        None => fallback.to_string(),
    }
}

/// `sanitizeMarkdownStyle`: the style in `raw`, holding only what the lists
/// allow. None when `raw` is not a style at all. An unknown preset reads as
/// Spacious; an unknown choice or option and a number that is not a number
/// are dropped; a number out of range moves to the nearest end of it.
pub fn sanitize(raw: &Value) -> Option<MarkdownStyle> {
    let raw = raw.as_object()?;
    let base = raw.get("base").and_then(Value::as_str).filter(|b| is_preset_id(b)).unwrap_or("spacious");
    let mut style = MarkdownStyle::preset(base);
    let name = clean_name_value(raw.get("name"), "");
    if !name.is_empty() {
        style.name = Some(name);
    }
    if let Some(choices) = raw.get("choices").and_then(Value::as_object) {
        for def in &SCHEMA.choices {
            if let Some(v) = choices.get(&def.key).and_then(Value::as_str)
                && def.options.iter().any(|o| o == v)
            {
                style.choices.insert(def.key.clone(), v.to_string());
            }
        }
    }
    if let Some(numbers) = raw.get("numbers").and_then(Value::as_object) {
        for def in &SCHEMA.numbers {
            if let Some(v) = numbers.get(&def.key).filter(|v| v.is_number()).and_then(Value::as_f64).filter(|v| v.is_finite()) {
                style.numbers.insert(def.key.clone(), round3(v.clamp(def.min, def.max)));
            }
        }
    }
    Some(style)
}

/// `sanitizeMarkdownStyleStore`: profiles with a bad or repeated id are
/// dropped, the list is cut at the limit, and an active id that names nothing
/// reads as Spacious.
pub fn sanitize_store(raw: &Value) -> Option<StyleStore> {
    let raw = raw.as_object()?;
    let mut profiles: Vec<Profile> = Vec::new();
    let mut seen: Vec<String> = SCHEMA.preset_ids.clone();
    if let Some(list) = raw.get("profiles").and_then(Value::as_array) {
        for entry in list {
            if profiles.len() >= SCHEMA.limits.profiles {
                break;
            }
            let Some(entry) = entry.as_object() else { continue };
            let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
            let Some(style) = entry.get("style").and_then(sanitize) else { continue };
            if !profile_id_shape(id) || seen.iter().any(|s| s == id) {
                continue;
            }
            seen.push(id.to_string());
            let name = clean_name_value(entry.get("name"), "Untitled style");
            profiles.push(Profile { id: id.to_string(), name: name.clone(), style: MarkdownStyle { name: Some(name), ..style } });
        }
    }
    let active_id = raw.get("activeId").and_then(Value::as_str).filter(|id| seen.iter().any(|s| s == id)).unwrap_or("spacious").to_string();
    Some(StyleStore { active_id, profiles, draft: raw.get("draft").and_then(sanitize) })
}

// ── Resolving ───────────────────────────────────────────────────────────────

/// A style with every choice and number filled in.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub base: String,
    choices: BTreeMap<String, String>,
    numbers: BTreeMap<String, f64>,
}

impl Default for Resolved {
    fn default() -> Self {
        resolve(&MarkdownStyle::default())
    }
}

impl Resolved {
    /// The option chosen for `key` ("" for a key the schema does not have).
    pub fn choice(&self, key: &str) -> &str {
        self.choices.get(key).map(String::as_str).unwrap_or("")
    }

    pub fn number(&self, key: &str) -> f64 {
        self.numbers.get(key).copied().unwrap_or(0.0)
    }

    /// Whether this draws exactly what Spacious draws, typefaces aside.
    pub fn is_spacious_drawing(&self) -> bool {
        let spacious = preset_values("spacious");
        SCHEMA.choices.iter().filter(|c| !FONT_KEYS.contains(&c.key.as_str())).all(|c| self.choice(&c.key) == spacious.choice(&c.key))
            && SCHEMA.numbers.iter().all(|n| self.number(&n.key) == spacious.number(&n.key))
    }

    pub fn to_value(&self) -> Value {
        let numbers: serde_json::Map<String, Value> = self.numbers.iter().map(|(k, v)| (k.clone(), js_number(*v))).collect();
        serde_json::json!({ "base": self.base, "choices": self.choices, "numbers": numbers })
    }
}

/// What a preset draws, in full (`presetValues`).
fn preset_values(id: &str) -> Resolved {
    let preset = find_preset(id).unwrap_or(&SCHEMA.presets[0]);
    Resolved {
        base: preset.id.clone(),
        choices: SCHEMA.choices.iter().map(|c| (c.key.clone(), preset.choices.get(&c.key).cloned().unwrap_or_else(|| c.options[0].clone()))).collect(),
        numbers: SCHEMA.numbers.iter().map(|n| (n.key.clone(), preset.numbers.get(&n.key).copied().unwrap_or(n.default))).collect(),
    }
}

/// `resolveMarkdownStyle` for a style that is already clean.
pub fn resolve(style: &MarkdownStyle) -> Resolved {
    let mut r = preset_values(&style.base);
    for (k, v) in &style.choices {
        r.choices.insert(k.clone(), v.clone());
    }
    for (k, v) in &style.numbers {
        r.numbers.insert(k.clone(), *v);
    }
    r
}

/// `resolveMarkdownStyle`: any value at all, read as a style.
pub fn resolve_value(raw: &Value) -> Resolved {
    resolve(&sanitize(raw).unwrap_or_default())
}

/// `canonicalMarkdownStyle`: the one stored form, holding only what differs
/// from its preset.
pub fn canonical(style: &MarkdownStyle) -> MarkdownStyle {
    // Through the cleaner, so a style built in code is held to the lists too.
    let style = sanitize(&style.to_value()).unwrap_or_default();
    let preset = preset_values(&style.base);
    MarkdownStyle {
        base: style.base.clone(),
        name: style.name.clone(),
        choices: style.choices.iter().filter(|(k, v)| preset.choice(k) != v.as_str()).map(|(k, v)| (k.clone(), v.clone())).collect(),
        numbers: style.numbers.iter().filter(|(k, v)| preset.number(k) != **v).map(|(k, v)| (k.clone(), *v)).collect(),
    }
}

/// `sameMarkdownStyle`: both draw the same thing. Names do not count.
pub fn same(a: &MarkdownStyle, b: &MarkdownStyle) -> bool {
    let (a, b) = (resolve(a), resolve(b));
    a.choices == b.choices && a.numbers == b.numbers
}

// ── CSS (for an exported file) ──────────────────────────────────────────────

/// A number as CSS prints it: at most three decimals, never NaN (`num`).
fn num(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    let v = round3(value);
    if v == 0.0 { "0".into() } else { format!("{v}") }
}

/// Spacious's own heading margins, in em of each heading (`HEADING_SPACE`).
const HEADING_SPACE: [(&str, f64, f64); 5] = [("& h1", 1.5, 0.6), ("& h2", 1.4, 0.5), ("& h3", 1.3, 0.4), ("& h4", 1.2, 0.4), ("& h5, & h6", 1.0, 0.3)];

fn number_rules(n: &Resolved) -> Vec<(String, String)> {
    let d = |key: &str| number_def(key).map(|d| d.default).unwrap_or(0.0);
    let mut rules: Vec<(String, String)> = Vec::new();
    let mut push = |s: &str, decl: String| rules.push((s.to_string(), decl));
    let leading = n.number("leading");
    if leading != d("leading") {
        push("&", format!("line-height: calc(var(--doc-line-height, 1.75) * {})", num(leading)));
    }
    let g = n.number("blockGap");
    if g != d("blockGap") {
        push("& p", format!("margin-top: calc(var(--doc-paragraph-gap, 0.8em) * {0}); margin-bottom: calc(var(--doc-paragraph-gap, 0.8em) * {0})", num(g)));
        push("& blockquote, & pre, & table, & img", format!("margin-top: {0}em; margin-bottom: {0}em", num(g)));
        push("& ul, & ol", format!("margin-top: {0}em; margin-bottom: {0}em", num(0.6 * g)));
        push("& hr", format!("margin-top: {0}em; margin-bottom: {0}em", num(2.0 * g)));
        push("& blockquote p", "margin-top: 0.3em; margin-bottom: 0.3em".into());
    }
    let above = n.number("headingSpaceAbove");
    if above != d("headingSpaceAbove") {
        for (selector, a, _) in HEADING_SPACE {
            push(selector, format!("margin-top: {}em", num(a * above)));
        }
        push("& h1:first-child", "margin-top: 0".into());
    }
    let below = n.number("headingSpaceBelow");
    if below != d("headingSpaceBelow") {
        for (selector, _, b) in HEADING_SPACE {
            push(selector, format!("margin-bottom: {}em", num(b * below)));
        }
    }
    let indent = n.number("listIndent");
    if indent != d("listIndent") {
        push("& ul:not([data-type=\"taskList\"]), & ol", format!("padding-left: {}em", num(indent)));
        push("& .task-list-item", format!("margin-left: {}em", num(-(indent - 0.3))));
    }
    let item = n.number("listItemGap");
    if item != d("listItemGap") {
        push("& li", format!("margin-top: {0}em; margin-bottom: {0}em", num(item)));
    }
    let radius = n.number("imageRadius");
    if radius != d("imageRadius") {
        push("& img", format!("border-radius: {}px", num(radius)));
    }
    rules
}

/// `markdownStyleCss`: the stylesheet that turns Spacious into `style`, for
/// documents matching `scope`. Empty for Spacious. `scope` is a selector
/// written in code (`.markdown-body` for an exported page).
pub fn css(style: &Resolved, scope: &str) -> String {
    let mut lines: Vec<String> = number_rules(style).into_iter().map(|(s, d)| format!("{s} {{ {d}; }}")).collect();
    for key in &SCHEMA.choice_order {
        if let Some(rules) = SCHEMA.rules.get(key).and_then(|t| t.get(style.choice(key))) {
            lines.extend(rules.iter().cloned());
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    if style.choice("orderedStyle") == "paren" {
        lines.insert(0, SCHEMA.paren_counter.clone());
    }
    lines.join("\n").replace('&', scope)
}

/// `MARKDOWN_STYLE_APP_SCOPE`.
pub const APP_SCOPE: &str = ".markdown-body:not([data-md-style] .markdown-body)";

// ── Typefaces ───────────────────────────────────────────────────────────────

/// The theme tokens a style's typefaces stand for. A face left to the
/// template is absent (`markdownStyleFontTokens`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FontTokens {
    pub body_font: Option<String>,
    pub heading_font: Option<String>,
    pub code_font: Option<String>,
}

impl FontTokens {
    pub fn is_empty(&self) -> bool {
        self.body_font.is_none() && self.heading_font.is_none() && self.code_font.is_none()
    }

    fn get(&self, key: &str) -> Option<&str> {
        match key {
            "bodyFont" => self.body_font.as_deref(),
            "headingFont" => self.heading_font.as_deref(),
            _ => self.code_font.as_deref(),
        }
    }
}

pub fn font_tokens(style: &MarkdownStyle) -> FontTokens {
    let r = resolve(style);
    let pick = |key: &str| Some(r.choice(key)).filter(|v| *v != "theme").map(str::to_string);
    FontTokens { body_font: pick("bodyFont"), heading_font: pick("headingFont"), code_font: pick("codeFont") }
}

/// `styleFontId`: the id a typeface is stored under in a style: itself when
/// the lists know it, the bundled face it names when it is a font from one
/// computer, and None for anything else.
pub fn style_font_id(key: &str, id: &str) -> Option<String> {
    if id == "theme" {
        return None;
    }
    let allowed = choice_options(key);
    if allowed.iter().any(|o| o == id) {
        return Some(id.to_string());
    }
    let fallback = fonts::parse_local_typeface_id(id)?.1.id.clone();
    allowed.iter().any(|o| *o == fallback).then_some(fallback)
}

/// `withPaintedFonts`: `style` with the typefaces that are really being
/// painted written into it, which is what a pinned look carries.
pub fn with_painted_fonts(style: &MarkdownStyle, painted: &FontTokens) -> MarkdownStyle {
    let mut base = canonical(style);
    for key in FONT_KEYS {
        match painted.get(key).and_then(|id| style_font_id(key, id)) {
            Some(id) => {
                base.choices.insert(key.to_string(), id);
            }
            None => {
                base.choices.remove(key);
            }
        }
    }
    canonical(&base)
}

// ── The account's store ─────────────────────────────────────────────────────

impl StyleStore {
    /// `savedMarkdownStyle`: what the active id names, before unsaved edits.
    pub fn saved(&self) -> MarkdownStyle {
        if let Some(p) = self.profiles.iter().find(|p| p.id == self.active_id) {
            return canonical(&MarkdownStyle { name: Some(p.name.clone()), ..p.style.clone() });
        }
        let preset = find_preset(&self.active_id).unwrap_or(&SCHEMA.presets[0]);
        MarkdownStyle { name: Some(preset.name.clone()), ..MarkdownStyle::preset(&preset.id) }
    }

    /// `markdownStyleEdited`: there are edits on top of the active style.
    pub fn edited(&self) -> bool {
        self.draft.as_ref().is_some_and(|d| !same(d, &self.saved()))
    }

    /// `activeMarkdownStyle`: the style being drawn.
    pub fn active(&self) -> MarkdownStyle {
        let saved = self.saved();
        if !self.edited() {
            return saved;
        }
        let draft = canonical(self.draft.as_ref().expect("edited"));
        MarkdownStyle { name: Some(format!("{} (edited)", saved.name.unwrap_or_default())), ..draft }
    }

    /// "Spacious", "My notes", or "Spacious (edited)".
    pub fn active_name(&self) -> String {
        self.active().name.unwrap_or_else(|| "Spacious".into())
    }

    fn bare(&self) -> Self {
        Self { active_id: self.active_id.clone(), profiles: self.profiles.clone(), draft: None }
    }

    /// `chooseMarkdownStyle`.
    pub fn choose(&self, id: &str) -> Self {
        if is_preset_id(id) || self.profiles.iter().any(|p| p.id == id) {
            Self { active_id: id.to_string(), profiles: self.profiles.clone(), draft: None }
        } else {
            self.clone()
        }
    }

    fn with_draft(&self, draft: MarkdownStyle) -> Self {
        let mut next = self.bare();
        let clean = canonical(&MarkdownStyle { name: None, ..draft });
        if !same(&clean, &next.saved()) {
            next.draft = Some(clean);
        }
        next
    }

    /// `editMarkdownStyle`: change some choices or numbers of the style being
    /// drawn. The result is an unsaved edit.
    pub fn edit(&self, choices: &[(&str, &str)], numbers: &[(&str, f64)]) -> Self {
        let mut current = self.active();
        for (k, v) in choices {
            current.choices.insert(k.to_string(), v.to_string());
        }
        for (k, v) in numbers {
            current.numbers.insert(k.to_string(), *v);
        }
        self.with_draft(current)
    }

    /// `markdownStyleGroupChanged` for the style being drawn.
    pub fn group_changed(&self, group: &Group) -> bool {
        let c = canonical(&self.active());
        group.choices.iter().any(|k| c.choices.contains_key(k)) || group.numbers.iter().any(|k| c.numbers.contains_key(k))
    }

    /// `resetMarkdownStyleGroup`: put one element back to its preset's.
    pub fn reset_group(&self, group: &Group) -> Self {
        let mut current = canonical(&self.active());
        for k in &group.choices {
            current.choices.remove(k);
        }
        for k in &group.numbers {
            current.numbers.remove(k);
        }
        self.with_draft(current)
    }

    /// `discardMarkdownStyleDraft`.
    pub fn discard_draft(&self) -> Self {
        self.bare()
    }

    fn unique_name(&self, wanted: &str, except: Option<&str>) -> String {
        let taken: Vec<String> = SCHEMA
            .presets
            .iter()
            .map(|p| p.name.to_lowercase())
            .chain(self.profiles.iter().filter(|p| Some(p.id.as_str()) != except).map(|p| p.name.to_lowercase()))
            .collect();
        let base = clean_name(wanted, "My style");
        if !taken.contains(&base.to_lowercase()) {
            return base;
        }
        let mut n = 2;
        loop {
            let candidate = clean_name(&format!("{base} {n}"), &base);
            if !taken.contains(&candidate.to_lowercase()) {
                return candidate;
            }
            n += 1;
        }
    }

    /// `saveMarkdownStyleAs`: save the style being drawn as a new named
    /// profile, and make it the active one.
    pub fn save_as(&self, name: &str, id: &str) -> Self {
        if !is_profile_id(id) || self.profiles.iter().any(|p| p.id == id) {
            return self.clone();
        }
        let name = self.unique_name(name, None);
        let style = canonical(&MarkdownStyle { name: Some(name.clone()), ..self.active() });
        let mut profiles = self.profiles.clone();
        profiles.push(Profile { id: id.to_string(), name, style });
        Self { active_id: id.to_string(), profiles, draft: None }
    }

    /// Whether the active style is a saved profile (a preset cannot be overwritten).
    pub fn active_is_profile(&self) -> bool {
        self.profiles.iter().any(|p| p.id == self.active_id)
    }

    /// `saveMarkdownStyleEdits`: write the unsaved edits into the active profile.
    pub fn save_edits(&self) -> Self {
        let Some(profile) = self.profiles.iter().find(|p| p.id == self.active_id) else { return self.clone() };
        if !self.edited() {
            return self.clone();
        }
        let style = canonical(&MarkdownStyle { name: Some(profile.name.clone()), ..self.draft.clone().expect("edited") });
        let id = profile.id.clone();
        let profiles = self.profiles.iter().map(|p| if p.id == id { Profile { style: style.clone(), ..p.clone() } } else { p.clone() }).collect();
        Self { active_id: self.active_id.clone(), profiles, draft: None }
    }

    /// `duplicateMarkdownStyle`: a copy of a preset or a profile, as a new
    /// profile. It does not become active.
    pub fn duplicate(&self, source_id: &str, id: &str) -> Self {
        if !is_profile_id(id) || self.profiles.iter().any(|p| p.id == id) {
            return self.clone();
        }
        let (source_name, source) = match (self.profiles.iter().find(|p| p.id == source_id), find_preset(source_id)) {
            (Some(p), _) => (p.name.clone(), p.style.clone()),
            (None, Some(preset)) => (preset.name.clone(), MarkdownStyle::preset(&preset.id)),
            (None, None) => return self.clone(),
        };
        let name = self.unique_name(&format!("{source_name} copy"), None);
        let style = canonical(&MarkdownStyle { name: Some(name.clone()), ..source });
        let mut next = self.clone();
        next.profiles.push(Profile { id: id.to_string(), name, style });
        next
    }

    /// `renameMarkdownStyle`.
    pub fn rename(&self, id: &str, name: &str) -> Self {
        if !self.profiles.iter().any(|p| p.id == id) {
            return self.clone();
        }
        let name = self.unique_name(name, Some(id));
        let mut next = self.clone();
        for p in next.profiles.iter_mut().filter(|p| p.id == id) {
            p.name = name.clone();
            p.style.name = Some(name.clone());
        }
        next
    }

    /// `deleteMarkdownStyle`: if it was the active one, the preset it was
    /// built on takes over.
    pub fn delete(&self, id: &str) -> Self {
        let Some(profile) = self.profiles.iter().find(|p| p.id == id) else { return self.clone() };
        let profiles: Vec<Profile> = self.profiles.iter().filter(|p| p.id != id).cloned().collect();
        if self.active_id != id {
            return Self { profiles, ..self.clone() };
        }
        Self { active_id: profile.style.base.clone(), profiles, draft: None }
    }

    /// `pinnableMarkdownStyle`: the style a document is pinned with.
    pub fn pinnable(&self) -> MarkdownStyle {
        canonical(&self.active())
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `newMarkdownStyleProfileId`. `seed` is the time in milliseconds.
pub fn new_profile_id(taken: &[String], seed: u64) -> String {
    let stem = format!("style-{}", base36(seed));
    let mut id = stem.clone();
    let mut n = 2;
    while taken.contains(&id) || !is_profile_id(&id) {
        id = format!("{stem}-{n}");
        n += 1;
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../data/markdown-style-golden.json")).unwrap()
    }

    #[test]
    fn six_presets_with_electrons_choices_numbers_and_pairings() {
        let ids: Vec<_> = presets().iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["spacious", "compact", "classic", "technical", "editorial", "minimal"]);
        assert!(presets()[0].choices.is_empty() && presets()[0].numbers.is_empty(), "Spacious is unchanged: it names nothing");
        let pair = |id: &str| {
            let p = find_preset(id).unwrap();
            (p.choices["bodyFont"].as_str(), p.choices["headingFont"].as_str(), p.choices["codeFont"].as_str())
        };
        assert_eq!(pair("compact"), ("source-sans", "body", "source-code"));
        assert_eq!(pair("classic"), ("literata", "eb-garamond", "source-code"));
        assert_eq!(pair("technical"), ("plex-sans", "body", "jetbrains-mono"));
        assert_eq!(pair("editorial"), ("source-serif", "playfair", "fira-code"));
        assert_eq!(pair("minimal"), ("atkinson-mono", "body", "atkinson-mono"));
        assert_eq!(find_preset("compact").unwrap().numbers["leading"], 0.86);
        assert_eq!(groups().len(), 13);
        assert_eq!(option_label("tableStyle", "lines"), "Row lines");
        assert_eq!(option_label("bodyFont", "theme"), "Template's font");
        assert_eq!(option_label("headingFont", "body"), "Same as text");
        assert_eq!(option_label("bodyFont", "plex-sans"), "IBM Plex Sans");
        // The schema's face lists are the registry's.
        for id in choice_options("bodyFont").iter().filter(|o| *o != "theme") {
            assert!(fonts::find_typeface(id).is_some(), "{id}");
        }
    }

    #[test]
    fn every_style_reads_resolves_and_writes_css_as_electron_does() {
        for case in golden()["styles"].as_array().unwrap() {
            let raw = &case["raw"];
            let clean = sanitize(raw);
            assert_eq!(clean.as_ref().map(MarkdownStyle::to_value).unwrap_or(Value::Null), case["sanitized"], "sanitize {raw}");
            let style = clean.unwrap_or_default();
            assert_eq!(canonical(&style).to_value(), case["canonical"], "canonical {raw}");
            assert_eq!(resolve_value(raw).to_value(), case["resolved"], "resolve {raw}");
            assert_eq!(css(&resolve(&style), ".markdown-body"), case["css"].as_str().unwrap(), "css {raw}");
            assert_eq!(css(&resolve(&style), APP_SCOPE), case["appCss"].as_str().unwrap(), "app css {raw}");
            let tokens = font_tokens(&style);
            let want = &case["fontTokens"];
            assert_eq!(tokens.body_font.as_deref(), want["bodyFont"].as_str(), "{raw}");
            assert_eq!(tokens.heading_font.as_deref(), want["headingFont"].as_str(), "{raw}");
            assert_eq!(tokens.code_font.as_deref(), want["codeFont"].as_str(), "{raw}");
            let painted = FontTokens { body_font: Some("local:carlito:Calibri".into()), heading_font: Some("body".into()), code_font: Some("theme".into()) };
            assert_eq!(with_painted_fonts(&style, &painted).to_value(), case["painted"], "painted {raw}");
        }
    }

    #[test]
    fn spacious_writes_no_rule_at_all() {
        assert_eq!(css(&Resolved::default(), ".markdown-body"), "");
        assert!(Resolved::default().is_spacious_drawing());
        assert!(font_tokens(&MarkdownStyle::default()).is_empty());
        assert!(!resolve(&MarkdownStyle::preset("compact")).is_spacious_drawing());
    }

    fn check(step: &Value, store: &StyleStore, raw: &Value) {
        let label = step["label"].as_str().unwrap();
        assert_eq!(store.to_value(), step["store"], "{label} from {raw}");
        assert_eq!(store.active().to_value(), step["active"], "{label} active from {raw}");
        assert_eq!(store.active_name(), step["name"].as_str().unwrap(), "{label} from {raw}");
        assert_eq!(store.edited(), step["edited"].as_bool().unwrap(), "{label} from {raw}");
        assert_eq!(store.pinnable().to_value(), step["pinnable"], "{label} pinnable from {raw}");
    }

    #[test]
    fn the_store_transitions_are_electrons() {
        let tables = groups().iter().find(|g| g.id == "tables").unwrap();
        for case in golden()["stores"].as_array().unwrap() {
            let raw = &case["raw"];
            let steps = case["steps"].as_array().unwrap();
            let mut s = sanitize_store(raw).unwrap_or_default();
            let mut at = 0;
            let mut next = |s: &StyleStore| {
                check(&steps[at], s, raw);
                at += 1;
            };
            next(&s);
            s = s.edit(&[("tableStyle", "grid"), ("bodyFont", "lora")], &[("leading", 1.1)]);
            next(&s);
            assert_eq!(format!("groupChanged:{}", s.group_changed(tables)), steps[2]["label"].as_str().unwrap(), "{raw}");
            next(&s);
            s = s.reset_group(tables);
            next(&s);
            s = s.save_as("Compact", "style-new");
            next(&s);
            s = s.edit(&[("quoteStyle", "card")], &[]);
            next(&s);
            s = s.save_edits();
            next(&s);
            s = s.duplicate("editorial", "style-dup");
            next(&s);
            s = s.duplicate("style-new", "style-dup2");
            next(&s);
            s = s.rename("style-dup", "Spacious");
            next(&s);
            s = s.choose("style-dup");
            next(&s);
            s = s.edit(&[], &[("blockGap", 1.5)]);
            next(&s);
            s = s.discard_draft();
            next(&s);
            s = s.delete("style-dup");
            next(&s);
            s = s.choose("nope");
            next(&s);
        }
    }

    #[test]
    fn names_ids_and_number_labels_match() {
        let g = golden();
        for case in g["names"].as_array().unwrap() {
            let got = clean_name_value(Some(&case["raw"]), "fb");
            assert_eq!(got, case["clean"].as_str().unwrap(), "{}", case["raw"]);
        }
        for (key, list) in g["numberFormats"].as_object().unwrap() {
            for pair in list.as_array().unwrap() {
                assert_eq!(format_number(key, pair[0].as_f64().unwrap()), pair[1].as_str().unwrap(), "{key} {}", pair[0]);
            }
        }
        for case in g["profileIds"].as_array().unwrap() {
            let taken: Vec<String> = case["taken"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            assert_eq!(new_profile_id(&taken, case["seed"].as_u64().unwrap()), case["id"].as_str().unwrap());
        }
        for case in g["styleFontIds"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            assert_eq!(style_font_id("bodyFont", id).as_deref(), case["body"].as_str(), "{id}");
            assert_eq!(style_font_id("headingFont", id).as_deref(), case["heading"].as_str(), "{id}");
            assert_eq!(style_font_id("codeFont", id).as_deref(), case["code"].as_str(), "{id}");
        }
        assert!(is_profile_id("style-1") && !is_profile_id("compact") && !is_profile_id("Bad"));
    }

    #[test]
    fn a_stored_style_never_reaches_a_stylesheet_as_text() {
        let hostile = json!({ "base": "compact", "choices": { "tableStyle": "} body { display: none", "quoteStyle": "card" }, "numbers": { "leading": "1; }" } });
        let style = sanitize(&hostile).unwrap();
        assert_eq!(style.choices.len(), 1);
        assert!(style.numbers.is_empty());
        let sheet = css(&resolve(&style), ".markdown-body");
        assert!(!sheet.contains("display: none"));
        // Deserializing goes through the same cleaner.
        let parsed: MarkdownStyle = serde_json::from_value(hostile).unwrap();
        assert_eq!(parsed, style);
    }
}
