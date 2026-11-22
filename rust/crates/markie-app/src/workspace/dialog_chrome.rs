//! The look every Markie overlay shares, ported from `src/app/globals.css`:
//! the scrim, the overlay panel, the close button, section labels, the
//! segmented control, select buttons and range tracks. Colours come from the
//! active style template, exactly as Electron's CSS variables do, so a
//! dialog in Markie RS paints with the same tokens as the Electron one.

use std::sync::Arc;

use gpui_kit::*;
use serde::Deserialize;

const TEMPLATES_JSON: &str = include_str!("../../themes/templates.json");

/// One template variant, with the typography the settings show.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Variant {
    pub background: String,
    pub surface: String,
    pub surface2: String,
    pub foreground: String,
    pub muted: String,
    pub border: String,
    pub accent: String,
    pub link: String,
    pub status_red: Option<String>,
    pub body_font: Option<String>,
    pub heading_font: Option<String>,
    pub line_height: Option<f32>,
    pub paragraph_gap: Option<f32>,
    pub font_size: Option<f32>,
    pub content_width: Option<f32>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub light: Variant,
    pub dark: Variant,
}

pub(crate) fn templates() -> Vec<TemplateInfo> {
    serde_json::from_str(TEMPLATES_JSON).expect("themes/templates.json is valid")
}

/// `#rrggbb` (or `#rgb`) to a colour; anything else is magenta so a bad
/// token is obvious rather than silently black.
pub(crate) fn hex(s: &str) -> Hsla {
    let s = s.trim().trim_start_matches('#');
    let full = if s.len() == 3 { s.chars().flat_map(|c| [c, c]).collect::<String>() } else { s.to_string() };
    match u32::from_str_radix(&full, 16) {
        Ok(v) if full.len() == 6 => rgb(v).into(),
        Ok(v) if full.len() == 8 => rgba(v).into(),
        _ => rgb(0xff00ff).into(),
    }
}

/// CSS `color-mix(in srgb, a p, b)` for two colours.
pub(crate) fn mix(a: Hsla, p: f32, b: Hsla) -> Hsla {
    let (a, b) = (a.to_rgb(), b.to_rgb());
    // Premultiplied, like CSS, so mixing with `transparent` only fades.
    let alpha = a.a * p + b.a * (1. - p);
    if alpha <= 0. {
        return gpui_kit::transparent_black();
    }
    let ch = |x: f32, xa: f32, y: f32, ya: f32| (x * xa * p + y * ya * (1. - p)) / alpha;
    Rgba { r: ch(a.r, a.a, b.r, b.a), g: ch(a.g, a.a, b.g, b.a), b: ch(a.b, a.a, b.b, b.a), a: alpha }.into()
}

/// CSS `color-mix(in srgb, a p, transparent)`.
pub(crate) fn fade(a: Hsla, p: f32) -> Hsla {
    a.opacity(p)
}

/// The CSS variables Electron sets from the active template variant.
#[derive(Clone, Debug)]
pub(crate) struct Tokens {
    pub dark: bool,
    pub background: Hsla,
    pub surface: Hsla,
    pub surface2: Hsla,
    pub foreground: Hsla,
    pub muted: Hsla,
    pub border: Hsla,
    pub accent: Hsla,
    /// `--blue`, which Electron sets to the template's link colour.
    pub blue: Hsla,
    pub red: Hsla,
}

impl Tokens {
    pub(crate) fn from_variant(v: &Variant, dark: bool) -> Self {
        let or = |o: &Option<String>, d: &str| hex(o.as_deref().unwrap_or(d));
        Self {
            dark,
            background: hex(&v.background),
            surface: hex(&v.surface),
            surface2: hex(&v.surface2),
            foreground: hex(&v.foreground),
            muted: hex(&v.muted),
            border: hex(&v.border),
            accent: hex(&v.accent),
            blue: hex(&v.link),
            red: or(&v.status_red, "#f87171"),
        }
    }

    /// The tokens for `template` in the current light or dark mode.
    pub(crate) fn current(template: &str, cx: &App) -> Self {
        let dark = gpui_kit::component::Theme::global(cx).mode.is_dark();
        let all = templates();
        let t = all.iter().find(|t| t.id == template).or_else(|| all.first()).expect("templates exist");
        Self::from_variant(if dark { &t.dark } else { &t.light }, dark)
    }

    // ---- the shared surfaces, one per class in globals.css ----

    /// `.markie-scrim`: the page dimmed behind a dialog. Chromium also blurs
    /// it; GPUI has no backdrop blur, so the dim is slightly stronger.
    pub(crate) fn scrim(&self) -> Hsla {
        fade(self.background, 0.72)
    }

    /// `.markie-scrim-strong`.
    pub(crate) fn scrim_strong(&self) -> Hsla {
        fade(self.background, 0.82)
    }

    /// `.markie-overlay-panel` background.
    pub(crate) fn panel_bg(&self) -> Hsla {
        if self.dark { self.surface2 } else { mix(self.background, 0.58, self.surface2) }
    }

    pub(crate) fn panel_border(&self) -> Hsla {
        if self.dark { self.border } else { fade(self.border, 0.6) }
    }

    pub(crate) fn panel_shadow(&self) -> Vec<BoxShadow> {
        if self.dark {
            vec![
                shadow(fade(black(), 0.26), 0., 18., 44.),
                inset(fade(self.foreground, 0.06), 1.),
            ]
        } else {
            vec![shadow(fade(black(), 0.10), 0., 12., 32.)]
        }
    }

    /// Hover fill for menu rows, the close button and command rows.
    pub(crate) fn hover(&self) -> Hsla {
        if self.dark { fade(self.accent, 0.72) } else { fade(self.foreground, 0.06) }
    }

    /// `hover:bg-accent/40`, the plain button hover used across dialogs.
    pub(crate) fn hover_soft(&self) -> Hsla {
        fade(self.accent, 0.4)
    }

    /// `.markie-overlay-field` background.
    pub(crate) fn field_bg(&self) -> Hsla {
        if self.dark { mix(self.background, 0.82, self.surface) } else { self.background }
    }

    pub(crate) fn field_border(&self) -> Hsla {
        if self.dark { self.border } else { mix(self.foreground, 0.14, self.border) }
    }

    /// `.markie-select-button` background.
    pub(crate) fn select_bg(&self) -> Hsla {
        if self.dark { mix(self.background, 0.72, self.surface2) } else { self.background }
    }

    /// `text-muted/80`.
    pub(crate) fn muted_soft(&self) -> Hsla {
        fade(self.muted, 0.8)
    }
}

pub(crate) fn black() -> Hsla {
    rgb(0x000000).into()
}

pub(crate) fn shadow(color: Hsla, x: f32, y: f32, blur: f32) -> BoxShadow {
    BoxShadow { color, offset: point(px(x), px(y)), blur_radius: px(blur), spread_radius: px(0.), inset: false }
}

/// `inset 0 1px <color>`: the top highlight line on Markie's dark surfaces.
pub(crate) fn inset(color: Hsla, y: f32) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.), px(y)), blur_radius: px(0.), spread_radius: px(0.), inset: true }
}

/// `inset 0 <y>px <blur>px <color>`.
pub(crate) fn inset_blur(color: Hsla, y: f32, blur: f32) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.), px(y)), blur_radius: px(blur), spread_radius: px(0.), inset: true }
}

/// A ring drawn with a spread shadow: `0 0 0 <w>px <color>`.
pub(crate) fn ring(color: Hsla, width: f32) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(width), inset: false }
}

/// `#rrggbb` for an SVG attribute.
pub(crate) fn css(c: Hsla) -> String {
    let c = c.to_rgb();
    let to = |x: f32| (x.clamp(0., 1.) * 255.).round() as u8;
    format!("#{:02x}{:02x}{:02x}", to(c.r), to(c.g), to(c.b))
}

pub(crate) fn css_opacity(c: Hsla) -> String {
    format!("{:.3}", c.to_rgb().a)
}

/// An inline SVG drawn at 2x so it stays crisp on Retina, shown at `w`x`h`
/// points. `body` uses the 0 0 `vw` `vh` coordinate space.
pub(crate) fn svg_image(body: &str, vw: f32, vh: f32, w: f32, h: f32) -> Img {
    let doc = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 {vw} {vh}" fill="none">{body}</svg>"#,
        w * 2.,
        h * 2.
    );
    img(Arc::new(Image::from_bytes(ImageFormat::Svg, doc.into_bytes()))).w(px(w)).h(px(h)).flex_none()
}

/// The 24-unit stroke icons Electron draws inline (×, ✓, chevrons, arrows).
pub(crate) fn stroke_icon(path: &str, color: Hsla, size: f32, width: f32) -> Img {
    svg_image(
        &format!(
            r#"<path d="{path}" stroke="{}" stroke-opacity="{}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>"#,
            css(color),
            css_opacity(color)
        ),
        24.,
        24.,
        size,
        size,
    )
}

pub(crate) const PATH_CLOSE: &str = "M18 6 6 18M6 6l12 12";
pub(crate) const PATH_CHECK: &str = "M20 6 9 17l-5-5";
pub(crate) const PATH_CHEVRON_DOWN: &str = "m6 9 6 6 6-6";
pub(crate) const PATH_ARROW_RIGHT: &str = "M5 12h14M13 6l6 6-6 6";

/// Electron's `DocumentFormatMark`: a miniature sheet per format, with its
/// own glyph, tint and short label. Sizes: sm 29x35, md 40x48, lg 58x70.
pub(crate) fn format_mark(format: &str, size: &str, t: &Tokens) -> Img {
    let (accent, soft, short) = match format {
        "markdown" => ("#7dd3fc", "rgba(56,189,248,.18)", "MD"),
        "docx" => ("#60a5fa", "rgba(59,130,246,.20)", "W"),
        "rtf" => ("#2dd4bf", "rgba(45,212,191,.17)", "Aa"),
        "odt" => ("#38bdf8", "rgba(14,165,233,.18)", "OD"),
        "text" => ("#a1a1aa", "rgba(161,161,170,.16)", "TXT"),
        "darkmown" => ("#fbbf24", "rgba(251,191,36,.17)", "WD"),
        "csv" => ("#4ade80", "rgba(74,222,128,.16)", "CSV"),
        "json" => ("#facc15", "rgba(250,204,21,.15)", "{ }"),
        "yaml" => ("#fb7185", "rgba(251,113,133,.16)", "YML"),
        "xml" => ("#fb923c", "rgba(251,146,60,.16)", "&lt;/&gt;"),
        _ => ("#a1a1aa", "rgba(161,161,170,.13)", "FILE"),
    };
    let (w, h) = match size {
        "sm" => (29., 35.),
        "lg" => (58., 70.),
        _ => (40., 48.),
    };
    let line = |d: &str, sw: f32| {
        format!(r#"<path d="{d}" stroke="{accent}" stroke-width="{sw}" stroke-linecap="round" opacity="0.88"/>"#)
    };
    let glyph = match format {
        "csv" => format!(r#"<g stroke="{accent}" stroke-width="1.7" opacity="0.9"><path d="M13 25h22M13 32h22M13 39h22M20 19v25M28 19v25"/></g>"#),
        "darkmown" => format!(
            r#"<path d="M29 18a8 8 0 1 0 6 13 10 10 0 0 1-6-13Z" fill="{accent}" opacity="0.92"/><circle cx="17" cy="38" r="2.2" fill="{accent}"/>{}"#,
            line("M22 38h10", 2.)
        ),
        "json" => format!(r#"<text x="24" y="35" text-anchor="middle" fill="{accent}" font-size="15" font-weight="700" font-family="Menlo, monospace">{{ }}</text>"#),
        "xml" => format!(r#"<text x="24" y="35" text-anchor="middle" fill="{accent}" font-size="14" font-weight="700" font-family="Menlo, monospace">&lt;/&gt;</text>"#),
        "yaml" => line("M14 23h7M25 23h9M14 31h5M23 31h11M14 39h9", 2.6),
        "markdown" => format!(
            r#"{}<path d="M31 16v7M28.5 20.5 31 23l2.5-2.5" stroke="{accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
            line("M14 21h13M14 29h20M14 37h16", 2.6)
        ),
        "docx" => format!(
            r#"<text x="17" y="30" fill="{accent}" font-size="17" font-weight="700" font-family="Georgia, serif">W</text>{}"#,
            line("M24 24h10M14 34h20M14 41h14", 2.1)
        ),
        "rtf" => format!(
            r#"<text x="13" y="30" fill="{accent}" font-size="15" font-style="italic" font-weight="700" font-family="Georgia, serif">Aa</text>{}"#,
            line("M14 37h20M14 43h13", 2.)
        ),
        "odt" => format!(
            r#"<circle cx="18" cy="24" r="5" stroke="{accent}" stroke-width="2.4"/>{}"#,
            line("M27 24h7M14 35h20M14 42h14", 2.1)
        ),
        "text" => line("M14 22h20M14 29h20M14 36h13M14 43h17", 2.),
        _ => line("M14 25h20M14 33h16M14 41h11", 2.6),
    };
    let label_size = if short.replace("&lt;", "<").replace("&gt;", ">").len() > 3 { 5.5 } else { 6.5 };
    let body = format!(
        r##"<defs><linearGradient id="g" x1="8" y1="4" x2="40" y2="54" gradientUnits="userSpaceOnUse"><stop stop-color="{soft}"/><stop offset="0.48" stop-color="{s2}"/><stop offset="1" stop-color="{bg}"/></linearGradient></defs>
<path d="M10 4h19l9 9v38a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" fill="url(#g)" stroke="{accent}" stroke-opacity="0.58"/>
<path d="M29 4v9h9" fill="{soft}" stroke="{accent}" stroke-opacity="0.48" stroke-linejoin="round"/>
<path d="M7 7.5A2.5 2.5 0 0 1 10 5h18" stroke="{fg}" stroke-opacity="0.14"/>
{glyph}
<text x="24" y="52" text-anchor="middle" fill="{accent}" font-size="{label_size}" font-weight="700" letter-spacing="0.5" font-family="Helvetica Neue, sans-serif">{short}</text>"##,
        s2 = css(t.surface2),
        bg = css(t.background),
        fg = css(t.foreground),
    );
    svg_image(&body, 48., 58., w, h)
}

// ---- shared pieces ----

/// `.markie-overlay-section`: 10px semibold uppercase muted label.
pub(crate) fn section_label(text: &str, t: &Tokens) -> Div {
    div()
        .text_size(px(10.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(t.muted)
        .child(spaced_caps(text))
}

/// Uppercase with the 0.08em tracking CSS adds; GPUI has no letter
/// spacing, so a hair space between letters stands in for it.
pub(crate) fn spaced_caps(text: &str) -> String {
    let upper = text.to_uppercase();
    let mut out = String::with_capacity(upper.len() * 2);
    let mut prev: Option<char> = None;
    for ch in upper.chars() {
        if prev.is_some_and(|p| p != ' ') && ch != ' ' {
            out.push('\u{200A}');
        }
        out.push(ch);
        prev = Some(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob export brings its own `test` attribute.
    use super::{css, hex, mix, spaced_caps, templates};

    #[test]
    fn mixes_like_css() {
        let white = hex("#ffffff");
        let black = hex("#000000");
        let grey = mix(white, 0.5, black).to_rgb();
        assert!((grey.r - 0.5).abs() < 0.01 && (grey.a - 1.).abs() < 0.001);
        let faded = mix(white, 0.4, gpui_kit::transparent_black()).to_rgb();
        assert!((faded.a - 0.4).abs() < 0.001 && (faded.r - 1.).abs() < 0.01);
        assert_eq!(css(hex("#60a5fa")), "#60a5fa");
    }

    #[test]
    fn every_template_has_typography() {
        for t in templates() {
            assert!(t.light.font_size.is_some() && t.dark.content_width.is_some(), "{}", t.id);
        }
    }

    #[test]
    fn caps_are_spaced() {
        assert_eq!(spaced_caps("ab c"), "A\u{200A}B C");
    }
}
