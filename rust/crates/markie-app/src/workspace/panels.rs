//! The outline (section rail), statistics, and the CSV table.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Position;
use gpui_kit::component::{ActiveTheme, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::stats;

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
        let text = self.editor.read(cx).value().to_string();
        let s = stats::compute(&text);
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

    /// CSV as a table: the first row is the header, columns share the width,
    /// and only the visible rows render, so a 100,000-row file stays smooth.
    pub(super) fn render_csv(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let Some(rows) = self.csv_rows.clone() else {
            return div().into_any_element();
        };
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
        let header = rows.first().cloned().unwrap_or_default();
        let body = rows.len().saturating_sub(1);
        let cell = move |text: String, bold: bool, theme: &gpui_kit::component::Theme| {
            div()
                .flex_1()
                .min_w(px(80.))
                .px_2()
                .py_1()
                .border_r_1()
                .border_color(theme.border)
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_sm()
                .when(bold, |el| el.font_weight(FontWeight::SEMIBOLD))
                .child(text)
        };
        let header_theme = theme.clone();
        v_flex()
            .size_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .w_full()
                    .bg(theme.muted)
                    .border_b_1()
                    .border_color(theme.border)
                    .children((0..columns).map(|i| cell(header.get(i).cloned().unwrap_or_default(), true, &header_theme))),
            )
            .child(
                uniform_list("csv-rows", body, move |range, _, _| {
                    range
                        .map(|ix| {
                            let row = &rows[ix + 1];
                            h_flex()
                                .w_full()
                                .border_b_1()
                                .border_color(theme.border)
                                .when(ix % 2 == 1, |el| el.bg(theme.list_even))
                                .children((0..columns).map(|i| cell(row.get(i).cloned().unwrap_or_default(), false, &theme)))
                        })
                        .collect::<Vec<_>>()
                })
                .flex_1(),
            )
            .into_any_element()
    }
}
