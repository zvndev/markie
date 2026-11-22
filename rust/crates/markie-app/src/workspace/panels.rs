//! The outline (section rail), statistics, and the CSV table.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Position;
use gpui_kit::component::{ActiveTheme, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;


use super::{Mode, SidePanel, Workspace};

impl Workspace {
    fn panel_shell(&self, title: &'static str, panel: SidePanel, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        v_flex()
            .size_full()
            .bg(theme.sidebar)
            .border_l_1()
            .border_color(theme.sidebar_border)
            .child(
                h_flex()
                    .p_2()
                    .justify_between()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(title))
                    .child(
                        Button::new(SharedString::from(format!("close-{title}")))
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .on_click(cx.listener(move |this, _, _, cx| this.toggle_side(panel, cx))),
                    ),
            )
    }

    /// Jump to a heading. Source mode moves the caret; View mode switches to
    /// Source at that line until the rich editor can scroll to a block.
    fn jump_to_line(&mut self, line: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.rich_active() && self.reveal_section_line(line, window, cx) {
            return;
        }
        if self.mode == Mode::View {
            self.set_mode(Mode::Source, window, cx);
        }
        self.editor.update(cx, |state, cx| {
            state.set_cursor_position(Position { line: line as u32, character: 0 }, window, cx);
        });
        self.focus_editor(window, cx);
    }

    pub(super) fn render_outline(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let empty = self.sections.is_empty();
        self.panel_shell("Outline", SidePanel::Outline, cx)
            .when(empty, |el| {
                el.child(
                    div()
                        .px_3()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("No headings yet. Lines starting with #, ## or ### show up here."),
                )
            })
            .child(
                v_flex().id("outline").flex_1().overflow_y_scroll().children(self.sections.iter().map(|section| {
                    let line = section.line;
                    div()
                        .id(SharedString::from(format!("sec-{line}")))
                        .pl(px(12. + 14. * (section.level.saturating_sub(1)) as f32))
                        .pr_3()
                        .py_1()
                        .text_sm()
                        .when(section.level == 1, |el| el.font_weight(FontWeight::SEMIBOLD))
                        .cursor_pointer()
                        .hover(|el| el.bg(theme.list_hover))
                        .on_click(cx.listener(move |this, _, window, cx| this.jump_to_line(line, window, cx)))
                        .child(section.text.clone())
                })),
            )
    }

    pub(super) fn render_stats(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        // Counted when the text settles, not on every frame the panel is open.
        let s = self.doc_stats;
        let rows = [
            ("Words", s.words.to_string()),
            ("Characters", s.chars.to_string()),
            ("Lines", s.lines.to_string()),
            ("Headings", s.headings.to_string()),
            ("Reading time", format!("{} min", s.reading_minutes)),
        ];
        self.panel_shell("Statistics", SidePanel::Stats, cx).child(v_flex().px_3().gap_2().children(rows.into_iter().map(
            |(label, value)| {
                h_flex()
                    .justify_between()
                    .text_sm()
                    .child(div().text_color(theme.muted_foreground).child(label))
                    .child(div().font_weight(FontWeight::MEDIUM).child(value))
            },
        )))
    }
}
