//! The sheet a CSV or TSV file opens in. A port of Electron's
//! `src/components/csv-table/csv-table.tsx` and its stylesheet.
//!
//! It is drawn as a spreadsheet: a strip of column letters and a gutter of
//! row numbers, a name box and formula bar, a frozen header row, gridlines on
//! every cell, empty cells out to the edges of the window, and a sheet tab
//! below.
//!
//! The file stays the file. Every edit goes through the lossless model in
//! `markie_core::csv_table`, which rewrites only the cells that changed;
//! sorting, filtering and the way a number, a date or a link is drawn change
//! what is shown and never touch the text.
//!
//! The toolbar, the formula bar, the letters, the header row and the sheet
//! tab are ordinary elements. The rows are painted directly: only the rows
//! and columns on screen are read, shaped and drawn, so a file of any length
//! costs the same per frame.

use std::cell::Cell as StdCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::input::{self as kit, Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::Sizable as _;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::csv_table::{
    CellKind, CsvDocument, CsvSort, RangeStats, SortDirection, cell_reference, clipboard_to_cells, column_letter, format_average, format_cell, format_sum, grouped, parse_cell_reference,
};

use super::dialog_chrome::{PATH_CHECK, Tokens, black, fade, mix, ring, shadow, stroke_icon, svg_image};
use super::source::{EditCopy, EditCut, EditFind, EditPaste, EditRedo, EditSelectAll, EditUndo};

const KEY_CONTEXT: &str = "CsvGrid";
const FORMULA_CONTEXT: &str = "CsvFormula";

actions!(markie_csv, [NextCell, PreviousCell]);

/// Tab in the grid walks its cells. GPUI Kit binds Tab to "next control" for
/// the whole window; a binding in the grid's own context is asked first, and
/// hands the key on when the walk reaches either end of the table.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", NextCell, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-tab", PreviousCell, Some(KEY_CONTEXT)),
        // In the formula bar Tab saves and moves on, as it does in a cell.
        KeyBinding::new("tab", NextCell, Some(FORMULA_CONTEXT)),
        KeyBinding::new("shift-tab", PreviousCell, Some(FORMULA_CONTEXT)),
    ]);
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
/// The status bar adds up a selection up to this many cells; past it, it only counts them.
const MAX_STAT_CELLS: usize = 400_000;

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
    /// From a row number: whole rows.
    Rows,
    /// From a column letter: whole columns.
    Columns,
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
    /// Gridlines are solid colours, never see-through: one crisp pixel on any fill.
    line: Hsla,
    /// The gridlines of the empty sheet past the data.
    line_faint: Hsla,
    /// The heavier rule under the header row.
    rule: Hsla,
    /// The letters and the row numbers.
    chrome: Hsla,
    chrome_select: Hsla,
    /// The text of the letters and numbers of the empty sheet.
    chrome_faint: Hsla,
    /// The header row.
    head: Hsla,
    head_select: Hsla,
    bar: Hsla,
    accent: Hsla,
    negative: Hsla,
    select: Hsla,
}

impl Palette {
    fn current(cx: &App) -> Self {
        let t = Tokens::current("markie", cx);
        let line = mix(t.border, 0.88, t.background);
        let chrome = mix(t.foreground, 0.05, t.background);
        let head = mix(t.foreground, 0.08, t.background);
        Self {
            bg: t.background,
            fg: t.foreground,
            muted: t.muted,
            line,
            line_faint: mix(line, 0.5, t.background),
            rule: mix(t.foreground, 0.34, t.background),
            chrome,
            chrome_select: mix(t.blue, 0.22, chrome),
            chrome_faint: mix(t.muted, 0.6, chrome),
            head,
            head_select: mix(t.blue, 0.16, head),
            bar: t.surface,
            accent: t.blue,
            negative: t.red,
            select: mix(t.blue, 0.13, t.background),
        }
    }
}

pub(super) struct CsvTable {
    focus: FocusHandle,
    doc: CsvDocument,
    /// The file's name, which the sheet tab carries.
    name: Option<String>,
    /// Bumped whenever the cells or the rows shown change, for what is worked out from them.
    version: u64,
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

    /// The far corner of the selection, the end the Shift keys move.
    cursor: Option<Cell>,
    /// The active cell: the one the name box names and typing edits.
    anchor: Option<Cell>,
    /// A cell was picked. The sheet opens with its first cell selected, but a
    /// row or a column is added beside one only once a cell was picked.
    picked: bool,
    editing: Option<Editing>,
    /// The name box and the formula bar.
    name_input: Entity<InputState>,
    name_shown: String,
    formula_input: Entity<InputState>,
    formula_shown: String,
    /// The cell the formula bar is typing into, and what it has typed.
    bar_edit: Option<(Cell, String)>,
    /// What the selected block adds up to, for the selection and version it was worked out for.
    stats: std::cell::RefCell<Option<(StatsKey, Option<BlockStats>)>>,
    past: Vec<Step>,
    future: Vec<Step>,
    drag: Option<Drag>,
    hover: Option<Cell>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<CsvEvent> for CsvTable {}

type StatsKey = ((i64, i64, usize, usize), u64);

/// A selected block: how many cells, and what its numbers come to (None past [`MAX_STAT_CELLS`]).
#[derive(Clone, Copy)]
struct BlockStats {
    cells: usize,
    numbers: Option<RangeStats>,
}

/// The tab reads as a sheet's name does: the file's, without its extension.
fn sheet_name(name: Option<&str>) -> String {
    let Some(name) = name else { return "Sheet 1".into() };
    let lower = name.to_ascii_lowercase();
    let stem = [".csv", ".tsv", ".tab", ".txt"].iter().find(|ext| lower.ends_with(**ext)).map_or(name, |ext| &name[..name.len() - ext.len()]);
    if stem.is_empty() { name.into() } else { stem.into() }
}

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
        let name_input = cx.new(|cx| InputState::new(window, cx));
        let formula_input = cx.new(|cx| InputState::new(window, cx));
        let subscriptions = vec![
            cx.subscribe(&filter_input, |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let value = input.read(cx).value().to_string();
                    this.set_filter(value, cx);
                }
            }),
            // The name box: a cell's name and Enter goes to it.
            cx.subscribe_in(&name_input, window, |this, input, event: &InputEvent, window, cx| match event {
                InputEvent::Focus => input.update(cx, |state, cx| state.select_all(window, cx)),
                InputEvent::PressEnter { .. } => {
                    let typed = input.read(cx).value().to_string();
                    if this.jump(&typed, cx) {
                        this.focus.focus(window, cx);
                    }
                }
                InputEvent::Blur => {
                    this.name_shown.clear();
                    cx.notify();
                }
                _ => {}
            }),
            // The formula bar edits the active cell. Leaving it saves, as leaving a cell does.
            cx.subscribe_in(&formula_input, window, |this, input, event: &InputEvent, window, cx| match event {
                InputEvent::Focus => this.begin_bar_edit(window, cx),
                InputEvent::Change => {
                    if let Some((_, text)) = this.bar_edit.as_mut() {
                        *text = input.read(cx).value().to_string();
                        cx.notify();
                    }
                }
                InputEvent::PressEnter { shift: false, .. } => this.finish_bar_edit(true, Some(Direction::Down), true, window, cx),
                InputEvent::Blur => this.finish_bar_edit(true, None, false, window, cx),
                _ => {}
            }),
        ];
        Self {
            focus: cx.focus_handle(),
            doc: CsvDocument::parse("", None),
            name: None,
            version: 0,
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
            picked: false,
            editing: None,
            name_input,
            name_shown: String::new(),
            formula_input,
            formula_shown: String::new(),
            bar_edit: None,
            stats: Default::default(),
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
        self.name = name.map(str::to_string);
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
        self.bar_edit = None;
        self.cursor = None;
        self.anchor = None;
        self.picked = false;
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
        self.version += 1;
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
        // A sheet opens with its first cell selected.
        let first = clamp(Cell { row: 0, col: 0 });
        self.cursor = Some(self.cursor.map_or(first, clamp));
        self.anchor = Some(self.anchor.map_or(self.cursor.unwrap_or(first), clamp));
    }

    /// The active cell.
    fn active(&self) -> Option<Cell> {
        self.anchor.or(self.cursor)
    }

    fn select(&mut self, anchor: Cell, cursor: Cell) {
        self.anchor = Some(anchor);
        self.cursor = Some(cursor);
        self.picked = true;
    }

    fn single(&self) -> bool {
        self.selection().is_some_and(|(top, bottom, left, right)| top == bottom && left == right)
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
        (24. * self.zoom).round()
    }

    /// The strip of column letters.
    fn letter_height(&self) -> f32 {
        (20. * self.zoom).round()
    }

    /// A column of the empty sheet past the last one in the file.
    fn fill_width(&self) -> f32 {
        (96. * self.zoom).round()
    }

    fn font_size(&self) -> f32 {
        (13. * self.zoom * 10.).round() / 10.
    }

    /// What stays put above the rows: the letters, and the header row under them.
    fn head_height(&self) -> f32 {
        self.letter_height() + if self.header_on() { self.row_height() } else { 0. }
    }

    /// Wide enough for the numbers of the empty rows under the data as well.
    fn gutter(&self) -> f32 {
        ((16. + (self.doc.row_count() + 60).to_string().len() as f32 * 7.5) * self.zoom).round().max(36.)
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
        let header_on = self.header_on();
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
                let text_width = f32::from(window.text_system().shape_line(text, size, &[run], None).width).ceil();
                // The header is bold and leaves room for its sort mark.
                let measured = if header_on && r == 0 { (text_width * 1.08).ceil() + 34. } else { text_width + 20. };
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
        self.widths = (0..columns).map(|c| self.resized.get(&c).copied().unwrap_or_else(|| self.auto_widths.get(c).copied().unwrap_or(self.fill_width()))).collect();
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
        self.select(if extend { self.active().unwrap_or(next) } else { next }, next);
        self.reveal(next);
        cx.notify();
    }

    /// The name box: "B4" and Enter goes to that cell. False when the sheet has no such cell.
    fn jump(&mut self, reference: &str, cx: &mut Context<Self>) -> bool {
        let Some((file_row, column)) = parse_cell_reference(reference).filter(|(_, column)| *column < self.columns()) else { return false };
        let row = if self.header_on() && file_row == 0 {
            HEADER
        } else {
            match self.order.iter().position(|r| *r as usize == file_row) {
                Some(row) => row as i64,
                None => return false,
            }
        };
        self.name_shown.clear();
        self.move_to(row, column as i64, false, cx);
        true
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
        self.version += 1;
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
                }
                // The formula bar shows what is being typed.
                cx.notify();
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
        self.step_from(cell, then, cx);
        if refocus {
            self.focus.focus(window, cx);
        }
        cx.notify();
    }

    /// The formula bar took the focus: it now types into the active cell.
    fn begin_bar_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing.is_some() {
            self.finish_editing(true, None, false, window, cx);
        }
        let Some(cell) = self.active().filter(|_| self.editable() && self.bar_edit.is_none()) else { return };
        let value = self.doc.cell_value(self.file_row(cell.row), cell.col).into_owned();
        self.bar_edit = Some((cell, value));
        cx.notify();
    }

    fn finish_bar_edit(&mut self, save: bool, then: Option<Direction>, refocus: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((cell, value)) = self.bar_edit.take() else { return };
        if save {
            let row = self.file_row(cell.row);
            self.commit_cells(&[(row, cell.col, value.as_str())], cx);
        }
        self.formula_shown.clear();
        self.step_from(cell, then, cx);
        if refocus {
            self.focus.focus(window, cx);
        }
        cx.notify();
    }

    /// Where Enter and Tab go after an edit of `cell`.
    fn step_from(&mut self, cell: Cell, then: Option<Direction>, cx: &mut Context<Self>) {
        let (max_row, columns) = (self.max_row(), self.columns() as i64);
        match then {
            Some(Direction::Down) => self.move_to((cell.row + 1).min(max_row), cell.col as i64, false, cx),
            Some(Direction::Right) => self.move_to(cell.row, (cell.col as i64 + 1).min(columns - 1), false, cx),
            Some(Direction::Left) => self.move_to(cell.row, (cell.col as i64 - 1).max(0), false, cx),
            None => {}
        }
    }

    fn copy_as(&self, delimiter: char) -> String {
        self.doc.cells_to_text(&self.selected_file_rows(), &self.selected_columns(), delimiter)
    }

    /// What ⌘C puts on the clipboard: one cell as its own text, a block as tab-separated rows.
    fn copy_text(&self) -> Option<String> {
        let ((top, bottom, left, right), active) = (self.selection()?, self.active()?);
        if top == bottom && left == right {
            return Some(self.doc.cell_value(self.file_row(active.row), active.col).into_owned());
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
        let at = match self.selection().filter(|_| self.picked) {
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
        let next = Cell { row: (at as i64 - first_row as i64).max(0), col: self.active().map_or(0, |c| c.col) };
        self.select(next, next);
        self.clamp_cursor();
        self.reveal(self.cursor.unwrap_or(next));
    }

    fn add_column(&mut self, cx: &mut Context<Self>) {
        let at = self.selection().filter(|_| self.picked).map_or(self.doc.column_count, |(_, _, _, right)| right + 1);
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
        let col = self.active().map_or(0, |c| c.col);
        if !self.commit_structure(true, |doc| doc.delete_rows(&rows), cx) {
            return;
        }
        let next = Cell { row: top, col };
        self.select(next, next);
        self.clamp_cursor();
    }

    fn remove_columns(&mut self, cx: &mut Context<Self>) {
        let Some((_, _, left, _)) = self.selection() else { return };
        let dropped = self.selected_columns();
        let row = self.active().map_or(0, |c| c.row);
        self.resized.clear();
        self.sort = None;
        if !self.commit_structure(true, |doc| doc.delete_columns(&dropped), cx) {
            return;
        }
        let next = Cell { row, col: left };
        self.select(next, next);
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
        self.picked = false;
        self.bar_edit = None;
        // The header is measured bold, a first row of data is not.
        self.widths_stale = true;
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
        // Shift moves the far corner of the selection; without it the active cell moves.
        let at = (if shift { self.cursor } else { self.active() }).unwrap_or(Cell { row: min_row, col: 0 });
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
                if let Some(active) = self.active().filter(|_| self.editable()) {
                    self.start_editing(active, None, window, cx);
                    cx.stop_propagation();
                }
            }
            "escape" => {
                if let Some(active) = self.active().filter(|_| !self.single()) {
                    self.cursor = Some(active);
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
                if let (Some(typed), Some(active), false, false) = (typed, self.active(), cmd, key.modifiers.alt)
                    && self.editable()
                {
                    self.start_editing(active, Some(typed.clone()), window, cx);
                    cx.stop_propagation();
                }
            }
        }
    }

    /// Tab walks the row, then the next one; at either end it leaves the table.
    fn tab(&mut self, back: bool, cx: &mut Context<Self>) -> bool {
        let (min_row, max_row, columns) = (self.min_row(), self.max_row(), self.columns() as i64);
        let at = self.active().unwrap_or(Cell { row: min_row, col: 0 });
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
            self.select(Cell { row: min_row, col: 0 }, Cell { row: max_row, col: self.columns() - 1 });
            cx.notify();
        }
    }

    /// A row number: the whole row. Shift carries on from the active cell's row.
    fn pick_row(&mut self, row: i64, extend: bool, cx: &mut Context<Self>) {
        if self.max_row() < self.min_row() {
            return;
        }
        let start = self.anchor.filter(|_| extend).map_or(row, |anchor| anchor.row);
        self.select(Cell { row: start, col: 0 }, Cell { row, col: self.columns() - 1 });
        self.drag = Some(Drag::Rows);
        cx.notify();
    }

    /// A column letter: the whole column. Shift carries on from the active cell's column.
    fn pick_column(&mut self, column: usize, extend: bool, cx: &mut Context<Self>) {
        let (min_row, max_row) = (self.min_row(), self.max_row());
        if max_row < min_row {
            return;
        }
        let start = self.anchor.filter(|_| extend).map_or(column, |anchor| anchor.col);
        self.select(Cell { row: min_row, col: start }, Cell { row: max_row, col: column });
        self.drag = Some(Drag::Columns);
        cx.notify();
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
        // The empty sheet under and beside the data is drawn, not part of the file.
        if local.y >= self.head_height() + self.order.len() as f32 * self.row_height() - self.scroll.y {
            return;
        }
        if local.x < self.gutter() {
            self.pick_row(cell.row, event.modifiers.shift, cx);
        } else if local.x - self.gutter() + self.scroll.x < self.offsets.last().copied().unwrap_or(0.) {
            // A web address opens on a plain click where the sheet is only read,
            // and with ⌘ or Ctrl held where a click has to be able to pick the cell.
            if (self.read_only || event.modifiers.platform || event.modifiers.control)
                && let Some(url) = self.link_at(cell, local, window)
            {
                return cx.open_url(&url);
            }
            self.select(if event.modifiers.shift { self.active().unwrap_or(cell) } else { cell }, cell);
            self.drag = Some(Drag::Select);
            if event.click_count == 2 && self.editable() {
                self.drag = None;
                self.select(cell, cell);
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
            Some(Drag::Rows) => {
                if let Some(cell) = self.cell_at(local) {
                    let row = if local.y < self.head_height() && self.header_on() { HEADER } else { cell.row };
                    let next = Cell { row, col: self.columns() - 1 };
                    if Some(next) != self.cursor {
                        self.cursor = Some(next);
                        self.reveal(Cell { row, col: self.visible_columns().start });
                        cx.notify();
                    }
                }
                return;
            }
            Some(Drag::Columns) => {
                if let Some(cell) = self.cell_at(local) {
                    let next = Cell { row: self.max_row(), col: cell.col };
                    if Some(next) != self.cursor {
                        self.cursor = Some(next);
                        cx.notify();
                    }
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

    /// The web address in a cell, when the point is on its text.
    fn link_at(&self, cell: Cell, local: Point<f32>, window: &Window) -> Option<String> {
        let value = self.doc.cell_value(self.file_row(cell.row), cell.col);
        let shown = format_cell(&value, self.doc.reads_decimal_comma());
        if shown.kind != CellKind::Url {
            return None;
        }
        let (left, _, width) = self.cell_rect(cell);
        let text = one_line(&shown.text);
        let font = window.text_style().font();
        let shaped = window.text_system().shape_line(text.clone(), px(self.font_size()), &[text_run(text.len(), &font, black())], None);
        let end = left + 8. + f32::from(shaped.width).min((width - 17.).max(0.));
        (local.x >= left + 8. && local.x <= end).then(|| shown.text.into_owned())
    }

    // ---- what the name box, the formula bar and the status bar say

    /// The active cell's name, "B4": its column's letter and its line in the file.
    fn active_reference(&self) -> String {
        self.active().map_or_else(String::new, |cell| cell_reference(self.file_row(cell.row), cell.col))
    }

    fn active_value(&self) -> String {
        self.active().map_or_else(String::new, |cell| self.doc.cell_value(self.file_row(cell.row), cell.col).into_owned())
    }

    /// What a selected block adds up to; None for one cell.
    fn block_stats(&self) -> Option<BlockStats> {
        let selection = self.selection().filter(|_| !self.single())?;
        let key = (selection, self.version);
        if let Some((cached, stats)) = self.stats.borrow().as_ref()
            && *cached == key
        {
            return *stats;
        }
        let (top, bottom, left, right) = selection;
        let cells = (bottom - top + 1) as usize * (right - left + 1);
        let numbers = if cells > MAX_STAT_CELLS { None } else { self.doc.range_stats((top..=bottom).map(|row| self.file_row(row)), left, right) };
        let stats = Some(BlockStats { cells, numbers });
        *self.stats.borrow_mut() = Some((key, stats));
        stats
    }

    /// (cell name, value, detail), as the scene report prints them.
    #[cfg(feature = "scene")]
    fn status(&self) -> Option<(String, String, String)> {
        self.active()?;
        match self.block_stats() {
            None => Some((self.active_reference(), self.active_value(), String::new())),
            Some(stats) => {
                let detail = stats.numbers.map_or_else(String::new, |n| format!("Sum {} · Average {} · Count {}", format_sum(n.sum), format_average(n.average), grouped(n.count)));
                Some((self.active_reference(), format!("{} selected", count(stats.cells, "cell")), detail))
            }
        }
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

/// A cell as it is drawn: its text on one line, and how it reads.
struct ShownCell {
    text: SharedString,
    kind: CellKind,
    negative: bool,
}

/// Everything the painted rows need, read from the table before the frame.
struct Rows {
    palette: Palette,
    font: Font,
    /// The same face with tabular figures, for the cells that line up on the
    /// right: a column of numbers reads digit under digit.
    figures: Font,
    font_size: f32,
    row_height: f32,
    /// The letters and the header row: where the rows start.
    head_height: f32,
    gutter: f32,
    fill_width: f32,
    scroll: Point<f32>,
    /// (index on screen, file row, the visible cells).
    rows: Vec<(usize, u32, Vec<ShownCell>)>,
    columns: std::ops::Range<usize>,
    offsets: Vec<f32>,
    /// How many rows are shown in all, and how many the file has: the empty
    /// sheet starts under the first and is numbered from the second.
    shown: usize,
    file_rows: usize,
    selection: Option<(i64, i64, usize, usize)>,
    active: Option<Cell>,
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
        let (row_height, head) = (self.row_height, self.head_height);
        let line_height = px(row_height - 1.);
        let ellipsis = window.text_system().shape_line("…".into(), size, &[text_run("…".len(), &self.font, p.fg)], None).width;
        // Where the file's own columns and rows end, and the empty sheet begins.
        let data_right = self.gutter + self.offsets.last().copied().unwrap_or(0.) - self.scroll.x;
        let data_bottom = head + self.shown as f32 * row_height - self.scroll.y;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for (index, _, cells) in &self.rows {
                let y = head + *index as f32 * row_height - self.scroll.y;
                if y >= height || y + row_height <= 0. {
                    continue;
                }
                let row = *index as i64;
                let selected_row = self.selection.is_some_and(|(top, bottom, ..)| row >= top && row <= bottom);
                for (column, cell) in self.columns.clone().zip(cells) {
                    let x = self.gutter + self.offsets[column] - self.scroll.x;
                    let cell_width = self.offsets[column + 1] - self.offsets[column];
                    let here = Cell { row, col: column };
                    let active = self.active == Some(here);
                    // The block is tinted; the active cell stays clear inside its ring.
                    if !active && selected_row && self.selection.is_some_and(|(_, _, left, right)| column >= left && column <= right) {
                        window.paint_quad(fill(rect(x, y, cell_width, row_height), p.select));
                    }
                    window.paint_quad(fill(rect(x + cell_width - 1., y, 1., row_height), p.line));
                    window.paint_quad(fill(rect(x, y + row_height - 1., cell_width, 1.), p.line));
                    let editing = self.editing == Some(here);
                    if !cell.text.is_empty() && !editing {
                        // How a value reads. Display only: the file keeps what was typed.
                        let link = cell.kind == CellKind::Url;
                        let color = if cell.negative {
                            p.negative
                        } else if link {
                            p.accent
                        } else {
                            p.fg
                        };
                        let size = if cell.kind == CellKind::Boolean { size * 0.92 } else { size };
                        let font = if cell.kind.right_aligned() { &self.figures } else { &self.font };
                        let run = |len: usize| TextRun {
                            underline: link.then(|| UnderlineStyle { thickness: px(1.), color: Some(fade(p.accent, 0.45)), wavy: false }),
                            ..text_run(len, font, color)
                        };
                        let text = &cell.text;
                        let room = px((cell_width - 17.).max(0.));
                        let mut shaped = window.text_system().shape_line(text.clone(), size, &[run(text.len())], None);
                        if shaped.width > room {
                            let mut cut = shaped.closest_index_for_x((room - ellipsis).max(px(0.))).min(text.len());
                            while cut > 0 && !text.is_char_boundary(cut) {
                                cut -= 1;
                            }
                            let short: SharedString = format!("{}…", text[..cut].trim_end()).into();
                            shaped = window.text_system().shape_line(short.clone(), size, &[run(short.len())], None);
                        }
                        let text_width = f32::from(shaped.width);
                        let left = if cell.kind.right_aligned() {
                            x + cell_width - 9. - text_width
                        } else if cell.kind == CellKind::Boolean {
                            x + (cell_width - 1. - text_width) / 2.
                        } else {
                            x + 8.
                        };
                        let _ = shaped.paint(point(px(ox + left.max(x + 8.)), px(oy + y)), line_height, TextAlign::Left, None, window, cx);
                    }
                    if active && !editing {
                        // A 2px ring inside the cell's own box, its right and bottom gridlines included.
                        for (rx, ry, rw, rh) in [(x, y, cell_width, 2.), (x, y, 2., row_height), (x + cell_width - 2., y, 2., row_height), (x, y + row_height - 2., cell_width, 2.)] {
                            window.paint_quad(fill(rect(rx, ry, rw, rh), p.accent));
                        }
                    }
                }
                // The row carries on, fainter, to the edge of the window.
                if data_right < width {
                    window.paint_quad(fill(rect(data_right, y + row_height - 1., width - data_right, 1.), p.line_faint));
                }
            }
            // The empty sheet: columns out to the right edge, rows down to the bottom.
            let mut x = data_right + self.fill_width - 1.;
            while x < width {
                window.paint_quad(fill(rect(x, head, 1., height - head), p.line_faint));
                x += self.fill_width;
            }
            if data_bottom < height {
                let top = data_bottom.max(head);
                for column in self.columns.clone() {
                    let x = self.gutter + self.offsets[column + 1] - self.scroll.x - 1.;
                    window.paint_quad(fill(rect(x, top, 1., height - top), p.line_faint));
                }
                let mut y = top;
                while y < height {
                    window.paint_quad(fill(rect(self.gutter, y + row_height - 1., width - self.gutter, 1.), p.line_faint));
                    y += row_height;
                }
            }
            // The selected block's outline and the small square at its corner.
            if let Some((top, bottom, left, right)) = self.selection.filter(|(_, bottom, ..)| *bottom >= 0 && self.shown > 0)
                && left < self.offsets.len() - 1
            {
                let right = right.min(self.offsets.len() - 2);
                let (x0, x1) = (self.gutter + self.offsets[left] - self.scroll.x, self.gutter + self.offsets[right + 1] - self.scroll.x);
                let (y0, y1) = (head + top.max(0) as f32 * row_height - self.scroll.y, head + (bottom + 1) as f32 * row_height - self.scroll.y);
                let body = rect(self.gutter, head, (width - self.gutter).max(0.), (height - head).max(0.));
                window.with_content_mask(Some(ContentMask { bounds: body }), |window| {
                    if top != bottom || left != right {
                        // The header row is above this frame: a block that starts there is open at the top.
                        if top != HEADER {
                            window.paint_quad(fill(rect(x0, y0, x1 - x0, 1.), p.accent));
                        }
                        window.paint_quad(fill(rect(x0, y0, 1., y1 - y0), p.accent));
                        window.paint_quad(fill(rect(x1 - 1., y0, 1., y1 - y0), p.accent));
                        window.paint_quad(fill(rect(x0, y1 - 1., x1 - x0, 1.), p.accent));
                    }
                    if self.editing.is_none() {
                        window.paint_quad(fill(rect(x1 - 4., y1 - 4., 7., 7.), p.bg));
                        window.paint_quad(fill(rect(x1 - 3., y1 - 3., 5., 5.), p.accent));
                    }
                });
            }
            // The row numbers stay put while the cells scroll under them.
            let small = px(self.font_size * 0.85);
            let number = |label: String, y: f32, selected: bool, color: Hsla, window: &mut Window, cx: &mut App| {
                window.paint_quad(fill(rect(0., y, self.gutter, row_height), if selected { p.chrome_select } else { p.chrome }));
                window.paint_quad(fill(rect(self.gutter - 1., y, 1., row_height), p.line));
                window.paint_quad(fill(rect(0., y + row_height - 1., self.gutter, 1.), p.line));
                if selected {
                    window.paint_quad(fill(rect(self.gutter - 2., y, 2., row_height), p.accent));
                }
                let label: SharedString = label.into();
                let shaped = window.text_system().shape_line(label.clone(), small, &[text_run(label.len(), &self.font, color)], None);
                let _ = shaped.paint(point(px(ox + ((self.gutter - 1. - f32::from(shaped.width)) / 2.).round()), px(oy + y)), px(row_height), TextAlign::Left, None, window, cx);
            };
            for (index, file_row, _) in &self.rows {
                let y = head + *index as f32 * row_height - self.scroll.y;
                if y >= height || y + row_height <= 0. {
                    continue;
                }
                let row = *index as i64;
                let selected = self.selection.is_some_and(|(top, bottom, ..)| row >= top && row <= bottom);
                // The number is the row's line in the file, so it still names the row when sorted.
                number((file_row + 1).to_string(), y, selected, if selected { p.fg } else { p.muted }, window, cx);
            }
            // The empty rows are numbered on from the last line of the file.
            let (mut y, mut line) = (data_bottom.max(head), self.file_rows + 1);
            while data_bottom < height && y < height {
                number(line.to_string(), y, false, p.chrome_faint, window, cx);
                y += row_height;
                line += 1;
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
        let decimal_comma = self.doc.reads_decimal_comma();
        // The cell the formula bar is typing into shows what it has typed.
        let live = self.bar_edit.as_ref();
        let rows = self
            .visible_rows()
            .map(|index| {
                let file_row = self.order[index];
                let cells = columns
                    .clone()
                    .map(|c| {
                        let value = match live {
                            Some((cell, typed)) if cell.row == index as i64 && cell.col == c => std::borrow::Cow::Borrowed(typed.as_str()),
                            _ => self.doc.raw(file_row as usize, c).map_or(std::borrow::Cow::Borrowed(""), markie_core::csv_table::decode_field),
                        };
                        let shown = format_cell(&value, decimal_comma);
                        ShownCell { text: one_line(&shown.text), kind: shown.kind, negative: shown.negative }
                    })
                    .collect();
                (index, file_row, cells)
            })
            .collect();
        let mut figures = font.clone();
        figures.features = FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]));
        Rows {
            palette,
            font,
            figures,
            font_size: self.font_size(),
            row_height: self.row_height(),
            head_height: self.head_height(),
            gutter: self.gutter(),
            fill_width: self.fill_width(),
            scroll: self.scroll,
            rows,
            columns,
            offsets: self.offsets.clone(),
            shown: self.order.len(),
            file_rows: self.doc.row_count(),
            selection: self.selection(),
            active: self.active(),
            editing: self.editing.as_ref().map(|e| e.cell),
            thumbs: if self.scrollbars_shown() { self.thumbs() } else { (None, None) },
        }
    }
}

const SHEET_ICON: &str = r#"<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.6" stroke="COLOR" stroke-width="1.3"/><path d="M1.65 6.5h12.7M1.65 10h12.7M6 2.65v10.7" stroke="COLOR" stroke-width="1.3"/>"#;
const CORNER_ICON: &str = r#"<path d="M8 0v8H0z" fill="COLOR"/>"#;
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
                let no_row = self.selection().is_none_or(|(_, bottom, ..)| bottom == HEADER) || self.order.is_empty();
                let no_column = self.selection().is_none() || self.doc.column_count == 0;
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
        bar
    }

    /// The name box and the formula bar, under the toolbar: which cell is
    /// selected, and all of what it holds. Typing in the bar edits the cell.
    fn render_formula(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let reference = self.active_reference();
        if self.name_shown != reference && !self.name_input.read(cx).focus_handle(cx).is_focused(window) {
            self.name_input.update(cx, |state, cx| state.set_value(reference.clone(), window, cx));
            self.name_shown = reference;
        }
        // While a cell is open the bar shows what is being typed in it.
        let value = match &self.editing {
            Some(editing) => editing.input.read(cx).value().to_string(),
            None => self.active_value(),
        };
        // The bar is one line: a cell with a line break in it is edited in the cell.
        let field = self.editable() && self.active().is_some() && self.editing.is_none() && !value.contains(['\n', '\r']);
        if field && self.bar_edit.is_none() && self.formula_shown != value {
            self.formula_input.update(cx, |state, cx| state.set_value(value.clone(), window, cx));
            self.formula_shown = value.clone();
        }
        let size = px(13.);
        let content = if field {
            div()
                .id("csv-formula")
                .key_context(FORMULA_CONTEXT)
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .px(px(6.))
                .capture_action(cx.listener(|this, _: &kit::Escape, window, cx| {
                    if this.bar_edit.is_some() {
                        this.finish_bar_edit(false, None, true, window, cx);
                        cx.stop_propagation();
                    }
                }))
                .on_action(cx.listener(|this, _: &NextCell, window, cx| this.finish_bar_edit(true, Some(Direction::Right), true, window, cx)))
                .on_action(cx.listener(|this, _: &PreviousCell, window, cx| this.finish_bar_edit(true, Some(Direction::Left), true, window, cx)))
                .child(Input::new(&self.formula_input).appearance(false).xsmall().text_size(size))
                .into_any_element()
        } else {
            self.formula_shown.clear();
            div().flex_1().min_w_0().flex().items_center().px(px(10.)).child(div().min_w_0().truncate().child(one_line(&value))).into_any_element()
        };
        div()
            .flex()
            .flex_row()
            .flex_none()
            .w_full()
            .h(px(28.))
            .border_b_1()
            .border_color(p.line)
            .bg(p.bg)
            .text_color(p.fg)
            .text_size(size)
            .child(div().flex().flex_none().items_center().w(px(76.)).px(px(4.)).border_r_1().border_color(p.line).child(Input::new(&self.name_input).appearance(false).xsmall().text_size(size)))
            .child(div().flex().flex_none().items_center().px(px(9.)).border_r_1().border_color(p.line).text_color(p.muted).font_family("Georgia").italic().child("fx"))
            .child(content)
    }

    /// The sheet tab and the status bar: the file's name as the one sheet,
    /// how big it is, and what the selected block adds up to.
    fn render_foot(&self, p: &Palette) -> Div {
        let part = |text: String| div().flex().flex_none().items_center().whitespace_nowrap().child(text);
        let icon = svg_image(&SHEET_ICON.replace("COLOR", &super::dialog_chrome::css(p.accent)), 16., 16., 12., 12.);
        let mut foot = div()
            .flex()
            .flex_row()
            .flex_none()
            .w_full()
            .h(px(28.))
            .gap(px(14.))
            .pr(px(12.))
            .overflow_hidden()
            .border_t_1()
            .border_color(p.line)
            .bg(p.bar)
            .text_color(p.muted)
            .text_size(px(12.))
            .child(
                // The one sheet: a tab hanging from the grid, as in Excel and Numbers.
                div().flex().flex_shrink(1.).min_w_0().max_w(px(300.)).pl(px(10.)).child(
                    div()
                        .relative()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .min_w_0()
                        .pl(px(10.))
                        .pr(px(12.))
                        .bg(p.bg)
                        .border_l_1()
                        .border_r_1()
                        .border_color(p.line)
                        .text_color(p.fg)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(icon)
                        .child(div().min_w_0().truncate().child(sheet_name(self.name.as_deref())))
                        .child(div().absolute().left_0().right_0().bottom_0().h(px(2.)).bg(p.accent)),
                ),
            )
            .child(part(self.summary()))
            .child(div().flex_1().min_w_0());
        let table = !self.text_view;
        if let Some(stats) = self.block_stats().filter(|_| table) {
            let figure = |label: &'static str, value: String| div().flex().flex_none().items_center().gap(px(5.)).whitespace_nowrap().child(label).child(div().text_color(p.fg).font_weight(FontWeight::SEMIBOLD).child(value));
            foot = match stats.numbers {
                Some(n) => foot.child(figure("Sum", format_sum(n.sum))).child(figure("Average", format_average(n.average))).child(figure("Count", grouped(n.count))),
                None => foot.child(part(format!("{} selected", count(stats.cells, "cell")))),
            };
        }
        if table && self.matched > MAX_SHOWN_ROWS {
            foot = foot.child(part(format!("Showing the first {} rows", grouped(MAX_SHOWN_ROWS))));
        }
        let view_only = if table && (self.sort.is_some() || self.filtered()) { " · view only, the file keeps its order" } else { "" };
        foot.child(part(format!("{}{view_only}", delimiter_name(self.doc.delimiter))))
    }

    /// The sheet tab under the file's text, for the host that draws the text.
    pub(super) fn foot(&self, cx: &App) -> Div {
        self.render_foot(&Palette::current(cx))
    }

    /// What stays put above the rows: the strip of column letters, and under
    /// it the header row, bold and filled, with a heavier rule below.
    fn render_head(&self, p: &Palette, cx: &mut Context<Self>) -> Div {
        let (row, letters, gutter, scroll, fill) = (self.row_height(), self.letter_height(), self.gutter(), self.scroll.x, self.fill_width());
        let header_on = self.header_on();
        let selection = self.selection();
        let active = self.active();
        let editing = self.editing.as_ref().map(|e| e.cell);
        let view_width = self.view_size().width;
        let data_right = gutter + self.offsets.last().copied().unwrap_or(0.) - scroll;
        let small = px(self.font_size() * 0.85);
        let in_columns = |column: usize| selection.is_some_and(|(_, _, left, right)| column >= left && column <= right);
        let mut head = div().absolute().top_0().left_0().w_full().h(px(self.head_height())).overflow_hidden();

        // ---- the letters. With no header row they are the header: they name the columns and sort them.
        let letter_hover = mix(p.fg, 0.09, p.bg);
        for column in self.visible_columns() {
            let selected = in_columns(column);
            let name = column_letter(column);
            let group: SharedString = format!("csv-letter-{column}").into();
            let mut letter = div()
                .id(("csv-letter", column))
                .group(group.clone())
                .absolute()
                .top_0()
                .left(px(gutter + self.offsets[column] - scroll))
                .w(px(self.widths[column]))
                .h(px(letters))
                .flex()
                .items_center()
                .justify_center()
                .border_r_1()
                .border_b_1()
                .border_color(p.line)
                .text_size(small)
                .map(|el| {
                    if selected {
                        el.bg(p.chrome_select).text_color(p.fg).font_weight(FontWeight::SEMIBOLD)
                    } else {
                        el.bg(p.chrome).text_color(p.muted).font_weight(FontWeight::MEDIUM).hover(move |s| s.bg(letter_hover))
                    }
                })
                .on_mouse_down(MouseButton::Left, cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    if this.editing.is_some() {
                        this.finish_editing(true, None, false, window, cx);
                    }
                    this.focus.focus(window, cx);
                    this.pick_column(column, event.modifiers.shift, cx);
                    cx.stop_propagation();
                }))
                .child(name.clone())
                .when(selected, |el| el.child(div().absolute().left_0().right_0().bottom_0().h(px(2.)).bg(p.accent)));
            if !header_on {
                let sorted = self.sort.filter(|s| s.column == column).map(|s| s.direction);
                let tip: SharedString = format!("Sort column {name}").into();
                letter = letter.child(
                    div()
                        .id(("csv-letter-sort", column))
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(px(5.))
                        .w(px(14.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .map(|el| match sorted {
                            Some(_) => el.text_color(p.accent).text_size(small * 0.7),
                            None => el.text_color(p.muted).opacity(0.).group_hover(group, |s| s.opacity(1.)),
                        })
                        .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.toggle_sort(column, cx);
                            this.focus.focus(window, cx);
                        }))
                        .child(match sorted {
                            Some(SortDirection::Asc) => "▲",
                            Some(SortDirection::Desc) => "▼",
                            None => "↕",
                        }),
                );
            }
            head = head.child(letter);
        }
        // The letters carry on over the empty sheet.
        let (mut x, mut index) = (data_right, self.columns());
        while x < view_width {
            head = head.child(
                div().absolute().top_0().left(px(x)).w(px(fill)).h(px(letters)).flex().items_center().justify_center().bg(p.chrome).border_r_1().border_b_1().border_color(p.line_faint).text_size(small).font_weight(FontWeight::MEDIUM).text_color(p.chrome_faint).child(column_letter(index)),
            );
            x += fill;
            index += 1;
        }

        // ---- the header row
        if header_on {
            head = head.child(div().absolute().top(px(letters)).left_0().w_full().h(px(row)).bg(p.head).border_b_2().border_color(p.rule));
            let hover = fade(p.fg, 0.06);
            let live = self.bar_edit.as_ref().filter(|(cell, _)| cell.row == HEADER);
            for column in self.visible_columns() {
                let numeric = self.numeric.get(column).copied().unwrap_or(false);
                let label = match live {
                    Some((cell, typed)) if cell.col == column => typed.clone(),
                    _ => self.header_label(column),
                };
                let tip: SharedString = if label.is_empty() { "Click to sort".into() } else { format!("{}: click to sort", one_line(&label)).into() };
                let mark = self.sort.filter(|s| s.column == column).map(|s| if s.direction == SortDirection::Asc { "▲" } else { "▼" });
                let here = Cell { row: HEADER, col: column };
                let selected = selection.is_some_and(|(top, ..)| top == HEADER) && in_columns(column);
                let is_active = active == Some(here);
                let hidden = editing == Some(here);
                head = head.child(
                    div()
                        .id(("csv-th", column))
                        .absolute()
                        .top(px(letters))
                        .left(px(gutter + self.offsets[column] - scroll))
                        .w(px(self.widths[column]))
                        .h(px(row))
                        .flex()
                        .border_r_1()
                        .border_b_2()
                        .border_color(if is_active { p.accent } else { p.line })
                        .bg(if selected && !is_active { p.head_select } else { p.head })
                        .font_weight(FontWeight::SEMIBOLD)
                        .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                        .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| this.head_click(column, event.click_count(), window, cx)))
                        .child(
                            div()
                                .flex()
                                .flex_1()
                                .min_w_0()
                                .items_center()
                                .gap(px(4.))
                                .px(px(8.))
                                .hover(move |s| s.bg(hover))
                                .when(numeric, |el| el.flex_row_reverse())
                                .when(!hidden, |el| el.child(div().min_w_0().truncate().child(one_line(&label))))
                                .children(mark.map(|m| div().flex_none().text_color(p.accent).text_size(px(self.font_size() * 0.62)).child(m))),
                        )
                        // The rule under the header is the row's own, whatever the cell's side line is.
                        .when(!is_active, |el| el.child(div().absolute().left_0().right(px(-1.)).bottom(px(-2.)).h(px(2.)).bg(p.rule)))
                        .when(is_active && !hidden, |el| el.child(div().absolute().inset_0().border_l_2().border_t_2().border_r_1().border_color(p.accent))),
                );
            }
            // The header row carries on over the empty sheet.
            let mut x = data_right + fill - 1.;
            while x < view_width {
                head = head.child(div().absolute().top(px(letters)).left(px(x)).w(px(1.)).h(px(row - 2.)).bg(p.line_faint));
                x += fill;
            }
        }

        // The resize handles sit over the line between two columns: drag to size, double click to fit.
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
                    .h(px(self.head_height()))
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

        // ---- the gutter's part: the select-all corner, and the header row's number
        let corner = svg_image(&CORNER_ICON.replace("COLOR", &super::dialog_chrome::css(mix(p.muted, 0.55, p.chrome))), 8., 8., 8., 8.);
        head = head.child(
            div()
                .id("csv-corner")
                .absolute()
                .top_0()
                .left_0()
                .w(px(gutter))
                .h(px(letters))
                .bg(p.chrome)
                .border_r_1()
                .border_b_1()
                .border_color(p.line)
                .occlude()
                .tooltip(|window, cx| Tooltip::new("Select all").build(window, cx))
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
                    this.focus.focus(window, cx);
                    this.select_all(cx);
                    cx.stop_propagation();
                }))
                .child(div().absolute().right(px(3.)).bottom(px(3.)).child(corner)),
        );
        if header_on {
            let selected = selection.is_some_and(|(top, ..)| top == HEADER);
            head = head.child(
                div()
                    .id("csv-header-number")
                    .absolute()
                    .top(px(letters))
                    .left_0()
                    .w(px(gutter))
                    .h(px(row))
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(if selected { p.chrome_select } else { p.chrome })
                    .border_r_1()
                    .border_color(p.line)
                    .text_size(small)
                    .text_color(if selected { p.fg } else { p.muted })
                    .font_weight(if selected { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                    .occlude()
                    .on_mouse_down(MouseButton::Left, cx.listener(|this, event: &MouseDownEvent, window, cx| {
                        this.focus.focus(window, cx);
                        this.pick_row(HEADER, event.modifiers.shift, cx);
                        cx.stop_propagation();
                    }))
                    // The header row is line 1 of the file.
                    .child("1")
                    .child(div().absolute().left_0().right(px(-1.)).bottom_0().h(px(2.)).bg(p.rule))
                    .when(selected, |el| el.child(div().absolute().top_0().right_0().bottom_0().w(px(2.)).bg(p.accent))),
            );
        }
        head
    }

    fn head_click(&mut self, column: usize, clicks: usize, window: &mut Window, cx: &mut Context<Self>) {
        if clicks <= 1 {
            self.toggle_sort(column, cx);
            self.focus.focus(window, cx);
        } else if clicks == 2 && self.header_on() && self.editable() {
            self.sort = self.sort_before_click;
            self.recompute_view();
            let cell = Cell { row: HEADER, col: column };
            self.select(cell, cell);
            self.start_editing(cell, None, window, cx);
        }
    }

    /// Where a cell is in the grid: (left, top, width).
    fn cell_rect(&self, cell: Cell) -> (f32, f32, f32) {
        let left = self.gutter() + self.offsets.get(cell.col).copied().unwrap_or(0.) - self.scroll.x;
        let top = if cell.row == HEADER { self.letter_height() } else { self.head_height() + cell.row as f32 * self.row_height() - self.scroll.y };
        (left, top, self.widths.get(cell.col).copied().unwrap_or(96.))
    }

    fn render_editor(&self, p: &Palette, cx: &mut Context<Self>) -> Option<Div> {
        let editing = self.editing.as_ref()?;
        let (left, top, width) = self.cell_rect(editing.cell);
        let (row, size) = (self.row_height(), self.font_size());
        let line = size * 1.25;
        let input = editing.input.clone();
        // As in a spreadsheet, the editor grows over the cells to its right as the text does.
        let longest = editing.input.read(cx).value().split('\n').map(|line| line.chars().count()).max().unwrap_or(0).min(90);
        let width = width.max((longest as f32 + 3.) * size * 0.56).min((self.view_size().width - left).max(width));
        Some(
            div()
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(width.max(120.)))
                .min_h(px(row))
                .border_2()
                .border_color(p.accent)
                .bg(p.bg)
                .text_color(p.fg)
                .shadow(vec![shadow(fade(black(), 0.22), 0., 4., 14.)])
                // `padding: … 6px` less GPUI Kit's own 4 px inset.
                .px(px(2.))
                .py(px(((row - line - 4.) / 2.).max(0.)))
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
            div().absolute().top(px(self.head_height() + self.row_height())).left_0().w_full().px(px(16.)).py(px(18.)).flex().justify_center().text_color(p.muted).text_size(px(13.)).child(message)
        });
        // The whole of a long cell shows while the pointer rests on it.
        let tip = self.hover.filter(|_| self.drag.is_none() && self.editing.is_none()).and_then(|cell| {
            let value = self.doc.cell_value(self.file_row(cell.row), cell.col);
            let (left, top, width) = self.cell_rect(cell);
            if value.chars().count() as f32 * 7. <= width - 16. {
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
        let formula = self.render_formula(&p, window, cx);
        root.h_full().min_h_0().child(formula).child(self.render_grid(p, font, cx)).child(self.render_foot(&p))
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
        // The other corner of a block: `cursor` is then its active cell.
        if let Some((row, col)) = pair("anchor") {
            let active = self.cursor;
            self.cursor = Some(Cell { row, col: col as usize });
            self.anchor = active;
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
            } else if let Some(reference) = step.get("jump").and_then(Value::as_str) {
                // The name box: a cell's name and Enter.
                if !self.jump(reference, cx) {
                    eprintln!("markie-rs scene: no cell {reference}");
                }
            } else if let Some(text) = step.get("bar").and_then(Value::as_str) {
                // The formula bar: focus it, type, Enter.
                self.begin_bar_edit(window, cx);
                if let Some((_, typed)) = self.bar_edit.as_mut() {
                    *typed = text.to_string();
                }
                self.finish_bar_edit(true, Some(Direction::Down), false, window, cx);
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
                    "sort" => self.toggle_sort(self.active().map_or(0, |c| c.col), cx),
                    "select-column" => {
                        self.pick_column(self.active().map_or(0, |c| c.col), false, cx);
                        self.drag = None;
                    }
                    "select-row" => {
                        self.pick_row(self.active().map_or(0, |c| c.row), false, cx);
                        self.drag = None;
                    }
                    _ => eprintln!("markie-rs scene: unknown csv op {op}"),
                }
            }
        }
        if args.get("edit").and_then(Value::as_bool).unwrap_or(false)
            && let Some(active) = self.active()
        {
            self.start_editing(active, None, window, cx);
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
                    "reference": self.active_reference(),
                    "formula": self.active_value(),
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
