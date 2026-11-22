//! `renderMarkdownHTML` (`src/lib/markdown-html.ts`): Markdown to the
//! sanitized HTML every export, print and PDF starts from.
//!
//! Electron's chain is remark-parse, remark-gfm, remark-math with strict
//! single-dollar math, remark-rehype, rehype-raw, rehype-media, rehype-embeds,
//! rehype-highlight, rehype-katex, rehype-sanitize, rehype-contain-styles,
//! rehype-stringify. This runs the same steps in the same order, with one
//! change: math is drawn by markie-math (the editor's renderer, MATH.md) as
//! inline SVG instead of KaTeX HTML, after the sanitizer, as trusted output.

use crate::embeds::parse_embed;
use crate::hast::{self, Element, Node};
use crate::{highlight, markdown, sanitize};

/// How math is drawn into HTML.
#[derive(Clone, Copy, Debug)]
pub struct MathColor(pub [u8; 4]);

/// The sanitized tree, before math is drawn. The PDF path walks this.
pub fn render_tree(markdown_text: &str) -> Vec<Node> {
    let raw = markdown::markdown_to_html(markdown_text);
    let mut tree = hast::parse_fragment(&raw);
    rehype_media(&mut tree);
    rehype_embeds(&mut tree);
    let mut tree = sanitize::export_schema().sanitize(tree);
    sanitize::contain_styles(&mut tree);
    highlight::highlight_tree(&mut tree);
    tree
}

/// Markdown to the HTML an export carries, math as SVG in `color`.
pub fn render_markdown_html_with(markdown_text: &str, color: MathColor) -> String {
    let mut tree = render_tree(markdown_text);
    crate::math_html::draw_math(&mut tree, color.0);
    hast::to_html(&tree)
}

/// Markdown to export HTML with math in the light theme's text colour.
pub fn render_markdown_html(markdown_text: &str) -> String {
    render_markdown_html_with(markdown_text, MathColor([0x1a, 0x1a, 0x2e, 0xff]))
}

const VIDEO_EXT: &[&str] = &["mp4", "m4v", "webm", "ogv", "mov"];
const AUDIO_EXT: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "oga", "opus"];

/// `mediaTagFor`: a picture reference that is really a clip.
pub fn media_tag_for(src: &str) -> Option<&'static str> {
    let raw = src.trim();
    if raw.is_empty() {
        return None;
    }
    let path = raw.split(['?', '#']).next().unwrap_or("");
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
    if VIDEO_EXT.contains(&ext.as_str()) {
        Some("video")
    } else if AUDIO_EXT.contains(&ext.as_str()) {
        Some("audio")
    } else {
        None
    }
}

/// `rehype-media.ts`: `![](clip.mp4)` plays instead of showing a broken picture.
pub fn rehype_media(nodes: &mut [Node]) {
    hast::walk_mut(nodes, &mut |e| {
        if e.tag != "img" {
            return;
        }
        let src = e.get("src").unwrap_or("").to_string();
        if let Some(tag) = media_tag_for(&src) {
            e.tag = tag.to_string();
            e.attrs = vec![("src".into(), src), ("controls".into(), String::new()), ("preload".into(), "metadata".into())];
            e.children.clear();
        }
    });
}

fn lone_anchor(p: &Element) -> Option<&Element> {
    let mut anchor = None;
    for child in &p.children {
        match child {
            Node::Text(t) if t.trim().is_empty() => {}
            Node::Element(e) if e.tag == "a" && anchor.is_none() => anchor = Some(e),
            _ => return None,
        }
    }
    anchor
}

/// `rehype-embeds.ts`: a video link alone in its paragraph becomes a card.
pub fn rehype_embeds(nodes: &mut [Node]) {
    hast::walk_mut(nodes, &mut |p| {
        if p.tag != "p" {
            return;
        }
        let Some(anchor) = lone_anchor(p) else { return };
        let href = anchor.get("href").unwrap_or("").to_string();
        if anchor.text().trim() != href.trim() {
            return;
        }
        let Some(embed) = parse_embed(&href) else { return };
        let Some(thumbnail) = embed.thumbnail_url() else { return };
        p.set("class", "markie-embed");
        let img = Element::new("img")
            .with_attr("src", &thumbnail)
            .with_attr("alt", &format!("Watch on {}", embed.label()))
            .with_attr("loading", "lazy");
        p.children = vec![Node::Element(Element::new("a").with_attr("href", &embed.url).with_children(vec![Node::Element(img)]))];
    });
}
