//! The section rail (`section-rail.tsx`, overlay placement): one short tick
//! per heading, floating in the page's left margin, brighter for the
//! sections on screen. A click scrolls to the heading.
//!
//! Pointing at the rail magnifies the tick under the pointer and, less, its
//! neighbours, like the Dock, and a card beside it previews that section.
//! The card waits 180 ms before it first opens, then follows the pointer
//! from tick to tick, and stays 120 ms after the pointer leaves.
//!
//! It reads what the document pass already measured (`block_tops`,
//! `content_height`) and an outline and previews cached per edit, so a frame
//! costs one walk over the headings and nothing more.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::ActiveTheme;
use gpui_kit::*;

use markie_rich::editor::{Editor, LeafKind, OutlineEntry};

use super::RichView;

/// `RAIL_MIN_SECTIONS`, `RAIL_MIN_VIEWPORTS`.
const MIN_SECTIONS: usize = 3;
const MIN_VIEWPORTS: f32 = 1.5;
/// `TICK_LENGTH` for h1, h2, h3, and `GEOMETRY.overlay`.
const TICK: [f32; 3] = [10., 6., 4.];
const INSET: f32 = 14.;
const HIT_WIDTH: f32 = 30.;
/// `MAGNIFY_GROWTH` and `MAGNIFY_FALLOFF`: how far the tick under the
/// pointer grows, and the share its neighbours get by distance.
const GROWTH: f32 = 20.;
const FALLOFF: [f32; 4] = [1., 0.75, 0.45, 0.22];
/// `TICK_MAX_LENGTH + 4`: the rail's drawn width past the inset.
const DRAWN: f32 = 34.;
/// The card: `CARD_WIDTH`, `CARD_GAP`, `EDGE`, the two delays, and
/// `SNIPPET_CHARS`.
const CARD_WIDTH: f32 = 320.;
const CARD_GAP: f32 = 6.;
const EDGE: f32 = 8.;
const CARD_OPEN_MS: u64 = 180;
const CARD_CLOSE_MS: u64 = 120;
const SNIPPET_CHARS: usize = 180;

/// The pointer on the rail: the tick under it (an index into the shown
/// ticks), the tick the card shows, and timers by generation.
#[derive(Default)]
pub(crate) struct RailHover {
    hot: Option<usize>,
    card: Option<usize>,
    generation: u64,
    /// The rail column's bounds as last drawn, to place the card.
    bounds: Rc<Cell<Bounds<Pixels>>>,
    /// Section previews for the outline of this document version.
    snippets: (u64, Vec<String>),
}

/// `magnification`: the share of the growth a tick `distance` ticks from
/// the pointer gets.
pub(crate) fn magnification(distance: usize) -> f32 {
    FALLOFF.get(distance).copied().unwrap_or(0.)
}

/// A tick's drawn length: its rest length, one more while its section is
/// on screen and the pointer is off the rail, and its share of the growth.
pub(crate) fn tick_length(level: u8, in_view: bool, hot: Option<usize>, index: usize) -> f32 {
    let rest = TICK[(level.clamp(1, 3) - 1) as usize];
    let lift = if in_view && hot.is_none() { 1. } else { 0. };
    let boost = hot.map(|h| magnification(h.abs_diff(index))).unwrap_or(0.);
    rest + lift + boost * GROWTH
}

/// `clipSnippet`: whitespace folded, cut at a word near 180 characters,
/// with an ellipsis.
pub(crate) fn clip_snippet(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return flat;
    }
    let cut: String = chars[..SNIPPET_CHARS].iter().collect();
    let space = cut.rfind(' ').map(|b| cut[..b].chars().count());
    let kept: String = match space {
        Some(n) if n as f32 > SNIPPET_CHARS as f32 * 0.6 => chars[..n].iter().collect(),
        _ => cut,
    };
    format!("{}…", kept.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':' | '.')))
}

/// `readRichSections`'s preview: the text of the top-level blocks after the
/// heading, up to the next heading at its level or above, code left out.
pub(crate) fn section_snippet(editor: &Editor, entry: &OutlineEntry) -> String {
    let mut snippet = String::new();
    for b in entry.block + 1..editor.block_count() {
        let leaves = editor.leaves_of(b);
        if let Some(first) = leaves.first() {
            if let LeafKind::Heading(l) = first.kind {
                if first.frames.is_empty() && l <= entry.level {
                    break;
                }
            }
        }
        if snippet.chars().count() >= SNIPPET_CHARS {
            break;
        }
        let mut words = Vec::new();
        for (i, leaf) in leaves.iter().enumerate() {
            if matches!(leaf.kind, LeafKind::Code | LeafKind::Math | LeafKind::Atom | LeafKind::Source) {
                continue;
            }
            let t: String = editor.units(b, i).iter().map(|u| u.display()).collect();
            let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
            if !t.is_empty() {
                words.push(t);
            }
        }
        let words = words.join(" ");
        if !words.is_empty() {
            if !snippet.is_empty() {
                snippet.push(' ');
            }
            snippet.push_str(&words);
        }
    }
    clip_snippet(&snippet)
}

/// `tickPitch`: 10px a tick, down to 4, or None when even 4 does not fit.
fn pitch(count: usize, available: f32) -> Option<f32> {
    if count == 0 {
        return Some(10.);
    }
    let fit = (available * 0.9 / count as f32).floor();
    if fit >= 10. {
        Some(10.)
    } else if fit >= 4. {
        Some(fit)
    } else {
        None
    }
}

impl RichView {
    /// Point at shown tick `k`: magnify around it, and open the card after
    /// the first wait, or move it straight there once open.
    fn rail_point(&mut self, k: usize, cx: &mut Context<Self>) {
        let h = &mut self.rail_hover;
        if h.hot == Some(k) {
            return;
        }
        h.hot = Some(k);
        h.generation += 1;
        if h.card.is_some() {
            h.card = Some(k);
        } else {
            let generation = h.generation;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(CARD_OPEN_MS)).await;
                this.update(cx, |this, cx| {
                    let h = &mut this.rail_hover;
                    if h.generation == generation && h.hot.is_some() {
                        h.card = h.hot;
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
        cx.notify();
    }

    /// The pointer left the rail: the ticks ease back at once, the card a
    /// moment later.
    fn rail_leave(&mut self, cx: &mut Context<Self>) {
        let h = &mut self.rail_hover;
        h.hot = None;
        h.generation += 1;
        if h.card.is_some() {
            let generation = h.generation;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(CARD_CLOSE_MS)).await;
                this.update(cx, |this, cx| {
                    let h = &mut this.rail_hover;
                    if h.generation == generation && h.hot.is_none() {
                        h.card = None;
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
        cx.notify();
    }

    pub(crate) fn render_rail(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.outline.0 != self.editor.version {
            self.outline = (self.editor.version, self.editor.outline());
        }
        let viewport = f32::from(self.scroll.bounds().size.height);
        let levels: Vec<(usize, u8)> = self.outline.1.iter().enumerate().filter(|(_, e)| e.level <= 3).map(|(i, e)| (i, e.level)).collect();
        if levels.len() < MIN_SECTIONS || viewport <= 0. || f32::from(self.content_height) <= viewport * MIN_VIEWPORTS {
            self.rail_hover.hot = None;
            self.rail_hover.card = None;
            return None;
        }
        // `levelsThatFit`: drop h3, then h2, while the ticks do not fit.
        let available = viewport - 16.;
        let mut deepest = 3u8;
        for d in [3u8, 2, 1] {
            let count = levels.iter().filter(|(_, l)| *l <= d).count();
            if d < 3 && count < MIN_SECTIONS {
                break;
            }
            deepest = d;
            if pitch(count, available).is_some() {
                break;
            }
        }
        let shown: Vec<(usize, u8)> = levels.into_iter().filter(|(_, l)| *l <= deepest).collect();
        if self.rail_hover.hot.is_some_and(|h| h >= shown.len()) || self.rail_hover.card.is_some_and(|c| c >= shown.len()) {
            self.rail_hover.hot = None;
            self.rail_hover.card = None;
        }
        let step = pitch(shown.len(), available).unwrap_or(4.);
        let top_of = |i: usize| -> f32 {
            let b = self.outline.1[i].block;
            self.block_tops.get(b).map(|y| f32::from(*y)).unwrap_or(0.)
        };
        let scroll_top = -f32::from(self.scroll.offset().y);
        let end = f32::from(self.content_height);
        let theme = cx.theme();
        let fg = theme.foreground;
        let hot = self.rail_hover.hot;
        let mut ticks = Vec::with_capacity(shown.len());
        for (k, (index, level)) in shown.iter().copied().enumerate() {
            let start = top_of(index);
            let stop = shown.get(k + 1).map(|(n, _)| top_of(*n)).unwrap_or(end);
            let in_view = start < scroll_top + viewport && stop > scroll_top;
            let len = tick_length(level, in_view, hot, k);
            // Faint at rest, about half for the part on screen, nearly full
            // under the pointer; the on-screen run steps back while the
            // pointer is on the rail (`[data-scrubbing]`).
            let alpha = if hot == Some(k) {
                0.92
            } else if in_view && hot.is_none() {
                0.58
            } else {
                0.24
            };
            ticks.push(
                div()
                    .id(SharedString::from(format!("rail-{k}")))
                    .relative()
                    .w(px(HIT_WIDTH))
                    .h(px(step))
                    .flex_none()
                    .cursor_pointer()
                    .child(div().absolute().left(px(INSET)).top(px(step / 2. - 1.)).h(px(2.)).w(px(len)).rounded(px(1.)).bg(fg.opacity(alpha)))
                    .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                        if *over {
                            this.rail_point(k, cx);
                        }
                    }))
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        this.reveal_heading(index, window, cx);
                    }))
                    .into_any_element(),
            );
        }
        let bounds = self.rail_hover.bounds.clone();
        let card = self.rail_hover.card.and_then(|k| shown.get(k).map(|(i, _)| (k, *i))).map(|(k, index)| {
            if self.rail_hover.snippets.0 != self.editor.version {
                let snippets = self.outline.1.iter().map(|e| section_snippet(&self.editor, e)).collect();
                self.rail_hover.snippets = (self.editor.version, snippets);
            }
            let entry = &self.outline.1[index];
            let snippet = self.rail_hover.snippets.1.get(index).cloned().unwrap_or_default();
            self.section_card(k, step, entry.text.clone(), entry.level, snippet, window, cx)
        });
        Some(
            div()
                .id("section-rail")
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .w(px(INSET + DRAWN))
                .flex()
                .flex_col()
                .justify_center()
                .child(
                    div()
                        .id("section-rail-ticks")
                        .relative()
                        .py(px(8.))
                        .flex()
                        .flex_col()
                        .children(ticks)
                        .on_hover(cx.listener(|this, over: &bool, _, cx| {
                            if !*over {
                                this.rail_leave(cx);
                            }
                        }))
                        .child(canvas(move |b, _, _| bounds.set(b), |_, _, _, _| {}).absolute().top_0().left_0().size_full()),
                )
                .children(card)
                .into_any_element(),
        )
    }

    /// `SectionCard`: the heading on one line with its level, then the start
    /// of its section, beside the tick and kept on screen.
    #[allow(clippy::too_many_arguments)]
    fn section_card(&self, k: usize, step: f32, text: String, level: u8, snippet: String, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let dark = theme.mode.is_dark();
        let column = self.rail_hover.bounds.get();
        // The tick's middle: the column is the ticks plus 8 px above.
        let mid = f32::from(column.origin.y) + 8. + step * k as f32 + step / 2.;
        let window_w = f32::from(window.viewport_size().width);
        let window_h = f32::from(window.viewport_size().height);
        let left = (f32::from(column.origin.x) + INSET + DRAWN + CARD_GAP).min((window_w - CARD_WIDTH - EDGE).max(EDGE));
        // Its height, for centring on the tick: 10 + 20 + 4 + lines of 20 +
        // 12 px and the border, with up to three lines of about 46 chars.
        let shown_snippet = if snippet.is_empty() { "No text before the next heading.".to_string() } else { snippet };
        let lines = shown_snippet.chars().count().div_ceil(46).clamp(1, 3) as f32;
        let height = 10. + 20. + 4. + lines * 20. + 12. + 2.;
        let half = height / 2.;
        let top = (mid.clamp(EDGE + half, (window_h - EDGE - half).max(EDGE + half))) - half;
        let shadow = if dark {
            BoxShadow { color: hsla(0., 0., 0., 0.4), offset: point(px(0.), px(8.)), blur_radius: px(24.), spread_radius: px(0.), inset: false }
        } else {
            BoxShadow { color: hsla(0., 0., 0., 0.12), offset: point(px(0.), px(6.)), blur_radius: px(20.), spread_radius: px(0.), inset: false }
        };
        let card = div()
            .w(px(CARD_WIDTH))
            .max_w(px(window_w - EDGE * 2.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.muted)
            .px(px(12.))
            .pt(px(10.))
            .pb(px(12.))
            .text_color(theme.foreground)
            .shadow(vec![shadow])
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap(px(8.))
                    .child(div().min_w_0().flex_1().truncate().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).line_height(px(20.)).child(text))
                    .child(div().flex_none().font_family(super::MONO).text_size(px(10.)).line_height(px(20.)).text_color(theme.muted_foreground).child(format!("H{level}"))),
            )
            .child(div().mt(px(4.)).text_size(px(12.5)).line_height(px(20.)).text_color(theme.muted_foreground).line_clamp(3).child(shown_snippet));
        deferred(anchored().position(point(px(left), px(top))).child(card)).with_priority(3).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{Editor, SNIPPET_CHARS, clip_snippet, section_snippet, tick_length};

    #[test]
    fn the_tick_under_the_pointer_grows_most_and_its_neighbours_less() {
        // At rest: 10, 6, 4, plus one for the part on screen.
        assert_eq!(tick_length(1, false, None, 0), 10.);
        assert_eq!(tick_length(2, true, None, 0), 7.);
        // Under the pointer an h1 is 30 px (`TICK_MAX_LENGTH`).
        assert_eq!(tick_length(1, true, Some(4), 4), 30.);
        // The falloff: 0.75, 0.45, 0.22 of 20, then nothing.
        assert_eq!(tick_length(3, false, Some(4), 5), 4. + 15.);
        assert_eq!(tick_length(3, false, Some(4), 2), 4. + 9.);
        assert!((tick_length(3, false, Some(4), 7) - (4. + 4.4)).abs() < 1e-4);
        assert_eq!(tick_length(3, false, Some(4), 8), 4.);
        // While scrubbing, the on-screen lift goes.
        assert_eq!(tick_length(2, true, Some(0), 9), 6.);
    }

    #[test]
    fn snippets_are_clipped_at_a_word_like_clip_snippet() {
        assert_eq!(clip_snippet("  short\n text  "), "short text");
        let long = "word ".repeat(60);
        let clipped = clip_snippet(&long);
        assert!(clipped.ends_with('…'));
        assert!(clipped.chars().count() <= SNIPPET_CHARS + 1);
        assert!(!clipped.contains("  "));
    }

    #[test]
    fn a_section_previews_up_to_the_next_heading_at_its_level_without_code() {
        let ed = Editor::parse("# One\n\nFirst para.\n\n```\ncode here\n```\n\n## Sub\n\nUnder sub.\n\n# Two\n\nSecond.\n\n# Empty\n\n# Three\n");
        let outline = ed.outline();
        assert_eq!(section_snippet(&ed, &outline[0]), "First para. Sub Under sub.");
        assert_eq!(section_snippet(&ed, &outline[1]), "Under sub.");
        assert_eq!(section_snippet(&ed, &outline[2]), "Second.");
        assert_eq!(section_snippet(&ed, &outline[3]), "");
    }
}
