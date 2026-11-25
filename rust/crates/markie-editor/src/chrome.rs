//! The formatting toolbar (`formatting-toolbar.tsx`), the find bar and the
//! one-line prompt, around the document.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
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
/// The toolbar's parts in Electron's DOM order, each one `OverflowTools`
/// wrapper: in the row, or one row of the "more" popover.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Part {
    History,
    Output,
    View,
    Selectors,
    SizeDown,
    SizeBox,
    SizeUp,
    Primary,
    Colour,
    Marks,
    Insert,
    Lists,
    Task,
    Alignment,
    Clear,
}

const PARTS: [Part; 15] = [
    Part::History,
    Part::Output,
    Part::View,
    Part::Selectors,
    Part::SizeDown,
    Part::SizeBox,
    Part::SizeUp,
    Part::Primary,
    Part::Colour,
    Part::Marks,
    Part::Insert,
    Part::Lists,
    Part::Task,
    Part::Alignment,
    Part::Clear,
];

impl Part {
    /// The fitting group it leaves with; None for the primary row.
    fn group(self) -> Option<Group> {
        Some(match self {
            Part::History => Group::History,
            Part::Output => Group::Output,
            Part::View => Group::View,
            Part::Selectors => Group::Selectors,
            Part::SizeDown | Part::SizeUp => Group::Size,
            Part::SizeBox | Part::Primary => return None,
            Part::Colour => Group::Colour,
            Part::Marks => Group::Marks,
            Part::Insert => Group::Insert,
            Part::Lists => Group::Lists,
            Part::Task => Group::Task,
            Part::Alignment => Group::Alignment,
            Part::Clear => Group::Clear,
        })
    }

    /// The full row's dividers: after history and print, around zoom and
    /// width, after size, before insert, before lists and before clear.
    fn divider_before(self) -> bool {
        matches!(self, Part::View | Part::Selectors | Part::Primary | Part::Insert | Part::Lists | Part::Clear)
    }
}

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

/// The size box: Electron's `<input type="number">` (min 1, max 400,
/// step 0.5), whose value goes through `clampFontSize` (11 to 32, whole
/// pixels).
pub(crate) struct SizeField {
    pub(crate) state: Entity<InputState>,
    /// The size the box last showed, so a frame only rewrites it when the
    /// size changed from elsewhere.
    shown: f32,
    _subs: Vec<Subscription>,
}

/// A typed size, as the number input takes it: a finite number from 1 to
/// 400 in half steps, then clamped like `clampFontSize`. None leaves the
/// size alone (an empty box, a letter, a value out of range).
pub(crate) fn typed_size(text: &str) -> Option<f32> {
    let v: f32 = text.trim().parse().ok()?;
    (v.is_finite() && (1.0..=400.0).contains(&v) && (v * 2.).fract() == 0.).then(|| clamp_font_size(v))
}

/// While typing, only a value that is already a size takes effect, so
/// typing "14" does not pass through 11 on the way (see `typed_size`).
fn typing_size(text: &str) -> Option<f32> {
    let v: f32 = text.trim().parse().ok()?;
    (v.is_finite() && (11.0..=32.0).contains(&v)).then(|| clamp_font_size(v))
}

/// Whether a part sits in the "more" popover rather than the row.
fn part_in_menu(p: Part, compact: bool, primary_out: bool, out: &[Group]) -> bool {
    compact && p.group().map_or(primary_out, |g| out.contains(&g))
}

impl RichView {
    /// The toolbar's size, for the selection or the whole document.
    pub(crate) fn toolbar_size(&self) -> f32 {
        let selecting = self.editor.has_selection() && !self.read_only && !self.source_mode;
        if selecting {
            let t = self.editor.toolbar();
            t.font_size.as_deref().and_then(|z| super::media::css_size(z, 16.)).map(clamp_font_size).unwrap_or(self.doc_size)
        } else {
            self.doc_size
        }
    }

    /// `setSize`: the selection's size when text is selected, else the
    /// document's. `refocus` gives the document focus back (the stepper);
    /// the typed box keeps it.
    pub(crate) fn apply_size(&mut self, next: f32, refocus: bool, window: &mut Window, cx: &mut Context<Self>) {
        let next = clamp_font_size(next);
        if self.editor.has_selection() {
            if self.read_only || self.source_mode {
                return;
            }
            self.edit(cx, |e| e.set_text_style(None, None, Some(Some(format!("{next}px")))));
            if refocus {
                self.focus(window, cx);
            }
        } else {
            self.doc_size = next;
            self.heights.iter_mut().for_each(|h| *h = None);
            cx.notify();
        }
    }

    /// The document's face and size with nothing selected, as the toolbar's
    /// font menu and size stepper set them (the app's scene mode uses it).
    /// An unknown font id leaves the face as it is.
    pub fn scene_doc_font(&mut self, font: &str, size: Option<f32>, cx: &mut Context<Self>) {
        if let Some((id, ..)) = DOC_FONTS.iter().find(|(id, ..)| *id == font) {
            self.doc_font = id;
        }
        if let Some(size) = size {
            self.doc_size = clamp_font_size(size);
        }
        self.heights.iter_mut().for_each(|h| *h = None);
        cx.notify();
    }

    /// One line per table drawn in the last frame: its box width, the rows'
    /// width, whether it scrolls, and anything that disagrees: rows wider
    /// than a box that does not scroll, or a cell's text past the table's
    /// right edge. The app's scene mode prints it.
    pub fn table_report(&self) -> Vec<String> {
        let s = self.store.borrow();
        let mut keys: Vec<_> = s.table_boxes.keys().cloned().collect();
        keys.sort();
        keys.iter()
            .map(|key| {
                let (bounds, left, body, overflows) = s.table_boxes[key];
                let right = left + px(body).min(bounds.size.width);
                let mut problems = Vec::new();
                if !overflows && body > f32::from(bounds.size.width) + 0.5 {
                    problems.push(format!("rows {body:.1} wider than the box"));
                }
                let escaping = s
                    .leaves
                    .iter()
                    .filter(|(k, p)| k.0 == key.0 && !overflows && p.bounds.origin.y >= bounds.origin.y && p.bounds.origin.y < bounds.origin.y + bounds.size.height && p.bounds.right() > right + px(0.5))
                    .count();
                if escaping > 0 {
                    problems.push(format!("{escaping} cells past the right edge"));
                }
                // A cell narrower than its widest word cuts the word across
                // lines, and the row then grows by a line its other cells
                // centre in.
                let cut = s
                    .leaves
                    .iter()
                    .filter(|(k, p)| k.0 == key.0 && s.table_words.get(*k).is_some_and(|w| f32::from(p.bounds.size.width) + 0.01 < *w))
                    .count();
                if cut > 0 {
                    problems.push(format!("{cut} cells narrower than a word"));
                }
                format!(
                    "table block {} box {:.1} rows {:.1} {} {}",
                    key.0,
                    f32::from(bounds.size.width),
                    body,
                    if overflows { "scrolls" } else { "fits" },
                    if problems.is_empty() { "ok".to_string() } else { problems.join(", ") }
                )
            })
            .collect()
    }

    /// The size box, made once, and kept showing the current size while it
    /// is not being typed in.
    fn size_input(&mut self, size: f32, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if self.size_field.is_none() {
            let state = cx.new(|cx| InputState::new(window, cx));
            state.update(cx, |s, cx| s.set_value(format!("{}", size as i32), window, cx));
            let sub = cx.subscribe_in(&state, window, |this, state, ev: &InputEvent, window, cx| {
                let text = state.read(cx).value().to_string();
                match ev {
                    InputEvent::Change => {
                        if let Some(v) = typing_size(&text) {
                            this.apply_size(v, false, window, cx);
                        }
                    }
                    InputEvent::PressEnter { .. } | InputEvent::Blur => {
                        if let Some(v) = typed_size(&text) {
                            this.apply_size(v, false, window, cx);
                        }
                        // Show what took effect, as the controlled input
                        // does once React renders the clamped size.
                        let now = this.toolbar_size();
                        state.update(cx, |s, cx| s.set_value(format!("{}", now as i32), window, cx));
                        if let Some(f) = &mut this.size_field {
                            f.shown = now;
                        }
                    }
                    InputEvent::Focus => {}
                }
            });
            self.size_field = Some(SizeField { state, shown: size, _subs: vec![sub] });
        }
        let field = self.size_field.as_mut().unwrap();
        let state = field.state.clone();
        let focused = state.read(cx).focus_handle(cx).is_focused(window);
        if !focused && field.shown != size {
            field.shown = size;
            state.update(cx, |s, cx| s.set_value(format!("{}", size as i32), window, cx));
        }
        state
    }

    /// The number input's arrow keys: one step up or down.
    fn step_size_field(&mut self, up: bool, window: &mut Window, cx: &mut Context<Self>) {
        let now = self.toolbar_size();
        let next = clamp_font_size(now + if up { 1. } else { -1. });
        self.apply_size(next, false, window, cx);
        if let Some(f) = &mut self.size_field {
            f.shown = next;
            f.state.update(cx, |s, cx| s.set_value(format!("{}", next as i32), window, cx));
        }
    }

    /// Run an editor command from the toolbar and give the document focus.
    fn tool_edit(&mut self, window: &mut Window, cx: &mut Context<Self>, f: impl FnOnce(&mut Editor)) {
        self.more_open = false;
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
        label: &'static str,
        menu: bool,
        active: bool,
        disabled: bool,
        cx: &mut Context<Self>,
        f: impl Fn(&mut RichView, &mut Window, &mut Context<RichView>) + 'static,
    ) -> AnyElement {
        // GPUI draws an SVG in its own colour, not its parent's: give it the
        // button's, and the hover colour through the button's group.
        let theme = cx.theme();
        let (fg, muted) = (theme.foreground, theme.muted_foreground);
        let icon = svg()
            .path(icon)
            .size(px(15.))
            .text_color(if active { fg } else { muted })
            .when(!disabled, |s| s.group_hover(id, move |s| s.text_color(fg)));
        self.tool_with(id, icon.into_any_element(), tip, label, menu, active, disabled, cx, f)
    }

    #[allow(clippy::too_many_arguments)]
    fn tool_with(
        &self,
        id: &'static str,
        content: AnyElement,
        tip: &'static str,
        label: &'static str,
        menu: bool,
        active: bool,
        disabled: bool,
        cx: &mut Context<Self>,
        f: impl Fn(&mut RichView, &mut Window, &mut Context<RichView>) + 'static,
    ) -> AnyElement {
        // In the "more" popover a button also shows its name after the icon
        // (`[&_button]:after:content-[attr(aria-label)]`, 11 px, 8 px gap).
        let content = if menu {
            h_flex().gap(px(8.)).child(content).child(div().text_size(px(11.)).child(label)).into_any_element()
        } else {
            content
        };
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
            .when(!disabled, |d| {
                d.on_click(cx.listener(move |this, _, window, cx| {
                    this.more_open = false;
                    f(this, window, cx)
                }))
            })
            .into_any_element()
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

    pub(crate) fn render_toolbar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = if self.source_mode { Default::default() } else { self.editor.toolbar() };
        let theme = cx.theme().clone();
        let weak = cx.entity().downgrade();
        let can_edit = !self.read_only;
        let source = self.source_mode;
        let selecting = self.editor.has_selection() && can_edit && !source;
        let (compact, primary_out, out) = fit(f32::from(self.toolbar_width));
        let divider = || div().w(px(1.)).h(px(20.)).mx(px(4.)).bg(theme.border).flex_none();

        // Paragraph style.
        let style_label = BLOCK_STYLES.iter().find(|(_, s)| Some(*s) == t.style).map(|(l, _)| *l).unwrap_or("Normal text");
        // formatting-toolbar.tsx: a view-only document's paragraph style is
        // `disabled={!canEdit}` (35%), reads "Normal text" and opens nothing.
        let style_label = if can_edit { style_label } else { "Normal text" };
        let w = weak.clone();
        let current = t.style;
        let style_select = self.select(style_label.into(), if compact { 112. } else { 140. }, cx);
        let style_menu = if !can_edit {
            div().id("rich-style").opacity(0.35).child(style_select.cursor_default()).into_any_element()
        } else {
            div().id("rich-style").child(style_select).popup_menu_anchored(move |menu, _, _| {
            let mut menu = menu;
            for (label, style) in BLOCK_STYLES {
                let w = w.clone();
                menu = menu.item(PopupMenuItem::new(label).checked(current == Some(style)).on_click(move |_, window, cx| {
                    w.update(cx, |this, cx| this.tool_edit(window, cx, |e| e.set_block_style(style))).ok();
                }));
            }
            menu
        }).into_any_element()
        };

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
                            this.more_open = false;
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
            this.apply_size(next, true, window, cx);
        };
        let size_state = self.size_input(size, window, cx);
        let size_title: &'static str = if selecting { "Size of the selected text - Saved as HTML in the file" } else { "Font size for the whole document" };
        let size_field = self
            .field(cx)
            .id("rt-size")
            .w(px(38.))
            .justify_center()
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(size_title).build(window, cx))
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                let k = &ev.keystroke;
                if !k.modifiers.modified() && (k.key == "up" || k.key == "down") {
                    cx.stop_propagation();
                    window.prevent_default();
                    this.step_size_field(k.key == "up", window, cx);
                }
            }))
            .child(Input::new(&size_state).appearance(false).text_size(px(11.)).text_center().w_full());

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

        let mut style_menu = Some(style_menu);
        let mut font_menu = Some(font_menu.into_any_element());
        let mut size_field = Some(size_field.into_any_element());
        let mut colour_menu = Some(colour_menu.into_any_element());
        let mut highlight_menu = Some(highlight_menu.into_any_element());
        let zoom = self.zoom;
        let width = self.page_width;
        let align = t.align.clone().unwrap_or_default();
        let label = |text: String, w: f32| div().w(px(w)).flex_none().text_center().text_size(px(11.)).text_color(muted).child(text).into_any_element();
        // A part goes to the "more" popover when its group does not fit
        // (`OverflowTools`); the size box and B I U go with the primary row.
        let in_menu = |p: Part| part_in_menu(p, compact, primary_out, &out);
        let off = !can_edit || source;

        let mut parts: Vec<(Part, Vec<AnyElement>)> = Vec::with_capacity(PARTS.len());
        for part in PARTS {
            let m = in_menu(part);
            let els: Vec<AnyElement> = match part {
                Part::History => vec![
                    self.tool("rt-undo", "icons/undo-2.svg", "Undo (⌘Z)", "Undo", m, false, off || !t.can_undo, cx, |this, w, cx| this.tool_edit(w, cx, |e| {
                        e.undo();
                    })),
                    self.tool("rt-redo", "icons/redo-2.svg", "Redo (⇧⌘Z)", "Redo", m, false, off || !t.can_redo, cx, |this, w, cx| this.tool_edit(w, cx, |e| {
                        e.redo();
                    })),
                ],
                Part::Output => vec![
                    // The host prints through its export path (RichEvent::Print).
                    self.tool("rt-print", "icons/printer.svg", "Print (⌘P)", "Print", m, false, false, cx, |_, _, cx| cx.emit(RichEvent::Print)),
                    self.tool("rt-history", "icons/clock.svg", "Version history", "History", m, false, false, cx, |_, _, cx| cx.emit(RichEvent::History)),
                ],
                Part::View => vec![
                    self.tool("rt-zoom-out", "icons/zoom-out.svg", "Zoom out (⌘-)", "Zoom out", m, false, false, cx, move |_, _, cx| cx.emit(RichEvent::Zoom(step_zoom(zoom, false)))),
                    label(zoom_label(zoom), 38.),
                    self.tool("rt-zoom-in", "icons/zoom-in.svg", "Zoom in (⌘=)", "Zoom in", m, false, false, cx, move |_, _, cx| cx.emit(RichEvent::Zoom(step_zoom(zoom, true)))),
                    self.tool("rt-narrower", "icons/chevrons-right-left.svg", "Narrower page (⌥⌘[)", "Narrower", m, false, false, cx, move |_, _, cx| cx.emit(RichEvent::PageWidth(step_width(width, false)))),
                    label(width_label(width), 52.),
                    self.tool("rt-wider", "icons/chevrons-left-right.svg", "Wider page (⌥⌘])", "Wider", m, false, false, cx, move |_, _, cx| cx.emit(RichEvent::PageWidth(step_width(width, true)))),
                ],
                Part::Selectors => vec![style_menu.take().unwrap(), font_menu.take().unwrap()],
                Part::SizeDown => vec![self.tool("rt-smaller", "icons/minus.svg", if selecting { "Smaller selected text" } else { "Smaller text (whole document)" }, "Decrease font size", m, false, size <= 11., cx, move |this, w, cx| set_size(this, w, cx, size - 1.))],
                Part::SizeBox => vec![size_field.take().unwrap()],
                Part::SizeUp => vec![self.tool("rt-larger", "icons/plus.svg", if selecting { "Larger selected text" } else { "Larger text (whole document)" }, "Increase font size", m, false, size >= 32., cx, move |this, w, cx| set_size(this, w, cx, size + 1.))],
                Part::Primary => {
                    let glyph = |text: &'static str, f: fn(Div) -> Div| f(div().text_size(px(13.)).line_height(px(15.))).child(text).into_any_element();
                    vec![
                        self.tool_with("rt-bold", glyph("B", |d| d.font_weight(FontWeight::BOLD)), "Bold (⌘B)", "Bold", m, t.bold, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Bold))),
                        self.tool_with("rt-italic", glyph("I", |d| d.italic().font_family("Georgia")), "Italic (⌘I)", "Italic", m, t.italic, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Italic))),
                        self.tool_with("rt-underline", glyph("U", |d| d.underline()), "Underline (⌘U) - Saved as HTML in the file", "Underline", m, t.underline, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Underline))),
                    ]
                }
                Part::Colour => vec![colour_menu.take().unwrap(), highlight_menu.take().unwrap()],
                Part::Marks => vec![
                    self.tool("rt-strike", "icons/strikethrough.svg", "Strikethrough (⇧⌘X)", "Strikethrough", m, t.strike, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Strike))),
                    self.tool("rt-code", "icons/code.svg", "Inline code (⌘E)", "Inline code", m, t.code, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_mark(MarkKind::Code))),
                ],
                Part::Insert => vec![
                    self.tool("rt-link", "icons/link.svg", "Insert link (⇧⌘K)", "Insert link", m, false, !can_edit, cx, |this, w, cx| this.open_prompt(PromptKind::Link, w, cx)),
                    self.tool("rt-image", "icons/image.svg", "Insert image", "Insert image", m, false, !can_edit, cx, |this, w, cx| this.open_prompt(PromptKind::Image, w, cx)),
                ],
                Part::Lists => vec![
                    self.tool("rt-bullet", "icons/list.svg", "Bullet list (⇧⌘8)", "Bullet list", m, t.list == Some(ListKind::Bullet), !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Bullet))),
                    self.tool("rt-ordered", "icons/list-ordered.svg", "Numbered list (⇧⌘7)", "Numbered list", m, t.list == Some(ListKind::Ordered), !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Ordered))),
                ],
                Part::Task => vec![self.tool("rt-task", "icons/list-todo.svg", "Task list (⇧⌘9)", "Task list", m, t.list == Some(ListKind::Task), !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.toggle_list(ListKind::Task)))],
                Part::Alignment => vec![
                    self.tool("rt-left", "icons/text-align-start.svg", "Align left (⇧⌘L) - Saved as HTML in the file", "Align left", m, align == "left", !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("left")))),
                    self.tool("rt-center", "icons/text-align-center.svg", "Align centre (⇧⌘E) - Saved as HTML in the file", "Align centre", m, align == "center", !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("center")))),
                    self.tool("rt-right", "icons/text-align-end.svg", "Align right (⇧⌘R) - Saved as HTML in the file", "Align right", m, align == "right", !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.set_align(Some("right")))),
                ],
                Part::Clear => vec![self.tool("rt-clear", "icons/remove-formatting.svg", "Clear formatting (⌘\\)", "Clear formatting", m, false, !can_edit, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.clear_formatting()))],
            };
            parts.push((part, els));
        }

        let mut row: Vec<AnyElement> = Vec::new();
        let mut menu_rows: Vec<Vec<AnyElement>> = Vec::new();
        for (part, els) in parts {
            if in_menu(part) {
                menu_rows.push(els);
                continue;
            }
            if !compact && part.divider_before() {
                row.push(divider().into_any_element());
            }
            row.extend(els);
        }
        if !compact {
            self.more_open = false;
        }
        if compact {
            row.push(self.more_button(cx).into_any_element());
        }
        if compact && self.more_open {
            // Formula, display formula, table and rule are Electron's format
            // rail buttons (`format-rail.tsx`). Markie RS has no format rail
            // yet, so they wait here, as the popover's last row.
            let m = true;
            menu_rows.push(vec![
                self.tool("rt-formula", "icons/sigma.svg", "Insert formula", "Formula", m, false, !can_edit || source, cx, |this, w, cx| this.open_prompt(PromptKind::InlineMath { at: None }, w, cx)),
                self.tool("rt-math-block", "icons/sigma.svg", "Insert display formula", "Display formula", m, false, !can_edit || source, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.insert_math_block("x^2"))),
                self.tool("rt-table", "icons/table.svg", "Insert table", "Table", m, false, !can_edit || source, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.insert_table(3, 3))),
                self.tool("rt-rule", "icons/minus.svg", "Horizontal rule", "Horizontal rule", m, false, !can_edit || source, cx, |this, w, cx| this.tool_edit(w, cx, |e| e.insert_rule())),
            ]);
        }
        let popover = (compact && self.more_open).then(|| self.more_popover(menu_rows, window, cx));

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
            .children(popover)
            .into_any_element()
    }

    /// The "more" button (`aria-haspopup="dialog"`): opens and closes the
    /// popover that holds the controls that did not fit.
    fn more_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (muted, fg, hover_bg, accent) = (theme.muted_foreground, theme.foreground, theme.accent.opacity(0.4), theme.accent);
        let open = self.more_open;
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
            .when(open, |d| d.bg(accent))
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .cursor_pointer()
            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("More formatting and viewing controls").build(window, cx))
            .group("rich-more")
            .child(svg().path("icons/ellipsis.svg").size(px(15.)).text_color(if open { fg } else { muted }).group_hover("rich-more", move |s| s.text_color(fg)))
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_click(cx.listener(|this, _, _, cx| {
                this.more_open = !this.more_open;
                cx.notify();
            }))
    }

    /// `.markie-format-overflow`: 320 px, 8 px corners, surface-2, a shadow,
    /// at the toolbar's right below it. Each part that left the row is one
    /// wrapping row of its real controls, labelled, with a rule between.
    /// A click outside closes it; so does any button in it.
    fn more_popover(&self, rows: Vec<Vec<AnyElement>>, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let (border, surface2) = (theme.border, theme.secondary);
        let count = rows.len();
        let body = div()
            .id("rich-more-popover")
            .absolute()
            .top_full()
            .right(px(8.))
            .mt(px(4.))
            .w(px(320.))
            .max_h(window.viewport_size().height * 0.6)
            .overflow_y_scroll()
            .rounded(px(8.))
            .border_1()
            .border_color(border)
            .bg(surface2)
            .p(px(4.))
            .shadow_lg()
            .occlude()
            .children(rows.into_iter().enumerate().map(move |(i, els)| {
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .p(px(4.))
                    .when(i + 1 < count, |d| d.border_b_1().border_color(border))
                    .children(els)
            }));
        // Behind the popover, the rest of the window: a click there closes
        // it. Menus the popover opens (style, font, colour) float above both.
        let backdrop = div()
            .id("rich-more-backdrop")
            .absolute()
            .top(px(-4000.))
            .left(px(-4000.))
            .w(px(12000.))
            .h(px(12000.))
            .occlude()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
                this.more_open = false;
                cx.notify();
            }));
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(deferred(backdrop).with_priority(1))
            .child(deferred(body).with_priority(2))
            .into_any_element()
    }

    /// The `role="status"` pill: centred 8 px below the top, 6 px corners,
    /// the border at 70%, the page colour at 95%, 11.5 px text.
    fn render_notice(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let (message, _) = self.notice.clone()?;
        let theme = cx.theme();
        Some(
            div()
                .absolute()
                .top(px(8.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .max_w(relative(0.9))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(theme.border.opacity(0.7))
                        .bg(theme.background.opacity(0.95))
                        .px(px(10.))
                        .py(px(6.))
                        .text_size(px(11.5))
                        .text_color(theme.foreground)
                        .shadow_sm()
                        .child(message),
                )
                .into_any_element(),
        )
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
        markie_core::render_boundary::project(|| {
            if self.sample.is_some() {
                return self.render_document(window, cx);
            }
            self.project_document(window, cx).into_any_element()
        })
            .unwrap_or_else(|detail| {
                cx.emit(crate::RichEvent::RenderFailed(detail));
                div().into_any_element()
            })
    }
}

impl RichView {
    fn project_document(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let started = std::time::Instant::now();
        self.source_mode = false;
        let outside = std::mem::take(&mut self.toolbar_outside);
        // A view-only share keeps the toolbar, its editing controls greyed
        // (rich-view.tsx draws MarkdownToolbar with `readOnly`); zoom,
        // print, history and the theme font still work.
        let toolbar = (!outside).then(|| self.render_toolbar(window, cx));
        let prompt = self.render_prompt(cx);
        let doc = self.render_document(window, cx);
        let find = self.render_find(cx);
        // Peers' name tags fade out after a move; keep drawing until they have.
        if self.remote.iter().any(|r| r.moved_at.elapsed().as_millis() < crate::CARET_LABEL_MS) {
            window.request_animation_frame();
        }
        let rail = self.render_rail(window, cx);
        if std::env::var("MARKIE_RICH_DEBUG").is_ok() {
            eprintln!("render {} blocks in {:?}", self.editor.block_count(), started.elapsed());
        }
        let format_rail = self.render_format_rail(cx);
        gpui_kit::component::v_flex()
            .size_full()
            .children(toolbar)
            .children(prompt)
            .child(
                gpui_kit::component::h_flex()
                    .flex_1()
                    .min_h_0()
                    .children(format_rail)
                    .child(
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(doc)
                    .children(rail)
                    .children(find)
                    .children(self.render_table_bar(cx))
                    .children(self.render_math_field(cx))
                    .children(self.render_link_card(window, cx))
                    .children(self.render_notice(cx))
                    .children(self.render_video(window, cx))
                    .children({
                        let look = self.look(cx.theme(), window);
                        self.render_lightbox(&look, window, cx)
                    }),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{PARTS, Part, fit, part_in_menu, typed_size, typing_size};

    #[test]
    fn the_size_box_takes_what_the_number_input_takes() {
        assert_eq!(typed_size("14"), Some(14.));
        assert_eq!(typed_size(" 18 "), Some(18.));
        // Half steps are valid input; clampFontSize rounds them.
        assert_eq!(typed_size("16.5"), Some(17.));
        // In range for the input, clamped for the document.
        assert_eq!(typed_size("1"), Some(11.));
        assert_eq!(typed_size("400"), Some(32.));
        // Not a value the input accepts: the size stays.
        assert_eq!(typed_size(""), None);
        assert_eq!(typed_size("abc"), None);
        assert_eq!(typed_size("0"), None);
        assert_eq!(typed_size("401"), None);
        assert_eq!(typed_size("14.2"), None);
    }

    #[test]
    fn typing_only_applies_a_size_that_is_already_one() {
        // The first digit of "14" is not 11.
        assert_eq!(typing_size("1"), None);
        assert_eq!(typing_size("14"), Some(14.));
        assert_eq!(typing_size("32"), Some(32.));
        assert_eq!(typing_size("40"), None);
    }

    #[test]
    fn the_popover_holds_the_parts_that_left_the_row_in_electrons_order() {
        let menu = |w: f32| {
            let (c, p, out) = fit(w);
            PARTS.iter().copied().filter(|x| part_in_menu(*x, c, p, &out)).collect::<Vec<_>>()
        };
        assert!(menu(1400.).is_empty());
        // Groups are fitted in `groups` order, first come first placed: at
        // 900 px size, print and history, and zoom and width are left over.
        assert_eq!(menu(900.), vec![Part::Output, Part::View, Part::SizeDown, Part::SizeUp]);
        // At the narrowest everything goes, the size box and B I U with the
        // primary row, in DOM order: the minus, the box, the plus.
        let all = menu(50.);
        assert_eq!(all, PARTS.to_vec());
        let i = |p: Part| all.iter().position(|x| *x == p).unwrap();
        assert!(i(Part::SizeDown) < i(Part::SizeBox) && i(Part::SizeBox) < i(Part::SizeUp) && i(Part::SizeUp) < i(Part::Primary));
    }

    #[test]
    fn the_row_fits_at_full_width_and_overflows_below() {
        assert_eq!(fit(1400.), (false, false, vec![]));
        let (compact, primary_out, out) = fit(900.);
        assert!(compact && !primary_out && !out.is_empty());
    }
}
