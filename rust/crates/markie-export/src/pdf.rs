//! PDF export and the print path, through Typst.
//!
//! Electron prints the export HTML (`buildPDFHTML`) with Chromium's
//! `printToPDF`: A4, no page margin, the inset as body padding so a dark page
//! is dark to its edges, backgrounds printed, blocks kept whole unless taller
//! than half a page, and anything wider than the column scaled to fit.
//!
//! Here the same sanitized HTML tree ([`crate::render_tree`]) is walked into
//! Typst code that applies the same stylesheet rules (`assets/pdf-*.css`),
//! and Typst lays it out and writes the PDF. Math goes through the mitex scope
//! markie-math uses, so it is the editor's math. Code is coloured with a
//! TextMate theme built from the stylesheet's highlight.js colours.
//!
//! Like Electron, a picture that cannot be loaded or decoded stops the
//! export with the same message, rather than leaving a hole.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use typst_layout::PagedDocument;

use crate::assets::{Grants, resolve_image};
use crate::hast::{Element, Node};
use crate::styles::Theme;

pub const IMAGE_ERROR: &str = "A document image could not be decoded. The output was stopped.";
pub const IMAGE_TIMEOUT: &str = "A document image took too long to decode. The output was stopped.";
pub const TOO_LONG: &str = "The PDF export took too long and was stopped.";

/// Fetches a remote picture (http or https). The app supplies one with a
/// deadline; without one, a remote picture stops the export as Electron's
/// would when it cannot load.
pub type Fetch<'a> = &'a dyn Fn(&str) -> Option<Vec<u8>>;

pub struct PdfOptions<'a> {
    pub theme: Theme,
    /// The document's folder, for its pictures.
    pub doc_dir: Option<&'a Path>,
    pub grants: Grants,
    pub fetch: Option<Fetch<'a>>,
    /// The Markdown style and typefaces the document is drawn in. The
    /// default is Spacious in the export's own faces, as it always was.
    pub look: crate::styles::ExportLook,
}

impl Default for PdfOptions<'_> {
    fn default() -> Self {
        Self { theme: Theme::Light, doc_dir: None, grants: Grants::default(), fetch: None, look: Default::default() }
    }
}

struct Palette {
    bg: &'static str,
    fg: &'static str,
    h: [&'static str; 6],
    border: &'static str,
    link: &'static str,
    strong: &'static str,
    quote_bar: &'static str,
    quote_bg: &'static str,
    quote_fg: &'static str,
    marker: &'static str,
    code_bg: &'static str,
    code_border: &'static str,
    code_fg: &'static str,
    pre_bg: &'static str,
    pre_fg: &'static str,
    th_bg: &'static str,
    th_fg: &'static str,
    del: &'static str,
    box_border: &'static str,
    box_on: &'static str,
    box_tick: &'static str,
    hljs: Hljs,
}

struct Hljs {
    keyword: &'static str,
    string: &'static str,
    title: &'static str,
    built_in: &'static str,
    comment: &'static str,
    number: &'static str,
    variable: &'static str,
}

/// The colours of `pdf-dark.css` and `pdf-light.css`.
fn palette(theme: Theme) -> Palette {
    match theme {
        Theme::Dark => Palette {
            bg: "#09090b",
            fg: "#fafafa",
            h: ["#fafafa", "#fafafa", "#fafafa", "#fafafa", "#a1a1aa", "#a1a1aa"],
            border: "#27272a",
            link: "#60a5fa",
            strong: "#ffffff",
            quote_bar: "#c084fc",
            quote_bg: "#18181b",
            quote_fg: "#a1a1aa",
            marker: "#a1a1aa",
            code_bg: "#18181b",
            code_border: "#27272a",
            code_fg: "#fb923c",
            pre_bg: "#18181b",
            pre_fg: "#fafafa",
            th_bg: "#18181b",
            th_fg: "#a1a1aa",
            del: "#a1a1aa",
            box_border: "#3f3f46",
            box_on: "#60a5fa",
            box_tick: "#000000",
            hljs: Hljs { keyword: "#ff7b72", string: "#a5d6ff", title: "#d2a8ff", built_in: "#ffa657", comment: "#8b949e", number: "#79c0ff", variable: "#ffa657" },
        },
        Theme::Light => Palette {
            bg: "#ffffff",
            fg: "#1a1a2e",
            h: ["#09090b", "#18181b", "#27272a", "#27272a", "#71717a", "#71717a"],
            border: "#e4e4e7",
            link: "#2563eb",
            strong: "#09090b",
            quote_bar: "#8b5cf6",
            quote_bg: "#f5f3ff",
            quote_fg: "#52525b",
            marker: "#71717a",
            code_bg: "#f4f4f5",
            code_border: "#e4e4e7",
            code_fg: "#c2410c",
            pre_bg: "#fafafa",
            pre_fg: "#1a1a2e",
            th_bg: "#f4f4f5",
            th_fg: "#71717a",
            del: "#a1a1aa",
            box_border: "#d4d4d8",
            box_on: "#2563eb",
            box_tick: "#ffffff",
            hljs: Hljs { keyword: "#d73a49", string: "#032f62", title: "#6f42c1", built_in: "#e36209", comment: "#6a737d", number: "#005cc5", variable: "#e36209" },
        },
    }
}

/// A TextMate theme for Typst's raw highlighting with the export's colours.
fn tm_theme(p: &Palette) -> String {
    let h = &p.hljs;
    let rules: &[(&str, &str)] = &[
        ("comment, punctuation.definition.comment", h.comment),
        ("string, punctuation.definition.string", h.string),
        ("meta.template.expression, punctuation.section.interpolation, meta.interpolation", p.pre_fg),
        ("constant.numeric, constant.language, entity.other.attribute-name, support.type.property-name, meta.mapping.key", h.number),
        ("keyword, storage", h.keyword),
        ("keyword.operator, punctuation", p.pre_fg),
        ("entity.name.function, variable.function, meta.function-call.identifier, entity.name.class, entity.name.struct, entity.name.enum, entity.other.inherited-class, entity.name.tag", h.title),
        ("support.function, support.class, variable.language", h.built_in),
        ("entity.name.type, support.type, storage.type.primitive", h.built_in),
        ("variable.other.constant, variable.other.readwrite.global", h.variable),
        ("variable.parameter", p.pre_fg),
    ];
    let mut settings = format!("<dict><key>settings</key><dict><key>foreground</key><string>{}</string><key>background</key><string>{}</string></dict></dict>", p.pre_fg, p.pre_bg);
    for (scope, color) in rules {
        settings.push_str(&format!("<dict><key>scope</key><string>{scope}</string><key>settings</key><dict><key>foreground</key><string>{color}</string></dict></dict>"));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>name</key><string>Markie export</string><key>settings</key><array>{settings}</array></dict></plist>"
    )
}

/// A Typst string literal.
fn lit(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A CSS colour as a Typst colour expression, for the forms documents use.
fn css_color(value: &str) -> Option<String> {
    let v = value.trim().trim_end_matches("!important").trim().to_ascii_lowercase();
    if let Some(hex) = v.strip_prefix('#') {
        let ok = matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit());
        return ok.then(|| format!("rgb(\"#{hex}\")"));
    }
    if let Some(inner) = v.strip_prefix("rgb(").or_else(|| v.strip_prefix("rgba(")).and_then(|r| r.strip_suffix(')')) {
        let parts: Vec<&str> = inner.split([',', ' ', '/']).filter(|p| !p.is_empty()).collect();
        if parts.len() >= 3 {
            let n: Vec<u8> = parts[..3].iter().filter_map(|p| p.trim().parse::<f32>().ok()).map(|f| f.clamp(0.0, 255.0) as u8).collect();
            if n.len() == 3 {
                let a = parts.get(3).and_then(|a| a.trim().parse::<f32>().ok()).map(|a| if a <= 1.0 { (a * 255.0) as u8 } else { a as u8 }).unwrap_or(255);
                return Some(format!("rgb({}, {}, {}, {})", n[0], n[1], n[2], a));
            }
        }
        return None;
    }
    let named = match v.as_str() {
        "black" => "#000000",
        "white" => "#ffffff",
        "red" => "#ff0000",
        "green" => "#008000",
        "blue" => "#0000ff",
        "yellow" => "#ffff00",
        "orange" => "#ffa500",
        "purple" => "#800080",
        "gray" | "grey" => "#808080",
        "pink" => "#ffc0cb",
        "brown" => "#a52a2a",
        "cyan" | "aqua" => "#00ffff",
        "magenta" | "fuchsia" => "#ff00ff",
        "lime" => "#00ff00",
        "navy" => "#000080",
        "teal" => "#008080",
        "maroon" => "#800000",
        "olive" => "#808000",
        "silver" => "#c0c0c0",
        "gold" => "#ffd700",
        "crimson" => "#dc143c",
        "indigo" => "#4b0082",
        "violet" => "#ee82ee",
        _ => return None,
    };
    Some(format!("rgb(\"{named}\")"))
}

fn style_decls(e: &Element) -> Vec<(String, String)> {
    e.get("style")
        .map(|s| {
            s.split(';')
                .filter_map(|d| d.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn text_align(e: &Element) -> Option<&'static str> {
    let from_style = style_decls(e).into_iter().find(|(k, _)| k == "text-align").map(|(_, v)| v.to_ascii_lowercase());
    let v = from_style.or_else(|| e.get("align").map(|a| a.to_ascii_lowercase()))?;
    Some(match v.trim() {
        "center" => "center",
        "right" | "end" => "right",
        "justify" => "left",
        _ => "left",
    })
}

/// Pixels to points: CSS px are 1/96 in.
fn px(n: f64) -> f64 {
    n * 0.75
}

/// A length in CSS px as a Typst length in points.
fn pt(n: f64) -> String {
    format!("{:.3}pt", n * 0.75)
}

// ── Chromium's box model ────────────────────────────────────────────────
//
// Chromium lays the export out with CSS: every line box is `line-height`
// tall, made of the block's strut and each inline box on the line (its
// font's ascent and descent with half the leading above and half below,
// raised or lowered by `vertical-align`); block margins collapse between
// siblings and through parents without padding or borders; borders and
// padding take space. Typst stacks frames instead, so the walk below works
// out the CSS numbers here and hands Typst explicit text edges (so a Typst
// line is exactly the CSS line box) and explicit spacing (so blocks land
// where CSS margins put them). Measured against Electron's PDFs and its
// layout of the same HTML.

/// Ascent and descent per em as CoreText reports them, which Chromium uses.
const SF_ASC: f64 = 0.966796875;
const SF_DESC: f64 = 0.2109375;
const MONO_ASC: f64 = 0.92822265625;
const MONO_DESC: f64 = 0.23583984375;

/// The body text: 14px with `line-height: 1.75`.
const BODY: f64 = 14.0;
const LINE: f64 = 1.75;

thread_local! {
    /// A Markdown style's `leading`: every line height is this much of the
    /// stylesheet's own. Set for the length of one export, on its thread.
    static LEADING: std::cell::Cell<f64> = const { std::cell::Cell::new(1.0) };
}

fn leading() -> f64 {
    LEADING.with(|l| l.get())
}

/// One inline box's extent above and below its baseline, in px: the
/// line-height around the font's ascent and descent, half the leading on
/// each side.
fn edges(mono: bool, size: f64, line: f64) -> (f64, f64) {
    let (asc, desc) = if mono { (MONO_ASC, MONO_DESC) } else { (SF_ASC, SF_DESC) };
    let top = (line - (asc + desc) * size) / 2.0 + asc * size;
    (top, line - top)
}

/// What text inherits: its size and the line edges every line gets from the
/// block's strut and the inline boxes it sits in.
#[derive(Clone, Copy, Debug)]
struct Inh {
    size: f64,
    top: f64,
    bot: f64,
    /// Inside sub or sup: Typst moves a box there by the shift a second time.
    shifted: bool,
}

impl Inh {
    /// A block's strut.
    fn block(size: f64, mono: bool) -> Self {
        let (top, bot) = edges(mono, size, size * LINE * leading());
        Self { size, top, bot, shifted: false }
    }

    /// An inline box of another font or size, raised by `shift` px.
    fn inner(self, size: f64, mono: bool, shift: f64) -> Self {
        let (t, b) = edges(mono, size, size * LINE * leading());
        Self { size, top: self.top.max(t + shift), bot: self.bot.max(b - shift), shifted: self.shifted || shift != 0.0 }
    }

    /// The Typst text arguments that make a line this tall.
    fn args(&self) -> String {
        format!("top-edge: {}, bottom-edge: {}", pt(self.top), pt(-self.bot))
    }
}

/// A block with its CSS margins, already collapsed with its first and last
/// children where CSS collapses them.
struct Blk {
    mt: f64,
    mb: f64,
    code: String,
    sticky: bool,
}

impl Blk {
    fn new(mt: f64, mb: f64, code: String) -> Self {
        Self { mt, mb, code, sticky: false }
    }
}

/// Blocks in a flow. Typst keeps the larger of two adjacent spacings, as CSS
/// keeps the larger of two adjoining margins, and drops spacing at the start
/// and end of a container, where CSS has already moved it to the container.
fn seq(blks: &[Blk]) -> String {
    if blks.is_empty() {
        return "[]".into();
    }
    let parts: Vec<String> = blks
        .iter()
        .map(|b| format!("block(width: 100%, above: {}, below: {}{}, {})", pt(b.mt), pt(b.mb), if b.sticky { ", sticky: true" } else { "" }, b.code))
        .collect();
    format!("{{ {} }}", parts.join("\n"))
}

fn first_mt(blks: &[Blk]) -> f64 {
    blks.first().map_or(0.0, |b| b.mt)
}

fn last_mb(blks: &[Blk]) -> f64 {
    blks.last().map_or(0.0, |b| b.mb)
}

struct Ctx<'a, 'b> {
    p: Palette,
    opts: &'a PdfOptions<'b>,
    files: Vec<(String, Vec<u8>)>,
    ids: HashSet<String>,
    error: Option<String>,
    /// Width of the column the current content sits in, in points.
    column: f64,
    /// Inside a blockquote, where paragraphs take 0.25em margins.
    quote: bool,
    /// The Markdown style being drawn.
    md: markie_core::markdown_style::Resolved,
    /// Section numbers so far (h2, h3), for `headingNumbers`.
    sections: (u32, u32),
    /// Bulleted and numbered lists above the current one, and the place of
    /// each numbered list's current item (legal numbering).
    ul_depth: usize,
    ol_path: Vec<i64>,
    /// The block before this one, in the same flow, was a paragraph.
    after_p: bool,
    /// Paragraphs are centred (inside a pull quote).
    centre: bool,
}

/// `p > img + em` or `p > img + br + em`, with nothing else in the paragraph.
fn picture_and_caption(p: &Element) -> Option<(&Element, &Element)> {
    let mut parts = p.children.iter().filter(|n| match n {
        Node::Element(e) => e.tag != "br",
        Node::Text(t) => !t.trim().is_empty(),
        _ => false,
    });
    match (parts.next(), parts.next(), parts.next()) {
        (Some(Node::Element(img)), Some(Node::Element(em)), None) if img.tag == "img" && em.tag == "em" => Some((img, em)),
        _ => None,
    }
}

/// Whether a task item's own box is ticked.
fn checked_item(li: &Element) -> bool {
    fn find(nodes: &[Node]) -> Option<bool> {
        for n in nodes {
            let Node::Element(e) = n else { continue };
            if e.tag == "input" {
                return Some(e.has("checked"));
            }
            if matches!(e.tag.as_str(), "ul" | "ol") {
                continue;
            }
            if let Some(found) = find(&e.children) {
                return Some(found);
            }
        }
        None
    }
    find(&li.children).unwrap_or(false)
}

/// CSS `lower-alpha` and `lower-roman`.
fn alpha(mut n: i64) -> String {
    if n <= 0 {
        return n.to_string();
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

fn roman(mut n: i64) -> String {
    if !(1..=3999).contains(&n) {
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

/// Content width: A4 (595.28pt) less 2.2cm a side.
const COLUMN: f64 = 595.28 - 2.0 * 62.36;

fn label_ok(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

fn collect_ids(nodes: &[Node], out: &mut HashSet<String>) {
    for node in nodes {
        if let Node::Element(e) = node {
            if let Some(id) = e.get("id")
                && label_ok(id)
            {
                out.insert(id.to_string());
            }
            collect_ids(&e.children, out);
        }
    }
}

const INLINE: &[&str] = &[
    "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "img", "input", "ins", "kbd", "mark",
    "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr",
    "video", "audio", "math", "svg",
];

fn is_inline(node: &Node) -> bool {
    match node {
        Node::Text(_) | Node::Raw(_) => true,
        Node::Element(e) => {
            // A math placeholder is inline; a display formula's <pre> is not.
            INLINE.contains(&e.tag.as_str())
        }
        Node::Comment(_) => true,
    }
}

/// HTML white-space collapsing for a run of inline nodes.
fn collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if matches!(c, ' ' | '\n' | '\t' | '\r' | '\u{c}') {
            space = true;
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    if space {
        out.push(' ');
    }
    out
}

/// The only meaningful child of an element, ignoring white space.
fn only_child(e: &Element) -> Option<&Element> {
    let meaningful: Vec<&Node> = e.children.iter().filter(|n| !matches!(n, Node::Text(t) if t.trim().is_empty())).collect();
    match meaningful.as_slice() {
        [Node::Element(c)] => Some(c),
        _ => None,
    }
}

impl Ctx<'_, '_> {
    /// A run of inline nodes as one Typst content expression, or None when it
    /// holds only white space.
    fn inline_run(&mut self, nodes: &[Node], inh: Inh) -> Option<String> {
        let mut parts = Vec::new();
        let mut prev_space = true;
        self.inlines(nodes, &mut parts, &mut prev_space, inh);
        // Trim the white space at the run's end.
        while let Some(last) = parts.last() {
            if last == "\" \"" {
                parts.pop();
            } else {
                break;
            }
        }
        if let Some(last) = parts.last_mut()
            && last.starts_with('"')
            && last.ends_with(" \"")
            && last.len() > 3
        {
            last.replace_range(last.len() - 2..last.len() - 1, "");
        }
        if parts.is_empty() {
            return None;
        }
        Some(format!("{{ {} }}", parts.join("; ")))
    }

    fn inlines(&mut self, nodes: &[Node], out: &mut Vec<String>, prev_space: &mut bool, inh: Inh) {
        for node in nodes {
            match node {
                Node::Text(t) => {
                    let mut c = collapse(t);
                    if *prev_space && c.starts_with(' ') {
                        c.remove(0);
                    }
                    if c.is_empty() {
                        continue;
                    }
                    *prev_space = c.ends_with(' ');
                    out.push(lit(&c));
                }
                Node::Element(e) => {
                    if let Some(code) = self.inline_element(e, prev_space, inh) {
                        out.push(code);
                    }
                }
                _ => {}
            }
        }
    }

    fn body(&mut self, e: &Element, prev_space: &mut bool, inh: Inh) -> String {
        let mut parts = Vec::new();
        self.inlines(&e.children, &mut parts, prev_space, inh);
        if parts.is_empty() { "[]".into() } else { format!("{{ {} }}", parts.join("; ")) }
    }

    fn anchor(&self, e: &Element) -> String {
        match e.get("id") {
            Some(id) if label_ok(id) => format!("[#metadata(none)<{id}>]; "),
            _ => String::new(),
        }
    }

    fn inline_element(&mut self, e: &Element, prev_space: &mut bool, inh: Inh) -> Option<String> {
        let anchor = self.anchor(e);
        let wrap = |s: String| Some(format!("{{ {anchor}{s} }}"));
        match e.tag.as_str() {
            "br" => {
                *prev_space = true;
                Some("linebreak()".into())
            }
            "wbr" => None,
            "strong" | "b" => {
                let b = self.body(e, prev_space, inh);
                wrap(format!("text(weight: 600, fill: c-strong, {b})"))
            }
            "em" | "i" | "cite" | "dfn" | "var" => {
                let b = self.body(e, prev_space, inh);
                wrap(format!("text(style: \"italic\", {b})"))
            }
            "del" | "s" | "strike" => {
                let b = self.body(e, prev_space, inh);
                let fill = if e.tag == "del" { "text(fill: c-del, " } else { "text(" };
                wrap(format!("strike({fill}{b}))"))
            }
            "u" | "ins" => {
                let b = self.body(e, prev_space, inh);
                wrap(format!("underline({b})"))
            }
            "sup" | "sub" => {
                // `vertical-align: super` raises by the parent's size / 3 + 1px,
                // `sub` lowers by size / 5 + 1px, and the raised box can make the
                // line taller, as in Chromium.
                let size = inh.size * 0.75;
                let shift = if e.tag == "sup" { inh.size / 3.0 + 1.0 } else { -(inh.size / 5.0 + 1.0) };
                let i = inh.inner(size, false, shift);
                let b = self.body(e, prev_space, i);
                wrap(format!("text(size: {}, baseline: {}, {}, {b})", pt(size), pt(-shift), i.args()))
            }
            "small" => {
                let size = inh.size / 1.2;
                let i = inh.inner(size, false, 0.0);
                let b = self.body(e, prev_space, i);
                wrap(format!("text(size: {}, {}, {b})", pt(size), i.args()))
            }
            "q" => {
                let b = self.body(e, prev_space, inh);
                wrap(format!("{{ \"\u{201c}\"; {b}; \"\u{201d}\" }}"))
            }
            "mark" => {
                let fill = style_decls(e).into_iter().find(|(k, _)| k == "background-color" || k == "background").and_then(|(_, v)| css_color(&v)).unwrap_or_else(|| "rgb(\"#ffff00\")".into());
                let b = self.body(e, prev_space, inh);
                wrap(format!("highlight(fill: {fill}, top-edge: \"ascender\", bottom-edge: \"descender\", text(fill: rgb(\"#000000\"), {b}))"))
            }
            "code" if e.has_class("language-math") && e.has_class("math-inline") => {
                *prev_space = false;
                wrap(self.math(&e.text(), false))
            }
            "code" => {
                *prev_space = false;
                let text = collapse(&e.text());
                // 0.88em Menlo with 0.15em × 0.35em padding and a 1px border.
                // The background covers the font's ascent and descent plus the
                // padding; the line box is the strut's or the code's, whichever
                // reaches further.
                let size = inh.size * 0.88;
                let i = inh.inner(size, true, 0.0);
                let up = size * MONO_ASC + size * 0.15 + 1.0;
                let down = size * MONO_DESC + size * 0.15 + 1.0;
                // `inlineCodeStyle`: a chip, the fill alone, the hairline alone, or the ink alone.
                let kind = match self.md.choice("inlineCodeStyle") {
                    "flat" => ", kind: \"flat\"",
                    "bordered" => ", kind: \"bordered\"",
                    "plain" => ", kind: \"plain\"",
                    _ => "",
                };
                wrap(format!("mk-code({}, {}, {}, {}, {}, {}{kind})", lit(&text), pt(size), pt(i.top), pt(-i.bot), pt(up - i.top), pt(down - i.bot)))
            }
            "kbd" | "samp" | "tt" => {
                // `font-family: monospace` at the inherited size.
                *prev_space = false;
                let text = collapse(&e.text());
                let i = inh.inner(inh.size, true, 0.0);
                wrap(format!("text(size: {}, {}, raw({}))", pt(inh.size), i.args(), lit(&text)))
            }
            "a" => {
                let b = self.body(e, prev_space, inh);
                let href = e.get("href").unwrap_or("");
                let dest = if let Some(frag) = href.strip_prefix('#') {
                    if self.ids.contains(frag) { Some(format!("label({})", lit(frag))) } else { None }
                } else if href.is_empty() {
                    None
                } else {
                    Some(lit(href))
                };
                // Chromium breaks a link only where the text has a break
                // opportunity; Typst also breaks URLs at punctuation.
                let text = e.text();
                let b = if !inh.shifted && !text.is_empty() && !text.contains(char::is_whitespace) && text.chars().count() <= 60 { format!("box({b})") } else { b };
                // `linkStyle`: an underline, a dotted one, or the text's own ink over a link-coloured line.
                let b = match self.md.choice("linkStyle") {
                    "underline" => format!("mk-under({b}, paint: c-link.transparentize(45%))"),
                    "dotted" => format!("mk-under({b}, dotted: true)"),
                    "ink" => format!("text(fill: c-fg, mk-under({b}))"),
                    _ => b,
                };
                match dest {
                    Some(d) => wrap(format!("link({d}, text(fill: c-link, {b}))")),
                    // An anchor with no usable target is text in the link colour
                    // (sanitized-away hrefs keep their colour in the stylesheet).
                    None => wrap(format!("text(fill: c-link, {b})")),
                }
            }
            "img" => {
                *prev_space = false;
                // An inline picture sits on the baseline with its 1em margins.
                let image = self.image(e)?;
                Some(format!("{{ {anchor}box(inset: (y: {}), {image}) }}", pt(BODY)))
            }
            "input" => {
                *prev_space = false;
                (e.get("type") == Some("checkbox")).then(|| {
                    // `taskStyle`: a rounded box, a circle, or a thin outline with a coloured tick.
                    let kind = match self.md.choice("taskStyle") {
                        "round" => ", kind: \"round\"",
                        "minimal" => ", kind: \"minimal\"",
                        _ => "",
                    };
                    format!("mk-box({}{kind})", e.has("checked"))
                })
            }
            "video" | "audio" => {
                *prev_space = false;
                Some(if e.tag == "video" { "mk-video()".into() } else { "mk-audio()".into() })
            }
            "span" => {
                let b = self.body(e, prev_space, inh);
                if e.has_class("katex-error") {
                    return wrap(format!("text(fill: rgb(\"#cc0000\"), {b})"));
                }
                wrap(self.styled(e, b))
            }
            _ => {
                let b = self.body(e, prev_space, inh);
                wrap(self.styled(e, b))
            }
        }
    }

    /// Inline `style` a document keeps: colour, background, weight, style, decoration.
    fn styled(&self, e: &Element, mut b: String) -> String {
        for (k, v) in style_decls(e) {
            match k.as_str() {
                "color" => {
                    if let Some(c) = css_color(&v) {
                        b = format!("text(fill: {c}, {b})");
                    }
                }
                "background-color" | "background" => {
                    if let Some(c) = css_color(&v) {
                        b = format!("highlight(fill: {c}, top-edge: \"ascender\", bottom-edge: \"descender\", {b})");
                    }
                }
                "font-weight" => {
                    let w = match v.trim() {
                        "bold" | "bolder" => Some(700),
                        "normal" => Some(400),
                        n => n.parse::<u16>().ok(),
                    };
                    if let Some(w) = w {
                        b = format!("text(weight: {w}, {b})");
                    }
                }
                "font-style" if v.trim() == "italic" => b = format!("text(style: \"italic\", {b})"),
                "text-decoration" | "text-decoration-line" => {
                    if v.contains("underline") {
                        b = format!("underline({b})");
                    }
                    if v.contains("line-through") {
                        b = format!("strike({b})");
                    }
                }
                _ => {}
            }
        }
        b
    }

    fn math(&self, tex: &str, display: bool) -> String {
        // A formula Typst cannot set alone would fail the whole document, so
        // it is tried by itself first (cached; the editor draws it the same way).
        let alone = markie_math::render_cached(tex, display, &markie_math::MathStyle::default());
        // KaTeX shows the source in red, white space collapsed as HTML does.
        if alone.is_err() || crate::math_html::katex_rejects(tex).is_some() {
            return format!("text(fill: rgb(\"#cc0000\"), {})", lit(&collapse(tex)));
        }
        match markie_math::to_typst(tex) {
            Ok(code) => format!("mk-math({}, {display})", lit(&code)),
            Err(_) => format!("text(fill: rgb(\"#cc0000\"), {})", lit(&collapse(tex))),
        }
    }

    /// Loads a picture into the world and returns the Typst code drawing it
    /// at its CSS size (natural size, then the attributes, then max-width 100%).
    fn image(&mut self, e: &Element) -> Option<String> {
        let (code, _) = self.image_sized(e)?;
        Some(code)
    }

    /// The picture's code and its height in points, when known.
    fn image_sized(&mut self, e: &Element) -> Option<(String, Option<f64>)> {
        let src = e.get("src").unwrap_or("").trim().to_string();
        let bytes = match self.load(&src) {
            Some(b) => b,
            None => {
                self.error.get_or_insert_with(|| IMAGE_ERROR.to_string());
                return None;
            }
        };
        let svg = bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") || src.to_ascii_lowercase().ends_with(".svg") || src.starts_with("data:image/svg");
        let path = format!("/images/{}.{}", self.files.len(), if svg { "svg" } else { "img" });
        let natural = if svg { None } else { imagesize::blob_size(&bytes).ok().map(|s| (s.width as f64, s.height as f64)) };
        if !svg && natural.is_none() {
            self.error.get_or_insert_with(|| IMAGE_ERROR.to_string());
            return None;
        }
        self.files.push((path.clone(), bytes));
        let attr = |name: &str| e.get(name).and_then(|v| v.trim().trim_end_matches("px").parse::<f64>().ok());
        let (mut w, mut h) = match natural {
            Some((nw, nh)) => (Some(px(nw)), Some(px(nh))),
            None => (None, None),
        };
        if let Some(aw) = attr("width") {
            if let (Some(ow), Some(oh)) = (w, h) {
                h = Some(oh * px(aw) / ow);
            }
            w = Some(px(aw));
        }
        if let Some(ah) = attr("height") {
            h = Some(px(ah));
        }
        // max-width: 100%, height: auto.
        let max = self.column;
        if let Some(ww) = w
            && ww > max
        {
            h = h.map(|hh| hh * max / ww);
            w = Some(max);
        }
        let size = match (w, h) {
            (Some(w), Some(h)) => format!("width: {w:.2}pt, height: {h:.2}pt"),
            (Some(w), None) => format!("width: {w:.2}pt"),
            _ => "width: auto".to_string(),
        };
        let image = format!("image({}, {size})", lit(&path));
        // `imageRadius` (8px is the export's own) and `imageFrame: border`.
        // Typst draws no shadows, so `shadow` adds nothing here.
        let radius = pt(self.md.number("imageRadius"));
        let radius = if radius == "6.000pt" { "6pt".to_string() } else { radius };
        let frame = if self.md.choice("imageFrame") == "border" { ", stroke: 0.75pt + c-border" } else { "" };
        Some((format!("box(clip: true, radius: {radius}{frame}, {image})"), h))
    }

    fn load(&self, src: &str) -> Option<Vec<u8>> {
        let lower = src.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("data:") {
            let comma = rest.find(',')?;
            let meta = &rest[..comma];
            let data = &src[5 + comma + 1..];
            return if meta.ends_with(";base64") {
                base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()
            } else {
                Some(percent_decode(data))
            };
        }
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return self.opts.fetch.and_then(|f| f(src));
        }
        let dir = self.opts.doc_dir?;
        let (path, _) = resolve_image(src, dir, &self.opts.grants)?;
        let bytes = std::fs::read(path).ok()?;
        (bytes.len() <= crate::assets::MAX_IMAGE_BYTES).then_some(bytes)
    }

    // ── Blocks ───────────────────────────────────────────────────────────

    /// A paragraph's lines. Chromium keeps two lines together at either end
    /// of a page (orphans and widows 2), except that a three-line paragraph
    /// may leave its last line alone rather than move whole; `mk-p` asks
    /// Typst for the same.
    fn par(&self, body: &str, inh: Inh) -> String {
        format!("mk-p({body}, {:.3}pt, {})", self.column, pt(inh.top + inh.bot))
    }

    /// A container's children as blocks: inline runs become anonymous
    /// blocks with no margins, as in CSS.
    fn flow(&mut self, nodes: &[Node], inh: Inh) -> Vec<Blk> {
        let mut out = Vec::new();
        let mut run: Vec<Node> = Vec::new();
        let mut seen_element = false;
        for node in nodes {
            if is_inline(node) {
                if matches!(node, Node::Element(_)) {
                    seen_element = true;
                }
                run.push(node.clone());
                continue;
            }
            self.flush(&mut run, &mut out, inh);
            if let Node::Element(e) = node {
                let first = !seen_element;
                seen_element = true;
                if let Some(b) = self.block(e, inh, first) {
                    out.push(b);
                }
            }
        }
        self.flush(&mut run, &mut out, inh);
        out
    }

    fn flush(&mut self, run: &mut Vec<Node>, out: &mut Vec<Blk>, inh: Inh) {
        if run.is_empty() {
            return;
        }
        let nodes = std::mem::take(run);
        if let Some(body) = self.inline_run(&nodes, inh) {
            out.push(Blk::new(0.0, 0.0, self.par(&body, inh)));
        }
    }

    /// A container without padding or border: its margins collapse with its
    /// first and last children's.
    fn through(&mut self, e: &Element, inh: Inh, mt: f64, mb: f64, wrap: impl FnOnce(&Self, String) -> String) -> Blk {
        let inner = self.flow(&e.children, inh);
        let (top, bottom) = (mt.max(first_mt(&inner)), mb.max(last_mb(&inner)));
        let code = wrap(self, seq(&inner));
        Blk::new(top, bottom, code)
    }

    fn block(&mut self, e: &Element, inh: Inh, first: bool) -> Option<Blk> {
        let blk = self.block_inner(e, inh, first);
        self.after_p = e.tag == "p";
        blk
    }

    fn block_inner(&mut self, e: &Element, inh: Inh, first: bool) -> Option<Blk> {
        let anchor = self.anchor(e);
        let mut blk = match e.tag.as_str() {
            "p" => self.paragraph(e, inh)?,
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = e.tag[1..].parse::<usize>().unwrap_or(1);
                self.heading(e, level, first)
            }
            "hr" => {
                let m = 25.2 * self.gap();
                let code = match self.md.choice("dividerStyle") {
                    "short" => "align(center, block(width: 22%, height: 0.75pt, fill: c-border))".to_string(),
                    "dotted" => "line(length: 100%, stroke: (paint: c-marker.transparentize(40%), thickness: 1.5pt, dash: \"dotted\"))".to_string(),
                    "ornament" => "align(center, text(fill: c-marker, size: 9.45pt, \"\u{2022}\u{2003}\u{2022}\u{2003}\u{2022}\"))".to_string(),
                    "space" => "block(width: 100%, height: 0pt)".to_string(),
                    _ => "block(width: 100%, height: 0.75pt, fill: c-border)".to_string(),
                };
                Blk::new(m, m, code)
            }
            "blockquote" => {
                // margin 1em 0, padding 0.5em 1em, a 3px bar: the children's
                // margins stay inside the padding.
                let (quote, column) = (self.quote, self.column);
                self.quote = true;
                self.column -= px(31.0);
                let centre = self.centre;
                self.centre = self.md.choice("quoteStyle") == "pull";
                let inner = self.flow(&e.children, inh);
                (self.quote, self.column, self.centre) = (quote, column, centre);
                let (top, bottom) = (7.0 + first_mt(&inner), 7.0 + last_mb(&inner));
                let m = 14.0 * self.gap();
                // `quoteAccent` and `quoteStyle`, as the stylesheet's rules read.
                let bar = match self.md.choice("quoteAccent") {
                    "quiet" => "c-marker".to_string(),
                    "link" => "c-link".to_string(),
                    "text" => "c-fg".to_string(),
                    _ => "none".to_string(),
                };
                let body = seq(&inner);
                let code = match self.md.choice("quoteStyle") {
                    "bar" => format!("mk-quote-plain({bar}, false, false, {body})"),
                    "italic" => format!("mk-quote-plain({bar}, true, false, {body})"),
                    "pull" => format!("mk-quote-plain({bar}, true, true, {body})"),
                    "card" => format!("mk-quote-card({}, {}, {body})", pt(top + 2.8), pt(bottom + 2.8)),
                    _ if bar != "none" => format!("mk-quote({}, {}, {body}, bar: {bar})", pt(top), pt(bottom)),
                    _ => format!("mk-quote({}, {}, {body})", pt(top), pt(bottom)),
                };
                Blk::new(m, m, code)
            }
            "ul" | "ol" => self.list(e, inh),
            "pre" => {
                if let Some(Node::Element(code)) = e.children.iter().find(|c| matches!(c, Node::Element(_)))
                    && code.has_class("math-display")
                {
                    // `.katex-display`: margin 1em 0, one centred line.
                    return Some(Blk::new(14.0, 14.0, format!("{anchor}mk-display({})", self.math(&code.text(), true))));
                }
                let code_el = e.children.iter().find_map(|c| match c {
                    Node::Element(c) if c.tag == "code" => Some(c),
                    _ => None,
                });
                let text = code_el.map(|c| c.text()).unwrap_or_else(|| e.text());
                let text = text.strip_suffix('\n').unwrap_or(&text).to_string();
                let lang = code_el
                    .and_then(|c| c.classes().iter().find_map(|k| k.strip_prefix("language-").map(str::to_string)))
                    .filter(|l| code_el.is_some_and(|c| c.has_class("hljs")) && crate::highlight::syntax_for(l).is_some());
                let lang = lang.map(|l| format!(", lang: {}", lit(typst_lang(&l)))).unwrap_or_default();
                // The <pre>'s own strut is Menlo at 14px and 1.75; the code
                // inside is 0.85em at 1.55, so the strut sets the pitch.
                let i = Inh::block(BODY, true).inner(BODY * 0.85, true, 0.0);
                let frame = match self.md.choice("codeBlockStyle") {
                    "flat" => ", frame: \"flat\"",
                    "bordered" => ", frame: \"bordered\"",
                    "bar" => ", frame: \"bar\"",
                    _ => "",
                };
                let m = 14.0 * self.gap();
                Blk::new(m, m, format!("mk-pre(raw(block: true{lang}, {}), {}{frame})", lit(&text), i.args()))
            }
            "table" => {
                let t = self.table(e)?;
                let m = 12.6 * self.gap();
                // `tableWidth: centered`.
                let t = if self.md.choice("tableWidth") == "centered" { format!("align(center, {t})") } else { t };
                Blk::new(m, m, t)
            }
            "img" => {
                let image = self.image(e)?;
                Blk::new(14.0, 14.0, format!("block({image})"))
            }
            "video" | "audio" => self.replaced(e.tag == "video", 0.0, inh),
            "dl" => self.through(e, inh, 14.0, 14.0, |_, s| s),
            "dd" => self.through(e, inh, 0.0, 0.0, |_, s| format!("pad(left: {}, {s})", pt(40.0))),
            "details" | "summary" | "div" | "section" | "article" | "figure" | "figcaption" | "dt" | "picture" | "header" | "footer" | "main" | "nav" | "aside" => {
                self.through(e, inh, 0.0, 0.0, |this, inner| {
                    let inner = this.styled(e, inner);
                    match text_align(e) {
                        Some(al) => format!("align({al}, {inner})"),
                        None => inner,
                    }
                })
            }
            _ => self.through(e, inh, 0.0, 0.0, |_, s| s),
        };
        if !anchor.is_empty() {
            blk.code = format!("{{ {anchor}{} }}", blk.code);
        }
        Some(blk)
    }

    /// A Markdown style's `blockGap`.
    fn gap(&self) -> f64 {
        self.md.number("blockGap")
    }

    fn paragraph(&mut self, e: &Element, inh: Inh) -> Option<Blk> {
        let style = self.md.choice("paragraphStyle").to_string();
        // Indented paragraphs have no gap of their own (`margin: 0`).
        let m = if self.quote {
            BODY * 0.25
        } else if style == "indented" {
            0.0
        } else {
            BODY * 0.7 * self.gap()
        };
        if e.has_class("markie-embed") {
            return self.embed(e);
        }
        if let Some(only) = only_child(e) {
            match only.tag.as_str() {
                // One picture: its line holds the picture and its 1em margins
                // on the baseline, and the strut's descent under it.
                "img" => {
                    let anchor = self.anchor(only);
                    let (image, h) = self.image_sized(only)?;
                    let h = h.map(|h| h / 0.75).unwrap_or(0.0);
                    let above = (h + 28.0).max(inh.top) - h - 14.0;
                    // `imageAlign: center`.
                    let image = if self.md.choice("imageAlign") == "center" { format!("align(center, {image})") } else { image };
                    return Some(Blk::new(m, m, format!("{{ {anchor}block(width: 100%, inset: (top: {}, bottom: {}), {image}) }}", pt(above), pt(14.0 + inh.bot))));
                }
                "video" | "audio" => return Some(self.replaced(only.tag == "video", m, inh)),
                _ => {}
            }
        }
        // `captionStyle`: a picture with emphasised text straight after it,
        // in the same paragraph, is a picture and its caption (0.86em, muted,
        // 0.5em closer to the picture, centred or left).
        let caption_style = self.md.choice("captionStyle").to_string();
        if caption_style != "inline"
            && let Some((img, em)) = picture_and_caption(e)
        {
            let (image, _) = self.image_sized(img)?;
            let small = Inh::block(BODY * 0.86, false);
            let text = self.inline_run(&em.children, small).unwrap_or_else(|| "[]".into());
            let centre = caption_style == "centered";
            let image = if centre || self.md.choice("imageAlign") == "center" { format!("align(center, {image})") } else { image };
            let caption = format!("text(size: {}, fill: c-marker, style: \"italic\", {}, par({text}))", pt(BODY * 0.86), small.args());
            let caption = if centre { format!("align(center, {caption})") } else { caption };
            return Some(Blk::new(m.max(14.0), m, format!("{{ block(width: 100%, {image}); v({}); block(width: 100%, {caption}) }}", pt(14.0 - 0.5 * BODY * 0.86))));
        }
        let al = text_align(e).unwrap_or(if self.centre { "center" } else { "left" });
        let body = self.inline_run(&e.children, inh)?;
        let body = self.styled(e, body);
        // `text-indent: 1.5em` after another paragraph; `text-align: justify`.
        let par = if style == "indented" && self.after_p && !self.quote && self.ul_depth == 0 && self.ol_path.is_empty() {
            format!("{{ set par(first-line-indent: (amount: 1.5em, all: true)); {} }}", self.par(&body, inh))
        } else if style == "justified" && text_align(e).is_none() {
            format!("{{ set par(justify: true); {} }}", self.par(&body, inh))
        } else {
            self.par(&body, inh)
        };
        Some(Blk::new(m, m, format!("align({al}, {par})")))
    }

    /// A video (300 × 150) or audio (300 × 54) player on the baseline, with
    /// the strut's descent under it.
    fn replaced(&self, video: bool, m: f64, inh: Inh) -> Blk {
        let (code, h) = if video { ("mk-video()", 150.0) } else { ("mk-audio()", 54.0) };
        let above = f64::max(h, inh.top) - h;
        Blk::new(m, m, format!("block(inset: (top: {}, bottom: {}), {code})", pt(above), pt(inh.bot)))
    }

    fn heading(&mut self, e: &Element, level: usize, first: bool) -> Blk {
        // `.markdown-body hN`: size, top and bottom margin, padding-bottom,
        // in em of the heading's own size, and whether it has a 1px rule.
        let (em, top, bottom, pad, rule, weight) = match level {
            1 => (2.0, 1.2, 0.5, 0.3, true, 700),
            2 => (1.5, 1.3, 0.45, 0.25, true, 600),
            3 => (1.25, 1.2, 0.4, 0.0, false, 600),
            4 => (1.1, 1.1, 0.35, 0.0, false, 600),
            _ => (1.0, 1.0, 0.3, 0.0, false, 600),
        };
        // A Markdown style's headings (`CHOICE_RULES` in markdown-style.ts).
        // Each default leaves the stylesheet's own value alone.
        let i = level.clamp(1, 6) - 1;
        let em = match self.md.choice("headingScale") {
            "compact" => [1.6, 1.3, 1.12, 1.0, 0.92, 0.92][i],
            "large" => [2.5, 1.8, 1.35, 1.15, 1.0, 1.0][i],
            "flat" => [1.4, 1.2, 1.05, 1.0, 1.0, 1.0][i],
            _ => em,
        };
        let weight = match self.md.choice("headingWeight") {
            "medium" => [600, 600, 550][i.min(2)],
            "light" => [400, 400, 500][i.min(2)],
            "heavy" => [800, 750, 700][i.min(2)],
            _ => weight,
        };
        let rule_style = self.md.choice("headingRule").to_string();
        let (rule, pad, short) = match (rule_style.as_str(), level) {
            ("title", 2) | ("none", 1 | 2) => (false, 0.0, false),
            ("short", 1 | 2) => (false, 0.0, true),
            _ => (rule, pad, false),
        };
        let (upper, extra_track) = match (self.md.choice("headingCase"), level) {
            ("upper", _) => (true, 0.04),
            ("upper-minor", 4..) => (true, 0.08),
            ("small-caps", _) => (false, 0.03),
            _ => (false, 0.0),
        };
        let small_caps = self.md.choice("headingCase") == "small-caps";
        let centred = match self.md.choice("headingAlign") {
            "center-title" => level == 1,
            "center" => level <= 3,
            _ => false,
        };
        let top = top * self.md.number("headingSpaceAbove");
        let bottom = bottom * self.md.number("headingSpaceBelow");
        // Sections are counted from the second level down.
        let number = (self.md.choice("headingNumbers") == "outline")
            .then(|| match level {
                2 => {
                    self.sections = (self.sections.0 + 1, 0);
                    Some(format!("{}", self.sections.0))
                }
                3 => {
                    self.sections.1 += 1;
                    Some(format!("{}.{}", self.sections.0, self.sections.1))
                }
                _ => None,
            })
            .flatten();
        let size = BODY * em;
        let inh = Inh::block(size, false);
        let track = match level {
            1 => sf_tracking(28.0) - 0.025,
            2 => sf_tracking(21.0) - 0.02,
            3 => sf_tracking(17.5),
            4 => sf_tracking(15.4),
            _ => sf_tracking(14.0),
        } + extra_track;
        let al = text_align(e).unwrap_or(if centred { "center" } else { "left" });
        let body = self.inline_run(&e.children, inh).unwrap_or_else(|| "[]".into());
        let mut body = self.styled(e, body);
        if upper {
            body = format!("upper({body})");
        }
        if small_caps {
            body = format!("smallcaps({body})");
        }
        if let Some(n) = number {
            body = format!("{{ text(fill: c-marker, weight: 400, {}); {body} }}", lit(&format!("{n}\u{2002}")));
        }
        let border = if rule { 1.0 } else { 0.0 };
        let color = lit(self.p.h[level - 1]);
        // `h1:first-child` has no top margin; a heading after an indented
        // paragraph gets air (`p + h1 { margin-top: 1.6em }`).
        let mt = if level == 1 && first {
            0.0
        } else if self.after_p && self.md.choice("paragraphStyle") == "indented" {
            size * 1.6
        } else {
            size * top
        };
        let mut code = format!(
            "align({al}, mk-heading({}, {weight}, {}, {rule}, rgb({color}), {track:.5}em, {}, {body}))",
            pt(size),
            pt(size * pad + border),
            inh.args(),
        );
        if short {
            // `::after`: a bar 2.2em wide and 3px tall, 0.35em under the text.
            code = format!("{{ {code}; v({}); align({al}, rect(width: {}, height: 2.25pt, radius: 1.5pt, fill: c-link, stroke: none)) }}", pt(size * 0.35), pt(size * 2.2));
        }
        Blk { mt, mb: size * bottom, code, sticky: true }
    }

    fn list(&mut self, e: &Element, inh: Inh) -> Blk {
        // ul, ol: margin 0.6em 0 and padding-left 1.8em; li: margin 0.25em 0.
        let ordered = e.tag == "ol";
        let mut number: i64 = e.get("start").and_then(|s| s.trim().parse().ok()).unwrap_or(1);
        let mut items = Vec::new();
        let column = self.column;
        // `markerColor`, `bulletStyle` and `orderedStyle`.
        let fill = match self.md.choice("markerColor") {
            "text" => ", fill: c-fg",
            "accent" => ", fill: c-link",
            _ => "",
        };
        let bullet = match (self.md.choice("bulletStyle"), self.ul_depth) {
            ("nested", 0) | ("disc", _) => "mk-disc".to_string(),
            ("nested", 1) | ("hollow", _) => format!("mk-shape(\"circle\"{fill})"),
            ("nested", _) | ("square", _) => format!("mk-shape(\"square\"{fill})"),
            ("dash", _) => format!("mk-mark(\"\u{2013}\"{fill})"),
            ("arrow", _) => format!("mk-mark(\"\u{2192}\"{fill})"),
            _ => "mk-disc".to_string(),
        };
        let bullet = if bullet == "mk-disc" && !fill.is_empty() { format!("mk-shape(\"disc\"{fill})") } else { bullet };
        let ordered_style = self.md.choice("orderedStyle").to_string();
        let ol_depth = self.ol_path.len();
        let mut place: i64 = 0;
        let (ul_depth, ol_path) = (self.ul_depth, self.ol_path.clone());
        for child in &e.children {
            let Node::Element(li) = child else { continue };
            if li.tag != "li" {
                continue;
            }
            let anchor = self.anchor(li);
            let task = li.has_class("task-list-item");
            // A task item has no marker and pulls back 1.5em.
            // `padding-left` (listIndent); a task item pulls back to 0.3em of it.
            let indent = if task { BODY * 0.3 } else { BODY * self.md.number("listIndent") };
            self.column = column - px(indent);
            place += 1;
            if ordered {
                self.ol_path.push(place);
            } else {
                self.ul_depth += 1;
            }
            let body = self.flow(&li.children, inh);
            self.column = column;
            (self.ul_depth, self.ol_path) = (ul_depth, ol_path.clone());
            // `li { margin }`: the export's own 0.25em, or the style's listItemGap.
            let item_gap = if self.md.number("listItemGap") == 0.3 { 3.5 } else { BODY * self.md.number("listItemGap") };
            let (mt, mb) = (f64::max(item_gap, first_mt(&body)), f64::max(item_gap, last_mb(&body)));
            let body = seq(&body);
            // `taskDone`: a finished item reads muted, or muted and struck through.
            let done = task && checked_item(li);
            let body = match (done, self.md.choice("taskDone")) {
                (true, "dim") => format!("{{ set text(fill: c-marker); {body} }}"),
                (true, "strike") => format!("{{ set text(fill: c-marker); show regex(\"[^\\\\s]+\"): strike; {body} }}"),
                _ => body,
            };
            let code = if task {
                format!("pad(left: {}, {body})", pt(indent))
            } else {
                let label = match (ordered_style.as_str(), ol_depth) {
                    ("paren", _) => format!("{number})"),
                    ("alpha", _) | ("outline", 1) => format!("{}.", alpha(number)),
                    ("roman", _) | ("outline", 2..) => format!("{}.", roman(number)),
                    ("legal", _) => format!("{}.", ol_path.iter().chain(std::iter::once(&place)).map(|n| n.to_string()).collect::<Vec<_>>().join(".")),
                    _ => format!("{number}."),
                };
                let marker = match (ordered, fill.is_empty()) {
                    (true, true) => format!("mk-num({})", lit(&label)),
                    (true, false) => format!("mk-mark({}{fill})", lit(&label)),
                    (false, _) => bullet.clone(),
                };
                format!("grid(columns: ({}, 1fr), {marker}, {body})", pt(indent))
            };
            items.push(Blk::new(mt, mb, format!("{{ {anchor}{code} }}")));
            number += 1;
        }
        let own = 8.4 * self.gap();
        Blk::new(f64::max(own, first_mt(&items)), f64::max(own, last_mb(&items)), seq(&items))
    }

    fn table(&mut self, e: &Element) -> Option<String> {
        // Rows from thead, tbody, tfoot or directly under the table.
        let mut head: Vec<&Element> = Vec::new();
        let mut body: Vec<&Element> = Vec::new();
        for child in &e.children {
            let Node::Element(part) = child else { continue };
            match part.tag.as_str() {
                "thead" => head.extend(part.children.iter().filter_map(row)),
                "tbody" | "tfoot" => body.extend(part.children.iter().filter_map(row)),
                "tr" => body.push(part),
                _ => {}
            }
        }
        let columns = head.iter().chain(body.iter()).map(|r| r.children.iter().filter(|c| cell(c).is_some()).count()).max().unwrap_or(0);
        if columns == 0 {
            return None;
        }
        // The table is 0.9em; a header cell 0.85em of that.
        let td = Inh::block(BODY * 0.9, false);
        let th = Inh::block(BODY * 0.9 * 0.85, false);
        let mut cells = Vec::new();
        let mut header = Vec::new();
        for r in &head {
            for c in r.children.iter().filter_map(cell) {
                let al = text_align(c).unwrap_or("left");
                let content = self.inline_run(&c.children, th).unwrap_or_else(|| "[]".into());
                header.push(format!("mk-th({}, align({al}, {content}))", th.args()));
            }
            header.extend((r.children.iter().filter_map(cell).count()..columns).map(|_| "[]".to_string()));
        }
        for (ri, r) in body.iter().enumerate() {
            let n = r.children.iter().filter_map(cell).count();
            for c in r.children.iter().filter_map(cell) {
                let al = text_align(c).unwrap_or("left");
                let content = self.inline_run(&c.children, td).unwrap_or_else(|| "[]".into());
                let strong = c.tag == "th";
                let content = if strong { format!("text(weight: 600, {content})") } else { content };
                cells.push(format!("mk-td(align({al}, {content}))"));
            }
            cells.extend((n..columns).map(|_| "mk-td([])".to_string()));
            // `tableStyle`: row lines, or none for zebra and minimal (grid draws its own).
            if matches!(self.md.choice("tableStyle"), "lines" | "grid") {
                cells.push(format!("table.hline(y: {}, stroke: 0.75pt + c-border)", ri + 1 + usize::from(!head.is_empty())));
            }
        }
        let has_head = !head.is_empty();
        let head_line = if self.md.choice("tableStyle") == "minimal" { "0.75pt + c-marker" } else { "1.5pt + c-border" };
        let header = if header.is_empty() { String::new() } else { format!("table.header({}), table.hline(y: 1, stroke: {head_line}), ", header.join(", ")) };
        // Collapsed borders: each row carries half of the rule above and
        // below it (the header's 2px rule, 1px between body rows), and the
        // table half of its last rule.
        // `tableDensity`: cell padding (y, x) in em, header then body. The
        // export's own is 0.55em 0.8em and 0.5em 0.8em.
        let (hy, hx, by, bx) = match self.md.choice("tableDensity") {
            "compact" => (0.3, 0.65, 0.28, 0.65),
            "roomy" => (0.8, 1.2, 0.75, 1.2),
            _ => (0.55, 0.8, 0.5, 0.8),
        };
        let (hs, bs) = (BODY * 0.9 * 0.85, BODY * 0.9);
        let inset = format!(
            "(x, y) => if {has_head} and y == 0 {{ (x: {}, top: {}, bottom: {}) }} else if {has_head} and y == 1 {{ (x: {}, top: {}, bottom: {}) }} else if y == 0 {{ (x: {}, top: {}, bottom: {}) }} else {{ (x: {}, top: {}, bottom: {}) }}",
            pt(hs * hx),
            pt(hs * hy),
            pt(hs * hy + 1.0),
            pt(bs * bx),
            pt(bs * by + 1.0),
            pt(bs * by + 0.5),
            pt(bs * bx),
            pt(bs * by),
            pt(bs * by + 0.5),
            pt(bs * bx),
            pt(bs * by + 0.5),
            pt(bs * by + 0.5),
        );
        // A style's borders, header row and width ride in as named arguments;
        // with none, this is the call the export always made.
        let mut extra = String::new();
        match self.md.choice("tableStyle") {
            "grid" => extra.push_str(", grid: true"),
            "zebra" => extra.push_str(", zebra: true"),
            "minimal" => extra.push_str(", plain-head: true"),
            _ => {}
        }
        match self.md.choice("tableHeader") {
            "bold" => extra.push_str(", head-style: \"bold\""),
            "filled" => extra.push_str(", head-style: \"filled\""),
            "plain" => extra.push_str(", head-style: \"plain\""),
            _ => {}
        }
        if self.md.choice("tableWidth") == "full" {
            extra.push_str(", full: true");
        }
        Some(format!(
            "mk-table({columns}, {inset}, {has_head}, {}, ({header}{}){extra})",
            td.args(),
            if cells.is_empty() { String::new() } else { format!("{},", cells.join(", ")) }
        ))
    }

    fn embed(&mut self, e: &Element) -> Option<Blk> {
        let a = e.children.iter().find_map(|c| match c {
            Node::Element(a) if a.tag == "a" => Some(a),
            _ => None,
        })?;
        let img = a.children.iter().find_map(|c| match c {
            Node::Element(i) if i.tag == "img" => Some(i),
            _ => None,
        })?;
        let src = img.get("src").unwrap_or("").to_string();
        let Some(bytes) = self.load(&src) else {
            self.error.get_or_insert_with(|| IMAGE_ERROR.to_string());
            return None;
        };
        let path = format!("/images/{}.img", self.files.len());
        self.files.push((path.clone(), bytes));
        let href = a.get("href").unwrap_or("");
        // The picture is a block inside the paragraph: its 1em margins
        // collapse through the paragraph's.
        Some(Blk::new(14.0, 14.0, format!("mk-embed({}, {})", lit(&path), lit(href))))
    }
}

fn row(n: &Node) -> Option<&Element> {
    match n {
        Node::Element(e) if e.tag == "tr" => Some(e),
        _ => None,
    }
}

fn cell(n: &Node) -> Option<&Element> {
    match n {
        Node::Element(e) if e.tag == "td" || e.tag == "th" => Some(e),
        _ => None,
    }
}

/// Typst's syntax tokens for the names highlight.js documents use.
fn typst_lang(lang: &str) -> &str {
    match lang.to_ascii_lowercase().as_str() {
        "javascript" | "jsx" | "mjs" | "cjs" => "js",
        "typescript" | "tsx" => "ts",
        "python" => "py",
        "shell" | "sh" | "zsh" | "console" => "bash",
        "yml" => "yaml",
        "rust" => "rs",
        _ => lang,
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len() + 0
            && let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// SF Pro's `trak` table (track 0), which CoreText applies in Chromium:
/// tracking in font units of 2048 per size in CSS px. Typst does not read
/// `trak`, so the prelude sets the same tracking per text size.
const SF_TRAK: &[(f64, f64)] = &[(6.0, 82.0), (9.0, 38.0), (10.0, 24.0), (11.0, 12.0), (12.0, 0.0), (13.0, -12.0), (14.0, -22.0), (15.0, -32.0), (16.0, -40.0), (17.0, -52.0), (20.0, -46.0), (22.0, -24.0), (24.0, 6.0), (28.0, 28.0), (32.0, 26.0), (36.0, 21.0), (50.0, 14.0), (64.0, 7.0), (80.0, 0.0)];

/// SF tracking in em for a size in CSS px, interpolated like CoreText.
pub fn sf_tracking(px: f64) -> f64 {
    let units = match SF_TRAK.iter().position(|(s, _)| *s >= px) {
        Some(0) => SF_TRAK[0].1,
        Some(i) => {
            let (s0, v0) = SF_TRAK[i - 1];
            let (s1, v1) = SF_TRAK[i];
            v0 + (v1 - v0) * (px - s0) / (s1 - s0)
        }
        None => 0.0,
    };
    units / 2048.0
}

/// The Typst prelude: the stylesheet's rules as Typst functions. Lengths
/// come from the CSS in px (×0.75 for points).
/// A typeface id as the families Typst should try first, quoted and comma
/// ended, or "" for the export's own face.
fn font_prefix(id: &str) -> String {
    let name = match markie_core::fonts::parse_local_typeface_id(id) {
        // A font from this computer is not in the PDF engine; its bundled stand-in is.
        Some((_, fallback)) => crate::pdf_world::typst_family(&fallback.id),
        None => crate::pdf_world::typst_family(id).or_else(|| match id {
            "humanist" => Some("Avenir Next".into()),
            "helvetica" => Some("Helvetica Neue".into()),
            "georgia" => Some("Georgia".into()),
            _ => None,
        }),
    };
    name.map(|n| format!("{}, ", lit(&n))).unwrap_or_default()
}

fn prelude(p: &Palette, look: &crate::styles::ExportLook) -> String {
    let body = Inh::block(BODY, false);
    let body_font = font_prefix(&look.body_font);
    let code_font = font_prefix(&markie_core::fonts::clean_code_font(&look.code_font));
    let heading_font = match look.heading_font.as_str() {
        "" | "body" => "sans".to_string(),
        id => format!("({}..sans)", font_prefix(id)),
    };
    format!(
        r##"#import "/markie/scope.typ": markie-scope
#let c-fg = rgb("{fg}")
#let c-border = rgb("{border}")
#let c-link = rgb("{link}")
#let c-strong = rgb("{strong}")
#let c-del = rgb("{del}")
#let c-marker = rgb("{marker}")
#let sans = ({body_font}"SF NS", "Helvetica Neue", "Helvetica", "Arial", "Lucida Grande", "Apple Symbols", "Hiragino Sans GB", "Apple SD Gothic Neo", "Arial Unicode MS", "New Computer Modern")
#let mono = ({code_font}"Menlo", "DejaVu Sans Mono")
#let heading-font = {heading_font}
#set document(title: none)
#set page(paper: "a4", margin: (x: 2.2cm, y: 2cm), fill: rgb("{bg}"))
#set text(font: sans, size: 10.5pt, fill: c-fg, {edges}, hyphenate: false, overhang: false, lang: "en", tracking: {t_body:.5}em)
// CSS breaks lines greedily and never shrinks a space to fit a word.
#set par(leading: 0pt, spacing: 0pt, justify: false, linebreaks: "simple", justification-limits: (spacing: (min: 100%, max: 100%)))
#set block(above: 0pt, below: 0pt)
#set table.cell(breakable: false)
#show raw: set text(font: mono, tracking: 0em, size: 1.25em)
#set raw(theme: "/markie/hljs.tmTheme")
#let col = {col:.2}pt
// The export's fit script lets a block that avoids breaking break after all
// when it is over half the page's content height.
#let half = 364.25pt
#let avoid(body) = context {{
  let h = measure(width: col, body).height
  block(breakable: h > half, width: 100%, body)
}}
// Orphans and widows 2, and Chromium's exception: a three-line paragraph
// may leave one line behind rather than move whole.
#let mk-p(body, w, lh) = context {{
  let n = calc.round(measure(width: w, par(body)).height / lh)
  if n == 3 {{ set text(costs: (widow: 0%)); par(body) }} else {{ par(body) }}
}}
#let mk-heading(size, weight, pad, rule, color, track, top-edge: 0pt, bottom-edge: 0pt, body) = block(width: 100%, inset: (bottom: pad), stroke: if rule {{ (bottom: 0.75pt + c-border) }} else {{ none }}, outset: (bottom: -0.375pt), text(font: heading-font, size: size, weight: weight, fill: color, tracking: track, top-edge: top-edge, bottom-edge: bottom-edge, par(body)))
#let mk-quote(top, bottom, body, bar: rgb("{quote_bar}")) = block(width: 100%, fill: rgb("{quote_bg}"), stroke: (left: 2.25pt + bar), outset: (left: -1.125pt), radius: (right: 4.5pt), inset: (left: 12.75pt, right: 10.5pt, top: top, bottom: bottom), {{ set text(fill: rgb("{quote_fg}")); body }})
// A Markdown style's quotes: the bar alone, italics, a centred pull quote, or a card.
#let mk-quote-plain(bar, italic, pull, body) = block(width: 100%, stroke: if pull {{ none }} else {{ (left: 2.25pt + (if bar == none {{ rgb("{quote_bar}") }} else {{ bar }})) }}, outset: (left: -1.125pt), inset: if pull {{ (x: 25.2pt, y: 5pt) }} else {{ (left: 12.75pt, right: 10.5pt, y: 1.05pt) }}, {{ set text(fill: if italic {{ c-fg }} else {{ rgb("{quote_fg}") }}, style: if italic {{ "italic" }} else {{ "normal" }}, size: if pull {{ 1.2em }} else {{ 1em }}); if pull {{ align(center, body) }} else {{ body }} }})
#let mk-quote-card(top, bottom, body) = block(width: 100%, fill: rgb("{quote_bg}"), stroke: 0.75pt + c-border, radius: 6pt, inset: (x: 11.55pt, top: top, bottom: bottom), {{ set text(fill: rgb("{quote_fg}")); body }})
// A Markdown style's dividers, list markers and link marks.
#let mk-mark(s, fill: c-marker) = align(right, text(fill: fill, number-width: "tabular", s) + h(3.04pt))
#let mk-shape(kind, fill: c-marker) = align(right, "\u{{200b}}" + box(move(dy: -1.56pt, if kind == "square" {{ rect(width: 3.72pt, height: 3.72pt, fill: fill, stroke: none) }} else if kind == "circle" {{ circle(radius: 1.61pt, fill: none, stroke: 0.5pt + fill) }} else {{ circle(radius: 1.86pt, fill: fill, stroke: none) }})) + h(9.24pt))
#let mk-under(body, paint: c-link, dotted: false) = underline(stroke: (paint: paint, thickness: 0.75pt, dash: if dotted {{ "dotted" }} else {{ "solid" }}), offset: 2.5pt, body)
// Inline code: padding 0.15em 0.35em and a 1px border inside the box; the
// background covers the font's ascent and descent plus the padding.
#let mk-code(s, size, top, bot, ot, ob, kind: "chip") = box(fill: if kind == "chip" or kind == "flat" {{ rgb("{code_bg}") }} else {{ none }}, stroke: if kind == "chip" or kind == "bordered" {{ 0.75pt + rgb("{code_border}") }} else {{ none }}, radius: 3pt, inset: (x: if kind == "plain" {{ 0pt }} else {{ size * 0.35 + 0.75pt }}), outset: (top: ot, bottom: ob, x: if kind == "chip" or kind == "bordered" {{ -0.375pt }} else {{ 0pt }}), text(size: size, top-edge: top, bottom-edge: bot, fill: if kind == "flat" or kind == "bordered" {{ c-fg }} else {{ rgb("{code_fg}") }}, raw(s)))
// <pre>: margin 1em 0, padding 1em 1.2em inside a 1px border, 0.85em code.
// The padding is spacing, not inset, so a block that breaks across pages
// slices it as CSS does: none at the break. Its lines keep CSS's initial
// orphans and widows of 2, which are Typst's too.
#let mk-pre(body, top-edge: 0pt, bottom-edge: 0pt, frame: "card") = avoid(block(width: 100%, fill: if frame == "bordered" {{ none }} else {{ rgb("{pre_bg}") }}, stroke: if frame == "flat" {{ none }} else if frame == "bar" {{ (left: 2.25pt + c-marker) }} else {{ 0.75pt + c-border }}, outset: if frame == "card" or frame == "bordered" {{ -0.375pt }} else {{ 0pt }}, radius: if frame == "bar" {{ 0pt }} else if frame == "flat" {{ 4.5pt }} else {{ 6pt }}, inset: (x: 13.35pt), {{ set text(size: 8.925pt, fill: rgb("{pre_fg}"), top-edge: top-edge, bottom-edge: bottom-edge); v(11.25pt); body; v(11.25pt) }}))
// Chromium's `list-style-type: disc`: a 3.72pt disc centred 3.42pt above the
// baseline, its right edge 9.24pt before the text (measured from Electron's PDF).
#let mk-disc = align(right, "\u{{200b}}" + box(move(dy: -1.56pt, circle(radius: 1.86pt, fill: c-marker, stroke: none))) + h(9.24pt))
// `::marker` uses tabular digits.
#let mk-num(s) = align(right, text(fill: c-marker, number-width: "tabular", s) + h(3.04pt))
#let mk-box(on, kind: "box") = box(baseline: 15%, width: 10.5pt, height: 10.5pt, stroke: (if kind == "minimal" {{ 1.125pt }} else {{ 1.5pt }}) + (if on {{ rgb("{box_on}") }} else if kind == "minimal" {{ c-marker }} else {{ rgb("{box_border}") }}), radius: if kind == "round" {{ 50% }} else {{ 2.25pt }}, fill: if on and kind != "minimal" {{ rgb("{box_on}") }} else {{ none }}, if on {{ align(center + horizon, text(size: 7.5pt, weight: 700, fill: if kind == "minimal" {{ rgb("{box_on}") }} else {{ rgb("{box_tick}") }}, "✓")) }}) + h(3.75pt)
#let mk-embed(path, url) = link(url, box(clip: true, radius: 6pt, width: calc.min(col, 480pt), height: calc.min(col, 480pt) * 9 / 16, image(path, width: 100%, height: 100%, fit: "cover")))
#let mk-video() = box(width: 225pt, height: 112.5pt, fill: rgb("#000000"), radius: 0pt)
#let mk-audio() = box(width: 225pt, height: 40.5pt, fill: rgb("#f1f3f4"), radius: 20pt)
#let mk-math(code, display) = {{
  let eq = eval(code, mode: "math", scope: markie-scope)
  box(text(size: 1.05em, font: ("New Computer Modern Math", "New Computer Modern"), math.equation(block: false, if display {{ math.display(eq) }} else {{ eq }})))
}}
// `.katex-display`: the formula is one centred line box with the strut.
#let mk-display(eq) = avoid(align(center, par("\u{{200b}}" + eq)))
#let mk-head = state("mk-head", "caps")
#let mk-th(top-edge: 0pt, bottom-edge: 0pt, body) = context {{
  let h = mk-head.get()
  if h == "caps" {{ text(size: 8.0325pt, weight: 600, fill: rgb("{th_fg}"), tracking: {t_th:.5}em, top-edge: top-edge, bottom-edge: bottom-edge, upper(body)) }} else {{ text(size: 9.45pt, weight: if h == "bold" {{ 650 }} else if h == "filled" {{ 600 }} else {{ 500 }}, fill: if h == "plain" {{ rgb("{th_fg}") }} else {{ c-fg }}, body) }}
}}
#let mk-td(body) = body
#let mk-table(n, inset, head, top-edge: 0pt, bottom-edge: 0pt, cells, grid: false, zebra: false, plain-head: false, head-style: "caps", full: false) = block(width: if full {{ 100% }} else {{ auto }}, inset: (bottom: 0.375pt), {{
  set text(size: 9.45pt, tracking: {t_td:.5}em, top-edge: top-edge, bottom-edge: bottom-edge)
  mk-head.update(head-style)
  table(columns: if full {{ (1fr,) * n }} else {{ n }}, stroke: if grid {{ 0.75pt + c-border }} else {{ none }}, inset: inset, align: horizon, fill: (x, y) => if head and y == 0 and head-style == "filled" {{ c-border }} else if head and y == 0 and (plain-head or head-style != "caps") {{ none }} else if head and y == 0 {{ rgb("{th_bg}") }} else if zebra and calc.even(y) and y > 0 {{ rgb("{code_bg}") }} else {{ none }}, ..cells)
}})
"##,
        body_font = body_font,
        code_font = code_font,
        heading_font = heading_font,
        fg = p.fg,
        bg = p.bg,
        border = p.border,
        link = p.link,
        strong = p.strong,
        del = p.del,
        marker = p.marker,
        quote_bg = p.quote_bg,
        quote_bar = p.quote_bar,
        quote_fg = p.quote_fg,
        code_bg = p.code_bg,
        code_border = p.code_border,
        code_fg = p.code_fg,
        pre_bg = p.pre_bg,
        pre_fg = p.pre_fg,
        box_on = p.box_on,
        box_border = p.box_border,
        box_tick = p.box_tick,
        th_bg = p.th_bg,
        th_fg = p.th_fg,
        col = COLUMN,
        edges = body.args(),
        t_body = sf_tracking(14.0),
        t_th = sf_tracking(14.0 * 0.9 * 0.85) + 0.04,
        t_td = sf_tracking(12.6),
    )
}

/// The Typst source and files for a document, for tests and debugging.
pub fn typst_source(markdown: &str, opts: &PdfOptions) -> Result<(String, Vec<(String, Vec<u8>)>), String> {
    let tree = crate::render::render_tree(markdown);
    tree_source(&tree, opts)
}

pub fn tree_source(tree: &[Node], opts: &PdfOptions) -> Result<(String, Vec<(String, Vec<u8>)>), String> {
    let p = palette(opts.theme);
    let theme = tm_theme(&p);
    let mut ids = HashSet::new();
    collect_ids(tree, &mut ids);
    let md = opts.look.style.as_ref().map(markie_core::markdown_style::resolve).unwrap_or_default();
    LEADING.with(|l| l.set(md.number("leading")));
    let mut ctx = Ctx { p, opts, files: vec![("/markie/hljs.tmTheme".into(), theme.into_bytes())], ids, error: None, column: COLUMN, quote: false, md, sections: (0, 0), ul_depth: 0, ol_path: Vec::new(), after_p: false, centre: false };
    let blocks = ctx.flow(tree, Inh::block(BODY, false));
    LEADING.with(|l| l.set(1.0));
    if let Some(e) = ctx.error {
        return Err(e);
    }
    let mut source = prelude(&ctx.p, &opts.look);
    // CSS keeps the first block's top margin under the body padding (an h1
    // that is the first child has none); Typst drops spacing at a page top
    // unless something precedes it.
    source.push_str("#block(height: 0pt)\n#");
    source.push_str(&seq(&blocks));
    source.push('\n');
    Ok((source, ctx.files))
}

/// Lays Typst source out into pages.
pub fn layout(source: String, files: Vec<(String, Vec<u8>)>) -> Result<PagedDocument, String> {
    let world = crate::pdf_world::PdfWorld::new(source, files);
    let warned = typst::compile::<PagedDocument>(&world);
    warned.output.map_err(|errors| {
        let image = errors.iter().any(|d| d.message.contains("image") || d.message.contains("decode"));
        if image {
            IMAGE_ERROR.to_string()
        } else {
            let msgs: Vec<String> = errors.iter().map(|d| d.message.to_string()).collect();
            format!("The PDF could not be laid out: {}", msgs.join("; "))
        }
    })
}

/// Compiles Typst source to a PDF.
pub fn compile(source: String, files: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    let doc = layout(source, files)?;
    let pdf = typst_pdf::pdf(&doc, &typst_pdf::PdfOptions::default()).map_err(|errors| {
        let msgs: Vec<String> = errors.iter().map(|d| d.message.to_string()).collect();
        format!("The PDF could not be written: {}", msgs.join("; "))
    })?;
    typst::comemo::evict(64);
    Ok(pdf)
}

/// Markdown to PDF bytes, the way Export PDF makes them.
pub fn export_pdf(markdown: &str, opts: &PdfOptions) -> Result<Vec<u8>, String> {
    let (source, files) = typst_source(markdown, opts)?;
    compile(source, files)
}

/// Where a PDF goes: the extension is forced, as `ensureExtension` does.
pub fn ensure_extension(path: &Path, ext: &str) -> PathBuf {
    let s = path.to_string_lossy();
    if s.to_ascii_lowercase().ends_with(&ext.to_ascii_lowercase()) { path.to_path_buf() } else { PathBuf::from(format!("{s}{ext}")) }
}

/// One line of text as laid out: its page (from 1), baseline and left edge
/// in points from the page's top left, and its text. Spans on one baseline
/// (within 1pt) are one line; a raised superscript is its own.
#[derive(Debug, Clone)]
pub struct TextLine {
    pub page: usize,
    pub y: f64,
    pub x: f64,
    pub text: String,
}

/// The text lines of a laid-out document, for measuring it against
/// Chromium's PDF (`scripts/pdf-lines.py` reads a PDF the same way).
pub fn text_lines(doc: &PagedDocument) -> Vec<TextLine> {
    use typst::layout::{Frame, FrameItem, Point};
    fn walk(frame: &Frame, at: Point, out: &mut Vec<(f64, f64, String, f64)>) {
        for (pos, item) in frame.items() {
            let p = at + *pos;
            match item {
                FrameItem::Group(g) => walk(&g.frame, p + Point::new(g.transform.tx, g.transform.ty), out),
                FrameItem::Text(t) if !t.text.trim().is_empty() => out.push((p.y.to_pt(), p.x.to_pt(), t.text.to_string(), t.size.to_pt())),
                _ => {}
            }
        }
    }
    let mut lines = Vec::new();
    for (i, page) in doc.pages().iter().enumerate() {
        let mut spans = Vec::new();
        walk(&page.frame, Point::zero(), &mut spans);
        spans.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let mut rows: Vec<(f64, Vec<(f64, String)>)> = Vec::new();
        for (y, x, text, size) in spans {
            match rows.last_mut() {
                Some((ry, parts)) if (*ry - y).abs() <= 1.0 && size > 6.0 => parts.push((x, text)),
                _ => rows.push((y, vec![(x, text)])),
            }
        }
        for (y, mut parts) in rows {
            parts.sort_by(|a, b| a.0.total_cmp(&b.0));
            let x = parts[0].0;
            lines.push(TextLine { page: i + 1, y, x, text: parts.into_iter().map(|(_, t)| t).collect() });
        }
    }
    lines
}
