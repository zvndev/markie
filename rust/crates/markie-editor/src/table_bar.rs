//! The table bar: `TableBar` in format-rail.tsx, shown at the top of the
//! document while the caret is in a table. Same buttons, labels and titles.

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::{ActiveTheme, Disableable as _, Sizable, h_flex};
use gpui_kit::*;

use super::RichView;
use markie_rich::editor::Editor;

type Run = fn(&mut Editor);

/// (label, title, command). `None` is the header toggle. Electron's runs
/// TipTap's toggleHeaderRow, and a table without a header row then has no
/// Markdown form: `isMarkdownTable` fails and `writeTableHTML` saves it as
/// an HTML `<table>`. Markie RS reads an HTML table as source, not as a
/// table, so the toggle would turn the table into raw HTML the next time
/// the file opens. It stays disabled, and its title says why.
const ACTIONS: &[(&str, &str, Option<Run>)] = &[
    ("+ Row ↑", "Add row above", Some(|e| e.add_row(false))),
    ("+ Row ↓", "Add row below", Some(|e| e.add_row(true))),
    ("+ Col ←", "Add column left", Some(|e| e.add_column(false))),
    ("+ Col →", "Add column right", Some(|e| e.add_column(true))),
    ("− Row", "Delete row", Some(|e| e.delete_row())),
    ("− Col", "Delete column", Some(|e| e.delete_column())),
    ("Header", HEADER_TITLE, None),
    ("✕ Table", "Delete table", Some(|e| e.delete_table())),
];

/// The disabled toggle's title: Electron's own title, then the reason.
pub(crate) const HEADER_TITLE: &str = "Toggle header row - A table without a header row can only be saved as HTML, so Markdown tables keep theirs";

impl RichView {
    pub(crate) fn render_table_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.read_only || !self.editor.in_table() {
            return None;
        }
        let theme = cx.theme();
        let mut bar = h_flex()
            .id("rich-table-bar")
            .absolute()
            .top(px(8.))
            .left_0()
            .right_0()
            .mx_auto()
            .w(px(520.))
            .justify_center()
            .gap(px(4.))
            .px(px(8.))
            .py(px(4.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.popover)
            .shadow_lg()
            // Clicking a button must not take the caret out of the table.
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default());
        for (i, (label, title, run)) in ACTIONS.iter().enumerate() {
            let title: SharedString = (*title).into();
            let mut b = Button::new(("table-bar", i)).label(*label).xsmall().ghost().tooltip(title);
            match run {
                Some(run) => {
                    let run = *run;
                    b = b.on_click(cx.listener(move |this, _, window, cx| {
                        this.edit(cx, run);
                        this.focus(window, cx);
                    }));
                }
                None => b = b.disabled(true),
            }
            bar = bar.child(b);
        }
        Some(bar.into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{ACTIONS, HEADER_TITLE};

    #[test]
    fn the_bar_has_electrons_eight_buttons_with_the_header_toggle_disabled() {
        let labels: Vec<&str> = ACTIONS.iter().map(|(l, _, _)| *l).collect();
        assert_eq!(labels, ["+ Row ↑", "+ Row ↓", "+ Col ←", "+ Col →", "− Row", "− Col", "Header", "✕ Table"]);
        let header = ACTIONS.iter().find(|(l, _, _)| *l == "Header").unwrap();
        assert!(header.2.is_none());
        assert!(HEADER_TITLE.starts_with("Toggle header row"));
    }
}
