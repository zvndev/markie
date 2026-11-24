//! The table a CSV or TSV file opens in. A port of Electron's
//! `src/components/csv-table/csv-table.tsx` and its stylesheet.
//!
//! The file stays the file. Every edit goes through the lossless model in
//! `markie_core::csv_table`, which rewrites only the cells that changed;
//! sorting and filtering reorder what is shown and never touch the text.
//!
//! The toolbar, the header row and the status line are ordinary elements.
//! The rows are painted directly: only the rows and columns on screen are
//! read, shaped and drawn, so a file of any length costs the same per frame.

use std::cell::Cell as StdCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::input::{self as kit, Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::Sizable as _;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::csv_table::{CsvDocument, CsvSort, SortDirection, clipboard_to_cells, column_letter, format_sum, grouped};

use super::dialog_chrome::{PATH_CHECK, Tokens, black, fade, mix, ring, shadow, stroke_icon, svg_image};
use super::source::{EditCopy, EditCut, EditFind, EditPaste, EditRedo, EditSelectAll, EditUndo};

const KEY_CONTEXT: &str = "CsvGrid";

actions!(markie_csv, [NextCell, PreviousCell]);

/// Tab in the grid walks its cells. GPUI Kit binds Tab to "next control" for
/// the whole window; a binding in the grid's own context is asked first, and
/// hands the key on when the walk reaches either end of the table.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("tab", NextCell, Some(KEY_CONTEXT)), KeyBinding::new("shift-tab", PreviousCell, Some(KEY_CONTEXT))]);
}

/// The header row as a place the cursor can be.
const HEADER: i64 = -1;
const HISTORY: usize = 100;
/// Electron's limit on rows shown (one element can only be so tall there).
const MAX_SHOWN_ROWS: usize = 500_000;
/// Rows drawn above and below the ones on screen.
const OVERSCAN: usize = 2;
/// The longest text shaped for one cell; the rest cannot show in any column.
const MAX_DRAWN_CHARS: usize = 600;

/// The scrollbar thumbs, vertical then horizontal: (start, length) along the track.
type Thumbs = (Option<(f32, f32)>, Option<(f32, f32)>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Cell {
    /// A row on screen (an index into the shown order), or [`HEADER`].
    pub row: i64,
    pub col: usize,
}

pub(super) enum CsvEvent {
    /// The file's text changed.
    Edited,
    /// The Table / Text switch.
    ShowTable,
    ShowText,
    /// Find works on text: the host brings the text forward.
    Find,
}

enum Step {
    Cells(markie_core::csv_table::CellUndo),
    Whole(Box<CsvDocument>),
}

struct Editing {
    cell: Cell,
    input: Entity<TextareaState>,
    lines: usize,
    _subscription: Subscription,
}

#[derive(Clone, Copy)]
enum Drag {
    Select,
    Resize { column: usize, start_x: f32, start_width: f32 },
    ScrollY { grab: f32 },
    ScrollX { grab: f32 },
}

enum Direction {
    Down,
    Right,
    Left,
}

/// `csv-table.css`'s custom properties, from the active theme's tokens.
#[derive(Clone, Copy)]
struct Palette {
    bg: Hsla,
    fg: Hsla,
    muted: Hsla,
    line: Hsla,
    head: Hsla,
    bar: Hsla,
    accent: Hsla,
    stripe: Hsla,
    hover: Hsla,
    select: Hsla,
    head_select: Hsla,
}

impl Palette {
    fn current(cx: &App) -> Self {
        let t = Tokens::current("markie", cx);
        // color-mix(in srgb, surface 92%, foreground 3%): the two do not add
        // up to 100%, so the result is 95% opaque over the table's background.
        let head = mix(mix(t.surface, 92. / 95., t.foreground), 0.95, t.background);
        Self {
            bg: t.background,
            fg: t.foreground,
            muted: t.muted,
            line: fade(t.border, 0.78),
            head,
            bar: t.surface,
            accent: t.blue,
            stripe: mix(t.foreground, 0.026, t.background),
            hover: mix(t.foreground, 0.05, t.background),
            select: mix(t.blue, 0.15, t.background),
            head_select: mix(t.blue, 0.18, head),
        }
    }
}

pub(super) struct CsvTable {
    focus: FocusHandle,
    doc: CsvDocument,
    /// The text `doc` serializes to, kept until the next edit.
    text: std::cell::RefCell<Option<Rc<str>>>,
    read_only: bool,
    /// The host is showing the file's text under the bar.
    text_view: bool,
    zoom: f32,

    header_choice: Option<bool>,
    header_guess: bool,
    filter_input: Entity<InputState>,
    filter: String,
    reset_filter_input: bool,
    sort: Option<CsvSort>,
    /// A double click renames a header; its first click must not also leave a sort behind.
    sort_before_click: Option<CsvSort>,
    numeric: Vec<bool>,
    /// The rows shown, as indices into the file's rows.
    order: Vec<u32>,
    /// How many rows matched before [`MAX_SHOWN_ROWS`] cut them.
    matched: usize,

    widths_stale: bool,
    auto_widths: Vec<f32>,
    resized: HashMap<usize, f32>,
    widths: Vec<f32>,
    /// Where each column starts, and one more entry for the end of the last.
    offsets: Vec<f32>,

    scroll: Point<f32>,
    /// The grid's bounds as last painted.
    viewport: Rc<StdCell<Bounds<Pixels>>>,
    scrolled_at: Option<Instant>,
    _scrollbar_fade: Task<()>,

    cursor: Option<Cell>,
    anchor: Option<Cell>,
    editing: Option<Editing>,
    past: Vec<Step>,
    future: Vec<Step>,
    drag: Option<Drag>,
    hover: Option<Cell>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<CsvEvent> for CsvTable {}

fn count(n: usize, one: &str) -> String {
    format!("{} {one}{}", grouped(n), if n == 1 { "" } else { "s" })
}

fn delimiter_name(delimiter: char) -> &'static str {
    match delimiter {
        ';' => "Semicolon",
        '\t' => "Tab",
        '|' => "Pipe",
        _ => "Comma",
    }
}

/// A cell's value on one line, as `white-space: nowrap` shows it.
fn one_line(value: &str) -> SharedString {
    let cut = value.char_indices().nth(MAX_DRAWN_CHARS).map_or(value.len(), |(i, _)| i);
    let value = &value[..cut];
    if value.contains(['\n', '\r', '\t']) { value.replace(['\n', '\r', '\t'], " ").into() } else { SharedString::from(value.to_string()) }
}

impl CsvTable {
    pub(super) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let filter_input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter rows"));
        let subscriptions = vec![cx.subscribe(&filter_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let value = input.read(cx).value().to_string();
                this.set_filter(value, cx);
            }
        })];
        Self {
            focus: cx.focus_handle(),
            doc: CsvDocument::parse("", None),
            text: Default::default(),
            read_only: false,
            text_view: false,
            zoom: 1.,
            header_choice: None,
            header_guess: false,
            filter_input,
            filter: String::new(),
            reset_filter_input: false,
            sort: None,
            sort_before_click: None,
            numeric: Vec::new(),
            order: Vec::new(),
            matched: 0,
            widths_stale: true,
            auto_widths: Vec::new(),
            resized: HashMap::new(),
            widths: Vec::new(),
            offsets: vec![0.],
            scroll: point(0., 0.),
            viewport: Rc::new(StdCell::new(Bounds::default())),
            scrolled_at: None,
            _scrollbar_fade: Task::ready(()),
            cursor: None,
            anchor: None,
            editing: None,
            past: Vec::new(),
            future: Vec::new(),
            drag: None,
            hover: None,
            _subscriptions: subscriptions,
        }
    }

    // ---- the document

    /// A newly opened file: the table starts over.
    pub(super) fn open(&mut self, text: &str, name: Option<&str>, cx: &mut Context<Self>) {
        self.doc = CsvDocument::parse(text, name);
        self.header_guess = self.doc.first_row_is_header();
        self.header_choice = None;
        self.sort = None;
        self.sort_before_click = None;
        self.filter.clear();
        self.reset_filter_input = true;
        self.resized.clear();
        self.scroll = point(0., 0.);
        self.reset_after_outside_change(cx);
    }

    /// Someone else changed the text: the Text view, a reload from disk, a
    /// restored version. The view keeps its filter, sort and widths.
    pub(super) fn replace_text(&mut self, text: &str, cx: &mut Context<Self>) {
        let delimiter = self.doc.delimiter;
        let name = if delimiter == '\t' { Some("x.tsv") } else { None };
        self.doc = CsvDocument::parse(text, name);
        self.reset_after_outside_change(cx);
    }

    fn reset_after_outside_change(&mut self, cx: &mut Context<Self>) {
        *self.text.borrow_mut() = None;
        self.past.clear();
        self.future.clear();
        self.editing = None;
        self.cursor = None;
        self.anchor = None;
        self.hover = None;
        self.drag = None;
        self.widths_stale = true;
        self.recompute_view();
        cx.notify();
    }

    /// The whole file, byte for byte the opened one outside the cells that changed.
    pub(super) fn text(&self) -> Rc<str> {
        self.text.borrow_mut().get_or_insert_with(|| Rc::from(self.doc.serialize())).clone()
    }

    pub(super) fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    pub(super) fn set_text_view(&mut self, text_view: bool) {
        self.text_view = text_view;
    }

    pub(super) fn set_zoom(&mut self, zoom: f32) {
        if (self.zoom - zoom).abs() > f32::EPSILON {
            self.zoom = zoom;
            self.widths_stale = true;
        }
    }

    pub(super) fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }

    fn editable(&self) -> bool {
        !self.read_only
    }

    fn header_on(&self) -> bool {
        self.header_choice.unwrap_or(self.header_guess) && self.doc.row_count() > 0
    }

    fn first_row(&self) -> usize {
        usize::from(self.header_on())
    }

    fn columns(&self) -> usize {
        self.doc.column_count.max(1)
    }

    /// The rows shown and which columns are numbers, worked out again. Not
    /// called for a cell edit: the rows keep the order they were typed in.
    fn recompute_view(&mut self) {
        let first = self.first_row();
        self.numeric = self.doc.numeric_columns(first);
        let mut order = self.doc.view_rows(first, &self.filter, self.sort, &self.numeric);
        self.matched = order.len();
        order.truncate(MAX_SHOWN_ROWS);
        self.order = order;
        self.clamp_cursor();
        self.clamp_scroll();
    }

    fn set_filter(&mut self, value: String, cx: &mut Context<Self>) {
        if self.filter == value {
            return;
        }
        self.filter = value;
        self.scroll.y = 0.;
        self.recompute_view();
        cx.notify();
    }

    fn min_row(&self) -> i64 {
        if self.header_on() { HEADER } else { 0 }
    }

    fn max_row(&self) -> i64 {
        self.order.len() as i64 - 1
    }

    fn clamp_cursor(&mut self) {
        let (min, max, columns) = (self.min_row(), self.max_row(), self.columns());
        let clamp = |cell: Cell| Cell { row: cell.row.clamp(min, max.max(min)), col: cell.col.min(columns - 1) };
        if max < min {
            self.cursor = None;
            self.anchor = None;
            return;
        }
        self.cursor = self.cursor.map(clamp);
        self.anchor = self.anchor.map(clamp);
    }

    /// The row in the file behind a row on screen.
    fn file_row(&self, row: i64) -> usize {
        if row == HEADER { 0 } else { self.order.get(row as usize).map_or(0, |r| *r as usize) }
    }

    /// (top, bottom, left, right) of the selected block.
    fn selection(&self) -> Option<(i64, i64, usize, usize)> {
        let cursor = self.cursor?;
        let other = self.anchor.unwrap_or(cursor);
        Some((cursor.row.min(other.row), cursor.row.max(other.row), cursor.col.min(other.col), cursor.col.max(other.col)))
    }

    fn selected_file_rows(&self) -> Vec<usize> {
        self.selection().map_or_else(Vec::new, |(top, bottom, ..)| (top..=bottom).map(|row| self.file_row(row)).collect())
    }

    fn selected_columns(&self) -> Vec<usize> {
        self.selection().map_or_else(Vec::new, |(_, _, left, right)| (left..=right).collect())
    }

    // ---- sizes

    fn row_height(&self) -> f32 {
        (30. * self.zoom).round()
    }

    fn font_size(&self) -> f32 {
        (13. * self.zoom * 10.).round() / 10.
    }

    /// The header row: a row and its bottom line.
    fn head_height(&self) -> f32 {
        self.row_height() + 1.
    }

    fn gutter(&self) -> f32 {
        (20 + self.doc.row_count().to_string().len() * 8).max(44) as f32
    }

    fn total_width(&self) -> f32 {
        self.gutter() + self.offsets.last().copied().unwrap_or(0.)
    }

    fn view_size(&self) -> Size<f32> {
        let b = self.viewport.get();
        size(f32::from(b.size.width), f32::from(b.size.height))
    }

    fn max_scroll(&self) -> Point<f32> {
        let view = self.view_size();
        let content_height = self.head_height() + self.order.len() as f32 * self.row_height();
        point((self.total_width() - view.width).max(0.), (content_height - view.height).max(0.))
    }

    fn clamp_scroll(&mut self) {
        let max = self.max_scroll();
        self.scroll = point(self.scroll.x.clamp(0., max.x), self.scroll.y.clamp(0., max.y));
    }

    /// Each column as wide as its content, within reason, from the header
    /// and the first rows.
    fn content_widths(&self, font: &Font, window: &Window) -> Vec<f32> {
        let (min, max) = (64. * self.zoom, 340. * self.zoom);
        let size = px(self.font_size());
        let mut widths = vec![min; self.doc.column_count];
        for r in 0..self.doc.row_count().min(200) {
            for (c, width) in widths.iter_mut().enumerate().take(self.doc.row_len(r)) {
                if *width >= max {
                    continue;
                }
                let value = self.doc.cell_value(r, c);
                let cut = value.char_indices().nth(80).map_or(value.len(), |(i, _)| i);
                let text = one_line(&value[..cut]);
                let run = TextRun { len: text.len(), font: font.clone(), color: black(), background_color: None, underline: None, strikethrough: None };
                let measured = f32::from(window.text_system().shape_line(text, size, &[run], None).width).ceil() + if r == 0 { 46. } else { 26. };
                if measured > *width {
                    *width = measured.min(max);
                }
            }
        }
        widths
    }

    fn layout_columns(&mut self, font: &Font, window: &Window) {
        if self.widths_stale {
            self.auto_widths = self.content_widths(font, window);
            self.widths_stale = false;
        }
        let columns = self.columns();
        self.widths = (0..columns).map(|c| self.resized.get(&c).copied().unwrap_or_else(|| self.auto_widths.get(c).copied().unwrap_or(96.))).collect();
        self.offsets = Vec::with_capacity(columns + 1);
        let mut x = 0.;
        self.offsets.push(0.);
        for width in &self.widths {
            x += width;
            self.offsets.push(x);
        }
        self.clamp_scroll();
    }

    /// The columns that reach into the grid's width.
    fn visible_columns(&self) -> std::ops::Range<usize> {
        let width = (self.view_size().width - self.gutter()).max(0.);
        let first = self.offsets.partition_point(|x| *x <= self.scroll.x).saturating_sub(1);
        let last = self.offsets.partition_point(|x| *x < self.scroll.x + width).min(self.widths.len());
        first.min(self.widths.len())..last.max(first).min(self.widths.len())
    }

    fn visible_rows(&self) -> std::ops::Range<usize> {
        let (row, view) = (self.row_height(), self.view_size());
        let first = (self.scroll.y / row).floor() as usize;
        let shown = ((view.height - self.head_height()).max(0.) / row).ceil() as usize + 1;
        first.saturating_sub(OVERSCAN).min(self.order.len())..(first + shown + OVERSCAN).min(self.order.len())
    }

    fn page_rows(&self) -> i64 {
        let shown = (self.view_size().height / self.row_height()).ceil() as i64 + 1;
        (shown - 3).max(1)
    }

    // ---- cursor

    fn reveal(&mut self, cell: Cell) {
        let (row, view, gutter, head) = (self.row_height(), self.view_size(), self.gutter(), self.head_height());
        if view.height <= 0. {
            return;
        }
        if cell.row != HEADER {
            let top = cell.row as f32 * row;
            if top < self.scroll.y {
                self.scroll.y = top;
            } else if top + row > self.scroll.y + view.height - head {
                self.scroll.y = top + row - view.height + head;
            }
        }
        let left = self.offsets.get(cell.col).copied().unwrap_or(0.);
        let width = self.widths.get(cell.col).copied().unwrap_or(0.);
        if left < self.scroll.x {
            self.scroll.x = left;
        } else if gutter + left + width > self.scroll.x + view.width {
            self.scroll.x = gutter + left + width - view.width;
        }
        self.clamp_scroll();
    }

    fn move_to(&mut self, row: i64, col: i64, extend: bool, cx: &mut Context<Self>) {
        let (min, max) = (self.min_row(), self.max_row());
        if max < min {
            return;
        }
        let next = Cell { row: row.clamp(min, max), col: col.clamp(0, self.columns() as i64 - 1) as usize };
        self.anchor = Some(if extend { self.anchor.or(self.cursor).unwrap_or(next) } else { next });
        self.cursor = Some(next);
        self.reveal(next);
        cx.notify();
    }

    // ---- edits

    fn push_step(&mut self, step: Step) {
        self.past.push(step);
        if self.past.len() > HISTORY {
            self.past.remove(0);
        }
        self.future.clear();
    }

    fn after_edit(&mut self, rows_changed: bool, cx: &mut Context<Self>) {
        *self.text.borrow_mut() = None;
        if rows_changed {
            self.widths_stale = true;
            self.recompute_view();
        } else {
            self.numeric = self.doc.numeric_columns(self.first_row());
            if self.auto_widths.len() != self.doc.column_count {
                self.widths_stale = true;
            }
        }
        cx.emit(CsvEvent::Edited);
        cx.notify();
    }

    fn commit_cells(&mut self, edits: &[(usize, usize, &str)], cx: &mut Context<Self>) {
        if !self.editable() {
            return;
        }
        if let Some(undo) = self.doc.set_cells(edits) {
            self.push_step(Step::Cells(undo));
            self.after_edit(false, cx);
        }
    }

    /// A change to the rows or columns themselves: `change` returns false
    /// when it did nothing.
    fn commit_structure(&mut self, rows_changed: bool, change: impl FnOnce(&mut CsvDocument) -> bool, cx: &mut Context<Self>) -> bool {
        if !self.editable() {
            return false;
        }
        let before = self.doc.clone();
        if !change(&mut self.doc) {
            return false;
        }
        self.push_step(Step::Whole(Box::new(before)));
        self.after_edit(rows_changed, cx);
        true
    }

    fn travel(&mut self, back: bool, cx: &mut Context<Self>) {
        if !self.editable() {
            return;
        }
        let Some(mut step) = (if back { self.past.pop() } else { self.future.pop() }) else { return };
        match &mut step {
            Step::Cells(undo) => self.doc.swap_cells(undo),
            Step::Whole(other) => std::mem::swap(&mut self.doc, other),
        }
        if back { self.future.push(step) } else { self.past.push(step) }
        self.after_edit(true, cx);
    }

    fn start_editing(&mut self, cell: Cell, typed: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.editable() {
            return;
        }
        let select_all = typed.is_none();
        let value = typed.unwrap_or_else(|| self.doc.cell_value(self.file_row(cell.row), cell.col).into_owned());
        let lines = value.split('\n').count().min(8);
        let input = cx.new(|cx| TextareaState::new(window, cx).rows(lines).submit_on_enter(true));
        input.update(cx, |state, cx| {
            state.set_value(value.clone(), window, cx);
            if select_all {
                state.select_all(window, cx);
            } else {
                state.set_selected_range(value.len()..value.len(), cx);
            }
            state.focus(window, cx);
        });
        let subscription = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { shift: false, .. } => this.finish_editing(true, Some(Direction::Down), true, window, cx),
            // A click somewhere else already took the focus where it was going.
            InputEvent::Blur => this.finish_editing(true, None, false, window, cx),
            InputEvent::Change => {
                let lines = input.read(cx).value().split('\n').count().min(8);
                if let Some(editing) = this.editing.as_mut().filter(|e| e.lines != lines) {
                    editing.lines = lines;
                    input.update(cx, |state, cx| state.set_rows(lines, cx));
                    cx.notify();
                }
            }
            _ => {}
        });
        self.editing = Some(Editing { cell, input, lines, _subscription: subscription });
        self.reveal(cell);
        cx.notify();
    }

    fn finish_editing(&mut self, save: bool, then: Option<Direction>, refocus: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editing) = self.editing.take() else { return };
        let cell = editing.cell;
        if save {
            let value = editing.input.read(cx).value().to_string();
            let row = self.file_row(cell.row);
            self.commit_cells(&[(row, cell.col, value.as_str())], cx);
        }
        let (max_row, columns) = (self.max_row(), self.columns() as i64);
        match then {
            Some(Direction::Down) => self.move_to((cell.row + 1).min(max_row), cell.col as i64, false, cx),
            Some(Direction::Right) => self.move_to(cell.row, (cell.col as i64 + 1).min(columns - 1), false, cx),
            Some(Direction::Left) => self.move_to(cell.row, (cell.col as i64 - 1).max(0), false, cx),
            None => {}
        }
        if refocus {
            self.focus.focus(window, cx);
        }
        cx.notify();
    }

    fn copy_as(&self, delimiter: char) -> String {
        self.doc.cells_to_text(&self.selected_file_rows(), &self.selected_columns(), delimiter)
    }

    /// What ⌘C puts on the clipboard: one cell as its own text, a block as tab-separated rows.
    fn copy_text(&self) -> Option<String> {
        let ((top, bottom, left, right), cursor) = (self.selection()?, self.cursor?);
        if top == bottom && left == right {
            return Some(self.doc.cell_value(self.file_row(cursor.row), cursor.col).into_owned());
        }
        Some(self.copy_as('\t'))
    }

    fn clear_selection(&mut self, cx: &mut Context<Self>) {
        let (rows, columns) = (self.selected_file_rows(), self.selected_columns());
        let edits: Vec<(usize, usize, &str)> =
            rows.iter().flat_map(|row| columns.iter().map(move |column| (*row, *column, ""))).filter(|(row, column, _)| self.doc.raw(*row, *column).is_some()).collect();
        self.commit_cells(&edits, cx);
    }

    fn paste(&mut self, pasted: &str, cx: &mut Context<Self>) {
        let Some((top, _, left, _)) = self.selection() else { return };
        let block = clipboard_to_cells(pasted);
        let (max_row, columns) = (self.max_row(), self.columns());
        let mut edits: Vec<(usize, usize, &str)> = Vec::new();
        for (r, cells) in block.iter().enumerate() {
            let row = top + r as i64;
            if row > max_row {
                break;
            }
            for (c, value) in cells.iter().enumerate() {
                if left + c < columns {
                    edits.push((self.file_row(row), left + c, value.as_str()));
                }
            }
        }
        self.commit_cells(&edits, cx);
    }

    fn add_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let at = match self.selection() {
            Some((_, bottom, ..)) if !self.order.is_empty() => {
                if bottom == HEADER { 1 } else { self.file_row(bottom) + 1 }
            }
            _ => self.doc.row_count(),
        };
        let first_row = self.first_row();
        // The new row is empty, so a filter would hide it and a sort would move it.
        self.filter.clear();
        self.filter_input.update(cx, |state, cx| state.set_value("", window, cx));
        self.sort = None;
        if !self.commit_structure(true, |doc| { doc.insert_row(at, &[]); true }, cx) {
            return;
        }
        let next = Cell { row: (at as i64 - first_row as i64).max(0), col: self.cursor.map_or(0, |c| c.col) };
        self.cursor = Some(next);
        self.anchor = Some(next);
        self.clamp_cursor();
        self.reveal(self.cursor.unwrap_or(next));
    }

    fn add_column(&mut self, cx: &mut Context<Self>) {
        let at = self.selection().map_or(self.doc.column_count, |(_, _, _, right)| right + 1);
        self.resized.clear();
        let empty = self.doc.row_count() == 0;
        self.commit_structure(empty, |doc| {
            if empty { doc.insert_row(0, &[""]) } else { doc.insert_column(at) }
            true
        }, cx);
        self.widths_stale = true;
    }

    fn remove_rows(&mut self, cx: &mut Context<Self>) {
        let Some((top, ..)) = self.selection() else { return };
        let rows = self.selected_file_rows();
        let (min_row, max_row) = (self.min_row(), self.max_row());
        if !self.commit_structure(true, |doc| doc.delete_rows(&rows), cx) {
            return;
        }
        self.anchor = None;
        if let Some(cursor) = self.cursor.as_mut() {
            cursor.row = top.min(max_row - rows.len() as i64).max(min_row);
        }
        self.clamp_cursor();
    }

    fn remove_columns(&mut self, cx: &mut Context<Self>) {
        let Some((_, _, left, _)) = self.selection() else { return };
        let dropped = self.selected_columns();
        let columns = self.columns();
        self.resized.clear();
        self.sort = None;
        if !self.commit_structure(true, |doc| doc.delete_columns(&dropped), cx) {
            return;
        }
        self.anchor = None;
        if let Some(cursor) = self.cursor.as_mut() {
            cursor.col = left.min(columns.saturating_sub(dropped.len() + 1));
        }
        self.clamp_cursor();
    }

    fn toggle_sort(&mut self, column: usize, cx: &mut Context<Self>) {
        self.sort_before_click = self.sort;
        self.sort = match self.sort {
            Some(CsvSort { column: c, direction: SortDirection::Asc }) if c == column => Some(CsvSort { column, direction: SortDirection::Desc }),
            Some(CsvSort { column: c, .. }) if c == column => None,
            _ => Some(CsvSort { column, direction: SortDirection::Asc }),
        };
        self.recompute_view();
        cx.notify();
    }

    fn set_header(&mut self, on: bool, cx: &mut Context<Self>) {
        self.header_choice = Some(on);
        self.cursor = None;
        self.anchor = None;
        self.recompute_view();
        cx.notify();
    }

    // ---- keys

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing.is_some() {
            return;
        }
        let key = &event.keystroke;
        let (cmd, shift) = (key.modifiers.platform || key.modifiers.control, key.modifiers.shift);
        let (min_row, max_row, columns) = (self.min_row(), self.max_row(), self.columns() as i64);
        let at = self.cursor.unwrap_or(Cell { row: min_row, col: 0 });
        let (row, col) = (at.row, at.col as i64);
        let page = self.page_rows();
        let target = match key.key.as_str() {
            "down" => Some((if cmd { max_row } else { row + 1 }, col)),
            "up" => Some((if cmd { min_row } else { row - 1 }, col)),
            "right" => Some((row, if cmd { columns - 1 } else { col + 1 })),
            "left" => Some((row, if cmd { 0 } else { col - 1 })),
            "pagedown" => Some((row + page, col)),
            "pageup" => Some(((row - page).max(0), col)),
            "home" => Some((if cmd { min_row } else { row }, 0)),
            "end" => Some((if cmd { max_row } else { row }, columns - 1)),
            _ => None,
        };
        if let Some((row, col)) = target {
            self.move_to(row, col, shift, cx);
            return cx.stop_propagation();
        }
        match key.key.as_str() {
            "enter" | "f2" => {
                if let Some(cursor) = self.cursor.filter(|_| self.editable()) {
                    self.start_editing(cursor, None, window, cx);
                    cx.stop_propagation();
                }
            }
            "escape" => {
                if let (Some(anchor), Some(cursor)) = (self.anchor, self.cursor)
                    && anchor != cursor
                {
                    self.anchor = Some(cursor);
                    cx.notify();
                    cx.stop_propagation();
                }
            }
            "delete" | "backspace" => {
                if self.editable() && self.cursor.is_some() {
                    self.clear_selection(cx);
                    cx.stop_propagation();
                }
            }
            "y" if cmd && self.editable() => {
                self.travel(false, cx);
                cx.stop_propagation();
            }
            _ => {
                let typed = key.key_char.as_ref().filter(|c| c.chars().count() == 1 && !c.chars().any(char::is_control));
                if let (Some(typed), Some(cursor), false, false) = (typed, self.cursor, cmd, key.modifiers.alt)
                    && self.editable()
                {
                    self.start_editing(cursor, Some(typed.clone()), window, cx);
                    cx.stop_propagation();
                }
            }
        }
    }

    /// Tab walks the row, then the next one; at either end it leaves the table.
    fn tab(&mut self, back: bool, cx: &mut Context<Self>) -> bool {
        let (min_row, max_row, columns) = (self.min_row(), self.max_row(), self.columns() as i64);
        let at = self.cursor.unwrap_or(Cell { row: min_row, col: 0 });
        let col = at.col as i64 + if back { -1 } else { 1 };
        if (0..columns).contains(&col) {
            self.move_to(at.row, col, false, cx);
        } else if !back && at.row < max_row {
            self.move_to(at.row + 1, 0, false, cx);
        } else if back && at.row > min_row {
            self.move_to(at.row - 1, columns - 1, false, cx);
        } else {
            return false;
        }
        true
    }

    fn select_all(&mut self, cx: &mut Context<Self>) {
        let (min_row, max_row) = (self.min_row(), self.max_row());
        if max_row >= min_row {
            self.anchor = Some(Cell { row: min_row, col: 0 });
            self.cursor = Some(Cell { row: max_row, col: self.columns() - 1 });
            cx.notify();
        }
    }

    fn copy(&mut self, cut: bool, cx: &mut Context<Self>) {
        let Some(text) = self.copy_text() else { return };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        if cut && self.editable() {
            self.clear_selection(cx);
        }
    }

    // ---- pointer

    /// The cell under a point in the grid, clamped to the rows and columns there are.
    fn cell_at(&self, local: Point<f32>) -> Option<Cell> {
        if self.order.is_empty() {
            return None;
        }
        let row = ((local.y - self.head_height() + self.scroll.y) / self.row_height()).floor() as i64;
        let x = local.x - self.gutter() + self.scroll.x;
        let col = self.offsets.partition_point(|start| *start <= x).saturating_sub(1).min(self.columns() - 1);
        Some(Cell { row: row.clamp(0, self.max_row()), col })
    }

    fn local(&self, position: Point<Pixels>) -> Point<f32> {
        let origin = self.viewport.get().origin;
        point(f32::from(position.x - origin.x), f32::from(position.y - origin.y))
    }

    /// The scrollbar thumbs: (vertical, horizontal) as (start, length) along their tracks.
    fn thumbs(&self) -> Thumbs {
        let (view, max) = (self.view_size(), self.max_scroll());
        let head = self.head_height();
        let vertical = (max.y > 0.).then(|| {
            let track = view.height - head;
            let length = (track * track / (track + max.y)).max(24.);
            (head + (track - length) * self.scroll.y / max.y, length)
        });
        let horizontal = (max.x > 0.).then(|| {
            let track = view.width - self.gutter();
            let length = (track * track / (track + max.x)).max(24.);
            (self.gutter() + (track - length) * self.scroll.x / max.x, length)
        });
        (vertical, horizontal)
    }

    fn scrollbars_shown(&self) -> bool {
        matches!(self.drag, Some(Drag::ScrollX { .. } | Drag::ScrollY { .. })) || self.scrolled_at.is_some_and(|at| at.elapsed() < Duration::from_millis(1200))
    }

    fn note_scrolled(&mut self, cx: &mut Context<Self>) {
        self.scrolled_at = Some(Instant::now());
        self._scrollbar_fade = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(1250)).await;
            this.update(cx, |_, cx| cx.notify()).ok();
        });
    }

    fn on_scroll(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(px(self.row_height()));
        let (mut dx, mut dy) = (f32::from(delta.x), f32::from(delta.y));
        if event.modifiers.shift && dx == 0. {
            (dx, dy) = (dy, 0.);
        }
        let before = self.scroll;
        self.scroll = point(self.scroll.x - dx, self.scroll.y - dy);
        self.clamp_scroll();
        if self.scroll != before {
            self.note_scrolled(cx);
            cx.notify();
            cx.stop_propagation();
        }
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let local = self.local(event.position);
        let view = self.view_size();
        if self.scrollbars_shown() {
            let (vertical, horizontal) = self.thumbs();
            if let Some((start, length)) = vertical.filter(|_| local.x >= view.width - 12.)
                && (start..start + length).contains(&local.y)
            {
                self.drag = Some(Drag::ScrollY { grab: local.y - start });
                return cx.stop_propagation();
            }
            if let Some((start, length)) = horizontal.filter(|_| local.y >= view.height - 12.)
                && (start..start + length).contains(&local.x)
            {
                self.drag = Some(Drag::ScrollX { grab: local.x - start });
                return cx.stop_propagation();
            }
        }
        if local.y < self.head_height() {
            return;
        }
        // An open editor saves itself as the click takes its focus.
        if self.editing.is_some() {
            self.finish_editing(true, None, false, window, cx);
        }
        self.focus.focus(window, cx);
        let Some(cell) = self.cell_at(local) else { return };
        if local.y >= self.head_height() + self.order.len() as f32 * self.row_height() - self.scroll.y {
            return;
        }
        if local.x < self.gutter() {
            // A row number selects the whole row.
            let start = match self.anchor {
                Some(anchor) if event.modifiers.shift => anchor.row,
                _ => cell.row,
            };
            self.anchor = Some(Cell { row: start, col: 0 });
            self.cursor = Some(Cell { row: cell.row, col: self.columns() - 1 });
        } else if local.x - self.gutter() + self.scroll.x < self.offsets.last().copied().unwrap_or(0.) {
            self.anchor = Some(if event.modifiers.shift { self.anchor.or(self.cursor).unwrap_or(cell) } else { cell });
            self.cursor = Some(cell);
            self.drag = Some(Drag::Select);
            if event.click_count == 2 && self.editable() {
                self.drag = None;
                self.anchor = Some(cell);
                self.start_editing(cell, None, window, cx);
            }
        }
        cx.notify();
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let local = self.local(event.position);
        let pressed = event.pressed_button == Some(MouseButton::Left);
        match self.drag {
            Some(_) if !pressed => self.drag = None,
            Some(Drag::Select) => {
                if let Some(cell) = self.cell_at(local).filter(|cell| Some(*cell) != self.cursor) {
                    self.cursor = Some(cell);
                    self.reveal(cell);
                    cx.notify();
                }
                return;
            }
            Some(Drag::Resize { column, start_x, start_width }) => {
                let width = (start_width + f32::from(event.position.x) - start_x).round().max(40.);
                self.resized.insert(column, width);
                return cx.notify();
            }
            Some(Drag::ScrollY { grab }) => {
                let (view, max, head) = (self.view_size(), self.max_scroll(), self.head_height());
                if let (Some((_, length)), _) = self.thumbs() {
                    let track = view.height - head - length;
                    self.scroll.y = if track > 0. { (local.y - grab - head) / track * max.y } else { 0. };
                    self.clamp_scroll();
                    self.note_scrolled(cx);
                }
                return cx.notify();
            }
            Some(Drag::ScrollX { grab }) => {
                let (view, max, gutter) = (self.view_size(), self.max_scroll(), self.gutter());
                if let (_, Some((_, length))) = self.thumbs() {
                    let track = view.width - gutter - length;
                    self.scroll.x = if track > 0. { (local.x - grab - gutter) / track * max.x } else { 0. };
                    self.clamp_scroll();
                    self.note_scrolled(cx);
                }
                return cx.notify();
            }
            None => {}
        }
        let view = self.view_size();
        let over_rows = local.x >= self.gutter()
            && local.x < view.width
            && local.y >= self.head_height()
            && local.y < (self.head_height() + self.order.len() as f32 * self.row_height() - self.scroll.y).min(view.height)
            && local.x - self.gutter() + self.scroll.x < self.offsets.last().copied().unwrap_or(0.);
        let hover = if over_rows { self.cell_at(local) } else { None };
        if hover != self.hover {
            self.hover = hover;
            cx.notify();
        }
    }

    fn end_drag(&mut self, cx: &mut Context<Self>) {
        if self.drag.take().is_some() {
            cx.notify();
        }
    }

    // ---- what the status line says

    /// (cell name, value, detail).
    fn status(&self) -> Option<(String, String, String)> {
        let (cursor, (top, bottom, left, right)) = (self.cursor?, self.selection()?);
        if self.max_row() < self.min_row() {
            return None;
        }
        let row = self.file_row(cursor.row);
        let label = format!("{}{}", column_letter(cursor.col), row + 1);
        if top == bottom && left == right {
            return Some((label, self.doc.cell_value(row, cursor.col).into_owned(), String::new()));
        }
        let cells = (bottom - top + 1) as usize * (right - left + 1);
        let mut detail = String::new();
        if cells <= 20_000 {
            let (mut sum, mut numbers) = (0f64, 0usize);
            for r in top..=bottom {
                for c in left..=right {
                    if let Some(number) = self.doc.cell_number(self.file_row(r), c) {
                        sum += number;
                        numbers += 1;
                    }
                }
            }
            if numbers > 1 {
                detail = format!("Sum {}", format_sum(sum));
            }
        }
        Some((label, format!("{} selected", count(cells, "cell")), detail))
    }

    fn filtered(&self) -> bool {
        !self.filter.trim().is_empty()
    }

    fn summary(&self) -> String {
        let body_rows = self.doc.row_count().saturating_sub(self.first_row());
        if self.filtered() {
            format!("{} of {}", grouped(self.order.len()), count(body_rows, "row"))
        } else {
            format!("{} × {}", count(body_rows, "row"), count(self.doc.column_count, "column"))
        }
    }

    fn header_label(&self, column: usize) -> String {
        if self.header_on() { self.doc.cell_value(0, column).into_owned() } else { column_letter(column) }
    }
}

// ---------------------------------------------------------------------------
// Drawing

/// Everything the painted rows need, read from the table before the frame.
struct Rows {
    palette: Palette,
    font: Font,
    font_size: f32,
    row_height: f32,
    head_height: f32,
    gutter: f32,
    scroll: Point<f32>,
    /// (index on screen, file row, the visible cells' text).
    rows: Vec<(usize, u32, Vec<SharedString>)>,
    columns: std::ops::Range<usize>,
    offsets: Vec<f32>,
    numeric: Vec<bool>,
    selection: Option<(i64, i64, usize, usize)>,
    cursor: Option<Cell>,
    hover_row: Option<i64>,
    editing: Option<Cell>,
    thumbs: Thumbs,
}

fn text_run(len: usize, font: &Font, color: Hsla) -> TextRun {
    TextRun { len, font: font.clone(), color, background_color: None, underline: None, strikethrough: None }
}

impl Rows {
    fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
        let p = &self.palette;
        let (ox, oy) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
        let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let rect = |x: f32, y: f32, w: f32, h: f32| Bounds::new(point(px(ox + x), px(oy + y)), size(px(w), px(h)));
        let size = px(self.font_size);
        let line_height = px(self.row_height - 1.);
        let ellipsis = window.text_system().shape_line("…".into(), size, &[text_run("…".len(), &self.font, p.fg)], None).width;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for (index, _, cells) in &self.rows {
                let y = self.head_height + *index as f32 * self.row_height - self.scroll.y;
                if y >= height || y + self.row_height <= 0. {
                    continue;
                }
                if index % 2 == 1 {
                    window.paint_quad(fill(rect(self.gutter, y, width - self.gutter, self.row_height), p.stripe));
                }
                let row = *index as i64;
                let selected_row = self.selection.is_some_and(|(top, bottom, ..)| row >= top && row <= bottom);
                for (column, text) in self.columns.clone().zip(cells) {
                    let x = self.gutter + self.offsets[column] - self.scroll.x;
                    let cell_width = self.offsets[column + 1] - self.offsets[column];
                    let selected = selected_row && self.selection.is_some_and(|(_, _, left, right)| column >= left && column <= right);
                    if selected {
                        window.paint_quad(fill(rect(x, y, cell_width, self.row_height), p.select));
                    } else if self.hover_row == Some(row) {
                        window.paint_quad(fill(rect(x, y, cell_width, self.row_height), p.hover));
                    }
                    window.paint_quad(fill(rect(x + cell_width - 1., y, 1., self.row_height), p.line));
                    window.paint_quad(fill(rect(x, y + self.row_height - 1., cell_width, 1.), p.line));
                    let editing = self.editing == Some(Cell { row, col: column });
                    if !text.is_empty() && !editing {
                        let room = px((cell_width - 21.).max(0.));
                        let mut shaped = window.text_system().shape_line(text.clone(), size, &[text_run(text.len(), &self.font, p.fg)], None);
                        if shaped.width > room {
                            let mut cut = shaped.closest_index_for_x((room - ellipsis).max(px(0.))).min(text.len());
                            while cut > 0 && !text.is_char_boundary(cut) {
                                cut -= 1;
                            }
                            let short: SharedString = format!("{}…", text[..cut].trim_end()).into();
                            shaped = window.text_system().shape_line(short.clone(), size, &[text_run(short.len(), &self.font, p.fg)], None);
                        }
                        let left = if self.numeric.get(column).copied().unwrap_or(false) { x + cell_width - 11. - f32::from(shaped.width) } else { x + 10. };
                        let _ = shaped.paint(point(px(ox + left.max(x + 10.)), px(oy + y)), line_height, TextAlign::Left, None, window, cx);
                    }
                    if self.cursor == Some(Cell { row, col: column }) && !editing {
                        window.paint_quad(quad(rect(x, y, cell_width, self.row_height), px(0.), gpui_kit::transparent_black(), px(2.), p.accent, BorderStyle::Solid));
                    }
                }
            }
            // The row numbers stay put while the cells scroll under them.
            let small = px(self.font_size * 0.85);
            for (index, file_row, _) in &self.rows {
                let y = self.head_height + *index as f32 * self.row_height - self.scroll.y;
                if y >= height || y + self.row_height <= 0. {
                    continue;
                }
                let row = *index as i64;
                let selected = self.selection.is_some_and(|(top, bottom, ..)| row >= top && row <= bottom);
                window.paint_quad(fill(rect(0., y, self.gutter, self.row_height), if selected { p.head_select } else { p.head }));
                window.paint_quad(fill(rect(self.gutter - 1., y, 1., self.row_height), p.line));
                // The number is the row's line in the file, so it still names the row when sorted.
                let label: SharedString = (file_row + 1).to_string().into();
                let shaped = window.text_system().shape_line(label.clone(), small, &[text_run(label.len(), &self.font, if selected { p.fg } else { p.muted })], None);
                let _ = shaped.paint(point(px(ox + self.gutter - 9. - f32::from(shaped.width)), px(oy + y)), px(self.row_height), TextAlign::Left, None, window, cx);
            }
            let thumb = fade(p.fg, 0.42);
            if let Some((start, length)) = self.thumbs.0 {
                window.paint_quad(fill(rect(width - 9., start + 2., 7., length - 4.), thumb).corner_radii(px(3.5)));
            }
            if let Some((start, length)) = self.thumbs.1 {
                window.paint_quad(fill(rect(start + 2., height - 9., length - 4., 7.), thumb).corner_radii(px(3.5)));
            }
        });
    }
}

impl CsvTable {
    fn rows_to_paint(&self, palette: Palette, font: Font) -> Rows {
        let columns = self.visible_columns();
        let rows = self
            .visible_rows()
            .map(|index| {
                let file_row = self.order[index];
                let cells = columns.clone().map(|c| self.doc.raw(file_row as usize, c).map_or_else(SharedString::default, |raw| one_line(&markie_core::csv_table::decode_field(raw)))).collect();
                (index, file_row, cells)
            })
            .collect();
        Rows {
            palette,
            font,
            font_size: self.font_size(),
            row_height: self.row_height(),
            head_height: self.head_height(),
            gutter: self.gutter(),
            scroll: self.scroll,
            rows,
            columns,
            offsets: self.offsets.clone(),
            numeric: self.numeric.clone(),
            selection: self.selection(),
            cursor: self.cursor,
            hover_row: self.hover.map(|c| c.row),
            editing: self.editing.as_ref().map(|e| e.cell),
            thumbs: if self.scrollbars_shown() { self.thumbs() } else { (None, None) },
        }
    }
}

const SEARCH_ICON: &str = r#"<circle cx="11" cy="11" r="7" stroke="COLOR" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="COLOR" stroke-width="2" stroke-linecap="round"/>"#;

impl CsvTable {
    fn bar_button(&self, id: &'static str, label: &'static str, tip: &'static str, disabled: bool, p: &Palette) -> Stateful<Div> {
        let (fg, hover) = (p.fg, fade(p.fg, 0.08));
        div()
            .id(id)
            .h(px(26.))
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .text_color(p.muted)
            .whitespace_nowrap()
            .when(disabled, |el| el.opacity(0.4))
            .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.bg(hover).text_color(fg)))
            .tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
            .child(label)
    }

    /// The row above the table: the Table / Text switch, the filter, the
    /// header toggle, the row and column buttons, and the size of the file.
    fn render_bar(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let table = !self.text_view;
        let switch = |id: &'static str, label: &'static str, pressed: bool| {
            let fg = p.fg;
            div()
                .id(id)
                .h(px(24.))
                .px(px(11.))
                .flex()
                .items_center()
                .rounded(px(6.))
                .line_height(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .map(|el| {
                    if pressed {
                        el.bg(p.bg).text_color(p.fg).shadow(vec![shadow(fade(black(), 0.16), 0., 1., 2.), ring(p.line, 1.)])
                    } else {
                        el.text_color(p.muted).hover(move |s| s.text_color(fg))
                    }
                })
                .child(label)
        };
        let mut bar = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .flex_none()
            .w_full()
            .items_center()
            .gap_x(px(10.))
            .gap_y(px(6.))
            .px(px(12.))
            .py(px(7.))
            .border_b_1()
            .border_color(p.line)
            .bg(p.bar)
            .text_size(px(12.))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .gap(px(2.))
                    .p(px(2.))
                    .rounded(px(8.))
                    .bg(mix(p.fg, 0.08, p.bar))
                    .child(switch("csv-show-table", "Table", table).on_click(cx.listener(|_, _, _, cx| cx.emit(CsvEvent::ShowTable))))
                    .child(switch("csv-show-text", "Text", !table).on_click(cx.listener(|_, _, _, cx| cx.emit(CsvEvent::ShowText)))),
            );
        if table {
            let focused = self.filter_input.read(cx).focus_handle(cx).is_focused(window);
            let icon = svg_image(&SEARCH_ICON.replace("COLOR", &super::dialog_chrome::css(p.muted)), 24., 24., 13., 13.);
            bar = bar.child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(6.))
                    .w(px(220.))
                    .h(px(28.))
                    .pl(px(9.))
                    .pr(px(5.))
                    .rounded(px(7.))
                    .border_1()
                    .border_color(if focused { fade(p.accent, 0.7) } else { p.line })
                    .when(focused, |el| el.shadow(vec![ring(fade(p.accent, 0.22), 2.)]))
                    .bg(p.bg)
                    .text_color(p.fg)
                    .child(icon)
                    .child(div().flex_1().min_w_0().child(Input::new(&self.filter_input).appearance(false).xsmall().text_size(px(12.)))),
            );
            let header_on = self.header_on();
            let no_rows = self.doc.row_count() == 0;
            bar = bar.child(
                div()
                    .id("csv-header-row")
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(6.))
                    .text_color(p.muted)
                    .when(no_rows, |el| el.opacity(0.5))
                    .when(!no_rows, |el| el.cursor_pointer().on_click(cx.listener(move |this, _, _, cx| this.set_header(!header_on, cx))))
                    .tooltip(|window, cx| Tooltip::new("Use the first row as the column names").build(window, cx))
                    .child(
                        div()
                            .size(px(13.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(3.))
                            .map(|el| if header_on { el.bg(p.accent) } else { el.bg(p.bg).border_1().border_color(fade(p.fg, 0.45)) })
                            .when(header_on, |el| el.child(stroke_icon(PATH_CHECK, gpui_kit::white(), 10., 3.5))),
                    )
                    .child("Header row"),
            );
            if self.editable() {
                let no_row = self.cursor.is_none_or(|c| c.row == HEADER) || self.order.is_empty();
                let no_column = self.cursor.is_none() || self.doc.column_count == 0;
                bar = bar.child(
                    div()
                        .flex()
                        .flex_none()
                        .gap(px(2.))
                        .child(self.bar_button("csv-add-row", "+ Row", "Add a row below the selection", false, p).on_click(cx.listener(|this, _, window, cx| this.add_row(window, cx))))
                        .child(self.bar_button("csv-add-column", "+ Column", "Add a column to the right of the selection", false, p).on_click(cx.listener(|this, _, _, cx| this.add_column(cx))))
                        .child(self.bar_button("csv-delete-row", "Delete row", "Delete the selected rows", no_row, p).when(!no_row, |el| el.on_click(cx.listener(|this, _, _, cx| this.remove_rows(cx)))))
                        .child(self.bar_button("csv-delete-column", "Delete column", "Delete the selected columns", no_column, p).when(!no_column, |el| el.on_click(cx.listener(|this, _, _, cx| this.remove_columns(cx))))),
                );
            }
            if self.cursor.is_some() {
                let copy = |delimiter: char| cx.listener(move |this: &mut Self, _: &ClickEvent, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(this.copy_as(delimiter))));
                bar = bar.child(
                    div()
                        .flex()
                        .flex_none()
                        .gap(px(2.))
                        .child(self.bar_button("csv-copy-csv", "Copy CSV", "Copy the selection as comma-separated text", false, p).on_click(copy(',')))
                        .child(self.bar_button("csv-copy-tsv", "Copy TSV", "Copy the selection as tab-separated text", false, p).on_click(copy('\t'))),
                );
            }
        }
        bar.child(div().ml_auto().text_color(p.muted).whitespace_nowrap().child(self.summary()))
    }

    fn render_status(&self, p: &Palette) -> Div {
        let mut bar = div()
            .flex()
            .flex_row()
            .flex_none()
            .w_full()
            .items_center()
            .gap(px(10.))
            .min_h(px(28.))
            .px(px(12.))
            .border_t_1()
            .border_color(p.line)
            .bg(p.bar)
            .text_color(p.muted)
            .text_size(px(12.));
        let detail = |text: String| div().flex_none().whitespace_nowrap().child(text);
        match self.status() {
            Some((label, value, note)) => {
                bar = bar
                    .child(div().flex_none().px(px(6.)).py(px(2.)).rounded(px(4.)).bg(fade(p.fg, 0.08)).text_color(p.fg).font_family(markie_editor::MONO).text_size(px(11.)).child(label))
                    .child(div().flex_1().min_w_0().truncate().text_color(p.fg).child(one_line(&value)));
                if !note.is_empty() {
                    bar = bar.child(detail(note));
                }
            }
            None => {
                let hint = if self.editable() { "Select a cell. Enter edits it, Escape cancels." } else { "Select a cell to read all of it." };
                bar = bar.child(div().flex_1().min_w_0().truncate().child(hint));
            }
        }
        if self.matched > MAX_SHOWN_ROWS {
            bar = bar.child(detail(format!("Showing the first {} rows", grouped(MAX_SHOWN_ROWS))));
        }
        let view_only = if self.sort.is_some() || self.filtered() { " · view only, the file keeps its order" } else { "" };
        bar.child(detail(format!("{}{view_only}", delimiter_name(self.doc.delimiter))))
    }

    fn render_head(&self, p: &Palette, cx: &mut Context<Self>) -> Div {
        let (row, gutter, scroll) = (self.row_height(), self.gutter(), self.scroll.x);
        let header_on = self.header_on();
        let selection = self.selection().filter(|(top, ..)| *top == HEADER);
        let editing = self.editing.as_ref().map(|e| e.cell);
        let mut head = div().absolute().top_0().left_0().w_full().h(px(self.head_height())).bg(p.head).border_b_1().border_color(p.line).overflow_hidden().font_weight(FontWeight::SEMIBOLD);
        let hover = fade(p.fg, 0.06);
        for column in self.visible_columns() {
            let numeric = self.numeric.get(column).copied().unwrap_or(false);
            let label = self.header_label(column);
            let tip: SharedString = if label.is_empty() { "Click to sort".into() } else { format!("{}: click to sort", one_line(&label)).into() };
            let mark = self.sort.filter(|s| s.column == column).map(|s| if s.direction == SortDirection::Asc { "▲" } else { "▼" });
            let selected = header_on && selection.is_some_and(|(_, _, left, right)| column >= left && column <= right);
            let cursor = header_on && self.cursor == Some(Cell { row: HEADER, col: column });
            let hidden = editing == Some(Cell { row: HEADER, col: column });
            head = head.child(
                div()
                    .id(("csv-th", column))
                    .absolute()
                    .top_0()
                    .left(px(gutter + self.offsets[column] - scroll))
                    .w(px(self.widths[column]))
                    .h(px(row))
                    .flex()
                    .border_r_1()
                    .border_color(p.line)
                    .when(selected, |el| el.bg(p.head_select))
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| this.head_click(column, event.click_count(), window, cx)))
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .gap(px(4.))
                            .px(px(10.))
                            .hover(move |s| s.bg(hover))
                            .when(numeric, |el| el.flex_row_reverse())
                            .when(!hidden, |el| el.child(div().min_w_0().truncate().child(one_line(&label))))
                            .children(mark.map(|m| div().flex_none().text_color(p.accent).text_size(px(self.font_size() * 0.62)).child(m))),
                    )
                    .when(cursor, |el| el.child(div().absolute().inset_0().border_2().border_color(p.accent))),
            );
        }
        // The resize handles sit over the line between two headers.
        for column in self.visible_columns() {
            let group: SharedString = format!("csv-resize-{column}").into();
            let dragging = matches!(self.drag, Some(Drag::Resize { column: c, .. }) if c == column);
            head = head.child(
                div()
                    .id(("csv-resize", column))
                    .group(group.clone())
                    .absolute()
                    .top_0()
                    .left(px(gutter + self.offsets[column + 1] - scroll - 4.))
                    .w(px(8.))
                    .h(px(row))
                    .flex()
                    .justify_center()
                    .cursor_col_resize()
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                        if event.click_count == 2 {
                            // A double click fits the column to its content again.
                            this.resized.remove(&column);
                            this.drag = None;
                        } else {
                            this.drag = Some(Drag::Resize { column, start_x: f32::from(event.position.x), start_width: this.widths[column] });
                        }
                        cx.stop_propagation();
                        cx.notify();
                    }))
                    .child(div().w(px(2.)).h_full().when(dragging, |el| el.bg(p.accent)).group_hover(group, |s| s.bg(p.accent))),
            );
        }
        head.child(div().absolute().top_0().left_0().w(px(gutter)).h(px(row)).bg(p.head).border_r_1().border_color(p.line).occlude())
    }

    fn head_click(&mut self, column: usize, clicks: usize, window: &mut Window, cx: &mut Context<Self>) {
        if clicks <= 1 {
            self.toggle_sort(column, cx);
            self.focus.focus(window, cx);
        } else if clicks == 2 && self.header_on() && self.editable() {
            self.sort = self.sort_before_click;
            self.recompute_view();
            let cell = Cell { row: HEADER, col: column };
            self.cursor = Some(cell);
            self.anchor = Some(cell);
            self.start_editing(cell, None, window, cx);
        }
    }

    /// Where a cell is in the grid: (left, top, width).
    fn cell_rect(&self, cell: Cell) -> (f32, f32, f32) {
        let left = self.gutter() + self.offsets.get(cell.col).copied().unwrap_or(0.) - self.scroll.x;
        let top = if cell.row == HEADER { 0. } else { self.head_height() + cell.row as f32 * self.row_height() - self.scroll.y };
        (left, top, self.widths.get(cell.col).copied().unwrap_or(96.))
    }

    fn render_editor(&self, p: &Palette, cx: &mut Context<Self>) -> Option<Div> {
        let editing = self.editing.as_ref()?;
        let (left, top, width) = self.cell_rect(editing.cell);
        let (row, size) = (self.row_height(), self.font_size());
        let line = size * 1.25;
        let input = editing.input.clone();
        Some(
            div()
                .absolute()
                .left(px(left - 1.))
                .top(px(top - 1.))
                .w(px((width + 2.).max(120.)))
                .min_h(px(row + 1.))
                .border_2()
                .border_color(p.accent)
                .rounded(px(2.))
                .bg(p.bg)
                .text_color(p.fg)
                .shadow(vec![shadow(fade(black(), 0.22), 0., 6., 18.)])
                // `padding: … 9px` less the 2 px border and GPUI Kit's own 4 px inset.
                .px(px(3.))
                .py(px(((row - line) / 2.).max(0.)))
                .font_weight(FontWeight::NORMAL)
                .occlude()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .capture_action(cx.listener(|this, _: &kit::Escape, window, cx| {
                    this.finish_editing(false, None, true, window, cx);
                    cx.stop_propagation();
                }))
                .capture_action(cx.listener(|this, _: &kit::IndentInline, window, cx| {
                    this.finish_editing(true, Some(Direction::Right), true, window, cx);
                    cx.stop_propagation();
                }))
                .capture_action(cx.listener(|this, _: &kit::OutdentInline, window, cx| {
                    this.finish_editing(true, Some(Direction::Left), true, window, cx);
                    cx.stop_propagation();
                }))
                .capture_key_down(cx.listener(move |_, event: &KeyDownEvent, window, cx| {
                    // Option+Enter is a line break inside the cell.
                    if event.keystroke.key == "enter" && event.keystroke.modifiers.alt {
                        input.update(cx, |state, cx| state.insert("\n", window, cx));
                        cx.stop_propagation();
                    }
                }))
                .child(Textarea::new(&editing.input).appearance(false).xsmall().text_size(px(size)).line_height(px(line)).h(px(line * editing.lines as f32))),
        )
    }

    fn render_grid(&mut self, p: Palette, font: Font, cx: &mut Context<Self>) -> Stateful<Div> {
        let rows = self.rows_to_paint(p, font);
        let (entity, viewport) = (cx.entity(), self.viewport.clone());
        let edit = |this: &mut Self, cx: &mut Context<Self>, run: &dyn Fn(&mut Self, &mut Context<Self>)| {
            // While a cell is open the command belongs to its text field.
            if this.editing.is_some() { cx.propagate() } else { run(this, cx) }
        };
        let empty = self.order.is_empty().then(|| {
            let message = if self.doc.row_count() == 0 {
                "This file is empty."
            } else if self.filtered() {
                "No rows match the filter."
            } else {
                "No rows yet."
            };
            div().absolute().top(px(self.head_height())).left_0().w_full().px(px(16.)).py(px(28.)).flex().justify_center().text_color(p.muted).text_size(px(13.)).child(message)
        });
        // The whole of a long cell shows while the pointer rests on it.
        let tip = self.hover.filter(|_| self.drag.is_none() && self.editing.is_none()).and_then(|cell| {
            let value = self.doc.cell_value(self.file_row(cell.row), cell.col);
            let (left, top, width) = self.cell_rect(cell);
            if value.chars().count() as f32 * 7. <= width - 20. {
                return None;
            }
            let text: SharedString = value.chars().take(2_000).collect::<String>().into();
            Some(
                div()
                    .id(("csv-tip", cell.row as usize * self.columns() + cell.col))
                    .absolute()
                    .left(px(left.max(self.gutter())))
                    .top(px(top.max(self.head_height())))
                    .w(px(width))
                    .h(px(self.row_height()))
                    .tooltip(move |window, cx| Tooltip::new(text.clone()).build(window, cx)),
            )
        });
        div()
            .id("csv-grid")
            .track_focus(&self.focus)
            .key_context(KEY_CONTEXT)
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_hidden()
            .text_size(px(self.font_size()))
            .on_key_down(cx.listener(Self::on_key_down))
            .on_action(cx.listener(move |this, _: &EditCopy, _, cx| edit(this, cx, &|this, cx| this.copy(false, cx))))
            .on_action(cx.listener(move |this, _: &EditCut, _, cx| edit(this, cx, &|this, cx| this.copy(true, cx))))
            .on_action(cx.listener(move |this, _: &EditPaste, _, cx| {
                edit(this, cx, &|this, cx| {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()).filter(|_| this.editable()) {
                        this.paste(&text, cx);
                    }
                })
            }))
            .on_action(cx.listener(move |this, _: &EditSelectAll, _, cx| edit(this, cx, &|this, cx| this.select_all(cx))))
            .on_action(cx.listener(move |this, _: &EditUndo, _, cx| edit(this, cx, &|this, cx| this.travel(true, cx))))
            .on_action(cx.listener(move |this, _: &EditRedo, _, cx| edit(this, cx, &|this, cx| this.travel(false, cx))))
            .on_action(cx.listener(|_, _: &EditFind, _, cx| cx.emit(CsvEvent::Find)))
            .on_action(cx.listener(|this, _: &NextCell, _, cx| {
                if this.editing.is_some() || !this.tab(false, cx) {
                    cx.propagate();
                }
            }))
            .on_action(cx.listener(|this, _: &PreviousCell, _, cx| {
                if this.editing.is_some() || !this.tab(true, cx) {
                    cx.propagate();
                }
            }))
            .on_scroll(cx.listener(|this, event: &ScrollEvent, _, cx| this.on_scroll(event, cx)))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| this.on_mouse_move(event, cx)))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.end_drag(cx)))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.end_drag(cx)))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered && this.hover.take().is_some() {
                    cx.notify();
                }
            }))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        if viewport.get() != bounds {
                            viewport.set(bounds);
                            // The rows to draw depend on the size: once more, with it.
                            window.defer(cx, move |_, cx| entity.update(cx, |_, cx| cx.notify()));
                        }
                    },
                    move |bounds, _, window, cx| rows.paint(bounds, window, cx),
                )
                .absolute()
                .size_full(),
            )
            .child(self.render_head(&p, cx))
            .children(empty)
            .children(tip)
            .children(self.render_editor(&p, cx))
    }
}

impl Render for CsvTable {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.reset_filter_input) {
            self.filter_input.update(cx, |state, cx| state.set_value("", window, cx));
        }
        let p = Palette::current(cx);
        let root = div().flex().flex_col().w_full().min_w_0().bg(p.bg).text_color(p.fg).child(self.render_bar(&p, window, cx));
        if self.text_view {
            // The host draws the file's own text under the bar.
            return root.flex_none();
        }
        let font = window.text_style().font();
        if self.viewport.get().size.height <= px(0.) {
            // Before the first paint: no larger than the window it is in.
            self.viewport.set(Bounds::new(point(px(0.), px(0.)), window.viewport_size()));
        }
        self.layout_columns(&font, window);
        root.h_full().min_h_0().child(self.render_grid(p, font, cx)).child(self.render_status(&p))
    }
}

/// Scene mode (docs/rust-port/SCREEN.md): the table put in a state from code,
/// through the functions the controls and keys call.
#[cfg(feature = "scene")]
impl CsvTable {
    /// `{header?: bool, filter?: "…", sort?: [column, "asc" | "desc"], cursor?: [row, column],
    ///   anchor?: [row, column], scroll?: [x, y], resize?: [[column, width]], edit?: true,
    ///   hover?: [row, column], scrollbars?: true}`. Rows count from 0 on screen; -1 is the header.
    pub(super) fn scene(&mut self, args: &serde_json::Value, window: &mut Window, cx: &mut Context<Self>) {
        use serde_json::Value;
        let pair = |key: &str| {
            let list = args.get(key)?.as_array()?;
            Some((list.first()?.as_i64()?, list.get(1)?.as_i64()?))
        };
        if let Some(on) = args.get("header").and_then(Value::as_bool) {
            self.set_header(on, cx);
        }
        if let Some(filter) = args.get("filter").and_then(Value::as_str) {
            self.filter_input.update(cx, |state, cx| state.set_value(filter.to_string(), window, cx));
            self.set_filter(filter.to_string(), cx);
        }
        if let Some(sort) = args.get("sort").and_then(Value::as_array) {
            let column = sort.first().and_then(Value::as_u64).unwrap_or(0) as usize;
            let direction = if sort.get(1).and_then(Value::as_str) == Some("desc") { SortDirection::Desc } else { SortDirection::Asc };
            self.sort = Some(CsvSort { column, direction });
            self.recompute_view();
        }
        for entry in args.get("resize").and_then(Value::as_array).into_iter().flatten() {
            if let (Some(column), Some(width)) = (entry.get(0).and_then(Value::as_u64), entry.get(1).and_then(Value::as_f64)) {
                self.resized.insert(column as usize, width as f32);
            }
        }
        if let Some((row, col)) = pair("cursor") {
            self.move_to(row, col, false, cx);
        }
        if let Some((row, col)) = pair("anchor") {
            self.anchor = Some(Cell { row, col: col as usize });
            self.clamp_cursor();
        }
        if let Some((x, y)) = args.get("scroll").and_then(Value::as_array).and_then(|a| Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))) {
            self.scroll = point(x as f32, y as f32);
            self.clamp_scroll();
        }
        if let Some((row, col)) = pair("hover") {
            self.hover = Some(Cell { row, col: col as usize });
        }
        if args.get("scrollbars").and_then(Value::as_bool).unwrap_or(false) {
            self.scrolled_at = Some(Instant::now() + Duration::from_secs(3600));
        }
        // `keys`: keystrokes given to the grid's own key handler, in order
        // ("down", "shift-right", "cmd-end", "x" to type). `ops`: the bar's
        // buttons and the Edit menu's commands, by name. A key or op that
        // opens a cell's editor can be followed by {"type": "…"} and
        // "commit", "commit-right" or "cancel".
        for step in args.get("keys").and_then(Value::as_array).into_iter().flatten() {
            if let Some(key) = step.as_str().and_then(|k| Keystroke::parse(Box::leak(k.to_string().into_boxed_str())).ok()) {
                let mut key = key;
                if key.key.chars().count() == 1 && !key.modifiers.platform && !key.modifiers.control {
                    key.key_char = Some(key.key.clone());
                }
                self.on_key_down(&KeyDownEvent { keystroke: key, is_held: false, prefer_character_input: false }, window, cx);
            } else if let Some(text) = step.get("type").and_then(Value::as_str)
                && let Some(editing) = &self.editing
            {
                editing.input.update(cx, |state, cx| state.set_value(text.to_string(), window, cx));
            } else if let Some(op) = step.get("op").and_then(Value::as_str) {
                match op {
                    "commit" => self.finish_editing(true, Some(Direction::Down), false, window, cx),
                    "commit-right" => self.finish_editing(true, Some(Direction::Right), false, window, cx),
                    "cancel" => self.finish_editing(false, None, false, window, cx),
                    "tab" => drop(self.tab(false, cx)),
                    "shift-tab" => drop(self.tab(true, cx)),
                    "add-row" => self.add_row(window, cx),
                    "add-column" => self.add_column(cx),
                    "delete-row" => self.remove_rows(cx),
                    "delete-column" => self.remove_columns(cx),
                    "undo" => self.travel(true, cx),
                    "redo" => self.travel(false, cx),
                    "select-all" => self.select_all(cx),
                    "clear" => self.clear_selection(cx),
                    "sort" => self.toggle_sort(self.cursor.map_or(0, |c| c.col), cx),
                    _ => eprintln!("markie-rs scene: unknown csv op {op}"),
                }
            }
        }
        if args.get("edit").and_then(Value::as_bool).unwrap_or(false)
            && let Some(cursor) = self.cursor
        {
            self.start_editing(cursor, None, window, cx);
        }
        if args.get("report").and_then(Value::as_bool).unwrap_or(false) {
            // What the keys and ops left behind, for a check that reads the log.
            // The clipboard is never written in a scene: what ⌘C would copy is printed.
            eprintln!(
                "markie-csv-state {}",
                serde_json::json!({
                    "text": self.text().to_string(),
                    "cursor": self.cursor.map(|c| [c.row, c.col as i64]),
                    "anchor": self.anchor.map(|c| [c.row, c.col as i64]),
                    "status": self.status().map(|(label, value, detail)| [label, value, detail]),
                    "summary": self.summary(),
                    "copy": self.copy_text(),
                    "copy_csv": self.copy_as(','),
                    "shown": self.order.len(),
                    "editing": self.editing.is_some(),
                })
            );
        }
        cx.notify();
    }

    /// One step of the 100,000-row measurement: a change to the view, as its
    /// control makes it. The caller draws the frame and times both together.
    pub(super) fn bench_step(&mut self, step: &str, cx: &mut Context<Self>) {
        match step {
            "sort-number-asc" => self.bench_sort(2, SortDirection::Asc),
            "sort-number-desc" => self.bench_sort(2, SortDirection::Desc),
            "sort-text-asc" => self.bench_sort(1, SortDirection::Asc),
            "sort-text-desc" => self.bench_sort(1, SortDirection::Desc),
            "sort-off" => {
                self.sort = None;
                self.recompute_view();
            }
            "filter" => self.set_filter("name 99".into(), cx),
            "filter-off" => self.set_filter(String::new(), cx),
            "scroll" => {
                // 240 points a frame: a fast flick.
                let max = self.max_scroll().y;
                self.scroll.y = if self.scroll.y + 240. > max { 0. } else { self.scroll.y + 240. };
            }
            "top" => self.scroll.y = 0.,
            _ => {}
        }
        cx.notify();
    }

    fn bench_sort(&mut self, column: usize, direction: SortDirection) {
        self.sort = Some(CsvSort { column, direction });
        self.recompute_view();
    }

    pub(super) fn shown_rows(&self) -> usize {
        self.order.len()
    }
}
