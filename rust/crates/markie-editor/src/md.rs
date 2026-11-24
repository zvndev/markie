//! What a Markdown style (`markie_core::markdown_style`) means for the page,
//! as numbers the renderer draws with. Each function is the native reading of
//! the CSS rules Electron writes for the same option (`CHOICE_RULES` and
//! `numberRules` in `src/lib/markdown-style.ts`), over the Spacious rules of
//! `globals.css`. With Spacious every function answers what the renderer
//! always drew.

use markie_core::markdown_style::Resolved;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HeadingRule {
    None,
    /// The hairline under the heading (`border-bottom`).
    Line,
    /// A short bar in the link colour (`headingRule: short`).
    Short,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Heading {
    /// Size in em of the body.
    pub size: f32,
    pub weight: f32,
    /// Margins in em of the heading itself.
    pub top: f32,
    pub bottom: f32,
    pub rule: HeadingRule,
    /// `padding-bottom` over the hairline, in em of the heading.
    pub pad_bottom: f32,
    pub upper: bool,
    pub small_caps: bool,
    /// `letter-spacing` in em of the heading.
    pub tracking: f32,
    pub center: bool,
}

/// `h1` to `h6` in a style.
pub fn heading(md: &Resolved, level: u8) -> Heading {
    let i = (level.clamp(1, 6) - 1) as usize;
    let sizes: [f32; 6] = match md.choice("headingScale") {
        "compact" => [1.6, 1.3, 1.12, 1.0, 0.92, 0.92],
        "large" => [2.5, 1.8, 1.35, 1.15, 1.0, 1.0],
        "flat" => [1.4, 1.2, 1.05, 1.0, 1.0, 1.0],
        _ => [2.0, 1.5, 1.25, 1.1, 1.0, 1.0],
    };
    let weights: [f32; 3] = match md.choice("headingWeight") {
        "medium" => [600., 600., 550.],
        "light" => [400., 400., 500.],
        "heavy" => [800., 750., 700.],
        _ => [700., 650., 600.],
    };
    let (top, bottom) = [(1.5, 0.6), (1.4, 0.5), (1.3, 0.4), (1.2, 0.4), (1.0, 0.3), (1.0, 0.3)][i];
    let (rule, pad_bottom) = match (md.choice("headingRule"), level) {
        ("underline", 1) | ("title", 1) => (HeadingRule::Line, 0.3),
        ("underline", 2) => (HeadingRule::Line, 0.25),
        ("short", 1 | 2) => (HeadingRule::Short, 0.),
        _ => (HeadingRule::None, 0.),
    };
    let (upper, small_caps, tracking) = match (md.choice("headingCase"), level) {
        ("upper", _) => (true, false, 0.04),
        ("upper-minor", 4..) => (true, false, 0.08),
        ("small-caps", _) => (false, true, 0.03),
        _ => (false, false, 0.),
    };
    let center = match md.choice("headingAlign") {
        "center-title" => level == 1,
        "center" => level <= 3,
        _ => false,
    };
    Heading {
        size: sizes[i],
        weight: weights[i.min(2)],
        top: top * md.number("headingSpaceAbove") as f32,
        bottom: bottom * md.number("headingSpaceBelow") as f32,
        rule,
        pad_bottom,
        upper,
        small_caps,
        tracking,
        center,
    }
}

/// The marker before a bulleted item.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Bullet {
    Disc,
    /// `list-style-type: circle`: a ring.
    Circle,
    Square,
    /// A string marker, drawn as text ("\u{2013}\u{2002}").
    Text(&'static str),
}

/// `bulletStyle` for a list with `ul_depth` bulleted or task lists above it.
pub fn bullet(md: &Resolved, ul_depth: u8) -> Bullet {
    match md.choice("bulletStyle") {
        "nested" => match ul_depth {
            0 => Bullet::Disc,
            1 => Bullet::Circle,
            _ => Bullet::Square,
        },
        "dash" => Bullet::Text("\u{2013}\u{2002}"),
        "square" => Bullet::Square,
        "hollow" => Bullet::Circle,
        "arrow" => Bullet::Text("\u{2192}\u{2002}"),
        _ => Bullet::Disc,
    }
}

/// CSS `lower-alpha`: a, b, ... z, aa, ab.
pub fn alpha(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        n -= 1;
        out.push(b'a' + (n % 26) as u8);
        n /= 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// CSS `lower-roman` (decimal outside 1 to 3999, as browsers fall back).
pub fn roman(mut n: u64) -> String {
    if n == 0 || n > 3999 {
        return n.to_string();
    }
    let mut out = String::new();
    for (value, glyph) in [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")] {
        while n >= value {
            out.push_str(glyph);
            n -= value;
        }
    }
    out
}

/// A numbered item's marker, without the space CSS puts after it. `number`
/// is the item's own number (its list's start plus its place), `ol_depth`
/// how many numbered lists are above this one, and `path` the place of each
/// of those lists' current items, outermost first, for legal numbering.
pub fn ordered_marker(md: &Resolved, number: u64, place: u64, ol_depth: u8, path: &[u32]) -> String {
    match md.choice("orderedStyle") {
        "paren" => format!("{number})"),
        "alpha" => format!("{}.", alpha(number)),
        "roman" => format!("{}.", roman(number)),
        "outline" => match ol_depth {
            0 => format!("{number}."),
            1 => format!("{}.", alpha(number)),
            _ => format!("{}.", roman(number)),
        },
        // `counters(markie-ol, ".") ". "`: its own counter, which starts at one.
        "legal" => {
            let mut parts: Vec<String> = path.iter().map(|n| n.to_string()).collect();
            parts.push(place.to_string());
            format!("{}.", parts.join("."))
        }
        _ => format!("{number}."),
    }
}

/// A table cell's padding (x, y) in em of the table's text, or None for a
/// header cell left with the browser's own 1px.
pub fn cell_padding(md: &Resolved, header: bool) -> Option<(f32, f32)> {
    match (md.choice("tableDensity"), header) {
        ("compact", true) => Some((0.65, 0.3)),
        ("compact", false) => Some((0.65, 0.28)),
        ("roomy", true) => Some((1.2, 0.8)),
        ("roomy", false) => Some((1.2, 0.75)),
        (_, true) => None,
        (_, false) => Some((1.0, 0.55)),
    }
}

/// A paragraph's margins (top, bottom) in em of its own text.
///
/// - In a task item: none.
/// - In a quote: 0.3em, unless paragraphs are indented and the block gap is
///   untouched; then none, with 0.5em between two of them.
/// - Elsewhere: the template's gap times the style's block gap, or none when
///   paragraphs are indented.
pub fn paragraph_margins(md: &Resolved, gap: f32, task: bool, quote: bool, after_paragraph: bool) -> (f32, f32) {
    if task {
        return (0., 0.);
    }
    let g = md.number("blockGap") as f32;
    let indented = md.choice("paragraphStyle") == "indented";
    if quote {
        if (g - 1.).abs() > f32::EPSILON || !indented {
            let top = if indented && after_paragraph { 0.5 } else { 0.3 };
            return (top, 0.3);
        }
        return (if after_paragraph { 0.5 } else { 0. }, 0.);
    }
    if indented { (0., 0.) } else { (gap * g, gap * g) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use markie_core::markdown_style::{MarkdownStyle, resolve};

    fn preset(id: &str) -> Resolved {
        resolve(&MarkdownStyle::preset(id))
    }

    #[test]
    fn spacious_is_what_the_renderer_always_drew() {
        let md = Resolved::default();
        let got: Vec<_> = (1..=6).map(|l| heading(&md, l)).map(|h| (h.size, h.top, h.bottom, h.weight)).collect();
        assert_eq!(got, [(2.0, 1.5, 0.6, 700.), (1.5, 1.4, 0.5, 650.), (1.25, 1.3, 0.4, 600.), (1.1, 1.2, 0.4, 600.), (1.0, 1.0, 0.3, 600.), (1.0, 1.0, 0.3, 600.)]);
        assert_eq!((heading(&md, 1).rule, heading(&md, 1).pad_bottom), (HeadingRule::Line, 0.3));
        assert_eq!((heading(&md, 2).rule, heading(&md, 2).pad_bottom), (HeadingRule::Line, 0.25));
        assert_eq!(heading(&md, 3).rule, HeadingRule::None);
        assert!((1..=6).all(|l| !heading(&md, l).upper && !heading(&md, l).center && heading(&md, l).tracking == 0.));
        assert_eq!((0..4).map(|d| bullet(&md, d)).collect::<Vec<_>>(), [Bullet::Disc; 4]);
        assert_eq!(ordered_marker(&md, 3, 1, 2, &[1, 4]), "3.");
        assert_eq!(cell_padding(&md, false), Some((1.0, 0.55)));
        assert_eq!(cell_padding(&md, true), None);
        assert_eq!(paragraph_margins(&md, 0.8, false, false, true), (0.8, 0.8));
        assert_eq!(paragraph_margins(&md, 0.8, false, true, true), (0.3, 0.3));
        assert_eq!(paragraph_margins(&md, 0.8, true, false, false), (0., 0.));
    }

    #[test]
    fn each_preset_reads_as_its_css() {
        let compact = preset("compact");
        assert_eq!(heading(&compact, 1).size, 1.6);
        assert_eq!(heading(&compact, 5).size, 0.92);
        assert_eq!(heading(&compact, 1).rule, HeadingRule::None);
        assert!((heading(&compact, 2).top - 1.4 * 0.65).abs() < 1e-6);
        assert!((heading(&compact, 2).bottom - 0.5 * 0.6).abs() < 1e-6);
        assert_eq!((bullet(&compact, 0), bullet(&compact, 1), bullet(&compact, 2), bullet(&compact, 5)), (Bullet::Disc, Bullet::Circle, Bullet::Square, Bullet::Square));
        assert_eq!(cell_padding(&compact, true), Some((0.65, 0.3)));
        let (top, _) = paragraph_margins(&compact, 0.8, false, false, false);
        assert!((top - 0.52).abs() < 1e-6);
        assert_eq!(paragraph_margins(&compact, 0.8, false, true, true), (0.3, 0.3));

        let classic = preset("classic");
        let h1 = heading(&classic, 1);
        assert_eq!((h1.size, h1.weight, h1.rule, h1.center), (2.5, 400., HeadingRule::None, true));
        assert!(heading(&classic, 3).center && !heading(&classic, 4).center);
        assert_eq!(heading(&classic, 3).weight, 500.);
        assert_eq!(paragraph_margins(&classic, 0.8, false, false, true), (0., 0.));
        assert_eq!(paragraph_margins(&classic, 0.8, false, true, false), (0., 0.));
        assert_eq!(paragraph_margins(&classic, 0.8, false, true, true), (0.5, 0.));

        let technical = preset("technical");
        assert_eq!((heading(&technical, 1).rule, heading(&technical, 2).rule), (HeadingRule::Line, HeadingRule::None));
        let h4 = heading(&technical, 4);
        assert_eq!((h4.upper, h4.tracking), (true, 0.08));
        assert!(!heading(&technical, 3).upper);
        assert_eq!(ordered_marker(&technical, 7, 2, 1, &[3]), "3.2.");
        assert_eq!(ordered_marker(&technical, 7, 2, 0, &[]), "2.");

        let editorial = preset("editorial");
        assert_eq!((heading(&editorial, 1).rule, heading(&editorial, 2).rule, heading(&editorial, 3).rule), (HeadingRule::Short, HeadingRule::Short, HeadingRule::None));
        assert_eq!((heading(&editorial, 1).weight, heading(&editorial, 2).weight, heading(&editorial, 4).weight), (800., 750., 700.));
        assert_eq!(bullet(&editorial, 0), Bullet::Square);
        assert_eq!(cell_padding(&editorial, false), Some((1.2, 0.75)));

        let minimal = preset("minimal");
        assert_eq!(bullet(&minimal, 3), Bullet::Text("\u{2013}\u{2002}"));
        assert_eq!(ordered_marker(&minimal, 4, 4, 0, &[]), "4)");
        assert_eq!(heading(&minimal, 1).size, 1.4);
    }

    #[test]
    fn counters_count_as_css_does() {
        assert_eq!([1, 2, 26, 27, 52, 53, 703].map(alpha), ["a", "b", "z", "aa", "az", "ba", "aaa"]);
        assert_eq!([1, 4, 9, 14, 40, 1994, 3999].map(roman), ["i", "iv", "ix", "xiv", "xl", "mcmxciv", "mmmcmxcix"]);
        assert_eq!(roman(4000), "4000");
        let outline = resolve(&markie_core::markdown_style::sanitize(&serde_json::json!({ "base": "spacious", "choices": { "orderedStyle": "outline" } })).unwrap());
        assert_eq!((ordered_marker(&outline, 2, 2, 0, &[]), ordered_marker(&outline, 2, 2, 1, &[1]), ordered_marker(&outline, 2, 2, 2, &[1, 1])), ("2.".to_string(), "b.".to_string(), "ii.".to_string()));
    }
}
