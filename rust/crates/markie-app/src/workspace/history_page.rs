//! The History page (File › History…, ⌥⌘Y): Electron's super-nightly
//! `version-history-view.tsx`, the way Google Docs does it. The selected
//! version fills the document area, read-only, and a panel on the right
//! lists every version Markie holds, grouped by day and month, with runs of
//! autosaves folded under one row.
//!
//! "Highlight changes" compares the selected version with the version
//! before it, as Electron's does: that shows what each save changed, which
//! is what a row's author and time describe. A folded run compares with the
//! version before the whole run.
//!
//! Markie RS adds Older and Newer arrows beside the list's title, so the
//! versions can be stepped through by click as well as with ↑ and ↓. One
//! press on a row selects it and shows it at once; nothing folds closed
//! under the pointer.
//!
//! Restoring never writes: the version is loaded into the editor as
//! unsaved, so looking through history cannot cost anyone the document.
//!
//! Word, RTF and ODT documents keep the dialog (`history_dialog.rs`), as
//! Electron keeps its document shell's own recovery history for them.

use std::ops::Range;
use std::path::PathBuf;

use gpui_kit::component::TitleBar;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::formats::FormatKind;
use markie_core::history::VersionMeta;
use markie_core::version_diff::{self, DEL_CLOSE, DEL_OPEN, DiffSpan, INS_CLOSE, INS_OPEN, SpanKind};
use markie_core::version_list::{self as vl, AuthorTone};
use markie_editor::RichView;
use markie_rich::editor::{Editor, Pos, tree};
use markie_rich::edit::Unit;
use markie_rich::model::TextStyle;
use markie_rich::{BlockContent, Document};

use super::chrome::{TITLE_BAR_HEIGHT, hover_fill, icon, menu_panel, no_drag};
use super::history_model::{HistoryModel, VersionId};
use super::{DocKind, OpenDoc, Workspace};
use crate::themes::{self, Palette, hex};

/// What the document area holds, and what it was made from.
#[derive(Clone, Debug, PartialEq)]
struct ShownKey {
    id: VersionId,
    base: Option<String>,
    highlight: bool,
    dark: bool,
    /// Whether the selection and its base had been read.
    read: (bool, bool),
}

enum Shown {
    Loading,
    Unreadable,
    /// `skipped`: too long to highlight; the version shows as it was.
    Rich { skipped: bool },
    Source { spans: Vec<DiffSpan>, skipped: bool },
}

pub(super) struct HistoryPage {
    model: HistoryModel,
    path: PathBuf,
    name: String,
    /// Markdown draws in the rich view; everything else as source.
    markdown: bool,
    /// Who wrote the text on screen (`history-head`).
    head: Option<VersionMeta>,
    highlight: bool,
    /// The "Which versions" menu, and where it opens.
    filter_menu: Option<Point<Pixels>>,
    /// The row whose ⋯ menu is open, and where.
    menu_for: Option<(VersionId, Point<Pixels>)>,
    renaming: Option<(VersionId, Entity<InputState>)>,
    _rename_sub: Option<Subscription>,
    notice: Option<(SharedString, u64)>,
    view: Entity<RichView>,
    shown_key: Option<ShownKey>,
    shown: Shown,
    pub(super) focus: FocusHandle,
    list_scroll: ScrollHandle,
    source_scroll: ScrollHandle,
}

/// Electron's diff colours, fixed per tone (`version-history.css`): a theme
/// colour that is not green and red would not read as a change.
struct DiffColors {
    ins_bg: Hsla,
    del_bg: Hsla,
    del_fg: &'static str,
    ins_edge: Hsla,
    del_edge: Hsla,
}

fn diff_colors(dark: bool) -> DiffColors {
    if dark {
        DiffColors {
            ins_bg: hex("#4ade80").opacity(0.24),
            del_bg: hex("#f87171").opacity(0.14),
            del_fg: "#fca5a5",
            ins_edge: hex("#4ade80"),
            del_edge: hex("#f87171"),
        }
    } else {
        DiffColors {
            ins_bg: hex("#16a34a").opacity(0.18),
            del_bg: hex("#dc2626").opacity(0.09),
            del_fg: "#b91c1c",
            ins_edge: hex("#16a34a"),
            del_edge: hex("#dc2626"),
        }
    }
}

fn is_sentinel(c: char) -> bool {
    matches!(c, INS_OPEN | INS_CLOSE | DEL_OPEN | DEL_CLOSE)
}

/// A leaf's units with the sentinels taken out, and where each marked run
/// now sits. Removed text in a rich leaf is struck through in red; code,
/// TeX and kept source show their runs as tints only.
fn strip_units(units: Vec<Unit>, rich: bool, del_fg: &str) -> (Vec<Unit>, Vec<(Range<usize>, SpanKind)>) {
    let mut out = Vec::with_capacity(units.len());
    let mut runs = Vec::new();
    let mut state = SpanKind::Same;
    let mut start = 0;
    let close = |state: SpanKind, start: usize, end: usize, runs: &mut Vec<(Range<usize>, SpanKind)>| {
        if state != SpanKind::Same && end > start {
            runs.push((start..end, state));
        }
    };
    for unit in units {
        match unit {
            Unit::Char(c, _) if is_sentinel(c) => {
                close(state, start, out.len(), &mut runs);
                state = match c {
                    INS_OPEN => SpanKind::Ins,
                    DEL_OPEN => SpanKind::Del,
                    _ => SpanKind::Same,
                };
                start = out.len();
            }
            Unit::Char(c, mut marks) => {
                if state == SpanKind::Del && rich {
                    marks.strike = true;
                    let mut style = marks.text_style.take().unwrap_or_default();
                    style.color = Some(del_fg.to_string());
                    marks.text_style = Some(TextStyle { ..style });
                }
                out.push(Unit::Char(c, marks));
            }
            other => out.push(other),
        }
    }
    close(state, start, out.len(), &mut runs);
    (out, runs)
}

/// What `diff_document` makes: the rich document, the marked runs by
/// position for the view to tint, and the blocks only one side has.
pub(super) struct DiffDocument {
    pub editor: Editor,
    pub runs: Vec<(Pos, Pos, SpanKind)>,
    /// Blocks every word of which was added (or removed): drawn as one band,
    /// as Electron wraps such a block in `.markie-vh-block`.
    pub whole: Vec<(usize, SpanKind)>,
}

/// Units that carry content: everything but whitespace.
fn solid(u: &Unit) -> bool {
    !matches!(u, Unit::Char(c, _) if c.is_whitespace())
}

/// The rich document for sentinel-marked Markdown (`version_diff`). Marks
/// never cross a leaf: each is made per line, as Electron's stop at the end
/// of their block.
pub(super) fn diff_document(marked: &str, del_fg: &str) -> DiffDocument {
    let mut doc = Document::parse(marked);
    let mut runs = Vec::new();
    let mut whole = Vec::new();
    for (b, block) in doc.blocks.iter_mut().enumerate() {
        let mut block_runs: Vec<(Pos, Pos, SpanKind)> = Vec::new();
        // Content units in the block, and how many sit in added and removed runs.
        let mut counts = [0usize; 3];
        let tally = |counts: &mut [usize; 3], out: &[Unit], leaf_runs: &[(Range<usize>, SpanKind)]| {
            counts[0] += out.iter().filter(|u| solid(u)).count();
            for (r, k) in leaf_runs {
                let n = out[r.clone()].iter().filter(|u| solid(u)).count();
                counts[if *k == SpanKind::Ins { 1 } else { 2 }] += n;
            }
        };
        match &mut block.content {
            BlockContent::Nodes(nodes) => {
                for (l, leaf) in tree::leaves(nodes).iter().enumerate() {
                    if !leaf.kind.has_text() {
                        counts[0] += 1;
                        continue;
                    }
                    let units = tree::leaf_units(nodes, leaf);
                    if !units.iter().any(|u| matches!(u, Unit::Char(c, _) if is_sentinel(*c))) {
                        tally(&mut counts, &units, &[]);
                        continue;
                    }
                    let (out, leaf_runs) = strip_units(units, leaf.kind.is_rich(), del_fg);
                    tally(&mut counts, &out, &leaf_runs);
                    tree::set_leaf_units(nodes, leaf, &out);
                    block_runs.extend(leaf_runs.into_iter().map(|(r, k)| (Pos::new(b, l, r.start), Pos::new(b, l, r.end), k)));
                }
            }
            BlockContent::Opaque(_) => {
                let units: Vec<Unit> = block.source.chars().map(|c| Unit::Char(c, Default::default())).collect();
                if block.source.chars().any(is_sentinel) {
                    let (out, leaf_runs) = strip_units(units, false, del_fg);
                    tally(&mut counts, &out, &leaf_runs);
                    block.source = out.iter().map(Unit::display).collect();
                    block_runs.extend(leaf_runs.into_iter().map(|(r, k)| (Pos::new(b, 0, r.start), Pos::new(b, 0, r.end), k)));
                } else {
                    tally(&mut counts, &units, &[]);
                }
            }
        }
        let [total, ins, del] = counts;
        let kind = if total > 0 && ins == total {
            Some(SpanKind::Ins)
        } else if total > 0 && del == total {
            Some(SpanKind::Del)
        } else {
            None
        };
        match kind {
            // The band says it all: no word tints inside it. Removed text
            // keeps its red strike, as Electron's removed block does.
            Some(k) => whole.push((b, k)),
            None => runs.extend(block_runs),
        }
    }
    DiffDocument { editor: Editor::new(doc), runs, whole }
}

/// A Markdown document without its front matter, as the rendered view
/// shows it (`splitFrontMatter(...).body`).
fn body(text: &str) -> &str {
    &text[markie_core::outline::front_matter_len(text)..]
}

fn tone_color(tone: AuthorTone, p: &Palette) -> Hsla {
    match tone {
        AuthorTone::Blue => p.blue,
        AuthorTone::Muted => p.muted,
        AuthorTone::Purple => hex(if p.dark { "#c084fc" } else { "#9333ea" }),
        AuthorTone::Orange => hex(if p.dark { "#fb923c" } else { "#ea580c" }),
        AuthorTone::Green => p.green,
        AuthorTone::Yellow => p.yellow,
        AuthorTone::Teal => hex("#2dd4bf"),
        AuthorTone::Pink => hex("#f472b6"),
    }
}

fn now() -> chrono::DateTime<chrono::Local> {
    chrono::Local::now()
}

/// The selection's row id, for element ids.
fn id_key(id: &VersionId) -> String {
    match id {
        VersionId::Current => "current".into(),
        VersionId::Stamp(s) => s.clone(),
    }
}

impl Workspace {
    /// Is the History page up instead of the window's usual layout?
    pub(super) fn history_page_open(&self) -> bool {
        self.history_page.is_some()
    }

    /// File › History… and ⌥⌘Y for a text document with a file. Word, RTF
    /// and ODT documents open the recovery dialog instead.
    pub(super) fn open_history_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        if doc.untitled || !matches!(doc.kind, DocKind::Text { .. }) {
            return;
        }
        let (path, format, large) = (doc.path.clone(), doc.format, doc.large);
        self.settle_edit_now(cx);
        let current = self.current_text(cx);
        let mut entries = self.history.list(&path);
        entries.reverse();
        let head = if self.dirty { None } else { self.history.head(&path, &current) };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "this document".into());
        let view = cx.new(|cx| {
            let mut r = RichView::new(cx);
            r.read_only = true;
            r.sample = Some((28., 40.));
            r.load("", path.parent().map(|p| p.to_path_buf()), cx);
            r
        });
        let grants = self.file_grants.clone();
        let roots = self.registry.as_ref().and_then(|r| r.roots().ok()).unwrap_or_default();
        view.update(cx, |r, cx| r.set_media_grants(grants, roots, cx));
        let focus = cx.focus_handle();
        self.history_page = Some(HistoryPage {
            model: HistoryModel::new(entries, current, self.dirty),
            path,
            name,
            markdown: format == FormatKind::Markdown && !large,
            head,
            highlight: true,
            filter_menu: None,
            menu_for: None,
            renaming: None,
            _rename_sub: None,
            notice: None,
            view,
            shown_key: None,
            shown: Shown::Loading,
            focus: focus.clone(),
            list_scroll: ScrollHandle::new(),
            source_scroll: ScrollHandle::new(),
        });
        self.history_fill();
        // Electron focuses Back; here the page itself takes the keys, so ↑
        // and ↓ step at once.
        focus.focus(window, cx);
        cx.notify();
    }

    /// Back to the document (Esc, the Back button, ⌘[).
    pub(super) fn close_history_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.history_page.take().is_none() {
            return;
        }
        if self.rich_active() {
            self.focus_rich(window, cx);
        } else if matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. })) {
            self.focus_editor(window, cx);
        } else {
            self.focus_handle.focus(window, cx);
        }
        cx.notify();
    }

    /// Read the versions the page needs now. Reading the newest can change
    /// what the current row compares with, so it goes round until settled.
    fn history_fill(&mut self) {
        let Some(page) = self.history_page.as_mut() else { return };
        for _ in 0..4 {
            let needs = page.model.needs(&now());
            if needs.is_empty() {
                break;
            }
            for stamp in needs {
                let text = self.history.read(&page.path, &stamp);
                page.model.contents.insert(stamp, text);
            }
        }
    }

    fn history_select(&mut self, id: VersionId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        page.menu_for = None;
        page.filter_menu = None;
        page.model.selected = id;
        let focus = page.focus.clone();
        self.history_commit_rename(cx);
        self.history_fill();
        focus.focus(window, cx);
        cx.notify();
    }

    /// ↓ and Older step down the list; ↑ and Newer up.
    fn history_step(&mut self, older: bool, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        if page.model.step(older, &now()) {
            page.menu_for = None;
            self.history_fill();
            cx.notify();
        }
    }

    fn history_toggle_run(&mut self, lead: String, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        page.model.toggle_expanded(&lead);
        self.history_fill();
        cx.notify();
    }

    fn history_flash(&mut self, text: &'static str, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        let seq = page.notice.as_ref().map_or(1, |(_, n)| n + 1);
        page.notice = Some((text.into(), seq));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(1800)).await;
            this.update(cx, |this, cx| {
                if let Some(page) = this.history_page.as_mut() {
                    if page.notice.as_ref().is_some_and(|(_, n)| *n == seq) {
                        page.notice = None;
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn history_copy(&mut self, id: VersionId, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        page.menu_for = None;
        if let VersionId::Stamp(s) = &id {
            if !page.model.contents.contains_key(s) {
                let text = self.history.read(&page.path, s);
                page.model.contents.insert(s.clone(), text);
            }
        }
        match page.model.content_of(&id).flatten().map(str::to_string) {
            Some(text) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                self.history_flash("Copied", cx);
            }
            None => self.history_flash("Could not copy", cx),
        }
    }

    /// Restore this version: loaded into the editor as unsaved, never written.
    fn history_restore_version(&mut self, id: VersionId, window: &mut Window, cx: &mut Context<Self>) {
        let VersionId::Stamp(stamp) = &id else { return };
        let Some(page) = self.history_page.as_mut() else { return };
        if !page.model.contents.contains_key(stamp) {
            let text = self.history.read(&page.path, stamp);
            page.model.contents.insert(stamp.clone(), text);
        }
        let Some(text) = page.model.content_of(&id).flatten().map(str::to_string) else {
            return self.history_flash("Could not read this version", cx);
        };
        self.close_history_page(window, cx);
        self.load_version_unsaved(text, cx);
    }

    /// The text of a version in the editor, as unsaved edits. Never written:
    /// reading history must not cost anyone the document (`onRestore`).
    pub(super) fn load_version_unsaved(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(OpenDoc { kind: DocKind::Text { .. }, .. }) = &self.doc else { return };
        self.pending_editor_text = Some(self.editor_text(&text, cx));
        if self.rich_active() {
            self.load_rich(&text, cx);
        }
        self.update_stats(&text, cx);
        self.dirty = true;
        self.autosave.cancel();
        self.schedule_journal(&text, cx);
        cx.notify();
    }

    fn history_start_rename(&mut self, id: VersionId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        page.menu_for = None;
        let current = match &id {
            VersionId::Current => page.model.current_entry().and_then(|e| e.meta.name.clone()),
            VersionId::Stamp(s) => page.model.entry(s).and_then(|e| e.meta.name.clone()),
        };
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("Name this version");
            state.set_value(current.unwrap_or_default(), window, cx);
            state
        });
        let sub = cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, _, cx| match ev {
            InputEvent::PressEnter { .. } | InputEvent::Blur => this.history_commit_rename(cx),
            _ => {}
        });
        let handle = input.read(cx).focus_handle(cx);
        page.renaming = Some((id, input));
        page._rename_sub = Some(sub);
        handle.focus(window, cx);
        cx.notify();
    }

    /// Save the name being typed (Enter, or leaving the field).
    fn history_commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        let Some((id, input)) = page.renaming.take() else { return };
        page._rename_sub = None;
        let draft = input.read(cx).value().to_string();
        let path = page.path.clone();
        let stamp = match &id {
            VersionId::Current => page.model.current_entry().map(|e| e.stamp.clone()),
            VersionId::Stamp(s) => Some(s.clone()),
        };
        let result = match stamp {
            Some(stamp) => self.history.set_name(&path, &stamp, &draft),
            // The current text is kept as a version first, so the name hangs
            // on something that stays.
            None if draft.trim().is_empty() => Ok(None),
            None => self.history.name_current(&path, &draft),
        };
        match result {
            Ok(_) => self.history_reload(cx),
            Err(e) => {
                if let Some(page) = self.history_page.as_mut() {
                    page.notice = Some((e.into(), u64::MAX));
                }
            }
        }
        cx.notify();
    }

    fn history_cancel_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        page.renaming = None;
        page._rename_sub = None;
        let focus = page.focus.clone();
        focus.focus(window, cx);
        cx.notify();
    }

    fn history_remove_name(&mut self, stamp: String, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        page.menu_for = None;
        let path = page.path.clone();
        if self.history.set_name(&path, &stamp, "").is_ok() {
            self.history_reload(cx);
        }
    }

    /// The list again after a name changed.
    fn history_reload(&mut self, cx: &mut Context<Self>) {
        let Some(page) = self.history_page.as_mut() else { return };
        let mut entries = self.history.list(&page.path);
        entries.reverse();
        page.model.entries = entries;
        page.shown_key = None;
        self.history_fill();
        cx.notify();
    }

    /// Escape leaves history, unless it is closing a menu or a rename first.
    fn history_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(page) = self.history_page.as_mut() else { return false };
        let m = &ev.keystroke.modifiers;
        if m.platform || m.control || m.alt {
            return false;
        }
        match ev.keystroke.key.as_str() {
            "escape" if page.menu_for.is_some() || page.filter_menu.is_some() => {
                page.menu_for = None;
                page.filter_menu = None;
                cx.notify();
            }
            "escape" if page.renaming.is_some() => self.history_cancel_rename(window, cx),
            "escape" => self.close_history_page(window, cx),
            "down" | "up" if page.focus.is_focused(window) && page.renaming.is_none() => {
                self.history_step(ev.keystroke.key == "down", cx);
            }
            _ => return false,
        }
        true
    }

    /// Build what the document area shows for the selection, when it changed.
    fn history_sync_view(&mut self, cx: &mut Context<Self>) {
        let dark = themes::palette(cx).dark;
        let (zoom, width) = (self.zoom, self.page_width);
        let style = super::rich::doc_style(cx);
        let Some(page) = self.history_page.as_mut() else { return };
        let base = page.model.selected_base(&now());
        let selected = page.model.content_of(&page.model.selected);
        let base_text = base.as_ref().map(|b| page.model.content_of(&VersionId::Stamp(b.clone())));
        let key = ShownKey {
            id: page.model.selected.clone(),
            base: base.clone(),
            highlight: page.highlight,
            dark,
            read: (selected.is_some(), base_text.as_ref().is_none_or(|t| t.is_some())),
        };
        page.view.update(cx, |r, cx| {
            if (r.zoom - zoom).abs() > f32::EPSILON || (r.page_width - width).abs() > f32::EPSILON {
                r.set_appearance(zoom, width, cx);
            }
            r.set_style(style, cx);
        });
        if page.shown_key.as_ref() == Some(&key) {
            return;
        }
        let text = match selected {
            None => {
                page.shown = Shown::Loading;
                page.shown_key = Some(key);
                return;
            }
            Some(None) => {
                page.shown = Shown::Unreadable;
                page.shown_key = Some(key);
                return;
            }
            Some(Some(text)) => text.to_string(),
        };
        let compare = if page.highlight { base_text.flatten().flatten().map(str::to_string) } else { None };
        let colors = diff_colors(dark);
        page.shown = if page.markdown {
            let (diff, skipped) = match &compare {
                Some(before) => {
                    let marked = version_diff::mark_markdown_changes(body(before), body(&text));
                    (diff_document(&marked.text, colors.del_fg), marked.skipped)
                }
                None => (DiffDocument { editor: Editor::parse(body(&text)), runs: Vec::new(), whole: Vec::new() }, false),
            };
            let tints = diff
                .runs
                .into_iter()
                .map(|(a, b, k)| (a, b, if k == SpanKind::Ins { colors.ins_bg } else { colors.del_bg }))
                .collect();
            // `.markie-vh-block.markie-vh-ins` fills at 55% of the word tint.
            let bands = diff
                .whole
                .into_iter()
                .map(|(b, k)| match k {
                    SpanKind::Del => (b, colors.del_bg, colors.del_edge),
                    _ => (b, colors.ins_bg.opacity(0.55), colors.ins_edge),
                })
                .collect();
            let editor = diff.editor;
            page.view.update(cx, |r, cx| {
                r.editor = editor;
                r.comment_marks = tints;
                r.block_tints = bands;
                r.remote_changed(cx);
            });
            Shown::Rich { skipped }
        } else {
            match &compare {
                Some(before) => {
                    let marked = version_diff::mark_source_changes(before, &text);
                    Shown::Source { spans: version_diff::marked_spans(&marked.text), skipped: marked.skipped }
                }
                None => Shown::Source { spans: vec![DiffSpan { kind: SpanKind::Same, text }], skipped: false },
            }
        };
        page.shown_key = Some(key);
    }

    // ------------------------------------------------------------ drawing

    pub(super) fn render_history_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        // Another document opened under the page: the page was for the last one.
        if self.history_page.as_ref().is_some_and(|p| self.doc.as_ref().map(|d| &d.path) != Some(&p.path)) {
            self.history_page = None;
            return div().into_any_element();
        }
        self.history_sync_view(cx);
        let p = themes::palette(cx);
        let header = self.render_history_header(&p, cx);
        let document = self.render_history_document(&p, cx);
        let panel = self.render_history_panel(&p, window, cx);
        let page = self.history_page.as_ref().expect("the page is open");
        let menus = self.render_history_menus(&p, cx);
        v_flex_full()
            .id("history-page")
            .track_focus(&page.focus)
            .key_context("HistoryPage")
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                if ev.keystroke.key == "escape" && this.history_key(ev, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                if this.history_key(ev, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .bg(p.background)
            .text_color(p.foreground)
            .child(header)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(div().flex_1().min_w_0().min_h_0().relative().bg(p.background).child(document))
                    .child(panel),
            )
            .children(menus)
            .into_any_element()
    }

    fn history_heading(&self) -> (String, bool) {
        let Some(page) = &self.history_page else { return (String::new(), false) };
        let n = now();
        match &page.model.selected {
            VersionId::Current => match page.model.current_entry().and_then(|e| e.meta.name.clone()) {
                Some(name) => (name, true),
                None if page.model.dirty => ("Current version, unsaved".into(), false),
                None => (vl::format_version_heading(self.history_current_ms(), &n), false),
            },
            VersionId::Stamp(s) => match page.model.entry(s) {
                Some(e) => match &e.meta.name {
                    Some(name) => (name.clone(), true),
                    None => (vl::format_version_heading(vl::version_ms(e), &n), false),
                },
                None => (String::new(), false),
            },
        }
    }

    /// When the text on screen was written: its stored copy's time, else
    /// the last recorded write's, else now.
    fn history_current_ms(&self) -> i64 {
        let Some(page) = &self.history_page else { return now().timestamp_millis() };
        if let Some(e) = page.model.current_entry() {
            return vl::version_ms(e);
        }
        let head_ms = (!page.model.dirty)
            .then(|| page.head.as_ref().and_then(|h| h.iso.as_deref()))
            .flatten()
            .and_then(|iso| chrono::DateTime::parse_from_rfc3339(iso).ok())
            .map(|d| d.timestamp_millis());
        head_ms.unwrap_or_else(|| now().timestamp_millis())
    }

    fn render_history_header(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let page = self.history_page.as_ref().expect("the page is open");
        let (heading, named) = self.history_heading();
        let selected = page.model.selected.clone();
        let readable = page.model.content_of(&selected).is_some_and(|c| c.is_some())
            || matches!(&selected, VersionId::Stamp(s) if !page.model.contents.contains_key(s));
        let (fg, fill) = (p.foreground, hover_fill(p));
        let back = no_drag(
            div()
                .id("vh-back")
                .group("vh-back")
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded(px(6.))
                .border_1()
                .border_color(transparent_black())
                .cursor_pointer()
                .hover(|s| s.bg(fill).border_color(p.fg(0.07)))
                .role(Role::Button)
                .aria_label("Back to the document")
                .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Back to the document (Esc)").build(window, cx))
                .child(icon("markie/arrow-left.svg", 16., p.muted).group_hover("vh-back", |s| s.text_color(fg)))
                .on_click(cx.listener(|this, _, window, cx| this.close_history_page(window, cx))),
        );
        let copy_id = selected.clone();
        let copy = no_drag(
            div()
                .id("vh-copy")
                .h(px(28.))
                .px(px(10.))
                .flex()
                .items_center()
                .rounded(px(6.))
                .border_1()
                .border_color(transparent_black())
                .text_size(px(12.))
                .text_color(p.muted)
                .role(Role::Button)
                .when_else(
                    readable,
                    |el| {
                        el.cursor_pointer()
                            .hover(|s| s.bg(fill).border_color(p.fg(0.07)).text_color(fg))
                            .on_click(cx.listener(move |this, _, _, cx| this.history_copy(copy_id.clone(), cx)))
                    },
                    |el| el.opacity(0.5),
                )
                .child("Copy text"),
        );
        let restore_id = selected.clone();
        let restore = (selected != VersionId::Current).then(|| {
            no_drag(
                div()
                    .id("vh-restore")
                    .h(px(28.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .bg(p.blue)
                    .text_color(p.background)
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .role(Role::Button)
                    .when_else(
                        readable,
                        |el| {
                            el.cursor_pointer()
                                .hover(|s| s.opacity(0.92))
                                .on_click(cx.listener(move |this, _, window, cx| this.history_restore_version(restore_id.clone(), window, cx)))
                        },
                        |el| el.opacity(0.5),
                    )
                    .child("Restore this version"),
            )
        });
        let notice = page.notice.as_ref().map(|(text, _)| div().text_size(px(12.)).text_color(p.muted).child(text.clone()));
        TitleBar::new()
            .h(px(TITLE_BAR_HEIGHT))
            .pl(px(82.))
            .pr(px(12.))
            .bg(p.surface)
            .border_color(p.border)
            .child(
                h_flex_full()
                    .gap(px(8.))
                    .child(back)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .overflow_hidden()
                            .text_size(px(13.))
                            .child(div().truncate().when(named, |el| el.font_weight(FontWeight::SEMIBOLD)).child(heading))
                            .child(div().flex_none().ml(px(8.)).text_size(px(12.)).text_color(p.muted).child(page.name.clone())),
                    )
                    .children(notice)
                    .child(h_flex().flex_none().gap(px(6.)).child(copy).children(restore)),
            )
            .into_any_element()
    }

    fn render_history_document(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let page = self.history_page.as_ref().expect("the page is open");
        let message = |text: &'static str| div().p(px(32.)).text_size(px(13.)).text_color(p.muted).child(text).into_any_element();
        let skip_note = |width: f32| {
            div()
                .w_full()
                .flex()
                .justify_center()
                .pt(px(16.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(width))
                        .px(px(40.))
                        .text_size(px(12.))
                        .text_color(p.muted)
                        .child("This document is too long to highlight changes. Showing the version as it was."),
                )
        };
        match &page.shown {
            Shown::Loading => message("Loading…"),
            Shown::Unreadable => message("This version could not be read."),
            Shown::Rich { skipped } => v_flex()
                .size_full()
                .when(*skipped && page.highlight, |el| el.child(skip_note(self.page_width)))
                .child(div().flex_1().min_h_0().child(page.view.clone()))
                .into_any_element(),
            Shown::Source { spans, skipped } => {
                let colors = diff_colors(p.dark);
                let del_fg = hex(colors.del_fg);
                let mut text = String::new();
                let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
                for s in spans {
                    let start = text.len();
                    text.push_str(&s.text);
                    match s.kind {
                        SpanKind::Same => {}
                        SpanKind::Ins => highlights.push((start..text.len(), HighlightStyle { background_color: Some(colors.ins_bg), ..Default::default() })),
                        SpanKind::Del => highlights.push((
                            start..text.len(),
                            HighlightStyle {
                                background_color: Some(colors.del_bg),
                                color: Some(del_fg),
                                strikethrough: Some(StrikethroughStyle { thickness: px(1.5), color: Some(del_fg) }),
                                ..Default::default()
                            },
                        )),
                    }
                }
                let _ = cx;
                div()
                    .id("vh-source")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&page.source_scroll)
                    .when(*skipped && page.highlight, |el| el.child(skip_note(self.page_width)))
                    .child(
                        div().w_full().flex().justify_center().child(
                            div()
                                .w_full()
                                .max_w(px(self.page_width))
                                .pt(px(40.))
                                .px(px(24.))
                                .pb(px(96.))
                                .font_family(markie_editor::MONO)
                                .text_size(px(13. * self.zoom))
                                .line_height(relative(1.6))
                                .text_color(p.foreground)
                                .child(StyledText::new(text).with_highlights(highlights)),
                        ),
                    )
                    .into_any_element()
            }
        }
    }

    fn render_history_panel(&self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let page = self.history_page.as_ref().expect("the page is open");
        let n = now();
        let model = &page.model;
        let groups = model.groups(&n);
        let (fg, fill) = (p.foreground, hover_fill(p));
        let arrow = |id: &'static str, glyph: &'static str, label: &'static str, tip: &'static str, older: bool, cx: &mut Context<Self>| {
            let enabled = model.can_step(older, &n);
            div()
                .id(id)
                .group(id)
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(24.))
                .rounded(px(6.))
                .border_1()
                .border_color(transparent_black())
                .role(Role::Button)
                .aria_label(label)
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip).build(window, cx))
                .when_else(
                    enabled,
                    |el| {
                        el.cursor_pointer()
                            .hover(|s| s.bg(fill).border_color(p.fg(0.07)))
                            .child(icon(glyph, 14., p.muted).group_hover(id, |s| s.text_color(fg)))
                            .on_click(cx.listener(move |this, _, _, cx| this.history_step(older, cx)))
                    },
                    |el| el.child(icon(glyph, 14., p.muted.opacity(0.4))),
                )
        };
        let newer = arrow("vh-newer", "markie/chevron-up.svg", "Newer version", "Newer version (↑)", false, cx);
        let older = arrow("vh-older", "markie/chevron-down.svg", "Older version", "Older version (↓)", true, cx);
        let filter_label = if model.named_only { "Named versions" } else { "All versions" };
        let filter = div()
            .id("vh-filter")
            .h(px(32.))
            .px(px(8.))
            .flex()
            .items_center()
            .justify_between()
            .rounded(px(7.))
            .border_1()
            .border_color(p.border)
            .bg(p.surface2)
            .text_size(px(12.5))
            .cursor_pointer()
            .role(Role::ComboBox)
            .aria_label("Which versions")
            .child(filter_label)
            .child(icon("markie/chevron-down-bold.svg", 10., p.muted))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, ev: &MouseDownEvent, _, cx| {
                cx.stop_propagation();
                if let Some(page) = this.history_page.as_mut() {
                    page.filter_menu = if page.filter_menu.is_some() { None } else { Some(ev.position) };
                    page.menu_for = None;
                    cx.notify();
                }
            }));

        let mut list: Vec<AnyElement> = Vec::new();
        for group in &groups {
            list.push(
                div()
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.muted)
                    .px(px(8.))
                    .pt(px(12.))
                    .pb(px(4.))
                    .child(group.label.clone())
                    .into_any_element(),
            );
            if group.key == "today" && !model.named_only {
                list.push(self.render_history_row(VersionId::Current, 0, false, false, p, window, cx));
            }
            for row in &group.rows {
                let open = model.expanded.contains(&row.lead.stamp);
                list.push(self.render_history_row(VersionId::Stamp(row.lead.stamp.clone()), row.minor.len(), open, false, p, window, cx));
                if open {
                    for m in &row.minor {
                        list.push(self.render_history_row(VersionId::Stamp(m.stamp.clone()), 0, false, true, p, window, cx));
                    }
                }
            }
        }
        let empty_note = |text: &'static str| div().px(px(16.)).py(px(12.)).text_size(px(12.)).text_color(p.muted).child(text).into_any_element();
        if model.stored().is_empty() && !model.named_only {
            list.push(empty_note("No earlier versions yet. Markie keeps one every time this document is saved."));
        }
        if model.named_only && groups.iter().all(|g| g.rows.is_empty()) {
            list.push(empty_note("No named versions. Name one from its menu to keep it."));
        }
        let highlight = page.highlight;
        let check_bg = if highlight { p.blue } else { transparent_black() };
        let toggle = div()
            .id("vh-highlight")
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(16.))
            .py(px(11.))
            .border_t_1()
            .border_color(p.border)
            .text_size(px(12.5))
            .cursor_pointer()
            .role(Role::CheckBox)
            .aria_label("Highlight changes")
            .aria_toggled(if highlight { Toggled::True } else { Toggled::False })
            .child(
                div()
                    .size(px(15.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .border_1()
                    .border_color(if highlight { p.blue } else { p.border })
                    .bg(check_bg)
                    .when(highlight, |el| el.child(icon("markie/copied.svg", 11., p.background))),
            )
            .child("Highlight changes")
            .on_click(cx.listener(|this, _, _, cx| {
                if let Some(page) = this.history_page.as_mut() {
                    page.highlight = !page.highlight;
                    cx.notify();
                }
            }));
        let bg = if p.dark {
            Background::from(linear_gradient(
                180.,
                linear_color_stop(themes::mix(p.surface2, p.surface, 0.58), 0.),
                linear_color_stop(p.surface, 0.3),
            ))
        } else {
            p.surface.into()
        };
        v_flex()
            .id("vh-panel")
            .w(px(300.))
            .flex_none()
            .h_full()
            .min_h_0()
            .bg(bg)
            .border_l_1()
            .border_color(p.border)
            .role(Role::Complementary)
            .aria_label("Version history")
            .child(
                v_flex()
                    .px(px(14.))
                    .pt(px(14.))
                    .pb(px(8.))
                    .gap(px(10.))
                    .child(
                        h_flex()
                            .gap(px(4.))
                            .child(div().flex_1().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Version history"))
                            .child(newer)
                            .child(older),
                    )
                    .child(filter),
            )
            .child(
                div()
                    .id("vh-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&page.list_scroll)
                    .role(Role::ListBox)
                    .aria_label("Versions")
                    .px(px(8.))
                    .pb(px(12.))
                    .children(list),
            )
            .child(toggle)
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_history_row(
        &self,
        id: VersionId,
        minor_count: usize,
        open: bool,
        minor: bool,
        p: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let page = self.history_page.as_ref().expect("the page is open");
        let model = &page.model;
        let n = now();
        let current = id == VersionId::Current;
        let selected = model.selected == id;
        let entry = match &id {
            VersionId::Current => model.current_entry(),
            VersionId::Stamp(s) => model.entry(s),
        };
        let name = entry.and_then(|e| e.meta.name.clone());
        let ms = if current { self.history_current_ms() } else { entry.map_or(0, vl::version_ms) };
        let who: Option<(String, Option<String>)> = if current {
            if model.dirty {
                Some(("user".into(), None))
            } else if let Some(e) = entry {
                Some((e.meta.author.clone(), e.meta.agent.clone()))
            } else {
                page.head.as_ref().map(|h| (h.author.clone(), h.agent.clone()))
            }
        } else {
            entry.map(|e| (e.meta.author.clone(), e.meta.agent.clone()))
        };
        let key = id_key(&id);
        let editing = page.renaming.as_ref().filter(|(rid, _)| *rid == id).map(|(_, input)| input.clone());
        let menu_open = page.menu_for.as_ref().is_some_and(|(mid, _)| *mid == id);
        let (fg, muted) = (p.foreground, p.muted);
        let sel_bg = p.blue.opacity(if p.dark { 0.16 } else { 0.11 });
        let sel_edge = p.blue.opacity(0.7);
        let hover_bg = p.accent.opacity(0.45);
        let lead_stamp = match &id {
            VersionId::Stamp(s) => s.clone(),
            VersionId::Current => String::new(),
        };
        let chevron = (minor_count > 0).then(|| {
            let lead = lead_stamp.clone();
            let label = if open {
                "Hide minor versions".to_string()
            } else {
                format!("Show {minor_count} more version{}", if minor_count == 1 { "" } else { "s" })
            };
            div()
                .id(SharedString::from(format!("vh-chev-{key}")))
                .size(px(18.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .cursor_pointer()
                .hover(|s| s.bg(p.accent.opacity(0.6)))
                .role(Role::Button)
                .aria_label(label)
                .aria_expanded(open)
                .child(
                    svg()
                        .path("markie/chevron-right-small.svg")
                        .size(px(10.))
                        .text_color(muted)
                        .with_transformation(Transformation::rotate(if open { percentage(0.25) } else { percentage(0.) })),
                )
                .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.history_toggle_run(lead.clone(), cx);
                }))
        });
        let time = if current && model.dirty { "Unsaved changes".to_string() } else { vl::format_version_time(ms, &n) };
        let mut body = v_flex().flex_1().min_w_0().gap(px(2.));
        if let Some(input) = editing {
            body = body.child(
                div()
                    .h(px(26.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(sel_edge)
                    .bg(p.background)
                    .px(px(4.))
                    .flex()
                    .items_center()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(Input::new(&input).appearance(false).text_size(px(12.5)).w_full()),
            );
        } else {
            if let Some(name) = &name {
                body = body.child(div().text_size(px(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(fg).truncate().child(name.clone()));
                body = body.child(div().text_size(px(11.)).text_color(muted).child(time.clone()));
            } else {
                body = body.child(div().text_size(px(12.5)).text_color(fg).child(time.clone()));
            }
        }
        if current {
            body = body.child(div().text_size(px(11.)).text_color(muted).child("Current version"));
        }
        if let Some((author, agent)) = &who {
            if author != "unknown" && !author.is_empty() {
                let dot = tone_color(vl::author_tone(author, agent.as_deref()), p);
                body = body.child(
                    h_flex()
                        .gap(px(6.))
                        .text_size(px(11.))
                        .text_color(muted)
                        .min_w_0()
                        .child(div().size(px(7.)).rounded_full().bg(dot).flex_none())
                        .child(div().truncate().child(vl::author_label(author, agent.as_deref()))),
                );
            }
        }
        let kebab_id = id.clone();
        let kebab = div()
            .id(SharedString::from(format!("vh-kebab-{key}")))
            .size(px(24.))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|s| s.bg(p.accent.opacity(0.6)))
            .role(Role::Button)
            .aria_label("Version actions")
            .aria_expanded(menu_open)
            .when(!(selected || menu_open), |el| el.opacity(0.).group_hover("vh-row", |s| s.opacity(1.)))
            .child(icon("markie/kebab.svg", 14., muted))
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                cx.stop_propagation();
                if let Some(page) = this.history_page.as_mut() {
                    let open = page.menu_for.as_ref().is_some_and(|(m, _)| *m == kebab_id);
                    page.menu_for = if open { None } else { Some((kebab_id.clone(), ev.position)) };
                    page.filter_menu = None;
                    cx.notify();
                }
            }));
        let select_id = id.clone();
        let _ = window;
        div()
            .id(SharedString::from(format!("vh-row-{key}")))
            .group("vh-row")
            .relative()
            .flex()
            .items_start()
            .gap(px(2.))
            .pt(px(7.))
            .pb(px(7.))
            .pr(px(4.))
            .pl(px(if minor { 18. } else { 2. }))
            .rounded(px(8.))
            .border_1()
            .border_color(if selected { sel_edge } else { transparent_black() })
            .when(selected, |el| el.bg(sel_bg))
            .when(!selected, |el| el.hover(move |s| s.bg(hover_bg)))
            .role(Role::ListBoxOption)
            .aria_selected(selected)
            // One press selects and shows it, as a native list does: on the
            // press, not the release, so nothing under the pointer can move
            // between the two.
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| this.history_select(select_id.clone(), window, cx)))
            .child(div().w(px(20.)).flex_none().flex().justify_center().pt(px(2.)).children(chevron))
            .child(body)
            .child(kebab)
            .into_any_element()
    }

    /// The row menu and the "Which versions" menu, over everything.
    fn render_history_menus(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let page = self.history_page.as_ref()?;
        let item = |id: SharedString, label: String, enabled: bool, run: Box<dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)>, cx: &mut Context<Self>| {
            div()
                .id(id)
                .px(px(10.))
                .py(px(6.))
                .rounded(px(6.))
                .text_size(px(12.5))
                .text_color(p.foreground)
                .role(Role::MenuItem)
                .when_else(
                    enabled,
                    |el| {
                        el.cursor_pointer()
                            .hover(|s| s.bg(hover_fill(p)))
                            .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                run(this, window, cx);
                            }))
                    },
                    |el| el.opacity(0.45),
                )
                .child(label)
        };
        if let Some(at) = page.filter_menu {
            let rows = [(false, "All versions"), (true, "Named versions")].map(|(named, label)| {
                let chosen = page.model.named_only == named;
                item(
                    SharedString::from(format!("vh-filter-{named}")),
                    format!("{}{label}", if chosen { "✓  " } else { "    " }),
                    true,
                    Box::new(move |this, _, cx| {
                        if let Some(page) = this.history_page.as_mut() {
                            page.model.named_only = named;
                            page.filter_menu = None;
                        }
                        this.history_fill();
                        cx.notify();
                    }),
                    cx,
                )
            });
            return Some(
                deferred(
                    anchored().position(at + point(px(-120.), px(14.))).snap_to_window_with_margin(px(8.)).child(
                        menu_panel(p)
                            .id("vh-filter-menu")
                            .occlude()
                            .min_w(px(190.))
                            .p(px(4.))
                            .role(Role::Menu)
                            .children(rows)
                            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                if let Some(page) = this.history_page.as_mut() {
                                    page.filter_menu = None;
                                    cx.notify();
                                }
                            })),
                    ),
                )
                .into_any_element(),
            );
        }
        let (id, at) = page.menu_for.clone()?;
        let mut rows: Vec<Stateful<Div>> = Vec::new();
        let named = match &id {
            VersionId::Current => page.model.current_entry().and_then(|e| e.meta.name.clone()),
            VersionId::Stamp(s) => page.model.entry(s).and_then(|e| e.meta.name.clone()),
        };
        let key = id_key(&id);
        let rename_id = id.clone();
        match &id {
            VersionId::Current => {
                let label = if named.is_some() { "Rename" } else { "Name current version" };
                rows.push(item(
                    SharedString::from(format!("vh-m-name-{key}")),
                    if page.model.dirty { format!("{label} (save your changes first)") } else { label.into() },
                    !page.model.dirty,
                    Box::new(move |this, window, cx| this.history_start_rename(rename_id.clone(), window, cx)),
                    cx,
                ));
            }
            VersionId::Stamp(stamp) => {
                rows.push(item(
                    SharedString::from(format!("vh-m-name-{key}")),
                    if named.is_some() { "Rename".into() } else { "Name this version".into() },
                    true,
                    Box::new(move |this, window, cx| this.history_start_rename(rename_id.clone(), window, cx)),
                    cx,
                ));
                if named.is_some() {
                    let stamp = stamp.clone();
                    rows.push(item(
                        SharedString::from(format!("vh-m-unname-{key}")),
                        "Remove name".into(),
                        true,
                        Box::new(move |this, _, cx| this.history_remove_name(stamp.clone(), cx)),
                        cx,
                    ));
                }
                let restore_id = id.clone();
                rows.push(item(
                    SharedString::from(format!("vh-m-restore-{key}")),
                    "Restore this version".into(),
                    true,
                    Box::new(move |this, window, cx| this.history_restore_version(restore_id.clone(), window, cx)),
                    cx,
                ));
            }
        }
        let copy_id = id.clone();
        rows.push(item(
            SharedString::from(format!("vh-m-copy-{key}")),
            "Copy text".into(),
            true,
            Box::new(move |this, _, cx| this.history_copy(copy_id.clone(), cx)),
            cx,
        ));
        Some(
            deferred(
                anchored().position(at + point(px(-190.), px(12.))).snap_to_window_with_margin(px(8.)).child(
                    menu_panel(p)
                        .id("vh-row-menu")
                        .occlude()
                        .min_w(px(190.))
                        .p(px(4.))
                        .role(Role::Menu)
                        .children(rows)
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            if let Some(page) = this.history_page.as_mut() {
                                page.menu_for = None;
                                cx.notify();
                            }
                        })),
                ),
            )
            .into_any_element(),
        )
    }
}

fn v_flex_full() -> Div {
    div().flex().flex_col().size_full()
}

fn h_flex_full() -> Div {
    div().flex().flex_row().items_center().size_full()
}

fn v_flex() -> Div {
    div().flex().flex_col()
}

fn h_flex() -> Div {
    div().flex().flex_row().items_center()
}

#[cfg(test)]
mod tests {
    use super::{SpanKind, diff_document};
    use markie_core::version_diff::mark_markdown_changes;
    use markie_rich::edit::Unit;

    fn leaf_text(ed: &markie_rich::editor::Editor, b: usize, l: usize) -> String {
        ed.units(b, l).iter().map(Unit::display).collect()
    }

    #[test]
    fn marks_become_tints_on_clean_text() {
        let merged = mark_markdown_changes("The cat sat on the mat.\n", "The cat slept on the warm mat.\n");
        let d = diff_document(&merged.text, "#b91c1c");
        let (ed, marks) = (d.editor, d.runs);
        // The page reads as the merged sentence, no sentinel left in it.
        assert_eq!(leaf_text(&ed, 0, 0), "The cat satslept on the warm mat.");
        let runs: Vec<(String, SpanKind)> = marks
            .iter()
            .map(|(a, b, k)| (leaf_text(&ed, a.block, a.leaf).chars().skip(a.offset).take(b.offset - a.offset).collect(), *k))
            .collect();
        assert_eq!(runs, [("sat".into(), SpanKind::Del), ("slept".into(), SpanKind::Ins), ("warm".into(), SpanKind::Ins)]);
        // Removed words are struck through in the removed colour.
        let units = ed.units(0, 0);
        let Unit::Char(_, m) = &units[8] else { panic!() };
        assert!(m.strike);
        assert_eq!(m.text_style.as_ref().and_then(|s| s.color.as_deref()), Some("#b91c1c"));
        let Unit::Char(_, m) = &units[11] else { panic!() };
        assert!(!m.strike, "inserted words keep their ink");
    }

    #[test]
    fn a_changed_list_item_stays_a_list_item_and_code_keeps_its_fence() {
        let merged = mark_markdown_changes("- eggs\n- milk\n\n```\nlet a = 1;\n```\n", "- eggs\n- oat milk\n\n```\nlet a = 2;\n```\n");
        let d = diff_document(&merged.text, "#b91c1c");
        let (ed, marks) = (d.editor, d.runs);
        assert_eq!(ed.block_count(), 2, "one list and one code block");
        assert_eq!(leaf_text(&ed, 0, 1), "oat milk");
        assert_eq!(leaf_text(&ed, 1, 0), "let a = 12;");
        let kinds: Vec<SpanKind> = marks.iter().map(|m| m.2).collect();
        assert_eq!(kinds, [SpanKind::Ins, SpanKind::Del, SpanKind::Ins]);
    }

    #[test]
    fn a_block_only_one_side_has_is_a_band_not_word_tints() {
        let merged = mark_markdown_changes("Intro.\n\nOld paragraph here.\n", "Intro.\n\n## A new section\n\nIntro.\n");
        let d = diff_document(&merged.text, "#b91c1c");
        let blocks: Vec<String> = (0..d.editor.block_count()).map(|b| leaf_text(&d.editor, b, 0)).collect();
        let banded: Vec<(&str, SpanKind)> = d.whole.iter().map(|(b, k)| (blocks[*b].as_str(), *k)).collect();
        assert!(banded.contains(&("A new section", SpanKind::Ins)), "{banded:?}");
        assert!(banded.contains(&("Old paragraph here.", SpanKind::Del)), "{banded:?}");
        assert!(d.runs.is_empty(), "no word tints inside a band: {:?}", d.runs);
        // A changed sentence is not a band.
        let merged = mark_markdown_changes("The cat sat.\n", "The cat slept.\n");
        assert!(diff_document(&merged.text, "#b91c1c").whole.is_empty());
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// The History page over made-up versions of the file on the command
    /// line. `versions` (any order) are written into the scratch history as
    /// Electron's `history.js` keeps them; then `expand` (lead rows by their
    /// index in `versions`), `named: true`, `highlight: false`, `select` (a
    /// row of the list, 0 is the current version) and `menu` (the row whose
    /// ⋯ menu opens) are applied the way their controls apply them.
    pub(super) fn scene_history(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use serde_json::Value;
        let Some(path) = self.doc.as_ref().filter(|d| !d.untitled).map(|d| d.path.clone()) else { return false };
        let versions = args.get("versions").and_then(Value::as_array).cloned().unwrap_or_default();
        let stamp_of = |v: &Value| markie_core::clock::parse_iso(v.get("iso").and_then(Value::as_str).unwrap_or_default()).map(markie_core::clock::stamp);
        if *step == 0 {
            let dir = self.history.dir_for(&path);
            let _ = std::fs::create_dir_all(&dir);
            let mut meta = serde_json::Map::new();
            for v in &versions {
                let Some(stamp) = stamp_of(v) else { continue };
                let _ = std::fs::write(dir.join(format!("{stamp}.md")), v.get("text").and_then(Value::as_str).unwrap_or_default());
                let mut m = serde_json::Map::new();
                for key in ["author", "iso", "agent", "name"] {
                    if let Some(x) = v.get(key).filter(|x| !x.is_null()) {
                        m.insert(key.into(), x.clone());
                    }
                }
                m.entry("author").or_insert_with(|| Value::from("user"));
                meta.insert(stamp, Value::Object(m));
            }
            let _ = std::fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap_or_default());
            self.open_history_page(window, cx);
            *step = 1;
            return false;
        }
        if *step == 1 {
            let leads: Vec<String> = args
                .get("expand")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|i| versions.get(i.as_u64()? as usize)).filter_map(stamp_of).collect())
                .unwrap_or_default();
            let Some(page) = self.history_page.as_mut() else { return false };
            page.model.expanded.extend(leads);
            page.model.named_only = args.get("named").and_then(Value::as_bool).unwrap_or(false);
            page.highlight = args.get("highlight").and_then(Value::as_bool).unwrap_or(true);
            let rows = page.model.visible(&now());
            if let Some(row) = args.get("select").and_then(Value::as_u64).and_then(|n| rows.get(n as usize)) {
                page.model.selected = row.0.clone();
            }
            if let Some(row) = args.get("menu").and_then(Value::as_u64).and_then(|n| rows.get(n as usize)) {
                let y = args.get("menu_y").and_then(Value::as_f64).unwrap_or(160.) as f32;
                page.menu_for = Some((row.0.clone(), point(px(1256.), px(y))));
            }
            self.history_fill();
            cx.notify();
            *step = 2;
            return false;
        }
        *step += 1;
        *step > 6
    }
}
