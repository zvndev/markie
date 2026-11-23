//! The picture viewer: Electron's `image-lightbox.tsx`, kind "image". A
//! double-click on a picture while editing (a single click when the document
//! is read-only) draws it as large as the window allows over the strong
//! scrim, with every other picture in the document one arrow key away.
//!
//! - The picture fits within the window less 96 pt each way, with 6 pt
//!   corners and a large shadow. A click on it shows it at its natural size,
//!   scrollable, and another click fits it again.
//! - The round 36 pt × sits 16 pt from the top right. With more than one
//!   picture, 44 pt ‹ and › sit 16 pt in from the sides, disabled at the ends.
//! - The caption (the alt text) and "n / total" sit in a pill 16 pt from the
//!   bottom.
//! - Escape, the × or a click on the scrim closes it. Arrow Right and Down go
//!   to the next picture, Left and Up to the previous one.
//!
//! Pictures in Markie RS are block nodes, so none sits inside a link, and a
//! video card's thumbnail is an embed, not a picture: `collectImages` leaves
//! both out in Electron as well.

use std::sync::Arc;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::RichView;
use super::media::{self, Source};
use super::render::Look;
use markie_rich::editor::{LeafKind, Pos};
use markie_rich::Node;

/// How much of the page colour the viewer's scrim lays over the document.
const SCRIM_STRONG: f32 = 0.82;

/// One picture as the viewer lists it (`LightboxImage`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LightboxImage {
    pub src: String,
    pub alt: String,
}

pub(crate) struct Lightbox {
    pub(crate) images: Vec<LightboxImage>,
    pub(crate) index: usize,
    actual_size: bool,
}

impl Lightbox {
    pub(crate) fn new(images: Vec<LightboxImage>, index: usize) -> Self {
        Self { images, index, actual_size: false }
    }

    /// `step`: stays put at either end.
    pub(crate) fn step(&mut self, delta: isize) -> bool {
        let next = self.index as isize + delta;
        if next < 0 || next as usize >= self.images.len() {
            return false;
        }
        self.index = next as usize;
        self.actual_size = false;
        true
    }

    /// The caption pill's two parts: the trimmed alt text, and "n / total"
    /// when there is more than one picture.
    pub(crate) fn caption(&self) -> (String, Option<String>) {
        let alt = self.images[self.index].alt.trim().to_string();
        let count = (self.images.len() > 1).then(|| format!("{} / {}", self.index + 1, self.images.len()));
        (alt, count)
    }
}

/// `markie-lightbox-control`: round, surface-2 at 88%, the border, and a
/// 6/18 shadow at 22% black.
fn control(id: &'static str, look: &Look, size: f32, text: f32, label: &'static str, disabled: bool) -> Stateful<Div> {
    let s2 = look.surface2;
    div()
        .id(id)
        .absolute()
        .size(px(size))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(s2.opacity(0.88))
        .border_1()
        .border_color(look.border)
        .text_color(look.fg)
        .text_size(px(text))
        .line_height(px(text))
        .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.22), offset: point(px(0.), px(6.)), blur_radius: px(18.), spread_radius: px(0.), inset: false }])
        .when(disabled, |d| d.opacity(0.35))
        .when(!disabled, |d| d.hover(move |s| s.bg(s2)).cursor_pointer())
        .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

impl RichView {
    /// Every picture in the document, in reading order (`collectImages`).
    pub(crate) fn collect_images(&self) -> Vec<(Pos, LightboxImage)> {
        let mut out = Vec::new();
        for b in 0..self.editor.block_count() {
            for (l, leaf) in self.editor.leaves_of(b).iter().enumerate() {
                if leaf.kind != LeafKind::Atom {
                    continue;
                }
                let p = Pos::new(b, l, 0);
                if let Some(Node::Image { src, alt, .. }) = self.editor.leaf_node(p) {
                    if !src.is_empty() && markie_rich::html::media_kind(src) == markie_rich::html::MediaKind::Image {
                        out.push((p, LightboxImage { src: src.clone(), alt: alt.clone().unwrap_or_default() }));
                    }
                }
            }
        }
        out
    }

    /// Open the viewer on the picture at `p`, if it is one.
    pub(crate) fn open_lightbox_at(&mut self, p: Pos, cx: &mut Context<Self>) -> bool {
        let all = self.collect_images();
        let Some(index) = all.iter().position(|(q, _)| q.block == p.block && q.leaf == p.leaf) else { return false };
        self.lightbox = Some(Lightbox::new(all.into_iter().map(|(_, i)| i).collect(), index));
        self.hide_link_card(cx);
        cx.notify();
        true
    }

    pub(crate) fn close_lightbox(&mut self, cx: &mut Context<Self>) -> bool {
        let open = self.lightbox.take().is_some();
        if open {
            cx.notify();
        }
        open
    }

    /// The arrow keys while the viewer is open. True when it took the key.
    pub(crate) fn lightbox_key(&mut self, delta: isize, cx: &mut Context<Self>) -> bool {
        let Some(lb) = self.lightbox.as_mut() else { return false };
        if lb.step(delta) {
            cx.notify();
        }
        true
    }

    /// The picture as the document already loaded it: nothing is fetched
    /// twice.
    fn lightbox_picture(&self, src: &str) -> Option<Img> {
        match media::resolve(src, self.base_dir.as_deref()) {
            Source::Local(p) if p.is_file() => Some(img(p)),
            Source::Local(_) => self.cloud_media.get(&media::reference_key(src)).cloned().map(img),
            Source::Inline(i) => Some(img(i)),
            Source::Remote(url) => match self.media.remote.get(&url) {
                Some(media::Remote::Ready(i)) => Some(img(Arc::clone(i))),
                _ => None,
            },
            Source::None => None,
        }
    }

    pub(crate) fn render_lightbox(&mut self, look: &Look, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let lb = self.lightbox.as_ref()?;
        let size = window.viewport_size();
        let (w, h) = (f32::from(size.width), f32::from(size.height));
        let image = &lb.images[lb.index];
        let (alt, count) = lb.caption();
        let (index, total, actual) = (lb.index, lb.images.len(), lb.actual_size);
        let picture = self.lightbox_picture(&image.src).map(|i| {
            let i = i.object_fit(ObjectFit::Contain).rounded(px(6.)).shadow_2xl();
            let i = if actual { i } else { i.max_w(px((w - 96.).max(0.))).max_h(px((h - 96.).max(0.))) };
            div()
                .id("lightbox-picture")
                .cursor(if actual { CursorStyle::ResizeLeftRight } else { CursorStyle::PointingHand })
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(lb) = this.lightbox.as_mut() {
                        lb.actual_size = !lb.actual_size;
                        cx.notify();
                    }
                }))
                .child(i)
        });
        let stage = div()
            .id("lightbox-stage")
            .w(px(w))
            .h(px(h))
            .flex()
            .items_center()
            .justify_center()
            .when(actual, |d| d.overflow_scroll())
            .when(!actual, |d| d.overflow_hidden())
            .children(picture);
        let close = control("lightbox-close", look, 36., 20., "Close picture", false)
            .top(px(16.))
            .right(px(16.))
            .child("×")
            .on_click(cx.listener(|this, _, _, cx| {
                this.close_lightbox(cx);
            }));
        let arrows = (total > 1).then(|| {
            let mid = (h - 44.) / 2.;
            let prev = control("lightbox-prev", look, 44., 22., "Previous picture", index == 0)
                .top(px(mid))
                .left(px(16.))
                .child("‹")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.lightbox_key(-1, cx);
                }));
            let next = control("lightbox-next", look, 44., 22., "Next picture", index + 1 == total)
                .top(px(mid))
                .right(px(16.))
                .child("›")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.lightbox_key(1, cx);
                }));
            [prev, next]
        });
        let caption = (!alt.is_empty() || count.is_some()).then(|| {
            div()
                .absolute()
                .bottom(px(16.))
                .left_0()
                .w(px(w))
                .flex()
                .justify_center()
                .child(
                    div()
                        .max_w(px(w * 0.8))
                        .flex()
                        .items_baseline()
                        .gap(px(12.))
                        .rounded(px(6.))
                        .bg(look.surface2.opacity(0.9))
                        .px(px(12.))
                        .py(px(6.))
                        .text_size(px(12.))
                        .text_color(look.fg)
                        .shadow_md()
                        .when(!alt.is_empty(), |d| d.child(div().min_w_0().truncate().child(alt.clone())))
                        .children(count.map(|c| div().flex_none().text_color(look.muted).child(c))),
                )
        });
        // `.markie-scrim-strong`: the page colour at 72% under a 12 px
        // backdrop blur. GPUI has no backdrop blur, so the dim is the stronger
        // 82% the app's other strong scrims use (dialog_chrome `scrim_strong`),
        // which keeps the page behind as far back as Chromium's blur does.
        let scrim = div()
            .id("lightbox-scrim")
            .relative()
            .w(px(w))
            .h(px(h))
            .bg(look.background.opacity(SCRIM_STRONG))
            .occlude()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
                this.close_lightbox(cx);
            }))
            .child(stage)
            .child(close)
            .children(arrows.into_iter().flatten())
            .children(caption);
        Some(deferred(anchored().position(point(px(0.), px(0.))).child(scrim)).with_priority(10).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{Lightbox, LightboxImage};

    fn pics(n: usize) -> Vec<LightboxImage> {
        (0..n).map(|i| LightboxImage { src: format!("{i}.png"), alt: if i == 0 { "  A cat ".into() } else { String::new() } }).collect()
    }

    #[test]
    fn steps_stop_at_the_ends_and_the_caption_counts() {
        let mut lb = Lightbox::new(pics(3), 0);
        assert!(!lb.step(-1));
        assert_eq!(lb.caption(), ("A cat".into(), Some("1 / 3".into())));
        assert!(lb.step(1) && lb.step(1));
        assert!(!lb.step(1));
        assert_eq!(lb.caption(), (String::new(), Some("3 / 3".into())));
        let one = Lightbox::new(pics(1), 0);
        assert_eq!(one.caption(), ("A cat".into(), None));
    }
}
