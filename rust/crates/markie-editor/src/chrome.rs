//! The formatting toolbar (`formatting-toolbar.tsx`), the find bar and the
//! one-line prompt, around the document.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{PromptKind, RichView};
use markie_rich::editor::{BlockStyle, Editor, ListKind, MarkKind};

/// The text colours of `formatting-toolbar.tsx`.
const TEXT_COLOURS: [(&str, Option<&str>); 7] = [
    ("Default", None),
    ("Grey", Some("#6b7280")),
    ("Red", Some("#dc2626")),
    ("Orange", Some("#ea580c")),
    ("Green", Some("#16a34a")),
    ("Blue", Some("#2563eb")),
    ("Purple", Some("#7c3aed")),
];

/// Its highlight colours.
const HIGHLIGHTS: [(&str, Option<&str>); 6] = [
    ("None", None),
    ("Yellow", Some("#fef08a")),
    ("Green", Some("#bbf7d0")),
    ("Blue", Some("#bfdbfe")),
    ("Pink", Some("#fbcfe8")),
    ("Orange", Some("#fed7aa")),
];

/// The document fonts of `doc-appearance.ts`, as the stacks the
/// `fontFamily` mark stores.
const FONTS: [(&str, Option<&str>); 6] = [
    ("Theme font", None),
    ("Charter", Some("Charter, Georgia, 'Times New Roman', serif")),
    ("Georgia", Some("Georgia, Charter, serif")),
    ("Iowan", Some("'Iowan Old Style', Palatino, Georgia, serif")),
    ("Helvetica", Some("'Helvetica Neue', Helvetica, Arial, sans-serif")),
    ("Monospace", Some("ui-monospace, Menlo, monospace")),
];

const SIZES: [u32; 9] = [12, 14, 16, 18, 20, 24, 28, 32, 40];

impl RichView {
    /// Run an editor command from the toolbar and give the document focus.
    fn tool_edit(&mut self, window: &mut Window, cx: &mut Context<Self>, f: impl FnOnce(&mut Editor)) {
        self.edit(cx, f);
        self.focus(window, cx);
    }

    fn tool(
        &self,
        id: &'static str,
        icon: &'static str,
        tip: &'static str,
        active: bool,
        cx: &mut Context<Self>,
        f: impl Fn(&mut RichView, &mut Window, &mut Context<RichView>) + 'static,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let (fg, active_bg, hover) = (theme.foreground, theme.accent, theme.accent.opacity(0.5));
        div()
            .id(id)
            .size(px(28.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(5.))
            .when(active, |d| d.bg(active_bg))
            .hover(move |s| s.bg(hover))
            .cursor_pointer()
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip).build(window, cx))
            .child(svg().path(icon).size(px(15.)).text_color(fg))
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_click(cx.listener(move |this, _, window, cx| f(this, window, cx)))
    }

    pub(crate) fn render_toolbar(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = self.editor.toolbar();
        let theme = cx.theme().clone();
        let weak = cx.entity().downgrade();
        let style_label = match t.style {
            Some(BlockStyle::Heading(n)) => format!("Heading {n}"),
            Some(BlockStyle::Quote) => "Quote".into(),
            Some(BlockStyle::Code) => "Code block".into(),
            _ => "Normal text".into(),
        };
        let w = weak.clone();
        let current = t.style;
        let style_menu = Button::new("rich-style").label(style_label).ghost().xsmall().dropdown_menu(move |menu, _, _| {
            let mut menu = menu;
            for (label, style) in [
                ("Normal text", BlockStyle::Paragraph),
                ("Heading 1", BlockStyle::Heading(1)),
                ("Heading 2", BlockStyle::Heading(2)),
                ("Heading 3", BlockStyle::Heading(3)),
                ("Quote", BlockStyle::Quote),
                ("Code block", BlockStyle::Code),
            ] {
                let w = w.clone();
                menu = menu.item(PopupMenuItem::new(label).checked(current == Some(style)).on_click(move |_, window, cx| {
                    w.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_block_style(style))).ok();
                }));
            }
            menu
        });
        let w = weak.clone();
        let cur_font = t.font_family.clone();
        let font_menu = Button::new("rich-font")
            .label(FONTS.iter().find(|(_, s)| s.map(str::to_string) == cur_font).map(|(l, _)| *l).unwrap_or("Font"))
            .ghost()
            .xsmall()
            .dropdown_menu(move |menu, _, _| {
                let mut menu = menu;
                for (label, stack) in FONTS {
                    let w = w.clone();
                    menu = menu.item(PopupMenuItem::new(label).on_click(move |_, window, cx| {
                        let v = stack.map(|s| s.to_string());
                        w.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_text_style(None, Some(v), None))).ok();
                    }));
                }
                menu
            });
        let w = weak.clone();
        let size_label = t.font_size.clone().unwrap_or_else(|| "Size".into());
        let size_menu = Button::new("rich-size").label(size_label).ghost().xsmall().dropdown_menu(move |menu, _, _| {
            let mut menu = menu;
            let w0 = w.clone();
            menu = menu.item(PopupMenuItem::new("Default").on_click(move |_, window, cx| {
                w0.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_text_style(None, None, Some(None)))).ok();
            }));
            for s in SIZES {
                let w = w.clone();
                menu = menu.item(PopupMenuItem::new(format!("{s}px")).on_click(move |_, window, cx| {
                    w.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_text_style(None, None, Some(Some(format!("{s}px")))))).ok();
                }));
            }
            menu
        });
        let w = weak.clone();
        let color_menu = Button::new("rich-color").icon(gpui_kit::component::Icon::empty().path("icons/baseline.svg")).ghost().xsmall().dropdown_menu(move |menu, _, _| {
            let mut menu = menu;
            for (label, c) in TEXT_COLOURS {
                let w = w.clone();
                menu = menu.item(PopupMenuItem::new(label).on_click(move |_, window, cx| {
                    let v = c.map(|c| c.to_string());
                    w.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_text_style(Some(v), None, None))).ok();
                }));
            }
            menu
        });
        let w = weak.clone();
        let hl_menu = Button::new("rich-highlight").icon(gpui_kit::component::Icon::empty().path("icons/highlighter.svg")).ghost().xsmall().dropdown_menu(move |menu, _, _| {
            let mut menu = menu;
            for (label, c) in HIGHLIGHTS {
                let w = w.clone();
                menu = menu.item(PopupMenuItem::new(label).on_click(move |_, window, cx| {
                    let v = c.map(|c| Some(c.to_string()));
                    w.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_highlight(v))).ok();
                }));
            }
            menu
        });
        let w = weak.clone();
        let insert_menu = Button::new("rich-insert").icon(gpui_kit::component::Icon::empty().path("icons/plus.svg")).ghost().xsmall().dropdown_menu(move |menu, _, _| {
            let w1 = w.clone();
            let w2 = w.clone();
            let w3 = w.clone();
            let w4 = w.clone();
            let w5 = w.clone();
            menu.item(PopupMenuItem::new("Picture…").on_click(move |_, window, cx| {
                w1.update(cx, |this, cx| this.open_prompt(PromptKind::Image, window, cx)).ok();
            }))
            .item(PopupMenuItem::new("Formula…").on_click(move |_, window, cx| {
                w2.update(cx, |this, cx| this.open_prompt(PromptKind::InlineMath { at: None }, window, cx)).ok();
            }))
            .item(PopupMenuItem::new("Display formula").on_click(move |_, window, cx| {
                w3.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.insert_math_block("x^2"))).ok();
            }))
            .item(PopupMenuItem::new("Table").on_click(move |_, window, cx| {
                w4.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.insert_table(3, 3))).ok();
            }))
            .item(PopupMenuItem::new("Horizontal rule").on_click(move |_, window, cx| {
                w5.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.insert_rule())).ok();
            }))
        });
        let sep = || div().w(px(1.)).h(px(18.)).mx(px(4.)).bg(theme.border).flex_none();
        let align = t.align.clone().unwrap_or_default();
        h_flex()
            .id("rich-toolbar")
            .flex_none()
            .w_full()
            .overflow_x_scroll()
            .gap(px(2.))
            .px(px(10.))
            .py(px(4.))
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.background)
            .child(style_menu)
            .child(font_menu)
            .child(size_menu)
            .child(sep())
            .child(self.tool("rt-bold", "icons/bold.svg", "Bold ⌘B", t.bold, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Bold))))
            .child(self.tool("rt-italic", "icons/italic.svg", "Italic ⌘I", t.italic, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Italic))))
            .child(self.tool("rt-underline", "icons/underline.svg", "Underline ⌘U", t.underline, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Underline))))
            .child(self.tool("rt-strike", "icons/strikethrough.svg", "Strikethrough ⌘⇧X", t.strike, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Strike))))
            .child(self.tool("rt-code", "icons/code.svg", "Inline code ⌘E", t.code, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Code))))
            .child(sep())
            .child(color_menu)
            .child(hl_menu)
            .child(sep())
            .child(self.tool("rt-bullet", "icons/list.svg", "Bulleted list ⌘⇧8", t.list == Some(ListKind::Bullet), cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Bullet))))
            .child(self.tool("rt-ordered", "icons/list-ordered.svg", "Numbered list ⌘⇧7", t.list == Some(ListKind::Ordered), cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Ordered))))
            .child(self.tool("rt-task", "icons/list-todo.svg", "Task list ⌘⇧9", t.list == Some(ListKind::Task), cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Task))))
            .child(sep())
            .child(self.tool("rt-left", "icons/text-align-start.svg", "Align left ⌘⇧L", align.is_empty() || align == "left", cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("left")))))
            .child(self.tool("rt-center", "icons/text-align-center.svg", "Align centre ⌘⇧E", align == "center", cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("center")))))
            .child(self.tool("rt-right", "icons/text-align-end.svg", "Align right ⌘⇧R", align == "right", cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("right")))))
            .child(sep())
            .child(self.tool("rt-link", "icons/link.svg", "Link ⌘⇧K", t.link.is_some(), cx, |this, w, cx| this.open_prompt(PromptKind::Link, w, cx)))
            .child(self.tool("rt-image", "icons/image.svg", "Picture", false, cx, |this, w, cx| this.open_prompt(PromptKind::Image, w, cx)))
            .child(insert_menu)
            .child(sep())
            .child(self.tool("rt-undo", "icons/undo.svg", "Undo ⌘Z", false, cx, |this, w, cx| this.tool_edit(w, cx, |e| {
                e.undo();
            })))
            .child(self.tool("rt-redo", "icons/redo.svg", "Redo ⌘⇧Z", false, cx, |this, w, cx| this.tool_edit(w, cx, |e| {
                e.redo();
            })))
            .child(self.tool("rt-clear", "icons/remove-formatting.svg", "Clear formatting ⌘\\", false, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.clear_formatting())))
            .into_any_element()
    }

    pub(crate) fn render_prompt(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = self.prompt.as_ref()?;
        let theme = cx.theme();
        let input = p.input.clone();
        Some(
            h_flex()
                .id("rich-prompt")
                .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                    if ev.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.prompt = None;
                        this.focus(window, cx);
                        cx.notify();
                    }
                }))
                .flex_none()
                .gap(px(8.))
                .px(px(12.))
                .py(px(6.))
                .border_b_1()
                .border_color(theme.border)
                .bg(theme.muted)
                .child(div().text_sm().text_color(theme.muted_foreground).child(p.label.clone()))
                .child(div().flex_1().child(Input::new(&p.input).small()))
                .child(Button::new("prompt-ok").label("Apply").xsmall().primary().on_click(cx.listener(move |this, _, window, cx| {
                    let v = input.read(cx).value().to_string();
                    this.apply_prompt(v, window, cx);
                })))
                .child(Button::new("prompt-cancel").label("Cancel").xsmall().ghost().on_click(cx.listener(|this, _, window, cx| {
                    this.prompt = None;
                    this.focus(window, cx);
                    cx.notify();
                })))
                .into_any_element(),
        )
    }

    pub(crate) fn render_find(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let f = self.find.as_ref()?;
        let theme = cx.theme();
        let count = if f.matches.is_empty() {
            if self.find_query(cx).is_empty() { String::new() } else { "No results".into() }
        } else {
            format!("{} of {}", f.current + 1, f.matches.len())
        };
        Some(
            h_flex()
                .id("rich-find")
                .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                    if ev.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.find = None;
                        this.focus(window, cx);
                        cx.notify();
                    }
                }))
                .flex_none()
                .gap(px(6.))
                .px(px(12.))
                .py(px(6.))
                .border_b_1()
                .border_color(theme.border)
                .bg(theme.muted)
                .child(div().w(px(220.)).child(Input::new(&f.query).small()))
                .child(div().w(px(90.)).text_xs().text_color(theme.muted_foreground).child(count))
                .child(Button::new("find-prev").label("Previous").xsmall().ghost().on_click(cx.listener(|this, _, _, cx| this.find_step(false, cx))))
                .child(Button::new("find-next").label("Next").xsmall().ghost().on_click(cx.listener(|this, _, _, cx| this.find_step(true, cx))))
                .child(div().w(px(180.)).child(Input::new(&f.replace).small()))
                .child(Button::new("find-replace").label("Replace").xsmall().ghost().on_click(cx.listener(|this, _, _, cx| this.replace_one(cx))))
                .child(Button::new("find-all").label("All").xsmall().ghost().on_click(cx.listener(|this, _, _, cx| this.replace_all(cx))))
                .child(div().flex_1())
                .child(Button::new("find-close").label("Done").xsmall().ghost().on_click(cx.listener(|this, _, window, cx| {
                    this.find = None;
                    this.focus(window, cx);
                    cx.notify();
                })))
                .into_any_element(),
        )
    }
}

impl Render for RichView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let started = std::time::Instant::now();
        let toolbar = (!self.read_only).then(|| self.render_toolbar(window, cx));
        let prompt = self.render_prompt(cx);
        let doc = self.render_document(window, cx);
        let find = self.render_find(cx);
        if std::env::var("MARKIE_RICH_DEBUG").is_ok() {
            eprintln!("render {} blocks in {:?}", self.editor.block_count(), started.elapsed());
        }
        gpui_kit::component::v_flex()
            .size_full()
            .children(toolbar)
            .children(prompt)
            .children(find)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(doc)
                    .children(self.render_table_bar(cx))
                    .children(self.render_math_field(cx))
                    .children(self.render_link_card(window, cx)),
            )
    }
}
