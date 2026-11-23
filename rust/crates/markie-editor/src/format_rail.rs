//! The formatting rail: Electron's `format-rail.tsx`. A 44 pt column on the
//! rich pane's left edge, shown while the activity bar's pencil is chosen
//! (`showFormatRail`), with the same buttons in the same order:
//!
//! H1, H2, H3, bold, italic, strike, inline code, bullet, numbered and task
//! lists, quote, code block, table, rule, link, picture; then, at the
//! bottom, "Advanced tools", which shows inline math, a math block, a
//! footnote and clear formatting.
//!
//! Each button is 32 by 28 pt with 6 pt corners and 11 pt text. A pressed one
//! has the accent fill and a 1 pt inset ring at 12% ink; the rest are muted
//! until hovered. A read-only document keeps the rail, inert at 35%.
//!
//! One stated difference: Electron's link and picture buttons open a small
//! centred form (URL, text, "Open in new tab"). Markie RS opens its own link
//! and picture prompt bar, the one ⌘K and the toolbar use.

use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{PromptKind, RichView};
use markie_rich::editor::{BlockStyle, Editor, ListKind, MarkKind};

/// What a rail button shows.
#[derive(Clone, Copy)]
pub(crate) enum Face {
    /// A text mark: the text, its size and weight, and italic serif.
    Text(&'static str, f32, FontWeight, bool),
    /// An icon from the app's assets.
    Icon(&'static str),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RailKey {
    H1,
    H2,
    H3,
    Bold,
    Italic,
    Strike,
    Code,
    Bullet,
    Ordered,
    Task,
    Quote,
    CodeBlock,
    Table,
    Rule,
    Link,
    Image,
    MathInline,
    MathBlock,
    Footnote,
    Clear,
}

/// `COMMON`, then the link and picture buttons, in Electron's order.
pub(crate) const COMMON: [(RailKey, &str, Face); 16] = [
    (RailKey::H1, "Heading 1", Face::Text("H1", 11., FontWeight::SEMIBOLD, false)),
    (RailKey::H2, "Heading 2", Face::Text("H2", 11., FontWeight::SEMIBOLD, false)),
    (RailKey::H3, "Heading 3", Face::Text("H3", 11., FontWeight::SEMIBOLD, false)),
    (RailKey::Bold, "Bold (⌘B)", Face::Text("B", 13., FontWeight::BOLD, false)),
    (RailKey::Italic, "Italic (⌘I)", Face::Text("I", 13., FontWeight::NORMAL, true)),
    (RailKey::Strike, "Strikethrough", Face::Icon("markie/rail-strike.svg")),
    (RailKey::Code, "Inline code", Face::Icon("markie/rail-code.svg")),
    (RailKey::Bullet, "Bullet list", Face::Icon("markie/rail-bullet.svg")),
    (RailKey::Ordered, "Numbered list", Face::Icon("markie/rail-ordered.svg")),
    (RailKey::Task, "Task list", Face::Icon("markie/rail-task.svg")),
    (RailKey::Quote, "Blockquote", Face::Icon("markie/rail-quote.svg")),
    (RailKey::CodeBlock, "Code block", Face::Icon("markie/rail-codeblock.svg")),
    (RailKey::Table, "Insert table", Face::Icon("markie/rail-table.svg")),
    (RailKey::Rule, "Horizontal rule", Face::Icon("markie/rail-rule.svg")),
    (RailKey::Link, "Link", Face::Icon("markie/rail-link.svg")),
    (RailKey::Image, "Image", Face::Icon("markie/rail-image.svg")),
];

/// `ADVANCED`.
pub(crate) const ADVANCED: [(RailKey, &str, Face); 4] = [
    (RailKey::MathInline, "Inline math ($…$)", Face::Text("Σ", 14., FontWeight::SEMIBOLD, false)),
    (RailKey::MathBlock, "Math block ($$…$$)", Face::Text("∫", 15., FontWeight::SEMIBOLD, false)),
    (RailKey::Footnote, "Footnote", Face::Text("†", 14., FontWeight::SEMIBOLD, false)),
    (RailKey::Clear, "Clear formatting", Face::Icon("markie/rail-clear.svg")),
];

/// `railActiveStates`, read from the editor's toolbar state.
pub(crate) fn is_active(e: &Editor, key: RailKey) -> bool {
    let t = e.toolbar();
    match key {
        RailKey::H1 => t.style == Some(BlockStyle::Heading(1)),
        RailKey::H2 => t.style == Some(BlockStyle::Heading(2)),
        RailKey::H3 => t.style == Some(BlockStyle::Heading(3)),
        RailKey::Bold => t.bold,
        RailKey::Italic => t.italic,
        RailKey::Strike => t.strike,
        RailKey::Code => t.code,
        RailKey::Bullet => t.list == Some(ListKind::Bullet),
        RailKey::Ordered => t.list == Some(ListKind::Ordered),
        RailKey::Task => t.list == Some(ListKind::Task),
        RailKey::Quote => t.style == Some(BlockStyle::Quote),
        RailKey::CodeBlock => t.style == Some(BlockStyle::Code),
        RailKey::Table => t.in_table,
        RailKey::Link => t.link.is_some(),
        _ => false,
    }
}

/// What a button does to the document; `None` for the two that open a prompt.
pub(crate) fn command(key: RailKey) -> Option<fn(&mut Editor)> {
    Some(match key {
        RailKey::H1 => |e| e.set_block_style(BlockStyle::Heading(1)),
        RailKey::H2 => |e| e.set_block_style(BlockStyle::Heading(2)),
        RailKey::H3 => |e| e.set_block_style(BlockStyle::Heading(3)),
        RailKey::Bold => |e| e.toggle_mark(MarkKind::Bold),
        RailKey::Italic => |e| e.toggle_mark(MarkKind::Italic),
        RailKey::Strike => |e| e.toggle_mark(MarkKind::Strike),
        RailKey::Code => |e| e.toggle_mark(MarkKind::Code),
        RailKey::Bullet => |e| e.toggle_list(ListKind::Bullet),
        RailKey::Ordered => |e| e.toggle_list(ListKind::Ordered),
        RailKey::Task => |e| e.toggle_list(ListKind::Task),
        RailKey::Quote => |e| e.toggle_quote(),
        RailKey::CodeBlock => |e| e.set_block_style(BlockStyle::Code),
        // `insertTable({ rows: 3, cols: 3, withHeaderRow: true })`.
        RailKey::Table => |e| e.insert_table(3, 3),
        RailKey::Rule => |e| e.insert_rule(),
        RailKey::MathInline => |e| e.insert_inline_math("E = mc^2"),
        RailKey::MathBlock => |e| e.insert_math_block("E = mc^2"),
        RailKey::Footnote => |e| e.insert_text("[^1]"),
        RailKey::Clear => |e| e.clear_formatting(),
        RailKey::Link | RailKey::Image => return None,
    })
}

impl RichView {
    fn rail_run(&mut self, key: RailKey, window: &mut Window, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        match key {
            // In a link the button takes it off (`unsetLink`).
            RailKey::Link if is_active(&self.editor, RailKey::Link) => self.edit(cx, |e| e.set_link("")),
            RailKey::Link => self.open_prompt(PromptKind::Link, window, cx),
            RailKey::Image => self.open_prompt(PromptKind::Image, window, cx),
            key => {
                if let Some(f) = command(key) {
                    self.edit(cx, f);
                }
            }
        }
        self.focus(window, cx);
    }

    fn rail_button(&self, key: RailKey, title: &'static str, face: Face, active: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let (fg, muted, accent) = (theme.foreground, theme.muted_foreground, theme.accent);
        let disabled = self.read_only;
        let id = SharedString::from(format!("rail-{key:?}"));
        let ink = if active { fg } else { muted };
        let content: AnyElement = match face {
            Face::Text(t, size, weight, italic) => div()
                .text_size(px(size))
                .font_weight(weight)
                .when(italic, |d| d.italic().font_family("Georgia"))
                .text_color(ink)
                .when(!disabled, |d| d.group_hover(id.clone(), move |s| s.text_color(fg)))
                .child(t)
                .into_any_element(),
            Face::Icon(path) => svg()
                .path(path)
                .size(px(15.))
                .text_color(ink)
                .when(!disabled, |s| s.group_hover(id.clone(), move |s| s.text_color(fg)))
                .into_any_element(),
        };
        let title = if key == RailKey::Link && active { "Remove link" } else { title };
        div()
            .id(id.clone())
            .group(id)
            .w(px(32.))
            .h(px(28.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .when(active, |d| {
                d.bg(accent).shadow(vec![BoxShadow {
                    color: fg.opacity(0.12),
                    offset: point(px(0.), px(0.)),
                    blur_radius: px(0.),
                    spread_radius: px(1.),
                    inset: true,
                }])
            })
            .when(!active && !disabled, |d| d.hover(move |s| s.bg(accent.opacity(0.45))))
            .when(disabled, |d| d.opacity(0.35))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(title).build(window, cx))
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .when(!disabled, |d| d.on_click(cx.listener(move |this, _, window, cx| this.rail_run(key, window, cx))))
            .child(content)
            .into_any_element()
    }

    /// The rail, when the host asked for it (`show_format_rail`).
    pub(crate) fn render_format_rail(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.format_rail {
            return None;
        }
        let theme = cx.theme();
        // `bg-surface`: GPUI Kit's muted background is Electron's surface;
        // `secondary` is surface-2, a step lighter in dark and darker in light.
        let (surface, border) = (theme.muted, theme.border);
        let mut col = div().id("format-rail-col").size_full().flex().flex_col().items_center().py(px(8.)).gap(px(2.)).overflow_y_scroll();
        for (key, title, face) in COMMON {
            let active = is_active(&self.editor, key);
            col = col.child(self.rail_button(key, title, face, active, cx));
        }
        col = col.child(div().flex_1());
        let advanced = self.rail_advanced;
        let toggle_title = if advanced { "Hide advanced tools" } else { "Advanced tools" };
        let disabled = self.read_only;
        let (fg, muted, accent) = (cx.theme().foreground, cx.theme().muted_foreground, cx.theme().accent);
        let ink = if advanced { fg } else { muted };
        col = col.child(
            div()
                .id("rail-advanced")
                .group("rail-advanced")
                .w(px(32.))
                .h(px(28.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .when(advanced, |d| {
                    // `btnClass(showAdvanced)`: the pressed toggle has the same
                    // inset ring as a pressed formatting button.
                    d.bg(accent).shadow(vec![BoxShadow {
                        color: fg.opacity(0.12),
                        offset: point(px(0.), px(0.)),
                        blur_radius: px(0.),
                        spread_radius: px(1.),
                        inset: true,
                    }])
                })
                .when(!advanced && !disabled, |d| d.hover(move |s| s.bg(accent.opacity(0.45))))
                .when(disabled, |d| d.opacity(0.35))
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(toggle_title).build(window, cx))
                .when(!disabled, |d| {
                    d.on_click(cx.listener(|this, _, _, cx| {
                        this.rail_advanced = !this.rail_advanced;
                        cx.notify();
                    }))
                })
                .child(svg().path("markie/rail-more.svg").size(px(15.)).text_color(ink).when(!disabled, |s| s.group_hover("rail-advanced", move |s| s.text_color(fg)))),
        );
        if advanced {
            for (key, title, face) in ADVANCED {
                col = col.child(self.rail_button(key, title, face, false, cx));
            }
        }
        let rail = div()
            .id("format-rail")
            .w(px(44.))
            .h_full()
            .flex_none()
            .border_r_1()
            .border_color(border)
            .bg(surface)
            .when(disabled, |d| {
                d.tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("You have read-only access to this document").build(window, cx))
            })
            .child(col);
        Some(rail.into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{ADVANCED, COMMON, RailKey, command, is_active};
    use markie_rich::editor::Editor;

    #[test]
    fn the_buttons_are_electrons_in_order() {
        let titles: Vec<&str> = COMMON.iter().chain(ADVANCED.iter()).map(|(_, t, _)| *t).collect();
        assert_eq!(
            titles,
            [
                "Heading 1", "Heading 2", "Heading 3", "Bold (⌘B)", "Italic (⌘I)", "Strikethrough", "Inline code",
                "Bullet list", "Numbered list", "Task list", "Blockquote", "Code block", "Insert table", "Horizontal rule",
                "Link", "Image", "Inline math ($…$)", "Math block ($$…$$)", "Footnote", "Clear formatting",
            ]
        );
    }

    #[test]
    fn commands_write_what_tiptap_writes() {
        let run = |md: &str, key: RailKey| {
            let mut e = Editor::parse(md);
            command(key).unwrap()(&mut e);
            e.to_markdown()
        };
        assert_eq!(run("Hello\n", RailKey::H2), "## Hello\n");
        assert_eq!(run("## Hello\n", RailKey::H2), "Hello\n");
        assert_eq!(run("Hello\n", RailKey::Quote), "> Hello\n");
        assert_eq!(run("Hello\n", RailKey::Bullet), "- Hello\n");
        let mut e = Editor::parse("# Title\n");
        assert!(is_active(&e, RailKey::H1) && !is_active(&e, RailKey::H2));
        command(RailKey::H1).unwrap()(&mut e);
        assert!(!is_active(&e, RailKey::H1));
    }
}
