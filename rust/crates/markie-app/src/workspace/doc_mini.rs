//! The live miniature on a Markdown card, and how a card's preview scrolls.
//!
//! A Markdown card shows the start of the document drawn by the reader
//! itself: a [`RichView`] in thumbnail mode (`sample` plus `thumbnail`), read
//! only, in the page's own theme, template and Markdown style, at a small
//! zoom. It is fed the head of the file (`Preview::head`, read off the main
//! thread by `doc_preview.rs`), so it never holds more than about two pages.
//!
//! - [`MiniPool`] keeps a bounded number of those views, by card. The grid
//!   asks for one only for a card on screen or about to be, and the least
//!   recently drawn go once the pool is full, so a page of 200 documents
//!   holds a few dozen at most.
//! - [`max_scroll`] says how far a preview scrolls: to the end of the drawn
//!   page or two pages in, whichever comes first.
//! - [`Latch`] decides, wheel event by wheel event, whether the page or a
//!   card's preview moves. A gesture belongs to what it started over: one
//!   that starts over the page keeps scrolling the page across cards, and one
//!   that starts over a preview stays with it. At a preview's end a gesture
//!   that keeps pushing is handed back to the page.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use super::doc_preview::Preview;

use gpui_kit::{App, AppContext as _, Entity, Hitbox, Pixels, SharedString, Size, TouchPhase, Window};
use markie_editor::RichView;
use markie_editor::style::DocStyle;

/// The document's own small margin inside a card: top and bottom, then the
/// sides, in px. The top clears the type chip pinned in the corner, so the
/// title is never under it.
pub const PAD: (f32, f32) = (31., 12.);
/// A page is a sheet of US Letter as wide as the card.
pub const PAGE_RATIO: f32 = 11. / 8.5;
/// How much of the document a card holds.
pub const PAGES: f32 = 2.;
/// Live views kept at once. A wide window shows about 18 cards; this is
/// that, a screen of them either way, and a few to spare.
pub const MAX_LIVE: usize = 48;
/// New views made in one frame. Opening a page of cards makes them over a
/// few frames rather than in one long one; the rest show a blank page for
/// those frames.
pub const NEW_PER_FRAME: usize = 6;

/// The zoom a card of this width draws the document at: small enough that
/// the page keeps its shape, large enough that headings read.
pub fn zoom_for(card_w: f32) -> f32 {
    (card_w / 560.).clamp(0.32, 0.44)
}

/// The tallest the drawn part of a document gets on a card this wide.
pub fn extent_cap(card_w: f32) -> f32 {
    PAGES * PAGE_RATIO * card_w
}

/// How far a preview `view_h` tall scrolls, for a page drawn `content_h`
/// tall on a card `card_w` wide: to the end of the page or two pages in.
pub fn max_scroll(content_h: f32, card_w: f32, view_h: f32) -> f32 {
    (content_h.min(extent_cap(card_w)) - view_h).max(0.)
}

// ------------------------------------------------------------------ pool

struct Live {
    /// The preview it draws: a new version of the document is a new one.
    preview: Arc<Preview>,
    view: Entity<RichView>,
    /// The frame this card was last drawn on.
    used: u64,
    zoom: f32,
}

/// The live views, by card id.
#[derive(Default)]
pub struct MiniPool {
    views: HashMap<SharedString, Live>,
    frame: u64,
    /// Views made this frame, and whether a card went without one for it.
    made: usize,
    owed: bool,
}

impl MiniPool {
    /// The view for a card, made once per version of its document (each
    /// version is its own `preview`). `head` is the start of the file,
    /// `base_dir` resolves its relative pictures.
    #[allow(clippy::too_many_arguments)]
    pub fn view(&mut self, id: &SharedString, preview: &Arc<Preview>, head: &str, base_dir: Option<PathBuf>, zoom: f32, size: Size<Pixels>, offset: f32, style: &DocStyle, cx: &mut App) -> Option<Entity<RichView>> {
        let frame = self.frame;
        if let Some(live) = self.views.get_mut(id).filter(|l| Arc::ptr_eq(&l.preview, preview)) {
            live.used = frame;
            let view = live.view.clone();
            let rezoom = (live.zoom - zoom).abs() > 0.001;
            live.zoom = zoom;
            // Only a change redraws: an unchanged view keeps its last frame.
            let (restyle, resize) = {
                let r = view.read(cx);
                (r.style != *style, r.thumbnail != Some(size) || r.thumb_offset != offset)
            };
            if rezoom || restyle || resize {
                view.update(cx, |r, cx| {
                    if rezoom {
                        r.set_appearance(zoom, 0., cx);
                    }
                    r.set_style(style.clone(), cx);
                    r.set_thumbnail(size, offset, cx);
                });
            }
            return Some(view);
        }
        if self.made >= NEW_PER_FRAME {
            self.owed = true;
            return None;
        }
        self.made += 1;
        let style = style.clone();
        let view = cx.new(|cx| {
            let mut r = RichView::new(cx);
            r.read_only = true;
            r.sample = Some(PAD);
            r.thumbnail = Some(size);
            r.thumb_offset = offset;
            r.link_previews = false;
            r.set_appearance(zoom, 0., cx);
            r.set_style(style, cx);
            r.load(head, base_dir, cx);
            r
        });
        self.views.insert(id.clone(), Live { preview: preview.clone(), view: view.clone(), used: frame, zoom });
        self.trim();
        Some(view)
    }

    /// How tall a card's page was last drawn, in px. None before its view
    /// has drawn once.
    pub fn content_height(&self, id: &SharedString, cx: &App) -> Option<f32> {
        let h = self.views.get(id)?.view.read(cx).content_height();
        (h > 0.).then_some(h)
    }

    /// Call once a frame, before the cards ask for views.
    pub fn begin_frame(&mut self) {
        self.frame += 1;
        self.made = 0;
        self.owed = false;
    }

    /// A card went without its view this frame: draw another.
    pub fn owed(&self) -> bool {
        self.owed
    }

    /// Drop the least recently drawn views past [`MAX_LIVE`]. A view drawn
    /// this frame is never dropped.
    fn trim(&mut self) {
        if self.views.len() <= MAX_LIVE {
            return;
        }
        let mut by_age: Vec<(u64, SharedString)> = self.views.iter().filter(|(_, l)| l.used < self.frame).map(|(id, l)| (l.used, id.clone())).collect();
        by_age.sort();
        for (_, id) in by_age.into_iter().take(self.views.len() - MAX_LIVE) {
            self.views.remove(&id);
        }
    }

    /// Forget one card's view: its document became private.
    pub fn forget(&mut self, id: &str) {
        self.views.retain(|key, _| key.as_ref() != id);
    }

    /// Forget every view: the documents they drew may be anyone's now.
    pub fn clear(&mut self) {
        self.views.clear();
    }

    #[cfg(feature = "scene")]
    pub fn len(&self) -> usize {
        self.views.len()
    }
}

// --------------------------------------------------------------- scrolling

/// What a gesture moves.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Page,
    Card(SharedString),
}

/// Where a wheel event goes: the page (nothing is done here, the page's own
/// scroll takes it), or a card's preview, to this offset.
#[derive(Clone, Debug, PartialEq)]
pub enum Route {
    Page,
    Card(SharedString, f32),
}

/// One wheel event, as the latch reads it.
#[derive(Clone, Copy, Debug)]
pub struct Wheel {
    /// Vertical movement in px, as GPUI gives it: positive moves the content
    /// down (toward the top of the document).
    pub dy: f32,
    pub phase: TouchPhase,
    /// A trackpad (or another device with exact deltas), not wheel notches.
    pub precise: bool,
    pub now_ms: f64,
}

/// A pause longer than this between wheel events starts a new gesture. A
/// trackpad says when a gesture starts; a mouse wheel does not.
pub const GESTURE_GAP_MS: f64 = 400.;
/// How far a trackpad gesture pushes past a preview's end before the page
/// takes over: enough that a flick to the bottom does not jolt the page, a
/// little more and it moves.
pub const HAND_OFF_PX: f32 = 36.;

/// Which of the page and the previews a gesture is latched to.
#[derive(Debug, Default)]
pub struct Latch {
    target: Option<Target>,
    last_ms: f64,
    /// The fingers lifted: what follows is momentum.
    lifted: bool,
    /// How far the gesture has pushed past a preview's end.
    push: f32,
}

impl Latch {
    /// Route one wheel event. `over` is the card whose preview is under the
    /// pointer; `extent` gives a card's offset and how far it scrolls.
    pub fn route(&mut self, w: Wheel, over: Option<&SharedString>, extent: impl Fn(&SharedString) -> Option<(f32, f32)>) -> Route {
        if w.phase == TouchPhase::Started || w.now_ms - self.last_ms > GESTURE_GAP_MS {
            self.target = None;
            self.lifted = false;
            self.push = 0.;
        }
        self.last_ms = w.now_ms;
        if matches!(w.phase, TouchPhase::Ended | TouchPhase::Cancelled) {
            self.lifted = true;
        }
        let moves = |(offset, max): (f32, f32)| (offset - w.dy).clamp(0., max) != offset;
        if w.dy == 0. {
            // Nothing to move. A preview that holds the gesture keeps it.
            return match &self.target {
                Some(Target::Card(id)) => extent(id).map_or(Route::Page, |(offset, _)| Route::Card(id.clone(), offset)),
                _ => Route::Page,
            };
        }
        if self.target.is_none() {
            // The first movement decides: a preview that can move this way
            // takes the gesture; anything else is the page's.
            self.target = Some(match over.and_then(|id| extent(id).map(|e| (id, e))) {
                Some((id, e)) if moves(e) => Target::Card(id.clone()),
                _ => Target::Page,
            });
        }
        let Some(Target::Card(id)) = self.target.clone() else { return Route::Page };
        let Some((offset, max)) = extent(&id) else {
            // The card is gone (filtered out, scrolled off and dropped).
            self.target = Some(Target::Page);
            return Route::Page;
        };
        let next = (offset - w.dy).clamp(0., max);
        if next != offset {
            self.push = 0.;
            return Route::Card(id, next);
        }
        // At the end it is pushed past. Wheel notches hand over at once; a
        // trackpad after a short push, and never in momentum, so a flick
        // that runs out at the end does not launch the page.
        self.push += w.dy.abs();
        if !self.lifted && (!w.precise || self.push >= HAND_OFF_PX) {
            self.target = Some(Target::Page);
            return Route::Page;
        }
        Route::Card(id, offset)
    }

    /// What the gesture under way is latched to, if anything.
    #[cfg(test)]
    pub fn target(&self) -> Option<&Target> {
        self.target.as_ref()
    }
}

/// A card whose preview scrolls, as last laid out.
#[derive(Clone, Debug)]
pub struct Scrollable {
    /// Where its preview is: a wheel over it, and over nothing drawn above
    /// it (a menu), is over the card.
    pub hitbox: Option<Hitbox>,
    pub max: f32,
}

/// What the grid keeps for its previews between frames: where each one is,
/// how far it is scrolled, and the latch.
#[derive(Debug, Default)]
pub struct Scrolls {
    pub latch: Latch,
    /// The previews that scroll, as last laid out.
    pub cards: HashMap<SharedString, Scrollable>,
    /// How far each preview is scrolled, in px from the top.
    pub offsets: HashMap<SharedString, f32>,
}

impl Scrolls {
    pub fn offset(&self, id: &SharedString) -> f32 {
        self.offsets.get(id).copied().unwrap_or(0.)
    }

    /// The card whose preview the pointer is over, as the last frame laid out.
    pub fn over(&self, window: &Window) -> Option<SharedString> {
        self.cards.iter().find(|(_, c)| c.hitbox.as_ref().is_some_and(|h| h.should_handle_scroll(window))).map(|(id, _)| id.clone())
    }

    /// Route a wheel event, the pointer over `over`'s preview.
    pub fn route(&mut self, w: Wheel, over: Option<SharedString>) -> Route {
        let Scrolls { latch, cards, offsets } = self;
        let route = latch.route(w, over.as_ref(), |id| cards.get(id).map(|c| (offsets.get(id).copied().unwrap_or(0.).min(c.max), c.max)));
        if let Route::Card(id, y) = &route {
            offsets.insert(id.clone(), *y);
        }
        route
    }
}

#[cfg(test)]
mod tests {
    use super::{GESTURE_GAP_MS, HAND_OFF_PX, Latch, PAGE_RATIO, Route, Target, Wheel, extent_cap, max_scroll, zoom_for};
    use gpui_kit::{SharedString, TouchPhase};
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[test]
    fn a_preview_scrolls_to_the_end_of_the_page_or_two_pages_in() {
        // A short note: nothing to scroll.
        assert_eq!(max_scroll(120., 200., 150.), 0.);
        // A page and a bit: to its end.
        assert_eq!(max_scroll(300., 200., 150.), 150.);
        // A long document stops two pages in.
        let cap = 2. * PAGE_RATIO * 200.;
        assert_eq!(extent_cap(200.), cap);
        assert_eq!(max_scroll(10_000., 200., 150.), cap - 150.);
        // A wider card holds a longer stretch of the same document.
        assert!(max_scroll(10_000., 300., 150.) > max_scroll(10_000., 200., 150.));
        // Not measured yet.
        assert_eq!(max_scroll(0., 200., 150.), 0.);
    }

    #[test]
    fn the_zoom_follows_the_card_within_bounds() {
        assert_eq!(zoom_for(100.), 0.32);
        assert_eq!(zoom_for(10_000.), 0.44);
        assert!(zoom_for(200.) <= zoom_for(240.));
    }

    /// Two cards, "a" and "b", each scrolling 100 px, and a clock.
    struct Rig {
        latch: Latch,
        offsets: RefCell<HashMap<SharedString, f32>>,
        now: f64,
    }

    impl Rig {
        fn new() -> Self {
            Self { latch: Latch::default(), offsets: RefCell::new(HashMap::from([("a".into(), 0.), ("b".into(), 0.)])), now: 1_000. }
        }

        fn send(&mut self, dy: f32, phase: TouchPhase, over: Option<&str>) -> Route {
            self.now += 16.;
            let over = over.map(|s| SharedString::from(s.to_string()));
            let offsets = self.offsets.borrow().clone();
            let route = self.latch.route(Wheel { dy, phase, precise: true, now_ms: self.now }, over.as_ref(), |id| offsets.get(id).map(|o| (*o, 100.)));
            if let Route::Card(id, y) = &route {
                self.offsets.borrow_mut().insert(id.clone(), *y);
            }
            route
        }

        fn wheel(&mut self, dy: f32, over: Option<&str>) -> Route {
            self.now += 60.;
            let over = over.map(|s| SharedString::from(s.to_string()));
            let offsets = self.offsets.borrow().clone();
            let route = self.latch.route(Wheel { dy, phase: TouchPhase::Moved, precise: false, now_ms: self.now }, over.as_ref(), |id| offsets.get(id).map(|o| (*o, 100.)));
            if let Route::Card(id, y) = &route {
                self.offsets.borrow_mut().insert(id.clone(), *y);
            }
            route
        }

        fn at(&self, id: &str) -> f32 {
            self.offsets.borrow()[&SharedString::from(id.to_string())]
        }
    }

    fn card(id: &str, y: f32) -> Route {
        Route::Card(id.to_string().into(), y)
    }

    #[test]
    fn a_gesture_that_starts_over_the_page_keeps_scrolling_the_page_across_cards() {
        let mut r = Rig::new();
        assert_eq!(r.send(0., TouchPhase::Started, None), Route::Page);
        assert_eq!(r.send(-20., TouchPhase::Moved, None), Route::Page);
        // The pointer crosses a card mid-gesture: still the page.
        assert_eq!(r.send(-20., TouchPhase::Moved, Some("a")), Route::Page);
        assert_eq!(r.send(-20., TouchPhase::Ended, Some("a")), Route::Page);
        // Momentum over another card: the page.
        assert_eq!(r.send(-12., TouchPhase::Moved, Some("b")), Route::Page);
        assert_eq!((r.at("a"), r.at("b")), (0., 0.));
    }

    #[test]
    fn a_gesture_that_starts_over_a_preview_stays_with_it() {
        let mut r = Rig::new();
        r.send(0., TouchPhase::Started, Some("a"));
        assert_eq!(r.send(-30., TouchPhase::Moved, Some("a")), card("a", 30.));
        // The pointer drifts onto the page and another card: still card a.
        assert_eq!(r.send(-30., TouchPhase::Moved, None), card("a", 60.));
        assert_eq!(r.send(-10., TouchPhase::Moved, Some("b")), card("a", 70.));
        assert_eq!(r.at("b"), 0.);
        // Back up.
        assert_eq!(r.send(40., TouchPhase::Moved, Some("a")), card("a", 30.));
    }

    #[test]
    fn at_its_end_a_preview_hands_a_pushing_gesture_back_to_the_page() {
        let mut r = Rig::new();
        r.send(0., TouchPhase::Started, Some("a"));
        assert_eq!(r.send(-90., TouchPhase::Moved, Some("a")), card("a", 90.));
        assert_eq!(r.send(-20., TouchPhase::Moved, Some("a")), card("a", 100.), "clamped at the end");
        // A short push holds; past the hand-off the page takes over for good.
        assert_eq!(r.send(-(HAND_OFF_PX - 10.), TouchPhase::Moved, Some("a")), card("a", 100.));
        assert_eq!(r.send(-20., TouchPhase::Moved, Some("a")), Route::Page);
        assert_eq!(r.send(30., TouchPhase::Moved, Some("a")), Route::Page, "the rest of the gesture is the page's");
        assert_eq!(r.latch.target(), Some(&Target::Page));
    }

    #[test]
    fn momentum_that_runs_out_at_the_end_never_launches_the_page() {
        let mut r = Rig::new();
        r.send(0., TouchPhase::Started, Some("a"));
        r.send(-60., TouchPhase::Moved, Some("a"));
        r.send(-20., TouchPhase::Ended, Some("a"));
        // The flick carries on past the end in momentum: held by the card.
        for _ in 0..10 {
            assert_eq!(r.send(-40., TouchPhase::Moved, Some("a")), card("a", 100.));
        }
    }

    #[test]
    fn a_new_gesture_at_a_previews_end_goes_straight_to_the_page() {
        let mut r = Rig::new();
        r.offsets.borrow_mut().insert("a".into(), 100.);
        r.send(0., TouchPhase::Started, Some("a"));
        assert_eq!(r.send(-10., TouchPhase::Moved, Some("a")), Route::Page, "nothing further down");
        // The other way it can move, so a new gesture up takes the card.
        r.send(0., TouchPhase::Started, Some("a"));
        assert_eq!(r.send(10., TouchPhase::Moved, Some("a")), card("a", 90.));
        // And at the top, scrolling up is the page's.
        r.offsets.borrow_mut().insert("b".into(), 0.);
        r.send(0., TouchPhase::Started, Some("b"));
        assert_eq!(r.send(10., TouchPhase::Moved, Some("b")), Route::Page);
    }

    #[test]
    fn wheel_notches_latch_by_time_and_hand_over_at_once_at_the_end() {
        let mut r = Rig::new();
        // Notches close together over the page, then across a card: the page.
        assert_eq!(r.wheel(-40., None), Route::Page);
        assert_eq!(r.wheel(-40., Some("a")), Route::Page);
        // A pause: a new gesture, which the card under the pointer takes.
        r.now += GESTURE_GAP_MS + 1.;
        assert_eq!(r.wheel(-40., Some("a")), card("a", 40.));
        assert_eq!(r.wheel(-40., Some("a")), card("a", 80.));
        assert_eq!(r.wheel(-40., Some("a")), card("a", 100.));
        // At the end the next notch is the page's.
        assert_eq!(r.wheel(-40., Some("a")), Route::Page);
    }

    #[test]
    fn a_card_that_goes_mid_gesture_gives_the_gesture_to_the_page() {
        let mut r = Rig::new();
        r.send(0., TouchPhase::Started, Some("a"));
        r.send(-10., TouchPhase::Moved, Some("a"));
        r.offsets.borrow_mut().remove(&SharedString::from("a"));
        assert_eq!(r.send(-10., TouchPhase::Moved, None), Route::Page);
    }

    #[test]
    fn sideways_and_empty_events_move_nothing() {
        let mut r = Rig::new();
        assert_eq!(r.send(0., TouchPhase::Started, Some("a")), Route::Page);
        assert_eq!(r.send(0., TouchPhase::Moved, Some("a")), Route::Page, "no decision until it moves");
        assert_eq!(r.send(-5., TouchPhase::Moved, Some("a")), card("a", 5.));
        assert_eq!(r.send(0., TouchPhase::Moved, None), card("a", 5.), "a held gesture stays held");
    }

    #[test]
    fn scrolls_keep_each_previews_offset() {
        let mut s = super::Scrolls::default();
        s.cards.insert("a".into(), super::Scrollable { hitbox: None, max: 50. });
        let a = || Some(SharedString::from("a"));
        let w = |dy: f32, phase| Wheel { dy, phase, precise: true, now_ms: 0. };
        s.route(w(0., TouchPhase::Started), a());
        assert_eq!(s.route(w(-20., TouchPhase::Moved), a()), card("a", 20.));
        assert_eq!(s.offset(&"a".into()), 20.);
        s.route(w(0., TouchPhase::Started), None);
        assert_eq!(s.route(w(-20., TouchPhase::Moved), None), Route::Page, "not over a preview");
        // A stored offset past a card's new end is read as its end.
        s.offsets.insert("a".into(), 80.);
        s.route(w(0., TouchPhase::Started), a());
        assert_eq!(s.route(w(5., TouchPhase::Moved), a()), card("a", 45.));
    }
}
