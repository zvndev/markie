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
use markie_rich::model::*;
use std::collections::HashSet;

/// Sizes and colours for one frame: the `.markdown-body` rules of
/// `globals.css`, with the template's typography (`style.rs`).
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
        }
    }
}

/// `h1` to `h6`: size and margins in em of the heading, and weight.
fn heading_metrics(level: u8) -> (f32, f32, f32, f32) {
    match level {
        1 => (2.0, 1.5, 0.6, 700.),
        2 => (1.5, 1.4, 0.5, 650.),
        3 => (1.25, 1.3, 0.4, 600.),
        4 => (1.1, 1.2, 0.4, 600.),
        _ => (1.0, 1.0, 0.3, 600.),
    }
}

/// What a container does to the blocks inside it.
#[derive(Clone, Copy)]
pub(crate) struct Ctx {
    /// A paragraph's margin in em, when not the template's gap (a quote's
    /// `0.3em`, a task's `0`).
    pub para_em: Option<f32>,
    /// A paragraph's line height, when not the template's (a task's 1.6).
    pub line_height: Option<f32>,
    /// Text colour, when not the ink (a quote is muted).
    pub color: Option<Hsla>,
}

impl Ctx {
    const DOC: Ctx = Ctx { para_em: None, line_height: None, color: None };
}

/// Stack blocks the way CSS collapses vertical margins: the space between
/// two neighbours is the larger of their margins. Returns the stack and the
/// first top and last bottom margins, which escape to the container.
fn stack(children: Vec<(AnyElement, f32, f32)>) -> (AnyElement, f32, f32) {
    let mut top = 0.;
    let mut prev: Option<f32> = None;
    let mut out = Vec::with_capacity(children.len());
    for (el, t, b) in children {
        match prev {
            None => top = t,
            Some(pb) => out.push(div().flex_none().h(px(pb.max(t))).into_any_element()),
        }
        out.push(el);
        prev = Some(b);
    }
    (v_flex().w_full().children(out).into_any_element(), top, prev.unwrap_or(0.))
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
fn disc_marker(size: f32, line_height: f32, ascent: f32, descent: f32, scale: f32) -> Disc {
    let (ascent, descent) = (ascent.abs(), descent.abs());
    let a = (ascent * scale).floor() as i32;
    let width = ((a * 2 / 3 + 1) / 2) as f32 / scale;
    let below_ascent = (3 * (a - a * 2 / 3) / 2) as f32 / scale;
    let baseline = (line_height - (ascent + descent)) / 2. + ascent;
    let gutter = 1.8 * size;
    Disc { left: gutter - 0.685 * size - width / 2., top: baseline - a as f32 / scale + below_ascent, size: width }
}

impl RichView {
    pub(crate) fn look(&self, theme: &Theme, window: &Window) -> Look {
        let mut font = window.text_style().font();
        font.family = match self.doc_font {
            "system" => super::style::typeface(&self.style.body_font).map(SharedString::from).unwrap_or_else(|| theme.font_family.clone()),
            "sans" => theme.font_family.clone(),
            "mono" => SharedString::from(MONO),
            id => super::style::typeface(id).map(SharedString::from).unwrap_or_else(|| theme.font_family.clone()),
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
            id => super::style::typeface(id).map(SharedString::from),
        };
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
            line_height: self.style.line_height,
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
            mono: SharedString::from(MONO),
            focused: self.focus.is_focused(window),
            scale: window.scale_factor(),
            unshared_links: self.unshared_links.clone(),
        }
    }

    /// A block's outer margins (top, bottom) in px, before collapsing.
    pub(crate) fn margins(n: &Node, look: &Look, ctx: Ctx) -> (f32, f32) {
        let s = look.size;
        match n {
            Node::Paragraph { .. } => {
                let m = ctx.para_em.unwrap_or(look.gap) * s;
                (m, m)
            }
            Node::Heading { level, .. } => {
                let (k, t, b, _) = heading_metrics(*level);
                (t * k * s, b * k * s)
            }
            Node::HorizontalRule => (2. * s, 2. * s),
            Node::Table { .. } => (0.9 * s, 0.9 * s),
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let own = 0.6 * s;
                let li = 0.3 * s;
                let first = items.first().and_then(|i| i.first()).map(|n| Self::margins(n, look, Ctx { para_em: None, ..ctx }).0).unwrap_or(0.);
                let last = items.last().and_then(|i| i.last()).map(|n| Self::margins(n, look, Ctx { para_em: None, ..ctx }).1).unwrap_or(0.);
                (own.max(li).max(first), own.max(li).max(last))
            }
            Node::TaskList { .. } => {
                let m = (0.6 * s).max(2.4 * look.zoom);
                (m, m)
            }
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
        let top = nodes.first().map(|n| Self::margins(n, look, Ctx::DOC).0).unwrap_or(0.);
        let bottom = nodes.last().map(|n| Self::margins(n, look, Ctx::DOC).1).unwrap_or(0.);
        (top, bottom)
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
            s.atoms.clear();
            s.frame += 1;
        }
        let viewport = self.scroll.bounds();
        if (viewport.size.width - self.heights_width).abs() > px(0.5) {
            self.heights_width = viewport.size.width;
            self.heights.iter_mut().for_each(|h| *h = None);
        }
        if self.find.is_some() {
            self.recompute_find(cx);
        }
        let theme = cx.theme().clone();
        let look = self.look(&theme, window);
        // `.markie-document-scroll`'s padding: clamp(1.25rem, 3vw, 2.25rem)
        // above and below, clamp(1.5rem, 4vw, 3rem) at the sides, then the
        // column at min(100%, --doc-width).
        let vw = f32::from(window.viewport_size().width);
        let pad_y = (vw * 0.03).clamp(20., 36.);
        let pad_x = (vw * 0.04).clamp(24., 48.);
        let col = match super::style::width_index(self.page_width) {
            0 => px(self.style.content_width),
            4 => px(100_000.),
            _ => px(self.page_width),
        };
        let first_h1 = self.starts_with_h1();
        let mut prev_bottom: Option<f32> = None;
        let mut tops: Vec<Pixels> = Vec::with_capacity(self.editor.block_count());
        // Draw what is on screen (with a screen of margin either way), the
        // caret's and selection's ends, and any block not measured yet;
        // the rest is space of its last height.
        let top_visible = -self.scroll.offset().y;
        let screen = viewport.size.height.max(px(400.));
        let (lo, hi) = (top_visible - screen, top_visible + screen * 2.);
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
            if !near && b != a && b != h {
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
                    .pt(px(gap))
                    .child(div().w_full().max_w(col).child(el))
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
            .child(div().h(px(prev_bottom.unwrap_or(0.) + pad_y + 200.)).w_full())
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
        for (i, n) in nodes.iter().enumerate() {
            let el = self.render_node(b, n, vec![i], &mut counter, 0, Ctx::DOC, look, window, cx);
            let (t, bm) = Self::margins(n, look, Ctx::DOC);
            out.push((el, t, bm));
        }
        stack(out).0
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
            Node::Paragraph { align, .. } => {
                *counter += 1;
                let mut base = look.base(look.size);
                if let Some(c) = ctx.color {
                    base.color = c;
                }
                let lh = ctx.line_height.unwrap_or(look.line_height);
                self.rich_leaf(key, look, base, lh, align_of(align), window, cx)
            }
            Node::Heading { level, align, .. } => {
                *counter += 1;
                let (k, _, _, weight) = heading_metrics(*level);
                let size = look.size * k;
                let mut base = look.base(size);
                base.font.weight = FontWeight(weight);
                if let Some(f) = &look.heading_family {
                    base.font.family = f.clone();
                }
                if *level >= 5 {
                    base.color = look.muted;
                }
                let el = self.rich_leaf(key, look, base, look.line_height, align_of(align), window, cx);
                // h1 and h2 carry a hairline under them, a little below the text.
                let rule = match level {
                    1 => Some(0.3),
                    2 => Some(0.25),
                    _ => None,
                };
                match rule {
                    Some(em) => div().pb(px(em * size)).border_b_1().border_color(look.rule).child(el).into_any_element(),
                    None => el,
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
                let here = self.editor.head.block == b && self.editor.head.leaf == key.1;
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
                div()
                    .relative()
                    .px(px(look.size * 1.2))
                    .py(px(look.size))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(look.rule)
                    .bg(look.surface)
                    .child(el)
                    .children(lang_button)
                    .into_any_element()
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
                div()
                    .relative()
                    .h(px(1.))
                    .w_full()
                    .bg(if selected { look.link } else { look.rule })
                    .child(track(self.store.clone(), key))
                    .into_any_element()
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
                let inner = Ctx { para_em: Some(0.3), color: Some(look.muted), ..ctx };
                let mut kids = Vec::new();
                for (i, c) in children.iter().enumerate() {
                    let mut p = path.clone();
                    p.push(i);
                    let el = self.render_node(b, c, p, counter, depth, inner, look, window, cx);
                    let (t, bm) = Self::margins(c, look, inner);
                    kids.push((el, t, bm));
                }
                // The quote has padding, so its children's margins stay inside.
                let (el, t, bm) = stack(kids);
                div()
                    .relative()
                    .pl(px(look.size + 3.))
                    .pr(px(look.size))
                    .pt(px(look.size * 0.5 + t))
                    .pb(px(look.size * 0.5 + bm))
                    .bg(look.surface)
                    .rounded_tr(px(6.))
                    .rounded_br(px(6.))
                    .child(div().absolute().top_0().bottom_0().left_0().w(px(3.)).bg(rgb(QUOTE_RULE)))
                    .child(el)
                    .into_any_element()
            }
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let start = match n {
                    Node::OrderedList { start, .. } => Some(*start),
                    _ => None,
                };
                let item_ctx = Ctx { para_em: None, ..ctx };
                let li = 0.3 * look.size;
                let gutter = 1.8 * look.size;
                let mut rows = Vec::new();
                for (k, item) in items.iter().enumerate() {
                    let mut ip = path.clone();
                    ip.push(k);
                    let (body, t, bm) = self.render_item(b, item, ip, counter, depth, item_ctx, look, window, cx);
                    // `::marker`: outside, muted, at the item's own size.
                    let lh = look.size * ctx.line_height.unwrap_or(look.line_height);
                    let marker = match start {
                        Some(s) => div()
                            .w(px(gutter))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .pr(px(look.size * 0.3))
                            .text_size(px(look.size))
                            .line_height(px(lh))
                            .font_family(look.font.family.clone())
                            .text_color(look.muted)
                            .child(format!("{}.", s + k as u64)),
                        None => {
                            let ts = window.text_system();
                            let id = ts.resolve_font(&look.font);
                            let (asc, desc) = (f32::from(ts.ascent(id, px(look.size))), f32::from(ts.descent(id, px(look.size))));
                            let disc = disc_marker(look.size, lh, asc, desc, window.scale_factor());
                            div().w(px(gutter)).h(px(lh)).flex_none().relative().child(
                                div()
                                    .absolute()
                                    .left(px(disc.left))
                                    .top(px(disc.top))
                                    .size(px(disc.size))
                                    .rounded_full()
                                    .bg(look.muted),
                            )
                        }
                    };
                    let row = h_flex()
                        .items_start()
                        .child(marker)
                        .child(div().flex_1().min_w_0().child(body))
                        .into_any_element();
                    rows.push((row, li.max(t), li.max(bm)));
                }
                stack(rows).0
            }
            Node::TaskList { items } => {
                let item_ctx = Ctx { para_em: Some(0.), line_height: Some(1.6), ..ctx };
                let li = 2.4 * look.zoom;
                let mut rows = Vec::new();
                for (k, item) in items.iter().enumerate() {
                    let mut ip = path.clone();
                    ip.push(k);
                    let checked = item.checked;
                    let item_path = ip.clone();
                    let bx = div()
                        .id(SharedString::from(format!("task-{b}-{}", ip.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("-"))))
                        .size(px(16.))
                        .flex_none()
                        .rounded(px(4.))
                        .border_2()
                        .border_color(if checked { look.link } else { look.accent })
                        .when(checked, |d| d.bg(look.link))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .when(checked, |d| {
                            d.child(
                                div()
                                    .text_size(px(11.))
                                    .line_height(px(11.))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(look.background)
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
                        .gap(px(8.))
                        .pl(px(4.))
                        // The box is centred on a 1.6em label, the first line's height.
                        .child(div().h(px(look.size * 1.6)).flex_none().flex().items_center().child(bx))
                        .child(div().flex_1().min_w_0().child(body))
                        .into_any_element();
                    rows.push((row, li, li));
                }
                stack(rows).0
            }
            Node::Table { rows } => self.render_table(b, rows, path, counter, depth, look, window, cx),
        }
    }

    /// `.markdown-body table`: columns as wide as their text (the table is
    /// `display: block`, so it does not stretch), header cells bold and
    /// centred unless aligned, a hairline under each body row.
    #[allow(clippy::too_many_arguments)]
    fn render_table(
        &mut self,
        b: usize,
        rows: &[Vec<markie_rich::model::Cell>],
        path: Vec<usize>,
        counter: &mut usize,
        depth: usize,
        look: &Look,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let size = look.size * 0.9;
        let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let pad = |header: bool| if header { 1. } else { size };
        // Column widths from each cell's text on one line.
        let mut widths = vec![48f32 * look.zoom; ncols];
        for row in rows {
            for (c, cell) in row.iter().enumerate() {
                let text = cell_text(&cell.content);
                let mut st = look.base(size);
                if cell.header {
                    st.font.weight = FontWeight::BOLD;
                }
                let w = if text.is_empty() {
                    0.
                } else {
                    let run = TextRun { len: text.len(), font: st.font.clone(), color: st.color, background_color: None, underline: None, strikethrough: None };
                    f32::from(window.text_system().shape_line(SharedString::from(text), st.size, &[run], None).width)
                };
                widths[c] = widths[c].max(w + 2. * pad(cell.header) + 2.);
            }
        }
        // Narrower than the column: share the room in proportion.
        let room = f32::from(self.scroll.bounds().size.width).max(200.) - 2. * (f32::from(window.viewport_size().width) * 0.04).clamp(24., 48.);
        let total: f32 = widths.iter().sum();
        if total > room && total > 0. {
            let k = room / total;
            widths.iter_mut().for_each(|w| *w *= k);
        }
        let para = Ctx::DOC;
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
                                base.font.weight = FontWeight::BOLD;
                            }
                            let el = self.rich_leaf(k, look, base, look.line_height, align, window, cx);
                            let m = look.gap * size;
                            kids.push((el, m, m));
                        }
                        other => {
                            let el = self.render_node(b, other, p, counter, depth, para, look, window, cx);
                            let (t, bm) = Self::margins(other, look, para);
                            kids.push((el, t, bm));
                        }
                    }
                }
                let (el, t, bm) = stack(kids);
                let (px_, py_) = if cell.header { (1., 1.) } else { (size, size * 0.55) };
                cells.push(
                    div()
                        .w(px(widths.get(c).copied().unwrap_or(48.)))
                        .flex_none()
                        .flex()
                        .flex_col()
                        .justify_center()
                        .px(px(px_))
                        .pt(px(py_ + t))
                        .pb(px(py_ + bm))
                        .child(el)
                        .into_any_element(),
                );
            }
            let surface = look.surface;
            out_rows.push(
                h_flex()
                    .id(SharedString::from(format!("row-{b}-{r}")))
                    .items_stretch()
                    .when(!header_row, |d| d.border_b_1().border_color(look.rule).hover(move |s| s.bg(surface)))
                    .children(cells)
                    .into_any_element(),
            );
        }
        div().flex().child(v_flex().children(out_rows)).into_any_element()
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
            return (self.rich_leaf(key, look, look.base(look.size), lh, Align::Left, window, cx), 0., 0.);
        }
        let mut kids = Vec::new();
        for (j, n) in item.iter().enumerate() {
            let mut p = path.clone();
            p.push(j);
            let el = self.render_node(b, n, p, counter, depth + 1, ctx, look, window, cx);
            let (t, bm) = Self::margins(n, look, ctx);
            kids.push((el, t, bm));
        }
        stack(kids)
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
                    let i = i.object_fit(ObjectFit::Contain).with_fallback(fallback.clone()).max_w_full().rounded(px(8.));
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
            .child(
                div()
                    .group(group)
                    .relative()
                    .flex_none()
                    .max_w_full()
                    .when(w.is_some(), |d| d.w(px(w.unwrap() * look.zoom)))
                    .rounded(px(8.))
                    .child(image)
                    .when(selected, |d| {
                        d.child(div().absolute().top(px(-4.)).left(px(-4.)).right(px(-4.)).bottom(px(-4.)).rounded(px(10.)).border_2().border_color(look.link))
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
    fn rich_leaf(&mut self, key: LeafKey, look: &Look, base: SegStyle, line_height: f32, align: Align, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let units = self.editor.units(key.0, key.1);
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
                    segs.push(Seg { kind: SegKind::Text(text, style_for(m, &base, look)), units: start..i });
                }
                Unit::Atom(Inline::HardBreak) => {
                    segs.push(Seg { kind: SegKind::Break, units: i..i + 1 });
                    i += 1;
                }
                Unit::Atom(Inline::Math { source }) => {
                    // KaTeX draws inline formulas at 1.21em too.
                    let m = self.media.math(source, false, base.color, size * 1.21, look.scale);
                    let fallback_style = SegStyle { color: gpui_kit::red(), font: Font { family: look.mono.clone(), ..base.font.clone() }, ..base.clone() };
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
                    segs.push(Seg { kind: SegKind::Text(text.clone(), style_for(marks, &base, look)), units: i..i + 1 });
                    i += 1;
                }
            }
        }
        let len = units.len();
        let mut deco = self.deco(key, len, look, cx);
        if !self.read_only {
            deco.misspelled = self.misspelled(key, &units, cx);
        }
        let spec = LeafSpec { segs, base, line_height, align, len };
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

    /// Code, display math source or a raw block: plain text in mono. Code
    /// blocks are drawn in one ink, as TipTap draws them. `spell` checks
    /// spelling: Chromium checks a code block in the contenteditable like any
    /// other text; the formula field turns it off (`rich-math.ts`).
    #[allow(clippy::too_many_arguments)]
    fn plain_leaf(&mut self, key: LeafKey, look: &Look, size: f32, line_height: f32, color: Hsla, spell: bool, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let units = self.editor.units(key.0, key.1);
        let text: String = units.iter().map(|u| u.display()).collect();
        let mut base = look.base(size);
        base.font.family = look.mono.clone();
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
        let spec = LeafSpec { segs, base, line_height, align: Align::Left, len };
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

fn align_of(a: &Option<String>) -> Align {
    match a.as_deref() {
        Some("center") => Align::Center,
        Some("right") => Align::Right,
        _ => Align::Left,
    }
}

/// A run's look from its marks (`strong`, `em`, `del`, `code`, `a`,
/// `mark`, `u` and TipTap's `textStyle` in `.markdown-body`).
fn style_for(m: &Marks, base: &SegStyle, look: &Look) -> SegStyle {
    let mut s = base.clone();
    if m.bold {
        s.font.weight = FontWeight(650.);
    }
    if m.italic {
        s.font.style = FontStyle::Italic;
    }
    s.underline = m.underline;
    // TipTap writes `<s>`, which keeps the text's own ink; globals.css mutes
    // only `del`, which the rich editor never writes.
    s.strike = m.strike;
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
    if let Some(link) = &m.link {
        // `a[data-doc-link="none"]`: muted, for a document not shared with
        // this reader.
        s.color = if !look.unshared_links.is_empty() && look.unshared_links.contains(&media::reference_key(&link.href)) { look.muted } else { look.link };
    }
    if let Some(h) = &m.highlight {
        let c = h.color.as_deref().and_then(media::css_color).unwrap_or_else(|| rgb(0xfef08a).into());
        s.background = Some(c);
        // A highlighter is drawn on paper: dark ink on it in either theme.
        // (Electron keeps the page's ink, which is white on yellow in dark.)
        s.color = rgb(0x1f2328).into();
    }
    if m.code {
        s.font.family = look.mono.clone();
        s.size = s.size * 0.88;
        s.color = look.code_fg;
        s.background = Some(look.surface);
        s.border = Some(look.rule);
        s.pad_x = s.size * 0.4;
    }
    s
}

/// A cell's text on one line, to size its column.
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
    use super::disc_marker;

    #[test]
    fn the_disc_is_chromiums_symbol_marker() {
        // SF Pro at 16 px in a 1.75 line on a 2x screen: ascent 30.4 device
        // pixels floors to 30, so a 10 px (5 pt) disc 15 px below the ascent
        // line, its top 7.5 pt over the baseline; Electron's measures 7.25.
        let d = disc_marker(16., 28., 15.2, -3.85, 2.);
        assert_eq!(d.size, 5.);
        let baseline = (28. - (15.2 + 3.85)) / 2. + 15.2;
        assert!((baseline - d.top - 7.5).abs() < 0.01, "{d:?}");
        assert!((1.8 * 16. - (d.left + d.size / 2.) - 0.685 * 16.).abs() < 0.01);
        // On a 1x screen Chromium rounds in its own pixels: 15 floors to 15, 5 px.
        assert_eq!(disc_marker(16., 28., 15.2, -3.85, 1.).size, 5.);
        // Zoom grows it in whole device pixels.
        assert_eq!(disc_marker(32., 56., 30.4, -7.7, 2.).size, 10.);
    }
}
