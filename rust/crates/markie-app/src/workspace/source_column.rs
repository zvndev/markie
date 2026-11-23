//! Source's page-width column, as Electron draws CodeMirror
//! (`src/app/globals.css`, `.cm-editor .cm-content`):
//!
//! ```css
//! max-width: calc(var(--doc-width, 768px) + clamp(2.5rem, 6vw, 5rem));
//! margin: 0 auto;
//! padding: 0 clamp(1.25rem, 3vw, 2.5rem);
//! ```
//!
//! The gutter stays at the pane's left edge in CodeMirror and the column
//! centres in the space after it. GPUI Kit 0.10 paints the line numbers right
//! against the text, with no public way to put space between them, so the
//! space before the column goes in front of the numbers instead: an empty
//! gutter decoration strip of that width. The text then starts, wraps and
//! ends where CodeMirror's does; the numbers sit beside the column rather
//! than at the pane's edge. The space after the column is a plain spacer
//! that passes the wheel on to the editor. Where GPUI Kit's text starts
//! without the strip is read back from the editor after it draws, so the
//! column lands on Electron's to the point whatever the font's digits.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui_kit::component::input::{EditorState, GutterDecorationCollection, RopeExt as _};
use gpui_kit::*;

/// What GPUI Kit's code editor puts around the text (gpui-base 0.10.0,
/// `input/base/element.rs` and gpui-component `input.rs`): the editor's
/// left padding (`input_px().min(6)`), its right padding (Medium's
/// `input_px`), the margin after the line numbers, the fold icon column,
/// the gap after a decoration strip and the wrap margin.
const RS_PAD_LEFT: f32 = 6.;
const RS_PAD_RIGHT: f32 = 10.;
const RS_NUMBER_MARGIN: f32 = 6.;
const RS_FOLD: f32 = 18.;
const RS_STRIP_GAP: f32 = 4.;
const RS_WRAP_MARGIN: f32 = 10.;
/// The monospaced advance as a share of the font size, for both apps'
/// fonts (Geist Mono in Electron, SF Mono here).
const MONO_ADVANCE: f32 = 0.6;
/// Electron's Source keeps a 24 px column for its section rail left of
/// CodeMirror (`section-rail.tsx`, `GEOMETRY.column`); Markie RS draws the
/// rail over the editor, so the editor's pane is that much wider.
const RAIL_COLUMN: f32 = 24.;
/// CodeMirror's `.cm-line` padding, `0 2px 0 6px`.
const LINE_PAD_LEFT: f32 = 6.;
const LINE_PAD_RIGHT: f32 = 2.;
/// Electron's `::-webkit-scrollbar { width: 6px }` takes layout width once
/// the document is taller than the pane.
const SCROLLBAR: f32 = 6.;
/// `.cm-scroller`'s `padding: 1.25rem 0`, for the overflow test.
const SCROLLER_PAD_Y: f32 = 20.;

/// Where Electron's text column is in a pane: its left edge and its width,
/// both in points from the pane's left edge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Column {
    pub text_left: f32,
    pub text_width: f32,
}

fn digits(lines: usize) -> usize {
    lines.max(1).ilog10() as usize + 1
}

/// CodeMirror's gutter width in Electron: the line numbers (`min-width:
/// 20px`, padding `0 3px 0 5px`, as wide as the last line's number), the
/// fold gutter (one marker with `padding: 0 1px`) and the 1 px rule.
fn electron_gutter(lines: usize, font: f32) -> f32 {
    let cw = font * MONO_ADVANCE;
    (8. + digits(lines) as f32 * cw).max(20.) + cw + 2. + 1.
}

/// GPUI Kit's gutter without a strip: three digits at least.
fn rs_gutter(lines: usize, font: f32) -> f32 {
    let cw = font * MONO_ADVANCE;
    digits(lines).max(3) as f32 * cw + RS_NUMBER_MARGIN + RS_FOLD
}

/// Electron's text column for Markie RS's Source pane `pane` wide, in a
/// window `vw` wide, with the document's page width, the Source font size
/// (14 px times the zoom) and whether the document is taller than the pane.
pub(crate) fn electron_column(pane: f32, vw: f32, page_width: f32, lines: usize, font: f32, overflows: bool) -> Column {
    let gutter = electron_gutter(lines, font);
    let scroller = pane - RAIL_COLUMN - if overflows { SCROLLBAR } else { 0. };
    let avail = (scroller - gutter).max(0.);
    let pad = (vw * 0.03).clamp(20., 40.);
    let column = avail.min(page_width + (vw * 0.06).clamp(40., 80.));
    let margin = (avail - column) / 2.;
    Column {
        text_left: RAIL_COLUMN + gutter + margin + pad + LINE_PAD_LEFT,
        text_width: (column - 2. * pad - LINE_PAD_LEFT - LINE_PAD_RIGHT).max(0.),
    }
}

/// Whether Electron's scroller would show its scrollbar: the lines alone,
/// unwrapped, are taller than the pane.
pub(crate) fn overflows(lines: usize, font: f32, line_height: f32, pane_height: f32) -> bool {
    lines as f32 * font * line_height + 2. * SCROLLER_PAD_Y > pane_height
}

/// The strip in front of GPUI Kit's line numbers and the spacer after the
/// editor that put its text on `col`. A strip under a point is left out.
/// `measured` is where the text starts with no strip, read back from the
/// editor once it has drawn; before that the estimate stands in.
pub(crate) fn rs_insets(col: Column, pane: f32, lines: usize, font: f32, measured: Option<f32>) -> (Option<f32>, f32) {
    let plain_left = measured.unwrap_or_else(|| RS_PAD_LEFT + rs_gutter(lines, font));
    let strip = col.text_left - plain_left - RS_STRIP_GAP;
    let strip = (strip >= 1.).then_some(strip);
    let text_left = plain_left + strip.map_or(0., |s| s + RS_STRIP_GAP);
    // The editor wraps at its width less its padding, the gutter and the
    // wrap margin.
    let spacer = pane - text_left - RS_PAD_RIGHT - RS_WRAP_MARGIN - col.text_width;
    (strip, spacer.max(0.))
}

/// The column's state across frames: the pane width last measured and the
/// strip collection, which must live as long as the strip shows.
#[derive(Default)]
pub(crate) struct SourceColumn {
    /// The pane's width and height and the window's width, measured at
    /// the last paint.
    pane: Rc<Cell<(f32, f32, f32)>>,
    /// Where the editor's text starts in the pane without a strip, from the
    /// caret bounds of the first character, with the font size it was read at.
    plain_left: Rc<Cell<Option<(f32, f32)>>>,
    /// The strip width laid out now, to take back out of that reading.
    applied: Rc<Cell<Option<f32>>>,
    strip: RefCell<Option<(GutterDecorationCollection, f32)>>,
}

impl SourceColumn {
    /// Lay `editor` (the Source editor element) out in the column. Called
    /// while rendering; a changed pane width redraws once more.
    pub(crate) fn render(
        &self,
        state: &Entity<EditorState>,
        editor: AnyElement,
        page_width: f32,
        font: f32,
        line_height: f32,
        cx: &mut App,
    ) -> Div {
        let (pane, pane_h, vw) = self.pane.get();
        let lines = state.read(cx).text().lines_len();
        let plain_left = self.plain_left.get().filter(|(_, f)| (f - font).abs() < 0.01).map(|(x, _)| x);
        let (strip, spacer) = if pane > 0. {
            let col = electron_column(pane, vw, page_width, lines, font, overflows(lines, font, line_height, pane_h));
            rs_insets(col, pane, lines, font, plain_left)
        } else {
            (None, 0.)
        };
        self.set_strip(state, strip, cx);
        let measured = self.pane.clone();
        let (plain_cell, applied) = (self.plain_left.clone(), self.applied.clone());
        let read_state = state.downgrade();
        let wheel_state = state.downgrade();
        div()
            .size_full()
            .min_h_0()
            .relative()
            .child(
                div()
                    .size_full()
                    .flex()
                    .flex_row()
                    .child(div().flex_1().min_w_0().h_full().child(editor))
                    .child(div().flex_none().h_full().w(px(spacer)).on_scroll(move |ev: &ScrollEvent, _, cx| {
                        // The margin scrolls the document, as CodeMirror's does.
                        let _ = wheel_state.update(cx, |s, cx| {
                            let lh = s.line_height().unwrap_or(px(20.));
                            let d = ev.delta.pixel_delta(lh);
                            let o = s.scroll_offset();
                            s.set_scroll_offset(point(o.x, o.y + d.y), cx);
                        });
                    })),
            )
            .child(
                canvas(
                    move |bounds, window, cx| {
                        // Read where the text really starts: GPUI Kit's
                        // gutter width depends on its font's digits.
                        if let Some(st) = read_state.upgrade() {
                            if let Some(b) = st.read(cx).range_to_bounds(&(0..0)) {
                                let x = f32::from(b.origin.x - bounds.origin.x)
                                    - applied.get().map_or(0., |w| w + RS_STRIP_GAP);
                                let was = plain_cell.get();
                                if was.is_none_or(|(w, f)| (w - x).abs() > 0.25 || (f - font).abs() > 0.01) {
                                    plain_cell.set(Some((x, font)));
                                    window.refresh();
                                }
                            }
                        }
                        let now = (
                            f32::from(bounds.size.width),
                            f32::from(bounds.size.height),
                            f32::from(window.viewport_size().width),
                        );
                        let was = measured.get();
                        if (was.0 - now.0).abs() > 0.5 || (was.1 - now.1).abs() > 0.5 || (was.2 - now.2).abs() > 0.5 {
                            measured.set(now);
                            window.refresh();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
    }

    /// Leave the column (literal text formats share the editor and use
    /// their own layout).
    pub(crate) fn clear(&self, state: &Entity<EditorState>, cx: &mut App) {
        self.set_strip(state, None, cx);
    }

    fn set_strip(&self, state: &Entity<EditorState>, width: Option<f32>, cx: &mut App) {
        let mut strip = self.strip.borrow_mut();
        let old = strip.as_ref().map(|(_, w)| *w);
        match (width, old) {
            (None, None) => {}
            (None, Some(_)) => {
                if let Some((c, _)) = strip.take() {
                    c.dispose(cx);
                }
                self.applied.set(None);
            }
            (Some(w), Some(o)) if (w - o).abs() < 0.5 => {}
            (Some(w), _) => {
                let kept = strip.take().map(|(c, _)| c);
                let made = state.update(cx, |s, cx| {
                    s.set_gutter_decorations_width(px(w), cx);
                    kept.unwrap_or_else(|| s.create_gutter_decorations_collection(Vec::new(), cx))
                });
                *strip = Some((made, w));
                self.applied.set(Some(w));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's `test` attribute would shadow the standard one.
    use super::{electron_column, electron_gutter, overflows, rs_gutter, rs_insets, RS_PAD_LEFT, RS_PAD_RIGHT, RS_STRIP_GAP, RS_WRAP_MARGIN};

    #[test]
    fn the_column_is_electrons_at_1280() {
        // 1280 pt window, 52 pt app rail: a 1228 pt pane, of which Electron
        // gives 24 to the section rail and 6 to the scrollbar. Padding
        // clamp(20, 38.4, 40) = 38.4, column 768 + 76.8.
        let pane = 1228.;
        let c = electron_column(pane, 1280., 768., 93, 14., true);
        assert!((c.text_width - 760.).abs() < 0.01, "{c:?}");
        let gutter = electron_gutter(93, 14.);
        let margin = (pane - 24. - 6. - gutter - 844.8) / 2.;
        assert!((c.text_left - (24. + gutter + margin + 38.4 + 6.)).abs() < 0.01);
        // Measured on Electron 0.9.7 (`e-source-dark.png`): the text starts
        // 315 pt into the window, 263 pt into this pane.
        assert!((c.text_left - 263.).abs() < 1.5, "{c:?}");
    }

    #[test]
    fn a_narrow_pane_keeps_only_the_padding() {
        // Split at 1280: the pane is narrower than the column.
        let pane = 560.;
        let c = electron_column(pane, 1280., 768., 35, 14., false);
        let gutter = electron_gutter(35, 14.);
        assert!((c.text_left - (24. + gutter + 38.4 + 6.)).abs() < 0.01);
        assert!((c.text_width - (pane - 24. - gutter - 76.8 - 8.)).abs() < 0.01);
    }

    #[test]
    fn the_padding_and_column_follow_the_window() {
        // clamp(1.25rem, 3vw, 2.5rem) and clamp(2.5rem, 6vw, 5rem).
        let small = electron_column(2000., 600., 768., 10, 14., false);
        assert!((small.text_width - (768. + 40. - 40. - 8.)).abs() < 0.01);
        let wide = electron_column(3000., 2000., 768., 10, 14., false);
        assert!((wide.text_width - (768. + 80. - 80. - 8.)).abs() < 0.01);
    }

    #[test]
    fn page_width_sets_the_column() {
        let c = electron_column(2400., 1280., 1200., 10, 14., false);
        assert!((c.text_width - 1192.).abs() < 0.01);
    }

    #[test]
    fn the_scrollbar_counts_only_when_the_document_overflows() {
        assert!(!overflows(10, 14., 1.4, 700.));
        assert!(overflows(93, 14., 1.4, 700.));
        let short = electron_column(1228., 1280., 768., 10, 14., false);
        let long = electron_column(1228., 1280., 768., 10, 14., true);
        assert!((short.text_left - long.text_left - 3.).abs() < 0.01);
    }

    #[test]
    fn rs_insets_put_the_text_on_the_column() {
        let pane = 1228.;
        let c = electron_column(pane, 1280., 768., 35, 14., true);
        let (strip, spacer) = rs_insets(c, pane, 35, 14., None);
        let strip = strip.expect("a wide pane has a strip");
        let left = RS_PAD_LEFT + rs_gutter(35, 14.) + strip + RS_STRIP_GAP;
        assert!((left - c.text_left).abs() < 0.01);
        let wrap = pane - spacer - left - RS_PAD_RIGHT - RS_WRAP_MARGIN;
        assert!((wrap - c.text_width).abs() < 0.01);
    }
}
