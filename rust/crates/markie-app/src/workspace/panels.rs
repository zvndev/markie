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

    /// `StatsPanel`: a 240 pt popover 48 pt from the top and 16 pt from the
    /// right of the window, `.markie-menu-panel` in the current template,
    /// with the "STATISTICS" label, its ×, and one 12 pt row per figure.
    pub(super) fn render_stats(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = super::dialog_chrome::Tokens::current(&self.setting_or("style_template", "markie"), cx);
        // `stats::compute` over the document as it stands, kept by the
        // window and refreshed when typing pauses, not recounted per frame.
        let s = self.doc_stats;
        let n = stats::grouped;
        // `StatsPanel`'s rows, in its order and wording.
        let rows = [
            ("Words", n(s.words)),
            ("Characters", n(s.chars)),
            ("Characters (no spaces)", n(s.chars_no_spaces)),
            ("Lines", n(s.lines)),
            ("Headings", n(s.headings)),
            ("Code blocks", n(s.code_blocks)),
            ("Links", n(s.links)),
            ("Reading time", if s.reading_minutes > 0 { format!("{} min", s.reading_minutes) } else { "—".into() }),
        ];
        use super::dialog_chrome::{black, fade, inset, mix, shadow};
        let (bg, border, shadows) = if t.dark {
            (t.surface2, t.border, vec![shadow(fade(black(), 0.22), 0., 10., 24.), inset(fade(t.foreground, 0.06), 1.)])
        } else {
            (mix(t.background, 0.58, t.surface2), fade(t.border, 0.6), vec![shadow(fade(black(), 0.11), 0., 8., 22.)])
        };
        let width = f32::from(window.viewport_size().width);
        let hover = t.hover();
        let panel = v_flex()
            .id("stats-panel")
            .w(px(240.))
            .rounded(px(8.))
            .py(px(8.))
            .bg(bg)
            .border_1()
            .border_color(border)
            .shadow(shadows)
            .occlude()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .px(px(12.))
                    .pb(px(6.))
                    .border_b_1()
                    .border_color(t.border)
                    .child(super::dialog_chrome::section_label("Statistics", &t))
                    .child(
                        // `markie-overlay-close`: a 1.5 rem square, 6 px corners.
                        div()
                            .id("stats-close")
                            .size(px(24.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .text_size(px(13.))
                            .line_height(px(13.))
                            .text_color(t.muted)
                            .hover(move |s| s.bg(hover))
                            .cursor_pointer()
                            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Close statistics").build(window, cx))
                            .child("×")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_side(SidePanel::Stats, cx))),
                    ),
            )
            .children(rows.into_iter().map(|(label, value)| {
                h_flex()
                    .justify_between()
                    .gap(px(16.))
                    .px(px(12.))
                    .py(px(6.))
                    .text_size(px(12.))
                    // The body's 1.5: 18 px lines, 30 px rows, as `py-1.5`.
                    .line_height(px(18.))
                    .child(div().text_color(t.muted).child(label))
                    .child(div().text_color(t.foreground).child(value))
            }));
        deferred(anchored().position(point(px(width - 16. - 240.), px(48.))).child(panel)).with_priority(5).into_any_element()
    }
}
