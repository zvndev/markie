//! Document commands that work on the Markdown text in either mode, as
//! page.tsx runs them: Format Tables (⌥⌘T) and Find and Replace (⌥⌘F).
//! Source mode itself is GPUI Kit's code editor: tree-sitter highlighting
//! with fenced languages, folding, line numbers, wrapping, multiple cursors
//! (⌘⌥↑ and ⌘⌥↓), its own search bar and undo.

use gpui_kit::*;

use super::Workspace;

actions!(markie_source, [FormatTables, FindReplace]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("cmd-alt-t", FormatTables, None), KeyBinding::new("cmd-alt-f", FindReplace, None)]);
}

impl Workspace {
    pub(super) fn source_actions(d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        d.on_action(cx.listener(Self::on_format_tables)).on_action(cx.listener(Self::on_find_replace))
    }

    fn on_format_tables(&mut self, _: &FormatTables, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.doc.as_ref().map(|d| &d.kind), Some(super::DocKind::Text { .. })) {
            return;
        }
        let text = self.current_text(cx);
        let formatted = markie_core::format_tables::format_markdown_tables(&text);
        if formatted == text {
            return;
        }
        self.editor.update(cx, |s, cx| s.set_value(formatted.clone(), window, cx));
        if self.rich_active() {
            self.load_rich(&formatted, cx);
        }
        self.on_edit(cx);
    }

    fn on_find_replace(&mut self, _: &FindReplace, window: &mut Window, cx: &mut Context<Self>) {
        if self.rich_active() {
            // The View find bar always has its replace field.
            let h = self.rich.read(cx).focus_handle().clone();
            h.focus(window, cx);
            window.dispatch_action(Box::new(markie_editor::Find), cx);
        } else {
            let h = self.editor.read(cx).focus_handle(cx);
            h.focus(window, cx);
            window.dispatch_action(Box::new(gpui_kit::component::input::Replace), cx);
        }
    }
}
