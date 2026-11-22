//! The section rail (`section-rail.tsx`, overlay placement): one short tick
//! per heading, floating in the page's left margin, brighter for the
//! sections on screen. A click scrolls to the heading.
//!
//! It reads what the document pass already measured (`block_tops`,
//! `content_height`) and an outline cached per edit, so a frame costs one
//! walk over the headings and nothing more.

use gpui_kit::component::ActiveTheme;
use gpui_kit::*;

use super::RichView;

/// `RAIL_MIN_SECTIONS`, `RAIL_MIN_VIEWPORTS`.
const MIN_SECTIONS: usize = 3;
const MIN_VIEWPORTS: f32 = 1.5;
/// `TICK_LENGTH` for h1, h2, h3, and `GEOMETRY.overlay`.
const TICK: [f32; 3] = [10., 6., 4.];
const INSET: f32 = 14.;
const HIT_WIDTH: f32 = 30.;
/// `TICK_MAX_LENGTH + 4`: the rail's drawn width past the inset.
const DRAWN: f32 = 34.;

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
    pub(crate) fn render_rail(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.outline.0 != self.editor.version {
            self.outline = (self.editor.version, self.editor.outline());
        }
        let viewport = f32::from(self.scroll.bounds().size.height);
        let levels: Vec<(usize, u8)> = self.outline.1.iter().enumerate().filter(|(_, e)| e.level <= 3).map(|(i, e)| (i, e.level)).collect();
        if levels.len() < MIN_SECTIONS || viewport <= 0. || f32::from(self.content_height) <= viewport * MIN_VIEWPORTS {
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
        let step = pitch(shown.len(), available).unwrap_or(4.);
        let top_of = |i: usize| -> f32 {
            let b = self.outline.1[i].block;
            self.block_tops.get(b).map(|y| f32::from(*y)).unwrap_or(0.)
        };
        let scroll_top = -f32::from(self.scroll.offset().y);
        let end = f32::from(self.content_height);
        let fg = cx.theme().foreground;
        let mut ticks = Vec::with_capacity(shown.len());
        for (k, (index, level)) in shown.iter().copied().enumerate() {
            let start = top_of(index);
            let stop = shown.get(k + 1).map(|(n, _)| top_of(*n)).unwrap_or(end);
            let in_view = start < scroll_top + viewport && stop > scroll_top;
            let len = TICK[(level - 1) as usize] + if in_view { 1. } else { 0. };
            let color = fg.opacity(if in_view { 0.58 } else { 0.24 });
            let hot = fg.opacity(0.92);
            let group = SharedString::from(format!("rail-tick-{k}"));
            ticks.push(
                div()
                    .id(SharedString::from(format!("rail-{k}")))
                    .group(group.clone())
                    .relative()
                    .w(px(HIT_WIDTH))
                    .h(px(step))
                    .flex_none()
                    .cursor_pointer()
                    .child(
                        div()
                            .absolute()
                            .left(px(INSET))
                            .top(px(step / 2. - 1.))
                            .h(px(2.))
                            .w(px(len))
                            .rounded(px(1.))
                            .bg(color)
                            .group_hover(group, move |s| s.bg(hot)),
                    )
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        this.reveal_heading(index, window, cx);
                    }))
                    .into_any_element(),
            );
        }
        Some(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .w(px(INSET + DRAWN))
                .flex()
                .flex_col()
                .justify_center()
                .child(div().py(px(8.)).flex().flex_col().children(ticks))
                .into_any_element(),
        )
    }
}
