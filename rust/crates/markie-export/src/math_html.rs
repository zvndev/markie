//! Math for HTML exports, drawn by markie-math (the editor's renderer).
//!
//! rehype-katex turns remark-math's placeholders into KaTeX HTML plus a 240 KB
//! stylesheet of embedded fonts. Markie RS draws the same TeX with the same
//! Computer Modern look as inline SVG, inside the wrappers KaTeX uses
//! (`span.katex`, `span.katex-display`), so the export stylesheet's math rules
//! still apply. A formula that does not parse becomes `span.katex-error` with
//! the source, as rehype-katex does.

use crate::hast::{Element, Node, escape_attr, escape_text};

/// Export body text is 14px and `.katex` is 1.05em of it.
pub const MATH_FONT_PT: f32 = 14.0 * 1.05 * 0.75;

fn is_math(e: &Element, kind: &str) -> bool {
    e.tag == "code" && e.has_class("language-math") && e.has_class(kind)
}

fn svg_markup(tex: &str, display: bool, color: [u8; 4]) -> Result<String, String> {
    let style = markie_math::MathStyle { color, font_size_pt: MATH_FONT_PT };
    let rendered = markie_math::render_cached(tex, display, &style);
    match rendered.as_ref() {
        Ok(r) => {
            let svg = r.svg.trim_start_matches("<?xml version=\"1.0\" encoding=\"utf-8\"?>").trim();
            // Line the formula's baseline up with the text baseline.
            let drop = (r.height_pt - r.baseline_pt).max(0.0);
            let svg = svg.replacen("<svg ", &format!("<svg style=\"vertical-align: -{drop:.3}pt\" aria-hidden=\"true\" "), 1);
            Ok(format!(
                "<span class=\"katex\"><span class=\"katex-mathml\" hidden>{}</span>{svg}</span>",
                escape_text(tex)
            ))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn error_markup(tex: &str, message: &str) -> String {
    format!(
        "<span class=\"katex-error\" title=\"{}\" style=\"color:#cc0000\">{}</span>",
        escape_attr(&format!("ParseError: {message}")),
        escape_text(tex)
    )
}

/// Replaces math placeholders in `nodes` with drawn formulas.
pub fn draw_math(nodes: &mut Vec<Node>, color: [u8; 4]) {
    for node in nodes.iter_mut() {
        let Node::Element(e) = node else { continue };
        if is_math(e, "math-inline") {
            let tex = e.text();
            *node = Node::Raw(svg_markup(&tex, false, color).unwrap_or_else(|m| error_markup(&tex, &m)));
            continue;
        }
        if e.tag == "pre"
            && let Some(Node::Element(code)) = e.children.iter().find(|c| matches!(c, Node::Element(_)))
            && is_math(code, "math-display")
        {
            let tex = code.text();
            let html = match svg_markup(&tex, true, color) {
                Ok(inner) => format!("<span class=\"katex-display\">{inner}</span>"),
                Err(m) => error_markup(&tex, &m),
            };
            *node = Node::Raw(html);
            continue;
        }
        draw_math(&mut e.children, color);
    }
}
