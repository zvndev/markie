//! CSV documents as Electron opens them (page.tsx, `src/lib/csv.ts`).
//!
//! An open CSV or TSV is held as the text it is on disk and shown by the
//! table in `csv_table.rs`, over the lossless model in
//! `markie_core::csv_table`. View is the table and Source is the file's own
//! text, in the source editor: that editor only knows "\n", so it is given
//! plain lines, and what it hands back gets the file's line ending again.
//!
//! The CSV and GFM table conversions below are for the two crossings between
//! the formats: a Markdown document saved as `.csv` keeps its first table,
//! and a CSV saved under another name is the Markdown table of the same rows.

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::component::input::Editor;
use gpui_kit::*;

use markie_core::csv::serialize;
use markie_core::csv_table::{CsvDocument, plain_editor_text, restore_text_shape};
use markie_core::formats::FormatKind;

use super::csv_table::{CsvEvent, CsvTable};
use super::{DocKind, Mode, OpenDoc, SOURCE_LINE_HEIGHT, Workspace, doc_toolbar, text_view};

impl Workspace {
    pub(super) fn new_csv(window: &mut Window, cx: &mut Context<Self>) -> (Entity<CsvTable>, Subscription) {
        let table = cx.new(|cx| CsvTable::new(window, cx));
        let subscription = cx.subscribe_in(&table, window, |this, _, event: &CsvEvent, window, cx| match event {
            CsvEvent::Edited => this.note_edit(cx),
            CsvEvent::ShowTable => this.set_mode(Mode::View, window, cx),
            CsvEvent::ShowText => this.set_mode(Mode::Source, window, cx),
            CsvEvent::Find => this.csv_find(Box::new(gpui_kit::component::input::Search), window, cx),
        });
        (table, subscription)
    }

    /// A CSV or TSV is open as text (never an Office or failed document).
    pub(super) fn is_csv_doc(&self) -> bool {
        matches!(self.doc.as_ref(), Some(OpenDoc { format: FormatKind::Csv, kind: DocKind::Text { .. }, .. }))
    }

    pub(super) fn focus_csv(&self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = self.csv.read(cx).focus_handle();
        handle.focus(window, cx);
    }

    /// The table is what shows.
    pub(super) fn csv_table_active(&self) -> bool {
        self.is_csv_doc() && self.mode == Mode::View
    }

    /// An open CSV's text as it would be saved: the table's, or the Text
    /// view's lines in the file's own shape. None when no CSV is open.
    pub(super) fn csv_current_text(&self, cx: &App) -> Option<String> {
        if !self.is_csv_doc() {
            return None;
        }
        Some(if self.mode == Mode::View {
            self.csv.read(cx).text().to_string()
        } else {
            restore_text_shape(&self.csv_text_base, &self.editor.read(cx).value())
        })
    }

    /// The document's text was replaced from outside its editors (a reload,
    /// a restored version or draft). Returns what the source editor shows:
    /// for a CSV, plain lines, with the table following the new text.
    pub(super) fn editor_text(&mut self, text: &str, cx: &mut Context<Self>) -> String {
        if !self.is_csv_doc() {
            return text.to_string();
        }
        self.csv_text_base = text.to_string();
        self.csv.update(cx, |table, cx| table.replace_text(text, cx));
        plain_editor_text(text)
    }

    /// The Table / Text switch (and ⌘1, ⌘2, ⌘E on a CSV).
    pub(super) fn csv_set_mode(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        match mode {
            Mode::Source => {
                let text = self.csv.read(cx).text();
                self.csv_text_base = text.to_string();
                let plain = plain_editor_text(&text);
                if self.editor.read(cx).value().as_ref() as &str != plain.as_str() {
                    // The editor's change event for this is not an edit.
                    self.split_echo = Some(plain.clone());
                    self.editor.update(cx, |state, cx| state.set_value(plain, window, cx));
                }
                self.mode = Mode::Source;
                self.focus_editor(window, cx);
            }
            Mode::View => {
                let text = restore_text_shape(&self.csv_text_base, &self.editor.read(cx).value());
                if *self.csv.read(cx).text() != *text {
                    self.csv.update(cx, |table, cx| table.replace_text(&text, cx));
                }
                self.split_echo = None;
                self.mode = Mode::View;
                self.focus_csv(window, cx);
            }
            Mode::Split => return,
        }
        cx.notify();
    }

    /// Find works on text, so it brings a CSV's text forward, then opens the
    /// source editor's own find (or find and replace).
    pub(super) fn csv_find(&mut self, action: Box<dyn Action>, window: &mut Window, cx: &mut Context<Self>) {
        self.set_mode(Mode::Source, window, cx);
        cx.spawn_in(window, async move |this, cx| {
            // The editor has to be in a drawn frame before it can take the command.
            cx.background_executor().timer(std::time::Duration::from_millis(60)).await;
            this.update_in(cx, |this, window, cx| {
                if this.is_csv_doc() && this.mode == Mode::Source {
                    this.focus_editor(window, cx);
                    window.dispatch_action(action, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// The CSV pane: the table, or its bar over the file's text. `large` is
    /// the size of a file in the large tier, which says so above the table.
    pub(super) fn render_csv(&self, large: Option<usize>, untitled: bool, cx: &mut Context<Self>) -> AnyElement {
        let text_view = self.mode != Mode::View;
        let (zoom, read_only) = (self.zoom, !self.doc_editable());
        self.csv.update(cx, |table, _| {
            table.set_zoom(zoom);
            table.set_text_view(text_view);
            table.set_read_only(read_only);
        });
        let theme = cx.theme().clone();
        let mut pane = div().size_full().flex().flex_col().bg(theme.background);
        if let Some(bytes) = large {
            pane = pane.child(text_view::large_strip(bytes, cx));
        }
        // A new, unsaved CSV is in Electron's documents workspace, under its toolbar row.
        if untitled {
            pane = pane.child(self.text_toolbar(cx));
        }
        if !text_view {
            return pane.child(div().flex_1().min_h_0().child(self.csv.clone())).into_any_element();
        }
        self.source_column.clear(&self.editor, cx);
        let editor = if untitled {
            let pad = px(64.);
            div()
                .size_full()
                .pl(pad - doc_toolbar::EDITOR_INSET.0)
                .pt(pad - doc_toolbar::EDITOR_INSET.2)
                .child(
                    Editor::new(&self.editor)
                        .bordered(false)
                        .h(relative(1.))
                        .font_family(doc_toolbar::font_family(&theme.mono_font_family))
                        .text_size(px(doc_toolbar::font_size() * self.zoom))
                        .line_height(relative(1.85)),
                )
                .into_any_element()
        } else {
            self.source_mouse(
                Editor::new(&self.editor)
                    .bordered(false)
                    .h(relative(1.))
                    .font_family(markie_editor::MONO)
                    .text_size(px(14. * self.zoom))
                    .line_height(relative(SOURCE_LINE_HEIGHT)),
                cx,
            )
            .into_any_element()
        };
        pane.child(self.csv.clone()).child(div().flex_1().min_h_0().child(editor)).into_any_element()
    }
}

/// What Save As and Save a Copy write (page.tsx `handleSaveAs`). An open CSV
/// is already CSV: under a `.csv` name it is written as it is, and under any
/// other name as the Markdown table of the same rows. A Markdown document
/// saved as `.csv` keeps its first table.
pub(super) fn save_as_text(text: &str, from_csv: bool, as_csv: bool) -> String {
    match (from_csv, as_csv) {
        (true, false) => csv_to_markdown_table(text),
        (false, true) => markdown_table_to_csv(text),
        _ => text.to_string(),
    }
}

fn cell_to_markdown(cell: &str) -> String {
    cell.replace('|', "\\|").replace("\r\n", " ").replace('\n', " ")
}

fn markdown_to_cell(cell: &str) -> String {
    cell.replace("\\|", "|")
}

/// `csvToMarkdownTable`.
pub(super) fn csv_to_markdown_table(csv: &str) -> String {
    // The file's own delimiter (comma, semicolon, tab), not always a comma.
    let doc = CsvDocument::parse(csv, None);
    let rows: Vec<Vec<String>> = (0..doc.row_count())
        .map(|r| (0..doc.row_len(r)).map(|c| doc.cell_value(r, c).into_owned()).collect::<Vec<String>>())
        .filter(|r| !(r.len() == 1 && r[0].is_empty()))
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let norm = |r: &Vec<String>| {
        let mut cells: Vec<String> = r.iter().map(|c| cell_to_markdown(c)).collect();
        cells.resize(cols, String::new());
        format!("| {} |", cells.join(" | "))
    };
    let mut lines = vec![norm(&rows[0]), format!("| {} |", vec!["---"; cols].join(" | "))];
    lines.extend(rows[1..].iter().map(norm));
    lines.join("\n") + "\n"
}

fn is_delimiter(cell: &str) -> bool {
    let c = cell.strip_prefix(':').unwrap_or(cell);
    let c = c.strip_suffix(':').unwrap_or(c);
    !c.is_empty() && c.chars().all(|ch| ch == '-')
}

/// `markdownTableToCSV`: the first pipe table only.
pub(super) fn markdown_table_to_csv(markdown: &str) -> String {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut in_table = false;
    for line in markdown.split('\n') {
        let is_row = line.trim().starts_with('|');
        if !in_table && is_row {
            in_table = true;
        }
        if !in_table {
            continue;
        }
        if !is_row {
            break;
        }
        let t = line.trim();
        let t = t.strip_prefix('|').unwrap_or(t);
        let t = t.strip_suffix('|').unwrap_or(t);
        let mut cells = Vec::new();
        let mut current = String::new();
        let mut escaped = false;
        for ch in t.chars() {
            if escaped {
                current.push('\\');
                current.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '|' {
                cells.push(current.trim().to_string());
                current.clear();
            } else {
                current.push(ch);
            }
        }
        cells.push(current.trim().to_string());
        if cells.iter().all(|c| is_delimiter(c)) {
            continue;
        }
        rows.push(cells.iter().map(|c| markdown_to_cell(c)).collect());
    }
    serialize(&rows)
}

/// `csvDropsContent`: lines a CSV save leaves out, and whether there was a table.
pub(super) fn csv_drops_content(markdown: &str) -> (usize, bool) {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let start = lines.iter().position(|l| l.trim().starts_with('|'));
    let Some(start) = start else {
        return (lines.iter().filter(|l| !l.trim().is_empty()).count(), false);
    };
    let end = lines[start + 1..].iter().position(|l| !l.trim().starts_with('|')).map_or(lines.len(), |i| start + 1 + i);
    let dropped = lines.iter().enumerate().filter(|(i, l)| !(start..end).contains(i) && !l.trim().is_empty()).count();
    (dropped, true)
}

/// The banner a manual CSV save shows, when it left something out.
pub(super) fn csv_save_note(markdown: &str) -> Option<String> {
    let (dropped, has_table) = csv_drops_content(markdown);
    if dropped == 0 {
        return None;
    }
    Some(if has_table {
        format!("Saved as CSV: {dropped} line{} outside the first table are not in that file.", if dropped == 1 { "" } else { "s" })
    } else {
        "Saved as CSV: this document has no table, so the file is empty.".into()
    })
}

#[cfg(test)]
mod tests {
    use super::{csv_drops_content, csv_save_note, csv_to_markdown_table, markdown_table_to_csv, save_as_text};

    #[test]
    fn save_as_crosses_between_the_formats_only_when_the_name_does() {
        let csv = "a;b\r\n1;\"x; y\"\r\n";
        // An open CSV saved as CSV is the same text, untouched.
        assert_eq!(save_as_text(csv, true, true), csv);
        // Under another name it is the Markdown table of the same rows, read with the file's own delimiter.
        assert_eq!(save_as_text(csv, true, false), "| a | b |\n| --- | --- |\n| 1 | x; y |\n");
        // A Markdown document saved as .csv keeps its first table.
        assert_eq!(save_as_text("# T\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", false, true), "a,b\n1,2\n");
        assert_eq!(save_as_text("plain", false, false), "plain");
    }

    /// Electron's own outputs on the same inputs
    /// (`rust/scripts/parity/source-cases.mjs`).
    #[test]
    fn source_conversions_match_electron() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/source_electron.json")).unwrap();
        let mut bad = Vec::new();
        for c in fixture["formatTables"].as_array().unwrap() {
            let (i, o) = (c["in"].as_str().unwrap(), c["out"].as_str().unwrap());
            let mine = markie_core::format_tables::format_markdown_tables(i);
            if mine != o {
                bad.push(format!("formatMarkdownTables {i:?}\n  electron {o:?}\n  rs       {mine:?}"));
            }
        }
        for c in fixture["csvToMarkdown"].as_array().unwrap() {
            let (i, o) = (c["in"].as_str().unwrap(), c["out"].as_str().unwrap());
            let mine = csv_to_markdown_table(i);
            if mine != o {
                bad.push(format!("csvToMarkdownTable {i:?}\n  electron {o:?}\n  rs       {mine:?}"));
            }
        }
        for c in fixture["markdownToCsv"].as_array().unwrap() {
            let (i, o) = (c["in"].as_str().unwrap(), c["out"].as_str().unwrap());
            let mine = markdown_table_to_csv(i);
            if mine != o {
                bad.push(format!("markdownTableToCSV {i:?}\n  electron {o:?}\n  rs       {mine:?}"));
            }
            let d = &c["drops"];
            let (lines, table) = csv_drops_content(i);
            if (lines as u64, table) != (d["droppedLines"].as_u64().unwrap(), d["hasTable"].as_bool().unwrap()) {
                bad.push(format!("csvDropsContent {i:?}: electron {d}, rs ({lines}, {table})"));
            }
        }
        for c in fixture["stats"].as_array().unwrap() {
            let i = c["in"].as_str().unwrap();
            let o = &c["out"];
            let s = markie_core::stats::compute(i);
            let mine = [s.words, s.chars, s.chars_no_spaces, s.lines, s.headings, s.code_blocks, s.links, s.reading_minutes];
            let theirs = ["words", "chars", "charsNoSpaces", "lines", "headings", "codeBlocks", "links", "readingTimeMin"]
                .map(|k| o[k].as_u64().unwrap() as usize);
            if mine != theirs {
                bad.push(format!("computeStats {i:?}: electron {theirs:?}, rs {mine:?}"));
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }

    #[test]
    fn csv_becomes_a_pipe_table() {
        assert_eq!(csv_to_markdown_table("a,b\n1,2\n3\n"), "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |\n");
        assert_eq!(csv_to_markdown_table("x|y,\"multi\nline\"\n"), "| x\\|y | multi line |\n| --- | --- |\n");
        assert_eq!(csv_to_markdown_table(""), "");
        assert_eq!(csv_to_markdown_table("\n\n"), "");
    }

    #[test]
    fn the_first_table_goes_back_to_csv() {
        let md = "| name | note |\n| :--- | ---: |\n| Ann | a\\|b |\n| Bo | \"q\", here |\n\ntext\n| later | table |\n";
        assert_eq!(markdown_table_to_csv(md), "name,note\nAnn,a|b\nBo,\"\"\"q\"\", here\"\n");
    }

    #[test]
    fn round_trip_keeps_cells() {
        let csv = "id,city,amount\n1,\"Paris, FR\",3.5\n2,Oslo,\n";
        assert_eq!(markdown_table_to_csv(&csv_to_markdown_table(csv)), csv);
    }

    #[test]
    fn saving_says_what_was_left_out() {
        assert_eq!(csv_save_note("| a |\n| --- |\n| 1 |\n"), None);
        assert_eq!(csv_save_note("# Title\n| a |\n| --- |\n"), Some("Saved as CSV: 1 line outside the first table are not in that file.".into()));
        assert_eq!(csv_save_note("one\ntwo\n"), Some("Saved as CSV: this document has no table, so the file is empty.".into()));
    }
}
