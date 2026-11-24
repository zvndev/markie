//! Markie's dialogs as one layer over the window, the way Electron renders
//! them: a full-window scrim with a panel on it. Each dialog's look lives in
//! its own module (settings, palette, file_ops, history_dialog, strips,
//! shortcuts); this module owns which one is open, focus, Escape and the
//! click-outside-to-close behaviour they share.
//!
//! Drawing the dialogs here, instead of through GPUI Kit's dialog, is what
//! lets them match Electron's sizes and colours and open on the next frame.

use std::path::PathBuf;

use gpui_kit::component::WindowExt as _;
use gpui_kit::component::input::InputState;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::dialog_chrome::{self as chrome, Tokens};
use super::{Mode, Workspace};
use crate::actions::*;

/// The sections of Settings, in Electron's tab order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SettingsSection {
    Account,
    Appearance,
    Files,
    Advanced,
}

pub(super) enum Overlay {
    None,
    Settings { section: SettingsSection, colors_open: bool },
    Palette(super::palette::PaletteState),
    NewDocument { focused: usize },
    Shortcuts,
    History(super::history_dialog::HistoryState),
    Rename { path: PathBuf, input: Entity<InputState> },
    Trash { path: PathBuf },
    Move { from: PathBuf, to: PathBuf },
    /// The file changed on disk under unsaved edits. `confirming` is the
    /// destructive choice waiting for its second click.
    DiskConflict { confirming: Option<super::strips::Destructive> },
    /// "Import a text copy?" for an HTML file (`import_copy.rs`).
    ConvertDocument { path: PathBuf },
    /// "Both copies of … changed" (`cloud_strip.rs`, conflict-dialog.tsx).
    CloudConflict(super::cloud_strip::ConflictState),
    /// "Stop syncing this document to the cloud?" (library.tsx).
    StopSync { path: PathBuf },
}

impl Overlay {
    pub(super) fn is_open(&self) -> bool {
        !matches!(self, Overlay::None)
    }
}

pub(crate) struct Dialogs {
    pub(super) open: Overlay,
    pub(super) focus: FocusHandle,
    /// Where focus goes back to when the dialog closes.
    restore: Option<FocusHandle>,
}

impl Dialogs {
    pub(crate) fn new(cx: &mut App) -> Self {
        Self { open: Overlay::None, focus: cx.focus_handle(), restore: None }
    }
}

impl Workspace {
    pub(super) fn setting_or(&self, key: &str, default: &str) -> String {
        self.registry
            .as_ref()
            .and_then(|r| r.setting(key).ok().flatten())
            .unwrap_or_else(|| default.to_string())
    }

    /// The active template's tokens in the current light or dark mode.
    pub(super) fn tokens(&self, cx: &App) -> Tokens {
        Tokens::current(&self.setting_or("style_template", "markie"), cx)
    }

    /// Open `overlay`, replacing any dialog already open. The overlay layer
    /// takes focus unless the dialog focuses a field of its own.
    pub(super) fn show_dialog(&mut self, overlay: Overlay, window: &mut Window, cx: &mut Context<Self>) {
        if !self.dialogs.open.is_open() {
            self.dialogs.restore = window.focused(cx);
        }
        let field = match &overlay {
            Overlay::Palette(p) => Some(p.input.read(cx).focus_handle(cx)),
            Overlay::Rename { input, .. } => Some(input.read(cx).focus_handle(cx)),
            _ => None,
        };
        self.dialogs.open = overlay;
        match field {
            Some(handle) => handle.focus(window, cx),
            None => self.dialogs.focus.focus(window, cx),
        }
        cx.notify();
    }

    pub(super) fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.dialogs.open.is_open() {
            return;
        }
        // Escape and a click outside leave the style editor first, not Settings.
        if matches!(self.dialogs.open, Overlay::Settings { .. }) && self.appearance.style.editing {
            self.close_style_editor(cx);
            return;
        }
        self.dialogs.open = Overlay::None;
        match self.dialogs.restore.take() {
            Some(handle) => handle.focus(window, cx),
            None => self.focus_handle.focus(window, cx),
        }
        cx.notify();
    }

    /// Would a GPUI layer paint where a web view sits? A system web view is
    /// a native subview above everything GPUI draws, so the web views hide
    /// while one of these is open: a title-bar menu, Markie's dialogs and
    /// the palette, ⇧⌘F search, the share sheet, and GPUI Kit's dialogs
    /// and sheets (agents, shortcuts, sign-in). The document area also gives
    /// way to the Cloud and Vault pages and to a version preview.
    pub(super) fn web_views_covered(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        covered(&CoverState {
            title_menu: self.shell.menu.is_some(),
            dialog: self.dialogs.open.is_open(),
            search: self.shell.search_open,
            share: self.collab.share.is_some(),
            kit_layer: window.has_active_dialog(cx) || window.has_active_sheet(cx),
            page_replaced: self.workspace_page_open() || self.viewing_version.is_some(),
        })
    }

    /// The dialog layer, drawn over the whole window. Workspace::render adds
    /// it last so it paints above everything.
    pub(super) fn render_dialogs(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.dialogs.open.is_open() {
            return None;
        }
        let t = self.tokens(cx);
        let (panel, top_anchored, strong) = match &self.dialogs.open {
            Overlay::None => return None,
            Overlay::Settings { section, colors_open } => (self.render_settings(*section, *colors_open, &t, window, cx), false, false),
            Overlay::Palette(_) => (self.render_palette(&t, cx), true, false),
            Overlay::NewDocument { .. } => (self.render_new_document(&t, window, cx), false, false),
            Overlay::Shortcuts => (self.render_shortcuts(&t, window, cx), false, false),
            Overlay::History(_) => (self.render_history_dialog(&t, window, cx), false, true),
            Overlay::Rename { .. } => (self.render_rename(&t, cx), false, true),
            Overlay::Trash { .. } => (self.render_trash(&t, cx), false, true),
            Overlay::Move { .. } => (self.render_move(&t, cx), false, true),
            Overlay::DiskConflict { .. } => (self.render_disk_conflict(&t, cx), false, false),
            Overlay::ConvertDocument { .. } => (self.render_convert_dialog(&t, cx), false, true),
            Overlay::CloudConflict(_) => (self.render_cloud_conflict(&t, cx), false, false),
            Overlay::StopSync { .. } => (self.render_stop_sync(&t, cx), false, true),
        };
        Some(
            div()
                .id("markie-dialogs")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .occlude()
                .track_focus(&self.dialogs.focus)
                .key_context("MarkieDialog")
                .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                    if this.dialog_key(&ev.keystroke, window, cx) {
                        cx.stop_propagation();
                    }
                }))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, window, cx| {
                        // Only a press on the scrim itself lands here: every
                        // panel stops its own presses. The stop-syncing
                        // confirm has no click-outside, and the conflict
                        // dialog ignores it while a choice runs.
                        match &this.dialogs.open {
                            Overlay::StopSync { .. } => {}
                            Overlay::CloudConflict(c) if c.busy => {}
                            _ => this.close_dialog(window, cx),
                        }
                    }),
                )
                .bg(if strong { t.scrim_strong() } else { t.scrim() })
                .flex()
                .justify_center()
                .when_else(top_anchored, |el| el.items_start().pt(px(96.)), |el| el.items_center().p_4())
                .child(panel)
                .into_any_element(),
        )
    }

    /// Escape, and the keys a dialog handles itself. True when handled.
    fn dialog_key(&mut self, key: &Keystroke, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let plain = !key.modifiers.platform && !key.modifiers.control && !key.modifiers.alt;
        if key.key == "escape" && plain {
            // conflict-dialog.tsx ignores Escape while a choice is running.
            if !matches!(&self.dialogs.open, Overlay::CloudConflict(c) if c.busy) {
                self.close_dialog(window, cx);
            }
            return true;
        }
        match &self.dialogs.open {
            Overlay::Palette(_) if plain => self.palette_key(&key.key, window, cx),
            Overlay::NewDocument { .. } if plain => self.new_document_key(&key.key, window, cx),
            Overlay::Rename { .. } if key.key == "enter" && plain => {
                self.confirm_rename(window, cx);
                true
            }
            Overlay::Trash { .. } | Overlay::Move { .. } if key.key == "enter" && plain => {
                self.confirm_file_dialog(window, cx);
                true
            }
            // Return lands on Keep both, the choice that cannot lose anything.
            Overlay::CloudConflict(_) if key.key == "enter" && plain => {
                self.cloud_conflict_act(true, window, cx);
                true
            }
            _ => false,
        }
    }

    /// The actions behind the dialogs, registered on the workspace root.
    pub(super) fn dialog_actions(&self, root: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        root.on_action(cx.listener(|this, _: &ShowShortcuts, window, cx| {
            if matches!(this.dialogs.open, Overlay::Shortcuts) {
                this.close_dialog(window, cx);
            } else {
                this.show_dialog(Overlay::Shortcuts, window, cx);
            }
        }))
        .on_action(cx.listener(|_, _: &ShowAbout, _, cx| super::shortcuts::show_about(cx)))
        .on_action(cx.listener(|this, _: &RichMode, window, cx| this.set_mode(Mode::View, window, cx)))
        .on_action(cx.listener(|this, _: &SourceMode, window, cx| this.set_mode(Mode::Source, window, cx)))
        .on_action(cx.listener(|this, _: &SplitMode, window, cx| this.set_mode(Mode::Split, window, cx)))
        .on_action(cx.listener(|this, _: &MakeInteractive, window, cx| {
            if super::comments::nightly(this.registry.as_deref()) {
                this.make_interactive(window, cx);
            }
        }))
        .on_action(cx.listener(Self::on_move))
    }

    /// The panel every Electron overlay sits in: `.markie-overlay-panel`.
    pub(super) fn panel(&self, t: &Tokens, radius: f32) -> Div {
        div()
            .bg(t.panel_bg())
            .border_1()
            .border_color(t.panel_border())
            .rounded(px(radius))
            .shadow(t.panel_shadow())
            .text_color(t.foreground)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
    }

    /// `.markie-overlay-close`: a 24pt square with a muted ×.
    pub(super) fn close_button(&self, id: &'static str, t: &Tokens, cx: &mut Context<Self>) -> Stateful<Div> {
        let hover = t.hover();
        div()
            .id(id)
            .size(px(24.))
            .flex_none()
            .rounded(px(6.))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(move |el| el.bg(hover))
            .child(chrome::stroke_icon(chrome::PATH_CLOSE, t.muted, 14., 2.))
            .on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx)))
    }
}

/// What can sit over the document area this frame.
#[derive(Default, Clone, Copy)]
pub(super) struct CoverState {
    pub title_menu: bool,
    pub dialog: bool,
    pub search: bool,
    pub share: bool,
    pub kit_layer: bool,
    pub page_replaced: bool,
}

pub(super) fn covered(s: &CoverState) -> bool {
    s.title_menu || s.dialog || s.search || s.share || s.kit_layer || s.page_replaced
}

#[cfg(test)]
mod cover_tests {
    use super::{CoverState, covered};

    #[test]
    fn any_overlay_hides_the_web_views() {
        assert!(!covered(&CoverState::default()));
        for s in [
            CoverState { title_menu: true, ..Default::default() },
            CoverState { dialog: true, ..Default::default() },
            CoverState { search: true, ..Default::default() },
            CoverState { share: true, ..Default::default() },
            CoverState { kit_layer: true, ..Default::default() },
            CoverState { page_replaced: true, ..Default::default() },
        ] {
            assert!(covered(&s));
        }
    }
}
