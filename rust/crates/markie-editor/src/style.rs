//! How a document page looks, from the style template and the toolbar:
//! the values `src/lib/theme.ts` (`typographyVars`) and
//! `src/lib/doc-appearance.ts` put in CSS variables for `.markdown-body`.
//!
//! Nothing here touches the file. Like Electron, font, size, zoom and page
//! width are a way of looking at the document.

use gpui_kit::*;

/// The template's typography and the one colour GPUI Kit's theme has no
/// slot for (`docRule`, the quiet hairline inside documents).
#[derive(Clone, Debug, PartialEq)]
pub struct DocStyle {
    /// A `TYPEFACES` id (`system`, `charter`, ...).
    pub body_font: String,
    /// A `TYPEFACES` id, or `body` for "same as the body".
    pub heading_font: String,
    pub line_height: f32,
    /// em between paragraphs.
    pub paragraph_gap: f32,
    /// px, the body size at 100%.
    pub font_size: f32,
    /// px, the reading column at the "Default" width.
    pub content_width: f32,
    pub doc_rule: Hsla,
    /// `--blue`: the template's link colour (links, checked boxes).
    pub link: Hsla,
}

impl Default for DocStyle {
    /// Markie's own template (`DEFAULT_TYPOGRAPHY`).
    fn default() -> Self {
        DocStyle {
            body_font: "system".into(),
            heading_font: "body".into(),
            line_height: 1.75,
            paragraph_gap: 0.8,
            font_size: 16.0,
            content_width: 768.0,
            doc_rule: rgb(0x27272a).into(),
            link: rgb(0x60a5fa).into(),
        }
    }
}

/// The system serif design, New York. macOS hides it from font lists, so
/// "New York" finds no family; Electron's stack reaches it through
/// `ui-serif`, which is this family.
pub const SYSTEM_SERIF: &str = ".AppleSystemUIFontSerif";

/// `TYPEFACES` as macOS family names. `system` and `mono` are the app's
/// own faces, so they are left to the caller (None).
pub fn typeface(id: &str) -> Option<&'static str> {
    Some(match id {
        "humanist" => "Avenir Next",
        "helvetica" => "Helvetica Neue",
        "optima" => "Optima",
        "charter" => "Charter",
        "iowan" => "Iowan Old Style",
        "newyork" => SYSTEM_SERIF,
        "georgia" => "Georgia",
        _ => return None,
    })
}

/// The toolbar's fonts (`DOC_FONTS` in `doc-appearance.ts`): id, label, and
/// the CSS stack the `fontFamily` mark stores when it styles a selection.
pub const DOC_FONTS: [(&str, &str, &str); 7] = [
    ("system", "Theme font", ""),
    ("sans", "System", "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"),
    ("charter", "Charter", "Charter, Georgia, 'Times New Roman', serif"),
    ("georgia", "Georgia", "Georgia, Charter, serif"),
    ("iowan", "Iowan", "'Iowan Old Style', Palatino, Georgia, serif"),
    ("helvetica", "Helvetica", "'Helvetica Neue', Helvetica, Arial, sans-serif"),
    ("mono", "Monospace", "'SF Mono', ui-monospace, Menlo, monospace"),
];

/// `ZOOM_STEPS`.
pub const ZOOM_STEPS: [f32; 8] = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];

/// The next zoom preset from `current` (`stepZoom`): presses land on round
/// numbers rather than on 1.331.
pub fn step_zoom(current: f32, up: bool) -> f32 {
    let nearest = ZOOM_STEPS
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1 - current).abs().total_cmp(&(b.1 - current).abs()))
        .map(|(i, _)| i)
        .unwrap_or(3);
    let next = if up { (nearest + 1).min(ZOOM_STEPS.len() - 1) } else { nearest.saturating_sub(1) };
    ZOOM_STEPS[next]
}

/// `createPinchZoom` in `src/lib/document-zoom.ts`: a trackpad pinch (and
/// ctrl + scroll) arrives as many small deltas, collected so one deliberate
/// pinch moves one or two zoom steps. Deltas are in Chromium's wheel units:
/// positive `delta_y` zooms out.
#[derive(Default)]
pub struct PinchZoom {
    total: f32,
    last_ms: f64,
}

pub const PINCH_STEP: f32 = 60.;
pub const PINCH_IDLE_MS: f64 = 220.;

impl PinchZoom {
    /// The steps to take for one event: +1 zooms in, -1 zooms out.
    pub fn feed(&mut self, delta_y: f32, at_ms: f64) -> Vec<i8> {
        if at_ms - self.last_ms > PINCH_IDLE_MS {
            self.total = 0.;
        }
        self.last_ms = at_ms;
        self.total += delta_y;
        let mut steps = Vec::new();
        while self.total.abs() >= PINCH_STEP {
            let direction: i8 = if self.total < 0. { 1 } else { -1 };
            self.total += f32::from(direction) * PINCH_STEP;
            steps.push(direction);
        }
        steps
    }

    /// A platform pinch's magnification as the ctrl+wheel delta Chromium
    /// synthesizes for it (`-100 · ln(scale)`).
    pub fn wheel_delta_for_magnification(delta: f32) -> f32 {
        -100. * (1. + delta).max(0.01).ln()
    }
}

/// `zoomLabel`.
pub fn zoom_label(zoom: f32) -> String {
    format!("{}%", (zoom * 100.0).round() as i32)
}

/// `WIDTH_STEPS`: the reading column. 0 is "default" (the template's
/// width) and infinity is "full".
pub const WIDTH_STEPS: [f32; 5] = [0.0, 900.0, 1040.0, 1200.0, f32::INFINITY];

/// The step a stored width is nearest to. Older settings held a free pixel
/// width; 768, the old default, reads as "default".
pub fn width_index(width: f32) -> usize {
    if width <= 0.0 || (width - 768.0).abs() < 1.0 {
        return 0;
    }
    if !width.is_finite() || width >= 1600.0 {
        return 4;
    }
    (1..4).min_by(|a, b| (WIDTH_STEPS[*a] - width).abs().total_cmp(&(WIDTH_STEPS[*b] - width).abs())).unwrap_or(1)
}

/// `stepWidth`, clamped at the ends.
pub fn step_width(width: f32, wider: bool) -> f32 {
    let i = width_index(width);
    let next = if wider { (i + 1).min(WIDTH_STEPS.len() - 1) } else { i.saturating_sub(1) };
    WIDTH_STEPS[next]
}

/// `widthLabel`.
pub fn width_label(width: f32) -> String {
    match width_index(width) {
        0 => "Default".into(),
        4 => "Full".into(),
        i => format!("{} px", WIDTH_STEPS[i] as u32),
    }
}

/// `MIN_FONT_SIZE` and `MAX_FONT_SIZE`.
pub fn clamp_font_size(size: f32) -> f32 {
    size.round().clamp(11.0, 32.0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn pinch_collects_like_document_zoom_ts() {
        let mut p = super::PinchZoom::default();
        // Small deltas add up to one step; the remainder carries.
        assert!(p.feed(-30., 1000.).is_empty());
        assert_eq!(p.feed(-40., 1010.), vec![1]);
        assert!(p.feed(-45., 1020.).is_empty());
        // A pause longer than 220 ms starts over.
        assert!(p.feed(-50., 1300.).is_empty());
        assert_eq!(p.feed(130., 1310.), vec![-1]);
        assert_eq!(p.feed(200., 1320.), vec![-1, -1, -1]);
        assert!(super::PinchZoom::wheel_delta_for_magnification(0.1) < 0.);
    }

    use super::{step_width, step_zoom, width_label, zoom_label};

    #[test]
    fn zoom_steps_like_electron() {
        assert_eq!(step_zoom(1.0, true), 1.1);
        assert_eq!(step_zoom(1.0, false), 0.9);
        assert_eq!(step_zoom(2.0, true), 2.0);
        assert_eq!(step_zoom(0.5, false), 0.5);
        assert_eq!(step_zoom(1.3, true), 1.5);
        assert_eq!(zoom_label(1.25), "125%");
    }

    #[test]
    fn width_steps_like_electron() {
        assert_eq!(width_label(768.0), "Default");
        assert_eq!(width_label(0.0), "Default");
        assert_eq!(step_width(768.0, true), 900.0);
        assert_eq!(step_width(0.0, false), 0.0);
        assert_eq!(width_label(1040.0), "1040 px");
        assert_eq!(width_label(step_width(1200.0, true)), "Full");
        assert_eq!(step_width(f32::INFINITY, true), f32::INFINITY);
    }
}
