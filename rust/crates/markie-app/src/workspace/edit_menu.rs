//! The Edit menu and the menu items that act on the window, the way
//! Electron's renderer handles `menu-undo`, `menu-redo` and `menu-find`:
//! the command goes to whichever editor has focus, since each keeps its own
//! history (`undoTargetFor` in page.tsx). A plain field gets its own.

use gpui_kit::component::input as field;
use gpui_kit::*;

use super::overlay::{Overlay, SettingsSection};
use super::{DocKind, Workspace};
use crate::actions::*;

actions!(markie_new, [NewMarkdownDocument, NewWordDocument, NewTextDocument, NewDarkmownDocument]);

/// Which editor an Edit command reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditTarget {
    Rich,
    Word,
    Field,
}

/// `undoTargetFor`: the rich editor when it holds focus, the Word page when
/// it holds focus (or nothing does while a Word, RTF or ODT document is
/// open), otherwise the focused field. The Source editor is a field.
pub(super) fn edit_target(rich_focused: bool, word_focused: bool, nothing_focused: bool, office_open: bool) -> EditTarget {
    if rich_focused {
        EditTarget::Rich
    } else if word_focused || (office_open && nothing_focused) {
        EditTarget::Word
    } else {
        EditTarget::Field
    }
}

#[derive(Clone, Copy)]
enum EditCommand {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

fn action_for(target: EditTarget, command: EditCommand) -> Box<dyn Action> {
    use EditCommand::*;
    use markie_office_view::actions as word;
    match (target, command) {
        (EditTarget::Rich, Undo) => Box::new(markie_editor::Undo),
        (EditTarget::Rich, Redo) => Box::new(markie_editor::Redo),
        (EditTarget::Rich, Cut) => Box::new(markie_editor::Cut),
        (EditTarget::Rich, Copy) => Box::new(markie_editor::Copy),
        (EditTarget::Rich, Paste) => Box::new(markie_editor::Paste),
        (EditTarget::Rich, SelectAll) => Box::new(markie_editor::SelectAll),
        (EditTarget::Word, Undo) => Box::new(word::WordUndo),
        (EditTarget::Word, Redo) => Box::new(word::WordRedo),
        (EditTarget::Word, Cut) => Box::new(word::WordCut),
        (EditTarget::Word, Copy) => Box::new(word::WordCopy),
        (EditTarget::Word, Paste) => Box::new(word::WordPaste),
        (EditTarget::Word, SelectAll) => Box::new(word::WordSelectAll),
        (EditTarget::Field, Undo) => Box::new(field::Undo),
        (EditTarget::Field, Redo) => Box::new(field::Redo),
        (EditTarget::Field, Cut) => Box::new(field::Cut),
        (EditTarget::Field, Copy) => Box::new(field::Copy),
        (EditTarget::Field, Paste) => Box::new(field::Paste),
        (EditTarget::Field, SelectAll) => Box::new(field::SelectAll),
    }
}

impl Workspace {
    pub(super) fn edit_menu_actions(d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        d.on_action(cx.listener(|this, _: &MenuUndo, w, cx| this.route_edit(EditCommand::Undo, w, cx)))
            .on_action(cx.listener(|this, _: &MenuRedo, w, cx| this.route_edit(EditCommand::Redo, w, cx)))
            .on_action(cx.listener(|this, _: &MenuCut, w, cx| this.route_edit(EditCommand::Cut, w, cx)))
            .on_action(cx.listener(|this, _: &MenuCopy, w, cx| this.route_edit(EditCommand::Copy, w, cx)))
            .on_action(cx.listener(|this, _: &MenuPaste, w, cx| this.route_edit(EditCommand::Paste, w, cx)))
            .on_action(cx.listener(|this, _: &MenuSelectAll, w, cx| this.route_edit(EditCommand::SelectAll, w, cx)))
            .on_action(cx.listener(Self::on_menu_find))
            .on_action(cx.listener(|this, _: &SaveAs, w, cx| this.save_as(w, cx)))
            .on_action(cx.listener(Self::on_show_theme))
            .on_action(cx.listener(|this, _: &DefaultApps, w, cx| this.open_settings(SettingsSection::Files, w, cx)))
            .on_action(cx.listener(|this, _: &NewMarkdownDocument, w, cx| this.create_document("md", w, cx)))
            .on_action(cx.listener(|this, _: &NewWordDocument, w, cx| this.create_document("docx", w, cx)))
            .on_action(cx.listener(|this, _: &NewTextDocument, w, cx| this.create_document("txt", w, cx)))
            .on_action(cx.listener(|this, _: &NewDarkmownDocument, w, cx| this.create_document("wd", w, cx)))
            .on_action(cx.listener(|_, _: &MinimizeWindow, w, _| w.minimize_window()))
            .on_action(cx.listener(|_, _: &ZoomWindow, w, _| w.zoom_window()))
            .on_action(cx.listener(|_, _: &ToggleFullScreen, w, _| w.toggle_fullscreen()))
            .on_action(cx.listener(|_, _: &CloseWindow, w, _| w.remove_window()))
    }

    fn route_edit(&mut self, command: EditCommand, window: &mut Window, cx: &mut Context<Self>) {
        let rich_focused = self.rich.read(cx).focus_handle().contains_focused(window, cx);
        let office = match self.doc.as_ref().map(|d| &d.kind) {
            Some(DocKind::Office(office)) => Some(office.view.read(cx).focus_handle(cx)),
            _ => None,
        };
        let word_focused = office.as_ref().is_some_and(|h| h.is_focused(window));
        let nothing_focused = window.focused(cx).is_none_or(|f| f == self.focus_handle);
        let target = edit_target(rich_focused, word_focused, nothing_focused, office.is_some());
        window.dispatch_action(action_for(target, command), cx);
    }

    /// ⌘F (`menu-find`): the find bar of the pane on screen.
    fn on_menu_find(&mut self, _: &MenuFind, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. })) {
            return;
        }
        if self.rich_active() {
            let h = self.rich.read(cx).focus_handle().clone();
            h.focus(window, cx);
            window.dispatch_action(Box::new(markie_editor::Find), cx);
        } else {
            let h = self.editor.read(cx).focus_handle(cx);
            h.focus(window, cx);
            window.dispatch_action(Box::new(field::Search), cx);
        }
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
        crate::menus::install(crate::menus::MenuState { has_history, nightly }, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::{EditTarget, edit_target};

    #[test]
    fn edit_commands_reach_the_focused_editor() {
        assert_eq!(edit_target(true, false, false, false), EditTarget::Rich);
        assert_eq!(edit_target(false, true, false, true), EditTarget::Word);
        assert_eq!(edit_target(false, false, true, true), EditTarget::Word);
        assert_eq!(edit_target(false, false, false, true), EditTarget::Field, "a field in a Word document keeps its own undo");
        assert_eq!(edit_target(false, false, false, false), EditTarget::Field, "the Source editor is a field");
    }
}
