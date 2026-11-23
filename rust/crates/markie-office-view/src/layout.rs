//! How the page view lays a document out, without GPUI: run and paragraph
//! looks in points, block page-break hints, and pagination over measured
//! block heights.

use markie_office::model::{Block, ListKind, Paragraph, RichDocument, Run};

/// CSS pixels per point, as the Electron page uses (`points * 96 / 72`).
pub const PX_PER_POINT: f32 = 96.0 / 72.0;
/// The Electron default body text: Georgia 12 pt.
pub const DEFAULT_FONT: &str = "Georgia";
pub const DEFAULT_SIZE_POINTS: f64 = 12.0;
/// Electron's paragraph defaults: no space before, 8 pt after, line height 1.4.
pub const DEFAULT_AFTER_POINTS: f64 = 8.0;
pub const DEFAULT_LINE_MULTIPLE: f64 = 1.4;

/// The look of one run on screen.
#[derive(Clone, Debug, PartialEq)]
pub struct RunLook {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub link: bool,
    /// Authored color as six hex digits.
    pub color: Option<String>,
    pub font_family: Option<String>,
    pub size_points: f64,
}

/// Heading sizes used only when the document's styles give none (RTF, ODT and
/// bare packages). Word's own styles win whenever they resolve a size.
fn heading_fallback(style_id: Option<&str>) -> Option<(f64, bool)> {
    let id = style_id?.to_ascii_lowercase();
    match id.as_str() {
        "title" => Some((26.0, false)),
        "heading1" => Some((20.0, true)),
        "heading2" => Some((16.0, true)),
        "heading3" => Some((14.0, true)),
        "heading4" | "heading5" | "heading6" => Some((12.0, true)),
        _ => None,
    }
}

pub fn is_heading(paragraph: &Paragraph) -> bool {
    paragraph.style_id.as_deref().is_some_and(|id| {
        let id = id.to_ascii_lowercase();
        id.starts_with("heading") || id.starts_with("title")
    })
}

/// The heading level for the outline: Title is 0, Heading1 is 1.
pub fn heading_level(paragraph: &Paragraph) -> usize {
    let id = paragraph.style_id.as_deref().unwrap_or_default().to_ascii_lowercase();
    id.trim_start_matches("heading").parse().unwrap_or(0)
}

pub fn run_look(run: &Run, paragraph: &Paragraph) -> RunLook {
    let style = run.resolved_style.as_ref().unwrap_or(&run.style);
    let fallback = heading_fallback(paragraph.style_id.as_deref());
    let link = run.hyperlink_id.is_some();
    RunLook {
        bold: style.bold.unwrap_or(fallback.is_some_and(|(_, bold)| bold)),
        italic: style.italic == Some(true),
        underline: match style.underline.as_deref() {
            Some("none") => false,
            Some(_) => true,
            None => link,
        },
        link,
        color: style.color.clone().filter(|c| c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit())),
        font_family: style.font_family.clone(),
        size_points: style.font_size_points.or(fallback.map(|(size, _)| size)).unwrap_or(DEFAULT_SIZE_POINTS),
    }
}

/// One text size per paragraph: GPUI shapes a text element at a single size,
/// so a paragraph uses the size most of its text has.
pub fn paragraph_size_points(paragraph: &Paragraph) -> f64 {
    let mut best: Option<(usize, f64)> = None;
    let mut totals: Vec<(f64, usize)> = Vec::new();
    for run in &paragraph.runs {
        let size = run_look(run, paragraph).size_points;
        match totals.iter_mut().find(|(s, _)| (*s - size).abs() < 0.01) {
            Some(entry) => entry.1 += run.text.len().max(1),
            None => totals.push((size, run.text.len().max(1))),
        }
    }
    for (size, count) in totals {
        if best.is_none_or(|(c, _)| count > c) {
            best = Some((count, size));
        }
    }
    best.map(|(_, size)| size).or_else(|| heading_fallback(paragraph.style_id.as_deref()).map(|(size, _)| size)).unwrap_or(DEFAULT_SIZE_POINTS)
}

/// The look of a paragraph box.
#[derive(Clone, Debug, PartialEq)]
pub struct ParagraphLook {
    pub alignment: Alignment,
    pub before_points: f64,
    pub after_points: f64,
    pub line_multiple: f64,
    /// Left indent in CSS pixels at 100% zoom (lists).
    pub indent_px: f32,
    /// "•" or "3." for list items.
    pub marker: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alignment {
    Left,
    Center,
    Right,
    Justify,
}

pub fn paragraph_look(paragraph: &Paragraph) -> ParagraphLook {
    let alignment = match paragraph.alignment.as_deref() {
        Some("center") => Alignment::Center,
        Some("right" | "end") => Alignment::Right,
        Some("both" | "justify" | "distribute") => Alignment::Justify,
        _ => Alignment::Left,
    };
    let (indent_px, marker) = match paragraph.list_kind {
        None => (0.0, None),
        Some(kind) => {
            let level = paragraph.list_level.unwrap_or(0);
            let indent = 24.0 * (level.min(8) as f32 + 1.0);
            let marker = match kind {
                ListKind::Bullet => "•".to_string(),
                ListKind::Numbered => format!("{}.", paragraph.list_number.unwrap_or(1)),
            };
            (indent, Some(marker))
        }
    };
    ParagraphLook {
        alignment,
        before_points: paragraph.spacing_before_points.unwrap_or(0.0),
        after_points: paragraph.spacing_after_points.unwrap_or(DEFAULT_AFTER_POINTS),
        line_multiple: paragraph.line_spacing_multiple.filter(|m| *m > 0.0).unwrap_or(DEFAULT_LINE_MULTIPLE),
        indent_px,
        marker,
    }
}

/// Where explicit page breaks push a block onto a new page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BreakHint {
    /// A break at the very start of non-empty text: the block starts a page.
    pub before: bool,
    /// Any other break: the next block starts a page. A break inside the text
    /// is approximated by a break after the paragraph.
    pub after: bool,
}

impl BreakHint {
    /// Electron's marker is a block inside the run span, so Chromium keeps a
    /// line box on each side of it: a break that opens the text leaves an
    /// empty line above the marker, and one that ends it leaves an empty
    /// line below. A break inside the text has text on both sides.
    pub fn empty_line_before(self) -> bool {
        self.before
    }

    pub fn empty_line_after(self) -> bool {
        self.after
    }

    /// The height a break adds to its paragraph in CSS pixels at 100% zoom:
    /// `.docs-page-break-marker` (20 px tall, 10 px margins) and its empty
    /// line of `line_px`.
    pub fn added_px(self, line_px: f32) -> f32 {
        if !self.before && !self.after {
            return 0.0;
        }
        BREAK_MARKER_PX + 2.0 * BREAK_MARGIN_PX + line_px
    }
}

/// `.docs-page-break-marker`: 20 px tall with 10 px above and below.
pub const BREAK_MARKER_PX: f32 = 20.0;
pub const BREAK_MARGIN_PX: f32 = 10.0;

/// `.docs-workspace .docs-word-image`: a block button with 10 px vertical
/// margins and the workspace buttons' 1 px border.
pub const PICTURE_MARGIN_PX: f32 = 10.0;
pub const PICTURE_BORDER_PX: f32 = 1.0;

/// CSS margin collapsing between siblings: the gap is the larger margin, so
/// a box whose neighbour already left `previous` adds only the excess.
pub fn collapsed(margin: f32, previous: f32) -> f32 {
    (margin - previous).max(0.0)
}

/// `.docs-word-table td`: 7 px padding, 1 px collapsed borders, 60 px min.
pub const CELL_PADDING_PX: f32 = 7.0;
pub const CELL_MIN_PX: f32 = 60.0;

/// Chromium's automatic table layout when the table is wider than its
/// content: every column gets its max-content width (cell padding and
/// border included, never under the cell minimum) and the spare width is
/// shared in proportion to those widths. The result is each column's share
/// of the table width. `content` holds each column's widest unwrapped text.
pub fn column_fractions(content: &[f32], zoom: f32) -> Vec<f32> {
    let widths: Vec<f32> = content
        .iter()
        .map(|w| (w + (2.0 * CELL_PADDING_PX + 1.0) * zoom).max(CELL_MIN_PX * zoom))
        .collect();
    let total: f32 = widths.iter().sum();
    if total <= 0.0 {
        return vec![1.0 / content.len().max(1) as f32; content.len()];
    }
    widths.iter().map(|w| w / total).collect()
}

/// Electron's `::-webkit-scrollbar { width: 6px }` (`globals.css`): the
/// scroller gives up 6 px of width once its content is taller than it.
pub const SCROLLBAR_PX: f32 = 6.0;

/// Where Chromium puts the scrollbar thumb: its top and length in a track
/// `track` tall, for a viewport over `content` scrolled down by `offset`.
/// None when nothing overflows.
pub fn scrollbar_thumb(viewport: f32, content: f32, offset: f32, track: f32) -> Option<(f32, f32)> {
    if viewport <= 0.0 || content <= viewport + 0.5 {
        return None;
    }
    let len = (track * viewport / content).max(SCROLLBAR_PX).min(track);
    let range = content - viewport;
    Some((offset.clamp(0.0, range) / range * (track - len), len))
}

/// The scroll offset that puts the thumb's top at `top`.
pub fn scrollbar_offset(viewport: f32, content: f32, top: f32, track: f32) -> f32 {
    let Some((_, len)) = scrollbar_thumb(viewport, content, 0.0, track) else { return 0.0 };
    let room = (track - len).max(1.0);
    (top / room).clamp(0.0, 1.0) * (content - viewport)
}

pub fn break_hint(doc: &RichDocument, block: &Block) -> BreakHint {
    let Block::Paragraph(id) = block else { return BreakHint::default() };
    let mut hint = BreakHint::default();
    for page_break in doc.page_breaks.iter().filter(|b| &b.paragraph_id == id) {
        let text_len = doc.paragraph(id).map_or(0, |p| p.text.len());
        if page_break.offset == 0 && text_len > 0 {
            hint.before = true;
        } else {
            hint.after = true;
        }
    }
    hint
}

/// Assign blocks to pages from their measured heights (in pixels, spacing
/// included). A block taller than a page gets a page of its own and runs
/// over; pages never split a block.
pub fn paginate(heights: &[f32], hints: &[BreakHint], content_height: f32) -> Vec<Vec<usize>> {
    let mut pages: Vec<Vec<usize>> = vec![Vec::new()];
    let mut used = 0.0;
    let mut force = false;
    for (index, height) in heights.iter().copied().enumerate() {
        let hint = hints.get(index).copied().unwrap_or_default();
        let current = pages.last().unwrap();
        let overflow = used + height > content_height + 0.5;
        if !current.is_empty() && (force || hint.before || overflow) {
            pages.push(Vec::new());
            used = 0.0;
        }
        pages.last_mut().unwrap().push(index);
        used += height;
        force = hint.after;
    }
    pages
}

#[cfg(test)]
mod tests {
    use super::*;
    use markie_office::model::RunStyle;

    fn paragraph(style: Option<&str>) -> Paragraph {
        Paragraph { id: "p".into(), style_id: style.map(Into::into), ..Default::default() }
    }

    fn run(style: RunStyle) -> Run {
        Run {
            id: "r".into(),
            text: "x".into(),
            style,
            resolved_style: None,
            can_edit: true,
            hyperlink_id: None,
            target: None,
            page_breaks: vec![],
        }
    }

    #[test]
    fn pages_fill_until_the_next_block_overflows() {
        let pages = paginate(&[100.0, 100.0, 100.0, 50.0], &[BreakHint::default(); 4], 250.0);
        assert_eq!(pages, vec![vec![0, 1], vec![2, 3]]);
    }

    #[test]
    fn explicit_breaks_start_new_pages() {
        let hints = [BreakHint { after: true, before: false }, BreakHint::default(), BreakHint { before: true, after: false }];
        let pages = paginate(&[10.0, 10.0, 10.0], &hints, 1000.0);
        assert_eq!(pages, vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn a_block_taller_than_a_page_gets_its_own_page() {
        let pages = paginate(&[50.0, 900.0, 50.0], &[BreakHint::default(); 3], 500.0);
        assert_eq!(pages, vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn an_empty_document_has_one_empty_page() {
        assert_eq!(paginate(&[], &[], 500.0), vec![Vec::<usize>::new()]);
    }

    #[test]
    fn a_break_on_the_first_block_does_not_leave_a_blank_page() {
        let pages = paginate(&[10.0], &[BreakHint { before: true, after: false }], 500.0);
        assert_eq!(pages, vec![vec![0]]);
    }

    #[test]
    fn a_break_keeps_a_line_on_its_open_side() {
        let opens = BreakHint { before: true, after: false };
        let ends = BreakHint { before: false, after: true };
        assert!(opens.empty_line_before() && !opens.empty_line_after());
        assert!(ends.empty_line_after() && !ends.empty_line_before());
        // Electron's sample: Georgia 12 pt at line height 1.4 is 22.4 px, so
        // the break adds 62.4 px; without the empty line it sat 22.4 px high.
        assert!((opens.added_px(22.4) - 62.4).abs() < 0.001);
        assert_eq!(BreakHint::default().added_px(22.4), 0.0);
    }

    #[test]
    fn picture_margins_collapse_with_the_paragraph_above() {
        // 8 pt after the paragraph is 10.67 px, more than the picture's 10.
        let after = DEFAULT_AFTER_POINTS as f32 * PX_PER_POINT;
        assert_eq!(collapsed(PICTURE_MARGIN_PX, after), 0.0);
        assert_eq!(collapsed(PICTURE_MARGIN_PX, 0.0), 10.0);
        // The sample's 120 px picture with the list after it: 10.67 above,
        // a 122 px button, 10 below; it was 4 + 120 + 4 below the paragraph.
        let block = after + collapsed(PICTURE_MARGIN_PX, after) + 120.0 + 2.0 * PICTURE_BORDER_PX + PICTURE_MARGIN_PX;
        assert!((block - 142.667).abs() < 0.01);
    }

    #[test]
    fn the_scrollbar_thumb_follows_the_viewport() {
        // The sample page view: 704.5 px of a 1116 px page column.
        let (top, len) = scrollbar_thumb(704.5, 1116.0, 0.0, 704.5).unwrap();
        assert_eq!(top, 0.0);
        assert!((len - 444.7).abs() < 0.1);
        let (bottom, _) = scrollbar_thumb(704.5, 1116.0, 411.5, 704.5).unwrap();
        assert!((bottom + len - 704.5).abs() < 0.01);
        assert!(scrollbar_thumb(700.0, 700.0, 0.0, 700.0).is_none());
        assert!((scrollbar_offset(704.5, 1116.0, bottom, 704.5) - 411.5).abs() < 0.01);
    }

    #[test]
    fn table_columns_share_width_by_content() {
        let fractions = column_fractions(&[36.0, 94.0, 89.0], 1.0);
        // Name falls back to the 60 px minimum; the others are text + 15.
        let expected = [60.0 / 273.0, 109.0 / 273.0, 104.0 / 273.0];
        for (got, want) in fractions.iter().zip(expected) {
            assert!((got - want).abs() < 0.0001, "{got} vs {want}");
        }
        assert_eq!(column_fractions(&[0.0, 0.0], 1.0), vec![0.5, 0.5]);
        assert!(column_fractions(&[], 1.0).is_empty());
    }

    #[test]
    fn resolved_styles_win_and_headings_fall_back() {
        let resolved = Run { resolved_style: Some(RunStyle { font_size_points: Some(18.0), ..Default::default() }), ..run(RunStyle::default()) };
        assert_eq!(run_look(&resolved, &paragraph(Some("Heading1"))).size_points, 18.0);
        let bare = run(RunStyle::default());
        let look = run_look(&bare, &paragraph(Some("Heading1")));
        assert_eq!((look.size_points, look.bold), (20.0, true));
        assert_eq!(run_look(&bare, &paragraph(None)).size_points, DEFAULT_SIZE_POINTS);
    }

    #[test]
    fn links_underline_unless_told_not_to() {
        let mut link = run(RunStyle::default());
        link.hyperlink_id = Some("h".into());
        assert!(run_look(&link, &paragraph(None)).underline);
        link.style.underline = Some("none".into());
        assert!(!run_look(&link, &paragraph(None)).underline);
    }

    #[test]
    fn list_paragraphs_indent_and_mark() {
        let mut p = paragraph(None);
        p.list_kind = Some(ListKind::Numbered);
        p.list_number = Some(3);
        p.list_level = Some(1);
        let look = paragraph_look(&p);
        assert_eq!((look.indent_px, look.marker.as_deref()), (48.0, Some("3.")));
        assert_eq!(paragraph_look(&paragraph(None)).after_points, DEFAULT_AFTER_POINTS);
    }

    #[test]
    fn a_paragraph_takes_the_size_most_of_its_text_has() {
        let mut p = paragraph(None);
        let mut big = run(RunStyle { font_size_points: Some(18.0), ..Default::default() });
        big.text = "ab".into();
        let mut small = run(RunStyle { font_size_points: Some(10.0), ..Default::default() });
        small.text = "abcdef".into();
        p.runs = vec![big, small];
        assert_eq!(paragraph_size_points(&p), 10.0);
        assert_eq!(paragraph_size_points(&paragraph(Some("Heading2"))), 16.0);
        assert_eq!(paragraph_size_points(&paragraph(None)), DEFAULT_SIZE_POINTS);
    }

    #[test]
    fn invalid_colors_do_not_reach_the_page() {
        let colored = run(RunStyle { color: Some("auto".into()), ..Default::default() });
        assert_eq!(run_look(&colored, &paragraph(None)).color, None);
    }
}
