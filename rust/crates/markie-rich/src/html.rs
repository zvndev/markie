//! The little HTML the rich editor reads and writes itself.
//!
//! TipTap serializes the formatting Markdown has no syntax for as inline
//! HTML (`rich-extensions.ts`): highlight as `<mark>`, colour, font and size
//! as `<span style>`, underline as `<u>`, an aligned block as `<p style>` or
//! `<hN style>`, a sized picture as `<img width>` and a sized clip as
//! `<video width>`. This module reads those tags the way TipTap's parse rules
//! read them out of the DOM, and writes them the way TipTap writes them.
//! Any other HTML stays source the editor keeps byte for byte.

use crate::model::*;

/// One tag, as written.
#[derive(Debug, Clone, PartialEq)]
pub struct Tag {
    pub name: String,
    pub closing: bool,
    pub attrs: Vec<(String, String)>,
}

impl Tag {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// One property of the `style` attribute, value trimmed and unquoted.
    pub fn style(&self, prop: &str) -> Option<String> {
        let style = self.attr("style")?;
        for decl in style.split(';') {
            if let Some((k, v)) = decl.split_once(':') {
                if k.trim().eq_ignore_ascii_case(prop) {
                    return Some(v.trim().replace(['"', '\''], ""));
                }
            }
        }
        None
    }
}

/// Parse a tag at the start of `s`: `<name attr="v" ...>` or `</name>`.
/// Returns the tag and its length in bytes.
pub fn parse_tag(s: &str) -> Option<(Tag, usize)> {
    let b = s.as_bytes();
    if b.first() != Some(&b'<') {
        return None;
    }
    let mut i = 1;
    let closing = b.get(1) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-') {
        i += 1;
    }
    if i == name_start || !b[name_start].is_ascii_alphabetic() {
        return None;
    }
    let name = s[name_start..i].to_ascii_lowercase();
    let mut attrs = Vec::new();
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        match b.get(i) {
            None => return None,
            Some(b'>') => return Some((Tag { name, closing, attrs }, i + 1)),
            Some(b'/') if b.get(i + 1) == Some(&b'>') => return Some((Tag { name, closing, attrs }, i + 2)),
            _ => {}
        }
        let k0 = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !b"=>/\"'<".contains(&b[i]) {
            i += 1;
        }
        if i == k0 {
            return None;
        }
        let key = s[k0..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if b.get(i) == Some(&b'=') {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            match b.get(i) {
                Some(&q @ (b'"' | b'\'')) => {
                    let end = s[i + 1..].find(q as char)? + i + 1;
                    value = decode_entities(&s[i + 1..end]);
                    i = end + 1;
                }
                Some(_) => {
                    let v0 = i;
                    while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                        i += 1;
                    }
                    value = decode_entities(&s[v0..i]);
                }
                None => return None,
            }
        }
        attrs.push((key, value));
    }
}

/// The character references a browser decodes in text and attributes:
/// the five XML ones, `&nbsp;`, and numeric references.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[1..].find(';').map(|k| k + 1).filter(|k| *k <= 12);
        let decoded = end.and_then(|k| {
            let name = &rest[1..k];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => {
                    if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                        u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                    } else if let Some(dec) = name.strip_prefix('#') {
                        dec.parse::<u32>().ok().and_then(char::from_u32)
                    } else {
                        None
                    }
                }
            };
            ch.map(|c| (c, k + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Text as HTML: what a browser's serializer escapes.
pub fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('\u{a0}', "&nbsp;")
}

/// `escapeAttr` from `rich-media-html.ts`.
pub fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `normalizeWidth` from `rich-media-html.ts`: a whole number of pixels.
pub fn normalize_width(v: &str) -> Option<u32> {
    let t = v.trim();
    let t = t.strip_suffix("px").or_else(|| t.strip_suffix("PX")).unwrap_or(t).trim();
    if t.is_empty() || !t.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse::<u32>().ok().filter(|n| *n > 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

/// `mediaKindOf` from `asset-url.ts`, by file extension.
pub fn media_kind(src: &str) -> MediaKind {
    // `/\.(ext)(\?|#|$)/i` anywhere in the address, as the web regexes read.
    let lower = src.trim().to_ascii_lowercase();
    let has = |exts: &[&str]| {
        exts.iter().any(|e| {
            let pat = format!(".{e}");
            lower.match_indices(&pat).any(|(i, _)| {
                matches!(lower.as_bytes().get(i + pat.len()), None | Some(b'?') | Some(b'#'))
            })
        })
    };
    if has(&["mp4", "m4v", "webm", "ogv", "mov"]) {
        MediaKind::Video
    } else if has(&["mp3", "m4a", "aac", "wav", "flac", "oga", "opus"]) {
        MediaKind::Audio
    } else {
        MediaKind::Image
    }
}

/// An image node from an `<img>`, `<video>` or `<audio>` tag.
pub fn media_node(tag: &Tag) -> Option<Node> {
    if !matches!(tag.name.as_str(), "img" | "video" | "audio") || tag.closing {
        return None;
    }
    let src = tag.attr("data-markie-src").or_else(|| tag.attr("src"))?.to_string();
    let nonempty = |k: &str| tag.attr(k).map(|s| s.to_string());
    Some(Node::Image {
        src,
        alt: nonempty("alt"),
        title: nonempty("title"),
        width: tag.attr("width").and_then(normalize_width),
    })
}

/// `sizedMediaHtml` from `rich-media-html.ts`: the tag for media with a
/// width, or None when `![alt](src)` is still the right thing to write.
pub fn sized_media_html(src: &str, alt: Option<&str>, title: Option<&str>, width: Option<u32>) -> Option<String> {
    let width = width?;
    let kind = media_kind(src);
    if src.is_empty() || kind == MediaKind::Audio {
        return None;
    }
    if kind == MediaKind::Video {
        return Some(format!("<video src=\"{}\" width=\"{width}\" controls></video>", escape_attr(src)));
    }
    let mut parts = vec![format!("src=\"{}\"", escape_attr(src))];
    if let Some(a) = alt.filter(|a| !a.is_empty()) {
        parts.push(format!("alt=\"{}\"", escape_attr(a)));
    }
    if let Some(t) = title.filter(|t| !t.is_empty()) {
        parts.push(format!("title=\"{}\"", escape_attr(t)));
    }
    parts.push(format!("width=\"{width}\""));
    Some(format!("<img {}>", parts.join(" ")))
}

/// `isLoneMediaTag`: one media tag alone on its line, nothing else.
pub fn lone_media_tag(block: &str) -> Option<Node> {
    let t = block.trim();
    let indent = block.len() - block.trim_start_matches(' ').len();
    if indent > 3 || block.contains('\n') && block.trim_end_matches(['\r', '\n']).contains('\n') {
        return None;
    }
    let (tag, len) = parse_tag(t)?;
    let node = media_node(&tag)?;
    let rest = t[len..].trim();
    if rest.is_empty() {
        return Some(node);
    }
    if tag.name != "img" {
        if let Some((close, clen)) = parse_tag(rest) {
            if close.closing && close.name == tag.name && rest[clen..].trim().is_empty() {
                return Some(node);
            }
        }
    }
    None
}

/// An aligned paragraph or heading the editor wrote (`isAlignedBlockTag`),
/// read the way the DOM parser reads its inline HTML.
pub fn aligned_block(block: &str) -> Option<Node> {
    let line = block.trim_end_matches(['\r', '\n']);
    if line.contains('\n') {
        return None;
    }
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let t = line.trim();
    let (open, olen) = parse_tag(t)?;
    let level = match open.name.as_str() {
        "p" => 0u8,
        "h1" => 1,
        "h2" => 2,
        "h3" => 3,
        "h4" => 4,
        "h5" => 5,
        "h6" => 6,
        _ => return None,
    };
    if open.closing || open.attrs.len() != 1 || open.attrs[0].0 != "style" {
        return None;
    }
    let align = open.style("text-align")?;
    let style = open.attr("style").unwrap_or("");
    // The regex in rich-media-html.ts: exactly one text-align declaration.
    let decls: Vec<&str> = style.split(';').filter(|d| !d.trim().is_empty()).collect();
    if decls.len() != 1 || !matches!(align.as_str(), "center" | "right" | "justify" | "left") {
        return None;
    }
    let close = format!("</{}", open.name);
    let body_end = t.to_ascii_lowercase().rfind(&close)?;
    let after = &t[body_end + close.len()..];
    if after.trim_start().trim_start_matches('>').trim() != "" || !after.trim_start().starts_with('>') {
        return None;
    }
    if body_end < olen {
        return None;
    }
    let content = inline_html_content(&t[olen..body_end]);
    let align = Some(align);
    Some(if level == 0 { Node::Paragraph { content, align } } else { Node::Heading { level, content, align } })
}

/// Inline HTML (the inside of an aligned block) as inline content. Math is
/// plain text here, as it is for TipTap: no Markdown runs inside HTML.
pub fn inline_html_content(html: &str) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    let mut marks = Marks::default();
    let mut stack: Vec<(String, Marks)> = Vec::new();
    let mut text = String::new();
    let mut rest = html;
    let flush = |text: &mut String, marks: &Marks, out: &mut Vec<Inline>| {
        if !text.is_empty() {
            out.push(Inline::Text { text: decode_entities(text), marks: marks.clone() });
            text.clear();
        }
    };
    while !rest.is_empty() {
        if rest.starts_with('<') {
            if let Some((tag, len)) = parse_tag(rest) {
                flush(&mut text, &marks, &mut out);
                rest = &rest[len..];
                if tag.name == "br" {
                    out.push(Inline::HardBreak);
                    continue;
                }
                if tag.closing {
                    if let Some(k) = stack.iter().rposition(|(n, _)| *n == tag.name) {
                        marks = stack[k].1.clone();
                        stack.truncate(k);
                    }
                } else {
                    let saved = marks.clone();
                    if apply_tag(&tag, &mut marks) {
                        stack.push((tag.name.clone(), saved));
                    }
                }
                continue;
            }
        }
        let first = rest.chars().next().map_or(1, char::len_utf8);
        let next = rest[first..].find('<').map(|i| i + first).unwrap_or(rest.len());
        text.push_str(&rest[..next]);
        rest = &rest[next..];
    }
    flush(&mut text, &marks, &mut out);
    collapse(out)
}

/// The marks an opening inline tag sets, as TipTap's parse rules read them.
/// Returns false for a tag that sets nothing (its text is kept).
pub fn apply_tag(tag: &Tag, m: &mut Marks) -> bool {
    match tag.name.as_str() {
        "b" | "strong" => m.bold = true,
        "i" | "em" => m.italic = true,
        "s" | "del" | "strike" => m.strike = true,
        "u" => m.underline = true,
        "code" => m.code = true,
        "mark" => {
            let color = tag
                .attr("data-color")
                .filter(|c| !c.is_empty())
                .map(|c| c.to_string())
                .or_else(|| tag.style("background-color"))
                .unwrap_or_default();
            m.highlight = Some(Highlight { color: Some(color) });
        }
        "span" => {
            if tag.attr("style").is_none() {
                return false;
            }
            m.text_style = Some(TextStyle {
                color: Some(tag.style("color").unwrap_or_default()),
                font_family: Some(tag.style("font-family").unwrap_or_default()),
                font_size: Some(tag.style("font-size").unwrap_or_default()),
            });
        }
        "a" => {
            let Some(href) = tag.attr("href") else { return false };
            m.link = Some(Link {
                href: href.to_string(),
                title: tag.attr("title").map(|t| t.to_string()),
                style: LinkStyle::Inline,
            });
        }
        _ => return false,
    }
    true
}

/// ProseMirror's whitespace rule for parsed HTML: runs fold to one space,
/// none at the start, after a break, or at the end.
fn collapse(inlines: Vec<Inline>) -> Vec<Inline> {
    let mut out = Vec::new();
    let mut prev_space = true;
    for i in inlines {
        match i {
            Inline::Text { text, marks } => {
                let mut s = String::new();
                for ch in text.chars() {
                    if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                        if !prev_space {
                            s.push(' ');
                            prev_space = true;
                        }
                    } else {
                        s.push(ch);
                        prev_space = false;
                    }
                }
                out.push(Inline::Text { text: s, marks });
            }
            Inline::HardBreak => {
                trim_end(&mut out);
                out.push(Inline::HardBreak);
                prev_space = true;
            }
            other => {
                out.push(other);
                prev_space = false;
            }
        }
    }
    trim_end(&mut out);
    normalize_inlines(out)
}

fn trim_end(out: &mut Vec<Inline>) {
    while let Some(Inline::Text { text, .. }) = out.last_mut() {
        if text.ends_with(' ') {
            text.pop();
        }
        if text.is_empty() {
            out.pop();
            continue;
        }
        break;
    }
}

/// The opening tag TipTap writes for a highlight.
pub fn mark_open(h: &Highlight) -> String {
    match h.color.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => {
            let c = escape_attr(c);
            format!("<mark data-color=\"{c}\" style=\"background-color: {c}; color: inherit;\">")
        }
        None => "<mark>".into(),
    }
}

/// The opening tag TipTap writes for a text style, or None when it has no
/// property worth writing.
pub fn span_open(t: &TextStyle) -> Option<String> {
    let mut style = String::new();
    for (prop, v) in [("color", &t.color), ("font-family", &t.font_family), ("font-size", &t.font_size)] {
        if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
            if !style.is_empty() {
                style.push(' ');
            }
            style.push_str(&format!("{prop}: {v};"));
        }
    }
    if style.is_empty() { None } else { Some(format!("<span style=\"{}\">", escape_attr(&style))) }
}

/// Inline content as HTML, for an aligned block (`getHTMLFromFragment`).
pub fn inline_to_html(inlines: &[Inline]) -> String {
    let mut out = String::new();
    for inl in inlines {
        match inl {
            Inline::Text { text, marks } => {
                let mut open = String::new();
                let mut close: Vec<&str> = Vec::new();
                if let Some(l) = &marks.link {
                    open.push_str(&format!(
                        "<a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"{}\"{}>",
                        escape_attr(&l.href),
                        l.title.as_ref().map(|t| format!(" title=\"{}\"", escape_attr(t))).unwrap_or_default()
                    ));
                    close.push("</a>");
                }
                if let Some(s) = marks.text_style.as_ref().and_then(span_open) {
                    open.push_str(&s);
                    close.push("</span>");
                }
                for (on, o, c) in [
                    (marks.bold, "<strong>", "</strong>"),
                    (marks.italic, "<em>", "</em>"),
                    (marks.strike, "<s>", "</s>"),
                    (marks.underline, "<u>", "</u>"),
                    (marks.code, "<code>", "</code>"),
                ] {
                    if on {
                        open.push_str(o);
                        close.push(c);
                    }
                }
                if let Some(h) = &marks.highlight {
                    open.push_str(&mark_open(h));
                    close.push("</mark>");
                }
                out.push_str(&open);
                out.push_str(&escape_text(text));
                for c in close.iter().rev() {
                    out.push_str(c);
                }
            }
            Inline::Math { source } => out.push_str(&escape_text(source)),
            Inline::HardBreak => out.push_str("<br>"),
        }
    }
    out
}

/// `<p style="text-align: center;">…</p>`, as rich-aligned-blocks.ts writes it.
pub fn aligned_html(tag: &str, align: &str, content: &[Inline]) -> String {
    format!("<{tag} style=\"text-align: {align};\">{}</{tag}>", inline_to_html(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_and_styles() {
        let (t, n) = parse_tag("<span style=\"color: red; font-size: 20px\">x").unwrap();
        assert_eq!(n, 42);
        assert_eq!(t.style("color").as_deref(), Some("red"));
        assert_eq!(t.style("font-size").as_deref(), Some("20px"));
        assert!(parse_tag("< span>").is_none());
        let (img, _) = parse_tag("<img src=\"a b.png\" alt=\"q&quot;\" width=120 />").unwrap();
        assert_eq!(img.attr("alt"), Some("q\""));
        assert_eq!(media_node(&img), Some(Node::Image { src: "a b.png".into(), alt: Some("q\"".into()), title: None, width: Some(120) }));
    }

    #[test]
    fn lone_media_and_aligned() {
        assert!(lone_media_tag("<img src=\"a.png\" width=\"50\">").is_some());
        assert!(lone_media_tag("<video src=\"c.mp4\" width=\"320\" controls></video>").is_some());
        assert!(lone_media_tag("<img src=\"a.png\"> text").is_none());
        let n = aligned_block("<p style=\"text-align: right;\"><a target=\"_blank\" href=\"a.md\">l</a> &amp; &lt;x&gt; <mark>h</mark><br><code>c</code></p>").unwrap();
        let Node::Paragraph { content, align } = &n else { panic!() };
        assert_eq!(align.as_deref(), Some("right"));
        assert_eq!(inline_text(content), "l & <x> h\nc");
        assert!(aligned_block("<p style=\"color: red\">x</p>").is_none());
        assert!(aligned_block("<div style=\"text-align: center\">x</div>").is_none());
    }

    #[test]
    fn writes_tiptap_forms() {
        assert_eq!(
            mark_open(&Highlight { color: Some("#fef08a".into()) }),
            "<mark data-color=\"#fef08a\" style=\"background-color: #fef08a; color: inherit;\">"
        );
        assert_eq!(
            span_open(&TextStyle { color: Some("#2563eb".into()), font_family: None, font_size: Some("20px".into()) }).unwrap(),
            "<span style=\"color: #2563eb; font-size: 20px;\">"
        );
        assert_eq!(sized_media_html("clip.mp4", None, None, Some(320)).unwrap(), "<video src=\"clip.mp4\" width=\"320\" controls></video>");
        assert_eq!(sized_media_html("a.png", Some("x"), None, Some(300)).unwrap(), "<img src=\"a.png\" alt=\"x\" width=\"300\">");
        assert_eq!(sized_media_html("a.mp3", None, None, Some(300)), None);
    }
}
