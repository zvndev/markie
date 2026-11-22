//! The table bar: `TableBar` in format-rail.tsx, shown at the top of the
//! document while the caret is in a table. Same buttons, labels and titles.

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::{ActiveTheme, Disableable as _, Sizable, h_flex};
use gpui_kit::*;

use super::RichView;
use markie_rich::editor::Editor;

type Run = fn(&mut Editor);

/// (label, title, command). `None` is the header toggle, which Markdown
/// cannot express (a table keeps its first row as the header).
const ACTIONS: &[(&str, &str, Option<Run>)] = &[
    ("+ Row ↑", "Add row above", Some(|e| e.add_row(false))),
    ("+ Row ↓", "Add row below", Some(|e| e.add_row(true))),
    ("+ Col ←", "Add column left", Some(|e| e.add_column(false))),
    ("+ Col →", "Add column right", Some(|e| e.add_column(true))),
    ("− Row", "Delete row", Some(|e| e.delete_row())),
    ("− Col", "Delete column", Some(|e| e.delete_column())),
    ("Header", "Toggle header row (a Markdown table always has one)", None),
    ("✕ Table", "Delete table", Some(|e| e.delete_table())),
];

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
