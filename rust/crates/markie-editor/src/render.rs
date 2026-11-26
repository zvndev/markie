//! Drawing the document: blocks, containers, leaves and atoms.

use std::sync::Arc;

use gpui_kit::component::{ActiveTheme, Theme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::element::{Deco, LeafElement, LeafKey};
use super::layout::{Align, LeafSpec, Seg, SegKind, SegStyle};
use super::media::{self, Source};
use super::{CONTEXT, RichView};
use markie_rich::edit::Unit;
use markie_rich::editor::Pos;
use markie_core::markdown_style::Resolved;
use markie_rich::model::*;
use std::collections::HashSet;

use super::md::{self, Bullet, HeadingRule};

/// Sizes and colours for one frame: the `.markdown-body` rules of
/// `globals.css`, with the template's typography (`style.rs`).
#[derive(Clone)]
pub(crate) struct Look {
    /// The body size, zoom included (`--doc-font-size`).
    pub size: f32,
    pub zoom: f32,
    pub line_height: f32,
    /// em between paragraphs (`--doc-paragraph-gap`).
    pub gap: f32,
    pub fg: Hsla,
    pub muted: Hsla,
    /// `--blue`: links, checked boxes, selected pictures.
    pub link: Hsla,
    /// `--accent`: the unchecked box's edge.
    pub accent: Hsla,
    /// `--surface` and `--surface-2`.
    pub surface: Hsla,
    pub surface2: Hsla,
    pub background: Hsla,
    pub border: Hsla,
    /// `--doc-rule`: heading rules, table lines, code edges.
    pub rule: Hsla,
    /// `--status-yellow`: inline code's ink.
    pub code_fg: Hsla,
    pub selection: Hsla,
    pub caret: Hsla,
    pub find: Hsla,
    pub find_current: Hsla,
    pub font: Font,
    /// The template's heading face, when it is not the body's.
    pub heading_family: Option<SharedString>,
    pub mono: SharedString,
    /// Set when a code font was chosen: its ligatures are turned off, so
    /// code shows the characters that were typed.
    pub code_features: Option<FontFeatures>,
    /// The Markdown style being drawn (md.rs reads it).
    pub md: Resolved,
    /// The link under the pointer (`a:hover`).
    pub hovered_link: Option<(LeafKey, std::ops::Range<usize>)>,
    /// Heights and gaps are set on whole device pixels (this is the window's
    /// scale) in every style but Spacious. Chromium carries fractions of a
    /// pixel from line to line; GPUI rounds each box up, which made a page
    /// of 24.08 px lines about 1% longer than Electron's. Spacious's own
    /// numbers land on whole pixels already, and it is left exactly as it was.
    pub snap: Option<f32>,
    pub focused: bool,
    pub scale: f32,
    /// Reference keys of document links this reader may not follow.
    pub unshared_links: HashSet<String>,
}

/// `--font-geist-mono`: SF Mono, which macOS only hands out under its
/// system name.
pub const MONO: &str = ".AppleSystemUIFontMonospaced";

/// The quote's rule: `--purple`, the same in both tones.
const QUOTE_RULE: u32 = 0xc084fc;

/// Unmeasured blocks away from the screen drawn per frame while a document
/// is still being measured.
const UNMEASURED_PER_FRAME: usize = 48;

impl Look {
    pub(crate) fn base(&self, size: f32) -> SegStyle {
        SegStyle {
            font: self.font.clone(),
            size: px(size),
            color: self.fg,
            background: None,
            underline: false,
            strike: false,
            pad_x: px(0.),
            border: None,
            tracking: px(0.),
            upper: false,
            under: None,
        }
    }

    /// The code face, with its ligatures off when one was chosen.
    fn code_font(&self, from: &Font) -> Font {
        let mut font = Font { family: self.mono.clone(), ..from.clone() };
        if let Some(f) = &self.code_features {
            font.features = f.clone();
        }
        font
    }

    /// `li::marker`'s colour (`markerColor`).
    fn marker_color(&self) -> Hsla {
        match self.md.choice("markerColor") {
            "text" => self.fg,
            "accent" => self.link,
            _ => self.muted,
        }
    }

    fn block_gap(&self) -> f32 {
        self.md.number("blockGap") as f32
    }
}

/// The (h2, h3) section count after `nodes`, in document order.
fn count_headings(nodes: &[Node], c: &mut (u32, u32)) {
    for n in nodes {
        match n {
            Node::Heading { level: 2, .. } => *c = (c.0 + 1, 0),
            Node::Heading { level: 3, .. } => c.1 += 1,
            Node::Blockquote(children) => count_headings(children, c),
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => items.iter().for_each(|i| count_headings(i, c)),
            Node::TaskList { items } => items.iter().for_each(|i| count_headings(&i.content, c)),
            Node::Table { rows } => rows.iter().flatten().for_each(|cell| count_headings(&cell.content, c)),
            _ => {}
        }
    }
}

/// What a leaf carries beyond its runs.
#[derive(Default)]
struct LeafExtras {
    indent: f32,
    prefix: Option<(String, SegStyle)>,
}

/// What a container does to the blocks inside it.
#[derive(Clone, Copy)]
pub(crate) struct Ctx {
    /// A paragraph's line height, when not the template's (a task's 1.6).
    pub line_height: Option<f32>,
    /// Text colour, when not the ink (a quote is muted).
    pub color: Option<Hsla>,
    /// Inside a blockquote, a task item, a list item or a table cell.
    pub quote: bool,
    pub task: bool,
    pub nested: bool,
    /// The block before this one, in the same container, is a paragraph.
    pub after_paragraph: bool,
    /// The block before this one is a picture (for its caption).
    pub after_image: bool,
    /// Text is struck through (a finished task, `taskDone: strike`).
    pub strike: bool,
    /// Paragraphs are centred (a pull quote).
    pub center: bool,
    /// Bulleted and task lists above this block.
    pub ul_depth: u8,
    /// Numbered lists above this block, and the place of the item of each
    /// that holds it (for legal numbering).
    pub ol_depth: u8,
    pub ol_path: [u32; 8],
}

impl Ctx {
    const DOC: Ctx = Ctx {
        line_height: None,
        color: None,
        quote: false,
        task: false,
        nested: false,
        after_paragraph: false,
        after_image: false,
        strike: false,
        center: false,
        ul_depth: 0,
        ol_depth: 0,
        ol_path: [0; 8],
    };
}

/// Stack blocks the way CSS collapses vertical margins: the space between
/// two neighbours is the larger of their margins. Returns the stack and the
/// first top and last bottom margins, which escape to the container.
fn stack(children: Vec<(AnyElement, f32, f32)>, snap: Option<f32>) -> (AnyElement, f32, f32) {
    let mut top = 0.;
    let mut prev: Option<f32> = None;
    let mut out = Vec::with_capacity(children.len());
    for (el, t, b) in children {
        match prev {
            None => top = t,
            Some(pb) => out.push(div().flex_none().h(px(snapped(pb.max(t), snap))).into_any_element()),
        }
        out.push(el);
        prev = Some(b);
    }
    (v_flex().w_full().children(out).into_any_element(), top, prev.unwrap_or(0.))
}

/// `v` on the nearest whole device pixel, when the look asks for that.
fn snapped(v: f32, snap: Option<f32>) -> f32 {
    match snap {
        Some(scale) if scale > 0. => (v * scale).round() / scale,
        _ => v,
    }
}

/// Where a bullet list's disc sits in its 1.8 em gutter.
#[derive(Debug, PartialEq)]
struct Disc {
    left: f32,
    top: f32,
    size: f32,
}

/// Chromium paints `list-style-type: disc` as a shape, not the "•" glyph:
/// `ListMarker::RelativeSymbolMarkerRect` makes it `(ascent * 2 / 3 + 1) / 2`
/// wide and sets it `3 * (ascent - ascent * 2 / 3) / 2` below the ascent
/// line, in whole device pixels (`scale` is the window's). The text line puts
/// its baseline where `layout.rs` does; GPUI's descent is negative. Across,
/// its centre sits 0.685 em before the item's text, measured from Electron
/// at 16 px.
fn disc_marker(size: f32, line_height: f32, ascent: f32, descent: f32, scale: f32, gutter: f32) -> Disc {
    let (ascent, descent) = (ascent.abs(), descent.abs());
    let a = (ascent * scale).floor() as i32;
    let width = ((a * 2 / 3 + 1) / 2) as f32 / scale;
    let below_ascent = (3 * (a - a * 2 / 3) / 2) as f32 / scale;
    let baseline = (line_height - (ascent + descent)) / 2. + ascent;
    Disc { left: gutter - 0.685 * size - width / 2., top: baseline - a as f32 / scale + below_ascent, size: width }
}

impl RichView {
    pub(crate) fn look(&self, theme: &Theme, window: &Window) -> Look {
        let mut font = window.text_style().font();
        font.family = match self.doc_font {
            "system" => super::style::typeface(&self.style.body_font).unwrap_or_else(|| theme.font_family.clone()),
            "sans" => theme.font_family.clone(),
            "mono" => SharedString::from(MONO),
            id => super::style::typeface(id).unwrap_or_else(|| theme.font_family.clone()),
        };
        if self.doc_font == "system" && self.style.body_font == "mono" {
            font.family = SharedString::from(MONO);
        }
        // Headings follow the body unless the template names a face, and a
        // font picked for this document wins over the template's, as there.
        let heading_family = match self.style.heading_font.as_str() {
            "body" => None,
            _ if self.doc_font != "system" => None,
            "system" => Some(theme.font_family.clone()),
            "mono" => Some(SharedString::from(MONO)),
            id => super::style::typeface(id),
        };
        // `--doc-code-family`: the style's or the person's code face. The
        // app's own monospace keeps its ligatures, as it always drew.
        let code_family = match self.style.code_font.as_str() {
            "" | "mono" => None,
            id => super::style::typeface(id),
        };
        let code_features = code_family.as_ref().map(|_| FontFeatures(Arc::new(vec![("liga".into(), 0), ("calt".into(), 0)])));
        // Chromium paints a contenteditable selection in macOS's selected-text
        // colours, opaque under the text, and in the unemphasized ones while
        // the window or the editor is not focused. Measured from Electron
        // 0.9.7 with the system's default blue accent: light #b8d4fa and
        // #bbc5d8, dark #58749a and #858fa2 on screen. GPUI lands about
        // (+5, -1, -3) off a given sRGB value on this display path, so the
        // values below are those less that offset (checked side by side).
        // GPUI Kit's theme caps a selection at 30% alpha, which cannot reach
        // the dark colour, hence a colour here rather than in the theme.
        let dark = theme.mode.is_dark();
        let focused = self.focus.is_focused(window) && window.is_window_active();
        let sel: Hsla = match (dark, focused) {
            (false, true) => rgb(0xb3d5fd).into(),
            (false, false) => rgb(0xb6c6db).into(),
            (true, true) => rgb(0x52759d).into(),
            (true, false) => rgb(0x7f90a5).into(),
        };
        // At the default 16 the template's own size shows through
        // (`appearanceVars`); a size picked for this document wins.
        let base = if (self.doc_size - 16.0).abs() < 0.01 { self.style.font_size } else { self.doc_size };
        Look {
            size: base * self.zoom,
            zoom: self.zoom,
            // `line-height: calc(var(--doc-line-height) * leading)`.
            line_height: self.style.line_height * self.style.md.number("leading") as f32,
            gap: self.style.paragraph_gap,
            fg: theme.foreground,
            muted: theme.muted_foreground,
            link: self.style.link,
            accent: theme.accent,
            surface: theme.muted,
            surface2: theme.secondary,
            background: theme.background,
            border: theme.border,
            rule: self.style.doc_rule,
            code_fg: theme.warning,
            selection: sel,
            caret: theme.caret,
            find: theme.warning.opacity(0.35),
            find_current: theme.warning.opacity(0.75),
            font,
            heading_family,
            mono: code_family.unwrap_or_else(|| SharedString::from(MONO)),
            code_features,
            md: self.style.md.clone(),
            hovered_link: self.hovered_link.clone(),
            snap: (!self.style.md.is_spacious_drawing()).then(|| window.scale_factor()),
            focused: self.focus.is_focused(window),
            scale: window.scale_factor(),
            unshared_links: self.unshared_links.clone(),
        }
    }

    /// A block's outer margins (top, bottom) in px, before collapsing.
    pub(crate) fn margins(n: &Node, look: &Look, ctx: Ctx) -> (f32, f32) {
        let s = look.size;
        let g = look.block_gap();
        match n {
            Node::Paragraph { .. } => {
                let (t, b) = md::paragraph_margins(&look.md, look.gap, ctx.task, ctx.quote, ctx.after_paragraph);
                (t * s, b * s)
            }
            Node::Heading { level, .. } => {
                let h = md::heading(&look.md, *level);
                // `p + h1 { margin-top: 1.6em }`: with no gap of their own,
                // indented paragraphs need air before a heading.
                let top = if ctx.after_paragraph && look.md.choice("paragraphStyle") == "indented" { 1.6 } else { h.top };
                (top * h.size * s, h.bottom * h.size * s)
            }
            Node::HorizontalRule => (2. * g * s, 2. * g * s),
            Node::Table { .. } => (0.9 * g * s, 0.9 * g * s),
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let own = 0.6 * g * s;
                let li = look.md.number("listItemGap") as f32 * s;
                let inner = Ctx { nested: true, quote: false, task: false, after_paragraph: false, ..ctx };
                let first = items.first().and_then(|i| i.first()).map(|n| Self::margins(n, look, inner).0).unwrap_or(0.);
                let last = items.last().and_then(|i| i.last()).map(|n| Self::margins(n, look, inner).1).unwrap_or(0.);
                (own.max(li).max(first), own.max(li).max(last))
            }
            Node::TaskList { .. } => {
                let m = (0.6 * g * s).max(2.4 * look.zoom);
                (m, m)
            }
            // A pull quote is 1.2em, and its margin is in its own em.
            Node::Blockquote(_) if look.md.choice("quoteStyle") == "pull" => (1.2 * g * s, 1.2 * g * s),
            Node::Blockquote(_) | Node::CodeBlock { .. } | Node::Image { .. } => (g * s, g * s),
            _ => (s, s),
        }
    }

    /// The margins of a whole top-level block.
    fn block_margins(&self, b: usize, look: &Look) -> (f32, f32) {
        let block = &self.editor.doc.blocks[b];
        if block.is_opaque() {
            let m = look.gap * look.size;
            return (m, m);
        }
        let nodes = block.nodes();
        let first = Ctx { after_paragraph: self.block_follows_paragraph(b), ..Ctx::DOC };
        let last = Ctx { after_paragraph: nodes.len() > 1 && matches!(nodes[nodes.len() - 2], Node::Paragraph { .. }), ..Ctx::DOC };
        let top = nodes.first().map(|n| Self::margins(n, look, first).0).unwrap_or(0.);
        let bottom = nodes.last().map(|n| Self::margins(n, look, if nodes.len() > 1 { last } else { first }).1).unwrap_or(0.);
        (top, bottom)
    }

    /// Is the block before `b` one that ends in a paragraph?
    fn block_follows_paragraph(&self, b: usize) -> bool {
        b > 0 && self.editor.doc.blocks.get(b - 1).is_some_and(|p| !p.is_opaque() && matches!(p.nodes().last(), Some(Node::Paragraph { .. })))
    }

    /// The section count before each block, for a style that numbers headings.
    fn count_sections(&mut self) {
        if self.heading_counts.0 == self.editor.version && self.heading_counts.1.len() == self.editor.block_count() {
            return;
        }
        let mut c = (0u32, 0u32);
        let mut out = Vec::with_capacity(self.editor.block_count());
        for block in &self.editor.doc.blocks {
            out.push(c);
            if !block.is_opaque() {
                count_headings(block.nodes(), &mut c);
            }
        }
        self.heading_counts = (self.editor.version, out);
    }

    /// Is the document's first block an `h1` (whose top margin CSS drops)?
    fn starts_with_h1(&self) -> bool {
        self.editor.doc.blocks.first().is_some_and(|b| !b.is_opaque() && matches!(b.nodes().first(), Some(Node::Heading { level: 1, .. })))
    }

    pub(crate) fn render_document(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if self.inline_video.as_ref().is_some_and(|v| v.borrow().version != self.editor.version) {
            self.inline_video = None;
        }
        let inline_video = self.inline_video.clone();
        let video_covered = self.web_views_covered;
        {
            let mut s = self.store.borrow_mut();
            // Heights of what was drawn last frame.
            let n = self.editor.block_count();
            if self.heights.len() != n {
                // Blocks came or went: measure everything once more.
                self.heights = vec![None; n];
            } else {
                for (b, bounds) in s.blocks.drain() {
                    if b < n {
                        self.heights[b] = Some(bounds.size.height);
                    }
                }
            }
            s.blocks.clear();
            s.leaves.clear();
            s.table_boxes.clear();
            s.table_words.clear();
            s.atoms.clear();
            s.frame += 1;
        }
        let viewport = match self.thumbnail {
            Some(size) => Bounds::new(point(px(0.), px(0.)), size),
            None => self.scroll.bounds(),
        };
        if (viewport.size.width - self.heights_width).abs() > px(0.5) {
            self.heights_width = viewport.size.width;
            self.heights.iter_mut().for_each(|h| *h = None);
        }
        if self.find.is_some() {
            self.recompute_find(cx);
        }
        let theme = cx.theme().clone();
        let look = self.look(&theme, window);
        if look.md.choice("headingNumbers") == "outline" {
            self.count_sections();
        }
        // `.markie-document-scroll`'s padding: clamp(1.25rem, 3vw, 2.25rem)
        // above and below, clamp(1.5rem, 4vw, 3rem) at the sides, then the
        // column at min(100%, --doc-width).
        let vw = f32::from(window.viewport_size().width);
        // `@media (max-width: 820px)`: 1rem by 1.25rem in a narrow window.
        let narrow = (16., 20.);
        let (pad_y, pad_x) = self.sample.unwrap_or(if vw <= 820. { narrow } else { ((vw * 0.03).clamp(20., 36.), (vw * 0.04).clamp(24., 48.)) });
        let past_end = if self.sample.is_some() { 0. } else { 200. };
        let col = match super::style::width_index(self.page_width) {
            0 => px(self.style.content_width),
            4 => px(100_000.),
            _ => px(self.page_width),
        };
        // The column a top-level table has: min(100%, --doc-width) inside the padding.
        self.table_room = (f32::from(viewport.size.width) - 2. * pad_x).min(f32::from(col)).max(0.);
        let first_h1 = self.starts_with_h1();
        let mut prev_bottom: Option<f32> = None;
        let mut tops: Vec<Pixels> = Vec::with_capacity(self.editor.block_count());
        // Draw what is on screen (with a screen of margin either way), the
        // caret's and selection's ends, and any block not measured yet;
        // the rest is space of its last height.
        let top_visible = if self.thumbnail.is_some() { px(self.thumb_offset) } else { -self.scroll.offset().y };
        let screen = viewport.size.height.max(px(400.));
        // A card's window is drawn with a little to spare and no more.
        let (lo, hi) = if self.thumbnail.is_some() {
            (top_visible - px(24.), top_visible + viewport.size.height + px(24.))
        } else {
            (top_visible - screen, top_visible + screen * 2.)
        };
        let (a, h) = (self.editor.anchor.block, self.editor.head.block);
        let mut y = px(pad_y);
        let mut blocks: Vec<AnyElement> = Vec::new();
        // Consecutive off-screen blocks share one spacer: one element per
        // block made layout cost grow with the document (4 to 5 ms a frame
        // at 900 KB) even though only a screenful is drawn.
        let mut spacer = px(0.);
        // Blocks not measured yet are drawn (and so measured) when near the
        // screen, plus a small batch elsewhere each frame until all are
        // known. Measuring every block in the first frame cost 680 ms at
        // 900 KB, on open and again on every window resize.
        let mut unmeasured_budget = UNMEASURED_PER_FRAME;
        let mut more_to_measure = false;
        for b in 0..self.editor.block_count() {
            // The space above: CSS's collapsed margin between this block and
            // the last, or the first block's own (an h1 has none there).
            let (mt, mb) = self.block_margins(b, &look);
            let gap = match prev_bottom {
                None if first_h1 => 0.,
                None => mt,
                Some(pb) => pb.max(mt),
            };
            prev_bottom = Some(mb);
            tops.push(y + px(gap));
            let height = self.heights.get(b).copied().flatten();
            let near = match height {
                Some(ht) => y + ht >= lo && y <= hi,
                None if y + px(30.) >= lo && y <= hi => true,
                None if unmeasured_budget > 0 => {
                    unmeasured_budget -= 1;
                    true
                }
                None => {
                    more_to_measure = true;
                    false
                }
            };
            y += height.unwrap_or(px(30.));
            if !near && (self.thumbnail.is_some() || (b != a && b != h)) {
                spacer += height.unwrap_or(px(30.));
                continue;
            }
            if spacer > px(0.) {
                blocks.push(div().w_full().h(spacer).into_any_element());
                spacer = px(0.);
            }
            let el = self.render_block(b, &look, window, cx);
            let store = self.store.clone();
            blocks.push(
                div()
                    .relative()
                    .w_full()
                    .flex()
                    .justify_center()
                    .px(px(pad_x))
                    .pt(px(snapped(gap, look.snap)))
                    .child(div().w_full().max_w(col).flex().flex_col().child(match self.block_tints.iter().find(|t| t.0 == b) {
                        // `.markie-vh-block`: 0.9em out to each side, a
                        // 3px edge on the left, rounded on the right.
                        Some(&(_, fill, edge)) => {
                            let em = look.size;
                            div()
                                .ml(px(-0.9 * em))
                                .mr(px(-0.9 * em))
                                .pl(px(0.9 * em - 3.))
                                .pr(px(0.9 * em))
                                .py(px(0.35 * em))
                                .bg(fill)
                                .border_l(px(3.))
                                .border_color(edge)
                                .rounded_tr(px(6.))
                                .rounded_br(px(6.))
                                .child(el)
                                .into_any_element()
                        }
                        None => el,
                    }))
                    .child(
                        canvas(move |bounds, _, _| {
                            store.borrow_mut().blocks.insert(b, bounds);
                        }, |_, _, _, _| {})
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                    )
                    .into_any_element(),
            );
        }
        if spacer > px(0.) {
            blocks.push(div().w_full().h(spacer).into_any_element());
        }
        if more_to_measure {
            window.request_animation_frame();
        }
        // For the section rail: where each block starts, and how tall the
        // page is, from the same pass.
        self.block_tops = tops;
        self.content_height = y + px(pad_y);
        if self.thumbnail.is_some() {
            // A card's miniature: the page alone. No keys, focus, pointer or
            // scrolling of its own.
            return div()
                .size_full()
                .relative()
                .overflow_hidden()
                .bg(theme.background)
                .text_color(theme.foreground)
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(px(-self.thumb_offset))
                        .pt(px(pad_y))
                        .children(blocks)
                        .child(div().h(px(prev_bottom.unwrap_or(0.) + pad_y)).w_full()),
                )
                .into_any_element();
        }
        let view = cx.entity();
        let store = self.store.clone();
        let focus = self.focus.clone();
        let autoscroll = std::mem::take(&mut self.autoscroll);
        let to_top = self.scroll_to_top.take();
        let head = self.editor.head;
        let scroll = self.scroll.clone();
        let view_for_retry = view.clone();
        let retries = if autoscroll { std::mem::take(&mut self.autoscroll_retries) } else { 0 };
        div()
            .id("rich-scroll")
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::on_backspace))
            .on_action(cx.listener(Self::on_delete))
            .on_action(cx.listener(Self::on_delete_word_left))
            .on_action(cx.listener(Self::on_delete_word_right))
            .on_action(cx.listener(Self::on_delete_to_line_start))
            .on_action(cx.listener(Self::on_enter))
            .on_action(cx.listener(Self::on_hard_break))
            .on_action(cx.listener(Self::on_tab))
            .on_action(cx.listener(Self::on_shift_tab))
            .on_action(cx.listener(Self::on_left))
            .on_action(cx.listener(Self::on_right))
            .on_action(cx.listener(Self::on_up))
            .on_action(cx.listener(Self::on_down))
            .on_action(cx.listener(Self::on_select_left))
            .on_action(cx.listener(Self::on_select_right))
            .on_action(cx.listener(Self::on_select_up))
            .on_action(cx.listener(Self::on_select_down))
            .on_action(cx.listener(Self::on_word_left))
            .on_action(cx.listener(Self::on_word_right))
            .on_action(cx.listener(Self::on_select_word_left))
            .on_action(cx.listener(Self::on_select_word_right))
            .on_action(cx.listener(Self::on_line_start))
            .on_action(cx.listener(Self::on_line_end))
            .on_action(cx.listener(Self::on_select_line_start))
            .on_action(cx.listener(Self::on_select_line_end))
            .on_action(cx.listener(Self::on_doc_start))
            .on_action(cx.listener(Self::on_doc_end))
            .on_action(cx.listener(Self::on_select_doc_start))
            .on_action(cx.listener(Self::on_select_doc_end))
            .on_action(cx.listener(Self::on_page_up))
            .on_action(cx.listener(Self::on_page_down))
            .on_action(cx.listener(Self::on_select_all))
            .on_action(cx.listener(Self::on_copy))
            .on_action(cx.listener(Self::on_copy_plain))
            .on_action(cx.listener(Self::on_cut))
            .on_action(cx.listener(Self::on_paste))
            .on_action(cx.listener(Self::on_undo))
            .on_action(cx.listener(Self::on_redo))
            .on_action(cx.listener(Self::on_bold))
            .on_action(cx.listener(Self::on_italic))
            .on_action(cx.listener(Self::on_underline))
            .on_action(cx.listener(Self::on_strike))
            .on_action(cx.listener(Self::on_code))
            .on_action(cx.listener(Self::on_highlight))
            .on_action(cx.listener(Self::on_bullet))
            .on_action(cx.listener(Self::on_ordered))
            .on_action(cx.listener(Self::on_task))
            .on_action(cx.listener(Self::on_align_left))
            .on_action(cx.listener(Self::on_align_center))
            .on_action(cx.listener(Self::on_align_right))
            .on_action(cx.listener(Self::on_link))
            .on_action(cx.listener(Self::on_clear))
            .on_action(cx.listener(Self::on_paragraph))
            .on_action(cx.listener(Self::on_h1))
            .on_action(cx.listener(Self::on_h2))
            .on_action(cx.listener(Self::on_h3))
            .on_action(cx.listener(Self::on_h4))
            .on_action(cx.listener(Self::on_h5))
            .on_action(cx.listener(Self::on_h6))
            .on_action(cx.listener(Self::on_code_block))
            .on_action(cx.listener(Self::on_quote))
            .on_action(cx.listener(Self::on_find))
            .on_action(cx.listener(Self::on_find_next))
            .on_action(cx.listener(Self::on_find_prev))
            .on_action(cx.listener(Self::on_escape))
            .map(|d| self.accessibility(d, window))
            .map(|d| Self::behaviour(d, cx))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .cursor(CursorStyle::IBeam)
            .size_full()
            .relative()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .pt(px(pad_y))
            .bg(theme.background)
            .text_color(theme.foreground)
            .children(blocks)
            // Room past the end, as a page has: a click there goes to the end.
            .child(div().h(px(prev_bottom.unwrap_or(0.) + pad_y + past_end)).w_full())
            .child(
                canvas(
                    move |_bounds, window, cx| {
                        // Keep the caret in sight after keyboard moves.
                        let st = store.borrow();
                        let viewport = scroll.bounds();
                        if let Some(video) = &inline_video {
                            let mut video = video.borrow_mut();
                            let bounds = st.atoms.get(&video.key).copied();
                            video.place(bounds, viewport, video_covered);
                        }
                        let target = to_top.or(autoscroll.then_some((head.block, head.leaf)));
                        if let Some(key) = target {
                            let rect = st
                                .leaves
                                .get(&key)
                                .map(|pl| {
                                    let c = pl.laid.caret(head.offset.min(pl.laid.len), false);
                                    if to_top.is_some() {
                                        Bounds::new(pl.bounds.origin, size(px(1.), px(1.)))
                                    } else {
                                        Bounds::new(point(pl.bounds.origin.x + c.origin.x, pl.bounds.origin.y + c.origin.y), c.size)
                                    }
                                })
                                .or_else(|| st.atoms.get(&key).copied());
                            if let Some(r) = rect {
                                let margin = px(40.);
                                let mut off = scroll.offset();
                                if to_top.is_some() {
                                    off.y -= r.top() - viewport.top() - px(16.);
                                } else if r.top() < viewport.top() + margin {
                                    off.y += viewport.top() + margin - r.top();
                                } else if r.bottom() > viewport.bottom() - margin {
                                    off.y -= r.bottom() - (viewport.bottom() - margin);
                                }
                                let max = scroll.max_offset().y;
                                let wanted = off.y;
                                off.y = off.y.min(px(0.)).max(-max);
                                if off != scroll.offset() {
                                    scroll.set_offset(off);
                                    // A cached view would keep the old offset:
                                    // draw this one again.
                                    let v = view_for_retry.clone();
                                    window.defer(cx, move |_, cx| v.update(cx, |_, cx| cx.notify()));
                                }
                                // Content still growing (pictures loading): try
                                // again next frame, a few times.
                                if wanted < -max - px(1.) && retries < 4 {
                                    let v = view_for_retry.clone();
                                    window.defer(cx, move |_, cx| {
                                        v.update(cx, |v, cx| {
                                            v.autoscroll = true;
                                            v.autoscroll_retries = retries + 1;
                                            cx.notify();
                                        });
                                    });
                                }
                            }
                        }
                    },
                    move |bounds, _, window, cx| {
                        window.handle_input(&focus, ElementInputHandler::new(bounds, view), cx);
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }

    fn render_block(&mut self, b: usize, look: &Look, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let block = &self.editor.doc.blocks[b];
        if block.is_opaque() {
            // Kept as source: shown as written, and edited as written.
            let leaf = self.plain_leaf((b, 0), look, look.size * 0.85, 1.6, look.muted, false, window, cx);
            return div().pl(px(10.)).border_l_2().border_color(look.rule).child(leaf).into_any_element();
        }
        let nodes = block.nodes().to_vec();
        let mut counter = 0usize;
        let mut out = Vec::new();
        self.heading_count = self.heading_counts.1.get(b).copied().unwrap_or_default();
        let mut after_paragraph = self.block_follows_paragraph(b);
        let mut after_image = b > 0 && self.editor.doc.blocks.get(b - 1).is_some_and(|p| !p.is_opaque() && matches!(p.nodes().last(), Some(Node::Image { .. })));
        for (i, n) in nodes.iter().enumerate() {
            let ctx = Ctx { after_paragraph, after_image, ..Ctx::DOC };
            after_image = matches!(n, Node::Image { .. });
            let el = self.render_node(b, n, vec![i], &mut counter, 0, ctx, look, window, cx);
            let (t, bm) = Self::margins(n, look, ctx);
            out.push((el, t, bm));
            after_paragraph = matches!(n, Node::Paragraph { .. });
        }
        stack(out, look.snap).0
    }

    #[allow(clippy::too_many_arguments)]
    fn render_node(
        &mut self,
        b: usize,
        n: &Node,
        path: Vec<usize>,
        counter: &mut usize,
        depth: usize,
        ctx: Ctx,
        look: &Look,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = (b, *counter);
        match n {
            Node::Paragraph { align, content } => {
                *counter += 1;
                let mut base = look.base(look.size);
                if let Some(c) = ctx.color {
                    base.color = c;
                }
                base.strike = ctx.strike;
                // `captionStyle`: italic text on the line straight after a
                // picture is its caption, set small and muted.
                let caption_style = look.md.choice("captionStyle");
                let caption = caption_style != "inline" && ctx.after_image && is_caption(content);
                if caption {
                    base.size = px(look.size * 0.86);
                    base.color = look.muted;
                }
                let lh = ctx.line_height.unwrap_or(look.line_height);
                let style = look.md.choice("paragraphStyle");
                // `text-indent: 1.5em`, but the first paragraph of a run
                // starts flush, as a book sets it, and so does anything
                // inside a list, a quote or a table.
                let indent = if style == "indented" && ctx.after_paragraph && !ctx.quote && !ctx.nested && !ctx.task { 1.5 * look.size } else { 0. };
                let fallback = if ctx.center || (caption && caption_style == "centered") {
                    Align::Center
                } else if style == "justified" {
                    Align::Justify
                } else {
                    Align::Left
                };
                self.rich_leaf(key, look, base, lh, align_or(align, fallback), LeafExtras { indent, prefix: None }, window, cx)
            }
            Node::Heading { level, align, .. } => {
                *counter += 1;
                let h = md::heading(&look.md, *level);
                let size = look.size * h.size;
                let mut base = look.base(size);
                base.font.weight = FontWeight(h.weight);
                if let Some(f) = &look.heading_family {
                    base.font.family = f.clone();
                }
                if *level >= 5 {
                    base.color = look.muted;
                }
                base.upper = h.upper;
                base.tracking = px(h.tracking * size);
                if h.small_caps {
                    base.font.features = FontFeatures(Arc::new(vec![("smcp".into(), 1)]));
                }
                // Sections are counted from the second level down; the title
                // stands alone. The number is muted and regular, then an en space.
                let prefix = (look.md.choice("headingNumbers") == "outline")
                    .then(|| match level {
                        2 => {
                            self.heading_count = (self.heading_count.0 + 1, 0);
                            Some(format!("{}\u{2002}", self.heading_count.0))
                        }
                        3 => {
                            self.heading_count.1 += 1;
                            Some(format!("{}.{}\u{2002}", self.heading_count.0, self.heading_count.1))
                        }
                        _ => None,
                    })
                    .flatten()
                    .map(|text| {
                        let mut st = base.clone();
                        st.color = look.muted;
                        st.font.weight = FontWeight(400.);
                        st.tracking = px(0.);
                        (text, st)
                    });
                let fallback = if h.center { Align::Center } else { Align::Left };
                let aligned = align_or(align, fallback);
                let el = self.rich_leaf(key, look, base, look.line_height, aligned, LeafExtras { indent: 0., prefix }, window, cx);
                match h.rule {
                    // h1 and h2 carry a hairline under them, a little below the text.
                    HeadingRule::Line => div().pb(px(h.pad_bottom * size)).border_b_1().border_color(look.rule).child(el).into_any_element(),
                    // `::after`: a block 2.2em wide and 3px tall, 0.35em under
                    // the text, in the link colour; centred with the heading.
                    HeadingRule::Short => v_flex()
                        .child(el)
                        .child(
                            div()
                                .mt(px(0.35 * size))
                                .w(px(2.2 * size))
                                .h(px(3.))
                                .rounded(px(2.))
                                .bg(look.link)
                                .when(h.center, |d| d.mx_auto()),
                        )
                        .into_any_element(),
                    HeadingRule::None => el,
                }
            }
            Node::CodeBlock { language, .. } => {
                *counter += 1;
                // `pre code` is 0.87em at line-height 1.6, but each line box
                // also holds the `pre`'s own strut (the body size at the
                // template's line height), which is what sets the spacing.
                let code = look.size * 0.87;
                let lh = (look.size * look.line_height).max(code * 1.6) / code;
                let el = self.plain_leaf(key, look, code, lh, look.fg, true, window, cx);
                let pos = Pos::new(b, key.1, 0);
                // TipTap shows no language: the label appears only while the
                // caret is in the block, so it can still be changed.
                let here = self.thumbnail.is_none() && self.editor.head.block == b && self.editor.head.leaf == key.1;
                let lang_button = here.then(|| {
                    let label = language.clone().filter(|l| !l.is_empty()).unwrap_or_else(|| "plain text".into());
                    div()
                        .id(SharedString::from(format!("lang-{b}-{}", key.1)))
                        .absolute()
                        .top(px(6.))
                        .right(px(10.))
                        .text_size(px(11.))
                        .text_color(look.muted)
                        .cursor_pointer()
                        .child(label)
                        .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            this.open_prompt(super::PromptKind::CodeLanguage(pos), window, cx);
                        }))
                });
                // `pre`: padding 1em 1.2em, a hairline, 8px corners, on the
                // surface colour; a style changes the frame, never the code.
                let frame = div().relative().px(px(look.size * 1.2)).py(px(look.size));
                let frame = match look.md.choice("codeBlockStyle") {
                    "flat" => frame.rounded(px(6.)).bg(look.surface),
                    "bordered" => frame.rounded(px(8.)).border_1().border_color(look.rule),
                    "bar" => frame.border_l(px(3.)).border_color(look.muted).bg(look.surface),
                    _ => frame.rounded(px(8.)).border_1().border_color(look.rule).bg(look.surface),
                };
                frame.child(el).children(lang_button).into_any_element()
            }
            Node::MathBlock { source } => {
                *counter += 1;
                let pos = Pos::new(b, key.1, 0);
                let editing = (self.editor.head.block, self.editor.head.leaf) == key || {
                    let (f, t) = self.editor.range();
                    self.editor.has_selection() && (f.block, f.leaf) <= key && key <= (t.block, t.leaf)
                };
                // KaTeX draws at 1.21em of its own metrics; typst's glyphs
                // run larger, so 1.05em matches it on screen.
                let img = self.media.math(source, true, look.fg, look.size * 1.05, look.scale);
                let rendered = match img {
                    Some(m) => div()
                        .flex()
                        .justify_center()
                        .child(img_el(m.image.clone()).w(px(m.width)).h(px(m.height)))
                        .into_any_element(),
                    None => div()
                        .text_color(look.muted)
                        .font_family(look.mono.clone())
                        .text_size(px(look.size * 0.9))
                        .child(source.clone())
                        .into_any_element(),
                };
                if editing {
                    let el = self.plain_leaf(key, look, look.size * 0.9, 1.5, look.fg, false, window, cx);
                    v_flex()
                        .gap(px(8.))
                        .child(div().px(px(8.)).py(px(6.)).rounded(px(6.)).border_1().border_color(look.rule).bg(look.surface).child(el))
                        .child(rendered)
                        .into_any_element()
                } else {
                    // Not editing: the formula, a click away from its source.
                    let store = self.store.clone();
                    let hover = look.fg.opacity(0.05);
                    div()
                        .id(SharedString::from(format!("math-{b}-{}", key.1)))
                        .relative()
                        .rounded(px(6.))
                        .cursor_pointer()
                        .when(!self.read_only, |d| d.hover(move |s| s.bg(hover)))
                        .child(rendered)
                        .child(track(store, key))
                        .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            this.focus(window, cx);
                            let len = this.editor.leaf_len(pos.block, pos.leaf);
                            this.editor.set_caret(Pos { offset: len, ..pos }, false);
                            cx.notify();
                        }))
                        .into_any_element()
                }
            }
            Node::HorizontalRule => {
                *counter += 1;
                let selected = self.is_atom_selected(key);
                let ink = if selected { look.link } else { look.rule };
                let quiet = if selected { look.link } else { look.muted };
                match look.md.choice("dividerStyle") {
                    // 22% of the column, never under 4em, centred.
                    "short" => div()
                        .relative()
                        .w_full()
                        .flex()
                        .justify_center()
                        .child(div().h(px(1.)).w(relative(0.22)).min_w(px(4. * look.size)).bg(ink))
                        .child(track(self.store.clone(), key))
                        .into_any_element(),
                    // `border-top: 2px dotted`, the muted colour at 60%.
                    "dotted" => div()
                        .relative()
                        .w_full()
                        .h(px(2.))
                        .child(
                            canvas(|_, _, _| {}, {
                                let color = quiet.opacity(if selected { 1. } else { 0.6 });
                                move |bounds, _, window, _| {
                                    let mut x = px(0.);
                                    while x + px(2.) <= bounds.size.width {
                                        let dot = Bounds::new(point(bounds.origin.x + x, bounds.origin.y), size(px(2.), px(2.)));
                                        window.paint_quad(fill(dot, color).corner_radii(px(1.)));
                                        x += px(4.);
                                    }
                                }
                            })
                            .size_full(),
                        )
                        .child(track(self.store.clone(), key))
                        .into_any_element(),
                    // Three bullets an em apart, in a line of their own height.
                    "ornament" => div()
                        .relative()
                        .w_full()
                        .flex()
                        .justify_center()
                        .text_size(px(0.9 * look.size))
                        .line_height(px(0.9 * look.size))
                        .font_family(look.font.family.clone())
                        .text_color(quiet)
                        .child("\u{2022}\u{2003}\u{2022}\u{2003}\u{2022}")
                        .child(track(self.store.clone(), key))
                        .into_any_element(),
                    // Space only: the rule's own margins.
                    "space" => div().relative().w_full().h(px(if selected { 1. } else { 0. })).bg(ink.opacity(if selected { 1. } else { 0. })).child(track(self.store.clone(), key)).into_any_element(),
                    _ => div().relative().h(px(1.)).w_full().bg(ink).child(track(self.store.clone(), key)).into_any_element(),
                }
            }
            Node::Image { src, alt, width, .. } => {
                *counter += 1;
                self.render_image(key, src, alt.as_deref(), *width, look, cx)
            }
            Node::Embed { url } => {
                *counter += 1;
                self.render_embed(key, url, look, cx)
            }
            Node::Blockquote(children) => {
                let style = look.md.choice("quoteStyle");
                // A pull quote is set larger, in italics, on a 1.5 line; an
                // italic quote keeps the size. Both read in the ink, not muted.
                let own_look;
                let look = match style {
                    "pull" | "italic" => {
                        let mut l = look.clone();
                        l.font.style = FontStyle::Italic;
                        if style == "pull" {
                            l.size *= 1.2;
                            l.line_height = 1.5;
                        }
                        own_look = l;
                        &own_look
                    }
                    _ => look,
                };
                let color = if matches!(style, "pull" | "italic") { None } else { Some(look.muted) };
                let inner = Ctx { color, quote: true, center: style == "pull", ..ctx };
                let mut kids = Vec::new();
                let mut after_paragraph = false;
                for (i, c) in children.iter().enumerate() {
                    let mut p = path.clone();
                    p.push(i);
                    let child_ctx = Ctx { after_paragraph, ..inner };
                    let el = self.render_node(b, c, p, counter, depth, child_ctx, look, window, cx);
                    let (t, bm) = Self::margins(c, look, child_ctx);
                    kids.push((el, t, bm));
                    after_paragraph = matches!(c, Node::Paragraph { .. });
                }
                // The quote has padding, so its children's margins stay inside.
                let (el, t, bm) = stack(kids, look.snap);
                let s = look.size;
                // `quoteAccent`: the bar's colour.
                let bar_color: Hsla = match look.md.choice("quoteAccent") {
                    "quiet" => look.muted,
                    "link" => look.link,
                    "text" => look.fg,
                    _ => rgb(QUOTE_RULE).into(),
                };
                let bar = || div().absolute().top_0().bottom_0().left_0().w(px(3.)).bg(bar_color);
                let frame = div().relative();
                match style {
                    // No panel: the bar alone, `padding: 0.1em 1em`.
                    "bar" => frame.pl(px(s + 3.)).pr(px(s)).pt(px(s * 0.1 + t)).pb(px(s * 0.1 + bm)).child(bar()).child(el),
                    "italic" => frame.pl(px(s * 1.1 + 3.)).pr(px(s * 1.1)).pt(px(s * 0.1 + t)).pb(px(s * 0.1 + bm)).child(bar()).child(el),
                    // A hairline all round (it replaces the bar), 8px corners.
                    "card" => frame.px(px(s * 1.1)).pt(px(s * 0.7 + t)).pb(px(s * 0.7 + bm)).border_1().border_color(look.rule).rounded(px(8.)).bg(look.surface).child(el),
                    // No bar and no panel: `padding: 0.4em 2em` of its own em.
                    "pull" => frame.px(px(s * 2.)).pt(px(s * 0.4 + t)).pb(px(s * 0.4 + bm)).child(el),
                    _ => frame
                        .pl(px(s + 3.))
                        .pr(px(s))
                        .pt(px(s * 0.5 + t))
                        .pb(px(s * 0.5 + bm))
                        .bg(look.surface)
                        .rounded_tr(px(6.))
                        .rounded_br(px(6.))
                        .child(bar())
                        .child(el),
                }
                .into_any_element()
            }
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let start = match n {
                    Node::OrderedList { start, .. } => Some(*start),
                    _ => None,
                };
                // `padding-left` (listIndent) and `li { margin }` (listItemGap).
                let li = look.md.number("listItemGap") as f32 * look.size;
                let gutter = look.md.number("listIndent") as f32 * look.size;
                let marker_color = look.marker_color();
                let bullet = md::bullet(&look.md, ctx.ul_depth);
                let mut rows = Vec::new();
                for (k, item) in items.iter().enumerate() {
                    let mut ip = path.clone();
                    ip.push(k);
                    let mut item_ctx = Ctx { nested: true, quote: false, task: false, after_paragraph: false, ..ctx };
                    match start {
                        Some(_) => {
                            if (ctx.ol_depth as usize) < item_ctx.ol_path.len() {
                                item_ctx.ol_path[ctx.ol_depth as usize] = k as u32 + 1;
                            }
                            item_ctx.ol_depth = ctx.ol_depth.saturating_add(1);
                        }
                        None => item_ctx.ul_depth = ctx.ul_depth.saturating_add(1),
                    }
                    let (body, t, bm) = self.render_item(b, item, ip, counter, depth, item_ctx, look, window, cx);
                    // `::marker`: outside, at the item's own size.
                    let lh = look.size * ctx.line_height.unwrap_or(look.line_height);
                    let text_marker = |text: String, pad: f32| {
                        div()
                            .w(px(gutter))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .whitespace_nowrap()
                            .pr(px(pad))
                            .text_size(px(look.size))
                            .line_height(px(lh))
                            .font_family(look.font.family.clone())
                            .text_color(marker_color)
                            .child(text)
                    };
                    let marker = match (start, bullet) {
                        (Some(s), _) => {
                            let path = &ctx.ol_path[..(ctx.ol_depth as usize).min(ctx.ol_path.len())];
                            // The marker's own trailing space is the 0.3em here.
                            text_marker(md::ordered_marker(&look.md, s + k as u64, k as u64 + 1, ctx.ol_depth, path), look.size * 0.3)
                        }
                        (None, Bullet::Text(text)) => text_marker(text.to_string(), 0.),
                        (None, shape) => {
                            let ts = window.text_system();
                            let id = ts.resolve_font(&look.font);
                            let (asc, desc) = (f32::from(ts.ascent(id, px(look.size))), f32::from(ts.descent(id, px(look.size))));
                            let disc = disc_marker(look.size, lh, asc, desc, window.scale_factor(), gutter);
                            // Chromium gives disc, circle and square one box:
                            // filled round, a 1px ring, or filled square.
                            let dot = div().absolute().left(px(disc.left)).top(px(disc.top)).size(px(disc.size));
                            let dot = match shape {
                                Bullet::Circle => dot.rounded_full().border_1().border_color(marker_color),
                                Bullet::Square => dot.bg(marker_color),
                                _ => dot.rounded_full().bg(marker_color),
                            };
                            div().w(px(gutter)).h(px(lh)).flex_none().relative().child(dot)
                        }
                    };
                    let row = h_flex()
                        .items_start()
                        .child(marker)
                        .child(div().flex_1().min_w_0().child(body))
                        .into_any_element();
                    rows.push((row, li.max(t), li.max(bm)));
                }
                stack(rows, look.snap).0
            }
            Node::TaskList { items } => {
                let li = 2.4 * look.zoom;
                let box_style = look.md.choice("taskStyle");
                let done_style = look.md.choice("taskDone");
                let mut rows = Vec::new();
                for (k, item) in items.iter().enumerate() {
                    let mut ip = path.clone();
                    ip.push(k);
                    let checked = item.checked;
                    let item_path = ip.clone();
                    // A finished item reads muted, or muted and struck through.
                    let done = checked && done_style != "plain";
                    let item_ctx = Ctx {
                        line_height: Some(1.6),
                        task: true,
                        nested: true,
                        after_paragraph: false,
                        ul_depth: ctx.ul_depth.saturating_add(1),
                        color: if done { Some(look.muted) } else { ctx.color },
                        strike: ctx.strike || (checked && done_style == "strike"),
                        ..ctx
                    };
                    // `taskStyle`: a rounded box, a circle, or a thin outline
                    // whose tick takes the link colour instead of a fill.
                    let thin = box_style == "minimal";
                    let edge = match (checked, thin) {
                        (true, _) => look.link,
                        (false, true) => look.muted,
                        (false, false) => look.accent,
                    };
                    // The box follows the zoom, as the text beside it does.
                    let z = look.zoom;
                    let bx = div()
                        .id(SharedString::from(format!("task-{b}-{}", ip.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("-"))))
                        .size(px(16. * z))
                        .flex_none()
                        .map(|d| if box_style == "round" { d.rounded_full() } else { d.rounded(px(4. * z)) })
                        .map(|d| d.border(px(if thin { 1.5 } else { 2. } * z.max(0.5))))
                        .border_color(edge)
                        .when(checked && !thin, |d| d.bg(look.link))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .when(checked, |d| {
                            d.child(
                                div()
                                    .text_size(px(11. * z))
                                    .line_height(px(11. * z))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(if thin { look.link } else { look.background })
                                    .child("✓"),
                            )
                        })
                        .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            let p = item_path.clone();
                            this.edit(cx, |e| e.toggle_task(b, &p));
                        }));
                    let (body, _, _) = self.render_item(b, &item.content, ip, counter, depth, item_ctx, look, window, cx);
                    let row = h_flex()
                        .items_start()
                        .gap(px(8. * z))
                        .pl(px(4. * z))
                        // The box is centred on a 1.6em label, the first line's height.
                        .child(div().h(px(look.size * 1.6)).flex_none().flex().items_center().child(bx))
                        .child(div().flex_1().min_w_0().child(body))
                        .into_any_element();
                    rows.push((row, li, li));
                }
                stack(rows, look.snap).0
            }
            Node::Table { rows } => self.render_table(b, rows, path, counter, depth, ctx, look, window, cx),
        }
    }

    /// `.markdown-body table`: Chromium's automatic table layout
    /// (table_layout.rs) over each cell's min-content and max-content
    /// widths, in the room the table's own box has. Header cells are bold
    /// and centred unless aligned (TipTap draws them as `th` in the body, so
    /// the browser's own `th` style holds), every cell is centred top to
    /// bottom, and a hairline runs under each body row. A table its words
    /// cannot fit scrolls sideways inside its box (`display: block;
    /// overflow-x: auto`). A Markdown style changes the borders, the header
    /// row, the padding and the width.
    #[allow(clippy::too_many_arguments)]
    fn render_table(
        &mut self,
        b: usize,
        rows: &[Vec<markie_rich::model::Cell>],
        path: Vec<usize>,
        counter: &mut usize,
        depth: usize,
        ctx: Ctx,
        look: &Look,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let size = look.size * 0.9;
        let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let borders = look.md.choice("tableStyle");
        let header_style = look.md.choice("tableHeader");
        let table_width = look.md.choice("tableWidth");
        // A header cell keeps the browser's own 1px unless a density sets it.
        let padding = |header: bool| match md::cell_padding(&look.md, header) {
            Some((x, y)) => (x * size, y * size),
            None => (1., 1.),
        };
        // `tableHeader`: bold (the browser's own), 650, 600 on a fill, or 500 muted.
        let (header_weight, header_color, header_fill) = match header_style {
            "bold" => (FontWeight(650.), look.fg, None),
            "filled" => (FontWeight(600.), look.fg, Some(look.accent)),
            "plain" => (FontWeight(500.), look.muted, None),
            _ => (FontWeight::BOLD, look.fg, None),
        };
        let full = table_width == "full";
        let grid = borders == "grid";
        // Each column's min-content and max-content width, measured the way
        // the cells' text is laid out, with the cell's padding (and the
        // grid's 1px right edge) on top.
        let mut measured = vec![super::table_layout::Column::default(); ncols];
        let mut k = *counter;
        for row in rows {
            for (c, cell) in row.iter().enumerate() {
                let mut base = look.base(size);
                if cell.header {
                    base.font.weight = header_weight;
                }
                let (mut lo, mut hi) = (0f32, 0f32);
                for n in &cell.content {
                    let (min, max) = match n {
                        Node::Paragraph { .. } => {
                            let m = self.leaf_intrinsic((b, k), look, &base, window);
                            self.store.borrow_mut().table_words.insert((b, k), m.0);
                            k += 1;
                            m
                        }
                        other => {
                            k += markie_rich::editor::tree::leaves(std::slice::from_ref(other)).len();
                            text_intrinsic(&cell_text(std::slice::from_ref(other)), &base, window)
                        }
                    };
                    lo = lo.max(min);
                    hi = hi.max(max);
                }
                // Padding, the grid's edge and a point of slack for pixel snapping.
                let edge = super::table_layout::cell_edge(padding(cell.header).0, grid);
                // `.ProseMirror td, th { min-width: 3rem }`.
                let floor = 48. * look.zoom;
                measured[c].min = measured[c].min.max(lo + edge).max(floor);
                measured[c].max = measured[c].max.max(hi + edge).max(floor);
            }
        }
        // The room: the width this table's box had when last drawn, or the
        // page column's before that.
        let key = (b, path.clone());
        let known = self.store.borrow().tables.get(&key).copied();
        let room = known.unwrap_or(self.table_room).max(48.) - if grid { 1. } else { 0. };
        let cols = super::table_layout::columns(&measured, room, full);
        let para = Ctx { nested: true, quote: false, task: false, after_paragraph: false, center: false, ..ctx };
        let mut out_rows = Vec::new();
        for (r, row) in rows.iter().enumerate() {
            let header_row = row.iter().all(|c| c.header);
            let mut cells = Vec::new();
            for (c, cell) in row.iter().enumerate() {
                let mut cp = path.clone();
                cp.push(r);
                cp.push(c);
                let align = match cell.align {
                    Some(markie_rich::model::Align::Center) => Align::Center,
                    Some(markie_rich::model::Align::Right) => Align::Right,
                    Some(_) => Align::Left,
                    None if cell.header => Align::Center,
                    None => Align::Left,
                };
                let mut kids = Vec::new();
                for (j, n) in cell.content.iter().enumerate() {
                    let mut p = cp.clone();
                    p.push(j);
                    let k = (b, *counter);
                    match n {
                        Node::Paragraph { .. } => {
                            *counter += 1;
                            let mut base = look.base(size);
                            if cell.header {
                                base.font.weight = header_weight;
                                base.color = header_color;
                            }
                            let el = self.rich_leaf(k, look, base, look.line_height, align, LeafExtras::default(), window, cx);
                            let m = md::paragraph_margins(&look.md, look.gap, false, false, false).0 * size;
                            kids.push((el, m, m));
                        }
                        other => {
                            let el = self.render_node(b, other, p, counter, depth, para, look, window, cx);
                            let (t, bm) = Self::margins(other, look, para);
                            kids.push((el, t, bm));
                        }
                    }
                }
                let (el, t, bm) = stack(kids, look.snap);
                let (px_, py_) = padding(cell.header);
                let width = cols.widths.get(c).copied().unwrap_or(0.);
                let cell_el = div()
                    .w(px(width))
                    .flex_none()
                    .flex()
                    .flex_col()
                    // `vertical-align: middle`, the browser's own for cells.
                    .justify_center()
                    .px(px(px_))
                    .pt(px(py_ + t))
                    .pb(px(py_ + bm))
                    .when(cell.header, |d| d.when_some(header_fill, |d, fill| d.bg(fill)))
                    // `border: 1px solid`, collapsed: each cell draws its
                    // right and bottom edge, the table its left and top.
                    .when(grid, |d| d.border_r_1().border_b_1().border_color(look.rule))
                    // Minimal: one quiet line under the header, nothing else.
                    .when(borders == "minimal" && cell.header, |d| d.border_b_1().border_color(look.muted))
                    .child(el);
                cells.push(cell_el.into_any_element());
            }
            let surface = look.surface;
            // Body rows carry a hairline; zebra keeps its room but not its
            // ink, and shades every second row (the header row counts).
            let line = match borders {
                "lines" => Some(look.rule),
                "zebra" => Some(gpui_kit::transparent_black()),
                _ => None,
            };
            out_rows.push(
                h_flex()
                    .id(SharedString::from(format!("row-{b}-{path:?}-{r}")))
                    .w_full()
                    .items_stretch()
                    .when(borders == "zebra" && r % 2 == 1, |d| d.bg(surface))
                    .when(!header_row, |d| d.when_some(line, |d, c| d.border_b_1().border_color(c)))
                    .when(!header_row && borders != "minimal", |d| d.hover(move |s| s.bg(surface)))
                    .children(cells)
                    .into_any_element(),
            );
        }
        // One width for the cells, the rows (their fills and lines) and the
        // grid's edge: the columns' sum.
        let body = v_flex()
            .flex_none()
            .w(px(cols.width + if grid { 1. } else { 0. }))
            .when(grid, |d| d.border_l_1().border_t_1().border_color(look.rule))
            .children(out_rows);
        let store = self.store.clone();
        let used = known;
        let (body_width, overflows) = (cols.width + if grid { 1. } else { 0. }, cols.overflows);
        let centred = table_width == "centered" && !overflows;
        div()
            .id(SharedString::from(format!("table-{b}-{path:?}")))
            .relative()
            .w_full()
            .flex()
            // `width: fit-content; margin: auto` centres it; otherwise it starts at the left.
            .when(centred, |d| d.justify_center())
            .when(cols.overflows, |d| d.overflow_x_scroll())
            .child(body)
            .child(
                canvas(
                    move |bounds, window, _| {
                        let w = f32::from(bounds.size.width);
                        let mut s = store.borrow_mut();
                        // The rows' left edge, for the scene report.
                        let left = bounds.origin.x + if centred { (bounds.size.width - px(body_width)) / 2. } else { px(0.) };
                        s.table_boxes.insert(key.clone(), (bounds, left, body_width, overflows));
                        s.tables.insert(key, w);
                        // Laid out for another room: lay it out again.
                        if used.is_none_or(|u| (u - w).abs() > 0.5) {
                            window.request_animation_frame();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }

    /// A list item's blocks, stacked; returns its outer margins too.
    #[allow(clippy::too_many_arguments)]
    fn render_item(
        &mut self,
        b: usize,
        item: &[Node],
        path: Vec<usize>,
        counter: &mut usize,
        depth: usize,
        ctx: Ctx,
        look: &Look,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (AnyElement, f32, f32) {
        if item.is_empty() {
            // The virtual leaf of an empty item.
            let key = (b, *counter);
            *counter += 1;
            let lh = ctx.line_height.unwrap_or(look.line_height);
            return (self.rich_leaf(key, look, look.base(look.size), lh, Align::Left, LeafExtras::default(), window, cx), 0., 0.);
        }
        let mut kids = Vec::new();
        let mut after_paragraph = false;
        for (j, n) in item.iter().enumerate() {
            let mut p = path.clone();
            p.push(j);
            let child = Ctx { after_paragraph, ..ctx };
            let el = self.render_node(b, n, p, counter, depth + 1, child, look, window, cx);
            let (t, bm) = Self::margins(n, look, child);
            kids.push((el, t, bm));
            after_paragraph = matches!(n, Node::Paragraph { .. });
        }
        stack(kids, look.snap)
    }

    fn is_atom_selected(&self, key: LeafKey) -> bool {
        self.editor.selected_atom().is_some_and(|p| (p.block, p.leaf) == key)
            || {
                let (f, t) = self.editor.range();
                self.editor.has_selection() && (f.block, f.leaf) < key && key < (t.block, t.leaf)
            }
    }

    fn render_image(&mut self, key: LeafKey, src: &str, alt: Option<&str>, width: Option<u32>, look: &Look, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.is_atom_selected(key);
        let pos = Pos::new(key.0, key.1, 0);
        // `imageRadius`, `imageFrame` and `imageAlign`.
        let radius = look.md.number("imageRadius") as f32;
        let frame = look.md.choice("imageFrame");
        let centered = look.md.choice("imageAlign") == "center";
        let live = self.live_width.filter(|(p, _)| *p == pos).map(|(_, w)| w);
        let w = live.or(width.map(|w| w as f32));
        let kind = markie_rich::html::media_kind(src);
        let source = match media::resolve(src, self.base_dir.as_deref()) {
            Source::Local(path) => {
                let allowed = !self.restrict_local_media || self.base_dir.as_ref()
                    .and_then(|dir| Some(path.canonicalize().ok()?.starts_with(dir.canonicalize().ok()?)))
                    .unwrap_or(false);
                if allowed && path.is_file() {
                    Source::Local(path)
                } else {
                    self.cloud_media.get(&media::reference_key(src))
                        .cloned().map(Source::Local).unwrap_or(Source::None)
                }
            }
            source => source,
        };
        let image: AnyElement = if kind == markie_rich::html::MediaKind::Video && self.inline_mp4(src).is_some() {
            let src = src.to_string();
            let width = w.unwrap_or(640.) * look.zoom;
            div()
                .id(SharedString::from(format!("play-mp4-{}-{}", key.0, key.1)))
                .w(px(width)).max_w_full().h(px(width * 9. / 16.))
                .flex().items_center().justify_center()
                .rounded(px(6.)).bg(rgb(0x101010)).text_color(rgb(0xffffff))
                .cursor_pointer().child("▶  Play video")
                .on_click(cx.listener(move |this, _, window, cx| this.open_inline_mp4(key, &src, window, cx)))
                .into_any_element()
        } else if kind != markie_rich::html::MediaKind::Image {
            div()
                .p(px(12.))
                .rounded(px(6.))
                .bg(look.surface)
                .text_color(look.muted)
                .text_size(px(look.size * 0.9))
                .child(format!("{} · {src}", if kind == markie_rich::html::MediaKind::Video { "Video" } else { "Audio" }))
                .into_any_element()
        } else {
            let el = match source {
                Source::Local(p) => Some(img(p)),
                Source::Inline(i) => Some(img(i)),
                // A card's miniature never goes to the network for a picture.
                Source::Remote(_) if self.thumbnail.is_some() => None,
                Source::Remote(url) => match self.media.remote.get(&url) {
                    Some(media::Remote::Ready(i)) => Some(img(i.clone())),
                    Some(media::Remote::Failed) => None,
                    Some(media::Remote::Loading) => None,
                    None => {
                        self.media.remote.insert(url.clone(), media::Remote::Loading);
                        let u = url.clone();
                        cx.spawn(async move |this, cx| {
                            let fetched = cx.background_executor().spawn(async move { media::fetch(&u) }).await;
                            this.update(cx, |this, cx| {
                                this.media.remote.insert(url, match fetched {
                                    Some(i) => media::Remote::Ready(Arc::new(i)),
                                    None => media::Remote::Failed,
                                });
                                cx.notify();
                            })
                            .ok();
                        })
                        .detach();
                        None
                    }
                },
                Source::None => None,
            };
            let alt_text = alt.unwrap_or("").to_string();
            let fallback = {
                let muted = look.muted;
                let bg = look.surface;
                let label = if alt_text.is_empty() { src.to_string() } else { alt_text.clone() };
                move || {
                    div().p(px(12.)).rounded(px(6.)).bg(bg).text_color(muted).child(format!("Picture: {label}")).into_any_element()
                }
            };
            match el {
                Some(i) => {
                    let i = i.object_fit(ObjectFit::Contain).with_fallback(fallback.clone()).max_w_full().rounded(px(radius));
                    match w {
                        Some(w) => i.w(px(w * look.zoom)).into_any_element(),
                        None => i.into_any_element(),
                    }
                }
                None => fallback(),
            }
        };
        // ResizableNodeView's four corners (`.markie-media-handle`): 12 px
        // squares in the link blue with a 2 px page-coloured edge and a
        // small shadow, centred on the frame's corners. They show for the
        // selected picture and the one under the pointer, never in a
        // read-only document. Dragging any corner changes the width only;
        // the picture keeps its proportions.
        let group = SharedString::from(format!("media-{}-{}", key.0, key.1));
        let editable = !self.read_only && kind == markie_rich::html::MediaKind::Image;
        let handles: Vec<AnyElement> = if editable {
            [(false, false), (false, true), (true, false), (true, true)]
                .into_iter()
                .map(|(bottom, right)| {
                    let corner = div()
                        .id(SharedString::from(format!("resize-{}-{}-{}{}", key.0, key.1, bottom as u8, right as u8)))
                        .absolute()
                        .size(px(12.))
                        .rounded(px(3.))
                        .bg(look.link)
                        .border_2()
                        .border_color(look.background)
                        .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.35), offset: point(px(0.), px(1.)), blur_radius: px(3.), spread_radius: px(0.), inset: false }])
                        .cursor(if bottom == right { CursorStyle::ResizeUpLeftDownRight } else { CursorStyle::ResizeUpRightDownLeft })
                        .when(!selected, |d| d.opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)))
                        .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            // From the width the file holds, else the drawn width.
                            let start = width.map(|w| w as f32).unwrap_or_else(|| {
                                this.store.borrow().atoms.get(&key).map(|b| f32::from(b.size.width) / this.zoom - 4.).unwrap_or(300.)
                            });
                            this.resize = Some((pos, f32::from(ev.position.x), start, if right { 1. } else { -1. }));
                            this.live_width = Some((pos, start));
                        }));
                    let corner = if bottom { corner.bottom(px(-6.)) } else { corner.top(px(-6.)) };
                    (if right { corner.right(px(-6.)) } else { corner.left(px(-6.)) }).into_any_element()
                })
                .collect()
        } else {
            Vec::new()
        };
        // The selected picture has a 2px blue outline, 2px off its edge.
        div()
            .flex()
            .when(centered, |d| d.justify_center())
            .child(
                div()
                    .group(group)
                    .relative()
                    .flex_none()
                    .max_w_full()
                    .when(w.is_some(), |d| d.w(px(w.unwrap() * look.zoom)))
                    .rounded(px(radius))
                    .when(frame == "border", |d| d.border_1().border_color(look.rule))
                    .when(frame == "shadow", |d| {
                        d.shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.18), offset: point(px(0.), px(6.)), blur_radius: px(24.), spread_radius: px(0.), inset: false }])
                    })
                    .child(image)
                    .when(selected, |d| {
                        d.child(div().absolute().top(px(-4.)).left(px(-4.)).right(px(-4.)).bottom(px(-4.)).rounded(px(radius + 2.)).border_2().border_color(look.link))
                    })
                    .child(track(self.store.clone(), key))
                    .children(handles),
            )
            .into_any_element()
    }

    fn render_embed(&mut self, key: LeafKey, url: &str, look: &Look, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.is_atom_selected(key);
        let yt = media::youtube_id(url);
        let site = if yt.is_some() { "YouTube" } else { "Vimeo" };
        // Nothing is fetched until the card is hovered (link_card.rs and
        // rich-embed.ts): then its title and picture come from the guarded
        // preview fetch, for YouTube and Vimeo alike.
        let _ = &yt;
        let fetched = self.link_hover.embeds.get(url).cloned();
        let title = fetched.as_ref().and_then(|(t, _)| t.clone()).unwrap_or_else(|| url.to_string());
        let thumb_el: Option<AnyElement> = fetched
            .and_then(|(_, i)| i)
            .map(|i| img(i).absolute().top_0().left_0().size_full().object_fit(ObjectFit::Cover).into_any_element());
        let hover_url = url.to_string();
        // `.markie-embed-card`: the thumbnail at 16:9 with a play button
        // and a strip carrying the address and the site. A click plays it
        // (video.rs).
        let open_url = url.to_string();
        let width = self.store.borrow().atoms.get(&key).map(|b| b.size.width);
        let height = width.map(|w| w * (9. / 16.)).unwrap_or(px(360.));
        let blue = look.link;
        div()
            .id(SharedString::from(format!("embed-{}-{}", key.0, key.1)))
            .group("embed")
            .relative()
            .w_full()
            .h(height)
            .rounded(px(8.))
            .border_1()
            .border_color(look.border)
            .bg(look.surface2)
            .overflow_hidden()
            .cursor_pointer()
            .children(thumb_el)
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w(px(68.))
                            .h(px(48.))
                            .rounded(px(14.))
                            .bg(gpui_kit::black().opacity(0.7))
                            .group_hover("embed", move |s| s.bg(blue))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(div().pl(px(4.)).text_size(px(22.)).line_height(px(22.)).text_color(gpui_kit::white()).child("▶")),
                    ),
            )
            .child(
                h_flex()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .px(px(12.))
                    .py(px(10.))
                    .gap(px(10.))
                    .items_end()
                    .bg(linear_gradient(
                        180.,
                        linear_color_stop(gpui_kit::black().opacity(0.0), 0.),
                        linear_color_stop(gpui_kit::black().opacity(0.72), 1.),
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(gpui_kit::white())
                            .child(title),
                    )
                    .child(div().flex_none().text_size(px(10.)).text_color(gpui_kit::white().opacity(0.85)).child(site.to_uppercase())),
            )
            .when(selected, |d| d.border_2().border_color(look.link))
            .child(track(self.store.clone(), key))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| this.embed_hover(hover_url.clone(), *over, cx)))
            // The press selects the card, as on any block; the click plays
            // it in the video viewer (`requestVideoViewer`).
            .on_click(cx.listener(move |this, _, window, cx| this.open_video(&open_url, window, cx)))
            .into_any_element()
    }

    /// Selection, caret, find matches and IME marks for one leaf.
    fn deco(&self, key: LeafKey, len: usize, look: &Look, cx: &App) -> Deco {
        let (from, to) = self.editor.range();
        let mut d = Deco {
            selection_color: look.selection,
            caret_color: look.caret,
            find_color: look.find,
            find_current_color: look.find_current,
            ..Deco::default()
        };
        if self.editor.has_selection() && (from.block, from.leaf) <= key && key <= (to.block, to.leaf) {
            let a = if (from.block, from.leaf) == key { from.offset } else { 0 };
            let b = if (to.block, to.leaf) == key { to.offset } else { len + 1 };
            d.selection = Some(a..b);
        }
        let h = self.editor.head;
        if look.focused && !self.editor.has_selection() && (h.block, h.leaf) == key && self.prompt.is_none() {
            d.caret = Some((h.offset, false));
        }
        // While dragging the selection, the caret shows where it would land.
        if let Some((_, Some(at))) = self.text_drag {
            if (at.block, at.leaf) == key {
                d.caret = Some((at.offset, false));
            }
        }
        if let Some(f) = &self.find {
            let _ = cx;
            for (i, m) in f.matches.iter().enumerate() {
                if (m.start.block, m.start.leaf) == key {
                    d.finds.push((m.start.offset..m.end.offset, i == f.current));
                }
            }
        }
        if let Some((m, n)) = self.marked {
            if (m.block, m.leaf) == key {
                d.marked = Some(m.offset..m.offset + n);
            }
        }
        // Live peers and commented passages (markie-editor collab binding).
        let span = |a: Pos, b: Pos| -> Option<std::ops::Range<usize>> {
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            if a == b || !((a.block, a.leaf) <= key && key <= (b.block, b.leaf)) {
                return None;
            }
            let x = if (a.block, a.leaf) == key { a.offset } else { 0 };
            let y = if (b.block, b.leaf) == key { b.offset } else { len + 1 };
            Some(x..y)
        };
        for (a, b, color) in &self.comment_marks {
            if let Some(r) = span(*a, *b) {
                d.marks.push((r, *color));
            }
        }
        for rc in &self.remote {
            if let Some(r) = span(rc.anchor, rc.head) {
                let mut c = rc.color;
                c.a = 0x70 as f32 / 255.;
                d.remote_selections.push((r, c));
            }
            if (rc.head.block, rc.head.leaf) == key {
                let ms = rc.moved_at.elapsed().as_millis();
                let label = if ms < crate::CARET_LABEL_MS * 62 / 100 {
                    1.
                } else if ms < crate::CARET_LABEL_MS {
                    1. - (ms - crate::CARET_LABEL_MS * 62 / 100) as f32 / (crate::CARET_LABEL_MS * 38 / 100) as f32
                } else {
                    0.
                };
                d.remote_carets.push((rc.head.offset, rc.color, rc.name.clone(), label));
            }
        }
        d
    }

    /// A paragraph, heading or cell: styled runs, inline formulas, breaks.
    #[allow(clippy::too_many_arguments)]
    fn rich_leaf(&mut self, key: LeafKey, look: &Look, base: SegStyle, line_height: f32, align: Align, extras: LeafExtras, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let units = self.editor.units(key.0, key.1);
        let mut segs = self.leaf_segs(&units, look, &base);
        let len = units.len();
        let mut deco = self.deco(key, len, look, cx);
        if !self.read_only {
            deco.misspelled = self.misspelled(key, &units, cx);
        }
        // `a:hover { border-bottom-color: var(--blue) }`, where the style
        // does not already mark its links.
        if let Some((hover_key, units)) = &look.hovered_link
            && *hover_key == key
            && look.md.choice("linkStyle") == "hover"
        {
            for seg in segs.iter_mut().filter(|s| s.units.start < units.end && units.start < s.units.end) {
                if let SegKind::Text(_, style) = &mut seg.kind {
                    style.under = Some((look.link, false));
                }
            }
        }
        let spec = LeafSpec { segs, base, line_height, align, len, indent: px(extras.indent), prefix: extras.prefix, snap: look.snap };
        let el = LeafElement::new(key, spec, deco, self.store.clone());
        // Inline formulas open their source on a click.
        let math_at: Vec<usize> = units.iter().enumerate().filter(|(_, u)| matches!(u, Unit::Atom(Inline::Math { .. }))).map(|(i, _)| i).collect();
        if math_at.is_empty() {
            return div().w_full().child(el).into_any_element();
        }
        let pos = Pos::new(key.0, key.1, 0);
        div()
            .w_full()
            .child(el)
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                // A click on a formula edits it in place (math_field.rs).
                if let Some(p) = this.hit(ev.position) {
                    for i in [p.offset, p.offset.saturating_sub(1)] {
                        if math_at.contains(&i) && (p.block, p.leaf) == (pos.block, pos.leaf) && this.hit_is_atom(ev.position, pos, i) {
                            cx.stop_propagation();
                            this.open_math_field(pos, i, window, cx);
                            return;
                        }
                    }
                }
            }))
            .into_any_element()
    }

    /// A rich leaf's runs: its text in its marks, breaks and inline formulas.
    fn leaf_segs(&mut self, units: &[Unit], look: &Look, base: &SegStyle) -> Vec<Seg> {
        let size = f32::from(base.size);
        let mut segs: Vec<Seg> = Vec::new();
        let mut i = 0;
        while i < units.len() {
            match &units[i] {
                Unit::Char(_, m) => {
                    let start = i;
                    let mut text = String::new();
                    while i < units.len() {
                        match &units[i] {
                            Unit::Char(c, m2) if m2 == m => {
                                text.push(*c);
                                i += 1;
                            }
                            _ => break,
                        }
                    }
                    segs.push(Seg { kind: SegKind::Text(text, style_for(m, base, look)), units: start..i });
                }
                Unit::Atom(Inline::HardBreak) => {
                    segs.push(Seg { kind: SegKind::Break, units: i..i + 1 });
                    i += 1;
                }
                Unit::Atom(Inline::Math { source }) => {
                    // KaTeX draws inline formulas at 1.21em too.
                    let m = self.media.math(source, false, base.color, size * 1.21, look.scale);
                    let fallback_style = SegStyle { color: gpui_kit::red(), font: look.code_font(&base.font), ..base.clone() };
                    segs.push(Seg {
                        kind: match m {
                            Some(m) => SegKind::Box {
                                width: px(m.width),
                                height: px(m.height),
                                baseline: px(m.baseline),
                                image: Some(m.image),
                                fallback: None,
                            },
                            None => SegKind::Box { width: px(0.), height: px(0.), baseline: px(0.), image: None, fallback: Some((source.clone(), fallback_style)) },
                        },
                        units: i..i + 1,
                    });
                    i += 1;
                }
                Unit::Atom(Inline::Text { text, marks }) => {
                    segs.push(Seg { kind: SegKind::Text(text.clone(), style_for(marks, base, look)), units: i..i + 1 });
                    i += 1;
                }
            }
        }
        segs
    }

    /// The min-content and max-content widths of one leaf drawn in `base`
    /// (a table sizes its columns from them).
    pub(crate) fn leaf_intrinsic(&mut self, key: LeafKey, look: &Look, base: &SegStyle, window: &Window) -> (f32, f32) {
        let units = self.editor.units(key.0, key.1);
        let segs = self.leaf_segs(&units, look, base);
        let spec = LeafSpec { segs, base: base.clone(), line_height: look.line_height, align: Align::Left, len: units.len(), indent: px(0.), prefix: None, snap: look.snap };
        let (min, max) = super::layout::intrinsic(&spec, window);
        (f32::from(min), f32::from(max))
    }

    /// Code, display math source or a raw block: plain text in mono. Code
    /// blocks are drawn in one ink, as TipTap draws them. `spell` checks
    /// spelling: Chromium checks a code block in the contenteditable like any
    /// other text; the formula field turns it off (`rich-math.ts`).
    #[allow(clippy::too_many_arguments)]
    fn plain_leaf(&mut self, key: LeafKey, look: &Look, size: f32, line_height: f32, color: Hsla, spell: bool, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let units = self.editor.units(key.0, key.1);
        let text: String = units.iter().map(|u| u.display()).collect();
        let mut base = look.base(size);
        base.font = look.code_font(&base.font);
        base.color = color;
        let mut segs: Vec<Seg> = Vec::new();
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '\n' {
                segs.push(Seg { kind: SegKind::Break, units: i..i + 1 });
                i += 1;
                continue;
            }
            let start = i;
            let mut s = String::new();
            while i < chars.len() && chars[i] != '\n' {
                s.push(chars[i]);
                i += 1;
            }
            segs.push(Seg { kind: SegKind::Text(s, base.clone()), units: start..i });
        }
        let len = units.len();
        let mut deco = self.deco(key, len, look, cx);
        if spell && !self.read_only {
            deco.misspelled = self.misspelled(key, &units, cx);
        }
        let spec = LeafSpec { segs, base, line_height, align: Align::Left, len, indent: px(0.), prefix: None, snap: look.snap };
        div().w_full().child(LeafElement::new(key, spec, deco, self.store.clone())).into_any_element()
    }
}

/// An invisible child that records its parent's bounds as an atom's.
fn track(store: super::element::SharedStore, key: LeafKey) -> impl IntoElement {
    canvas(
        move |bounds, _, _| {
            store.borrow_mut().atoms.insert(key, bounds);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

fn img_el(i: Arc<Image>) -> Img {
    img(i)
}

/// TipTap's `textAlign` on the block, or what its style gives it.
fn align_or(a: &Option<String>, fallback: Align) -> Align {
    match a.as_deref() {
        Some("center") => Align::Center,
        Some("right") => Align::Right,
        Some("left") => Align::Left,
        Some("justify") => Align::Justify,
        _ => fallback,
    }
}

/// A run's look from its marks (`strong`, `em`, `del`, `code`, `a`,
/// `mark`, `u` and TipTap's `textStyle` in `.markdown-body`).
fn style_for(m: &Marks, base: &SegStyle, look: &Look) -> SegStyle {
    let mut s = base.clone();
    // `.markdown-body strong { color: var(--foreground) }`: bold text takes
    // the page's ink even where its block is muted (a quote, a finished task).
    if m.bold {
        s.font.weight = FontWeight(650.);
        s.color = look.fg;
    }
    if m.italic {
        s.font.style = FontStyle::Italic;
    }
    s.underline = m.underline;
    // TipTap writes `<s>`, which keeps the text's own ink; globals.css mutes
    // only `del`, which the rich editor never writes. A finished task's
    // line-through (`taskDone: strike`) runs through every run in it, as
    // CSS text-decoration does.
    s.strike = base.strike || m.strike;
    if let Some(t) = &m.text_style {
        if let Some(c) = t.color.as_deref().and_then(media::css_color) {
            s.color = c;
        }
        if let Some(f) = t.font_family.as_deref().and_then(media::font_family) {
            s.font.family = f;
        }
        if let Some(z) = t.font_size.as_deref().and_then(|z| media::css_size(z, 16.)) {
            s.size = px(z * look.zoom);
        }
    }
    let ink = s.color;
    if let Some(link) = &m.link {
        // `a[data-doc-link="none"]`: muted, for a document not shared with
        // this reader.
        let unshared = !look.unshared_links.is_empty() && look.unshared_links.contains(&media::reference_key(&link.href));
        s.color = if unshared { look.muted } else { look.link };
        // `linkStyle`: how a link is marked in running text. A link this
        // reader may not follow keeps its own look.
        if !unshared {
            match look.md.choice("linkStyle") {
                "underline" => s.under = Some((look.link.opacity(0.55), false)),
                "dotted" => s.under = Some((look.link, true)),
                "ink" => {
                    s.color = ink;
                    s.under = Some((look.link, false));
                }
                _ => {}
            }
        }
    }
    if let Some(h) = &m.highlight {
        let c = h.color.as_deref().and_then(media::css_color).unwrap_or_else(|| rgb(0xfef08a).into());
        s.background = Some(c);
        // A highlighter is drawn on paper: dark ink on it in either theme.
        // (Electron keeps the page's ink, which is white on yellow in dark.)
        s.color = rgb(0x1f2328).into();
    }
    if m.code {
        s.font = look.code_font(&s.font);
        s.size = s.size * 0.88;
        s.tracking = px(0.);
        s.upper = false;
        // `inlineCodeStyle`: a chip (fill, hairline, coloured ink), the fill
        // alone, the hairline alone, or the coloured ink alone.
        let (fill, edge, ink, pad) = match look.md.choice("inlineCodeStyle") {
            "flat" => (true, false, s.color, true),
            "bordered" => (false, true, s.color, true),
            "plain" => (false, false, look.code_fg, false),
            _ => (true, true, look.code_fg, true),
        };
        s.color = ink;
        s.background = fill.then_some(look.surface);
        s.border = edge.then_some(look.rule);
        s.pad_x = if pad { s.size * 0.4 } else { px(0.) };
    }
    s
}

/// A paragraph that is nothing but emphasised text.
fn is_caption(content: &[Inline]) -> bool {
    let mut any = false;
    for inline in content {
        match inline {
            Inline::Text { text, marks } if marks.italic => any |= !text.trim().is_empty(),
            Inline::Text { text, .. } if text.trim().is_empty() => {}
            _ => return false,
        }
    }
    any
}

/// A cell's text on one line, to size its column.
/// Min-content and max-content widths of plain text in `base`: its widest
/// word and the whole text on one line (cells holding blocks other than a
/// paragraph).
fn text_intrinsic(text: &str, base: &SegStyle, window: &Window) -> (f32, f32) {
    let shape = |t: &str| {
        let run = TextRun { len: t.len(), font: base.font.clone(), color: base.color, background_color: None, underline: None, strikethrough: None };
        f32::from(window.text_system().shape_line(SharedString::from(t.to_string()), base.size, &[run], None).width)
    };
    if text.trim().is_empty() {
        return (0., 0.);
    }
    let min = text.split_whitespace().map(shape).fold(0f32, f32::max);
    (min, shape(text.trim_end()).max(min))
}

fn cell_text(nodes: &[Node]) -> String {
    let mut out = String::new();
    for n in nodes {
        if let Node::Paragraph { content, .. } | Node::Heading { content, .. } = n {
            for i in content {
                match i {
                    Inline::Text { text, .. } => out.push_str(text),
                    Inline::Math { source } => out.push_str(source),
                    Inline::HardBreak => out.push(' '),
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Look, disc_marker, style_for};
    use gpui_kit::{Hsla, font, rgb};
    use markie_core::markdown_style::{MarkdownStyle, resolve};
    use markie_rich::model::{Link, LinkStyle, Marks};

    fn look(style: &str) -> Look {
        let c = |v: u32| -> Hsla { rgb(v).into() };
        Look {
            size: 16.,
            zoom: 1.,
            line_height: 1.6,
            gap: 1.,
            fg: c(0xeeeeee),
            muted: c(0x888888),
            link: c(0x3b82f6),
            accent: c(0x444444),
            surface: c(0x111111),
            surface2: c(0x161616),
            background: c(0x0a0a0a),
            border: c(0x222222),
            rule: c(0x333333),
            code_fg: c(0xeab308),
            selection: c(0x264f78),
            caret: c(0xffffff),
            find: c(0x665500),
            find_current: c(0xaa8800),
            font: font("Helvetica"),
            heading_family: None,
            mono: "Menlo".into(),
            code_features: None,
            md: resolve(&MarkdownStyle::preset(style)),
            hovered_link: None,
            snap: None,
            focused: false,
            scale: 2.,
            unshared_links: Default::default(),
        }
    }

    #[test]
    fn bold_takes_the_ink_inside_a_muted_block() {
        // `.markdown-body strong { color: var(--foreground) }` wins over a
        // quote's or a finished task's muted colour.
        let l = look("compact");
        let mut muted = l.base(16.);
        muted.color = l.muted;
        let bold = Marks { bold: true, ..Default::default() };
        assert_eq!(style_for(&bold, &muted, &l).color, l.fg);
        assert_eq!(style_for(&Marks::default(), &muted, &l).color, l.muted);
        let link = Link { href: "https://e.com".into(), title: None, style: LinkStyle::Inline };
        let bold_link = Marks { bold: true, link: Some(link), ..Default::default() };
        assert_eq!(style_for(&bold_link, &muted, &l).color, l.link, "a link keeps its own colour");
    }

    #[test]
    fn a_finished_tasks_line_through_runs_through_marked_text() {
        // Minimal's `taskDone: strike` sets the item's base; bold, italic and
        // links inside it are struck too, as CSS text-decoration is.
        let l = look("minimal");
        let mut done = l.base(16.);
        done.strike = true;
        for m in [
            Marks { bold: true, ..Default::default() },
            Marks { italic: true, ..Default::default() },
            Marks { code: true, ..Default::default() },
            Marks::default(),
        ] {
            assert!(style_for(&m, &done, &l).strike, "{m:?}");
        }
        assert!(!style_for(&Marks { bold: true, ..Default::default() }, &l.base(16.), &l).strike);
    }

    #[test]
    fn the_disc_is_chromiums_symbol_marker() {
        // SF Pro at 16 px in a 1.75 line on a 2x screen: ascent 30.4 device
        // pixels floors to 30, so a 10 px (5 pt) disc 15 px below the ascent
        // line, its top 7.5 pt over the baseline; Electron's measures 7.25.
        let d = disc_marker(16., 28., 15.2, -3.85, 2., 1.8 * 16.);
        assert_eq!(d.size, 5.);
        let baseline = (28. - (15.2 + 3.85)) / 2. + 15.2;
        assert!((baseline - d.top - 7.5).abs() < 0.01, "{d:?}");
        assert!((1.8 * 16. - (d.left + d.size / 2.) - 0.685 * 16.).abs() < 0.01);
        // On a 1x screen Chromium rounds in its own pixels: 15 floors to 15, 5 px.
        assert_eq!(disc_marker(16., 28., 15.2, -3.85, 1., 28.8).size, 5.);
        // Zoom grows it in whole device pixels.
        assert_eq!(disc_marker(32., 56., 30.4, -7.7, 2., 57.6).size, 10.);
        // A style's list indent moves the gutter; the disc keeps its place before the text.
        let narrow = disc_marker(16., 28., 15.2, -3.85, 2., 1.4 * 16.);
        assert!((1.4 * 16. - (narrow.left + narrow.size / 2.) - 0.685 * 16.).abs() < 0.01);
    }
}
