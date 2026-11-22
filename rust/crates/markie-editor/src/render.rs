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

/// Sizes and colours for one frame.
pub(crate) struct Look {
    pub size: f32,
    pub zoom: f32,
    pub fg: Hsla,
    pub muted: Hsla,
    pub link: Hsla,
    /// Checked boxes and the picture frame: a blue that reads in both themes.
    pub accent: Hsla,
    pub border: Hsla,
    pub code_bg: Hsla,
    pub selection: Hsla,
    pub caret: Hsla,
    pub find: Hsla,
    pub find_current: Hsla,
    pub font: Font,
    pub mono: SharedString,
    pub focused: bool,
    pub scale: f32,
}

impl Look {
    fn base(&self, size: f32) -> SegStyle {
        SegStyle { font: self.font.clone(), size: px(size), color: self.fg, background: None, underline: false, strike: false }
    }
}

fn heading_scale(level: u8) -> f32 {
    match level {
        1 => 2.0,
        2 => 1.5,
        3 => 1.25,
        4 => 1.1,
        5 => 1.0,
        _ => 0.9,
    }
}

impl RichView {
    pub(crate) fn look(&self, theme: &Theme, window: &Window) -> Look {
        let mut font = window.text_style().font();
        font.family = theme.font_family.clone();
        let mut sel = theme.selection;
        if !self.focus.is_focused(window) {
            sel.a *= 0.6;
        }
        Look {
            size: 16.0 * self.zoom,
            zoom: self.zoom,
            fg: theme.foreground,
            muted: theme.muted_foreground,
            link: theme.link,
            accent: rgb(0x2563eb).into(),
            border: theme.border,
            code_bg: theme.muted,
            selection: sel,
            caret: theme.caret,
            find: theme.warning.opacity(0.35),
            find_current: theme.warning.opacity(0.75),
            font,
            mono: theme.mono_font_family.clone(),
            focused: self.focus.is_focused(window),
            scale: window.scale_factor(),
        }
    }

    pub(crate) fn render_document(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
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
        let col = px(self.page_width);
        // Draw what is on screen (with a screen of margin either way), the
        // caret's and selection's ends, and any block not measured yet;
        // the rest is space of its last height.
        let top_visible = -self.scroll.offset().y;
        let screen = viewport.size.height.max(px(400.));
        let (lo, hi) = (top_visible - screen, top_visible + screen * 2.);
        let (a, h) = (self.editor.anchor.block, self.editor.head.block);
        let mut y = px(28.);
        let mut blocks: Vec<AnyElement> = Vec::with_capacity(self.editor.block_count());
        for b in 0..self.editor.block_count() {
            let height = self.heights.get(b).copied().flatten();
            let near = height.is_none_or(|ht| y + ht >= lo && y <= hi);
            y += height.unwrap_or(px(30.));
            if !near && b != a && b != h {
                blocks.push(div().w_full().h(height.unwrap_or(px(30.))).into_any_element());
                continue;
            }
            let el = self.render_block(b, &look, window, cx);
            let store = self.store.clone();
            blocks.push(
                div()
                    .relative()
                    .w_full()
                    .flex()
                    .justify_center()
                    .child(div().w_full().max_w(col).px(px(40.)).child(el))
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
            .pt(px(28.))
            .bg(theme.background)
            .text_color(theme.foreground)
            .children(blocks)
            // Room past the end, as a page has: a click there goes to the end.
            .child(div().h(px(240.)).w_full())
            .child(
                canvas(
                    move |_bounds, window, cx| {
                        // Keep the caret in sight after keyboard moves.
                        let st = store.borrow();
                        let viewport = scroll.bounds();
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
            let leaf = self.plain_leaf((b, 0), look, look.size * 0.85, true, None, window, cx);
            return div()
                .my(px(6.))
                .pl(px(10.))
                .border_l_2()
                .border_color(look.border)
                .text_color(look.muted)
                .child(leaf)
                .into_any_element();
        }
        let nodes = block.nodes().to_vec();
        let mut counter = 0usize;
        let mut out = Vec::new();
        for (i, n) in nodes.iter().enumerate() {
            out.push(self.render_node(b, n, vec![i], &mut counter, 0, look, window, cx));
        }
        v_flex().children(out).into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_node(
        &mut self,
        b: usize,
        n: &Node,
        path: Vec<usize>,
        counter: &mut usize,
        depth: usize,
        look: &Look,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = (b, *counter);
        match n {
            Node::Paragraph { align, .. } => {
                *counter += 1;
                let el = self.rich_leaf(key, look, look.size, 1.65, false, align_of(align), window, cx);
                div().pb(px(10. * look.zoom)).child(el).into_any_element()
            }
            Node::Heading { level, align, .. } => {
                *counter += 1;
                let size = look.size * heading_scale(*level);
                let el = self.rich_leaf(key, look, size, 1.3, true, align_of(align), window, cx);
                div()
                    .pt(px(size * 0.55))
                    .pb(px(size * 0.3))
                    .when(*level <= 2, |d| d.mb(px(4.)))
                    .child(el)
                    .into_any_element()
            }
            Node::CodeBlock { language, .. } => {
                *counter += 1;
                let el = self.plain_leaf(key, look, look.size * 0.88, false, language.clone(), window, cx);
                let label = language.clone().unwrap_or_else(|| "plain text".into());
                let pos = Pos::new(b, key.1, 0);
                let lang_button = div()
                    .id(SharedString::from(format!("lang-{b}-{}", key.1)))
                    .absolute()
                    .top(px(4.))
                    .right(px(8.))
                    .text_size(px(11. * look.zoom))
                    .text_color(look.muted)
                    .cursor_pointer()
                    .child(label)
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        this.open_prompt(super::PromptKind::CodeLanguage(pos), window, cx);
                    }));
                div()
                    .relative()
                    .mb(px(12. * look.zoom))
                    .p(px(14. * look.zoom))
                    .pt(px(18. * look.zoom))
                    .rounded(px(6.))
                    .bg(look.code_bg)
                    .child(el)
                    .child(lang_button)
                    .into_any_element()
            }
            Node::MathBlock { source } => {
                *counter += 1;
                let pos = Pos::new(b, key.1, 0);
                let editing = (self.editor.head.block, self.editor.head.leaf) == key || {
                    let (f, t) = self.editor.range();
                    self.editor.has_selection() && (f.block, f.leaf) <= key && key <= (t.block, t.leaf)
                };
                let img = self.media.math(source, true, look.fg, look.size * 1.1, look.scale);
                let rendered = match img {
                    Some(m) => div()
                        .flex()
                        .justify_center()
                        .child(img_el(m.image.clone()).w(px(m.width)).h(px(m.height)))
                        .into_any_element(),
                    None => div()
                        .text_color(gpui_kit::red())
                        .font_family(look.mono.clone())
                        .text_size(px(look.size * 0.85))
                        .child(source.clone())
                        .into_any_element(),
                };
                if editing {
                    let el = self.plain_leaf(key, look, look.size * 0.88, false, None, window, cx);
                    v_flex()
                        .mb(px(12. * look.zoom))
                        .gap(px(6.))
                        .child(div().p(px(10.)).rounded(px(6.)).bg(look.code_bg).child(el))
                        .child(rendered)
                        .into_any_element()
                } else {
                    // Not editing: the formula, a click away from its source.
                    let store = self.store.clone();
                    div()
                        .id(SharedString::from(format!("math-{b}-{}", key.1)))
                        .relative()
                        .py(px(8. * look.zoom))
                        .mb(px(8. * look.zoom))
                        .cursor_pointer()
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
                    .py(px(12. * look.zoom))
                    .child(div().h(px(1.)).w_full().bg(if selected { look.link } else { look.border }))
                    .when(selected, |d| d.rounded(px(3.)).bg(look.selection))
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
                let mut kids = Vec::new();
                for (i, c) in children.iter().enumerate() {
                    let mut p = path.clone();
                    p.push(i);
                    kids.push(self.render_node(b, c, p, counter, depth, look, window, cx));
                }
                div()
                    .mb(px(10. * look.zoom))
                    .pl(px(16.))
                    .border_l_4()
                    .border_color(look.border)
                    .text_color(look.muted)
                    .child(v_flex().children(kids))
                    .into_any_element()
            }
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let start = match n {
                    Node::OrderedList { start, .. } => Some(*start),
                    _ => None,
                };
                let mut rows = Vec::new();
                for (k, item) in items.iter().enumerate() {
                    let marker = match start {
                        Some(s) => format!("{}.", s + k as u64),
                        None => ["•", "◦", "▪"][depth % 3].to_string(),
                    };
                    let mut ip = path.clone();
                    ip.push(k);
                    let body = self.render_item(b, item, ip, counter, depth, look, window, cx);
                    rows.push(
                        h_flex()
                            .items_start()
                            .child(
                                div()
                                    .w(px(look.size * 1.5))
                                    .flex_none()
                                    .flex()
                                    .justify_end()
                                    .pr(px(6.))
                                    .text_size(px(look.size))
                                    .line_height(px(look.size * 1.65))
                                    .text_color(look.muted)
                                    .child(marker),
                            )
                            .child(div().flex_1().min_w_0().child(body))
                            .into_any_element(),
                    );
                }
                v_flex().mb(px(if depth == 0 { 10. * look.zoom } else { 0. })).children(rows).into_any_element()
            }
            Node::TaskList { items } => {
                let mut rows = Vec::new();
                for (k, item) in items.iter().enumerate() {
                    let mut ip = path.clone();
                    ip.push(k);
                    let checked = item.checked;
                    let item_path = ip.clone();
                    let bx = div()
                        .id(SharedString::from(format!("task-{b}-{}", ip.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("-"))))
                        .mt(px(look.size * 0.33))
                        .mr(px(8.))
                        .size(px(look.size * 0.95))
                        .flex_none()
                        .rounded(px(3.))
                        .border_1()
                        .border_color(if checked { look.accent } else { look.muted })
                        .when(checked, |d| d.bg(look.accent))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .when(checked, |d| {
                            d.child(svg().path("icons/check.svg").size(px(look.size * 0.7)).text_color(gpui_kit::white()))
                        })
                        .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            let p = item_path.clone();
                            this.edit(cx, |e| e.toggle_task(b, &p));
                        }));
                    let body = self.render_item(b, &item.content, ip, counter, depth, look, window, cx);
                    rows.push(
                        h_flex()
                            .items_start()
                            .pl(px(look.size * 0.3))
                            .child(bx)
                            .child(div().flex_1().min_w_0().when(checked, |d| d.text_color(look.muted)).child(body))
                            .into_any_element(),
                    );
                }
                v_flex().mb(px(if depth == 0 { 10. * look.zoom } else { 0. })).children(rows).into_any_element()
            }
            Node::Table { rows } => {
                let mut out_rows = Vec::new();
                for (r, row) in rows.iter().enumerate() {
                    let mut cells = Vec::new();
                    for (c, cell) in row.iter().enumerate() {
                        let mut cp = path.clone();
                        cp.push(r);
                        cp.push(c);
                        let mut kids = Vec::new();
                        for (j, n) in cell.content.iter().enumerate() {
                            let mut p = cp.clone();
                            p.push(j);
                            let k = (b, *counter);
                            match n {
                                Node::Paragraph { .. } => {
                                    *counter += 1;
                                    let align = match cell.align {
                                        Some(markie_rich::model::Align::Center) => Align::Center,
                                        Some(markie_rich::model::Align::Right) => Align::Right,
                                        _ => Align::Left,
                                    };
                                    kids.push(self.rich_leaf(k, look, look.size * 0.95, 1.5, cell.header, align, window, cx));
                                }
                                other => kids.push(self.render_node(b, other, p, counter, depth, look, window, cx)),
                            }
                        }
                        cells.push(
                            div()
                                .flex_1()
                                .min_w_0()
                                .px(px(10.))
                                .py(px(6.))
                                .border_r_1()
                                .border_color(look.border)
                                .when(cell.header, |d| d.bg(look.code_bg))
                                .children(kids)
                                .into_any_element(),
                        );
                    }
                    out_rows.push(h_flex().items_stretch().border_b_1().border_color(look.border).children(cells).into_any_element());
                }
                div()
                    .mb(px(12. * look.zoom))
                    .border_l_1()
                    .border_t_1()
                    .border_color(look.border)
                    .rounded(px(4.))
                    .children(out_rows)
                    .into_any_element()
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_item(
        &mut self,
        b: usize,
        item: &[Node],
        path: Vec<usize>,
        counter: &mut usize,
        depth: usize,
        look: &Look,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if item.is_empty() {
            // The virtual leaf of an empty item.
            let key = (b, *counter);
            *counter += 1;
            return self.rich_leaf(key, look, look.size, 1.65, false, Align::Left, window, cx);
        }
        let mut kids = Vec::new();
        for (j, n) in item.iter().enumerate() {
            let mut p = path.clone();
            p.push(j);
            let el = match n {
                // Paragraphs in a list sit close together.
                Node::Paragraph { .. } => {
                    let key = (b, *counter);
                    *counter += 1;
                    self.rich_leaf(key, look, look.size, 1.65, false, Align::Left, window, cx)
                }
                other => self.render_node(b, other, p, counter, depth + 1, look, window, cx),
            };
            kids.push(el);
        }
        v_flex().pb(px(2.)).children(kids).into_any_element()
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
        let image: AnyElement = if kind != markie_rich::html::MediaKind::Image {
            // Playback is phase 5: a card for the clip.
            div()
                .p(px(12.))
                .rounded(px(6.))
                .bg(look.code_bg)
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
                let bg = look.code_bg;
                let label = if alt_text.is_empty() { src.to_string() } else { alt_text.clone() };
                move || {
                    div().p(px(12.)).rounded(px(6.)).bg(bg).text_color(muted).child(format!("Picture: {label}")).into_any_element()
                }
            };
            match el {
                Some(i) => {
                    let i = i.object_fit(ObjectFit::Contain).with_fallback(fallback.clone()).max_w_full();
                    match w {
                        Some(w) => i.w(px(w * look.zoom)).into_any_element(),
                        None => i.into_any_element(),
                    }
                }
                None => fallback(),
            }
        };
        let handle = div()
            .id(SharedString::from(format!("resize-{}-{}", key.0, key.1)))
            .absolute()
            .bottom(px(-5.))
            .right(px(-5.))
            .size(px(12.))
            .rounded(px(2.))
            .bg(look.accent)
            .border_1()
            .border_color(gpui_kit::white())
            .cursor(CursorStyle::ResizeLeftRight)
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                cx.stop_propagation();
                // From the width the file holds, else the drawn width.
                let start = width.map(|w| w as f32).unwrap_or_else(|| {
                    this.store.borrow().atoms.get(&key).map(|b| f32::from(b.size.width) / this.zoom - 4.).unwrap_or(300.)
                });
                this.resize = Some((pos, f32::from(ev.position.x), start));
                this.live_width = Some((pos, start));
            }));
        div()
            .py(px(6.))
            .mb(px(6.))
            .child(
                div()
                    .relative()
                    .flex_none()
                    .max_w_full()
                    .when(w.is_some(), |d| d.w(px(w.unwrap() * look.zoom)))
                    .when(selected, |d| d.border_2().border_color(look.accent).rounded(px(3.)))
                    .child(image)
                    .child(track(self.store.clone(), key))
                    .when(selected && kind == markie_rich::html::MediaKind::Image, |d| d.child(handle)),
            )
            .into_any_element()
    }

    fn render_embed(&mut self, key: LeafKey, url: &str, look: &Look, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.is_atom_selected(key);
        let yt = media::youtube_id(url);
        let site = if yt.is_some() { "YouTube" } else { "Vimeo" };
        // Nothing is fetched until the card is hovered (link_card.rs).
        let fetched = self.link_hover.embeds.get(url).cloned();
        let title = fetched.as_ref().and_then(|(t, _)| t.clone()).unwrap_or_else(|| url.to_string());
        let thumb_el: Option<AnyElement> = fetched
            .and_then(|(_, i)| i)
            .map(|i| img(i).w(px(160.)).h(px(90.)).object_fit(ObjectFit::Cover).rounded(px(4.)).into_any_element());
        let hover_url = url.to_string();
        let open_url = url.to_string();
        div()
            .relative()
            .mb(px(10.))
            .p(px(10.))
            .rounded(px(8.))
            .border_1()
            .border_color(if selected { look.link } else { look.border })
            .bg(look.code_bg)
            .child(
                h_flex()
                    .gap(px(12.))
                    .items_center()
                    .children(thumb_el.or_else(|| Some(div().w(px(160.)).h(px(90.)).rounded(px(4.)).bg(look.border).into_any_element())))
                    .child(
                        v_flex()
                            .gap(px(4.))
                            .min_w_0()
                            .child(div().text_size(px(look.size * 0.95)).font_weight(FontWeight::SEMIBOLD).child(format!("{site} video")))
                            .child(div().text_size(px(look.size * 0.8)).text_color(look.muted).truncate().child(title))
                            .child(
                                div()
                                    .id(SharedString::from(format!("embed-open-{}-{}", key.0, key.1)))
                                    .text_size(px(look.size * 0.8))
                                    .text_color(look.link)
                                    .cursor_pointer()
                                    .child(format!("Open in {site}"))
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        cx.stop_propagation();
                                        cx.open_url(&open_url);
                                    }),
                            ),
                    ),
            )
            .child(track(self.store.clone(), key))
            .id(SharedString::from(format!("embed-card-{}-{}", key.0, key.1)))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| this.embed_hover(hover_url.clone(), *over, cx)))
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
        d
    }

    /// A paragraph, heading or cell: styled runs, inline formulas, breaks.
    #[allow(clippy::too_many_arguments)]
    fn rich_leaf(&mut self, key: LeafKey, look: &Look, size: f32, line_height: f32, bold: bool, align: Align, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let units = self.editor.units(key.0, key.1);
        let mut base = look.base(size);
        if bold {
            base.font.weight = FontWeight::BOLD;
        }
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
                    let m = self.media.math(source, false, base.color, size, look.scale);
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

    /// Code, display math source or a raw block: plain text in mono.
    #[allow(clippy::too_many_arguments)]
    fn plain_leaf(&mut self, key: LeafKey, look: &Look, size: f32, _raw: bool, language: Option<String>, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let units = self.editor.units(key.0, key.1);
        let text: String = units.iter().map(|u| u.display()).collect();
        let mut base = look.base(size);
        base.font.family = look.mono.clone();
        // Syntax colours by byte range, from GPUI Kit's highlighter.
        let styles: Vec<(std::ops::Range<usize>, HighlightStyle)> = match language.as_deref().filter(|l| !l.is_empty()) {
            Some(lang) => self.highlight(lang, &text, cx),
            None => vec![],
        };
        let mut segs: Vec<Seg> = Vec::new();
        let chars: Vec<(usize, char)> = text.char_indices().collect();
        let mut i = 0;
        let style_at = |byte: usize| styles.iter().find(|(r, _)| r.start <= byte && byte < r.end).map(|(_, s)| s.clone());
        while i < chars.len() {
            if chars[i].1 == '\n' {
                segs.push(Seg { kind: SegKind::Break, units: i..i + 1 });
                i += 1;
                continue;
            }
            let start = i;
            let st = style_at(chars[i].0);
            let mut s = String::new();
            while i < chars.len() && chars[i].1 != '\n' && style_at(chars[i].0) == st {
                s.push(chars[i].1);
                i += 1;
            }
            let mut seg_style = base.clone();
            if let Some(h) = st {
                if let Some(c) = h.color {
                    seg_style.color = c;
                }
                if let Some(w) = h.font_weight {
                    seg_style.font.weight = w;
                }
                if let Some(fs) = h.font_style {
                    seg_style.font.style = fs;
                }
            }
            segs.push(Seg { kind: SegKind::Text(s, seg_style), units: start..i });
        }
        let len = units.len();
        let deco = self.deco(key, len, look, cx);
        let spec = LeafSpec { segs, base, line_height: 1.5, align: Align::Left, len };
        div().w_full().child(LeafElement::new(key, spec, deco, self.store.clone())).into_any_element()
    }

    fn highlight(&self, lang: &str, code: &str, cx: &App) -> Vec<(std::ops::Range<usize>, HighlightStyle)> {
        use gpui_kit::component::highlighter::SyntaxHighlighter;
        let theme = cx.theme().highlight_theme.clone();
        let mut map = self.highlighters.borrow_mut();
        let h = map.entry(lang.to_string()).or_insert_with(|| SyntaxHighlighter::new(lang));
        let rope = gpui_kit::base::input::Rope::from_str(code);
        h.update(None, &rope, None);
        h.styles(&(0..code.len()), theme.as_ref())
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

/// A run's look from its marks.
fn style_for(m: &Marks, base: &SegStyle, look: &Look) -> SegStyle {
    let mut s = base.clone();
    if m.bold {
        s.font.weight = FontWeight::BOLD;
    }
    if m.italic {
        s.font.style = FontStyle::Italic;
    }
    s.underline = m.underline;
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
    if m.link.is_some() {
        s.color = look.link;
        s.underline = true;
    }
    if let Some(h) = &m.highlight {
        let c = h.color.as_deref().and_then(media::css_color).unwrap_or_else(|| rgb(0xfef08a).into());
        s.background = Some(c);
        // A highlighter is drawn on paper: dark text on it in either theme.
        s.color = rgb(0x1f2328).into();
    }
    if m.code {
        s.font.family = look.mono.clone();
        s.size = s.size * 0.9;
        s.background = Some(look.code_bg);
    }
    s
}
