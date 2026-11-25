//! The Browse page's look: "Documents on this Mac" in the document area, a
//! folder tree on the left and the chosen folder's contents on the right.
//! What it shows is built in `browse.rs`; this file only draws it, in the
//! vault page's style (one filled button per state, outlined and quiet ones
//! beside it, tinted banners, the template's own colours).

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::Ordering;

use gpui_kit::assets::IconName;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::index::Truncation;

use super::super::Workspace;
use super::super::chrome::{segment_on, segmented};
use super::super::vault::ui::{Kind, Tone, banner, button, hint};
use super::browse::{PaneRow, View, pane_summary, shown_crumbs, status_line};
use super::{FilterMenu, compact_dir, compact_home, filter_field, format_badge, format_icon, group_thousands, type_menu_label, updated_ago};
use crate::actions::{OpenFolder, Rescan};
use crate::library::{LibraryTab, SortOrder};
use crate::themes::{self, Palette};

/// A tree row, a contents row, and a match row (name over its folder).
const TREE_ROW: f32 = 28.;
const PANE_ROW: f32 = 36.;
const MATCH_ROW: f32 = 48.;

fn section_label(text: &'static str, p: &Palette) -> Div {
    div().px(px(14.)).pt(px(12.)).pb(px(4.)).text_size(px(10.5)).font_weight(FontWeight::MEDIUM).text_color(p.muted).child(text)
}

/// A centred message with its next step, for the states with nothing to list.
fn message(icon: IconName, title: impl Into<SharedString>, text: impl Into<SharedString>, p: &Palette) -> Div {
    v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .px(px(28.))
        .pb(px(40.))
        .child(
            div()
                .mb(px(8.))
                .size(px(44.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(12.))
                .border_1()
                .border_color(p.border)
                .bg(p.fg(0.04))
                .text_color(p.muted)
                .child(Icon::new(icon)),
        )
        .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_center().child(title.into()))
        .child(div().max_w(px(420.)).text_center().text_size(px(13.)).line_height(px(19.)).text_color(p.muted).child(text.into()))
}

/// Why the walk stopped early, in a sentence.
fn truncation_text(why: Option<Truncation>) -> &'static str {
    match why {
        Some(Truncation::Files) => "This Mac has more documents than Markie lists at once, so some are missing here. Add a folder to make sure it is included.",
        Some(Truncation::Depth) => "Some folders are nested too deep for Markie to reach, so their documents are missing here. Add a folder to make sure it is included.",
        _ => "Markie stopped looking after 30 seconds, so some folders are missing here. Add a folder to make sure it is included.",
    }
}

impl Workspace {
    /// The whole page, in place of the document.
    pub(in crate::workspace) fn render_browse_page(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
        // Past the page column's width the page stays against the rail, as
        // Finder keeps its sidebar, and the spare room is on the right: the
        // folder tree sits next to the rail, and the header, toolbar and list
        // keep the column's width so names stay near their dates.
        let spare = 2. * super::super::recent_page::page_gutter(f32::from(window.viewport_size().width));
        let lib = &self.library;
        let view = self.shell.browse.view.clone().unwrap_or_default();
        let total = lib.docs().len();
        let first_scan = lib.scanning && total == 0;
        let checked = if lib.scanned_at_ms > 0 { updated_ago(lib.scanned_at_ms as f64, chrono::Local::now()) } else { String::new() };
        let found = self.shell.browse.found.load(Ordering::Relaxed);
        let status = status_line(total, lib.folders, lib.scanning, found, &checked);

        let header = h_flex()
            .flex_none()
            .h(px(56.))
            .items_center()
            .gap(px(10.))
            .border_b_1()
            .border_color(p.border)
            .pl(px(20.))
            .pr(px(20. + spare))
            .child(div().flex_none().text_color(p.foreground).child(Icon::new(IconName::Laptop)))
            .child(div().flex_none().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child("Documents on this Mac"))
            .when(lib.scanning, |el| el.child(Spinner::new().small().color(p.muted)))
            .child(hint(status, &p).flex_1().min_w_0().truncate())
            .child(button("browse-rescan", "Rescan", Some(IconName::RefreshCw), Tone::Quiet, lib.scanning, &p).when(!lib.scanning, |b| {
                b.on_click(|_, window, cx| window.dispatch_action(Box::new(Rescan), cx))
            }))
            .child(
                button("browse-add-folder", "Add Folder…", Some(IconName::FolderPlus), if total == 0 && !lib.scanning { Tone::Primary } else { Tone::Secondary }, false, &p)
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(OpenFolder), cx)),
            );

        let page = v_flex()
            .id("browse-page")
            .size_full()
            .bg(p.background)
            .text_color(p.foreground)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| this.browse_key(event, window, cx)))
            .child(header);
        if first_scan {
            return page
                .child(message(
                    IconName::FolderSearch,
                    "Looking for documents on this Mac",
                    "Markie checks your home folder for files it can open. This takes a few seconds the first time.",
                    &p,
                ))
                .into_any_element();
        }
        if total == 0 {
            return page
                .child(message(
                    IconName::FolderSearch,
                    "No documents found on this Mac",
                    "Markie looked in your home folder for Markdown, Word, text and data files. If yours are somewhere else, add that folder.",
                    &p,
                ))
                .into_any_element();
        }
        page.child(self.render_browse_toolbar(&p, cx).pl(px(20.)).pr(px(20. + spare)))
            .when(lib.truncated, |el| {
                el.child(div().flex_none().pl(px(20.)).pr(px(20. + spare)).pt(px(12.)).child(banner(Kind::Info, truncation_text(lib.truncation), &p)))
            })
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_stretch()
                    .child(self.render_browse_tree(view.clone(), &p, cx))
                    .child(self.render_browse_pane(view, spare, &p, cx)),
            )
            .into_any_element()
    }

    /// Find, type, sort and starred, in one row.
    fn render_browse_toolbar(&self, p: &Palette, cx: &mut Context<Self>) -> Div {
        let p = *p;
        let lib = &self.library;
        let typed = !lib.text().trim().is_empty();
        let starred = lib.tab == LibraryTab::Starred;
        let narrowed = typed || lib.only_format().is_some() || starred;
        // With words typed the list starts as best match first.
        let orders: &[(SortOrder, &str)] = if typed {
            &[(SortOrder::Default, "Best match"), (SortOrder::Name, "Name"), (SortOrder::Recent, "Updated")]
        } else {
            &[(SortOrder::Name, "Name"), (SortOrder::Recent, "Updated")]
        };
        let sort_seg = segmented(&p).flex_none().children(orders.iter().map(|(order, label)| {
            let order = *order;
            let on = lib.sort == order || (!typed && order == SortOrder::Name && lib.sort == SortOrder::Default);
            div()
                .id(SharedString::from(format!("bsort-{label}")))
                .h(px(28.))
                .px(px(10.4))
                .flex()
                .items_center()
                .rounded(px(7.))
                .text_size(px(11.5))
                .text_color(if on { p.foreground } else { p.muted })
                .when(on, |el| el.bg(segment_on(&p)))
                .hover(|s| s.text_color(p.foreground))
                .child(*label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.library.set_sort(order);
                    this.shell.browse.view = None;
                    cx.notify();
                }))
        }));
        h_flex()
            .flex_none()
            .gap(px(8.))
            .px(px(20.))
            .py(px(10.))
            .border_b_1()
            .border_color(p.border)
            .child(div().flex_1().min_w(px(180.)).max_w(px(460.)).child(filter_field(&self.shell.browse.filter, 13., &p)))
            .child(
                h_flex()
                    .relative()
                    .flex_none()
                    .w(px(150.))
                    .child(self.select_button(FilterMenu::BrowseType, type_menu_label(lib.only_format()), &p, cx))
                    .when(self.shell.filter_menu == Some(FilterMenu::BrowseType), |el| el.child(self.render_filter_menu(FilterMenu::BrowseType, &p, cx))),
            )
            .child(sort_seg)
            .child(
                button("browse-starred", "Starred", Some(if starred { IconName::StarFill } else { IconName::Star }), Tone::Quiet, false, &p)
                    .when(starred, |b| b.bg(p.fg(0.08)).text_color(p.foreground))
                    .tooltip(move |window, cx| Tooltip::new(if starred { "Show every document" } else { "Show only starred documents and folders" }).build(window, cx))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.library.set_tab(if starred { LibraryTab::All } else { LibraryTab::Starred });
                        this.shell.browse.view = None;
                        cx.notify();
                    })),
            )
            .child(div().flex_1())
            .when(narrowed, |el| {
                el.child(button("browse-clear", "Clear filters", None, Tone::Quiet, false, &p).on_click(cx.listener(|this, _, window, cx| this.clear_browse_filters(window, cx))))
            })
    }

    /// The left column: shortcuts, then every folder that holds documents.
    fn render_browse_tree(&self, view: Rc<View>, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let now = chrono::Local::now();
        let at_top = view.selected.is_none();
        let selected_bg = if p.dark { p.accent } else { p.fg(0.08) };
        let hover_bg = p.fg(0.05);
        let shortcuts = view.shortcuts.iter().enumerate().map(|(i, s)| {
            let path = s.path.clone();
            let on = view.selected.as_deref() == Some(s.path.as_path());
            h_flex()
                .id(("browse-shortcut", i))
                .h(px(TREE_ROW))
                .mx(px(6.))
                .px(px(8.))
                .gap(px(7.))
                .rounded(px(6.))
                .cursor_pointer()
                .text_size(px(12.5))
                .when(on, |el| el.bg(selected_bg))
                .when(!on, |el| el.hover(|st| st.bg(hover_bg)))
                .child(div().flex_none().text_color(p.muted).child(Icon::new(IconName::Clock).xsmall()))
                .child(div().flex_none().max_w(relative(0.6)).truncate().child(s.label.clone()))
                .child(div().flex_1().min_w_0().truncate().text_size(px(11.)).text_color(p.muted).child(s.place.clone()))
                .child(div().flex_none().text_size(px(11.)).text_color(p.muted).child(updated_ago(s.mtime_ms, now)))
                .on_click(cx.listener(move |this, _, _, cx| this.browse_select(Some(path.clone()), cx)))
        });
        let top = h_flex()
            .id("browse-top")
            .flex_none()
            .h(px(TREE_ROW))
            .mx(px(6.))
            .px(px(8.))
            .gap(px(7.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_size(px(12.5))
            .when(at_top, |el| el.bg(selected_bg).font_weight(FontWeight::MEDIUM))
            .when(!at_top, |el| el.hover(|st| st.bg(hover_bg)))
            .child(div().flex_none().text_color(if at_top { p.blue } else { p.muted }).child(Icon::new(if view.top_label == "Home" { IconName::House } else { IconName::Laptop }).xsmall()))
            .child(div().flex_1().min_w_0().truncate().child(view.top_label.clone()))
            .child(div().flex_none().text_size(px(11.)).text_color(p.muted).child(group_thousands(view.top_count)))
            .on_click(cx.listener(|this, _, _, cx| this.browse_select(None, cx)));
        let rows = view.clone();
        let home = Self::browse_home();
        let tree = uniform_list(
            "browse-tree",
            view.tree.len(),
            cx.processor(move |_, range: std::ops::Range<usize>, _, cx| {
                let p = themes::palette(cx);
                range
                    .map(|ix| {
                        let row = &rows.tree[ix];
                        let on = rows.selected.as_deref() == Some(row.path.as_path());
                        let (select, toggle) = (row.path.clone(), row.path.clone());
                        let place = compact_home(&row.path, &home, true);
                        // One 14 px step per level, with a hairline to follow down.
                        let guides = h_flex().h_full().flex_none().children((0..row.depth).map(|_| div().w(px(14.)).h_full().flex_none().child(div().ml(px(7.)).h_full().border_l_1().border_color(p.border))));
                        let row_el = h_flex()
                            .id(("browse-tree-row", ix))
                            .w_full()
                            .h(px(TREE_ROW))
                            .pl(px(8.))
                            .pr(px(8.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .text_size(px(12.5))
                            .when(on, |el| el.bg(selected_bg).font_weight(FontWeight::MEDIUM))
                            .when(!on, |el| el.hover(|st| st.bg(hover_bg)))
                            .child(guides)
                            .child(
                                div()
                                    .id(("browse-chevron", ix))
                                    .flex_none()
                                    .size(px(18.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(4.))
                                    .text_color(p.muted)
                                    .when(row.expandable, |el| {
                                        el.hover(|st| st.bg(p.fg(0.08)))
                                            .child(Icon::new(if row.open { IconName::ChevronDown } else { IconName::ChevronRight }).xsmall())
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                cx.stop_propagation();
                                                this.toggle_folder(toggle.clone(), cx);
                                            }))
                                    }),
                            )
                            .child(div().flex_none().mr(px(6.)).text_color(if on { p.blue } else { p.muted }).child(Icon::new(if row.open { IconName::FolderOpen } else { IconName::Folder }).xsmall()))
                            .child(div().flex_1().min_w_0().truncate().child(row.label.clone()))
                            .child(div().flex_none().pl(px(6.)).text_size(px(11.)).font_weight(FontWeight::NORMAL).text_color(p.muted).child(group_thousands(row.count)))
                            .tooltip(move |window, cx| Tooltip::new(place.clone()).build(window, cx))
                            .on_click(cx.listener(move |this, _, _, cx| this.browse_select(Some(select.clone()), cx)));
                        div().w_full().px(px(6.)).child(row_el).into_any_element()
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .track_scroll(&self.shell.browse.tree_scroll)
        .flex_1();
        v_flex()
            .id("browse-folders")
            .relative()
            .flex_none()
            .w(px(self.shell.panel_width))
            .h_full()
            .bg(p.surface)
            .border_r_1()
            .border_color(p.border)
            .when(!view.shortcuts.is_empty(), |el| el.child(section_label("RECENTLY CHANGED", &p)).children(shortcuts))
            .child(section_label("FOLDERS", &p))
            .child(top)
            .child(div().flex_1().min_h_0().flex().flex_col().pb(px(8.)).child(tree))
            .child(self.render_resizer(&p, cx))
    }

    /// The right column: where you are, then what is there.
    /// `spare` is the room right of the page column, left empty on a wide
    /// window; the pane's hairlines still run through it.
    fn render_browse_pane(&self, view: Rc<View>, spare: f32, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let lib = &self.library;
        let text = lib.text().trim().to_string();
        let typed = !text.is_empty();
        let crumbs = shown_crumbs(&view.crumbs, 3);
        let last = crumbs.len().saturating_sub(1);
        let mut trail = h_flex().flex_1().min_w_0().gap(px(2.)).overflow_hidden();
        for (i, crumb) in crumbs.into_iter().enumerate() {
            if i > 0 {
                trail = trail.child(div().flex_none().text_color(p.muted.opacity(0.7)).child(Icon::new(IconName::ChevronRight).xsmall()));
            }
            let here = i == last;
            let path = crumb.path.clone();
            trail = trail.child(
                div()
                    .id(("browse-crumb", i))
                    .when(!here, |el| el.flex_none().max_w(px(220.)))
                    .when(here, |el| el.min_w_0())
                    .truncate()
                    .px(px(6.))
                    .py(px(3.))
                    .rounded(px(5.))
                    .text_size(px(13.))
                    .when(here, |el| el.font_weight(FontWeight::SEMIBOLD).text_color(p.foreground))
                    .when(!here, |el| {
                        let fg = p.foreground;
                        el.text_color(p.muted).cursor_pointer().hover(move |st| st.bg(p.fg(0.06)).text_color(fg)).on_click(cx.listener(move |this, _, _, cx| this.browse_select(path.clone(), cx)))
                    })
                    .child(crumb.label),
            );
        }
        let bar = h_flex()
            .flex_none()
            .h(px(44.))
            .gap(px(12.))
            .pl(px(14.))
            .pr(px(20. + spare))
            .border_b_1()
            .border_color(p.border.opacity(0.7))
            .child(trail)
            .child(div().flex_none().text_size(px(12.)).text_color(p.muted).child(pane_summary(&view)));

        let folder_name = view.crumbs.last().map(|c| c.label.clone()).unwrap_or_default();
        let body: AnyElement = if view.pane.is_empty() {
            let somewhere = view.selected.is_some();
            let (title, hint_text) = if typed {
                (
                    if somewhere { format!("No documents match “{text}” in {folder_name}") } else { format!("No documents match “{text}”") },
                    if somewhere { "Search every folder, or try another word." } else if lib.only_format().is_some() { "Try another word, or include every type." } else { "Try another word or a shorter one." },
                )
            } else if lib.tab == LibraryTab::Starred {
                ("Nothing starred here".to_string(), "Star a document or a folder to find it here.")
            } else {
                ("Nothing of this type here".to_string(), "Choose another folder, or include every type.")
            };
            let primary = if typed && somewhere {
                button("browse-everywhere", "Search every folder", None, Tone::Primary, false, &p).on_click(cx.listener(|this, _, _, cx| this.browse_select(None, cx)))
            } else {
                button("browse-clear-here", "Clear filters", None, Tone::Primary, false, &p).on_click(cx.listener(|this, _, window, cx| this.clear_browse_filters(window, cx)))
            };
            message(IconName::SearchX, title, hint_text, &p).child(h_flex().mt(px(10.)).gap(px(8.)).child(primary)).into_any_element()
        } else {
            let rows = view.clone();
            let current = self.doc.as_ref().map(|d| d.path.clone());
            let home = Self::browse_home();
            let query = text.clone();
            uniform_list(
                "browse-pane",
                view.pane.len(),
                cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                    let p = themes::palette(cx);
                    let now = chrono::Local::now();
                    let cursor = this.shell.browse.cursor;
                    let cursor_bg = if p.dark { p.accent.opacity(0.72) } else { p.fg(0.07) };
                    range.map(|ix| this.browse_pane_row(&rows.pane[ix], ix, cursor == Some(ix), cursor_bg, current.as_deref(), &home, &query, now, &p, cx)).collect::<Vec<_>>()
                }),
            )
            .track_scroll(&self.shell.browse.pane_scroll)
            .flex_1()
            .into_any_element()
        };
        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(bar)
            .when_some(self.shell.browse.gone.clone(), |el, name| {
                el.child(div().flex_none().pl(px(20.)).pr(px(20. + spare)).pt(px(12.)).child(banner(Kind::Info, format!("“{name}” is no longer there. This is the closest folder that still is."), &p)))
            })
            .child(div().flex_1().min_h_0().flex().flex_col().py(px(6.)).pr(px(spare)).child(body))
            .when(typed && !view.pane.is_empty(), |el| {
                el.child(
                    h_flex()
                        .flex_none()
                        .justify_between()
                        .pl(px(20.))
                        .pr(px(20. + spare))
                        .py(px(7.))
                        .border_t_1()
                        .border_color(p.border.opacity(0.7))
                        .text_size(px(11.))
                        .text_color(p.muted)
                        .child(if view.selected.is_some() { format!("Matches in {folder_name} and the folders inside it") } else { "Matches in every folder".to_string() })
                        .child(h_flex().gap(px(12.)).child("↑↓ move").child("↵ open").child("esc clear")),
                )
            })
    }

    /// One contents row: a folder, a document, or a filter match with its path.
    #[allow(clippy::too_many_arguments)]
    fn browse_pane_row(
        &self,
        row: &PaneRow,
        ix: usize,
        on_cursor: bool,
        cursor_bg: Hsla,
        current: Option<&Path>,
        home: &Path,
        query: &str,
        now: chrono::DateTime<chrono::Local>,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = *p;
        let hover_bg = p.fg(0.045);
        let group = SharedString::from(format!("browse-row-{ix}"));
        let star = |id: SharedString, path: PathBuf, kind: &'static str, on: bool, group: SharedString, cx: &mut Context<Self>| {
            let fg = p.foreground;
            div()
                .id(id)
                .flex_none()
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .when(on, |d| d.text_color(p.yellow))
                .when(!on, |d| d.text_color(p.muted).opacity(0.).group_hover(group, |s| s.opacity(1.)).hover(move |s| s.text_color(fg).bg(p.fg(0.07))))
                .tooltip(move |window, cx| Tooltip::new(if on { "Remove star" } else { "Star" }).build(window, cx))
                .child(Icon::new(if on { IconName::StarFill } else { IconName::Star }).xsmall())
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.toggle_browse_star(path.clone(), kind, window, cx);
                }))
        };
        let when = |ms: f64| div().flex_none().w(px(76.)).text_right().text_size(px(11.5)).text_color(p.muted).child(updated_ago(ms, now));
        let shell = |height: f32| {
            h_flex()
                .id(("browse-pane-row", ix))
                .group(group.clone())
                .w_full()
                .h(px(height))
                .pl(px(12.))
                .pr(px(8.))
                .gap(px(10.))
                .rounded(px(7.))
                .cursor_pointer()
                .text_size(px(13.))
                .when(on_cursor, |el| el.bg(cursor_bg))
                .when(!on_cursor, |el| el.hover(|st| st.bg(hover_bg)))
                .on_click(cx.listener(move |this, _, window, cx| this.browse_activate(ix, window, cx)))
        };
        match row {
            PaneRow::Folder { path, label, count, latest_mtime_ms } => {
                let starred = self.shell.stars.contains(path);
                let place = compact_home(path, home, true);
                let el = shell(PANE_ROW)
                    .child(div().flex_none().text_color(p.blue).child(Icon::new(IconName::Folder).small()))
                    .child(div().flex_1().min_w_0().truncate().font_weight(FontWeight::MEDIUM).child(label.clone()))
                    .child(div().flex_none().text_size(px(11.5)).text_color(p.muted).child(super::browse::counted(*count, "document", "documents")))
                    .child(when(*latest_mtime_ms))
                    .child(star(SharedString::from(format!("bstar-d-{ix}")), path.clone(), "folder", starred, group.clone(), cx))
                    .child(div().flex_none().size(px(26.)).flex().items_center().justify_center().text_color(p.muted).child(Icon::new(IconName::ChevronRight).xsmall()))
                    .tooltip(move |window, cx| Tooltip::new(place.clone()).build(window, cx));
                div().w_full().px(px(8.)).child(el).into_any_element()
            }
            PaneRow::File { hit } | PaneRow::Match { hit } => {
                let Some(hit_row) = self.library.hits().get(*hit) else { return div().h(px(PANE_ROW)).into_any_element() };
                let doc = self.library.doc(hit_row);
                let is_match = matches!(row, PaneRow::Match { .. });
                let starred = self.shell.stars.contains(&doc.path);
                let open_here = current == Some(doc.path.as_path());
                let menu_open = self.shell.row_menu.as_ref().is_some_and(|(m, _)| *m == doc.path);
                let (menu_path, context_path) = (doc.path.clone(), doc.path.clone());
                let place = compact_home(&doc.path, home, true);
                let fg = p.foreground;
                let name = super::super::projects::marked(&doc.name, &markie_core::doc_text::highlight_ranges(&doc.name, query), &p);
                let title = div().truncate().when(open_here, |el| el.font_weight(FontWeight::MEDIUM)).child(name);
                let label: AnyElement = if is_match {
                    // The folder says which of several same-named documents this is.
                    let folder = compact_dir(&doc.dir, home, 4);
                    let folder_marks = markie_core::doc_text::highlight_ranges(&folder, query);
                    let in_name = !markie_core::doc_text::highlight_ranges(&doc.name, query).is_empty();
                    let excerpt = hit_row.excerpt.clone().filter(|_| !in_name && folder_marks.is_empty());
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(1.))
                        .child(title)
                        .child(
                            h_flex()
                                .gap(px(8.))
                                .text_size(px(11.5))
                                .text_color(p.muted)
                                .child(div().when(excerpt.is_some(), |el| el.flex_none().max_w(relative(0.5))).truncate().child(super::super::projects::marked(&folder, &folder_marks, &p)))
                                .when_some(excerpt, |el, ex| {
                                    let ex = ex.split_whitespace().collect::<Vec<_>>().join(" ");
                                    let marks = markie_core::doc_text::highlight_ranges(&ex, query);
                                    el.child(div().flex_1().min_w_0().truncate().text_color(p.fg(0.7)).child(super::super::projects::marked(&ex, &marks, &p)))
                                }),
                        )
                        .into_any_element()
                } else {
                    div().flex_1().min_w_0().child(title).into_any_element()
                };
                let el = shell(if is_match { MATCH_ROW } else { PANE_ROW })
                    .when(open_here && !on_cursor, |el| el.bg(p.accent.opacity(0.35)))
                    .child(format_icon(doc.format, 16., &p))
                    .child(label)
                    .child(format_badge(doc.format, &p))
                    .child(when(doc.mtime_ms))
                    .child(star(SharedString::from(format!("bstar-f-{ix}")), doc.path.clone(), "file", starred, group.clone(), cx))
                    .child(
                        div()
                            .id(("browse-more", ix))
                            .flex_none()
                            .size(px(26.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(5.))
                            .text_color(p.muted)
                            .when(menu_open, |d| d.bg(p.fg(0.07)).text_color(fg))
                            .when(!menu_open, |d| d.opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)))
                            .hover(move |s| s.text_color(fg).bg(p.fg(0.07)))
                            .tooltip(|window, cx| Tooltip::new("Actions").build(window, cx))
                            .child(Icon::new(IconName::Ellipsis).xsmall())
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                                cx.stop_propagation();
                                let at = ev.position();
                                this.open_row_menu(menu_path.clone(), point(at.x - px(150.), at.y + px(14.)), cx);
                            })),
                    )
                    .tooltip(move |window, cx| Tooltip::new(place.clone()).build(window, cx))
                    .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                        this.shell.row_menu = None;
                        this.open_row_menu(context_path.clone(), ev.position, cx);
                    }));
                div().w_full().px(px(8.)).child(el).into_any_element()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Truncation, truncation_text};

    #[test]
    fn user_visible_copy_has_no_em_dashes() {
        let source = include_str!("browse_page.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        let in_strings = code.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.contains('\u{2014}'));
        assert!(!in_strings);
        for why in [None, Some(Truncation::Files), Some(Truncation::Time), Some(Truncation::Depth)] {
            assert!(truncation_text(why).ends_with("Add a folder to make sure it is included."));
        }
    }
}
