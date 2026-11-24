//! Menu items with no other home: Save As, Theme…, Default Apps, the window
//! items, and the menu bar's refresh. The Edit menu itself is
//! `source::edit_menu`, which sends each command to the focused editor.

use gpui_kit::*;

use super::overlay::{Overlay, SettingsSection};
use super::{DocKind, Workspace};
use crate::actions::*;

impl Workspace {
    pub(super) fn edit_menu_actions(d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        d.on_action(cx.listener(|this, _: &SaveAs, w, cx| this.save_as(w, cx)))
            .on_action(cx.listener(Self::on_show_theme))
            .on_action(cx.listener(|this, _: &DefaultApps, w, cx| this.open_settings(SettingsSection::Files, w, cx)))
            .on_action(cx.listener(|_, _: &MinimizeWindow, w, _| w.minimize_window()))
            .on_action(cx.listener(|_, _: &ZoomWindow, w, _| w.zoom_window()))
            .on_action(cx.listener(|_, _: &ToggleFullScreen, w, _| w.toggle_fullscreen()))
            .on_action(cx.listener(|_, _: &CloseWindow, w, _| w.remove_window()))
    }

    /// View > Theme… (`menu-theme`): Settings on Appearance, toggled.
    fn on_show_theme(&mut self, _: &ShowTheme, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.dialogs.open, Overlay::Settings { section: SettingsSection::Appearance, .. }) {
            self.close_dialog(window, cx);
        } else {
            self.open_settings(SettingsSection::Appearance, window, cx);
        }
    }

    /// The menu bar follows the open document (`refreshRevertMenuItem`).
    pub(super) fn refresh_menus(&mut self, cx: &mut Context<Self>) {
        let key = self.doc.as_ref().map(|d| (d.path.clone(), self.dirty));
        if self.menu_key == key {
            return;
        }
        self.menu_key = key;
        let has_history = match &self.doc {
            Some(doc) if doc.untitled => false,
            Some(doc) if matches!(doc.kind, DocKind::Office(_)) => !self.office_versions(&doc.path).is_empty(),
            Some(doc) => !self.history.list(&doc.path).is_empty(),
            None => false,
        };
        let nightly = super::comments::nightly(self.registry.as_deref());
        let word = matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(_)));
        crate::menus::install(crate::menus::MenuState { has_history, nightly, word, ..Default::default() }, cx);
    }
}
