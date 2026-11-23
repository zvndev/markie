//! Math for HTML exports, as KaTeX's own HTML.
//!
//! Electron runs rehype-katex, which replaces remark-math's placeholders with
//! `katex.renderToString` output, and the sanitizer then filters that HTML.
//! Markie RS does the same with katex-rs, a Rust port of KaTeX: the same
//! `span.katex` tree with KaTeX's font classes and em offsets, drawn by the
//! browser with the KaTeX stylesheet and fonts Electron embeds
//! ([`crate::styles::KATEX_CSS`]). So a formula in an exported page is laid out
//! and inked exactly as Electron's is. The PDF path draws math with
//! markie-math instead (pdf.rs), because Typst cannot read HTML.
//!
//! A formula KaTeX cannot parse becomes `span.katex-error` with the source and
//! KaTeX's message as its title, as rehype-katex writes it.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::OnceLock;

use katex::{KatexContext, Settings, StrictMode, StrictSetting};

use crate::hast::{self, Element, Node};
use crate::sanitize;

/// TeX that KaTeX refuses but markie-math would draw: a bare `$` is a
/// math-shift character, which KaTeX cannot use inside math. The PDF path
/// asks this before drawing with markie-math.
pub(crate) fn katex_rejects(tex: &str) -> Option<String> {
    let mut escaped = false;
    for (i, c) in tex.char_indices() {
        match c {
            '\\' => escaped = !escaped,
            '$' if !escaped => return Some(format!("KaTeX parse error: Can't use function '$' in math mode at position {}", tex[..i].chars().count() + 1)),
            _ => escaped = false,
        }
    }
    None
}

/// Built once: KaTeX's function, symbol and macro tables.
fn context() -> &'static KatexContext {
    static CONTEXT: OnceLock<KatexContext> = OnceLock::new();
    CONTEXT.get_or_init(KatexContext::default)
}

/// rehype-katex's options: none, so KaTeX's defaults, with `displayMode` and
/// `throwOnError: true`. Strict "warn" would print to stderr and changes no
/// output, so it is "ignore" here.
fn settings(display: bool) -> Settings {
    Settings { display_mode: display, throw_on_error: true, strict: StrictSetting::Mode(StrictMode::Ignore), ..Settings::default() }
}

/// `katex.renderToString`, or the title of rehype-katex's error markup.
fn render(tex: &str, display: bool) -> Result<String, String> {
    match catch_unwind(AssertUnwindSafe(|| katex::render_to_string(context(), tex, &settings(display)))) {
        Ok(Ok(html)) => Ok(html),
        // KaTeX's `renderError`: `error.toString()` is "ParseError: " and the message.
        Ok(Err(e)) => Err(format!("ParseError: {e}")),
        Err(_) => Err("Error: KaTeX could not render this formula".to_string()),
    }
}

/// The order KaTeX writes attributes in: a span's class, then its style,
/// then the rest; an SVG's as every KaTeX call site lists them. katex-rs keeps
/// them in a hash map, so its order is arbitrary.
const KATEX_ATTRIBUTE_ORDER: &[&str] =
    &["xmlns", "class", "width", "height", "style", "viewBox", "preserveAspectRatio", "display", "x1", "y1", "x2", "y2", "d", "encoding"];

fn katex_attribute_order(nodes: &mut [Node]) {
    hast::walk_mut(nodes, &mut |e| {
        e.attrs.sort_by_key(|(name, _)| KATEX_ATTRIBUTE_ORDER.iter().position(|k| k == name).unwrap_or(KATEX_ATTRIBUTE_ORDER.len()));
    });
}

/// KaTeX's HTML as tree nodes, filtered as Electron filters it: rehype-katex
/// runs before rehype-sanitize and rehype-contain-styles there.
fn math_nodes(tex: &str, display: bool) -> Vec<Node> {
    let (html, ok) = match render(tex, display) {
        Ok(html) => (html, true),
        Err(title) => (
            format!(
                "<span class=\"katex-error\" title=\"{}\" style=\"color:#cc0000\">{}</span>",
                hast::escape_attr(&title),
                hast::escape_text(tex)
            ),
            false,
        ),
    };
    static SCHEMA: OnceLock<sanitize::Schema> = OnceLock::new();
    let mut nodes = SCHEMA.get_or_init(sanitize::export_schema).sanitize(hast::parse_fragment(&html));
    sanitize::contain_styles(&mut nodes);
    if ok {
        katex_attribute_order(&mut nodes);
    }
    nodes
}

/// The formula an element stands for, as rehype-katex picks it: any element
/// with a math class is replaced (display if `math-display`), except that
/// `code.language-math` inside a `pre` replaces the `pre` and is display.
fn formula_of(e: &Element) -> Option<(String, bool)> {
    let math_class = |e: &Element| e.has_class("language-math") || e.has_class("math-display") || e.has_class("math-inline");
    if e.tag == "pre"
        && e.children.iter().any(|c| matches!(c, Node::Element(code) if code.tag == "code" && code.has_class("language-math")))
    {
        return Some((e.text(), true));
    }
    math_class(e).then(|| (e.text(), e.has_class("math-display")))
}

/// Replaces math placeholders in `nodes` with KaTeX's HTML: `code.math-inline`
/// in place, and a `pre` holding `code.math-display` (or a fenced `math`
/// block) as a display formula.
pub fn draw_math(nodes: &mut Vec<Node>) {
    let mut i = 0;
    while i < nodes.len() {
        let Node::Element(e) = &mut nodes[i] else {
            i += 1;
            continue;
        };
        match formula_of(e) {
            Some((tex, display)) => {
                let replacement = math_nodes(&tex, display);
                let len = replacement.len();
                nodes.splice(i..=i, replacement);
                i += len;
            }
            None => {
                draw_math(&mut e.children);
                i += 1;
            }
        }
    }
}
