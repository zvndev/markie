//! The Projects tab, drawn: an outline like Finder's sidebar. Folders have
//! disclosure arrows and remember whether they are open; files show their
//! type. Every row drags (several at once when selected together), every
//! folder takes drops, and an insertion line shows where a reorder lands.
//! A right click opens the menu for what is selected; the keys are listed in
//! `key_bindings` and `tree_key`.
//!
//! The state and every action live in `projects.rs`; this module only draws
//! and routes input to them.

use std::path::PathBuf;

use gpui_kit::component::input::Input;
use gpui_kit::component::{Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::projects::folders::{Item, Target};

use super::Workspace;
use super::chrome::{hover_fill, menu_panel};
use super::dialog_chrome::{Tokens, fade};
use super::library_rows::svg_bytes;
use super::overlay::Overlay;
use super::projects::{DragItems, DragPreview, MenuAction, Projects, Row, SectionKind, Zone, delete_message, destinations, drop_allowed, menu_entries, target_for, zone_for};
use super::source::{EditRedo, EditSelectAll, EditUndo};
use crate::themes::{self, Palette};

pub(super) const ROW_H: f32 = 26.;
const INDENT: f32 = 14.;
pub(super) const KEY_CONTEXT: &str = "ProjectsTree";

const FOLDER: &str = r#"<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>"#;
const FOLDER_OPEN: &str = r#"<path d="M3.5 17.5v-10a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1"/><path d="M3.5 17.5 6 11a1.5 1.5 0 0 1 1.4-1h13.1l-2.6 8.3a1.5 1.5 0 0 1-1.4 1.2H5.4a1.9 1.9 0 0 1-1.9-2z"/>"#;
const CHEVRON: &str = r#"<path d="M9 6l6 6-6 6"/>"#;
const CHEVRON_DOWN: &str = r#"<path d="M6 9l6 6 6-6"/>"#;
const PLUS_FOLDER: &str = r#"<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>"#;
const TRAY: &str = r#"<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M4 13l2.5-7h11L20 13v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/>"#;
const SPARK: &str = r#"<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>"#;
const WARN: &str = r#"<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.2"/>"#;

actions!(markie_projects, [ProjectsNewFolder, ProjectsDelete, ProjectsOpen, ProjectsRename]);

/// Keys of the outline while it has focus. Bound with its context, so they
/// win over the app's own ⌘O and leave every other place alone.
pub fn key_bindings() -> Vec<KeyBinding> {
    let ctx = Some(KEY_CONTEXT);
    vec![
        KeyBinding::new("cmd-shift-n", ProjectsNewFolder, ctx),
        KeyBinding::new("cmd-backspace", ProjectsDelete, ctx),
        KeyBinding::new("cmd-delete", ProjectsDelete, ctx),
        KeyBinding::new("cmd-o", ProjectsOpen, ctx),
        KeyBinding::new("cmd-down", ProjectsOpen, ctx),
    ]
}

fn glyph(body: &str, size: f32, color: Hsla) -> Svg {
    svg().data(&svg_bytes(body, size as u32)).size(px(size)).flex_none().text_color(color)
}

impl Workspace {
    pub(super) fn render_projects(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let pr = &self.projects;
        let rows = pr.rows();
        let searching = !pr.query.trim().is_empty();
        let focused = pr.tree_focused;
        let current = self.doc.as_ref().map(|d| d.path.clone());
        let empty_tree = pr.tree.is_empty() && !searching;
        let order = Projects::order(&rows);
        let n = rows.len();
        let rows_for_list = rows.clone();
        let list = uniform_list(
            "projects-tree",
            n,
            cx.processor(move |this, range: std::ops::Range<usize>, _window, cx| {
                range.map(|ix| this.render_tree_row(ix, &rows_for_list, &order, focused, current.as_deref(), &p, cx)).collect::<Vec<_>>()
            }),
        )
        .track_scroll(&pr.scroll)
        .w_full()
        .flex_none()
        .h(px(ROW_H * n as f32));

        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .flex_none()
                    .px(px(8.))
                    .pt(px(8.))
                    .pb(px(6.))
                    .gap(px(6.))
                    .child(div().flex_1().min_w_0().child(super::rail::filter_field(&pr.filter, 12., &p)))
                    .child(
                        div()
                            .id("projects-new-folder")
                            .size(px(32.))
                            .flex_none()
                            .rounded(px(7.))
                            .border_1()
                            .border_color(p.border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .hover(|s| s.bg(hover_fill(&p)))
                            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("New Folder  ⇧⌘N").build(window, cx))
                            .child(glyph(PLUS_FOLDER, 15., p.muted))
                            .on_click(cx.listener(|this, _, window, cx| this.new_folder(None, window, cx))),
                    ),
            )
            .when_some(pr.state.as_ref().and_then(|s| s.rules_error.clone()).filter(|_| pr.state.as_ref().is_some_and(|s| s.auto)), |el, e| {
                el.child(div().mx(px(8.)).mb(px(6.)).px(px(8.)).py(px(4.)).rounded(px(6.)).border_1().border_color(p.yellow).text_size(px(11.)).text_color(p.yellow).child(e))
            })
            .child(
                div()
                    .id("projects-outline")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_focus(&pr.focus)
                    .key_context(KEY_CONTEXT)
                    .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                        if this.tree_key(&ev.keystroke, window, cx) {
                            cx.stop_propagation();
                        }
                    }))
                    .on_action(cx.listener(|this, _: &EditUndo, window, cx| this.projects_undo(false, window, cx)))
                    .on_action(cx.listener(|this, _: &EditRedo, window, cx| this.projects_undo(true, window, cx)))
                    .on_action(cx.listener(|this, _: &EditSelectAll, _, cx| {
                        let order = Projects::order(&this.projects.rows());
                        this.projects.selection.select_all(&order);
                        cx.notify();
                    }))
                    .on_action(cx.listener(|this, _: &ProjectsNewFolder, window, cx| {
                        let parent = this.single_selected_folder();
                        this.new_folder(parent, window, cx);
                    }))
                    .on_action(cx.listener(|this, _: &ProjectsDelete, window, cx| this.delete_selection(window, cx)))
                    .on_action(cx.listener(|this, _: &ProjectsOpen, window, cx| {
                        let items = this.projects.selection.items.clone();
                        this.open_items(&items, window, cx);
                    }))
                    .on_action(cx.listener(|this, _: &ProjectsRename, window, cx| {
                        if let Some(id) = this.single_selected_folder() {
                            this.start_folder_rename(&id, window, cx);
                        }
                    }))
                    .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.clear_drop(cx)))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.clear_drop(cx)))
                    .when(empty_tree, |el| el.child(self.render_projects_empty(&p, cx)))
                    .when(searching && n == 0, |el| el.child(div().px(px(12.)).py(px(12.)).text_size(px(12.)).text_color(p.muted).child("Nothing matches that.")))
                    .child(list)
                    // The open area under the rows: a drop here leaves every
                    // folder (files) or goes to the top level (folders).
                    .child(
                        div()
                            .id("projects-tail")
                            .flex_1()
                            .min_h(px(48.))
                            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
                                this.projects.focus.focus(window, cx);
                                this.projects.selection.clear();
                                cx.notify();
                            }))
                            .on_mouse_down(MouseButton::Right, cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                                this.projects.focus.focus(window, cx);
                                this.projects.selection.clear();
                                this.open_projects_menu(Vec::new(), ev.position, cx);
                            }))
                            .on_drag_move(cx.listener(|this, ev: &DragMoveEvent<DragItems>, _, cx| {
                                if ev.bounds.contains(&ev.event.position) && this.projects.drop.as_ref().is_none_or(|d| d.0 != usize::MAX) {
                                    this.projects.drop = Some((usize::MAX, Zone::After, Target::TopEnd));
                                    cx.notify();
                                }
                            }))
                            .on_drop(cx.listener(|this, d: &DragItems, window, cx| {
                                this.drop_items(d.items.clone(), Target::TopEnd, window, cx);
                            })),
                    ),
            )
            .into_any_element()
    }

    fn clear_drop(&mut self, cx: &mut Context<Self>) {
        if self.projects.drop.take().is_some() | self.projects.file_drop.take().is_some() {
            cx.notify();
        }
    }

    fn single_selected_folder(&self) -> Option<String> {
        match self.projects.selection.items.as_slice() {
            [Item::Folder(id)] => Some(id.clone()),
            _ => None,
        }
    }

    /// No folders yet: what Projects is for, and the button to start.
    fn render_projects_empty(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        v_flex()
            .id("projects-empty")
            .mx(px(8.))
            .mt(px(4.))
            .mb(px(10.))
            .px(px(14.))
            .py(px(14.))
            .gap(px(8.))
            .items_center()
            .rounded(px(10.))
            .border_1()
            .border_color(p.border.opacity(0.8))
            .bg(p.fg(if p.dark { 0.025 } else { 0.02 }))
            .child(glyph(FOLDER, 26., p.blue.opacity(0.85)))
            .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child("Organize your files into folders"))
            .child(
                div()
                    .text_size(px(11.5))
                    .line_height(px(16.))
                    .text_center()
                    .text_color(p.muted)
                    .child("Make a folder, then drag files in from Unsorted. Nothing moves on your disk."),
            )
            .child(
                div()
                    .id("projects-empty-new")
                    .mt(px(2.))
                    .px(px(12.))
                    .py(px(5.))
                    .rounded(px(7.))
                    .bg(p.blue)
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(gpui_kit::white())
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.9))
                    .child("New Folder")
                    .on_click(cx.listener(|this, _, window, cx| this.new_folder(None, window, cx))),
            )
            .child(
                div()
                    .id("projects-empty-bring")
                    .text_size(px(11.5))
                    .text_color(p.blue)
                    .cursor_pointer()
                    .hover(|s| s.underline())
                    .child("Bring in your documents\u{2026}")
                    .on_click(cx.listener(|this, _, window, cx| this.open_bring_docs(false, window, cx))),
            )
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_tree_row(&self, ix: usize, rows: &[Row], order: &[Item], focused: bool, current: Option<&std::path::Path>, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let row = rows[ix].clone();
        let pr = &self.projects;
        let item = row.item();
        let selected = item.as_ref().is_some_and(|i| pr.selection.contains(i));
        let at_cursor = focused && item.is_some() && item == pr.selection.cursor;
        let depth = row.depth();
        let hint = pr.drop.as_ref().filter(|d| d.0 == ix).map(|d| d.1);
        let into = hint == Some(Zone::Into) || pr.file_drop == Some(ix);
        let indent = 8. + depth as f32 * INDENT;
        let sel_bg = if focused { p.blue.opacity(if p.dark { 0.38 } else { 0.22 }) } else { p.fg(if p.dark { 0.12 } else { 0.08 }) };

        let mut el = h_flex()
            .id(SharedString::from(format!("prow-{ix}")))
            .relative()
            .h(px(ROW_H))
            .w_full()
            .pl(px(indent))
            .pr(px(8.))
            .gap(px(5.))
            .rounded(px(6.))
            .when(selected, |el| el.bg(sel_bg))
            .when(!selected && !into, |el| el.hover(|s| s.bg(hover_fill(&p))))
            .when(into, |el| el.bg(p.blue.opacity(0.18)).border_1().border_color(p.blue.opacity(0.85)))
            .when(at_cursor && !into, |el| el.border_1().border_color(p.blue.opacity(0.7)));

        // The insertion line, at the row's indent.
        if let Some(z @ (Zone::Before | Zone::After)) = hint {
            let line = div().absolute().left(px(indent - 4.)).right(px(4.)).h(px(2.)).rounded_full().bg(p.blue);
            let dot = div().absolute().left(px(indent - 8.)).size(px(6.)).rounded_full().border_2().border_color(p.blue).bg(p.background);
            el = el.child(if z == Zone::Before { line.top(px(-1.)) } else { line.bottom(px(-1.)) }).child(if z == Zone::Before { dot.top(px(-3.)) } else { dot.bottom(px(-3.)) });
        }

        el = match &row {
            Row::Folder { id, name, open, files, has_children, .. } => {
                let renaming = pr.renaming.as_ref().filter(|(r, _)| r == id).map(|(_, input)| input.clone());
                let toggle_id = id.clone();
                let open_now = *open;
                el.child(
                    div()
                        .id(SharedString::from(format!("pdisc-{id}")))
                        .size(px(14.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(*has_children, |d| d.child(glyph(if *open { CHEVRON_DOWN } else { CHEVRON }, 11., p.muted)))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.set_folder_open(&toggle_id, !open_now, cx);
                        })),
                )
                .child(glyph(if *open && *has_children { FOLDER_OPEN } else { FOLDER }, 15., p.blue.opacity(if p.dark { 0.9 } else { 0.8 })))
                .child(match renaming {
                    Some(input) => div()
                        .flex_1()
                        .min_w_0()
                        .h(px(22.))
                        .flex()
                        .items_center()
                        .overflow_hidden()
                        .px(px(2.))
                        .rounded(px(4.))
                        .border_1()
                        .border_color(p.blue)
                        .bg(p.background)
                        .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                            if ev.keystroke.key == "escape" {
                                cx.stop_propagation();
                                this.cancel_folder_rename(window, cx);
                            }
                        }))
                        .child(Input::new(&input).appearance(false).xsmall().h(px(20.)).text_size(px(12.5)))
                        .into_any_element(),
                    None => div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(p.foreground).child(name.clone()).into_any_element(),
                })
                .when(*files > 0, |el| el.child(div().flex_none().text_size(px(11.)).text_color(p.muted).child(files.to_string())))
            }
            Row::File { path, name, missing, .. } => {
                let active = current == Some(path.as_path());
                let format = markie_core::formats::classify(name);
                el.child(div().w(px(14.)).flex_none())
                    .child(if *missing { glyph(WARN, 14., p.red).into_any_element() } else { super::rail::format_icon(format, 14., &p).into_any_element() })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.5))
                            .text_color(if *missing { p.muted } else { p.foreground })
                            .when(active, |d| d.font_weight(FontWeight::MEDIUM))
                            .child(name.clone()),
                    )
                    .when(*missing, |el| el.child(div().flex_none().text_size(px(10.5)).text_color(p.red).child("Missing")))
                    .tooltip({
                        let shown = markie_core::path_display::compact_dir(path.parent().unwrap_or(path), &markie_core::paths::home_dir(), 3);
                        move |window, cx| gpui_kit::component::tooltip::Tooltip::new(shown.clone()).build(window, cx)
                    })
            }
            Row::Section { kind, count, open } => {
                let kind = *kind;
                let open_now = *open;
                let (label, icon) = match kind {
                    SectionKind::Unsorted => ("Unsorted", TRAY),
                    SectionKind::Automatic => ("Grouped automatically", SPARK),
                };
                el.mt(px(if ix == 0 { 0. } else { 6. }))
                    .child(div().size(px(14.)).flex_none().flex().items_center().justify_center().child(glyph(if *open { CHEVRON_DOWN } else { CHEVRON }, 11., p.muted)))
                    .child(glyph(icon, 14., p.muted))
                    .child(div().flex_1().min_w_0().truncate().text_size(px(11.)).font_weight(FontWeight::MEDIUM).text_color(p.muted).child(label.to_uppercase()))
                    .child(div().flex_none().text_size(px(11.)).text_color(p.muted).child(count.to_string()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        match kind {
                            SectionKind::Unsorted => this.projects.unsorted_open = !open_now,
                            SectionKind::Automatic => this.projects.auto_open = !open_now,
                        }
                        cx.notify();
                    }))
            }
            Row::AutoProject { key, name, files, open } => {
                let (key, open_now) = (key.clone(), *open);
                el.child(div().size(px(14.)).flex_none().flex().items_center().justify_center().child(glyph(if *open { CHEVRON_DOWN } else { CHEVRON }, 11., p.muted)))
                    .child(glyph(FOLDER, 15., p.muted))
                    .child(div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(p.foreground).child(name.clone()))
                    .child(div().flex_none().text_size(px(11.)).text_color(p.muted).child(files.to_string()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.projects.toggled.insert(key.clone(), !open_now);
                        cx.notify();
                    }))
            }
        };

        // Selection, opening, the menu and dragging, for folders and files.
        if let Some(item) = item.clone() {
            let order_v: Vec<Item> = order.to_vec();
            let (press_item, press_order) = (item.clone(), order_v.clone());
            el = el.on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                this.projects.focus.focus(window, cx);
                let m = ev.modifiers;
                let sel = &mut this.projects.selection;
                // A plain press on a row already in a selection keeps the
                // selection, so it can be dragged; the click narrows it.
                if m.platform || m.shift || !sel.contains(&press_item) {
                    sel.press(&press_item, m.platform, m.shift, &press_order);
                }
                cx.notify();
            }));
            let (click_item, click_order, click_row) = (item.clone(), order_v.clone(), row.clone());
            el = el.on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                let m = ev.modifiers();
                if m.platform || m.shift {
                    return;
                }
                this.projects.selection.press(&click_item, false, false, &click_order);
                match &click_row {
                    Row::Folder { id, .. } if ev.click_count() >= 2 => this.start_folder_rename(id, window, cx),
                    Row::File { path, missing: false, .. } => this.open_path(path, window, cx),
                    _ => {}
                }
                cx.notify();
            }));
            let (menu_item, menu_order) = (item.clone(), order_v.clone());
            el = el.on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                this.projects.focus.focus(window, cx);
                if !this.projects.selection.contains(&menu_item) {
                    this.projects.selection.press(&menu_item, false, false, &menu_order);
                }
                let items = this.projects.selection.drag_set(&menu_item, &menu_order);
                let items = if this.projects.selection.items.len() > 1 { items } else { vec![menu_item.clone()] };
                this.open_projects_menu(items, ev.position, cx);
            }));
            let carried = pr.selection.drag_set(&item, order);
            let drag = DragItems::new(carried, &|i| pr.name_of(i));
            el = el.on_drag(drag, move |d: &DragItems, _, _, cx| cx.new(|_| DragPreview { label: d.label.clone(), count: d.items.len(), palette: p }));
        }

        // Where a drag would land, worked out from the pointer in this row.
        let drop_row = row.clone();
        el = el
            .on_drag_move(cx.listener(move |this, ev: &DragMoveEvent<DragItems>, _, cx| {
                let inside = ev.bounds.contains(&ev.event.position);
                let held = this.projects.drop.as_ref().is_some_and(|d| d.0 == ix);
                if !inside {
                    if held {
                        this.projects.drop = None;
                        cx.notify();
                    }
                    return;
                }
                let zone = zone_for(&drop_row, f32::from(ev.bounds.origin.y), f32::from(ev.bounds.size.height), f32::from(ev.event.position.y));
                let items = ev.drag(cx).items.clone();
                let next = target_for(&drop_row, zone).filter(|t| drop_allowed(&items, t, &this.projects.tree)).map(|t| (ix, zone, t));
                if this.projects.drop != next {
                    this.projects.drop = next;
                    cx.notify();
                }
            }))
            .on_drop(cx.listener(move |this, d: &DragItems, window, cx| {
                let Some((at, _, target)) = this.projects.drop.clone() else { return };
                if at == ix {
                    this.drop_items(d.items.clone(), target, window, cx);
                }
            }));

        // Files from Finder, onto a folder: added there, never moved on disk.
        if let Row::Folder { id, .. } = &row {
            let (hover_id, drop_id) = (id.clone(), id.clone());
            let _ = hover_id;
            el = el
                .drag_over::<ExternalPaths>(move |s, _, _, _| s.bg(p.blue.opacity(0.18)).border_1().border_color(p.blue.opacity(0.85)))
                .on_drop(cx.listener(move |this, paths: &ExternalPaths, window, cx| {
                    cx.stop_propagation();
                    this.add_paths_to_folder(paths.paths().to_vec(), drop_id.clone(), window, cx);
                }));
        }
        div().w_full().px(px(4.)).child(el).into_any_element()
    }

    /// The outline's own keys. Returns whether one was used.
    fn tree_key(&mut self, key: &Keystroke, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.projects.renaming.is_some() {
            return false;
        }
        let m = key.modifiers;
        let rows = self.projects.rows();
        let order = Projects::order(&rows);
        let cursor_row = self.projects.selection.cursor.clone().and_then(|c| rows.iter().find(|r| r.item().as_ref() == Some(&c)).cloned());
        match key.key.as_str() {
            "down" | "up" if !m.platform && !m.alt => {
                self.projects.selection.step(key.key == "down", m.shift, &order);
                if let Some(c) = &self.projects.selection.cursor
                    && let Some(ix) = rows.iter().position(|r| r.item().as_ref() == Some(c))
                {
                    self.projects.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
                }
            }
            "right" => match cursor_row {
                Some(Row::Folder { id, open: false, .. }) => self.set_folder_open(&id, true, cx),
                Some(Row::Folder { open: true, .. }) => self.projects.selection.step(true, false, &order),
                _ => return false,
            },
            "left" => match cursor_row {
                Some(Row::Folder { id, open: true, .. }) => self.set_folder_open(&id, false, cx),
                Some(Row::Folder { id, .. }) => self.select_parent_of(&Item::Folder(id), &order, cx),
                Some(Row::File { path, folder: Some(_), .. }) => self.select_parent_of(&Item::File(path.to_string_lossy().into_owned()), &order, cx),
                _ => return false,
            },
            "enter" if !m.platform => match cursor_row {
                Some(Row::Folder { id, .. }) => self.start_folder_rename(&id, window, cx),
                Some(Row::File { path, missing: false, .. }) => self.open_path(&path, window, cx),
                _ => return false,
            },
            "escape" => {
                if self.projects.selection.items.is_empty() {
                    return false;
                }
                self.projects.selection.clear();
            }
            // The context-menu keys: ⇧F10 and the menu key.
            "f10" if m.shift => self.menu_from_keyboard(cx),
            "menu" => self.menu_from_keyboard(cx),
            _ => return false,
        }
        cx.notify();
        true
    }

    fn select_parent_of(&mut self, item: &Item, order: &[Item], cx: &mut Context<Self>) {
        let parent = match item {
            Item::File(p) => self.projects.folder_of(p),
            Item::Folder(id) => {
                let mut up = None;
                fn find_parent(nodes: &[markie_core::projects::folders::FolderNode], id: &str, parent: Option<&str>, out: &mut Option<String>) {
                    for n in nodes {
                        if n.id == id {
                            *out = parent.map(str::to_string);
                            return;
                        }
                        find_parent(&n.children, id, Some(&n.id), out);
                    }
                }
                find_parent(&self.projects.tree, id, None, &mut up);
                up
            }
        };
        if let Some(pid) = parent {
            self.projects.selection.press(&Item::Folder(pid), false, false, order);
            cx.notify();
        }
    }

    fn menu_from_keyboard(&mut self, cx: &mut Context<Self>) {
        let items = self.projects.selection.items.clone();
        let rows = self.projects.rows();
        let ix = self.projects.selection.cursor.as_ref().and_then(|c| rows.iter().position(|r| r.item().as_ref() == Some(c))).unwrap_or(0);
        // Beside the cursor row, near the panel's left edge.
        let at = point(px(60. + 12.), px(120. + ROW_H * ix as f32));
        self.open_projects_menu(items, at, cx);
    }

    /// ⌘⌫: Delete Folder (asks first) for one folder, Remove from Folder for files.
    fn delete_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let items = self.projects.selection.items.clone();
        if let [Item::Folder(id)] = items.as_slice() {
            return self.ask_delete_folder(id.clone(), window, cx);
        }
        let files: Vec<String> = items.iter().filter_map(|i| if let Item::File(p) = i { Some(p.clone()) } else { None }).collect();
        self.remove_from_folder(files, window, cx);
    }

    pub(super) fn open_projects_menu(&mut self, items: Vec<Item>, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.shell.row_menu = None;
        self.projects.menu = Some((items, at));
        self.projects.menu_focus = 0;
        cx.notify();
    }

    fn projects_menu_entries(&self) -> Option<(Vec<super::projects::MenuEntry>, Vec<Item>, Point<Pixels>)> {
        let (items, at) = self.projects.menu.clone()?;
        let paths: Vec<String> = items.iter().filter_map(|i| if let Item::File(p) = i { Some(p.clone()) } else { None }).collect();
        let in_folder = paths.iter().filter(|p| self.projects.folder_of(p).is_some()).count();
        let missing = paths.len() == 1 && items.len() == 1 && self.projects.missing.contains(&paths[0]);
        Some((menu_entries(&items, in_folder, missing), items, at))
    }

    pub(super) fn run_projects_menu(&mut self, action: MenuAction, items: Vec<Item>, window: &mut Window, cx: &mut Context<Self>) {
        self.projects.menu = None;
        let folder = match items.as_slice() {
            [Item::Folder(id)] => Some(id.clone()),
            _ => None,
        };
        let files: Vec<String> = items.iter().filter_map(|i| if let Item::File(p) = i { Some(p.clone()) } else { None }).collect();
        match action {
            MenuAction::Open => self.open_items(&items, window, cx),
            MenuAction::Reveal => {
                if let Some(p) = files.first() {
                    cx.reveal_path(std::path::Path::new(p));
                }
            }
            MenuAction::MoveTo => self.ask_move_to(items, window, cx),
            MenuAction::RemoveFromFolder => self.remove_from_folder(files, window, cx),
            MenuAction::Locate => {
                if let Some(p) = files.into_iter().next() {
                    self.locate_missing(p, window, cx);
                }
            }
            MenuAction::Forget => self.forget_missing(files, window, cx),
            MenuAction::NewFolder => self.new_folder(None, window, cx),
            MenuAction::NewFolderInside => self.new_folder(folder, window, cx),
            MenuAction::NewDocument => {
                if let Some(f) = folder {
                    self.new_document_in(f, window, cx);
                }
            }
            MenuAction::AddFiles => self.prompt_add_files(folder, window, cx),
            MenuAction::Rename => {
                if let Some(f) = folder {
                    self.start_folder_rename(&f, window, cx);
                }
            }
            MenuAction::DeleteFolder => {
                if let Some(f) = folder {
                    self.ask_delete_folder(f, window, cx);
                }
            }
            MenuAction::MakePrivate => {
                if let Some(p) = files.into_iter().next() {
                    self.make_private_path(PathBuf::from(p), window, cx);
                }
            }
        }
        cx.notify();
    }

    /// The menu's keys while it is open, as the Library row menu's.
    pub(super) fn projects_menu_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((entries, items, _)) = self.projects_menu_entries() else { return false };
        let n = entries.len();
        if n == 0 {
            return false;
        }
        let i = self.projects.menu_focus.min(n - 1);
        match key {
            "down" => self.projects.menu_focus = (i + 1) % n,
            "up" => self.projects.menu_focus = (i + n - 1) % n,
            "home" => self.projects.menu_focus = 0,
            "end" => self.projects.menu_focus = n - 1,
            "enter" | "space" => {
                self.run_projects_menu(entries[i].action, items, window, cx);
                return true;
            }
            "escape" | "tab" => self.projects.menu = None,
            _ => return false,
        }
        cx.notify();
        true
    }

    pub(super) fn render_projects_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (entries, items, at) = self.projects_menu_entries()?;
        let p = themes::palette(cx);
        let hover = p.accent.opacity(0.85);
        let focus = self.projects.menu_focus.min(entries.len().saturating_sub(1));
        let rows = entries.into_iter().enumerate().map(|(i, e)| {
            let items = items.clone();
            let action = e.action;
            let color = if e.danger { p.red } else { p.foreground };
            div()
                .when(e.separated, |d| d.child(div().h(px(1.)).mx(px(6.)).my(px(4.)).bg(p.border)))
                .child(
                    h_flex()
                        .id(("projects-menu-item", i))
                        .w_full()
                        .gap(px(16.))
                        .justify_between()
                        .rounded(px(6.))
                        .px(px(8.))
                        .py(px(5.))
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .text_color(color)
                        .cursor_pointer()
                        .when(i == focus, |d| d.bg(hover))
                        .hover(move |s| s.bg(hover))
                        .child(div().min_w_0().truncate().child(e.label.clone()))
                        .when_some(e.shortcut, |d, s| d.child(div().flex_none().text_color(p.muted).child(s)))
                        .on_click(cx.listener(move |this, _, window, cx| this.run_projects_menu(action, items.clone(), window, cx))),
                )
        });
        Some(
            deferred(
                anchored().position(at).snap_to_window_with_margin(px(8.)).child(
                    menu_panel(&p)
                        .id("projects-menu")
                        .occlude()
                        .rounded(px(10.))
                        .p(px(4.))
                        .min_w(px(200.))
                        .max_w(px(280.))
                        .children(rows)
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.projects.menu = None;
                            cx.notify();
                        })),
                ),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }

    /// "Delete the folder …?": what happens to its files and subfolders.
    pub(super) fn render_delete_folder(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::DeleteFolder { name, impact, .. } = &self.dialogs.open else { return div().into_any_element() };
        let (title, body) = delete_message(name, *impact);
        let (fg, hover) = (t.foreground, t.hover_soft());
        self.panel(t, 12.)
            .id("delete-folder-dialog")
            .w(px(400.))
            .p(px(18.))
            .child(div().text_size(px(13.5)).font_weight(FontWeight::SEMIBOLD).mb(px(6.)).child(title))
            .child(div().text_size(px(12.)).line_height(px(18.)).text_color(t.muted).mb(px(16.)).child(body))
            .child(
                h_flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("delete-folder-cancel")
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(7.))
                            .border_1()
                            .border_color(t.border)
                            .text_size(px(12.))
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover).text_color(fg))
                            .child("Cancel")
                            .on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx))),
                    )
                    .child(
                        div()
                            .id("delete-folder-confirm")
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(7.))
                            .bg(t.red)
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gpui_kit::white())
                            .cursor_pointer()
                            .hover(|s| s.opacity(0.9))
                            .child("Delete Folder")
                            .on_click(cx.listener(|this, _, window, cx| this.confirm_delete_folder(window, cx))),
                    ),
            )
            .into_any_element()
    }

    /// Move to…: every folder as an outline, and Unsorted.
    pub(super) fn render_move_to(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::MoveToFolder { items, focused } = &self.dialogs.open else { return div().into_any_element() };
        let rows = destinations(&self.projects.tree, items);
        let focused = *focused;
        let what = match items.as_slice() {
            [one] => format!("\u{201c}{}\u{201d}", self.projects.name_of(one)),
            many => format!("{} items", many.len()),
        };
        let (fg, muted, accent, blue) = (t.foreground, t.muted, t.accent, t.blue);
        let list = rows.into_iter().enumerate().map(|(i, d)| {
            div()
                .id(("move-to-row", i))
                .flex()
                .items_center()
                .gap(px(6.))
                .h(px(26.))
                .pl(px(8. + d.depth as f32 * INDENT))
                .pr(px(8.))
                .rounded(px(6.))
                .text_size(px(12.5))
                .text_color(if d.disabled { fade(muted, 0.6) } else { fg })
                .when(i == focused && !d.disabled, |el| el.bg(accent))
                .when(!d.disabled, |el| el.cursor_pointer().hover(move |s| s.bg(accent)))
                .child(glyph(if d.id.is_some() { FOLDER } else { TRAY }, 14., if d.id.is_some() { fade(blue, 0.85) } else { muted }))
                .child(div().min_w_0().truncate().child(d.name.clone()))
                .when(!d.disabled, |el| el.on_click(cx.listener(move |this, _, window, cx| this.confirm_move_to(i, window, cx))))
        });
        self.panel(t, 12.)
            .id("move-to-dialog")
            .w(px(380.))
            .p(px(16.))
            .child(div().text_size(px(13.5)).font_weight(FontWeight::SEMIBOLD).mb(px(2.)).child(format!("Move {what} to…")))
            .child(div().text_size(px(11.5)).text_color(muted).mb(px(10.)).child("Files stay where they are on your disk."))
            .child(
                div()
                    .id("move-to-list")
                    .max_h(px(320.))
                    .overflow_y_scroll()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(t.border)
                    .p(px(4.))
                    .children(list),
            )
            .child(
                h_flex().mt(px(12.)).justify_end().child(
                    div()
                        .id("move-to-cancel")
                        .px(px(12.))
                        .py(px(6.))
                        .rounded(px(7.))
                        .border_1()
                        .border_color(t.border)
                        .text_size(px(12.))
                        .cursor_pointer()
                        .child("Cancel")
                        .on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx))),
                ),
            )
            .into_any_element()
    }

    /// Move to…'s keys: the arrows step over folders that cannot be picked.
    pub(super) fn move_to_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Overlay::MoveToFolder { items, focused } = &self.dialogs.open else { return false };
        let rows = destinations(&self.projects.tree, items);
        let pickable: Vec<usize> = rows.iter().enumerate().filter(|(_, d)| !d.disabled).map(|(i, _)| i).collect();
        let at = pickable.iter().position(|i| i == focused).unwrap_or(0);
        let next = match key {
            "down" => pickable.get((at + 1).min(pickable.len().saturating_sub(1))).copied(),
            "up" => pickable.get(at.saturating_sub(1)).copied(),
            "home" => pickable.first().copied(),
            "end" => pickable.last().copied(),
            "enter" => {
                let i = *focused;
                self.confirm_move_to(i, window, cx);
                return true;
            }
            _ => return false,
        };
        if let (Some(n), Overlay::MoveToFolder { focused, .. }) = (next, &mut self.dialogs.open) {
            *focused = n;
        }
        cx.notify();
        true
    }

    /// Settings: one row, "Organize files into projects automatically". Drawn
    /// from here so any Settings section can host it.
    pub(super) fn render_auto_organize_setting(&self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let on = self.auto_organize();
        let (blue, track_off) = (t.blue, fade(t.muted, 0.35));
        div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .child(
                div()
                    .child(div().mb(px(4.)).child(super::dialog_chrome::section_label("Projects", t)))
                    .child(div().text_size(px(12.5)).child("Organize files into projects automatically"))
                    .child(
                        div()
                            .max_w(px(380.))
                            .text_size(px(11.5))
                            .line_height(px(18.))
                            .text_color(t.muted)
                            .child("Groups the files you have not put in a folder by their repository, front matter and when you worked on them. Folders you make always win."),
                    ),
            )
            .child(
                div()
                    .id("auto-organize-switch")
                    .flex_none()
                    .mt(px(14.))
                    .w(px(34.))
                    .h(px(20.))
                    .rounded_full()
                    .p(px(2.))
                    .bg(if on { blue } else { track_off })
                    .cursor_pointer()
                    .flex()
                    .when(on, |el| el.justify_end())
                    .child(div().size(px(16.)).rounded_full().bg(gpui_kit::white()).shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.2), offset: point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: false }]))
                    .on_click(cx.listener(move |this, _, _, cx| this.set_auto_organize(!on, cx))),
            )
            .into_any_element()
    }
}

/// Paths given as files: Finder drops and pickers.
#[allow(dead_code)]
pub(super) fn file_items(paths: &[PathBuf]) -> Vec<Item> {
    paths.iter().map(|p| Item::File(p.to_string_lossy().into_owned())).collect()
}

#[cfg(feature = "scene")]
impl Workspace {
    /// The Projects tab in a named state, reached through the functions its
    /// controls call. Rows are named by their label (a folder or file name).
    /// - `folders`: `[{name, open?, files?: [paths], children?: [...]}]`, made
    ///   in the scratch registry first;
    /// - `select`: labels to select (⌘-click each); `focus: false` leaves the
    ///   outline without the keyboard;
    /// - `drop`: `{row, zone: "into" | "before" | "after", items: [labels]}`,
    ///   a drag held over a row: its highlight or insertion line;
    /// - `menu`: a label whose right-click menu is open (`""` the open area);
    /// - `confirm`: a folder whose Delete Folder is asking;
    /// - `moveto`: labels for Move to…; `rename`: a folder being renamed;
    /// - `auto: true`: automatic grouping on; `filter`: search words.
    pub(super) fn scene_projects(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use markie_core::projects::folders;
        use serde_json::Value;
        let labels = |key: &str| -> Vec<String> { args.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default() };
        match *step {
            0 => {
                let Some(reg) = self.registry.clone() else { return true };
                let db = reg.conn();
                if args.get("auto").and_then(Value::as_bool).unwrap_or(false) {
                    let _ = folders::set_auto_organize(db, true);
                }
                let _ = folders::mark_migrated(db);
                fn seed(db: &rusqlite::Connection, parent: Option<&str>, list: &[Value], open: &mut Vec<String>) {
                    for f in list {
                        let name = f.get("name").and_then(Value::as_str).unwrap_or("Folder");
                        let Ok(id) = folders::create_folder(db, parent, name) else { continue };
                        let files: Vec<String> = f.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                        let _ = folders::place_files(db, &files, &id, None);
                        if f.get("open").and_then(Value::as_bool).unwrap_or(false) {
                            open.push(id.clone());
                        }
                        seed(db, Some(&id), f.get("children").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), open);
                    }
                }
                let mut open = Vec::new();
                seed(db, None, args.get("folders").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), &mut open);
                self.show_projects_tab(cx);
                self.projects.open.extend(open);
                *step = 1;
                false
            }
            1 => {
                if !self.shell.lists_loaded {
                    return false;
                }
                self.reload_folders(cx);
                let filter = args.get("filter").and_then(Value::as_str).unwrap_or_default().to_string();
                if !filter.is_empty() {
                    self.projects.query = filter.clone();
                    self.projects.filter.update(cx, |s, cx| s.set_value(filter, window, cx));
                }
                let rows = self.projects.rows();
                let order = Projects::order(&rows);
                let find = |label: &str| -> Option<(usize, Row)> {
                    rows.iter().enumerate().find(|(_, r)| match r {
                        Row::Folder { name, .. } | Row::File { name, .. } => name == label,
                        _ => false,
                    }).map(|(i, r)| (i, r.clone()))
                };
                let item_of = |label: &str| find(label).and_then(|(_, r)| r.item());
                if args.get("focus").and_then(Value::as_bool).unwrap_or(true) {
                    self.projects.focus.focus(window, cx);
                }
                for l in labels("select") {
                    if let Some(i) = item_of(&l) {
                        self.projects.selection.press(&i, true, false, &order);
                    }
                }
                if let Some(d) = args.get("drop") {
                    let row = d.get("row").and_then(Value::as_str).unwrap_or_default();
                    let zone = match d.get("zone").and_then(Value::as_str) {
                        Some("before") => Zone::Before,
                        Some("after") => Zone::After,
                        _ => Zone::Into,
                    };
                    let items: Vec<Item> = d.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_str()).filter_map(item_of).collect();
                    if let Some((ix, r)) = find(row)
                        && let Some(t) = target_for(&r, zone).filter(|t| drop_allowed(&items, t, &self.projects.tree))
                    {
                        self.projects.drop = Some((ix, zone, t));
                    }
                }
                if let Some(m) = args.get("menu").and_then(Value::as_str) {
                    let (items, ix) = match find(m) {
                        Some((ix, r)) => {
                            let item = r.item().into_iter().collect::<Vec<_>>();
                            if let Some(i) = item.first() {
                                if !self.projects.selection.contains(i) {
                                    self.projects.selection.press(i, false, false, &order);
                                }
                            }
                            let sel = self.projects.selection.items.clone();
                            (if sel.len() > 1 { sel } else { item }, ix)
                        }
                        None => (Vec::new(), rows.len()),
                    };
                    let y = 72. + 45. + 46. + ROW_H * (ix + 1) as f32;
                    self.open_projects_menu(items, point(px(super::rail::RAIL_WIDTH + 120.), px(y)), cx);
                }
                if let Some(c) = args.get("confirm").and_then(Value::as_str)
                    && let Some(Item::Folder(id)) = item_of(c)
                {
                    self.ask_delete_folder(id, window, cx);
                }
                let moving: Vec<Item> = labels("moveto").iter().filter_map(|l| item_of(l)).collect();
                if !moving.is_empty() {
                    self.ask_move_to(moving, window, cx);
                }
                if let Some(r) = args.get("rename").and_then(Value::as_str)
                    && let Some(Item::Folder(id)) = item_of(r)
                {
                    self.start_folder_rename(&id, window, cx);
                }
                *step = 2;
                cx.notify();
                false
            }
            _ => true,
        }
    }
}
