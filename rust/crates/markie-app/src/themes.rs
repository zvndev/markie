//! Markie's eight style templates, each with a light and a dark variant.
//! `themes/templates.json` is generated from the Electron app's
//! `src/lib/theme.ts` by `rust/scripts/export-themes.mjs`, so the two apps
//! ship identical colours.

use std::rc::Rc;

use gpui_kit::component::{Theme, ThemeConfig, ThemeMode, ThemeSet};
use gpui_kit::*;
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
            "link.foreground": t.link,
            "link.hover.foreground": t.link,
            "link.active.foreground": t.link,
            "success.background": or(&t.status_green, "#16a34a"),
            "warning.background": or(&t.status_yellow, "#ca8a04"),
            "danger.background": or(&t.status_red, "#dc2626"),
            "info.background": or(&t.status_blue, "#2563eb"),
        }
    })
}

/// Make `id` the template GPUI Kit uses for light and dark, keeping the
/// current mode.
pub fn apply(id: &str, window: Option<&mut Window>, cx: &mut App) {
    let all = templates();
    let Some(t) = all.iter().find(|t| t.id == id).or_else(|| all.first()) else { return };
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
}
