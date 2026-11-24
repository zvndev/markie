//! The link preview card (`link-preview-card.tsx`): rest the pointer on a
//! web link for 450 ms and a 320 px card with the page's picture, site,
//! title, description and host appears below it (above it near the bottom of
//! the window). It goes 180 ms after the pointer leaves both the link and the
//! card, and at once on a click elsewhere, a scroll, Escape or an edit. A
//! click on the card opens the page in the browser.
//!
//! Nothing is fetched unless the pointer stays: leaving before 450 ms cancels
//! the request. `previews_enabled` is the Settings switch (on by default).

use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::RichView;
use super::attach::external_web_target;
use super::link_preview::{LinkPreview, Lookup, Previews};

const HOVER_MS: u64 = 450;
const LEAVE_MS: u64 = 180;
const CARD_WIDTH: f32 = 320.;
const GAP: f32 = 8.;

#[derive(Default)]
pub(crate) struct LinkHover {
    /// The link under the pointer: its address and where it is drawn.
    wanted: Option<(String, Bounds<Pixels>)>,
    shown: Option<(LinkPreview, Option<Arc<Image>>, Bounds<Pixels>)>,
    over_card: bool,
    generation: u64,
    pub previews: Previews,
    /// Embed cards' title and picture, fetched on a deliberate hover
    /// (rich-embed.ts), by link.
    pub embeds: std::collections::HashMap<String, (Option<String>, Option<Arc<Image>>)>,
    embed_generation: u64,
}

/// The card's place: (top-left or bottom-left point, below the link?).
pub fn place(link: Bounds<Pixels>, window: Size<Pixels>) -> (Point<Pixels>, bool) {
    let below = f32::from(window.height - link.bottom()) > 280. || f32::from(link.top()) < 280.;
    let max_left = (f32::from(window.width) - CARD_WIDTH - GAP).max(GAP);
    let left = f32::from(link.left()).max(GAP).min(max_left);
    let top = if below { f32::from(link.bottom()) + GAP } else { f32::from(link.top()) - GAP };
    (point(px(left), px(top)), below)
}

impl RichView {
    /// The web link under `at`, with the bounds of its run on that line.
    fn link_at_point(&self, at: Point<Pixels>) -> Option<(String, Bounds<Pixels>)> {
        let p = self.hit(at)?;
        let (a, b, link) = self.editor.link_range(p)?;
        let href = external_web_target(&link.href)?;
        let store = self.store.borrow();
        let pl = store.leaves.get(&(p.block, p.leaf))?;
        let o = pl.bounds.origin;
        pl.laid
            .selection_rects(a..b)
            .into_iter()
            .map(|r| Bounds::new(point(o.x + r.origin.x, o.y + r.origin.y), r.size))
            .find(|r| r.contains(&at))
            .map(|r| (href, r))
    }

    pub(crate) fn link_hover_visible(&self) -> bool {
        self.link_hover.shown.is_some()
    }

    /// Settings › Advanced › "Preview links on hover". Off hides a card that
    /// is up and stops any fetch still waiting.
    pub fn set_link_previews(&mut self, on: bool, cx: &mut Context<Self>) {
        self.link_previews = on;
        if !on {
            self.hide_link_card(cx);
        }
        cx.notify();
    }

    pub(crate) fn hide_link_card(&mut self, cx: &mut Context<Self>) {
        let h = &mut self.link_hover;
        if h.wanted.is_some() || h.shown.is_some() {
            h.wanted = None;
            h.shown = None;
            h.over_card = false;
            h.generation += 1;
            cx.notify();
        }
    }

    /// The link whose own text is under `at`, as its leaf and units.
    fn link_run_at(&self, at: Point<Pixels>) -> Option<((usize, usize), std::ops::Range<usize>)> {
        let p = self.hit(at)?;
        let (a, b, _) = self.editor.link_range(p)?;
        let store = self.store.borrow();
        let pl = store.leaves.get(&(p.block, p.leaf))?;
        let o = pl.bounds.origin;
        pl.laid.selection_rects(a..b).into_iter().any(|r| Bounds::new(point(o.x + r.origin.x, o.y + r.origin.y), r.size).contains(&at)).then_some(((p.block, p.leaf), a..b))
    }

    pub(crate) fn link_hover_move(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        // `.markdown-body a:hover`: the link under the pointer is underlined.
        let hovered = self.link_run_at(at);
        if hovered != self.hovered_link {
            self.hovered_link = hovered;
            cx.notify();
        }
        if !self.link_previews {
            return;
        }
        let over = self.link_at_point(at);
        let h = &mut self.link_hover;
        match over {
            Some((href, rect)) => {
                if h.wanted.as_ref().is_some_and(|(w, _)| *w == href) {
                    // Still on it: a pending leave is cancelled.
                    h.generation += 1;
                    let generation = h.generation;
                    if h.shown.is_none() {
                        self.schedule_fetch(href, rect, generation, cx);
                    }
                    return;
                }
                h.shown = None;
                h.wanted = Some((href.clone(), rect));
                h.generation += 1;
                let generation = h.generation;
                self.schedule_fetch(href, rect, generation, cx);
                cx.notify();
            }
            None => {
                if h.wanted.is_none() || h.over_card {
                    return;
                }
                h.generation += 1;
                let generation = h.generation;
                // Before the card is up, leaving cancels the request at once.
                if h.shown.is_none() {
                    h.wanted = None;
                    return;
                }
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(LEAVE_MS)).await;
                    this.update(cx, |this, cx| {
                        if this.link_hover.generation == generation && !this.link_hover.over_card {
                            this.hide_link_card(cx);
                        }
                    })
                    .ok();
                })
                .detach();
            }
        }
    }

    fn schedule_fetch(&mut self, href: String, rect: Bounds<Pixels>, generation: u64, cx: &mut Context<Self>) {
        let previews = self.link_hover.previews.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(HOVER_MS)).await;
            let still = this.update(cx, |this, _| this.link_hover.generation == generation && this.link_previews).unwrap_or(false);
            if !still {
                return;
            }
            let card = match previews.lookup(&href) {
                Lookup::Ready(v) => v,
                Lookup::Refused => None,
                Lookup::Fetch(key) => {
                    let p = previews.clone();
                    cx.background_executor().spawn(async move { p.fetch(&key) }).await
                }
            };
            let Some(card) = card else { return };
            if external_web_target(&card.url).is_none() {
                return;
            }
            let image = card.image.as_ref().and_then(|(bytes, ty)| image_of(bytes, ty));
            this.update(cx, |this, cx| {
                let h = &mut this.link_hover;
                if h.wanted.as_ref().is_some_and(|(w, _)| *w == href) {
                    h.shown = Some((card, image, rect));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn render_link_card(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (card, image, rect) = self.link_hover.shown.as_ref()?;
        let (at, below) = place(*rect, window.viewport_size());
        let theme = cx.theme();
        let host = url_host(&card.url);
        let url = card.url.clone();
        let body = div()
            .id("rich-link-card")
            .w(px(CARD_WIDTH))
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.background)
            .text_color(theme.foreground)
            .shadow_lg()
            .cursor_pointer()
            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                this.link_hover.over_card = *over;
                if !*over {
                    let generation = this.link_hover.generation + 1;
                    this.link_hover.generation = generation;
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(Duration::from_millis(LEAVE_MS)).await;
                        this.update(cx, |this, cx| {
                            if this.link_hover.generation == generation && !this.link_hover.over_card {
                                this.hide_link_card(cx);
                            }
                        })
                        .ok();
                    })
                    .detach();
                }
            }))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |this, _, _, cx| {
                if let super::behaviour::Activation::Web(u) = super::behaviour::activation(&url, &Default::default(), None) {
                    cx.open_url(&u);
                }
                this.hide_link_card(cx);
            }))
            .children(image.clone().map(|i| img(i).w_full().h(px(132.)).object_fit(ObjectFit::Cover).border_b_1().border_color(theme.border)))
            .child(
                div()
                    .p(px(12.))
                    .when(!card.site_name.is_empty(), |d| {
                        d.child(div().mb(px(4.)).truncate().text_size(px(10.)).text_color(theme.muted_foreground).child(card.site_name.to_uppercase()))
                    })
                    .children(card.title.clone().map(|t| div().mb(px(4.)).line_clamp(2).text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).child(t)))
                    .children(card.description.clone().map(|d| div().line_clamp(3).text_size(px(11.)).text_color(theme.muted_foreground).child(d)))
                    .child(div().mt(px(8.)).truncate().text_size(px(10.)).text_color(theme.muted_foreground).child(format!("{host} ↗"))),
            );
        let anchor = if below { Anchor::TopLeft } else { Anchor::BottomLeft };
        Some(deferred(anchored().position(at).anchor(anchor).snap_to_window_with_margin(px(GAP)).child(body)).with_priority(2).into_any_element())
    }
}

impl RichView {
    /// Hovering an embed card for 450 ms asks for its title and picture;
    /// leaving first cancels (rich-embed.ts `beginPreview`).
    pub(crate) fn embed_hover(&mut self, url: String, over: bool, cx: &mut Context<Self>) {
        self.link_hover.embed_generation += 1;
        if !over || !self.link_previews || self.link_hover.embeds.contains_key(&url) {
            return;
        }
        let generation = self.link_hover.embed_generation;
        let previews = self.link_hover.previews.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(HOVER_MS)).await;
            let still = this.update(cx, |this, _| this.link_hover.embed_generation == generation && this.link_previews).unwrap_or(false);
            if !still {
                return;
            }
            let card = match previews.lookup(&url) {
                Lookup::Ready(v) => v,
                Lookup::Refused => None,
                Lookup::Fetch(key) => {
                    let p = previews.clone();
                    cx.background_executor().spawn(async move { p.fetch(&key) }).await
                }
            };
            let Some(card) = card else { return };
            let image = card.image.as_ref().and_then(|(bytes, ty)| image_of(bytes, ty));
            this.update(cx, |this, cx| {
                if this.link_hover.embed_generation == generation {
                    this.link_hover.embeds.insert(url, (card.title.clone(), image));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
}

fn image_of(bytes: &[u8], ty: &str) -> Option<Arc<Image>> {
    let fmt = match ty {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        _ => return None,
    };
    Some(Arc::new(Image::from_bytes(fmt, bytes.to_vec())))
}

fn url_host(u: &str) -> String {
    let rest = u.split_once("://").map(|(_, r)| r).unwrap_or(u);
    rest.split(['/', '?', '#']).next().unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::{place, url_host};
    use gpui_kit::{point, px, size, Bounds};

    #[test]
    fn placement_like_the_web_card() {
        let win = size(px(1280.), px(820.));
        let link = Bounds::new(point(px(100.), px(300.)), size(px(60.), px(18.)));
        let (p, below) = place(link, win);
        assert!(below);
        assert_eq!((f32::from(p.x), f32::from(p.y)), (100., 326.));
        // Near the bottom: above the link.
        let low = Bounds::new(point(px(1200.), px(700.)), size(px(60.), px(18.)));
        let (p, below) = place(low, win);
        assert!(!below);
        assert_eq!((f32::from(p.x), f32::from(p.y)), (1280. - 320. - 8., 692.));
        assert_eq!(url_host("https://www.example.com/a?b"), "www.example.com");
    }
}
