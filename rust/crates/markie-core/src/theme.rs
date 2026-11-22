//! Style templates, custom presets and typography: the logic of
//! `src/lib/theme.ts`, UI-free. The store keeps the JSON shape of Electron's
//! `markie.themes.v1` (and `PUT /api/me/themes`), so a store migrated or
//! synced from Electron reads the same here.
//!
//! The eight templates come from the same `templates.json` the app paints
//! from, generated from `theme.ts`.

use serde::{Deserialize, Serialize};

const TEMPLATES_JSON: &str = include_str!("../../markie-app/themes/templates.json");

pub const HEADING_SAME_AS_BODY: &str = "body";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokens {
    pub background: String,
    pub surface: String,
    pub surface2: String,
    pub foreground: String,
    pub muted: String,
    pub border: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_rule: Option<String>,
    pub accent: String,
    pub link: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_green: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_yellow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_red: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_blue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_purple: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub content_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph_gap: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePreset {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<Tone>,
    pub tokens: ThemeTokens,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Typography {
    pub body_font: String,
    pub heading_font: String,
    pub line_height: f64,
    pub paragraph_gap: f64,
    pub font_size: f64,
    pub content_width: f64,
}

/// Partial typography: the person's tweaks over the template.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypographyPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph_gap: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_width: Option<f64>,
}

impl TypographyPatch {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

pub struct Typeface {
    pub id: &'static str,
    pub label: &'static str,
    /// Native families in preference order (the CSS stack without generics).
    pub families: &'static [&'static str],
    pub kind: &'static str,
}

/// `TYPEFACES`: only faces that ship with macOS or Windows.
pub const TYPEFACES: &[Typeface] = &[
    Typeface { id: "system", label: "System", families: &[".SystemUIFont"], kind: "sans" },
    Typeface { id: "humanist", label: "Avenir", families: &["Avenir Next", "Avenir", "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue"], kind: "sans" },
    Typeface { id: "helvetica", label: "Helvetica", families: &["Helvetica Neue", "Helvetica", "Arial"], kind: "sans" },
    Typeface { id: "optima", label: "Optima", families: &["Optima", "Candara", "Avenir Next", "Segoe UI"], kind: "sans" },
    Typeface { id: "charter", label: "Charter", families: &["Charter", "Bitstream Charter", "Georgia", "Times New Roman"], kind: "serif" },
    Typeface { id: "iowan", label: "Iowan", families: &["Iowan Old Style", "Palatino Linotype", "Palatino", "Book Antiqua", "Georgia"], kind: "serif" },
    Typeface { id: "newyork", label: "New York", families: &["New York", "Iowan Old Style", "Charter", "Georgia"], kind: "serif" },
    Typeface { id: "georgia", label: "Georgia", families: &["Georgia", "Charter", "Times New Roman"], kind: "serif" },
    Typeface { id: "mono", label: "Monospace", families: &["Menlo"], kind: "mono" },
];

pub fn typeface(id: &str) -> &'static Typeface {
    TYPEFACES.iter().find(|t| t.id == id).unwrap_or(&TYPEFACES[0])
}

pub fn default_typography() -> Typography {
    Typography {
        body_font: "system".into(),
        heading_font: HEADING_SAME_AS_BODY.into(),
        line_height: 1.75,
        paragraph_gap: 0.8,
        font_size: 16.0,
        content_width: 768.0,
    }
}

/// `TYPOGRAPHY_LIMITS`: (min, max, step) for the Settings sliders.
pub const LINE_HEIGHT_LIMITS: (f64, f64, f64) = (1.3, 2.2, 0.05);
pub const PARAGRAPH_GAP_LIMITS: (f64, f64, f64) = (0.3, 1.6, 0.1);
pub const FONT_SIZE_LIMITS: (f64, f64, f64) = (13.0, 22.0, 1.0);
pub const CONTENT_WIDTH_LIMITS: (f64, f64, f64) = (560.0, 1200.0, 16.0);

fn clamp(v: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    match v {
        Some(n) if n.is_finite() => n.clamp(min, max),
        _ => fallback,
    }
}

fn known_face(id: Option<&str>) -> bool {
    id.is_some_and(|i| TYPEFACES.iter().any(|t| t.id == i))
}

/// `typographyOf`: every value checked before it reaches the renderer.
pub fn typography_of(t: &ThemeTokens) -> Typography {
    let d = default_typography();
    Typography {
        body_font: if known_face(t.body_font.as_deref()) { t.body_font.clone().unwrap() } else { d.body_font },
        heading_font: match t.heading_font.as_deref() {
            Some(h) if h == HEADING_SAME_AS_BODY || known_face(Some(h)) => h.to_string(),
            _ => d.heading_font,
        },
        line_height: clamp(t.line_height, d.line_height, LINE_HEIGHT_LIMITS.0, LINE_HEIGHT_LIMITS.1),
        paragraph_gap: clamp(t.paragraph_gap, d.paragraph_gap, PARAGRAPH_GAP_LIMITS.0, PARAGRAPH_GAP_LIMITS.1),
        font_size: clamp(t.font_size, d.font_size, 11.0, 32.0),
        content_width: clamp(t.content_width, d.content_width, 320.0, 2400.0),
    }
}

impl Typography {
    /// Native families for the body and for headings (None: same as body).
    pub fn body_families(&self) -> &'static [&'static str] {
        typeface(&self.body_font).families
    }
    pub fn heading_families(&self) -> Option<&'static [&'static str]> {
        (self.heading_font != HEADING_SAME_AS_BODY).then(|| typeface(&self.heading_font).families)
    }
}

#[derive(Clone, Debug, Deserialize)]
struct TemplateJson {
    id: String,
    name: String,
    description: String,
    light: ThemeTokens,
    dark: ThemeTokens,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub typography: Typography,
    pub light: ThemePreset,
    pub dark: ThemePreset,
}

impl Template {
    pub fn variant(&self, tone: Tone) -> &ThemePreset {
        match tone {
            Tone::Light => &self.light,
            Tone::Dark => &self.dark,
        }
    }
}

/// The eight templates, Markie first.
pub fn templates() -> &'static [Template] {
    static ALL: std::sync::LazyLock<Vec<Template>> = std::sync::LazyLock::new(|| {
        let raw: Vec<TemplateJson> = serde_json::from_str(TEMPLATES_JSON).expect("templates.json");
        raw.into_iter()
            .map(|t| {
                let variant = |tone: Tone, tokens: ThemeTokens| {
                    let suffix = if tone == Tone::Light { "Light" } else { "Dark" };
                    ThemePreset {
                        id: format!("{}-{}", t.id, if tone == Tone::Light { "light" } else { "dark" }),
                        name: format!("{} {suffix}", t.name),
                        built_in: Some(true),
                        template_id: Some(t.id.clone()),
                        tone: Some(tone),
                        tokens,
                    }
                };
                Template {
                    typography: typography_of(&t.light),
                    light: variant(Tone::Light, t.light),
                    dark: variant(Tone::Dark, t.dark),
                    id: t.id,
                    name: t.name,
                    description: t.description,
                }
            })
            .collect()
    });
    &ALL
}

pub fn find_template(id: Option<&str>) -> Option<&'static Template> {
    id.and_then(|id| templates().iter().find(|t| t.id == id))
}

fn markie() -> &'static Template {
    &templates()[0]
}

pub fn built_in_presets() -> impl Iterator<Item = &'static ThemePreset> {
    templates().iter().flat_map(|t| [&t.dark, &t.light])
}

/// `editorThemeForTokens`: light when the background's luminance is over 0.45.
pub fn tone_for_tokens(t: &ThemeTokens) -> Tone {
    let raw = t.background.trim().trim_start_matches('#');
    let full: String = if raw.len() == 3 { raw.chars().flat_map(|c| [c, c]).collect() } else { raw.to_string() };
    let ok = full.len() == 6 && full.chars().all(|c| c.is_ascii_hexdigit());
    if !ok {
        return Tone::Dark;
    }
    let ch = |i: usize| {
        let v = u8::from_str_radix(&full[i..i + 2], 16).unwrap() as f64 / 255.0;
        if v <= 0.03928 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    let l = 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
    if l > 0.45 { Tone::Light } else { Tone::Dark }
}

pub fn preset_tone(p: &ThemePreset) -> Tone {
    p.tone.unwrap_or_else(|| tone_for_tokens(&p.tokens))
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Overrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark: Option<String>,
}

impl Overrides {
    fn get(&self, tone: Tone) -> Option<&String> {
        match tone {
            Tone::Light => self.light.as_ref(),
            Tone::Dark => self.dark.as_ref(),
        }
    }
    fn set(&mut self, tone: Tone, id: Option<String>) {
        match tone {
            Tone::Light => self.light = id,
            Tone::Dark => self.dark = id,
        }
    }
}

/// `ThemeStore`, JSON-compatible with `markie.themes.v1`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeStore {
    pub active_id: String,
    #[serde(default)]
    pub custom: Vec<ThemePreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Overrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typography: Option<TypographyPatch>,
}

impl Default for ThemeStore {
    fn default() -> Self {
        Self { active_id: "markie-dark".into(), custom: Vec::new(), template_id: None, overrides: None, typography: None }
    }
}

/// Clean a patch the way `normalizeThemeStore` does: keep only keys present,
/// each clamped.
fn clean_patch(p: &TypographyPatch) -> TypographyPatch {
    let t = typography_of(&ThemeTokens {
        body_font: p.body_font.clone(),
        heading_font: p.heading_font.clone(),
        line_height: p.line_height,
        paragraph_gap: p.paragraph_gap,
        font_size: p.font_size,
        content_width: p.content_width,
        ..Default::default()
    });
    TypographyPatch {
        body_font: p.body_font.as_ref().map(|_| t.body_font.clone()),
        heading_font: p.heading_font.as_ref().map(|_| t.heading_font.clone()),
        line_height: p.line_height.map(|_| t.line_height),
        paragraph_gap: p.paragraph_gap.map(|_| t.paragraph_gap),
        font_size: p.font_size.map(|_| t.font_size),
        content_width: p.content_width.map(|_| t.content_width),
    }
}

impl ThemeStore {
    /// Parse a stored store; anything unreadable is the default.
    pub fn parse(json: &str) -> Self {
        serde_json::from_str::<ThemeStore>(json).map(|s| s.normalized()).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// `normalizeThemeStore`.
    pub fn normalized(&self) -> Self {
        let mut s = self.clone();
        let built = built_in_presets().find(|p| p.id == s.active_id);
        let active_custom = s.custom.iter().find(|p| p.id == s.active_id).cloned();
        if find_template(s.template_id.as_deref()).is_none() {
            s.template_id = Some(
                built
                    .and_then(|b| b.template_id.clone())
                    .or_else(|| {
                        active_custom.as_ref().and_then(|c| find_template(c.template_id.as_deref()).map(|t| t.id.clone()))
                    })
                    .unwrap_or_else(|| markie().id.clone()),
            );
        }
        let mut ov = Overrides::default();
        for tone in [Tone::Light, Tone::Dark] {
            if let Some(id) = self.overrides.as_ref().and_then(|o| o.get(tone))
                && let Some(p) = s.custom.iter().find(|p| &p.id == id)
                && preset_tone(p) == tone
            {
                ov.set(tone, Some(p.id.clone()));
            }
        }
        if let Some(c) = &active_custom
            && self.overrides.is_none()
        {
            ov.set(preset_tone(c), Some(c.id.clone()));
        }
        s.overrides = Some(ov);
        s.typography = self.typography.as_ref().map(clean_patch);
        s
    }

    /// `findTheme`: the preset with the person's typography tweaks applied.
    pub fn find_theme(&self, id: &str) -> ThemePreset {
        let preset = built_in_presets()
            .find(|p| p.id == id)
            .or_else(|| self.custom.iter().find(|p| p.id == id))
            .cloned()
            .unwrap_or_else(|| markie().dark.clone());
        self.with_tweaks(preset)
    }

    fn with_tweaks(&self, mut p: ThemePreset) -> ThemePreset {
        if let Some(t) = self.typography.as_ref().filter(|t| !t.is_empty()) {
            let k = &mut p.tokens;
            if t.body_font.is_some() {
                k.body_font = t.body_font.clone();
            }
            if t.heading_font.is_some() {
                k.heading_font = t.heading_font.clone();
            }
            k.line_height = t.line_height.or(k.line_height);
            k.paragraph_gap = t.paragraph_gap.or(k.paragraph_gap);
            k.font_size = t.font_size.or(k.font_size);
            k.content_width = t.content_width.or(k.content_width);
        }
        p
    }

    pub fn active_template(&self) -> &'static Template {
        find_template(self.normalized().template_id.as_deref()).unwrap_or_else(markie)
    }

    /// `presetForTone`: the custom override for that tone, or the template's.
    pub fn preset_for_tone(&self, tone: Tone) -> ThemePreset {
        let clean = self.normalized();
        let ov = clean.overrides.as_ref().and_then(|o| o.get(tone)).and_then(|id| clean.custom.iter().find(|p| &p.id == id));
        match ov {
            Some(p) => p.clone(),
            None => clean.active_template().variant(tone).clone(),
        }
    }

    /// The tokens painted in a tone, tweaks included, and their typography.
    pub fn painted(&self, tone: Tone) -> (ThemePreset, Typography) {
        let p = self.with_tweaks(self.preset_for_tone(tone));
        let t = typography_of(&p.tokens);
        (p, t)
    }

    pub fn choose_template(&self, template_id: &str, tone: Tone) -> Self {
        let t = find_template(Some(template_id)).unwrap_or_else(markie);
        Self {
            active_id: t.variant(tone).id.clone(),
            custom: self.custom.clone(),
            template_id: Some(t.id.clone()),
            overrides: Some(Overrides::default()),
            typography: None,
        }
    }

    pub fn choose_custom_preset(&self, preset_id: &str) -> Self {
        let Some(p) = self.custom.iter().find(|p| p.id == preset_id) else { return self.clone() };
        let clean = self.normalized();
        let template_id = find_template(p.template_id.as_deref())
            .map(|t| t.id.clone())
            .or_else(|| clean.template_id.clone())
            .unwrap_or_else(|| markie().id.clone());
        let same = Some(&template_id) == clean.template_id.as_ref();
        let mut ov = if same { clean.overrides.clone().unwrap_or_default() } else { Overrides::default() };
        ov.set(preset_tone(p), Some(p.id.clone()));
        Self {
            active_id: p.id.clone(),
            custom: self.custom.clone(),
            template_id: Some(template_id),
            overrides: Some(ov),
            typography: if same { clean.typography.clone() } else { None },
        }
    }

    pub fn reset_to_template(&self, tone: Tone) -> Self {
        let clean = self.normalized();
        clean.choose_template(clean.template_id.as_deref().unwrap_or("markie"), tone)
    }

    pub fn set_typography(&self, patch: &TypographyPatch) -> Self {
        let mut t = self.typography.clone().unwrap_or_default();
        macro_rules! take {
            ($f:ident) => {
                if patch.$f.is_some() {
                    t.$f = patch.$f.clone();
                }
            };
        }
        take!(body_font);
        take!(heading_font);
        take!(line_height);
        take!(paragraph_gap);
        take!(font_size);
        take!(content_width);
        Self { typography: Some(t), ..self.clone() }
    }

    /// `editColors`: a built-in variant forks into a custom preset that takes
    /// over that tone only; a custom preset is edited in place. `edit` changes
    /// colour tokens.
    pub fn edit_colors(&self, tone: Tone, edit: impl FnOnce(&mut ThemeTokens), new_id: &str) -> Self {
        let mut clean = self.normalized();
        let current = clean.preset_for_tone(tone);
        if current.built_in != Some(true) {
            clean.active_id = current.id.clone();
            if let Some(p) = clean.custom.iter_mut().find(|p| p.id == current.id) {
                edit(&mut p.tokens);
            }
            return clean;
        }
        let template = find_template(current.template_id.as_deref()).unwrap_or_else(markie);
        let mut tokens = current.tokens.clone();
        edit(&mut tokens);
        let fork = ThemePreset {
            id: new_id.into(),
            name: format!("{} Copy", current.name),
            built_in: None,
            template_id: Some(template.id.clone()),
            tone: Some(tone),
            tokens,
        };
        clean.active_id = fork.id.clone();
        clean.custom.push(fork);
        let mut ov = clean.overrides.clone().unwrap_or_default();
        ov.set(tone, Some(new_id.into()));
        clean.overrides = Some(ov);
        clean
    }

    pub fn delete_custom_preset(&self, preset_id: &str, tone: Tone) -> Self {
        let mut clean = self.normalized();
        clean.custom.retain(|p| p.id != preset_id);
        let mut ov = clean.overrides.clone().unwrap_or_default();
        if ov.light.as_deref() == Some(preset_id) {
            ov.light = None;
        }
        if ov.dark.as_deref() == Some(preset_id) {
            ov.dark = None;
        }
        clean.overrides = Some(ov);
        clean.active_id = clean.preset_for_tone(tone).id;
        clean
    }

    /// Rename a custom preset (Settings' name field).
    pub fn rename_custom_preset(&self, preset_id: &str, name: &str) -> Self {
        let mut s = self.clone();
        let name = name.trim();
        if let Some(p) = s.custom.iter_mut().find(|p| p.id == preset_id)
            && !name.is_empty()
        {
            p.name = name.into();
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eight_templates_with_their_typography() {
        let ids: Vec<_> = templates().iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["markie", "paper", "nord", "solarized", "ink", "rose", "forest", "studio"]);
        let paper = find_template(Some("paper")).unwrap();
        assert_eq!(paper.typography.body_font, "charter");
        assert_eq!(paper.typography.heading_font, "iowan");
        assert_eq!((paper.typography.font_size, paper.typography.content_width), (17.0, 720.0));
        assert_eq!(paper.light.id, "paper-light");
        assert_eq!(paper.dark.name, "Paper Dark");
        let studio = find_template(Some("studio")).unwrap();
        assert_eq!(studio.typography.heading_font, "mono");
        assert_eq!(studio.typography.content_width, 880.0);
        assert_eq!(templates()[0].typography, default_typography());
        for t in templates() {
            assert_eq!(tone_for_tokens(&t.light.tokens), Tone::Light, "{}", t.id);
            assert_eq!(tone_for_tokens(&t.dark.tokens), Tone::Dark, "{}", t.id);
        }
    }

    #[test]
    fn typography_is_clamped_and_unknown_faces_fall_back() {
        let t = typography_of(&ThemeTokens {
            body_font: Some("comic".into()),
            heading_font: Some("georgia".into()),
            line_height: Some(9.0),
            paragraph_gap: Some(f64::NAN),
            font_size: Some(5.0),
            ..Default::default()
        });
        assert_eq!(t.body_font, "system");
        assert_eq!(t.heading_font, "georgia");
        assert_eq!((t.line_height, t.paragraph_gap, t.font_size, t.content_width), (2.2, 0.8, 11.0, 768.0));
        assert_eq!(t.heading_families().unwrap()[0], "Georgia");
        assert!(typography_of(&ThemeTokens::default()).heading_families().is_none());
    }

    #[test]
    fn store_transitions_match_theme_ts() {
        let s = ThemeStore::default().choose_template("nord", Tone::Light);
        assert_eq!(s.active_id, "nord-light");
        assert_eq!(s.painted(Tone::Dark).0.id, "nord-dark");
        // Editing a colour forks the built-in for that tone only.
        let s = s.edit_colors(Tone::Light, |t| t.accent = "#ff0000".into(), "custom-1");
        assert_eq!(s.custom.len(), 1);
        assert_eq!(s.custom[0].name, "Nord Light Copy");
        assert_eq!(s.preset_for_tone(Tone::Light).id, "custom-1");
        assert_eq!(s.preset_for_tone(Tone::Dark).id, "nord-dark");
        // A second edit changes the custom preset in place.
        let s = s.edit_colors(Tone::Light, |t| t.link = "#00ff00".into(), "unused");
        assert_eq!(s.custom.len(), 1);
        assert_eq!(s.custom[0].tokens.link, "#00ff00");
        // Typography tweaks ride on whatever is painted, clamped on load.
        let s = s.set_typography(&TypographyPatch { font_size: Some(40.0), body_font: Some("iowan".into()), ..Default::default() });
        let reloaded = ThemeStore::parse(&s.to_json());
        let (_, t) = reloaded.painted(Tone::Dark);
        assert_eq!((t.font_size, t.body_font.as_str()), (32.0, "iowan"));
        // Choosing a template drops tweaks and overrides; the preset survives.
        let other = reloaded.choose_template("paper", Tone::Light);
        assert!(other.typography.is_none());
        assert_eq!(other.preset_for_tone(Tone::Light).id, "paper-light");
        let back = other.choose_custom_preset("custom-1");
        assert_eq!(back.template_id.as_deref(), Some("nord"));
        assert_eq!(back.preset_for_tone(Tone::Light).id, "custom-1");
        let gone = back.delete_custom_preset("custom-1", Tone::Light);
        assert!(gone.custom.is_empty());
        assert_eq!(gone.active_id, "nord-light");
        assert_eq!(back.rename_custom_preset("custom-1", " Mine ").custom[0].name, "Mine");
    }

    #[test]
    fn legacy_stores_normalize() {
        // A pre-template store: a custom preset active, no templateId.
        let json = r##"{"activeId":"old","custom":[{"id":"old","name":"Old","tokens":{"background":"#ffffff","surface":"#eee","surface2":"#ddd","foreground":"#000","muted":"#555","border":"#ccc","accent":"#00f","link":"#00f","fontSize":18,"contentWidth":700}}]}"##;
        let s = ThemeStore::parse(json);
        assert_eq!(s.template_id.as_deref(), Some("markie"));
        assert_eq!(s.overrides.as_ref().unwrap().light.as_deref(), Some("old"));
        assert_eq!(s.painted(Tone::Light).1.font_size, 18.0);
        assert_eq!(ThemeStore::parse("not json"), ThemeStore::default());
        let round = ThemeStore::parse(&s.to_json());
        assert_eq!(round, s);
    }
}
