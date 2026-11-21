//! On-screen adaptation of authored run colors to the page, ported from
//! `src/components/documents/word-colors.ts`. The result only reaches the
//! painted text; save and export keep the authored color.

pub type Rgb = [u8; 3];

/// Below this the authored color is treated as unreadable on the page.
pub const MIN_RUN_CONTRAST: f64 = 3.0;
/// An adapted color is pushed at least this far, so it reads as body text.
pub const ADAPTED_RUN_CONTRAST: f64 = 4.5;

/// How a run color is painted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunColor {
    /// Paint this color.
    Rgb(Rgb),
    /// Paint the page's own text color.
    PageText,
}

/// A six-digit hex color as the engine stores it (no `#`).
pub fn parse_hex(value: &str) -> Option<Rgb> {
    let raw = value.trim().trim_start_matches('#');
    if raw.len() != 6 || !raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&raw[i..i + 2], 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

fn luminance([r, g, b]: Rgb) -> f64 {
    let linear = |c: u8| {
        let v = c as f64 / 255.0;
        if v <= 0.03928 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

pub fn contrast_ratio(a: Rgb, b: Rgb) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    let (light, dark) = if x >= y { (x, y) } else { (y, x) };
    (light + 0.05) / (dark + 0.05)
}

fn to_hsl([r, g, b]: Rgb) -> (f64, f64, f64) {
    let (red, green, blue) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let max = red.max(green).max(blue);
    let min = red.min(green).min(blue);
    let lightness = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, lightness);
    }
    let delta = max - min;
    let saturation = if lightness > 0.5 { delta / (2.0 - max - min) } else { delta / (max + min) };
    let hue = if max == red {
        (green - blue) / delta + if green < blue { 6.0 } else { 0.0 }
    } else if max == green {
        (blue - red) / delta + 2.0
    } else {
        (red - green) / delta + 4.0
    };
    (hue / 6.0, saturation, lightness)
}

/// JavaScript `Math.round` on a channel.
fn round(value: f64) -> u8 {
    (value + 0.5).floor().clamp(0.0, 255.0) as u8
}

fn from_hsl(hue: f64, saturation: f64, lightness: f64) -> Rgb {
    if saturation == 0.0 {
        let v = round(lightness * 255.0);
        return [v, v, v];
    }
    let q = if lightness < 0.5 { lightness * (1.0 + saturation) } else { lightness + saturation - lightness * saturation };
    let p = 2.0 * lightness - q;
    let channel = |t: f64| {
        let x = if t < 0.0 { t + 1.0 } else if t > 1.0 { t - 1.0 } else { t };
        if x < 1.0 / 6.0 {
            p + (q - p) * 6.0 * x
        } else if x < 0.5 {
            q
        } else if x < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - x) * 6.0
        } else {
            p
        }
    };
    [round(channel(hue + 1.0 / 3.0) * 255.0), round(channel(hue) * 255.0), round(channel(hue - 1.0 / 3.0) * 255.0)]
}

/// The painted color for an authored run color on a page of `page`.
///
/// - Readable as authored (contrast at least 3:1): keep it exactly.
/// - Near-black or near-white neutral: use the page's text color.
/// - Anything else: keep hue and saturation, mirror lightness to the page's
///   readable side, then step until it reaches 4.5:1.
pub fn display_run_color(authored: &str, page: Rgb) -> Option<RunColor> {
    let color = parse_hex(authored)?;
    if contrast_ratio(color, page) >= MIN_RUN_CONTRAST {
        return Some(RunColor::Rgb(color));
    }
    let (hue, saturation, lightness) = to_hsl(color);
    let max = *color.iter().max().unwrap() as f64;
    let min = *color.iter().min().unwrap() as f64;
    let chroma = (max - min) / 255.0;
    if chroma < 0.1 && (lightness <= 0.25 || lightness >= 0.75) {
        return Some(RunColor::PageText);
    }
    let dark_page = contrast_ratio([255, 255, 255], page) > contrast_ratio([0, 0, 0], page);
    let mut next = if dark_page { lightness.max(1.0 - lightness) } else { lightness.min(1.0 - lightness) };
    let mut candidate = from_hsl(hue, saturation, next);
    while contrast_ratio(candidate, page) < ADAPTED_RUN_CONTRAST && if dark_page { next < 1.0 } else { next > 0.0 } {
        next = if dark_page { (next + 0.02).min(1.0) } else { (next - 0.02).max(0.0) };
        candidate = from_hsl(hue, saturation, next);
    }
    Some(RunColor::Rgb(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHITE: Rgb = [255, 255, 255];
    const DARK: Rgb = [0x1e, 0x1e, 0x1e];

    #[test]
    fn readable_colors_are_kept_exactly() {
        assert_eq!(display_run_color("c00000", WHITE), Some(RunColor::Rgb([0xc0, 0, 0])));
        assert_eq!(display_run_color("000000", WHITE), Some(RunColor::Rgb([0, 0, 0])));
    }

    #[test]
    fn neutral_extremes_use_the_page_text_color() {
        assert_eq!(display_run_color("ffffff", WHITE), Some(RunColor::PageText));
        assert_eq!(display_run_color("000000", DARK), Some(RunColor::PageText));
    }

    #[test]
    fn pale_hues_are_mirrored_until_readable() {
        let Some(RunColor::Rgb(adapted)) = display_run_color("ffff99", WHITE) else { panic!("expected a color") };
        assert!(contrast_ratio(adapted, WHITE) >= ADAPTED_RUN_CONTRAST);
        // The hue stays yellow: red and green stay close and above blue.
        assert!(adapted[0].abs_diff(adapted[1]) < 16 && adapted[2] < adapted[0]);
    }

    #[test]
    fn dark_hues_lighten_on_a_dark_page() {
        let Some(RunColor::Rgb(adapted)) = display_run_color("1f3864", DARK) else { panic!("expected a color") };
        assert!(contrast_ratio(adapted, DARK) >= ADAPTED_RUN_CONTRAST);
        assert!(adapted[2] > adapted[0]);
    }

    #[test]
    fn invalid_colors_are_ignored() {
        assert_eq!(display_run_color("auto", WHITE), None);
        assert_eq!(display_run_color("12345", WHITE), None);
    }
}
