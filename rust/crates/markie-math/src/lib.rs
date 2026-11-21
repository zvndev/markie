//! Native math rendering for Markie RS.
//!
//! Markie documents hold LaTeX math the way KaTeX reads it (`$x$` inline,
//! `$$x$$` display). This crate turns that source into a standalone SVG:
//!
//! 1. `mitex` converts the LaTeX to Typst math code.
//! 2. `typst` lays it out with the embedded New Computer Modern Math font,
//!    evaluating the converted code in the mitex Typst scope (vendored from the
//!    official `@preview/mitex` package, see `typst/mitex/`).
//! 3. `typst-svg` writes the page as SVG. Glyphs come out as `<path>` outlines,
//!    so the SVG needs no fonts to rasterize (GPUI uses resvg/usvg).
//!
//! Everything is pure Rust with no system TeX and no network or file access.
//! Errors are values; panics inside the pipeline are caught and turned into
//! [`MathError::Panic`].

mod mitex_convert;
mod spec;
mod world;

pub use world::loaded_families;

use std::collections::HashMap;
use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, LazyLock, Mutex};

use typst::foundations::Label;
use typst::utils::PicoStr;
use typst_layout::PagedDocument;

/// How a formula should look.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MathStyle {
    /// Glyph and rule color as RGBA.
    pub color: [u8; 4],
    /// Base font size in points. Inline math should match the body text size.
    pub font_size_pt: f32,
}

impl Default for MathStyle {
    fn default() -> Self {
        Self { color: [0, 0, 0, 255], font_size_pt: 16.0 }
    }
}

/// A rendered formula.
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    /// A standalone SVG document. Its `width`/`height` attributes are in `pt`.
    pub svg: String,
    /// Width of the SVG in points.
    pub width_pt: f32,
    /// Height of the SVG in points.
    pub height_pt: f32,
    /// Distance from the top of the SVG to the math baseline, in points. Align
    /// this with the surrounding text baseline for inline math.
    pub baseline_pt: f32,
}

/// Why a formula could not be rendered. The editor shows the raw source
/// instead (in red), so these only need to be readable, not structured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MathError {
    /// The source was empty after trimming.
    Empty,
    /// mitex could not convert the LaTeX (syntax it does not understand).
    Convert(String),
    /// Typst rejected the converted code (unknown command, bad arguments...).
    Typeset(String),
    /// The pipeline panicked. Caught so the editor keeps running.
    Panic(String),
}

impl fmt::Display for MathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MathError::Empty => write!(f, "empty formula"),
            MathError::Convert(m) => write!(f, "LaTeX conversion failed: {m}"),
            MathError::Typeset(m) => write!(f, "typesetting failed: {m}"),
            MathError::Panic(m) => write!(f, "math renderer panicked: {m}"),
        }
    }
}

impl std::error::Error for MathError {}

/// Splits a Markdown math span into its TeX body and display flag.
///
/// `"$x$"` gives `("x", false)` and `"$$x$$"` gives `("x", true)`. Display
/// bodies may span lines; whitespace and newlines just inside the delimiters
/// are trimmed. `\(x\)` and `\[x\]` are accepted too. Returns `None` when the
/// source is not delimited math or the body is empty.
pub fn strip_delimiters(source: &str) -> Option<(&str, bool)> {
    let s = source.trim();
    let (body, display) = if let Some(rest) = s.strip_prefix("$$") {
        (rest.strip_suffix("$$")?, true)
    } else if let Some(rest) = s.strip_prefix("\\[") {
        (rest.strip_suffix("\\]")?, true)
    } else if let Some(rest) = s.strip_prefix("\\(") {
        (rest.strip_suffix("\\)")?, false)
    } else {
        (s.strip_prefix('$')?.strip_suffix('$')?, false)
    };
    let body = body.trim();
    if body.is_empty() { None } else { Some((body, display)) }
}

/// Renders TeX math (no delimiters) to SVG.
///
/// `display` selects display style (large operators with limits, full-size
/// fractions), like KaTeX `displayMode`. Never panics.
pub fn render(tex: &str, display: bool, style: &MathStyle) -> Result<Rendered, MathError> {
    let tex = tex.trim();
    if tex.is_empty() {
        return Err(MathError::Empty);
    }
    match catch_unwind(AssertUnwindSafe(|| render_inner(tex, display, style))) {
        Ok(result) => result,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            Err(MathError::Panic(msg))
        }
    }
}

/// Converts TeX to the Typst math code mitex produces. Exposed for debugging
/// and for the docs; the editor only needs [`render`].
pub fn to_typst(tex: &str) -> Result<String, MathError> {
    catch_unwind(|| mitex_convert::convert_math(tex, Some(spec::SPEC.clone())))
        .map_err(|_| MathError::Panic("mitex panicked".into()))?
        .map_err(MathError::Convert)
}

const BASELINE_LABEL: &str = "markie-math-baseline";

fn render_inner(tex: &str, display: bool, style: &MathStyle) -> Result<Rendered, MathError> {
    let code = to_typst(tex)?;
    let main = main_source(&code, display, style);
    let world = world::MathWorld::new(main);
    let warned = typst::compile::<PagedDocument>(&world);
    let doc = warned.output.map_err(|errors| {
        let msgs: Vec<String> = errors.iter().map(|d| d.message.to_string()).collect();
        MathError::Typeset(msgs.join("; "))
    })?;
    let page = doc
        .pages()
        .first()
        .ok_or_else(|| MathError::Typeset("no page produced".into()))?;
    // typst-svg clamps the SVG to at least 1pt on each side; report the same.
    let size = page.frame.size();
    let width_pt = (size.x.to_pt() as f32).max(1.0);
    let height_pt = (size.y.to_pt() as f32).max(1.0);

    // The labelled metadata right after the equation sits on the line's
    // baseline (a zero-size inline item is placed at `top - 0`).
    let label = Label::new(PicoStr::intern(BASELINE_LABEL))
        .ok_or_else(|| MathError::Typeset("bad label".into()))?;
    let introspector = doc.introspector();
    let baseline_pt = introspector
        .elements()
        .query_label(label)
        .ok()
        .and_then(|content| content.location())
        .and_then(|loc| introspector.position(loc))
        .map(|pos| pos.point.y.to_pt() as f32)
        .unwrap_or(height_pt)
        .clamp(0.0, height_pt.max(0.0));

    let svg = typst_svg::svg(page, &typst_svg::SvgOptions::default());
    // Keep typst's global memoization cache bounded: drop entries that were
    // not used in the last few hundred compilations.
    typst::comemo::evict(256);
    Ok(Rendered { svg, width_pt, height_pt, baseline_pt })
}

fn main_source(code: &str, display: bool, style: &MathStyle) -> String {
    let [r, g, b, a] = style.color;
    let size = if style.font_size_pt.is_finite() && style.font_size_pt > 0.0 {
        style.font_size_pt
    } else {
        16.0
    };
    let body = if display { "math.display(markie-eq)" } else { "markie-eq" };
    format!(
        "#set page(width: auto, height: auto, margin: 0pt, fill: none)\n\
         #set text(size: {size}pt, fill: rgb({r}, {g}, {b}, {a}), font: (\"New Computer Modern\", \"New Computer Modern Math\"), top-edge: \"bounds\", bottom-edge: \"bounds\")\n\
         #show math.equation: set text(font: \"New Computer Modern Math\")\n\
         #import \"/markie/scope.typ\": markie-scope\n\
         #let markie-eq = eval({lit}, mode: \"math\", scope: markie-scope)\n\
         #math.equation(block: false, {body})#metadata(none)<{BASELINE_LABEL}>#box(width: 0pt, height: 0pt)\n",
        lit = typst_string_literal(code),
    )
}

fn typst_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Cache key: source, display flag, color, and font size (as bits, so the key
/// is `Eq + Hash`).
type CacheKey = (String, bool, [u8; 4], u32);

/// A thread-safe render cache, so the editor can ask for every formula on
/// every frame. Errors are cached too (a bad formula stays bad until edited).
/// When the cache passes `capacity` entries it is cleared; formulas on screen
/// re-render on the next frame. Simple, and bounded.
pub struct MathCache {
    map: Mutex<HashMap<CacheKey, Arc<Result<Rendered, MathError>>>>,
    capacity: usize,
}

impl MathCache {
    pub fn new(capacity: usize) -> Self {
        Self { map: Mutex::new(HashMap::new()), capacity: capacity.max(1) }
    }

    /// Returns the cached render, rendering on a miss. The lock is not held
    /// while rendering, so two threads may render the same formula once each.
    pub fn get(&self, tex: &str, display: bool, style: &MathStyle) -> Arc<Result<Rendered, MathError>> {
        let key: CacheKey = (tex.to_string(), display, style.color, style.font_size_pt.to_bits());
        if let Some(hit) = self.lock().get(&key) {
            return hit.clone();
        }
        let rendered = Arc::new(render(tex, display, style));
        let mut map = self.lock();
        if map.len() >= self.capacity {
            map.clear();
        }
        map.insert(key, rendered.clone());
        rendered
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<CacheKey, Arc<Result<Rendered, MathError>>>> {
        // A panic while holding the lock cannot leave the map half-written in
        // a way that matters (insert/clear are atomic for our purposes).
        self.map.lock().unwrap_or_else(|poison| poison.into_inner())
    }
}

impl Default for MathCache {
    fn default() -> Self {
        Self::new(2048)
    }
}

/// A process-wide cache for callers that do not want to own one.
pub fn global_cache() -> &'static MathCache {
    static CACHE: LazyLock<MathCache> = LazyLock::new(MathCache::default);
    &CACHE
}

/// Renders through [`global_cache`].
pub fn render_cached(tex: &str, display: bool, style: &MathStyle) -> Arc<Result<Rendered, MathError>> {
    global_cache().get(tex, display, style)
}

/// Loads fonts and the mitex scope ahead of time so the first visible formula
/// does not pay for it. Safe to call from a background thread at startup.
pub fn warm_up() {
    let _ = render("x", false, &MathStyle::default());
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn delimiters() {
        assert_eq!(strip_delimiters("$x$"), Some(("x", false)));
        assert_eq!(strip_delimiters("$$x$$"), Some(("x", true)));
        assert_eq!(strip_delimiters("$$\n  a + b\n  = c\n$$"), Some(("a + b\n  = c", true)));
        assert_eq!(strip_delimiters("  $ x^2 $  "), Some(("x^2", false)));
        assert_eq!(strip_delimiters("\\[x\\]"), Some(("x", true)));
        assert_eq!(strip_delimiters("\\(x\\)"), Some(("x", false)));
        assert_eq!(strip_delimiters("$$"), None);
        assert_eq!(strip_delimiters("$$ $$"), None);
        assert_eq!(strip_delimiters("$x"), None);
        assert_eq!(strip_delimiters("x"), None);
        assert_eq!(strip_delimiters(""), None);
    }

    #[test]
    fn literal_escaping() {
        assert_eq!(typst_string_literal("a\\b\"c\nd"), "\"a\\\\b\\\"c\\nd\"");
    }
}
