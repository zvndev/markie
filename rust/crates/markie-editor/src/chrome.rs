//! The formatting toolbar (`formatting-toolbar.tsx`), the find bar and the
//! one-line prompt, around the document.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::menu::{DropdownMenu, PopupMenu, PopupMenuItem};
use gpui_kit::component::Selectable;
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::style::{DOC_FONTS, clamp_font_size, step_width, step_zoom, width_label, zoom_label};
use super::{PromptKind, RichEvent, RichView};
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

/// A plain element that opens a menu: GPUI Kit's dropdown wants a
/// `Selectable` trigger, and the toolbar's are drawn by hand.
#[derive(IntoElement)]
pub(crate) struct Trigger {
    base: Stateful<Div>,
    selected: bool,
}

impl RenderOnce for Trigger {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        self.base
    }
}

impl Styled for Trigger {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for Trigger {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl Selectable for Trigger {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl DropdownMenu for Trigger {}

trait MenuTrigger {
    fn popup_menu_anchored(
        self,
        f: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
    ) -> impl IntoElement;
}

impl MenuTrigger for Stateful<Div> {
    fn popup_menu_anchored(
        self,
        f: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
    ) -> impl IntoElement {
        Trigger { base: self, selected: false }.dropdown_menu(f)
    }
}

/// The paragraph styles of `BLOCK_STYLES`.
const BLOCK_STYLES: [(&str, BlockStyle); 6] = [
    ("Normal text", BlockStyle::Paragraph),
    ("Heading 1", BlockStyle::Heading(1)),
    ("Heading 2", BlockStyle::Heading(2)),
    ("Heading 3", BlockStyle::Heading(3)),
    ("Quote", BlockStyle::Quote),
    ("Code block", BlockStyle::Code),
];

/// The toolbar's groups in the order they leave for the "more" menu, with
/// the width each takes (`formatting-toolbar.tsx`, `groups`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Group {
    Selectors,
    Colour,
    Lists,
    Alignment,
    History,
    Marks,
    Insert,
    Task,
    Clear,
    Size,
    Output,
    View,
}

const GROUPS: [(Group, f32); 12] = [
    (Group::Selectors, 220.),
    (Group::Colour, 82.),
    (Group::Lists, 60.),
    (Group::Alignment, 90.),
    (Group::History, 60.),
    (Group::Marks, 60.),
    (Group::Insert, 60.),
    (Group::Task, 30.),
    (Group::Clear, 30.),
    (Group::Size, 60.),
    (Group::Output, 60.),
    (Group::View, 214.),
];
/// Bold, italic and underline, which leave last.
const PRIMARY: f32 = 130.;

/// Which groups go to the "more" menu at `width`: none when the whole row
/// fits (then it also shows its dividers), else the first that do not fit,
/// in `GROUPS` order. Returns (compact, primary in menu, groups in menu).
fn fit(width: f32) -> (bool, bool, Vec<Group>) {
    let full = 16. + PRIMARY + GROUPS.iter().map(|(_, w)| w).sum::<f32>() + 64. + 60.;
    let compact = width > 0. && width < full;
    if !compact {
        return (false, false, vec![]);
    }
    let primary_out = width - 16. - 30. < PRIMARY;
    let mut available = width - 16. - if primary_out { 0. } else { PRIMARY } - 30.;
    let mut out = vec![];
    for (g, w) in GROUPS {
        if w <= available {
            available -= w;
        } else {
            out.push(g);
        }
    }
    (true, primary_out, out)
}

impl RichView {
    /// Run an editor command from the toolbar and give the document focus.
    fn tool_edit(&mut self, window: &mut Window, cx: &mut Context<Self>, f: impl FnOnce(&mut Editor)) {
        if self.source_mode {
            return;
        }
        self.edit(cx, f);
        self.focus(window, cx);
    }

    /// `TButton`: 28px square, muted until hovered, accent when on.
    #[allow(clippy::too_many_arguments)]
    fn tool(
        &self,
        id: &'static str,
        icon: &'static str,
        tip: &'static str,
        active: bool,
        disabled: bool,
        cx: &mut Context<Self>,
        f: impl Fn(&mut RichView, &mut Window, &mut Context<RichView>) + 'static,
    ) -> Stateful<Div> {
        // GPUI draws an SVG in its own colour, not its parent's: give it the
        // button's, and the hover colour through the button's group.
        let theme = cx.theme();
        let (fg, muted) = (theme.foreground, theme.muted_foreground);
        let icon = svg()
            .path(icon)
            .size(px(15.))
            .text_color(if active { fg } else { muted })
            .when(!disabled, |s| s.group_hover(id, move |s| s.text_color(fg)));
        self.tool_with(id, icon.into_any_element(), tip, active, disabled, cx, f)
    }

    #[allow(clippy::too_many_arguments)]
    fn tool_with(
        &self,
        id: &'static str,
        content: AnyElement,
        tip: &'static str,
        active: bool,
        disabled: bool,
        cx: &mut Context<Self>,
        f: impl Fn(&mut RichView, &mut Window, &mut Context<RichView>) + 'static,
    ) -> Stateful<Div> {
        let theme = cx.theme();
        let (fg, muted, accent) = (theme.foreground, theme.muted_foreground, theme.accent);
        div()
            .id(id)
            .group(id)
            .h(px(28.))
            .min_w(px(28.))
            .px(px(6.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .text_color(if active { fg } else { muted })
            .when(active, |d| d.bg(accent))
            .when(disabled, |d| d.opacity(0.35))
            .when(!disabled && !active, |d| d.hover(move |s| s.bg(accent.opacity(0.4)).text_color(fg)).cursor_pointer())
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip).build(window, cx))
            .child(content)
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .when(!disabled, |d| d.on_click(cx.listener(move |this, _, window, cx| f(this, window, cx))))
    }

    /// `.markie-overlay-field`: the select and number boxes.
    fn field(&self, cx: &Context<Self>) -> Div {
        let theme = cx.theme();
        let light = !theme.mode.is_dark();
        let (bg, border) = if light {
            (theme.background, theme.foreground.opacity(0.14).blend(theme.border.opacity(0.86)))
        } else {
            (theme.background.blend(theme.muted.opacity(0.18)), theme.border)
        };
        div()
            .h(px(28.))
            .flex_none()
            .flex()
            .items_center()
            .rounded(px(7.))
            .border_1()
            .border_color(border)
            .bg(bg)
            .text_size(px(11.))
            .text_color(theme.foreground)
    }

    /// A field that opens a menu, drawn like a native `<select>`.
    fn select(&self, label: String, width: f32, cx: &Context<Self>) -> Div {
        let muted = cx.theme().foreground;
        self.field(cx)
            .w(px(width))
            .pl(px(8.))
            .pr(px(6.))
            .justify_between()
            .cursor_pointer()
            .child(div().truncate().child(label))
            .child(svg().path("icons/chevron-down.svg").size(px(12.)).text_color(muted))
    }

    pub(crate) fn render_toolbar(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = if self.source_mode { Default::default() } else { self.editor.toolbar() };
        let theme = cx.theme().clone();
        let weak = cx.entity().downgrade();
        let can_edit = !self.read_only;
        let source = self.source_mode;
        let selecting = self.editor.has_selection() && can_edit && !source;
        let (compact, primary_out, out) = fit(f32::from(self.toolbar_width));
        let shows = |g: Group| !out.contains(&g);
        let divider = || div().w(px(1.)).h(px(20.)).mx(px(4.)).bg(theme.border).flex_none();

        // Paragraph style.
        let style_label = BLOCK_STYLES.iter().find(|(_, s)| Some(*s) == t.style).map(|(l, _)| *l).unwrap_or("Normal text");
        let w = weak.clone();
        let current = t.style;
        let style_menu = div().id("rich-style").child(self.select(style_label.into(), if compact { 112. } else { 140. }, cx)).popup_menu_anchored(move |menu, _, _| {
            let mut menu = menu;
            for (label, style) in BLOCK_STYLES {
                let w = w.clone();
                menu = menu.item(PopupMenuItem::new(label).checked(current == Some(style)).on_click(move |_, window, cx| {
                    w.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_block_style(style))).ok();
                }));
            }
            menu
        });

        // Font: the selection's when there is one, else the document's.
        let font_label = if selecting {
            t.font_family
                .as_deref()
                .and_then(|f| DOC_FONTS.iter().find(|(_, _, s)| !s.is_empty() && *s == f))
                .map(|(_, l, _)| *l)
                .unwrap_or("Font…")
        } else {
            DOC_FONTS.iter().find(|(id, _, _)| *id == self.doc_font).map(|(_, l, _)| *l).unwrap_or("Theme font")
        };
        let w = weak.clone();
        let font_menu = div().id("rich-font").child(self.select(font_label.into(), if compact { 104. } else { 140. }, cx)).popup_menu_anchored(move |menu, _, _| {
            let mut menu = menu;
            for (id, label, stack) in DOC_FONTS {
                let w = w.clone();
                menu = menu.item(PopupMenuItem::new(label).on_click(move |_, window, cx| {
                    w.update(cx, |this, cx| {
                        if this.editor.has_selection() {
                            let v = (!stack.is_empty()).then(|| stack.to_string());
                            this.tool_edit(window, cx, |e| e.set_text_style(None, Some(v), None));
                        } else {
                            this.doc_font = id;
                            this.heights.iter_mut().for_each(|h| *h = None);
                            cx.notify();
                        }
                    })
                    .ok();
                }));
            }
            menu
        });

        // Size: the stepper and the number between.
        let size = if selecting {
            t.font_size.as_deref().and_then(|z| super::media::css_size(z, 16.)).map(clamp_font_size).unwrap_or(self.doc_size)
        } else {
            self.doc_size
        };
        let set_size = move |this: &mut RichView, window: &mut Window, cx: &mut Context<RichView>, next: f32| {
            let next = clamp_font_size(next);
            if this.editor.has_selection() {
                this.tool_edit(window, cx, |e| e.set_text_style(None, None, Some(Some(format!("{next}px")))));
            } else {
                this.doc_size = next;
                this.heights.iter_mut().for_each(|h| *h = None);
                cx.notify();
            }
        };
        let size_field = self.field(cx).w(px(38.)).justify_center().child(format!("{}", size as i32));

        // Text colour and highlight: a glyph and a small caret, each a menu.
        let muted = theme.muted_foreground;
        let fg = theme.foreground;
        let hover_bg = theme.accent.opacity(0.4);
        let w = weak.clone();
        let colour_menu = div()
            .id("rich-color")
            .h(px(28.))
            .px(px(4.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(2.))
            .rounded(px(4.))
            .text_color(muted)
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .cursor_pointer()
            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Text colour - Saved as HTML in the file").build(window, cx))
            .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).line_height(px(13.)).child("A"))
            .child(div().text_size(px(10.)).child("▾"))
            .popup_menu_anchored(move |menu, _, _| {
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
        let highlight_menu = div()
            .id("rich-highlight")
            .h(px(28.))
            .px(px(4.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(2.))
            .rounded(px(4.))
            .text_color(muted)
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .cursor_pointer()
            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Highlight colour - Saved as HTML in the file").build(window, cx))
            .group("rich-highlight")
            .child(svg().path("icons/highlighter.svg").size(px(15.)).text_color(muted).group_hover("rich-highlight", move |s| s.text_color(fg)))
            .child(div().text_size(px(10.)).child("▾"))
            .popup_menu_anchored(move |menu, _, _| {
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

        let zoom = self.zoom;
        let width = self.page_width;
        let align = t.align.clone().unwrap_or_default();
        let label = |text: String, w: f32| div().w(px(w)).flex_none().text_center().text_size(px(11.)).text_color(muted).child(text);

        let mut row: Vec<AnyElement> = Vec::new();
        if shows(Group::History) {
            row.push(self.tool("rt-undo", "icons/undo-2.svg", "Undo (⌘Z)", false, !can_edit || source || !t.can_undo, cx, |this, w, cx| this.tool_edit(w, cx, |e| {
                e.undo();
            })).into_any_element());
            row.push(self.tool("rt-redo", "icons/redo-2.svg", "Redo (⇧⌘Z)", false, !can_edit || source || !t.can_redo, cx, |this, w, cx| this.tool_edit(w, cx, |e| {
                e.redo();
            })).into_any_element());
        }
        if shows(Group::Output) {
            // Printing arrives with phase 5's PDF export; until then the
            // button is shown where Electron has it, and disabled.
            row.push(self.tool("rt-print", "icons/printer.svg", "Print (⌘P)", false, true, cx, |_, _, _| {}).into_any_element());
            row.push(self.tool("rt-history", "icons/clock.svg", "Version history", false, false, cx, |_, _, cx| cx.emit(RichEvent::History)).into_any_element());
        }
        if !compact {
            row.push(divider().into_any_element());
        }
        if shows(Group::View) {
            row.push(self.tool("rt-zoom-out", "icons/zoom-out.svg", "Zoom out (⌘-)", false, false, cx, move |_, _, cx| cx.emit(RichEvent::Zoom(step_zoom(zoom, false)))).into_any_element());
            row.push(label(zoom_label(zoom), 38.).into_any_element());
            row.push(self.tool("rt-zoom-in", "icons/zoom-in.svg", "Zoom in (⌘=)", false, false, cx, move |_, _, cx| cx.emit(RichEvent::Zoom(step_zoom(zoom, true)))).into_any_element());
            row.push(self.tool("rt-narrower", "icons/chevrons-right-left.svg", "Narrower page (⌥⌘[)", false, false, cx, move |_, _, cx| cx.emit(RichEvent::PageWidth(step_width(width, false)))).into_any_element());
            row.push(label(width_label(width), 52.).into_any_element());
            row.push(self.tool("rt-wider", "icons/chevrons-left-right.svg", "Wider page (⌥⌘])", false, false, cx, move |_, _, cx| cx.emit(RichEvent::PageWidth(step_width(width, true)))).into_any_element());
        }
        if !compact {
            row.push(divider().into_any_element());
        }
        if shows(Group::Selectors) {
            row.push(style_menu.into_any_element());
            row.push(font_menu.into_any_element());
        }
        if shows(Group::Size) {
            row.push(self.tool("rt-smaller", "icons/minus.svg", if selecting { "Smaller selected text" } else { "Smaller text (whole document)" }, false, size <= 11., cx, move |this, w, cx| set_size(this, w, cx, size - 1.)).into_any_element());
        }
        if !primary_out {
            row.push(size_field.into_any_element());
        }
        if shows(Group::Size) {
            row.push(self.tool("rt-larger", "icons/plus.svg", if selecting { "Larger selected text" } else { "Larger text (whole document)" }, false, size >= 32., cx, move |this, w, cx| set_size(this, w, cx, size + 1.)).into_any_element());
        }
        if !compact {
            row.push(divider().into_any_element());
        }
        if !primary_out {
            let glyph = |text: &'static str, f: fn(Div) -> Div| f(div().text_size(px(13.)).line_height(px(15.))).child(text).into_any_element();
            row.push(self.tool_with("rt-bold", glyph("B", |d| d.font_weight(FontWeight::BOLD)), "Bold (⌘B)", t.bold, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Bold))).into_any_element());
            row.push(self.tool_with("rt-italic", glyph("I", |d| d.italic().font_family("Georgia")), "Italic (⌘I)", t.italic, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Italic))).into_any_element());
            row.push(self.tool_with("rt-underline", glyph("U", |d| d.underline()), "Underline (⌘U) - Saved as HTML in the file", t.underline, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Underline))).into_any_element());
        }
        if shows(Group::Colour) {
            row.push(colour_menu.into_any_element());
            row.push(highlight_menu.into_any_element());
        }
        if shows(Group::Marks) {
            row.push(self.tool("rt-strike", "icons/strikethrough.svg", "Strikethrough (⇧⌘X)", t.strike, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Strike))).into_any_element());
            row.push(self.tool("rt-code", "icons/code.svg", "Inline code (⌘E)", t.code, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Code))).into_any_element());
        }
        if shows(Group::Insert) {
            if !compact {
                row.push(divider().into_any_element());
            }
            row.push(self.tool("rt-link", "icons/link.svg", "Insert link (⇧⌘K)", false, !can_edit, cx, |this, w, cx| this.open_prompt(PromptKind::Link, w, cx)).into_any_element());
            row.push(self.tool("rt-image", "icons/image.svg", "Insert image", false, !can_edit, cx, |this, w, cx| this.open_prompt(PromptKind::Image, w, cx)).into_any_element());
        }
        if !compact {
            row.push(divider().into_any_element());
        }
        if shows(Group::Lists) {
            row.push(self.tool("rt-bullet", "icons/list.svg", "Bullet list (⇧⌘8)", t.list == Some(ListKind::Bullet), !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Bullet))).into_any_element());
            row.push(self.tool("rt-ordered", "icons/list-ordered.svg", "Numbered list (⇧⌘7)", t.list == Some(ListKind::Ordered), !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Ordered))).into_any_element());
        }
        if shows(Group::Task) {
            row.push(self.tool("rt-task", "icons/list-todo.svg", "Task list (⇧⌘9)", t.list == Some(ListKind::Task), !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Task))).into_any_element());
        }
        if shows(Group::Alignment) {
            row.push(self.tool("rt-left", "icons/text-align-start.svg", "Align left (⇧⌘L) - Saved as HTML in the file", align == "left", !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("left")))).into_any_element());
            row.push(self.tool("rt-center", "icons/text-align-center.svg", "Align centre (⇧⌘E) - Saved as HTML in the file", align == "center", !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("center")))).into_any_element());
            row.push(self.tool("rt-right", "icons/text-align-end.svg", "Align right (⇧⌘R) - Saved as HTML in the file", align == "right", !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("right")))).into_any_element());
        }
        if shows(Group::Clear) {
            if !compact {
                row.push(divider().into_any_element());
            }
            row.push(self.tool("rt-clear", "icons/remove-formatting.svg", "Clear formatting (⌘\\)", false, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.clear_formatting())).into_any_element());
        }
        if compact {
            row.push(self.more_menu(&out, primary_out, cx).into_any_element());
        }

        let store = self.store.clone();
        let view = cx.entity().downgrade();
        let last = self.toolbar_width;
        h_flex()
            .id("rich-toolbar")
            .relative()
            .flex_none()
            .w_full()
            .min_w_0()
            .gap(px(2.))
            .px(px(8.))
            .py(px(4.))
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.muted)
            .children(row)
            .child(
                // The row's width, for fitting its groups next frame.
                canvas(
                    move |bounds, window, cx| {
                        let _ = &store;
                        if (bounds.size.width - last).abs() > px(0.5) {
                            let w = bounds.size.width;
                            let v = view.clone();
                            window.defer(cx, move |_, cx| {
                                v.update(cx, |this, cx| {
                                    this.toolbar_width = w;
                                    cx.notify();
                                })
                                .ok();
                            });
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }

    /// The "more" button: the groups that did not fit, as a menu.
    fn more_menu(&self, out: &[Group], primary_out: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (muted, fg, hover_bg) = (theme.muted_foreground, theme.foreground, theme.accent.opacity(0.4));
        let w = cx.entity().downgrade();
        let out = out.to_vec();
        let zoom = self.zoom;
        let width = self.page_width;
        div()
            .id("rich-more")
            .h(px(28.))
            .min_w(px(28.))
            .px(px(6.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .text_color(muted)
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .cursor_pointer()
            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("More formatting and viewing controls").build(window, cx))
            .group("rich-more")
            .child(svg().path("icons/ellipsis.svg").size(px(15.)).text_color(muted).group_hover("rich-more", move |s| s.text_color(fg)))
            .popup_menu_anchored(move |menu, _, _| {
                let mut menu = menu;
                let act = |label: &'static str, f: Box<dyn Fn(&mut RichView, &mut Window, &mut Context<RichView>)>| {
                    let w = w.clone();
                    PopupMenuItem::new(label).on_click(move |_, window, cx| {
                        w.update(cx, |this, cx| f(this, window, cx)).ok();
                    })
                };
                let has = |g: Group| out.contains(&g);
                if has(Group::History) {
                    menu = menu.item(act("Undo", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| { e.undo(); }))));
                    menu = menu.item(act("Redo", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| { e.redo(); }))));
                }
                if has(Group::Output) {
                    menu = menu.item(act("Version history", Box::new(|_, _, cx| cx.emit(RichEvent::History))));
                }
                if has(Group::View) {
                    menu = menu.item(act("Zoom out", Box::new(move |_, _, cx| cx.emit(RichEvent::Zoom(step_zoom(zoom, false))))));
                    menu = menu.item(act("Zoom in", Box::new(move |_, _, cx| cx.emit(RichEvent::Zoom(step_zoom(zoom, true))))));
                    menu = menu.item(act("Narrower page", Box::new(move |_, _, cx| cx.emit(RichEvent::PageWidth(step_width(width, false))))));
                    menu = menu.item(act("Wider page", Box::new(move |_, _, cx| cx.emit(RichEvent::PageWidth(step_width(width, true))))));
                }
                if has(Group::Selectors) {
                    for (label, style) in BLOCK_STYLES {
                        menu = menu.item(act(label, Box::new(move |this, w, cx| this.tool_edit(w, cx, |e| e.set_block_style(style)))));
                    }
                }
                if primary_out {
                    menu = menu.item(act("Bold", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Bold)))));
                    menu = menu.item(act("Italic", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Italic)))));
                    menu = menu.item(act("Underline", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Underline)))));
                }
                if has(Group::Marks) {
                    menu = menu.item(act("Strikethrough", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Strike)))));
                    menu = menu.item(act("Inline code", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Code)))));
                }
                if has(Group::Insert) {
                    menu = menu.item(act("Insert link", Box::new(|this, w, cx| this.open_prompt(PromptKind::Link, w, cx))));
                    menu = menu.item(act("Insert image", Box::new(|this, w, cx| this.open_prompt(PromptKind::Image, w, cx))));
                }
                if has(Group::Lists) {
                    menu = menu.item(act("Bullet list", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Bullet)))));
                    menu = menu.item(act("Numbered list", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Ordered)))));
                }
                if has(Group::Task) {
                    menu = menu.item(act("Task list", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Task)))));
                }
                if has(Group::Alignment) {
                    menu = menu.item(act("Align left", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("left"))))));
                    menu = menu.item(act("Align centre", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("center"))))));
                    menu = menu.item(act("Align right", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("right"))))));
                }
                if has(Group::Clear) {
                    menu = menu.item(act("Clear formatting", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.clear_formatting()))));
                }
                // Formula, display formula, table and rule have no toolbar
                // button in Electron either; they live here.
                menu = menu.separator();
                menu = menu.item(act("Formula…", Box::new(|this, w, cx| this.open_prompt(PromptKind::InlineMath { at: None }, w, cx))));
                menu = menu.item(act("Display formula", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.insert_math_block("x^2")))));
                menu = menu.item(act("Table", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.insert_table(3, 3)))));
                menu = menu.item(act("Horizontal rule", Box::new(|this, w, cx| this.tool_edit(w, cx, |e| e.insert_rule()))));
                menu
            })
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

    /// `find-bar.tsx`: a small card floating at the top right of the page,
    /// with the replace row behind a disclosure.
    pub(crate) fn render_find(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let f = self.find.as_ref()?;
        let theme = cx.theme();
        let query = self.find_query(cx);
        let empty = f.matches.is_empty();
        let count = if query.is_empty() {
            String::new()
        } else if empty {
            "No results".into()
        } else {
            format!("{} of {}", f.current + 1, f.matches.len())
        };
        let (muted, fg, accent) = (theme.muted_foreground, theme.foreground, theme.accent);
        let field = |red: bool| {
            h_flex()
                .h(px(26.))
                .px(px(8.))
                .gap(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(if red { theme.danger } else { theme.border })
                .bg(theme.muted)
                .text_size(px(12.))
        };
        let toggle = |id: &'static str, label: &'static str, tip: &'static str, on: bool| {
            div()
                .id(id)
                .h(px(20.))
                .min_w(px(22.))
                .px(px(6.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .text_size(px(11.))
                .text_color(if on { fg } else { muted })
                .when(on, |d| d.bg(accent))
                .when(!on, |d| d.hover(move |s| s.bg(accent.opacity(0.4)).text_color(fg)))
                .cursor_pointer()
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip).build(window, cx))
                .child(label)
        };
        let action = |id: &'static str, label: &'static str, tip: &'static str, disabled: bool| {
            div()
                .id(id)
                .h(px(22.))
                .px(px(8.))
                .flex()
                .items_center()
                .rounded(px(4.))
                .text_size(px(11.))
                .text_color(muted)
                .when(disabled, |d| d.opacity(0.4))
                .when(!disabled, |d| d.hover(move |s| s.bg(accent.opacity(0.4)).text_color(fg)).cursor_pointer())
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip).build(window, cx))
                .child(label)
        };
        let close = |this: &mut RichView, window: &mut Window, cx: &mut Context<RichView>| {
            this.find = None;
            this.focus(window, cx);
            cx.notify();
        };
        let show_replace = f.show_replace;
        let can_replace = !self.read_only;
        let top = v_flex()
            .id("rich-find")
            .absolute()
            .top(px(8.))
            .right(px(12.))
            .gap(px(6.))
            .px(px(8.))
            .py(px(6.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.secondary)
            .shadow_2xl()
            .capture_key_down(cx.listener(move |this, ev: &KeyDownEvent, window, cx| {
                if ev.keystroke.key == "escape" {
                    cx.stop_propagation();
                    close(this, window, cx);
                }
            }))
            .child(
                h_flex()
                    .gap(px(6.))
                    .child(
                        div()
                            .id("find-disclose")
                            .h(px(22.))
                            .w(px(16.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(10.))
                            .text_color(muted)
                            .cursor_pointer()
                            .hover(move |s| s.text_color(fg))
                            .child(if show_replace { "▾" } else { "▸" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(f) = &mut this.find {
                                    f.show_replace = !f.show_replace;
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        field(!query.is_empty() && empty)
                            .child(div().w(px(168.)).child(Input::new(&f.query).appearance(false).xsmall()))
                            .child(toggle("find-case", "Aa", "Match case", f.case_sensitive).on_click(cx.listener(|this, _, _, cx| {
                                if let Some(f) = &mut this.find {
                                    f.case_sensitive = !f.case_sensitive;
                                }
                                cx.notify();
                            })))
                            .child(toggle("find-word", "ab", "Whole word", f.whole_word).on_click(cx.listener(|this, _, _, cx| {
                                if let Some(f) = &mut this.find {
                                    f.whole_word = !f.whole_word;
                                }
                                cx.notify();
                            }))),
                    )
                    .child(div().w(px(64.)).text_right().text_size(px(11.)).text_color(muted).child(count))
                    .child(action("find-prev", "↑", "Previous match (⇧⏎)", empty).on_click(cx.listener(|this, _, _, cx| this.find_step(false, cx))))
                    .child(action("find-next", "↓", "Next match (⏎)", empty).on_click(cx.listener(|this, _, _, cx| this.find_step(true, cx))))
                    .child(action("find-close", "✕", "Close (Esc)", false).on_click(cx.listener(move |this, _, window, cx| close(this, window, cx)))),
            )
            .when(show_replace, |d| {
                d.child(
                    h_flex()
                        .gap(px(6.))
                        .pl(px(22.))
                        .child(field(false).child(div().w(px(168.)).child(Input::new(&f.replace).appearance(false).xsmall())))
                        .when(can_replace, |d| {
                            d.child(action("find-replace", "Replace", "Replace this match", empty).on_click(cx.listener(|this, _, _, cx| this.replace_one(cx))))
                                .child(action("find-all", "All", "Replace every match", empty).on_click(cx.listener(|this, _, _, cx| this.replace_all(cx))))
                        })
                        .when(!can_replace, |d| d.child(div().px(px(4.)).text_size(px(11.)).text_color(muted).child("View only"))),
                )
            });
        Some(top.into_any_element())
    }
}

impl Render for RichView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let started = std::time::Instant::now();
        self.source_mode = false;
        let toolbar = (!self.read_only).then(|| self.render_toolbar(window, cx));
        let prompt = self.render_prompt(cx);
        let doc = self.render_document(window, cx);
        let find = self.render_find(cx);
        let rail = self.render_rail(cx);
        if std::env::var("MARKIE_RICH_DEBUG").is_ok() {
            eprintln!("render {} blocks in {:?}", self.editor.block_count(), started.elapsed());
        }
        gpui_kit::component::v_flex()
            .size_full()
            .children(toolbar)
            .children(prompt)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(doc)
                    .children(rail)
                    .children(find)
                    .children(self.render_table_bar(cx))
                    .children(self.render_math_field(cx))
                    .children(self.render_link_card(window, cx)),
            )
    }
}
