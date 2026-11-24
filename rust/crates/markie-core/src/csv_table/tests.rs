//! Electron's `src/lib/csv-table.test.ts`, test for test, over the same
//! fixtures (`src/lib/csv-fixtures.ts`): every shape that an editor is
//! tempted to "tidy". The fixture texts are generated from that file with
//! every control and non-ASCII character escaped, so no tool that touches
//! this file can change a line ending or drop a BOM.

use super::*;
use crate::formats::{TextEncoding, decode_text, encode_text};

struct Fixture {
    name: &'static str,
    file: &'static str,
    text: &'static str,
    delimiter: char,
    rows: usize,
    columns: usize,
}

const FIXTURES: [Fixture; 19] = [
    Fixture { name: "plain, trailing newline", file: "plain.csv", text: "name,qty,price\nApple,3,1.20\nPear,12,0.85\n", delimiter: ',', rows: 3, columns: 3 },
    Fixture { name: "no trailing newline", file: "no-newline.csv", text: "name,qty\nApple,3\nPear,12", delimiter: ',', rows: 3, columns: 2 },
    Fixture { name: "quoted newlines", file: "quoted-newlines.csv", text: "id,note\n1,\"line one\nline two\"\n2,\"a\r\nb\"\n3,plain\n", delimiter: ',', rows: 4, columns: 2 },
    Fixture { name: "embedded quotes", file: "embedded-quotes.csv", text: "id,quote\n1,\"She said \"\"hi\"\"\"\n2,\"\"\"\"\n3,\"a,b\"\n4,5\" pipe\n", delimiter: ',', rows: 5, columns: 2 },
    Fixture { name: "empty trailing cells", file: "empty-trailing.csv", text: "a,b,c,d\n1,,,\n,,,\n2,x,,\n", delimiter: ',', rows: 4, columns: 4 },
    Fixture { name: "ragged rows", file: "ragged.csv", text: "a,b,c\n1\n1,2\n1,2,3,4,5\n\n9,8,7\n", delimiter: ',', rows: 6, columns: 5 },
    Fixture { name: "BOM", file: "bom.csv", text: "\u{feff}name,city\nZo\u{eb},K\u{f6}ln\nJos\u{e9},S\u{e3}o Paulo\n", delimiter: ',', rows: 3, columns: 2 },
    Fixture { name: "CRLF", file: "crlf.csv", text: "name,qty\r\nApple,3\r\nPear,12\r\n", delimiter: ',', rows: 3, columns: 2 },
    Fixture { name: "CRLF, BOM, no trailing newline", file: "excel.csv", text: "\u{feff}name,qty\r\nApple,3\r\nPear,12", delimiter: ',', rows: 3, columns: 2 },
    Fixture { name: "semicolon, decimal commas (European)", file: "european.csv", text: "Artikel;Menge;Preis\r\nApfel;3;1,20\r\nBirne;12;0,85\r\n\"K\u{e4}se; alt\";1;12,50\r\n", delimiter: ';', rows: 4, columns: 3 },
    Fixture { name: "tab separated", file: "data.tsv", text: "name\tqty\tnote\nApple\t3\thas, comma\nPear\t12\t\"has\ttab\"\n", delimiter: '\t', rows: 3, columns: 3 },
    Fixture { name: "every field quoted", file: "quote-all.csv", text: "\"name\",\"qty\"\n\"Apple\",\"3\"\n\"Pear\",\"12\"\n", delimiter: ',', rows: 3, columns: 2 },
    Fixture { name: "mixed line endings", file: "mixed-eol.csv", text: "a,b\r\n1,2\n3,4\r5,6\r\n", delimiter: ',', rows: 4, columns: 2 },
    Fixture { name: "blank lines and spaces", file: "blank-lines.csv", text: "a,b\n\n 1 , 2 \n\n\n3,4\n\n", delimiter: ',', rows: 7, columns: 2 },
    Fixture { name: "malformed quotes", file: "malformed.csv", text: "a,b\n\"open,1\n2,\"x\"y,z\n3,\"never closed\n", delimiter: ',', rows: 3, columns: 2 },
    Fixture { name: "one column", file: "one-column.csv", text: "name\nApple\nPear\n", delimiter: ',', rows: 3, columns: 1 },
    Fixture { name: "pipe separated", file: "pipes.csv", text: "a|b|c\n1|2|3\n4|5|6\n", delimiter: '|', rows: 3, columns: 3 },
    Fixture { name: "empty file", file: "empty.csv", text: "", delimiter: ',', rows: 0, columns: 0 },
    Fixture { name: "only a newline", file: "newline.csv", text: "\n", delimiter: ',', rows: 1, columns: 1 },
];

fn open(text: &str) -> CsvDocument {
    CsvDocument::parse(text, Some("file.csv"))
}

fn fixture(file: &str) -> &'static Fixture {
    FIXTURES.iter().find(|f| f.file == file).unwrap()
}

fn with_cell(text: &str, row: usize, column: usize, value: &str) -> String {
    let mut doc = open(text);
    doc.set_cell(row, column, value);
    doc.serialize()
}

// ---- open and save without edits

#[test]
fn every_fixture_is_byte_for_byte_the_same() {
    for f in &FIXTURES {
        let doc = CsvDocument::parse(f.text, Some(f.file));
        assert_eq!(doc.serialize().as_bytes(), f.text.as_bytes(), "{}", f.name);
        assert_eq!(doc.delimiter, f.delimiter, "{}", f.name);
        assert_eq!(doc.row_count(), f.rows, "{}", f.name);
        assert_eq!(doc.column_count, f.columns, "{}", f.name);
    }
}

#[test]
fn every_fixture_survives_the_decode_and_encode_around_a_save() {
    // The window hands the table decoded text and encodes what comes back.
    for f in &FIXTURES {
        let bytes = f.text.as_bytes();
        let decoded = decode_text(bytes).unwrap();
        let saved = encode_text(&CsvDocument::parse(&decoded.text, Some(f.file)).serialize(), decoded.encoding, decoded.bom).unwrap();
        assert_eq!(saved, bytes, "{}", f.name);
    }
}

#[test]
fn every_fixture_is_unchanged_by_an_edit_that_changes_nothing() {
    for f in &FIXTURES {
        let mut doc = CsvDocument::parse(f.text, Some(f.file));
        for r in 0..doc.row_count() {
            for c in 0..doc.row_len(r) {
                let value = doc.cell_value(r, c).into_owned();
                assert!(!doc.set_cell(r, c, &value), "{} {r}:{c}", f.name);
            }
        }
        assert_eq!(doc.serialize().as_bytes(), f.text.as_bytes(), "{}", f.name);
    }
}

#[test]
fn every_fixture_comes_back_after_an_edit_is_undone() {
    for f in &FIXTURES {
        let mut doc = CsvDocument::parse(f.text, Some(f.file));
        if doc.row_count() == 0 {
            continue;
        }
        let last = doc.row_count() - 1;
        let mut undo = doc.set_cells(&[(0, 0, "changed, \"here\""), (last, doc.column_count + 1, "far")]).expect(f.name);
        assert_ne!(doc.serialize(), f.text, "{}", f.name);
        let edited = doc.serialize();
        doc.swap_cells(&mut undo);
        assert_eq!(doc.serialize().as_bytes(), f.text.as_bytes(), "{}", f.name);
        assert_eq!(doc.column_count, f.columns, "{}", f.name);
        doc.swap_cells(&mut undo);
        assert_eq!(doc.serialize(), edited, "{}", f.name);
    }
}

#[test]
fn utf16_with_a_bom_round_trips_through_the_codec() {
    let text = "name;qty\r\n\u{c4}pfel;3\r\n";
    let bytes = encode_text(text, TextEncoding::Utf16Le, true).unwrap();
    let decoded = decode_text(&bytes).unwrap();
    assert_eq!(encode_text(&open(&decoded.text).serialize(), decoded.encoding, decoded.bom).unwrap(), bytes);
}

// ---- reading

#[test]
fn reads_quoted_cells_as_their_values() {
    let doc = open(fixture("embedded-quotes.csv").text);
    assert_eq!(doc.cell_value(1, 1), "She said \"hi\"");
    assert_eq!(doc.cell_value(2, 1), "\"");
    assert_eq!(doc.cell_value(3, 1), "a,b");
    assert_eq!(doc.cell_value(4, 1), "5\" pipe");
}

#[test]
fn keeps_a_line_break_inside_a_quoted_cell_in_the_cell() {
    let doc = open(fixture("quoted-newlines.csv").text);
    assert_eq!(doc.cell_value(1, 1), "line one\nline two");
    assert_eq!(doc.cell_value(2, 1), "a\r\nb");
}

#[test]
fn reads_a_cell_a_short_row_does_not_have_as_empty() {
    assert_eq!(open("a,b,c\n1\n").cell_value(1, 2), "");
}

#[test]
fn finds_the_delimiter() {
    assert_eq!(sniff_delimiter("a;b;c\n1,5;2;3\n", None), ';');
    assert_eq!(sniff_delimiter("a\tb\n1\t2\n", None), '\t');
    assert_eq!(sniff_delimiter("a,b\n\"x;y;z\",2\n", None), ',');
    assert_eq!(sniff_delimiter("just one column\nof text\n", None), ',');
    assert_eq!(sniff_delimiter("one\ntwo\n", Some("list.tsv")), '\t');
    // A .tsv whose cells hold commas is still tab separated.
    assert_eq!(sniff_delimiter("a, b\tc, d, e\n1, 2\t3, 4, 5\n", Some("x.tsv")), '\t');
}

#[test]
fn decodes_and_encodes_a_field() {
    assert_eq!(decode_field("\"a \"\"b\"\" c\""), "a \"b\" c");
    assert_eq!(decode_field("\"x\"y"), "xy");
    assert_eq!(decode_field("\"open"), "open");
    assert_eq!(encode_field("plain", ',', false), "plain");
    assert_eq!(encode_field("a,b", ',', false), "\"a,b\"");
    assert_eq!(encode_field("a,b", ';', false), "a,b");
    assert_eq!(encode_field("say \"hi\"", ',', false), "\"say \"\"hi\"\"\"");
    assert_eq!(encode_field("two\nlines", '\t', false), "\"two\nlines\"");
}

// ---- editing changes only the cells it touches

#[test]
fn rewrites_one_cell_and_leaves_the_rest_of_the_file_alone() {
    let text = "\u{feff}id;name;note\r\n1;\"K\u{e4}se; alt\";\"x\"\r\n2;Brot;\r\n3;\"a \"\"b\"\"\";z";
    assert_eq!(with_cell(text, 2, 1, "Br\u{f6}tchen"), "\u{feff}id;name;note\r\n1;\"K\u{e4}se; alt\";\"x\"\r\n2;Br\u{f6}tchen;\r\n3;\"a \"\"b\"\"\";z");
}

#[test]
fn keeps_a_quoted_cell_quoted_and_quotes_a_value_that_needs_it() {
    let text = "a,b\n\"x\",y\n";
    assert_eq!(with_cell(text, 1, 0, "z"), "a,b\n\"z\",y\n");
    assert_eq!(with_cell(text, 1, 1, "1,5"), "a,b\n\"x\",\"1,5\"\n");
    assert_eq!(with_cell(text, 1, 1, "two\nlines"), "a,b\n\"x\",\"two\nlines\"\n");
}

#[test]
fn does_not_quote_a_comma_in_a_semicolon_file() {
    assert_eq!(with_cell("a;b\n1;2\n", 1, 1, "1,5"), "a;b\n1;1,5\n");
}

#[test]
fn follows_a_file_that_quotes_every_field() {
    let text = "\"a\",\"b\"\n\"1\",\"2\"\n";
    let mut doc = open(text);
    doc.insert_row(2, &[]);
    assert_eq!(doc.serialize(), "\"a\",\"b\"\n\"1\",\"2\"\n\"\",\"\"\n");
    let mut doc = open(text);
    doc.insert_column(2);
    assert_eq!(doc.serialize(), "\"a\",\"b\",\"\"\n\"1\",\"2\",\"\"\n");
}

#[test]
fn grows_a_short_row_only_as_far_as_the_cell() {
    assert_eq!(with_cell("a,b,c\n1\n2,3,4\n", 1, 2, "x"), "a,b,c\n1,,x\n2,3,4\n");
}

#[test]
fn adds_a_row_with_the_files_line_ending() {
    let mut doc = open("a,b\r\n1,2\r\n");
    doc.insert_row(1, &[]);
    assert_eq!(doc.serialize(), "a,b\r\n,\r\n1,2\r\n");
    let mut doc = open("a,b\r\n1,2\r\n");
    doc.insert_row(2, &["x", "y,z"]);
    assert_eq!(doc.serialize(), "a,b\r\n1,2\r\nx,\"y,z\"\r\n");
}

#[test]
fn keeps_a_file_without_a_trailing_newline_without_one() {
    let mut doc = open("a,b\n1,2");
    doc.insert_row(2, &[]);
    assert_eq!(doc.serialize(), "a,b\n1,2\n,");
    let mut doc = open("a,b\n1,2\n3,4");
    assert!(doc.delete_rows(&[2]));
    assert_eq!(doc.serialize(), "a,b\n1,2");
    let mut doc = open("a,b\n1,2\n3,4\n");
    assert!(doc.delete_rows(&[2]));
    assert_eq!(doc.serialize(), "a,b\n1,2\n");
}

#[test]
fn deletes_rows_and_columns() {
    let text = "a,b,c\n1,2,3\n4,5,6\n7,8,9\n";
    let mut doc = open(text);
    assert!(doc.delete_rows(&[1, 3]));
    assert_eq!(doc.serialize(), "a,b,c\n4,5,6\n");
    let mut doc = open(text);
    assert!(doc.delete_columns(&[1]));
    assert_eq!(doc.serialize(), "a,c\n1,3\n4,6\n7,9\n");
    let mut doc = open(text);
    assert!(doc.delete_columns(&[0, 2]));
    assert_eq!(doc.column_count, 1);
    assert!(!doc.delete_rows(&[99]));
    assert!(!doc.delete_columns(&[99]));
}

#[test]
fn adds_a_column_without_touching_blank_lines_or_rows_too_short_to_reach_it() {
    let mut doc = open("a,b\n\n1\n3,4\n");
    doc.insert_column(2);
    assert_eq!(doc.serialize(), "a,b,\n\n1\n3,4,\n");
    let mut doc = open("a,b\n1,2\n");
    doc.insert_column(0);
    assert_eq!(doc.serialize(), ",a,b\n,1,2\n");
}

#[test]
fn starts_an_empty_file_with_one_row() {
    let mut doc = open("");
    doc.insert_row(0, &["x"]);
    assert_eq!(doc.serialize(), "x\n");
}

// ---- the view

#[test]
fn reads_numbers_the_way_the_file_writes_them() {
    let n = |s: &str| parse_number(s, false);
    assert_eq!(n("42"), Some(42.));
    assert_eq!(n("-3.5"), Some(-3.5));
    assert_eq!(n("1,234.50"), Some(1234.5));
    assert_eq!(n("1.234,50"), Some(1234.5));
    assert_eq!(n("1,234"), Some(1234.));
    assert_eq!(parse_number("1,234", true), Some(1.234));
    assert_eq!(parse_number("12,50", true), Some(12.5));
    assert_eq!(n("$1,200"), Some(1200.));
    assert_eq!(n("45%"), Some(45.));
    assert_eq!(n("1 234 567"), Some(1234567.));
    assert_eq!(n("2024-01-05"), None);
    assert_eq!(n("555 1234"), None);
    assert_eq!(n("abc"), None);
    assert_eq!(n(""), None);
    // Shapes the pattern allows that the list above does not reach.
    assert_eq!(n("\u{20ac} 1.234.567,89"), Some(1234567.89));
    assert_eq!(n("12 %"), Some(12.));
    assert_eq!(n(".5"), Some(0.5));
    assert_eq!(n("+7"), Some(7.));
    assert_eq!(n("1'234'567.5"), Some(1234567.5));
    assert_eq!(n("1.2.3"), None);
    assert_eq!(n("1,2,3"), None);
    assert_eq!(n("12  %"), Some(12.));
    assert_eq!(n("12\t\t%"), None);
    assert_eq!(n("--1"), None);
}

#[test]
fn knows_which_columns_are_numbers() {
    assert_eq!(open("name,qty,price\nA,3,1.20\nB,12,0.85\n").numeric_columns(1), [false, true, true]);
    assert_eq!(open("Artikel;Preis\nA;1,20\nB;0,85\n").numeric_columns(1), [false, true]);
}

#[test]
fn takes_the_first_row_as_the_header_unless_it_is_clearly_data() {
    assert!(open("name,qty\nApple,3\nPear,12\n").first_row_is_header());
    assert!(!open("1,Apple,3\n2,Pear,12\n").first_row_is_header());
    assert!(open("name,city\nZo\u{eb},K\u{f6}ln\n").first_row_is_header());
    assert!(!open("").first_row_is_header());
}

fn sort(column: usize, direction: SortDirection) -> Option<CsvSort> {
    Some(CsvSort { column, direction })
}

#[test]
fn sorts_numbers_as_numbers_text_as_text_and_empty_cells_last() {
    let doc = open("name,qty\nb,10\na,9\nc,\nd,100\n");
    let numeric = doc.numeric_columns(1);
    assert_eq!(doc.view_rows(1, "", sort(1, SortDirection::Asc), &numeric), [2, 1, 4, 3]);
    assert_eq!(doc.view_rows(1, "", sort(1, SortDirection::Desc), &numeric), [4, 1, 2, 3]);
    assert_eq!(doc.view_rows(1, "", sort(0, SortDirection::Asc), &numeric), [2, 1, 3, 4]);
    assert_eq!(doc.view_rows(1, "", None, &numeric), [1, 2, 3, 4]);
}

#[test]
fn sorts_text_without_case_or_accent_and_digits_as_numbers() {
    let doc = open("name\nitem 10\n\u{c9}clair\nitem 9\napple\nBanana\n\nitem 9\n");
    assert_eq!(doc.view_rows(1, "", sort(0, SortDirection::Asc), &[false]), [4, 5, 2, 3, 7, 1, 6]);
    assert_eq!(doc.view_rows(1, "", sort(0, SortDirection::Desc), &[false]), [1, 3, 7, 2, 5, 4, 6]);
}

#[test]
fn filters_across_every_cell_ignoring_case_and_never_changes_the_document() {
    let doc = open("name,note\nApple,\"red, round\"\nPear,green\nPlum,\"dark RED\"\n");
    let before = doc.serialize();
    assert_eq!(doc.view_rows(1, "red", None, &[]), [1, 3]);
    assert_eq!(doc.view_rows(1, "  PEAR ", sort(0, SortDirection::Desc), &[]), [2]);
    assert_eq!(doc.view_rows(0, "name", None, &[]), [0]);
    assert_eq!(doc.serialize(), before);
    let accents = open("stadt\nK\u{d6}LN\nBonn\n");
    assert_eq!(accents.view_rows(1, "k\u{f6}l", None, &[]), [1]);
    assert_eq!(accents.view_rows(1, "\u{f6}", None, &[]), [1]);
}

#[test]
fn names_columns_by_letter() {
    assert_eq!([0, 25, 26, 27, 701, 702].map(column_letter), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
}

// ---- clipboard

#[test]
fn copies_a_block_as_tsv_or_csv() {
    let doc = open("a,b\n\"x,y\",2\n\"two\nlines\",4\n");
    assert_eq!(doc.cells_to_text(&[1, 2], &[0, 1], '\t'), "x,y\t2\n\"two\nlines\"\t4");
    assert_eq!(doc.cells_to_text(&[1, 2], &[0, 1], ','), "\"x,y\",2\n\"two\nlines\",4");
}

#[test]
fn reads_a_pasted_block() {
    assert_eq!(clipboard_to_cells("a\tb\r\nc\td\r\n"), [["a", "b"], ["c", "d"]]);
    assert_eq!(clipboard_to_cells("one, two"), [["one, two"]]);
    assert_eq!(clipboard_to_cells("x\t\"multi\nline\""), [["x", "multi\nline"]]);
}

// ---- the raw text view

#[test]
fn gives_an_editor_plain_lines_and_puts_the_files_shape_back() {
    let original = "\u{feff}a,b\r\n1,2\r\n";
    assert_eq!(plain_editor_text(original), "a,b\n1,2\n");
    assert_eq!(restore_text_shape(original, "a,b\n1,2\n3,4\n"), "\u{feff}a,b\r\n1,2\r\n3,4\r\n");
    assert_eq!(restore_text_shape("a,b\n1,2\n", "a,b\n1,2\n3,4\n"), "a,b\n1,2\n3,4\n");
    assert_eq!(restore_text_shape(original, &plain_editor_text(original)), original);
}

#[test]
fn names_csv_and_tsv_files() {
    assert!(is_csv_name("a.csv") && is_csv_name("B.TSV"));
    assert!(!is_csv_name("a.csv.md") && !is_csv_name("csv"));
}

// ---- the status line

#[test]
fn writes_counts_and_sums_as_en_us() {
    assert_eq!(grouped(0), "0");
    assert_eq!(grouped(999), "999");
    assert_eq!(grouped(100000), "100,000");
    assert_eq!(grouped(1234567), "1,234,567");
    assert_eq!(format_sum(15.), "15");
    assert_eq!(format_sum(0.1 + 0.2), "0.3");
    assert_eq!(format_sum(1234567.891), "1,234,567.891");
    assert_eq!(format_sum(-2.5), "-2.5");
    assert_eq!(format_sum(1. / 3.), "0.333333");
}

// ---- the sheet: cell names, how a value is drawn, what a block adds up to

#[test]
fn names_a_cell_by_its_letter_and_its_line_in_the_file_and_reads_the_name_back() {
    assert_eq!(cell_reference(3, 1), "B4");
    assert_eq!(cell_reference(0, 27), "AB1");
    assert_eq!(parse_cell_reference("b4"), Some((3, 1)));
    assert_eq!(parse_cell_reference(" AB1 "), Some((0, 27)));
    for text in ["", "4", "B", "B0", "B-1", "hello world", "A1:B2"] {
        assert_eq!(parse_cell_reference(text), None, "{text}");
    }
}

#[test]
fn reads_accounting_brackets_as_a_negative_number() {
    let n = |s: &str| parse_number(s, false);
    assert_eq!(n("(1,234.50)"), Some(-1234.5));
    assert_eq!(n("($12)"), Some(-12.));
    assert_eq!(n("(-3)"), None);
    assert_eq!(n("((3))"), None);
    assert_eq!(n("(see note)"), None);
}

fn kind(value: &str) -> CellKind {
    format_cell(value, false).kind
}

fn shown<'a>(kind: CellKind, negative: bool, text: &'a str) -> CellFormat<'a> {
    CellFormat { kind, negative, text: Cow::Borrowed(text) }
}

#[test]
fn tells_numbers_percents_and_money_apart_and_marks_the_negative_ones() {
    assert_eq!(format_cell("1,234.50", false), shown(CellKind::Number, false, "1,234.50"));
    assert_eq!(format_cell("-3", false), shown(CellKind::Number, true, "-3"));
    assert_eq!(format_cell("(250.00)", false), shown(CellKind::Number, true, "(250.00)"));
    assert_eq!(format_cell("12.5%", false), shown(CellKind::Percent, false, "12.5%"));
    assert!(format_cell("-4%", false).negative);
    assert_eq!(kind("$1,200"), CellKind::Currency);
    assert_eq!(format_cell("-\u{20ac} 12,50", true).kind, CellKind::Currency);
    assert_eq!(kind("12 \u{20ac}"), CellKind::Currency);
    assert_eq!(kind("0"), CellKind::Number);
    assert!(!format_cell("0", false).negative);
}

#[test]
fn knows_a_date_when_it_sees_one() {
    for value in [
        "2026-11-24", "2026-11-24 09:30", "2026-11-24T09:30:00Z", "2026-11-24T09:30:00.250+01:00", "2026/11/24", "11/24/2026", "24.11.2026", "24-11-26", "11/24/2026 9:30 PM", "Nov 24, 2026",
        "24 Nov 2026", "November 24", "24-Nov-26", "Tue, 24 Nov 2026", "November 2026", "09:30", "9:30:15 pm",
    ] {
        assert!(is_date_value(value), "{value}");
        assert_eq!(kind(value), CellKind::Date, "{value}");
    }
    for value in ["2026-13-01", "2026-11-32", "13/13/2026", "1.5", "2026", "v1.2.3", "May", "March on", "12:5", "A-12", "1-2", "Room 12/3/4", "11/24.2026"] {
        assert!(!is_date_value(value), "{value}");
    }
}

#[test]
fn shows_true_and_false_links_and_blanks_for_what_they_are_and_leaves_the_rest_alone() {
    assert_eq!(format_cell("true", false), shown(CellKind::Boolean, false, "TRUE"));
    assert_eq!(format_cell(" False ", false), shown(CellKind::Boolean, false, "FALSE"));
    assert_eq!(kind("truely"), CellKind::Text);
    assert_eq!(format_cell("https://markiedocs.com/download?x=1", false), shown(CellKind::Url, false, "https://markiedocs.com/download?x=1"));
    assert_eq!(kind("HTTP://example.com"), CellKind::Url);
    assert_eq!(kind("https://example.com and more"), CellKind::Text);
    assert_eq!(kind("javascript:alert(1)"), CellKind::Text);
    assert_eq!(kind("ftp://example.com"), CellKind::Text);
    assert_eq!(kind("https://"), CellKind::Text);
    assert_eq!(format_cell("   ", false), shown(CellKind::Empty, false, ""));
    assert_eq!(format_cell("", false), shown(CellKind::Empty, false, ""));
    // The text a cell shows is the file's own, spaces and all.
    assert_eq!(format_cell(" Pear ", false), shown(CellKind::Text, false, " Pear "));
}

#[test]
fn sums_averages_and_counts_the_numbers_in_a_block() {
    let doc = open("name,qty,price\nApple,3,1.20\nPear,12,\"0.85\"\nPlum,,n/a\nFig,(5),50%\n");
    assert_eq!(doc.range_stats([1, 2, 3, 4], 1, 2), Some(RangeStats { count: 6, sum: 62.05, average: 10.3416666667 }));
    assert_eq!(doc.range_stats([1, 2], 1, 1), Some(RangeStats { count: 2, sum: 15., average: 7.5 }));
    assert_eq!(doc.range_stats([1, 2, 3], 0, 0), None);
    assert_eq!(open("a\n0.1\n0.2\n").range_stats([1, 2], 0, 5), Some(RangeStats { count: 2, sum: 0.3, average: 0.15 }));
    assert_eq!(format_average(7.5), "7.5");
    assert_eq!(format_average(38.333333333), "38.33");
    assert_eq!(format_average(1187.27857143), "1,187.28");
    assert_eq!(format_average(0.15), "0.15");
    assert_eq!(format_average(0.000123456789), "0.000123");
    assert_eq!(format_average(-2.125), "-2.13");
}

// ---- a large file

fn large_text(rows: usize) -> String {
    let mut text = String::from("id,name,amount,note\n");
    for i in 1..=rows {
        text.push_str(&format!("{i},Name {i},{:.2},\"note, {i}\"\n", i as f64 * 1.5));
    }
    text
}

#[test]
fn opens_edits_and_saves_100_000_rows() {
    let text = large_text(100_000);
    let mut doc = open(&text);
    assert_eq!(doc.row_count(), 100_001);
    assert_eq!(doc.serialize(), text);
    assert_eq!(doc.view_rows(1, "name 99999", None, &[]), [99_999]);
    assert!(doc.set_cell(50_000, 1, "Changed"));
    assert_eq!(doc.serialize().len(), text.len() - "Name 50000".len() + "Changed".len());
}

/// The model's share of the 100,000-row measurement (docs/rust-port/PERF.md):
/// `cargo test --release -p markie-core csv_table -- --ignored --nocapture`.
#[test]
#[ignore = "a timing, run in release on a quiet machine"]
fn times_100_000_rows() {
    use std::time::Instant;
    let text = large_text(100_000);
    let best = |f: &mut dyn FnMut()| {
        (0..9)
            .map(|_| {
                let t = Instant::now();
                f();
                t.elapsed().as_secs_f64() * 1000.
            })
            .fold(f64::MAX, f64::min)
    };
    let mut doc = open(&text);
    println!("parse           {:.2} ms", best(&mut || doc = open(&text)));
    let numeric = doc.numeric_columns(1);
    let mut rows = Vec::new();
    println!("serialize       {:.2} ms", best(&mut || assert_eq!(doc.serialize().len(), text.len())));
    println!("sort numbers    {:.2} ms", best(&mut || rows = doc.view_rows(1, "", sort(2, SortDirection::Desc), &numeric)));
    println!("sort text       {:.2} ms", best(&mut || rows = doc.view_rows(1, "", sort(1, SortDirection::Asc), &numeric)));
    println!("filter          {:.2} ms", best(&mut || rows = doc.view_rows(1, "name 99", None, &numeric)));
    println!("filter no match {:.2} ms", best(&mut || rows = doc.view_rows(1, "zzzz", None, &numeric)));
    assert!(rows.is_empty());
}
