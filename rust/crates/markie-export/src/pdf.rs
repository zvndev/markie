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
}

impl Default for PdfOptions<'_> {
    fn default() -> Self {
        Self { theme: Theme::Light, doc_dir: None, grants: Grants::default(), fetch: None }
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

struct Ctx<'a, 'b> {
    p: Palette,
    opts: &'a PdfOptions<'b>,
    files: Vec<(String, Vec<u8>)>,
    ids: HashSet<String>,
    error: Option<String>,
    /// Width of the column the current content sits in, in points.
    column: f64,
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

impl Ctx<'_, '_> {
    /// A run of inline nodes as one Typst content expression, or None when it
    /// holds only white space.
    fn inline_run(&mut self, nodes: &[Node]) -> Option<String> {
        let mut parts = Vec::new();
        let mut prev_space = true;
        self.inlines(nodes, &mut parts, &mut prev_space);
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

    fn inlines(&mut self, nodes: &[Node], out: &mut Vec<String>, prev_space: &mut bool) {
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
                    if let Some(code) = self.inline_element(e, prev_space) {
                        out.push(code);
                    }
                }
                _ => {}
            }
        }
    }

    fn body(&mut self, e: &Element, prev_space: &mut bool) -> String {
        let mut parts = Vec::new();
        self.inlines(&e.children, &mut parts, prev_space);
        if parts.is_empty() { "[]".into() } else { format!("{{ {} }}", parts.join("; ")) }
    }

    fn anchor(&self, e: &Element) -> String {
        match e.get("id") {
            Some(id) if label_ok(id) => format!("[#metadata(none)<{id}>]; "),
            _ => String::new(),
        }
    }

    fn inline_element(&mut self, e: &Element, prev_space: &mut bool) -> Option<String> {
        let anchor = self.anchor(e);
        let wrap = |s: String| Some(format!("{{ {anchor}{s} }}"));
        match e.tag.as_str() {
            "br" => {
                *prev_space = true;
                Some("linebreak()".into())
            }
            "wbr" => None,
            "strong" | "b" => {
                let b = self.body(e, prev_space);
                wrap(format!("text(weight: 600, fill: c-strong, {b})"))
            }
            "em" | "i" | "cite" | "dfn" | "var" => {
                let b = self.body(e, prev_space);
                wrap(format!("text(style: \"italic\", {b})"))
            }
            "del" | "s" | "strike" => {
                let b = self.body(e, prev_space);
                let fill = if e.tag == "del" { "text(fill: c-del, " } else { "text(" };
                wrap(format!("strike({fill}{b}))"))
            }
            "u" | "ins" => {
                let b = self.body(e, prev_space);
                wrap(format!("underline({b})"))
            }
            "sup" => {
                let b = self.body(e, prev_space);
                wrap(format!("super(size: 0.75em, typographic: false, {b})"))
            }
            "sub" => {
                let b = self.body(e, prev_space);
                wrap(format!("sub(size: 0.75em, typographic: false, {b})"))
            }
            "small" => {
                let b = self.body(e, prev_space);
                wrap(format!("text(size: 0.833em, {b})"))
            }
            "q" => {
                let b = self.body(e, prev_space);
                wrap(format!("{{ \"\u{201c}\"; {b}; \"\u{201d}\" }}"))
            }
            "mark" => {
                let fill = style_decls(e).into_iter().find(|(k, _)| k == "background-color" || k == "background").and_then(|(_, v)| css_color(&v)).unwrap_or_else(|| "rgb(\"#ffff00\")".into());
                let b = self.body(e, prev_space);
                wrap(format!("highlight(fill: {fill}, top-edge: \"ascender\", bottom-edge: \"descender\", text(fill: rgb(\"#000000\"), {b}))"))
            }
            "code" if e.has_class("language-math") && e.has_class("math-inline") => {
                *prev_space = false;
                wrap(self.math(&e.text(), false))
            }
            "code" | "kbd" | "samp" | "tt" => {
                *prev_space = false;
                let text = collapse(&e.text());
                if e.tag == "code" {
                    wrap(format!("mk-code({})", lit(&text)))
                } else {
                    wrap(format!("text(font: mono, size: 0.875em, raw({}))", lit(&text)))
                }
            }
            "a" => {
                let b = self.body(e, prev_space);
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
                let b = if !text.is_empty() && !text.contains(char::is_whitespace) && text.chars().count() <= 60 { format!("box({b})") } else { b };
                match dest {
                    Some(d) => wrap(format!("link({d}, text(fill: c-link, {b}))")),
                    // An anchor with no usable target is text in the link colour
                    // (sanitized-away hrefs keep their colour in the stylesheet).
                    None => wrap(format!("text(fill: c-link, {b})")),
                }
            }
            "img" => {
                *prev_space = false;
                self.image(e, false).map(|s| format!("{{ {anchor}{s} }}"))
            }
            "input" => {
                *prev_space = false;
                (e.get("type") == Some("checkbox")).then(|| format!("mk-box({})", e.has("checked")))
            }
            "video" | "audio" => {
                *prev_space = false;
                Some(if e.tag == "video" { "mk-video()".into() } else { "mk-audio()".into() })
            }
            "span" => {
                let b = self.body(e, prev_space);
                if e.has_class("katex-error") {
                    return wrap(format!("text(fill: rgb(\"#cc0000\"), {b})"));
                }
                wrap(self.styled(e, b))
            }
            _ => {
                let b = self.body(e, prev_space);
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
        if alone.is_err() {
            return format!("text(fill: rgb(\"#cc0000\"), {})", lit(tex));
        }
        match markie_math::to_typst(tex) {
            Ok(code) => format!("mk-math({}, {display})", lit(&code)),
            Err(_) => format!("text(fill: rgb(\"#cc0000\"), {})", lit(tex)),
        }
    }

    /// Loads a picture into the world and returns the Typst code drawing it.
    fn image(&mut self, e: &Element, block: bool) -> Option<String> {
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
        // Natural size in CSS px, then the attributes, then the column.
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
            _ => format!("width: auto"),
        };
        let image = format!("image({}, {size})", lit(&path));
        let rounded = format!("box(clip: true, radius: 6pt, {image})");
        Some(if block { rounded } else { format!("box(baseline: 0pt, {rounded})") })
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

    /// A container's children as Typst block statements.
    fn blocks(&mut self, nodes: &[Node], quote: bool) -> Vec<String> {
        let mut out = Vec::new();
        let mut run: Vec<Node> = Vec::new();
        let flush = |this: &mut Self, run: &mut Vec<Node>, out: &mut Vec<String>| {
            if run.is_empty() {
                return;
            }
            let nodes = std::mem::take(run);
            if let Some(body) = this.inline_run(&nodes) {
                out.push(format!("mk-par({body}, {quote})"));
            }
        };
        for node in nodes {
            if is_inline(node) {
                run.push(node.clone());
                continue;
            }
            flush(self, &mut run, &mut out);
            if let Node::Element(e) = node
                && let Some(code) = self.block(e, quote)
            {
                out.push(code);
            }
        }
        flush(self, &mut run, &mut out);
        out
    }

    fn joined(&mut self, nodes: &[Node], quote: bool) -> String {
        let blocks = self.blocks(nodes, quote);
        if blocks.is_empty() { "[]".into() } else { format!("{{ {} }}", blocks.join("\n")) }
    }

    fn block(&mut self, e: &Element, quote: bool) -> Option<String> {
        let anchor = self.anchor(e);
        let code = match e.tag.as_str() {
            "p" => {
                if e.has_class("markie-embed") {
                    return self.embed(e);
                }
                // A paragraph that is one picture: the picture as a block.
                let meaningful: Vec<&Node> = e.children.iter().filter(|n| !matches!(n, Node::Text(t) if t.trim().is_empty())).collect();
                if let [Node::Element(img)] = meaningful.as_slice()
                    && img.tag == "img"
                {
                    let image = self.image(img, true)?;
                    return Some(format!("{anchor}mk-figure({image})"));
                }
                let al = text_align(e).unwrap_or("left");
                let body = self.inline_run(&e.children)?;
                let body = self.styled(e, body);
                format!("mk-par(align({al}, {body}), {quote})")
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = e.tag[1..].parse::<usize>().unwrap_or(1);
                let al = text_align(e).unwrap_or("left");
                let body = self.inline_run(&e.children).unwrap_or_else(|| "[]".into());
                let body = self.styled(e, body);
                format!("mk-h{level}(align({al}, {body}))")
            }
            "hr" => "mk-hr()".into(),
            "blockquote" => {
                let inner = self.joined(&e.children, true);
                format!("mk-quote({inner})")
            }
            "ul" | "ol" => self.list(e, quote),
            "pre" => {
                if let Some(Node::Element(code)) = e.children.iter().find(|c| matches!(c, Node::Element(_)))
                    && code.has_class("math-display")
                {
                    return Some(format!("mk-display({})", self.math(&code.text(), true)));
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
                format!("mk-pre(raw(block: true{lang}, {}))", lit(&text))
            }
            "table" => self.table(e)?,
            "img" => {
                let image = self.image(e, true)?;
                format!("mk-figure({image})")
            }
            "video" => "mk-par(mk-video(), false)".into(),
            "audio" => "mk-par(mk-audio(), false)".into(),
            "dl" => {
                let inner = self.joined(&e.children, quote);
                format!("block(above: 10.5pt, below: 10.5pt, {inner})")
            }
            "dd" => {
                let inner = self.joined(&e.children, quote);
                format!("pad(left: 30pt, {inner})")
            }
            "details" | "summary" | "div" | "section" | "article" | "figure" | "figcaption" | "dt" | "picture" | "header" | "footer" | "main" | "nav" | "aside" => {
                let inner = self.joined(&e.children, quote);
                let inner = self.styled(e, inner);
                match text_align(e) {
                    Some(al) => format!("align({al}, {inner})"),
                    None => inner,
                }
            }
            _ => self.joined(&e.children, quote),
        };
        Some(format!("{anchor}{code}"))
    }

    fn list(&mut self, e: &Element, quote: bool) -> String {
        let ordered = e.tag == "ol";
        let mut number: i64 = e.get("start").and_then(|s| s.trim().parse().ok()).unwrap_or(1);
        let mut items = Vec::new();
        for child in &e.children {
            let Node::Element(li) = child else { continue };
            if li.tag != "li" {
                continue;
            }
            let anchor = self.anchor(li);
            let task = li.has_class("task-list-item");
            let body = self.joined(&li.children, quote);
            let marker = if task {
                "none".to_string()
            } else if ordered {
                lit(&format!("{number}."))
            } else {
                lit("•")
            };
            // A loose item's paragraph margins collapse through the <li>.
            let loose = li.children.iter().any(|c| matches!(c, Node::Element(p) if p.tag == "p"));
            let gap = if loose { "7.35pt" } else { "2.625pt" };
            items.push(format!("{anchor}mk-li({marker}, {gap}, {body})"));
            number += 1;
        }
        format!("mk-list({{ {} }})", items.join("\n"))
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
        let mut cells = Vec::new();
        let mut header = Vec::new();
        for r in &head {
            for c in r.children.iter().filter_map(cell) {
                let al = text_align(c).unwrap_or("left");
                let content = self.inline_run(&c.children).unwrap_or_else(|| "[]".into());
                header.push(format!("mk-th(align({al}, {content}))"));
            }
            header.extend((r.children.iter().filter_map(cell).count()..columns).map(|_| "[]".to_string()));
        }
        let rows = body.len();
        for (ri, r) in body.iter().enumerate() {
            let n = r.children.iter().filter_map(cell).count();
            for c in r.children.iter().filter_map(cell) {
                let al = text_align(c).unwrap_or("left");
                let content = self.inline_run(&c.children).unwrap_or_else(|| "[]".into());
                let strong = c.tag == "th";
                let content = if strong { format!("text(weight: 600, {content})") } else { content };
                cells.push(format!("mk-td(align({al}, {content}))"));
            }
            cells.extend((n..columns).map(|_| "mk-td([])".to_string()));
            if ri + 1 < rows || rows > 0 {
                cells.push(format!("table.hline(y: {}, stroke: 0.75pt + c-border)", ri + 1 + usize::from(!head.is_empty())));
            }
        }
        let header = if header.is_empty() { String::new() } else { format!("table.header({}), table.hline(stroke: 1.5pt + c-border), ", header.join(", ")) };
        Some(format!("mk-table({columns}, ({header}{}))", if cells.is_empty() { String::new() } else { format!("{},", cells.join(", ")) }))
    }

    fn embed(&mut self, e: &Element) -> Option<String> {
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
        Some(format!("mk-embed({}, {})", lit(&path), lit(href)))
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

/// The Typst prelude: the stylesheet's rules as Typst functions.
fn prelude(p: &Palette) -> String {
    format!(
        r##"#import "/markie/scope.typ": markie-scope
#let c-fg = rgb("{fg}")
#let c-border = rgb("{border}")
#let c-link = rgb("{link}")
#let c-strong = rgb("{strong}")
#let c-del = rgb("{del}")
#let c-marker = rgb("{marker}")
#let sans = ("SF NS", "Helvetica Neue", "Helvetica", "Arial", "Lucida Grande", "Apple Symbols", "Hiragino Sans GB", "Apple SD Gothic Neo", "Arial Unicode MS", "New Computer Modern")
#let mono = ("Menlo", "DejaVu Sans Mono")
#set document(title: none)
#set page(paper: "a4", margin: (x: 2.2cm, y: 2cm), fill: rgb("{bg}"))
#set text(font: sans, size: 10.5pt, fill: c-fg, top-edge: "ascender", bottom-edge: "descender", hyphenate: false, lang: "en", tracking: {t_body:.5}em)
#set par(leading: 0.557em, spacing: 13.2pt, justify: false)
#show raw: set text(font: mono, tracking: 0em, size: 1.25em)
#set raw(theme: "/markie/hljs.tmTheme")
#let L = 5.85pt
#let col = {col:.2}pt
#let half = 128.5mm
#let avoid(body) = context {{
  let h = measure(width: col, body).height
  block(breakable: h > half, width: 100%, body)
}}
#let mk-par(body, quote) = block(above: (if quote {{ 2.625pt }} else {{ 7.35pt }}) + L, below: (if quote {{ 2.625pt }} else {{ 7.35pt }}) + L, width: 100%, par(body))
#let mk-heading(size, weight, top, bottom, pad, rule, color, track, body) = block(above: top, below: bottom, width: 100%, sticky: true, inset: (bottom: pad), stroke: if rule {{ (bottom: 0.75pt + c-border) }} else {{ none }}, text(size: size, weight: weight, fill: rgb(color), tracking: track, par(leading: 0.557em, body)))
#let mk-h1(body) = mk-heading(21pt, 700, 25.2pt + L, 10.5pt + L, 6.3pt, true, "{h1}", {t_h1:.5}em, body)
#let mk-h2(body) = mk-heading(15.75pt, 600, 20.475pt + L, 7.0875pt + L, 3.94pt, true, "{h2}", {t_h2:.5}em, body)
#let mk-h3(body) = mk-heading(13.125pt, 600, 15.75pt + L, 5.25pt + L, 0pt, false, "{h3}", {t_h3:.5}em, body)
#let mk-h4(body) = mk-heading(11.55pt, 600, 12.7pt + L, 4.04pt + L, 0pt, false, "{h4}", {t_h4:.5}em, body)
#let mk-h5(body) = mk-heading(10.5pt, 600, 10.5pt + L, 3.15pt + L, 0pt, false, "{h5}", {t_body:.5}em, body)
#let mk-h6(body) = mk-heading(10.5pt, 600, 10.5pt + L, 3.15pt + L, 0pt, false, "{h6}", {t_body:.5}em, body)
#let mk-hr() = block(above: 18.9pt + L, below: 18.9pt + L, line(length: 100%, stroke: 0.75pt + c-border))
#let mk-quote(body) = block(above: 10.5pt + L, below: 10.5pt + L, width: 100%, fill: rgb("{quote_bg}"), stroke: (left: 2.25pt + rgb("{quote_bar}")), radius: (right: 4.5pt), inset: (x: 10.5pt, y: 5.25pt), {{ set text(fill: rgb("{quote_fg}")); body }})
#let mk-code(s) = box(fill: rgb("{code_bg}"), stroke: 0.75pt + rgb("{code_border}"), radius: 3pt, inset: (x: 0.35em * 0.88), outset: (y: 0.2em), text(size: 0.88em, fill: rgb("{code_fg}"), raw(s)))
#let mk-pre(body) = block(above: 10.5pt + L, below: 10.5pt + L, width: 100%, avoid(block(width: 100%, fill: rgb("{pre_bg}"), stroke: 0.75pt + c-border, radius: 6pt, inset: (x: 12.6pt, y: 10.5pt), {{ set text(size: 8.925pt, fill: rgb("{pre_fg}"), top-edge: "ascender", bottom-edge: "descender"); set par(leading: 0.35em); body }})))
#let mk-list(items) = block(above: 6.3pt + L, below: 6.3pt + L, width: 100%, items)
#let mk-li(marker, gap, body) = block(above: gap + L, below: gap + L, width: 100%, if marker == none {{ pad(left: 0.3em, body) }} else {{ grid(columns: (1.8em, 1fr), align(right, text(fill: c-marker, marker) + h(0.45em)), body) }})
#let mk-box(on) = box(baseline: 15%, width: 10.5pt, height: 10.5pt, stroke: 1.5pt + (if on {{ rgb("{box_on}") }} else {{ rgb("{box_border}") }}), radius: 2.25pt, fill: if on {{ rgb("{box_on}") }} else {{ none }}, if on {{ align(center + horizon, text(size: 7.5pt, weight: 700, fill: rgb("{box_tick}"), "✓")) }}) + h(3.75pt)
#let mk-figure(img) = block(above: 10.5pt + L, below: 10.5pt + L, img)
#let mk-embed(path, url) = block(above: 10.5pt + L, below: 10.5pt + L, link(url, box(clip: true, radius: 6pt, width: calc.min(col, 480pt), height: calc.min(col, 480pt) * 9 / 16, image(path, width: 100%, height: 100%, fit: "cover"))))
#let mk-video() = box(width: 225pt, height: 112.5pt, fill: rgb("#000000"), radius: 0pt)
#let mk-audio() = box(width: 225pt, height: 40.5pt, fill: rgb("#f1f3f4"), radius: 20pt)
#let mk-math(code, display) = {{
  let eq = eval(code, mode: "math", scope: markie-scope)
  text(size: 1.05em, font: ("New Computer Modern Math", "New Computer Modern"), math.equation(block: display, eq))
}}
#let mk-display(eq) = block(above: 10.5pt + L, below: 10.5pt + L, width: 100%, avoid(align(center, eq)))
#let mk-th(body) = text(size: 0.85em, weight: 600, fill: rgb("{th_fg}"), tracking: {t_th:.5}em, upper(body))
#let mk-td(body) = body
#let mk-table(n, cells) = block(above: 10.5pt + L, below: 10.5pt + L, avoid({{
  set text(size: 0.9em, tracking: {t_td:.5}em)
  table(columns: n, stroke: none, inset: (x: 0.8em, y: 0.5em), fill: (x, y) => if y == 0 {{ rgb("{th_bg}") }} else {{ none }}, ..cells)
}}))
"##,
        fg = p.fg,
        bg = p.bg,
        border = p.border,
        link = p.link,
        strong = p.strong,
        del = p.del,
        marker = p.marker,
        h1 = p.h[0],
        h2 = p.h[1],
        h3 = p.h[2],
        h4 = p.h[3],
        h5 = p.h[4],
        h6 = p.h[5],
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
        t_body = sf_tracking(14.0),
        t_h1 = sf_tracking(28.0) - 0.025,
        t_h2 = sf_tracking(21.0) - 0.02,
        t_h3 = sf_tracking(17.5),
        t_h4 = sf_tracking(15.4),
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
    let mut ctx = Ctx { p, opts, files: vec![("/markie/hljs.tmTheme".into(), theme.into_bytes())], ids, error: None, column: COLUMN };
    let blocks = ctx.blocks(tree, false);
    if let Some(e) = ctx.error {
        return Err(e);
    }
    // The first heading sits at the top of the page (h1:first-child).
    let mut source = prelude(&ctx.p);
    source.push_str("#{\n");
    // CSS keeps the first block's top margin under the body padding (only an
    // h1 that is the first child drops it); Typst drops spacing at a page top
    // unless something precedes it.
    let first_h1 = matches!(tree.iter().find(|n| matches!(n, Node::Element(_))), Some(Node::Element(e)) if e.tag == "h1");
    if !first_h1 {
        source.push_str("block(height: 0pt, above: 0pt, below: 0pt)\n");
    }
    for b in &blocks {
        source.push_str(b);
        source.push('\n');
    }
    source.push_str("}\n");
    Ok((source, ctx.files))
}

/// Compiles Typst source to a PDF.
pub fn compile(source: String, files: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    let world = crate::pdf_world::PdfWorld::new(source, files);
    let warned = typst::compile::<PagedDocument>(&world);
    let doc = warned.output.map_err(|errors| {
        let image = errors.iter().any(|d| d.message.contains("image") || d.message.contains("decode"));
        if image {
            IMAGE_ERROR.to_string()
        } else {
            let msgs: Vec<String> = errors.iter().map(|d| d.message.to_string()).collect();
            format!("The PDF could not be laid out: {}", msgs.join("; "))
        }
    })?;
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
