//! Markie's eight style templates, each with a light and a dark variant.
//! `themes/templates.json` is generated from the Electron app's
//! `src/lib/theme.ts` by `rust/scripts/export-themes.mjs`, so the two apps
//! ship identical colours.

use std::rc::Rc;

use gpui_kit::component::{Theme, ThemeConfig, ThemeMode, ThemeSet};
use gpui_kit::*;
use markie_core::theme::{ThemePreset, ThemeStore, Tone, Typography};
use serde::Deserialize;

const TEMPLATES_JSON: &str = include_str!("../themes/templates.json");

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub background: String,
    pub surface: String,
    pub surface2: String,
    pub foreground: String,
    pub muted: String,
    pub border: String,
    pub accent: String,
    pub link: String,
    pub status_green: Option<String>,
    pub status_yellow: Option<String>,
    pub status_red: Option<String>,
    pub status_blue: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub light: Tokens,
    pub dark: Tokens,
}

pub fn templates() -> Vec<Template> {
    serde_json::from_str(TEMPLATES_JSON).expect("themes/templates.json is valid")
}

/// Markie tokens onto the GPUI Kit theme keys. Buttons use the ink colour on
/// the page colour, the way Markie's graphite primary buttons do.
fn config(name: &str, mode: &str, t: &Tokens) -> serde_json::Value {
    let or = |v: &Option<String>, d: &str| v.clone().unwrap_or_else(|| d.to_string());
    serde_json::json!({
        "name": name,
        "mode": mode,
        "colors": {
            "background": t.background,
            "foreground": t.foreground,
            "border": t.border,
            "input.border": t.border,
            "muted.background": t.surface,
            "muted.foreground": t.muted,
            "sidebar.background": t.surface,
            "sidebar.foreground": t.foreground,
            "sidebar.border": t.border,
            "title_bar.background": t.surface,
            "title_bar.border": t.border,
            "status_bar.background": t.surface,
            "status_bar.border": t.border,
            "popover.background": t.surface,
            "popover.foreground": t.foreground,
            "list.active.background": t.surface2,
            "list.active.border": t.border,
            "list.hover.background": t.surface2,
            "list.even.background": t.surface,
            "secondary.background": t.surface2,
            "secondary.foreground": t.foreground,
            "accent.background": t.accent,
            "accent.foreground": t.foreground,
            "primary.background": t.foreground,
            "primary.foreground": t.background,
            "link": t.link,
            "link.hover": t.link,
            "link.active": t.link,
            "success.background": or(&t.status_green, "#16a34a"),
            "warning.background": or(&t.status_yellow, "#ca8a04"),
            "danger.background": or(&t.status_red, "#dc2626"),
            "info.background": or(&t.status_blue, "#2563eb"),
            // `.markie-scrim` behind every dialog: the page dimmed. Chromium
            // also blurs it; GPUI has no backdrop blur, so the dim is the
            // stronger 72% that dialog_chrome's scrim uses.
            "overlay": scrim(&t.background),
        },
        "highlight": highlight(mode, t),
    })
}

/// GPUI Kit paints its code editor on the highlight theme's background, and
/// a theme config without a `highlight` keeps the last one: after a switch
/// to light, the source and literal-text editors stayed black with dark
/// text. Each tone gets the stock syntax colours of that tone, on the
/// template's own background and text colour.
fn highlight(mode: &str, t: &Tokens) -> serde_json::Value {
    use gpui_kit::component::highlighter::HighlightTheme;
    let base = if mode == "dark" { HighlightTheme::default_dark() } else { HighlightTheme::default_light() };
    let mut style = serde_json::to_value(&base.style).unwrap_or_default();
    if let Some(map) = style.as_object_mut() {
        map.insert("editor.background".into(), serde_json::json!(t.background));
        map.insert("editor.foreground".into(), serde_json::json!(t.foreground));
    }
    style
}

/// The background at 72% opacity, as `#rrggbbaa`.
fn scrim(background: &str) -> String {
    let hex = background.trim().trim_start_matches('#');
    let full = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => hex.to_string(),
        _ => return "#000000b8".into(),
    };
    format!("#{full}b8")
}

/// The person's theme store (`markie.themes.v1`): template, custom presets
/// and typography. Everything that paints reads the preset it resolves to.
pub struct ThemeState(pub ThemeStore);

impl Global for ThemeState {}

/// The store in use, or Markie's default before one is applied.
pub fn store(cx: &App) -> ThemeStore {
    cx.try_global::<ThemeState>().map(|s| s.0.clone()).unwrap_or_default()
}

/// The preset and typography painted in one tone, tweaks included.
pub fn painted(cx: &App, dark: bool) -> (ThemePreset, Typography) {
    store(cx).painted(if dark { Tone::Dark } else { Tone::Light })
}

fn app_tokens(t: &markie_core::theme::ThemeTokens) -> Option<Tokens> {
    serde_json::to_value(t).ok().and_then(|v| serde_json::from_value(v).ok())
}

/// Make `id` the template GPUI Kit uses for light and dark, keeping the
/// current mode and the custom presets.
pub fn apply(id: &str, window: Option<&mut Window>, cx: &mut App) {
    let dark = Theme::global(cx).mode.is_dark();
    let next = store(cx).choose_template(id, if dark { Tone::Dark } else { Tone::Light });
    apply_store(next, window, cx);
}

/// Paint `store`: its light and dark presets become GPUI Kit's themes and
/// Markie's palettes, and the store becomes the global every view reads.
pub fn apply_store(store: ThemeStore, window: Option<&mut Window>, cx: &mut App) {
    let store = store.normalized();
    let name = store.active_template().name.clone();
    let (light_p, _) = store.painted(Tone::Light);
    let (dark_p, _) = store.painted(Tone::Dark);
    cx.set_global(ThemeState(store));
    let (Some(lt), Some(dt)) = (app_tokens(&light_p.tokens), app_tokens(&dark_p.tokens)) else { return };
    let t = Template { id: String::new(), name, description: String::new(), light: lt, dark: dt };
    let set = serde_json::json!({
        "name": t.name,
        "themes": [
            config(&format!("{} Light", t.name), "light", &t.light),
            config(&format!("{} Dark", t.name), "dark", &t.dark),
        ]
    });
    let Ok(set) = serde_json::from_value::<ThemeSet>(set) else { return };
    let mut light: Option<Rc<ThemeConfig>> = None;
    let mut dark: Option<Rc<ThemeConfig>> = None;
    for cfg in set.themes {
        if cfg.mode.is_dark() {
            dark = Some(Rc::new(cfg));
        } else {
            light = Some(Rc::new(cfg));
        }
    }
    cx.set_global(Palettes { light: Palette::from_tokens(&t.light, false), dark: Palette::from_tokens(&t.dark, true) });
    let mode = cx.theme_mode();
    {
        let theme = Theme::global_mut(cx);
        if let Some(l) = light {
            theme.light_theme = l;
        }
        if let Some(d) = dark {
            theme.dark_theme = d;
        }
    }
    Theme::change(mode, window, cx);
}

/// Markie's own tokens for the current template, parsed once when the
/// template changes, so the chrome reads exact Electron colours (surface,
/// surface-2, accent, status blue) that GPUI Kit's theme keys do not carry.
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub dark: bool,
    pub background: Hsla,
    pub surface: Hsla,
    pub surface2: Hsla,
    pub foreground: Hsla,
    pub muted: Hsla,
    pub border: Hsla,
    pub accent: Hsla,
    pub blue: Hsla,
    pub green: Hsla,
    pub yellow: Hsla,
    #[allow(dead_code)]
    pub red: Hsla,
}

struct Palettes {
    light: Palette,
    dark: Palette,
}

impl Global for Palettes {}

pub fn hex(s: &str) -> Hsla {
    let s = s.trim().trim_start_matches('#');
    let v = u32::from_str_radix(s, 16).unwrap_or(0);
    let v = if s.len() == 3 {
        let (r, g, b) = ((v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf);
        (r * 17) << 16 | (g * 17) << 8 | b * 17
    } else {
        v
    };
    rgb(v).into()
}

/// CSS `color-mix(in srgb, a p%, b)`.
pub fn mix(a: Hsla, b: Hsla, p: f32) -> Hsla {
    let (a, b) = (a.to_rgb(), b.to_rgb());
    let q = 1.0 - p;
    Rgba { r: a.r * p + b.r * q, g: a.g * p + b.g * q, b: a.b * p + b.b * q, a: a.a * p + b.a * q }.into()
}

impl Palette {
    fn from_tokens(t: &Tokens, dark: bool) -> Self {
        let or = |v: &Option<String>, d: &str| hex(v.as_deref().unwrap_or(d));
        Self {
            dark,
            background: hex(&t.background),
            surface: hex(&t.surface),
            surface2: hex(&t.surface2),
            foreground: hex(&t.foreground),
            muted: hex(&t.muted),
            border: hex(&t.border),
            accent: hex(&t.accent),
            blue: or(&t.status_blue, if dark { "#60a5fa" } else { "#1d4ed8" }),
            green: or(&t.status_green, if dark { "#4ade80" } else { "#166534" }),
            yellow: or(&t.status_yellow, if dark { "#fde047" } else { "#92400e" }),
            red: or(&t.status_red, if dark { "#f87171" } else { "#991b1b" }),
        }
    }

    /// `foreground` at `p` opacity: Tailwind's `text-foreground/80`.
    pub fn fg(&self, p: f32) -> Hsla {
        self.foreground.opacity(p)
    }
}

/// The palette for the mode on screen.
pub fn palette(cx: &App) -> Palette {
    let dark = Theme::global(cx).mode.is_dark();
    match cx.try_global::<Palettes>() {
        Some(p) => if dark { p.dark } else { p.light },
        None => {
            let t = templates().into_iter().next().expect("one template");
            if dark { Palette::from_tokens(&t.dark, true) } else { Palette::from_tokens(&t.light, false) }
        }
    }
}

trait ModeExt {
    fn theme_mode(&self) -> ThemeMode;
}

impl ModeExt for App {
    fn theme_mode(&self) -> ThemeMode {
        Theme::global(self).mode
    }
}

#[cfg(test)]
mod tests {
    /// Both tones carry an editor background, so a live switch repaints
    /// the source editor instead of keeping the other tone's.
    #[test]
    fn each_tone_paints_its_own_editor_background() {
        let t = super::templates().into_iter().next().expect("one template");
        for (mode, tokens) in [("light", &t.light), ("dark", &t.dark)] {
            let cfg: gpui_kit::component::ThemeConfig = serde_json::from_value(super::config("x", mode, tokens)).expect("config parses");
            let style = cfg.highlight.expect("a highlight style");
            assert_eq!(style.editor_background, Some(super::hex(&tokens.background)), "{mode}");
            assert_eq!(style.editor_foreground, Some(super::hex(&tokens.foreground)), "{mode}");
            assert!(style.syntax != Default::default(), "{mode} keeps its syntax colours");
        }
    }

    #[test]
    fn hex_and_mix_match_css() {
        let white = super::hex("#fff").to_rgb();
        assert!((white.r - 1.0).abs() < 1e-3 && (white.b - 1.0).abs() < 1e-3);
        let grey = super::mix(super::hex("#000000"), super::hex("#ffffff"), 0.5).to_rgb();
        assert!((grey.g - 0.5).abs() < 1e-2);
    }

    /// Every dialog gets `.markie-scrim`: the template's background, dimmed.
    #[test]
    fn dialogs_get_a_dimmed_backdrop() {
        assert_eq!(super::scrim("#0b0b0c"), "#0b0b0cb8");
        assert_eq!(super::scrim("#fff"), "#ffffffb8");
        for t in super::templates() {
            let colors = super::config("x", "dark", &t.dark)["colors"]["overlay"].as_str().unwrap().to_string();
            assert!(colors.starts_with('#') && colors.len() == 9, "{}: {colors}", t.id);
            assert!(colors.ends_with("b8"));
        }
    }

    #[test]
    fn all_eight_templates_parse() {
        let all = super::templates();
        let ids: Vec<&str> = all.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["markie", "paper", "nord", "solarized", "ink", "rose", "forest", "studio"]);
        for t in &all {
            let set = serde_json::json!({ "name": t.name, "themes": [super::config("x", "light", &t.light)] });
            assert!(serde_json::from_value::<gpui_kit::component::ThemeSet>(set).is_ok(), "{}", t.id);
        }
    }

    #[test]
    fn every_painted_preset_reaches_the_chrome() {
        use markie_core::theme::{ThemeStore, Tone, templates};
        for t in templates() {
            let store = ThemeStore::default().choose_template(&t.id, Tone::Light);
            for tone in [Tone::Light, Tone::Dark] {
                let (p, typo) = store.painted(tone);
                let tokens = super::app_tokens(&p.tokens).expect("tokens convert");
                assert_eq!(tokens.background, p.tokens.background);
                assert_eq!(typo, t.typography, "{} {:?}", t.id, tone);
            }
        }
        let custom = ThemeStore::default()
            .choose_template("paper", Tone::Light)
            .edit_colors(Tone::Light, |k| k.background = "#ffeedd".into(), "custom-1");
        assert_eq!(super::app_tokens(&custom.painted(Tone::Light).0.tokens).unwrap().background, "#ffeedd");
    }
}
