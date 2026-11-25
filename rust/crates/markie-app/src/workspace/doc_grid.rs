//! A grid of document cards, the way a documents home screen lists them:
//! each card is a small page showing the start of the document, then its
//! name, type and one quiet line. Used by the Recent and Cloud pages, and
//! free for any other list of documents.
//!
//! How to use it:
//!
//! 1. Keep a [`DocGridState`] in your view (grid or list, the keyboard
//!    cursor, the scroll position). Put `state.scroll` on your scrolling
//!    container with `.track_scroll(&state.scroll)`.
//! 2. Each frame, build [`Section`]s of [`DocCard`]s. A card's thumbnail is a
//!    [`Thumb`]: a [`Preview`] from `doc_preview.rs` (build it off the main
//!    thread, keep it in a `PreviewCache`), or a clean tile for its type.
//! 3. Call [`render`] with the width you have and one handler. The handler
//!    gets the card's `id` and a [`CardEvent`]: `Open` (click or Enter),
//!    `Menu(point)` (the ⋯ button or a right click) or `Action` (the card's
//!    one text button, such as Remove).
//!
//! The grid draws no scroll container and owns no documents: it is told what
//! to show and reports what was asked.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use markie_core::formats::FormatKind;

use super::chrome::icon;
use super::doc_preview::{Block, Preview};
use super::rail::{format_badge, format_icon};
use crate::themes::{Palette, hex, mix};

/// A card is never narrower than this; columns are added as the page widens.
pub const CARD_MIN: f32 = 188.;
pub const GAP: f32 = 16.;
const THUMB_H: f32 = 138.;
const FOOT_H: f32 = 58.;
pub const CARD_H: f32 = THUMB_H + FOOT_H;
const HEADER_H: f32 = 34.;
const LIST_ROW_H: f32 = 36.;
const SECTION_GAP: f32 = 20.;

/// How many cards fit across `width`.
pub fn columns(width: f32) -> usize {
    (((width + GAP) / (CARD_MIN + GAP)).floor() as usize).clamp(1, 12)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GridView {
    #[default]
    Grid,
    List,
}

impl GridView {
    /// From a saved setting; anything else is the grid.
    pub fn parse(value: Option<&str>) -> Self {
        if value == Some("list") { GridView::List } else { GridView::Grid }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            GridView::Grid => "grid",
            GridView::List => "list",
        }
    }
}

/// What a card shows above its name.
#[derive(Clone)]
pub enum Thumb {
    /// The start of the document, in miniature.
    Page(Arc<Preview>),
    /// Being read: an empty page.
    Loading,
    /// Nothing to draw from: the type's own tile.
    Tile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkTone {
    Green,
    Yellow,
    Red,
    Blue,
    Purple,
    Muted,
}

/// A small state icon on a card: synced, shared, starred.
#[derive(Clone)]
pub struct Mark {
    pub icon: &'static str,
    pub tone: MarkTone,
    pub label: SharedString,
}

impl Mark {
    pub fn new(icon: &'static str, tone: MarkTone, label: impl Into<SharedString>) -> Self {
        Self { icon, tone, label: label.into() }
    }

    fn color(&self, p: &Palette) -> Hsla {
        match self.tone {
            MarkTone::Green => p.green,
            MarkTone::Yellow => p.yellow,
            MarkTone::Red => p.red,
            MarkTone::Blue => p.blue,
            MarkTone::Purple => hex(if p.dark { "#d8b4fe" } else { "#7e22ce" }),
            MarkTone::Muted => p.muted,
        }
    }
}

pub struct DocCard {
    /// Stable and unique in the grid; handed back with every event.
    pub id: SharedString,
    pub name: SharedString,
    pub format: FormatKind,
    /// One quiet line: "Opened 2 hours ago", "Shared by Bob".
    pub meta: SharedString,
    pub thumb: Thumb,
    pub marks: Vec<Mark>,
    /// The file is gone: the line is red and the type's tile is dimmed.
    pub missing: bool,
    /// The document open in the window.
    pub current: bool,
    /// A click or Enter opens it. Off for a file that is gone with no other copy.
    pub openable: bool,
    pub has_menu: bool,
    pub menu_open: bool,
    /// One text button on the card, such as "Remove" or "Manage".
    pub action: Option<SharedString>,
    /// ⌘-click, ⇧-click and a checkbox on hover select it with others.
    pub selectable: bool,
    pub selected: bool,
    /// What dragging the card carries, onto a folder in Projects.
    pub drag: Option<super::projects::DragItems>,
}

impl DocCard {
    pub fn new(id: impl Into<SharedString>, name: impl Into<SharedString>, format: FormatKind) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            format,
            meta: SharedString::default(),
            thumb: Thumb::Tile,
            marks: Vec::new(),
            missing: false,
            current: false,
            openable: true,
            has_menu: true,
            menu_open: false,
            action: None,
            selectable: false,
            selected: false,
            drag: None,
        }
    }
}

pub struct Section {
    /// "Today", "Earlier". None draws no heading.
    pub label: Option<SharedString>,
    pub cards: Vec<DocCard>,
    /// Shown after the label in place of the number of cards, such as "2 of 5".
    pub count: Option<String>,
    /// Something at the right of the heading, such as a Refresh button.
    pub trailing: Option<AnyElement>,
    /// Shown under the heading when the section has no cards.
    pub empty: Option<AnyElement>,
}

impl Section {
    pub fn new(label: Option<&str>, cards: Vec<DocCard>) -> Self {
        Self { label: label.map(|l| SharedString::from(l.to_string())), cards, count: None, trailing: None, empty: None }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CardEvent {
    Open,
    Menu(Point<Pixels>),
    Action,
}

/// What the grid keeps between frames.
pub struct DocGridState {
    pub view: GridView,
    pub focus: FocusHandle,
    /// The card the arrow keys are on.
    pub cursor: Option<SharedString>,
    /// Put this on the page's scrolling container so the cursor stays in view.
    pub scroll: ScrollHandle,
    /// Where the grid was last painted, to scroll the cursor into view.
    painted: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The cards picked with ⌘-click, ⇧-click, ⌘A or their checkboxes.
    /// Kept when the view switches between grid and list.
    pub selection: super::projects::Selection<SharedString>,
    /// Every card in drawn order, as last drawn: ranges and ⌘A use it.
    order: Rc<std::cell::RefCell<Vec<SharedString>>>,
}

impl DocGridState {
    pub fn new(view: GridView, cx: &mut App) -> Self {
        Self {
            view,
            focus: cx.focus_handle(),
            cursor: None,
            scroll: ScrollHandle::new(),
            painted: Rc::new(Cell::new(None)),
            selection: Default::default(),
            order: Default::default(),
        }
    }

    /// The selected cards that are on show, in drawn order.
    pub fn selected(&self) -> Vec<SharedString> {
        self.order.borrow().iter().filter(|id| self.selection.contains(id)).cloned().collect()
    }

    pub fn select_all(&mut self) {
        let order = self.order.borrow().clone();
        self.selection.select_all(&order);
    }

    /// A ⌘- or ⇧-press on a card, or its checkbox (a ⌘-press).
    pub fn press(&mut self, id: &SharedString, cmd: bool, shift: bool) {
        let order = self.order.borrow().clone();
        self.selection.press(id, cmd, shift, &order);
        self.cursor = Some(id.clone());
    }
}

/// Where each card sits, for the arrow keys: the ids of every section in
/// order, and how many columns the grid has (one in the list).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Layout {
    pub sections: Vec<Vec<SharedString>>,
    pub columns: usize,
}

impl Layout {
    fn locate(&self, id: &SharedString) -> Option<(usize, usize)> {
        self.sections.iter().enumerate().find_map(|(s, ids)| ids.iter().position(|i| i == id).map(|i| (s, i)))
    }

    fn first(&self) -> Option<SharedString> {
        self.sections.iter().find_map(|ids| ids.first().cloned())
    }

    fn last(&self) -> Option<SharedString> {
        self.sections.iter().rev().find_map(|ids| ids.last().cloned())
    }

    /// The card an arrow, Home or End moves to. With no cursor, any of them
    /// lands on the first card. At an edge the cursor stays put.
    pub fn step(&self, cursor: Option<&SharedString>, key: &str) -> Option<SharedString> {
        let columns = self.columns.max(1);
        let Some((s, i)) = cursor.and_then(|c| self.locate(c)) else {
            return matches!(key, "left" | "right" | "up" | "down" | "home" | "end").then(|| self.first()).flatten();
        };
        let here = || Some(self.sections[s][i].clone());
        let section_after = |from: usize| (from + 1..self.sections.len()).find(|n| !self.sections[*n].is_empty());
        let section_before = |from: usize| (0..from).rev().find(|n| !self.sections[*n].is_empty());
        match key {
            "home" => self.first(),
            "end" => self.last(),
            "right" => match self.sections[s].get(i + 1) {
                Some(id) => Some(id.clone()),
                None => section_after(s).map(|n| self.sections[n][0].clone()).or_else(here),
            },
            "left" => match i.checked_sub(1) {
                Some(prev) => Some(self.sections[s][prev].clone()),
                None => section_before(s).and_then(|n| self.sections[n].last().cloned()).or_else(here),
            },
            "down" => {
                let ids = &self.sections[s];
                if i + columns < ids.len() {
                    return Some(ids[i + columns].clone());
                }
                // The last row may be short: land on its end rather than stay.
                let last_row = (ids.len() - 1) / columns;
                if i / columns < last_row {
                    return ids.last().cloned();
                }
                match section_after(s) {
                    Some(n) => Some(self.sections[n][(i % columns).min(self.sections[n].len() - 1)].clone()),
                    None => here(),
                }
            }
            "up" => {
                if i >= columns {
                    return Some(self.sections[s][i - columns].clone());
                }
                match section_before(s) {
                    Some(n) => {
                        let ids = &self.sections[n];
                        let last_row = (ids.len() - 1) / columns;
                        Some(ids[(last_row * columns + i % columns).min(ids.len() - 1)].clone())
                    }
                    None => here(),
                }
            }
            _ => None,
        }
    }

    /// The top and bottom of a card inside the grid, in points from its top.
    pub fn span(&self, id: &SharedString, view: GridView) -> Option<(f32, f32)> {
        let (s, i) = self.locate(id)?;
        let columns = self.columns.max(1);
        let (row_h, gap) = match view {
            GridView::Grid => (CARD_H, GAP),
            GridView::List => (LIST_ROW_H, 0.),
        };
        let mut top = 0.;
        for ids in self.sections.iter().take(s) {
            let rows = ids.len().div_ceil(columns);
            top += HEADER_H + rows as f32 * row_h + rows.saturating_sub(1) as f32 * gap + SECTION_GAP;
        }
        top += HEADER_H + (i / columns) as f32 * (row_h + gap);
        Some((top, top + row_h))
    }
}

type Handler<V> = Rc<dyn Fn(&mut V, &SharedString, CardEvent, &mut Window, &mut Context<V>)>;

pub struct Grid<V> {
    pub id: &'static str,
    pub sections: Vec<Section>,
    /// The width the grid has, in points.
    pub width: f32,
    /// The view's own [`DocGridState`], for the keys.
    pub state: fn(&mut V) -> &mut DocGridState,
    pub on_event: Handler<V>,
}

/// Draw the sections as a grid or a list, as `state.view` says.
pub fn render<V: 'static>(grid: Grid<V>, state: &DocGridState, window: &Window, p: &Palette, cx: &mut Context<V>) -> AnyElement {
    let Grid { id, sections, width, state: state_of, on_event } = grid;
    let view = state.view;
    let cols = if view == GridView::Grid { columns(width) } else { 1 };
    let layout = Rc::new(Layout { sections: sections.iter().map(|s| s.cards.iter().map(|c| c.id.clone()).collect()).collect(), columns: cols });
    let focused = state.focus.is_focused(window);
    let cursor = state.cursor.clone().filter(|_| focused);
    let p = *p;
    *state.order.borrow_mut() = layout.sections.iter().flatten().cloned().collect();
    // With anything selected, every card shows its checkbox.
    let selecting = layout.sections.iter().flatten().any(|id| state.selection.contains(id));

    let selectable: std::collections::HashSet<SharedString> =
        sections.iter().flat_map(|s| s.cards.iter().filter(|c| c.selectable).map(|c| c.id.clone())).collect();
    let mut body = v_flex().gap(px(SECTION_GAP));
    let headed = sections.iter().any(|s| s.label.is_some() || s.trailing.is_some());
    for section in sections {
        let count = section.count.clone().unwrap_or_else(|| section.cards.len().to_string());
        let vacant = section.cards.is_empty();
        let header = h_flex()
            .h(px(HEADER_H))
            .flex_none()
            .items_center()
            .gap(px(8.))
            .when(!headed, |el| el.h(px(0.)).overflow_hidden())
            .children(section.label.clone().map(|label| div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(p.foreground).child(label)))
            .when(section.label.is_some(), |el| el.child(div().text_size(px(11.5)).text_color(p.muted).child(count)))
            .child(div().flex_1())
            .children(section.trailing);
        let cards = section.cards.into_iter().map(|mut card| {
            let at_cursor = cursor.as_ref() == Some(&card.id);
            card.selected = card.selectable && state.selection.contains(&card.id);
            match view {
                GridView::Grid => render_card(card, at_cursor, selecting, state_of, on_event.clone(), &p, cx),
                GridView::List => render_row(card, at_cursor, selecting, state_of, on_event.clone(), &p, cx),
            }
        });
        let items = match view {
            GridView::Grid => div().grid().grid_cols(cols as u16).gap(px(GAP)).children(cards),
            GridView::List => v_flex().children(cards),
        };
        body = body.child(v_flex().child(header).children(section.empty.filter(|_| vacant)).child(items));
    }

    let painted = state.painted.clone();
    let keys = layout.clone();
    let selectable_ids: Rc<std::collections::HashSet<SharedString>> = Rc::new(selectable);
    let handler = on_event.clone();
    div()
        .id(id)
        .relative()
        .w_full()
        .track_focus(&state.focus)
        // Where the grid is on screen, so a key press can scroll its card into view.
        .child(canvas(move |bounds, _, _| painted.set(Some(bounds)), |_, _, _, _| {}).absolute().inset_0())
        .child(body)
        .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, window, cx| {
            let key = ev.keystroke.key.as_str();
            let mods = ev.keystroke.modifiers;
            if mods.platform || mods.control || mods.alt {
                return;
            }
            let state = state_of(this);
            // Escape clears a selection; Space picks the cursor's card.
            if key == "escape" && !state.selection.items.is_empty() {
                cx.stop_propagation();
                state.selection.clear();
                cx.notify();
                return;
            }
            if key == "space" && selectable_ids.contains(&state.cursor.clone().unwrap_or_default()) {
                if let Some(id) = state.cursor.clone() {
                    cx.stop_propagation();
                    state.press(&id, true, false);
                    cx.notify();
                }
                return;
            }
            if key == "enter" {
                if let Some(id) = state.cursor.clone().filter(|id| keys.locate(id).is_some()) {
                    cx.stop_propagation();
                    handler(this, &id, CardEvent::Open, window, cx);
                }
                return;
            }
            let Some(next) = keys.step(state.cursor.as_ref(), key) else { return };
            cx.stop_propagation();
            reveal(state, &keys, &next);
            // ⇧ with an arrow extends the selection, as in Finder.
            if mods.shift && selectable_ids.contains(&next) {
                if state.selection.anchor.is_none()
                    && let Some(from) = state.cursor.clone()
                {
                    state.selection.anchor = Some(from);
                }
                state.press(&next, false, true);
            }
            state.cursor = Some(next);
            cx.notify();
        }))
        .into_any_element()
}

/// Scroll the page so the cursor's card is in view.
fn reveal(state: &DocGridState, layout: &Layout, id: &SharedString) {
    let (Some(grid), Some((top, bottom))) = (state.painted.get(), layout.span(id, state.view)) else { return };
    let port = state.scroll.bounds();
    if port.size.height <= px(0.) {
        return;
    }
    let (top, bottom) = (grid.top() + px(top), grid.top() + px(bottom));
    let margin = px(12.);
    let mut offset = state.scroll.offset();
    if top < port.top() + margin {
        offset.y += port.top() + margin - top;
    } else if bottom > port.bottom() - margin {
        offset.y -= bottom - (port.bottom() - margin);
    } else {
        return;
    }
    offset.y = offset.y.min(px(0.));
    state.scroll.set_offset(offset);
}

fn ring(color: Hsla, width: f32) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(width), inset: false }
}

fn lift(p: &Palette) -> BoxShadow {
    BoxShadow { color: hsla(0., 0., 0., if p.dark { 0.35 } else { 0.10 }), offset: point(px(0.), px(4.)), blur_radius: px(14.), spread_radius: px(0.), inset: false }
}

/// The ⋯ button of a card or row.
fn more_button<V: 'static>(card_id: &SharedString, group: &SharedString, menu_open: bool, at_cursor: bool, on_event: Handler<V>, p: &Palette, cx: &mut Context<V>) -> Stateful<Div> {
    let (fg, hover) = (p.foreground, p.fg(0.08));
    let id = card_id.clone();
    div()
        .id(SharedString::from(format!("doc-more-{card_id}")))
        .size(px(22.))
        .flex_none()
        .rounded(px(5.))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(14.))
        .line_height(px(14.))
        .text_color(p.muted)
        .cursor_pointer()
        .when(menu_open, |d| d.bg(hover).text_color(fg))
        // Always there, quiet until the pointer or the cursor is on the card.
        .when(!menu_open && !at_cursor, |d| d.opacity(0.55).group_hover(group.clone(), |s| s.opacity(1.)))
        .hover(move |s| s.text_color(fg).bg(hover))
        .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Actions").build(window, cx))
        .child("⋯")
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
            cx.stop_propagation();
            let at = ev.position();
            on_event(this, &id, CardEvent::Menu(point(at.x - px(10.), at.y + px(14.))), window, cx);
        }))
}

/// The card's one text button.
fn action_button<V: 'static>(card_id: &SharedString, label: SharedString, on_event: Handler<V>, p: &Palette, cx: &mut Context<V>) -> Stateful<Div> {
    let (fg, hover) = (p.foreground, p.fg(0.08));
    let id = card_id.clone();
    div()
        .id(SharedString::from(format!("doc-action-{card_id}")))
        .flex_none()
        .h(px(20.))
        .px(px(6.))
        .flex()
        .items_center()
        .rounded(px(5.))
        .border_1()
        .border_color(p.border)
        .text_size(px(11.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(p.muted)
        .cursor_pointer()
        .hover(move |s| s.text_color(fg).bg(hover))
        .child(label)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |this, _, window, cx| {
            cx.stop_propagation();
            on_event(this, &id, CardEvent::Action, window, cx);
        }))
}

fn marks(card_id: &SharedString, marks: &[Mark], p: &Palette) -> Vec<AnyElement> {
    marks
        .iter()
        .enumerate()
        .map(|(i, mark)| {
            let label = mark.label.clone();
            div()
                .id(SharedString::from(format!("doc-mark-{card_id}-{i}")))
                .size(px(16.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
                .child(icon(mark.icon, 13., mark.color(p)))
                .into_any_element()
        })
        .collect()
}

/// Shared wiring of a card and a row: click opens, right click asks for the
/// menu, and a click moves the keyboard cursor there. On a selectable card a
/// ⌘- or ⇧-click selects instead of opening, and a plain click clears the
/// selection. A card with something to carry drags it.
fn interactive<V: 'static>(el: Stateful<Div>, card: &DocCard, state_of: fn(&mut V) -> &mut DocGridState, on_event: Handler<V>, p: &Palette, cx: &mut Context<V>) -> Stateful<Div> {
    let (open_id, menu_id) = (card.id.clone(), card.id.clone());
    let (openable, has_menu, selectable) = (card.openable, card.has_menu, card.selectable);
    let menu = on_event.clone();
    let p = *p;
    el.when(openable, |el| el.cursor_pointer())
        .when(has_menu, |el| {
            el.on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, window, cx| menu(this, &menu_id, CardEvent::Menu(ev.position), window, cx)))
        })
        .when_some(card.drag.clone(), |el, drag| {
            el.on_drag(drag, move |d: &super::projects::DragItems, _, _, cx| {
                cx.new(|_| super::projects::DragPreview { label: d.label.clone(), count: d.items.len(), palette: p })
            })
        })
        .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
            let m = ev.modifiers();
            let state = state_of(this);
            state.focus.focus(window, cx);
            if selectable && (m.platform || m.shift) {
                state.press(&open_id, m.platform, m.shift);
                cx.notify();
                return;
            }
            state.cursor = Some(open_id.clone());
            state.selection.clear();
            if openable {
                on_event(this, &open_id, CardEvent::Open, window, cx);
            }
            cx.notify();
        }))
}

/// The round checkbox a selectable card shows on hover, and always once
/// anything is selected.
fn check_box<V: 'static>(card: &DocCard, group: &SharedString, selecting: bool, state_of: fn(&mut V) -> &mut DocGridState, p: &Palette, cx: &mut Context<V>) -> Stateful<Div> {
    let id = card.id.clone();
    let on = card.selected;
    let (blue, border, bg) = (p.blue, mix(p.foreground, p.border, 0.35), if p.dark { p.surface2 } else { hex("#ffffff") });
    div()
        .id(SharedString::from(format!("doc-check-{}", card.id)))
        .size(px(18.))
        .flex_none()
        .rounded_full()
        .border_1()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .when(on, |el| el.bg(blue).border_color(blue).child(svg().data(CHECK).size(px(11.)).text_color(gpui_kit::white())))
        .when(!on, |el| el.bg(bg.opacity(0.92)).border_color(border).hover(move |s| s.border_color(blue)))
        .when(!on && !selecting, |el| el.invisible().group_hover(group.clone(), |s| s.visible()))
        .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(if on { "Deselect" } else { "Select" }).build(window, cx))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |this, _, window, cx| {
            cx.stop_propagation();
            let state = state_of(this);
            state.focus.focus(window, cx);
            state.press(&id, true, false);
            cx.notify();
        }))
}

const CHECK: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>"#;

fn render_card<V: 'static>(card: DocCard, at_cursor: bool, selecting: bool, state_of: fn(&mut V) -> &mut DocGridState, on_event: Handler<V>, p: &Palette, cx: &mut Context<V>) -> AnyElement {
    let p = *p;
    let group = SharedString::from(format!("doc-card-{}", card.id));
    let border = if card.current { mix(p.blue, p.border, 0.6) } else { p.border };
    let hover_border = mix(p.foreground, p.border, if p.dark { 0.32 } else { 0.28 });
    let tray = if p.dark { mix(p.foreground, p.surface, 0.07) } else { mix(p.foreground, p.background, 0.045) };
    let surface = if p.dark { p.surface } else { p.background };
    let shell = div()
        .id(group.clone())
        .group(group.clone())
        .min_w_0()
        .h(px(CARD_H))
        .flex()
        .flex_col()
        .rounded(px(10.))
        .border_1()
        .border_color(border)
        .bg(surface)
        .overflow_hidden()
        .when(card.menu_open, |el| el.border_color(hover_border))
        .when(card.selected, |el| el.border_color(p.blue).bg(mix(p.blue, surface, 0.1)))
        .when(at_cursor, |el| el.shadow(vec![ring(p.blue.opacity(0.9), 2.)]))
        .when(!at_cursor, |el| el.hover(move |s| s.border_color(hover_border).shadow(vec![lift(&p)])));
    // The card's one button shows with the pointer or the cursor on the card,
    // over the end of the quiet line; a missing file's Remove always shows.
    let action = card.action.clone().map(|label| {
        let button = action_button(&card.id, label, on_event.clone(), &p, cx);
        if card.missing {
            button.into_any_element()
        } else {
            div()
                .absolute()
                .right_0()
                .top_0()
                .h_full()
                .flex()
                .items_center()
                .pl(px(8.))
                .bg(surface)
                .when(!at_cursor && !card.menu_open, |el| el.invisible().group_hover(group.clone(), |s| s.visible()))
                .child(button)
                .into_any_element()
        }
    });
    let foot = v_flex()
        .h(px(FOOT_H))
        .flex_none()
        .justify_center()
        .gap(px(5.))
        .pl(px(12.))
        .pr(px(8.))
        .border_t_1()
        .border_color(p.border.opacity(0.7))
        .child(
            h_flex()
                .gap(px(4.))
                .child(div().flex_1().min_w_0().truncate().text_size(px(13.)).line_height(px(18.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(card.name.clone()))
                .children(marks(&card.id, &card.marks, &p))
                .when(card.has_menu, |el| el.child(more_button(&card.id, &group, card.menu_open, at_cursor, on_event.clone(), &p, cx)))
                .when(!card.has_menu, |el| el.child(div().w(px(2.)).flex_none())),
        )
        .child(
            h_flex()
                .relative()
                .gap(px(6.))
                .h(px(20.))
                .child(format_badge(card.format, &p))
                .child(div().flex_1().min_w_0().truncate().text_size(px(11.)).line_height(px(16.)).text_color(if card.missing { p.red } else { p.muted }).child(card.meta.clone()))
                .children(action),
        );
    let thumb = div()
        .h(px(THUMB_H))
        .flex_none()
        .relative()
        .overflow_hidden()
        .bg(if card.selected { mix(p.blue, tray, 0.12) } else { tray })
        .child(match &card.thumb {
            Thumb::Page(preview) => sheet(&p).children(preview.blocks.iter().map(|b| block(b, &p))).into_any_element(),
            Thumb::Loading => sheet(&p).into_any_element(),
            Thumb::Tile => tile(card.format, card.missing, &p),
        })
        .when(card.selectable, |el| el.child(div().absolute().top(px(8.)).left(px(8.)).child(check_box(&card, &group, selecting, state_of, &p, cx))));
    interactive(shell, &card, state_of, on_event, &p, cx).child(thumb).child(foot).into_any_element()
}

fn render_row<V: 'static>(card: DocCard, at_cursor: bool, selecting: bool, state_of: fn(&mut V) -> &mut DocGridState, on_event: Handler<V>, p: &Palette, cx: &mut Context<V>) -> AnyElement {
    let p = *p;
    let group = SharedString::from(format!("doc-row-{}", card.id));
    let hover = p.fg(0.05);
    let shell = div()
        .id(group.clone())
        .group(group.clone())
        .h(px(LIST_ROW_H))
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(10.))
        .rounded(px(7.))
        .when(card.current, |el| el.bg(p.fg(0.06)))
        .when(card.menu_open, |el| el.bg(hover))
        .when(card.selected, |el| el.bg(p.blue.opacity(if p.dark { 0.24 } else { 0.12 })))
        // A border, not a shadow ring: a shadow shows through a row's
        // translucent selected fill.
        .border_2()
        .border_color(if at_cursor { p.blue.opacity(0.9) } else { transparent_black() })
        .when(!card.selected, |el| el.hover(move |s| s.bg(hover)))
        .when(card.selectable, |el| el.child(check_box(&card, &group, selecting, state_of, &p, cx)))
        .child(div().when(card.missing, |el| el.opacity(0.45)).child(format_icon(card.format, 16., &p)))
        .child(div().flex_1().min_w_0().truncate().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(card.name.clone()))
        .child(
            h_flex()
                .w(relative(0.36))
                .min_w_0()
                .gap(px(8.))
                .child(div().min_w_0().truncate().text_size(px(11.5)).text_color(if card.missing { p.red } else { p.muted }).child(card.meta.clone()))
                .children(card.action.clone().map(|label| {
                    let show = card.missing || at_cursor || card.menu_open;
                    div().flex_none().when(!show, |el| el.invisible().group_hover(group.clone(), |s| s.visible())).child(action_button(&card.id, label, on_event.clone(), &p, cx))
                })),
        )
        .child(h_flex().w(px(40.)).flex_none().justify_end().gap(px(2.)).children(marks(&card.id, &card.marks, &p)))
        .child(h_flex().w(px(46.)).flex_none().child(format_badge(card.format, &p)))
        .when(card.has_menu, |el| el.child(more_button(&card.id, &group, card.menu_open, at_cursor, on_event.clone(), &p, cx)))
        .when(!card.has_menu, |el| el.child(div().w(px(22.)).flex_none()));
    interactive(shell, &card, state_of, on_event, &p, cx).into_any_element()
}

// ------------------------------------------------------------- thumbnail

/// The page: a sheet of paper whose top shows and whose bottom runs off the
/// thumbnail, like the first page of the document seen from above.
fn sheet(p: &Palette) -> Div {
    let paper = if p.dark { p.background } else { hex("#ffffff") };
    div()
        .absolute()
        .top(px(14.))
        .left(px(22.))
        .right(px(22.))
        .h(px(THUMB_H))
        .flex()
        .flex_col()
        .gap(px(3.))
        .px(px(12.))
        .pt(px(12.))
        .overflow_hidden()
        .rounded_t(px(4.))
        .bg(paper)
        .border_1()
        .border_color(if p.dark { p.fg(0.10) } else { p.border.opacity(0.75) })
        .shadow(vec![BoxShadow { color: hsla(0., 0., 0., if p.dark { 0.30 } else { 0.07 }), offset: point(px(0.), px(2.)), blur_radius: px(8.), spread_radius: px(0.), inset: false }])
}

const BODY: f32 = 5.6;
const BODY_LH: f32 = 8.2;

fn body_line(text: &str, p: &Palette) -> Div {
    div().min_w_0().text_size(px(BODY)).line_height(px(BODY_LH)).text_color(p.foreground.opacity(0.66)).child(text.to_string())
}

/// One block of the document, in miniature.
fn block(block: &Block, p: &Palette) -> AnyElement {
    let dot = |el: Div| el.flex_none().w(px(7.)).text_size(px(BODY)).line_height(px(BODY_LH)).text_color(p.foreground.opacity(0.5));
    match block {
        Block::Title(text) => div()
            .mb(px(2.))
            .text_size(px(9.))
            .line_height(px(11.5))
            .font_weight(FontWeight::BOLD)
            .text_color(p.foreground)
            .line_clamp(2)
            .child(text.clone())
            .into_any_element(),
        Block::Heading(text) => div()
            .mt(px(2.))
            .text_size(px(6.8))
            .line_height(px(9.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(p.foreground.opacity(0.9))
            .truncate()
            .child(text.clone())
            .into_any_element(),
        Block::Text(text) => body_line(text, p).line_clamp(3).into_any_element(),
        Block::Bullet(text) => h_flex().items_start().child(dot(div()).child("•")).child(body_line(text, p).flex_1().truncate()).into_any_element(),
        Block::Numbered(marker, text) => {
            h_flex().items_start().child(dot(div()).w(px(9.)).child(marker.clone())).child(body_line(text, p).flex_1().truncate()).into_any_element()
        }
        Block::Check(done, text) => h_flex()
            .items_center()
            .gap(px(3.))
            .child(
                div()
                    .size(px(5.))
                    .flex_none()
                    .rounded(px(1.2))
                    .border_1()
                    .border_color(if *done { p.blue } else { p.foreground.opacity(0.4) })
                    .when(*done, |el| el.bg(p.blue)),
            )
            .child(body_line(text, p).flex_1().truncate().when(*done, |el| el.text_color(p.foreground.opacity(0.45))))
            .into_any_element(),
        Block::Quote(text) => h_flex()
            .items_stretch()
            .gap(px(4.))
            .child(div().w(px(1.5)).flex_none().rounded_full().bg(p.foreground.opacity(0.25)))
            .child(body_line(text, p).flex_1().line_clamp(2).text_color(p.foreground.opacity(0.55)))
            .into_any_element(),
        Block::Code(text) => div()
            .min_w_0()
            .font_family("Menlo")
            .text_size(px(5.))
            .line_height(px(7.6))
            .text_color(p.foreground.opacity(0.7))
            .whitespace_nowrap()
            .overflow_hidden()
            // Leading spaces are the shape of code; a layout would trim them.
            .pl(px(text.chars().take_while(|c| *c == ' ').count() as f32 * 3.))
            .child(text.trim_start().to_string())
            .into_any_element(),
        Block::Rule => div().my(px(2.)).h(px(1.)).w_full().bg(p.border).into_any_element(),
        Block::Table(rows) => {
            let line = p.border.opacity(if p.dark { 1. } else { 0.9 });
            v_flex()
                .my(px(1.))
                .rounded(px(2.))
                .border_1()
                .border_color(line)
                .overflow_hidden()
                .children(rows.iter().enumerate().map(|(r, cells)| {
                    h_flex()
                        .when(r > 0, |el| el.border_t_1().border_color(line))
                        .when(r == 0, |el| el.bg(p.fg(0.045)))
                        .children(cells.iter().enumerate().map(|(c, cell)| {
                            div()
                                .flex_1()
                                .min_w_0()
                                .px(px(3.))
                                .py(px(1.2))
                                .when(c > 0, |el| el.border_l_1().border_color(line))
                                .text_size(px(5.))
                                .line_height(px(7.))
                                .when(r == 0, |el| el.font_weight(FontWeight::SEMIBOLD))
                                .text_color(p.foreground.opacity(if r == 0 { 0.85 } else { 0.66 }))
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .child(cell.clone())
                        }))
                }))
                .into_any_element()
        }
    }
}

/// No words to show: the type's page icon, large and calm.
fn tile(format: FormatKind, missing: bool, p: &Palette) -> AnyElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .when(missing, |el| el.opacity(0.4))
        .child(format_icon(format, 46., p))
        .into_any_element()
}

/// A placeholder card while a list loads.
pub fn skeleton_card(p: &Palette) -> Div {
    let bar = |w: f32| div().h(px(8.)).w(relative(w)).rounded(px(4.)).bg(p.fg(0.07));
    v_flex()
        .h(px(CARD_H))
        .min_w_0()
        .rounded(px(10.))
        .border_1()
        .border_color(p.border.opacity(0.7))
        .overflow_hidden()
        .child(div().h(px(THUMB_H)).flex_none().bg(p.fg(0.035)))
        .child(v_flex().flex_1().justify_center().gap(px(9.)).px(px(12.)).child(bar(0.62)).child(bar(0.38)))
}

/// A grid of placeholders, as wide as the real one.
pub fn skeleton(width: f32, count: usize, p: &Palette) -> Div {
    div().grid().grid_cols(columns(width) as u16).gap(px(GAP)).children((0..count).map(|_| skeleton_card(p)))
}

/// The grid and list switch for a page's toolbar.
pub fn view_toggle<V: 'static>(view: GridView, p: &Palette, cx: &mut Context<V>, on_pick: impl Fn(&mut V, GridView, &mut Context<V>) + 'static) -> Div {
    let on_pick = Rc::new(on_pick);
    let p = *p;
    const GRID: &str = "markie/view-grid.svg";
    const LIST: &str = "markie/view-list.svg";
    super::chrome::segmented(&p).flex_none().children([(GridView::Grid, GRID, "Grid"), (GridView::List, LIST, "List")].map(|(which, glyph, label)| {
        let on = view == which;
        let pick = on_pick.clone();
        div()
            .id(SharedString::from(format!("doc-view-{label}")))
            .w(px(30.))
            .h(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(7.))
            .cursor_pointer()
            .when(on, |el| el.bg(super::chrome::segment_on(&p)))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx))
            .child(icon(glyph, 14., if on { p.foreground } else { p.muted }))
            .on_click(cx.listener(move |this, _, _, cx| {
                pick(this, which, cx);
                cx.notify();
            }))
    }))
}

#[cfg(test)]
mod tests {
    use super::{CARD_H, GAP, GridView, Layout, columns};
    use gpui_kit::SharedString;

    fn layout(sections: &[usize], columns: usize) -> Layout {
        let mut n = 0;
        Layout {
            sections: sections
                .iter()
                .map(|count| {
                    (0..*count)
                        .map(|_| {
                            n += 1;
                            SharedString::from(format!("d{n}"))
                        })
                        .collect()
                })
                .collect(),
            columns,
        }
    }

    fn walk(layout: &Layout, from: &str, keys: &[&str]) -> String {
        let mut at = Some(SharedString::from(from.to_string()));
        for key in keys {
            at = layout.step(at.as_ref(), key);
        }
        at.map(|s| s.to_string()).unwrap_or_default()
    }

    #[test]
    fn the_grid_adds_columns_as_it_widens() {
        assert_eq!(columns(100.), 1);
        assert_eq!(columns(188.), 1);
        assert_eq!(columns(188. * 2. + GAP), 2);
        assert_eq!(columns(1180.), 5);
        assert_eq!(columns(10_000.), 12);
    }

    #[test]
    fn the_view_is_remembered_as_a_word() {
        assert_eq!(GridView::parse(Some("list")), GridView::List);
        assert_eq!(GridView::parse(Some("grid")), GridView::Grid);
        assert_eq!(GridView::parse(None), GridView::Grid);
        assert_eq!(GridView::parse(Some(GridView::List.as_str())), GridView::List);
    }

    #[test]
    fn arrows_move_through_rows_and_across_sections() {
        // Today: d1 d2 d3 / d4 d5.  Earlier: d6 d7 d8 / d9.
        let l = layout(&[5, 4], 3);
        assert_eq!(l.step(None, "down").as_deref(), Some("d1"), "the first key lands on the first card");
        assert_eq!(walk(&l, "d1", &["right", "right"]), "d3");
        assert_eq!(walk(&l, "d3", &["right"]), "d4");
        assert_eq!(walk(&l, "d5", &["right"]), "d6", "past a section's end is the next section");
        assert_eq!(walk(&l, "d6", &["left"]), "d5");
        assert_eq!(walk(&l, "d1", &["left"]), "d1", "the first card is an edge");
        assert_eq!(walk(&l, "d1", &["down"]), "d4");
        assert_eq!(walk(&l, "d3", &["down"]), "d5", "a short last row takes its last card");
        assert_eq!(walk(&l, "d4", &["down"]), "d6");
        assert_eq!(walk(&l, "d5", &["down"]), "d7", "the column is kept across sections");
        assert_eq!(walk(&l, "d7", &["up"]), "d5");
        assert_eq!(walk(&l, "d8", &["up"]), "d5", "a column the row above lacks takes its last card");
        assert_eq!(walk(&l, "d9", &["down"]), "d9", "the last row is an edge");
        assert_eq!(walk(&l, "d2", &["up"]), "d2");
        assert_eq!(walk(&l, "d4", &["end"]), "d9");
        assert_eq!(walk(&l, "d4", &["home"]), "d1");
        assert_eq!(l.step(Some(&"d4".into()), "a"), None, "other keys are not the grid's");
    }

    #[test]
    fn arrows_skip_empty_sections_and_a_stale_cursor_starts_over() {
        let l = layout(&[2, 0, 2], 2);
        assert_eq!(walk(&l, "d2", &["right"]), "d3");
        assert_eq!(walk(&l, "d1", &["down"]), "d3");
        assert_eq!(walk(&l, "d3", &["up"]), "d1");
        assert_eq!(walk(&l, "gone", &["right"]), "d1");
        assert_eq!(layout(&[], 3).step(None, "down"), None);
    }

    #[test]
    fn the_list_is_one_column() {
        let l = layout(&[3], 1);
        assert_eq!(walk(&l, "d1", &["down", "down", "down"]), "d3");
        assert_eq!(walk(&l, "d3", &["up"]), "d2");
    }

    #[test]
    fn a_cards_place_follows_its_row_and_the_sections_above() {
        let l = layout(&[5, 4], 3);
        let top = |id: &str| l.span(&id.into(), GridView::Grid).unwrap().0;
        assert_eq!(top("d1"), top("d3"));
        assert_eq!(top("d4") - top("d1"), CARD_H + GAP);
        assert!(top("d6") > top("d4") + CARD_H);
        let (a, b) = l.span(&"d6".into(), GridView::Grid).unwrap();
        assert_eq!(b - a, CARD_H);
        assert_eq!(l.span(&"gone".into(), GridView::Grid), None);
    }
}
