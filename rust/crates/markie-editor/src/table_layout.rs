//! Column widths for a table in the rich view: Chromium's automatic table
//! layout, as Electron's `.markdown-body table` gets it.
//!
//! Each column has a min-content width (its widest unbreakable word, padding
//! included) and a max-content width (its longest cell on one line). The
//! table then takes:
//!
//! - every column at max-content when that fits the room;
//! - with `width: 100%` (the Full width style) the room, the extra shared in
//!   proportion to each column's max-content;
//! - between the two totals, each column's min-content plus a share of the
//!   room left over, in proportion to how much it could still grow;
//! - below the min-content total, every column at min-content. The table is
//!   then wider than the room, and its box scrolls sideways, as the
//!   `display: block; overflow-x: auto` table does in Electron.
//!
//! One list of widths sizes the cells, the rows (and so their backgrounds and
//! lines), the grid's borders and the header, so they cannot disagree.

/// A column's min-content and max-content widths, padding included.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Column {
    pub min: f32,
    pub max: f32,
}

/// The table's columns and its whole width.
#[derive(Clone, Debug, PartialEq)]
pub struct Columns {
    pub widths: Vec<f32>,
    pub width: f32,
    /// Wider than the room: the table's box scrolls sideways.
    pub overflows: bool,
}

/// The room a cell's text needs beyond its own width: the padding on both
/// sides, the grid's 1px right edge, and a point of slack. The cell's box
/// and padding snap to device pixels, which can shave up to half a point
/// off the text's room, and a word measured to the hair would then wrap
/// onto a second line (its row grows, and the row's other cells sit half a
/// line off its middle).
pub fn cell_edge(padding_x: f32, grid: bool) -> f32 {
    2. * padding_x + if grid { 1. } else { 0. } + SNAP_SLACK
}

/// See `cell_edge`.
pub const SNAP_SLACK: f32 = 1.;

/// Widths for `cols` in `room` points. `full` is `width: 100%`.
pub fn columns(cols: &[Column], room: f32, full: bool) -> Columns {
    let room = room.max(0.);
    let cols: Vec<Column> = cols.iter().map(|c| Column { min: c.min.max(0.), max: c.max.max(c.min).max(0.) }).collect();
    let min_total: f32 = cols.iter().map(|c| c.min).sum();
    let max_total: f32 = cols.iter().map(|c| c.max).sum();
    let widths: Vec<f32> = if max_total <= room {
        if full && max_total > 0. {
            cols.iter().map(|c| c.max + (room - max_total) * c.max / max_total).collect()
        } else if full && !cols.is_empty() {
            cols.iter().map(|_| room / cols.len() as f32).collect()
        } else {
            cols.iter().map(|c| c.max).collect()
        }
    } else if min_total < room {
        let k = (room - min_total) / (max_total - min_total);
        cols.iter().map(|c| c.min + (c.max - c.min) * k).collect()
    } else {
        cols.iter().map(|c| c.min).collect()
    };
    let width = widths.iter().sum::<f32>();
    Columns { widths, width, overflows: width > room + 0.5 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(min: f32, max: f32) -> Column {
        Column { min, max }
    }

    fn close(a: &[f32], b: &[f32]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.01)
    }

    #[test]
    fn a_table_that_fits_takes_its_text_widths() {
        let c = columns(&[col(40., 60.), col(50., 120.)], 700., false);
        assert!(close(&c.widths, &[60., 120.]));
        assert_eq!(c.width, 180.);
        assert!(!c.overflows);
    }

    #[test]
    fn full_width_shares_the_extra_by_text_width() {
        let c = columns(&[col(40., 100.), col(50., 300.)], 800., true);
        assert!(close(&c.widths, &[200., 600.]));
        assert!((c.width - 800.).abs() < 0.01);
    }

    /// The kind of table that broke (2026-11-24, the synthetic fixture in
    /// rust/scripts/screen/scene/fixtures/tables.md): three columns of very
    /// different lengths in a 614 pt page column, the Skills panel open. Theme
    /// font at 16 (14.4 in a cell, 1em padding): the Who column's widest word
    /// is also its longest line; the other two wrap.
    #[test]
    fn a_wide_table_wraps_inside_the_room_and_never_below_a_word() {
        let who = col(76., 76.);
        let work = col(110., 470.);
        let state = col(104., 790.);
        let c = columns(&[who, work, state], 614., false);
        assert!((c.width - 614.).abs() < 0.01, "the table is exactly the page column: {c:?}");
        assert!(!c.overflows);
        assert!((c.widths[0] - 76.).abs() < 0.01, "a column that cannot wrap keeps its word: {c:?}");
        assert!(c.widths[1] > work.min && c.widths[2] > state.min);
        // Each column grows by the same share of what it could still grow.
        let k1 = (c.widths[1] - work.min) / (work.max - work.min);
        let k2 = (c.widths[2] - state.min) / (state.max - state.min);
        assert!((k1 - k2).abs() < 1e-4);
    }

    #[test]
    fn the_same_table_full_width_is_the_same_once_it_has_to_wrap() {
        let cols = [col(76., 76.), col(110., 470.), col(104., 790.)];
        assert_eq!(columns(&cols, 614., true), columns(&cols, 614., false));
    }

    #[test]
    fn narrower_than_its_words_it_overflows_and_scrolls() {
        let c = columns(&[col(300., 400.), col(250., 500.)], 400., false);
        assert!(close(&c.widths, &[300., 250.]));
        assert!(c.overflows);
    }

    #[test]
    fn every_page_width_and_zoom_keeps_the_columns_inside_the_room_or_scrolling() {
        // Page widths at zoom 75 to 150%, panel open and closed: the table is
        // never wider than the room unless it cannot be, and never narrower
        // than its words.
        let base = [col(76., 76.), col(110., 470.), col(104., 790.), col(30., 30.)];
        for zoom in [0.75f32, 0.9, 1.0, 1.1, 1.25, 1.5] {
            for room in [320f32, 480., 614., 768., 900., 1040., 1200., 1552.] {
                for full in [false, true] {
                    let cols: Vec<Column> = base.iter().map(|c| col(c.min * zoom, c.max * zoom)).collect();
                    let c = columns(&cols, room, full);
                    let min_total: f32 = cols.iter().map(|c| c.min).sum();
                    for (w, cc) in c.widths.iter().zip(&cols) {
                        assert!(*w + 0.01 >= cc.min, "zoom {zoom} room {room}: {c:?}");
                    }
                    if min_total <= room {
                        assert!(c.width <= room + 0.01 && !c.overflows, "zoom {zoom} room {room}: {c:?}");
                    } else {
                        assert!(c.overflows);
                    }
                    assert!((c.widths.iter().sum::<f32>() - c.width).abs() < 0.01);
                }
            }
        }
    }

    /// Snapping a column to half points never leaves its words less room
    /// than they were measured at.
    #[test]
    fn a_snapped_column_still_fits_its_widest_word() {
        for word in [33.6f32, 35.2, 47.95, 104.49] {
            for pad in [9.36f32, 14.4, 17.28] {
                for grid in [false, true] {
                    let edge = cell_edge(pad, grid);
                    let w = columns(&[col(word + edge, word + edge)], 600., false).widths[0];
                    // The box and each side's padding round to the nearest half point.
                    let snap = |v: f32| (v * 2.).round() / 2.;
                    let text_room = snap(w) - 2. * snap(pad) - if grid { 1. } else { 0. };
                    assert!(text_room + 0.01 >= word, "word {word} pad {pad} grid {grid}: room {text_room}");
                }
            }
        }
    }

    #[test]
    fn empty_columns_still_get_their_padding() {
        let c = columns(&[col(28.8, 28.8), col(0., 0.)], 600., false);
        assert!(close(&c.widths, &[28.8, 0.]));
        let f = columns(&[col(0., 0.), col(0., 0.)], 600., true);
        assert!(close(&f.widths, &[300., 300.]));
    }
}
