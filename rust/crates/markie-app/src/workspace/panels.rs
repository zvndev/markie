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
    /// The CSV view, drawn as Electron draws a CSV: its table in the rich
    /// page column, columns as wide as their text, a bold centered header,
    /// 65 px rows with a rule between them and no column lines.
    pub(super) fn render_csv(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let Some(rows) = self.csv_rows.clone() else {
            return div().into_any_element();
        };
        let zoom = self.zoom;
        let size = px(15. * zoom);
        let pad = 15.5 * zoom;
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
        let widths = csv_widths(&rows, columns, size, &theme.font_family, cx);
        let total: f32 = widths.iter().sum();
        let header = rows.first().cloned().unwrap_or_default();
        let body = rows.len().saturating_sub(1);
        let cell = move |text: String, width: f32, bold: bool| {
            div()
                .w(px(width))
                .flex_none()
                .px(px(pad))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .when(bold, |d| d.font_weight(FontWeight::BOLD).text_center())
                .child(text)
        };
        let header_widths = widths.clone();
        let page_width = self.page_width;
        let column = move |content: AnyElement| {
            h_flex().w_full().justify_center().child(div().w_full().max_w(px(page_width)).px(px(40.)).child(content))
        };
        let row_border = theme.border;
        let hover = theme.secondary;
        v_flex()
            .size_full()
            .bg(theme.background)
            .text_size(size)
            .text_color(theme.foreground)
            .child(column(
                h_flex()
                    .mt(px(32.))
                    .w(px(total))
                    .h(px(61. * zoom))
                    .pt(px(14. * zoom))
                    .items_center()
                    .border_b_1()
                    .border_color(row_border)
                    .children((0..columns).map(|i| cell(header.get(i).cloned().unwrap_or_default(), header_widths[i], true)))
                    .into_any_element(),
            ))
            .child(
                uniform_list("csv-rows", body, move |range, _, _| {
                    range
                        .map(|ix| {
                            let row = &rows[ix + 1];
                            column(
                                h_flex()
                                    .id(("csv-row", ix))
                                    .w(px(total))
                                    .h(px(65. * zoom))
                                    .items_center()
                                    .border_b_1()
                                    .border_color(row_border)
                                    .hover(move |s| s.bg(hover))
                                    .children((0..columns).map(|i| cell(row.get(i).cloned().unwrap_or_default(), widths[i], false)))
                                    .into_any_element(),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .flex_1(),
            )
            .into_any_element()
    }
}

/// Column widths for the CSV view: the widest text in each column, measured
/// once per table and size from the first 2,000 rows, plus cell padding, at
/// least Electron's 3 rem.
fn csv_widths(rows: &std::rc::Rc<Vec<Vec<String>>>, columns: usize, size: Pixels, family: &SharedString, cx: &App) -> std::rc::Rc<Vec<f32>> {
    thread_local! {
        static CACHE: std::cell::RefCell<Option<(usize, usize, u32, std::rc::Rc<Vec<f32>>)>> = const { std::cell::RefCell::new(None) };
    }
    let key = (std::rc::Rc::as_ptr(rows) as usize, rows.len(), f32::from(size).to_bits());
    if let Some(hit) = CACHE.with(|c| c.borrow().as_ref().filter(|(p, n, s, _)| (*p, *n, *s) == key).map(|(_, _, _, w)| w.clone())) {
        return hit;
    }
    let system = cx.text_system();
    let regular = system.resolve_font(&font(family.clone()));
    let bold = system.resolve_font(&Font { weight: FontWeight::BOLD, ..font(family.clone()) });
    let measure = |text: &str, id: FontId| text.chars().map(|ch| system.advance(id, size, ch).map_or(0.0, |a| f32::from(a.width))).sum::<f32>();
    let pad = f32::from(size) / 15.0 * 31.0;
    let mut widths = vec![48.0_f32; columns];
    for (r, row) in rows.iter().take(2000).enumerate() {
        for (c, text) in row.iter().enumerate().take(columns) {
            let w = measure(text, if r == 0 { bold } else { regular }) + pad;
            widths[c] = widths[c].max(w.ceil());
        }
    }
    let widths = std::rc::Rc::new(widths);
    CACHE.with(|c| *c.borrow_mut() = Some((key.0, key.1, key.2, widths.clone())));
    widths
}
