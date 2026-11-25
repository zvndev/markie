//! Back and Forward between places, per window, the way Safari steps
//! through pages and Finder through folders. Electron Markie has no such
//! history; this is a Markie RS improvement.
//!
//! What counts as a place:
//!
//! - A document with a file, by its path, however it was opened: Open,
//!   Recent, the Library, Browse, search, a link, a drop, a deep link or a
//!   synced cloud document. Word, CSV, PDF and the rest are places too.
//! - An untitled document. The draft journal keeps one untitled buffer, so
//!   the history keeps one untitled place, the newest; going back to it
//!   brings its journalled text back.
//! - A page that replaces the document area: Recent, Browse, Cloud, Live
//!   Docs and the Vault.
//!
//! Not places: panels beside the document (Library, Skills, Outline),
//! dialogs, the palette, ⇧⌘F search and the History page, which is a mode of
//! its document (Back leaves it). Opening the place already on screen adds
//! nothing. A new visit clears Forward. A place whose file was moved or
//! deleted outside Markie is skipped with a notice; a rename, move or Save As
//! inside Markie follows the file.
//!
//! Each place remembers its mode (Rich, Source or Split) and scroll, and
//! Back and Forward put them back.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::rail::LeftView;
use super::{DocKind, Mode, Workspace};

/// The most places one window remembers.
const MAX_PLACES: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PageKind {
    Recent,
    Browse,
    Cloud,
    LiveDocs,
    Vault,
}

impl PageKind {
    fn of(view: LeftView) -> Option<Self> {
        Some(match view {
            LeftView::Recent => PageKind::Recent,
            LeftView::Browse => PageKind::Browse,
            LeftView::Cloud => PageKind::Cloud,
            LeftView::LiveDocs => PageKind::LiveDocs,
            LeftView::Vault => PageKind::Vault,
            _ => return None,
        })
    }

    fn view(self) -> LeftView {
        match self {
            PageKind::Recent => LeftView::Recent,
            PageKind::Browse => LeftView::Browse,
            PageKind::Cloud => LeftView::Cloud,
            PageKind::LiveDocs => LeftView::LiveDocs,
            PageKind::Vault => LeftView::Vault,
        }
    }

    fn label(self) -> &'static str {
        match self {
            PageKind::Recent => "Recent",
            PageKind::Browse => "Browse",
            PageKind::Cloud => "Cloud",
            PageKind::LiveDocs => "Live Docs",
            PageKind::Vault => "Vault",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Place {
    Doc(PathBuf),
    /// The untitled buffer; `welcome` when it is the first-launch welcome.
    Untitled { name: String, welcome: bool },
    Page(PageKind),
}

impl Place {
    fn label(&self) -> String {
        match self {
            Place::Doc(path) => path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned()),
            Place::Untitled { name, .. } => name.clone(),
            Place::Page(kind) => kind.label().into(),
        }
    }
}

/// How a place was left: its mode and how far down it was scrolled.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct PlaceView {
    pub mode: Option<Mode>,
    /// The rich pane's scroll (View and Split), in px from the top.
    pub rich_y: f32,
    /// The source pane's scroll offset (Source and Split).
    pub source: (f32, f32),
}

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    place: Place,
    view: PlaceView,
}

/// Where a Back or Forward landed, and the places it skipped on the way.
#[derive(Debug, PartialEq)]
pub(super) struct Step {
    pub target: Option<(Place, PlaceView)>,
    pub skipped: Vec<Place>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct NavHistory {
    entries: Vec<Entry>,
    index: usize,
}

impl NavHistory {
    pub fn current(&self) -> Option<&Place> {
        self.entries.get(self.index).map(|e| &e.place)
    }

    pub fn can_back(&self) -> bool {
        !self.entries.is_empty() && self.index > 0
    }

    pub fn can_forward(&self) -> bool {
        self.index + 1 < self.entries.len()
    }

    /// A place was shown. The place already current adds nothing; anything
    /// else drops Forward and becomes the newest place. True when added.
    pub fn visit(&mut self, place: Place) -> bool {
        if self.current() == Some(&place) {
            return false;
        }
        if !self.entries.is_empty() {
            self.entries.truncate(self.index + 1);
        }
        // One untitled buffer at a time: the older untitled place is gone.
        if matches!(place, Place::Untitled { .. }) {
            self.entries.retain(|e| !matches!(e.place, Place::Untitled { .. }));
        }
        self.entries.push(Entry { place, view: PlaceView::default() });
        if self.entries.len() > MAX_PLACES {
            self.entries.remove(0);
        }
        self.index = self.entries.len() - 1;
        true
    }

    /// Remember how the current place looks now, if it is `place`.
    pub fn save_view(&mut self, place: &Place, view: PlaceView) {
        if let Some(e) = self.entries.get_mut(self.index).filter(|e| e.place == *place) {
            e.view = view;
        }
    }

    /// One step back or forward, past places that are no longer there
    /// (which are dropped). The index moves to the target.
    pub fn step(&mut self, back: bool, exists: impl Fn(&Place) -> bool) -> Step {
        let mut skipped = Vec::new();
        loop {
            let target = if back {
                if self.index == 0 || self.entries.is_empty() {
                    break Step { target: None, skipped };
                }
                self.index - 1
            } else {
                if self.index + 1 >= self.entries.len() {
                    break Step { target: None, skipped };
                }
                self.index + 1
            };
            if exists(&self.entries[target].place) {
                self.index = target;
                let e = &self.entries[target];
                break Step { target: Some((e.place.clone(), e.view)), skipped };
            }
            skipped.push(self.entries.remove(target).place);
            if back {
                self.index -= 1;
            }
        }
    }

    /// A file moved or was renamed inside Markie: every visit follows it.
    pub fn rename(&mut self, from: &Path, to: &Path) {
        for e in &mut self.entries {
            if let Place::Doc(p) = &mut e.place {
                if p == from {
                    *p = to.to_path_buf();
                }
            }
        }
        self.merge_neighbours();
    }

    /// The current place became `place` (an untitled buffer saved as a file).
    pub fn retarget_current(&mut self, place: Place) {
        if let Some(e) = self.entries.get_mut(self.index) {
            e.place = place;
        }
        self.merge_neighbours();
    }

    /// Drop every visit to `place` (one that could not be opened).
    pub fn forget(&mut self, place: &Place) {
        let mut kept = Vec::with_capacity(self.entries.len());
        let mut index = 0;
        for (i, e) in std::mem::take(&mut self.entries).into_iter().enumerate() {
            if e.place == *place {
                continue;
            }
            // The current place, or the last kept one before it.
            if i <= self.index {
                index = kept.len();
            }
            kept.push(e);
        }
        self.entries = kept;
        self.index = index;
    }

    /// Two visits in a row to one place read as one.
    fn merge_neighbours(&mut self) {
        let mut i = 1;
        while i < self.entries.len() {
            if self.entries[i].place == self.entries[i - 1].place {
                self.entries.remove(i);
                if self.index >= i {
                    self.index -= 1;
                }
            } else {
                i += 1;
            }
        }
    }
}

/// Is a place still there to go back to?
fn exists(place: &Place) -> bool {
    match place {
        Place::Doc(path) => path.exists(),
        Place::Untitled { .. } | Place::Page(_) => true,
    }
}

/// "“Notes.md” is no longer there, so Back skipped it."
pub(super) fn skipped_notice(skipped: &[Place], back: bool) -> Option<String> {
    let verb = if back { "Back" } else { "Forward" };
    match skipped {
        [] => None,
        [one] => Some(format!("\u{201C}{}\u{201D} is no longer there, so {verb} skipped it.", one.label())),
        many => Some(format!("{} places are no longer there, so {verb} skipped them.", many.len())),
    }
}

/// A scroll to put back once the document has laid out, tried for a few
/// frames: the rich view measures its blocks as they come near the screen.
pub(super) struct PendingView {
    place: Place,
    view: PlaceView,
    frames: u8,
}

impl Workspace {
    /// The place on screen now, if it is one.
    pub(super) fn current_place(&self) -> Option<Place> {
        if self.workspace_page_open() {
            return PageKind::of(self.shell.view).map(Place::Page);
        }
        let doc = self.doc.as_ref()?;
        if self.document_failure.is_some() {
            return None;
        }
        if doc.untitled {
            // An unsaved Word document lives in its recovery store, not the
            // journal, so there is nothing to bring back: not a place.
            let DocKind::Text { saved, .. } = &doc.kind else { return None };
            let welcome = saved == super::first_run::WELCOME_DOC;
            return Some(Place::Untitled { name: doc.path.to_string_lossy().into_owned(), welcome });
        }
        Some(Place::Doc(doc.path.clone()))
    }

    /// How the document looks now, to put back later.
    fn place_view(&self, cx: &App) -> PlaceView {
        let text = matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. }));
        let offset = self.editor.read(cx).scroll_offset();
        PlaceView {
            mode: text.then_some(self.mode),
            rich_y: self.rich.read(cx).scroll_y(),
            source: (f32::from(offset.x), f32::from(offset.y)),
        }
    }

    /// Keep the current place's mode and scroll before it is left.
    pub(super) fn nav_capture(&mut self, cx: &App) {
        if self.pending_view.is_some() || self.history_page_open() {
            return;
        }
        let Some(place) = self.current_place() else { return };
        if self.nav.current() == Some(&place) && !matches!(place, Place::Page(_)) {
            let view = self.place_view(cx);
            self.nav.save_view(&place, view);
        }
    }

    /// Once a frame: put back a place's view, then note a new place.
    pub(super) fn nav_sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_pending_view(window, cx);
        self.nav_capture(cx);
        if let Some(place) = self.current_place() {
            if self.nav.visit(place) {
                self.refresh_menus(cx);
            }
        }
    }

    fn apply_pending_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(mut pending) = self.pending_view.take() else { return };
        if self.current_place().as_ref() != Some(&pending.place) {
            return;
        }
        if let Some(mode) = pending.view.mode.filter(|m| *m != self.mode) {
            self.set_mode(mode, window, cx);
        }
        let (rich_y, (sx, sy)) = (pending.view.rich_y, pending.view.source);
        if rich_y > 0. {
            self.rich.update(cx, |r, cx| r.set_scroll_y(rich_y, cx));
        }
        if pending.frames == 3 && (sx != 0. || sy != 0.) {
            self.editor.update(cx, |s, cx| s.set_scroll_offset(point(px(sx), px(sy)), cx));
        }
        pending.frames = pending.frames.saturating_sub(1);
        if pending.frames > 0 {
            self.pending_view = Some(pending);
            window.request_animation_frame();
        }
    }

    pub(super) fn on_navigate_back(&mut self, _: &crate::actions::NavigateBack, window: &mut Window, cx: &mut Context<Self>) {
        self.navigate(true, window, cx);
    }

    pub(super) fn on_navigate_forward(&mut self, _: &crate::actions::NavigateForward, window: &mut Window, cx: &mut Context<Self>) {
        self.navigate(false, window, cx);
    }

    pub(super) fn can_navigate(&self, back: bool) -> bool {
        if back && self.history_page_open() {
            return true;
        }
        if back { self.nav.can_back() } else { self.nav.can_forward() }
    }

    /// Back (⌘[, the title bar, a mouse's back button) or Forward.
    pub(super) fn navigate(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        // On the History page, Back is its own Back: to the document.
        if self.history_page_open() {
            if back {
                self.close_history_page(window, cx);
            }
            return;
        }
        if self.dialogs.open.is_open() {
            return;
        }
        self.nav_capture(cx);
        let before = self.nav.clone();
        let step = self.nav.step(back, exists);
        if let Some(notice) = skipped_notice(&step.skipped, back) {
            window.push_notification(notice, cx);
        }
        let Some((place, view)) = step.target else {
            cx.notify();
            return;
        };
        if !self.leave_page_now(&place, window, cx) {
            // The Vault asks before it is left with unsaved edits: stay put.
            self.nav = before;
            return;
        }
        match &place {
            Place::Page(kind) => self.show_page(*kind, cx),
            Place::Doc(path) => {
                let loaded = self.doc.as_ref().is_some_and(|d| !d.untitled && d.path == *path) && self.document_failure.is_none();
                if !loaded {
                    self.open_path(path, window, cx);
                }
            }
            Place::Untitled { name, welcome } => {
                let here = self.doc.as_ref().is_some_and(|d| d.untitled && d.path.to_string_lossy() == name.as_str());
                if !here {
                    match self.drafts.read(&markie_core::drafts::Drafts::key_for(None)) {
                        Some(text) if !text.trim().is_empty() => self.open_untitled(name.clone(), text, window, cx),
                        _ if *welcome => self.open_welcome(window, cx),
                        _ => self.open_untitled(name.clone(), String::new(), window, cx),
                    }
                }
            }
        }
        if self.current_place().as_ref() != Some(&place) {
            // It could not be opened (the error is already on screen), or it
            // waits on a question: this visit is not a place to come back to.
            self.nav = before;
            self.nav.forget(&place);
        } else if !matches!(place, Place::Page(_)) {
            self.pending_view = Some(PendingView { place, view, frames: 3 });
        }
        self.refresh_menus(cx);
        cx.notify();
    }

    /// Take a full page down so a document shows, or swap one page for
    /// another. False when the Vault must ask first (it then asks).
    fn leave_page_now(&mut self, target: &Place, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.workspace_page_open() || matches!(target, Place::Page(k) if k.view() == self.shell.view) {
            return true;
        }
        if self.vault_open() {
            if self.vault.as_ref().is_some_and(|p| p.read(cx).has_unsaved()) {
                self.close_vault(window, cx);
                return false;
            }
            if let Some(page) = self.vault.clone() {
                page.update(cx, |p, cx| p.lock_now("", window, cx));
            }
        }
        self.shell.panel_open = false;
        self.shell.page_focus_owed = true;
        true
    }

    /// Show a full page, as its rail button does, without closing it when
    /// it is already up.
    fn show_page(&mut self, kind: PageKind, cx: &mut Context<Self>) {
        if !(self.shell.panel_open && self.shell.view == kind.view()) {
            self.select_view(kind.view(), cx);
        }
    }

    /// A file of this window moved inside Markie (rename, move, Save As).
    pub(super) fn nav_follow(&mut self, from: &Path, to: &Path) {
        self.nav.rename(from, to);
    }

    /// The untitled buffer became a file.
    pub(super) fn nav_saved_untitled(&mut self, path: &Path) {
        if matches!(self.nav.current(), Some(Place::Untitled { .. })) {
            self.nav.retarget_current(Place::Doc(path.to_path_buf()));
        }
    }

    /// The title bar's Back and Forward: the same size, colours and hover as
    /// its other icon buttons, dimmed and inert with nowhere to go.
    pub(super) fn render_nav_buttons(&self, p: &crate::themes::Palette, cx: &mut Context<Self>) -> AnyElement {
        let button = |id: &'static str, glyph: &'static str, label: &'static str, tip: &'static str, back: bool, cx: &mut Context<Self>| {
            let enabled = self.can_navigate(back);
            let (fg, fill) = (p.foreground, super::chrome::hover_fill(p));
            super::chrome::no_drag(
                div()
                    .id(id)
                    .group(id)
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(28.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(transparent_black())
                    .role(Role::Button)
                    .aria_label(label)
                    .aria_keyshortcuts(if back { "Meta+[" } else { "Meta+]" })
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip).build(window, cx))
                    .when_else(
                        enabled,
                        |el| {
                            el.hover(|s| s.bg(fill).border_color(p.fg(0.07)))
                                .child(super::chrome::icon(glyph, 16., p.muted).group_hover(id, |s| s.text_color(fg)))
                                .on_click(cx.listener(move |this, _, window, cx| this.navigate(back, window, cx)))
                        },
                        |el| el.child(super::chrome::icon(glyph, 16., p.muted.opacity(0.35))),
                    ),
            )
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(2.))
            .child(button("tb-back", "markie/nav-back.svg", "Back", "Back (⌘[)", true, cx))
            .child(button("tb-forward", "markie/nav-forward.svg", "Forward", "Forward (⌘])", false, cx))
            .into_any_element()
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// The title bar's Back and Forward over real places: `open` (files,
    /// or "recent" for the Recent page) visited in order after the file on
    /// the command line, then `back` presses of Back.
    pub(super) fn scene_nav(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use serde_json::Value;
        let opens: Vec<String> = args.get("open").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        let backs = args.get("back").and_then(Value::as_u64).unwrap_or(0) as usize;
        if self.doc.is_none() {
            return false;
        }
        // One place a step, with a frame between, as a person would.
        if *step < opens.len() {
            match opens[*step].as_str() {
                "recent" => self.show_page(PageKind::Recent, cx),
                path => self.open_path(Path::new(path), window, cx),
            }
            *step += 1;
            return false;
        }
        if *step < opens.len() + backs {
            self.navigate(true, window, cx);
            *step += 1;
            return false;
        }
        *step += 1;
        *step > opens.len() + backs + 4
    }
}

#[cfg(test)]
mod tests {
    use super::{NavHistory, PageKind, Place, PlaceView, skipped_notice};
    use crate::workspace::Mode;
    use std::path::PathBuf;

    fn doc(name: &str) -> Place {
        Place::Doc(PathBuf::from(format!("/notes/{name}")))
    }

    fn untitled() -> Place {
        Place::Untitled { name: "Untitled.md".into(), welcome: false }
    }

    fn all(_: &Place) -> bool {
        true
    }

    #[test]
    fn back_and_forward_walk_the_places_and_a_new_visit_clears_forward() {
        let mut h = NavHistory::default();
        assert!(!h.can_back() && !h.can_forward(), "the window's first place has nowhere to go");
        h.visit(doc("a.md"));
        assert!(!h.can_back(), "the first place is the start");
        h.visit(Place::Page(PageKind::Recent));
        h.visit(doc("b.md"));
        assert_eq!(h.step(true, all).target.map(|t| t.0), Some(Place::Page(PageKind::Recent)));
        assert_eq!(h.step(true, all).target.map(|t| t.0), Some(doc("a.md")));
        assert_eq!(h.step(true, all).target, None);
        assert!(h.can_forward());
        assert_eq!(h.step(false, all).target.map(|t| t.0), Some(Place::Page(PageKind::Recent)));
        // A new place from the middle drops Forward.
        assert!(h.visit(doc("c.md")));
        assert!(!h.can_forward());
        assert_eq!(h.step(true, all).target.map(|t| t.0), Some(Place::Page(PageKind::Recent)));
    }

    #[test]
    fn the_place_on_screen_again_is_not_a_new_step() {
        let mut h = NavHistory::default();
        assert!(h.visit(doc("a.md")));
        assert!(!h.visit(doc("a.md")));
        h.visit(doc("b.md"));
        // Back lands on a, which the window then reports as on screen.
        h.step(true, all);
        assert!(!h.visit(doc("a.md")), "arriving by Back is not a visit");
        assert!(h.can_forward(), "so Forward is kept");
    }

    #[test]
    fn a_moved_or_deleted_place_is_skipped_and_dropped() {
        let mut h = NavHistory::default();
        for name in ["a.md", "gone.md", "b.md"] {
            h.visit(doc(name));
        }
        let step = h.step(true, |p| *p != doc("gone.md"));
        assert_eq!(step.target.map(|t| t.0), Some(doc("a.md")));
        assert_eq!(step.skipped, [doc("gone.md")]);
        assert_eq!(h.step(false, all).target.map(|t| t.0), Some(doc("b.md")), "Forward no longer stops there");
        // Nothing left that exists: stay put.
        let mut h = NavHistory::default();
        h.visit(doc("gone.md"));
        h.visit(doc("b.md"));
        let step = h.step(true, |p| *p != doc("gone.md"));
        assert_eq!(step.target, None);
        assert_eq!(h.current(), Some(&doc("b.md")));
        assert!(!h.can_back());
        assert_eq!(skipped_notice(&step.skipped, true).as_deref(), Some("\u{201C}gone.md\u{201D} is no longer there, so Back skipped it."));
    }

    #[test]
    fn each_place_keeps_its_mode_and_scroll() {
        let mut h = NavHistory::default();
        h.visit(doc("a.md"));
        let view = PlaceView { mode: Some(Mode::Source), rich_y: 0., source: (0., -420.) };
        h.save_view(&doc("a.md"), view);
        h.save_view(&doc("other.md"), PlaceView::default());
        h.visit(doc("b.md"));
        assert_eq!(h.step(true, all).target, Some((doc("a.md"), view)));
    }

    #[test]
    fn one_untitled_place_at_a_time_and_save_as_follows_it() {
        let mut h = NavHistory::default();
        h.visit(untitled());
        h.visit(doc("a.md"));
        h.visit(Place::Untitled { name: "Untitled.txt".into(), welcome: false });
        h.step(true, all);
        assert_eq!(h.current(), Some(&doc("a.md")), "the older untitled place is gone");
        assert!(!h.can_back());
        h.step(false, all);
        h.retarget_current(doc("saved.txt"));
        assert_eq!(h.current(), Some(&doc("saved.txt")));
    }

    #[test]
    fn a_rename_follows_the_file_and_merges_repeats() {
        let mut h = NavHistory::default();
        h.visit(doc("a.md"));
        h.visit(doc("b.md"));
        h.visit(doc("a.md"));
        h.rename(&PathBuf::from("/notes/b.md"), &PathBuf::from("/notes/a.md"));
        assert_eq!(h.current(), Some(&doc("a.md")));
        assert!(!h.can_back(), "a, a, a read as one place");
    }

    #[test]
    fn a_place_that_would_not_open_is_forgotten() {
        let mut h = NavHistory::default();
        h.visit(doc("a.md"));
        h.visit(doc("bad.md"));
        h.visit(doc("b.md"));
        h.forget(&doc("bad.md"));
        assert_eq!(h.current(), Some(&doc("b.md")));
        assert_eq!(h.step(true, all).target.map(|t| t.0), Some(doc("a.md")));
    }

    #[test]
    fn the_history_is_bounded() {
        let mut h = NavHistory::default();
        for i in 0..150 {
            h.visit(doc(&format!("{i}.md")));
        }
        let mut steps = 0;
        while h.step(true, all).target.is_some() {
            steps += 1;
        }
        assert_eq!(steps, super::MAX_PLACES - 1);
    }
}
