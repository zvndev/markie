//! A paragraph painter for Word pages, as a browser lays out an inline run of
//! spans: every run keeps its own size, runs share one baseline per line,
//! lines wrap after spaces, and a line can be justified.
//!
//! GPUI's `StyledText` shapes a whole element at one size and has no
//! justified alignment, so the page view paints paragraphs with this instead.
//! Runs of one size are shaped once through the text system's line cache and
//! split at break points, so no glyph is shaped twice in a frame.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowAlign {
    Left,
    Center,
    Right,
    Justify,
}

/// One styled run and the size it is shaped at.
#[derive(Clone)]
pub struct FlowRun {
    pub run: TextRun,
    pub size: Pixels,
}

struct Piece {
    start: usize,
    end: usize,
    x: Pixels,
    line: ShapedLine,
    /// The run's own CSS line height (size × multiple).
    line_height: Pixels,
    /// Top of this piece's line box, below the line's top.
    top: Pixels,
}

struct Line {
    top: Pixels,
    height: Pixels,
    start: usize,
    end: usize,
    /// Where an empty line draws its caret.
    empty_x: Pixels,
    pieces: Vec<Piece>,
}

struct Laid {
    wrap: Option<Pixels>,
    lines: Vec<Line>,
    origin: Point<Pixels>,
    size: Size<Pixels>,
    text: SharedString,
}

/// The layout of one painted paragraph, kept from the last frame for carets,
/// clicks and the input method.
#[derive(Clone, Default)]
pub struct FlowLayout(Rc<RefCell<Option<Laid>>>);

struct Token {
    start: usize,
    end: usize,
    line: ShapedLine,
    width: Pixels,
    /// Width without the trailing spaces, which never count against the wrap.
    fit: Pixels,
    breakable: bool,
    forced: bool,
    line_height: Pixels,
}

struct Spec {
    text: SharedString,
    runs: Vec<FlowRun>,
    align: FlowAlign,
    multiple: f32,
    /// The paragraph's own font and size: the strut every line is at least as tall as.
    strut: TextRun,
    strut_size: Pixels,
}

fn tokens(spec: &Spec, window: &mut Window) -> Vec<Token> {
    let text = spec.text.as_ref();
    let system = window.text_system().clone();
    let mut out = Vec::new();
    let mut at = 0;
    let mut i = 0;
    while i < spec.runs.len() && at < text.len() {
        // Consecutive runs of one size shape together.
        let size = spec.runs[i].size;
        let mut runs = Vec::new();
        let mut end = at;
        while i < spec.runs.len() && spec.runs[i].size == size {
            let len = spec.runs[i].run.len.min(text.len() - end);
            if len > 0 {
                runs.push(TextRun { len, ..spec.runs[i].run.clone() });
            }
            end += len;
            i += 1;
        }
        if end == at {
            continue;
        }
        let piece = &text[at..end];
        // Newlines are forced breaks; they shape as a space of the same byte length.
        let shaped_text: SharedString = if piece.contains('\n') { piece.replace('\n', " ").into() } else { SharedString::from(piece.to_string()) };
        let mut rest = system.shape_line(shaped_text, size, &runs, None);
        let line_height = size * spec.multiple;
        let mut from = 0;
        let mut j = 0;
        while j < piece.len() {
            let ch = piece[j..].chars().next().unwrap_or(' ');
            j += ch.len_utf8();
            let forced = ch == '\n';
            let breakable = forced || (ch.is_whitespace() && piece[j..].chars().next().is_none_or(|next| !next.is_whitespace() || next == '\n'));
            if !(breakable || j >= piece.len()) {
                continue;
            }
            let (head, tail) = rest.split_at(j - from);
            let token_text = &piece[from..j];
            let trimmed = token_text.trim_end().len();
            let width = head.width();
            let fit = head.x_for_index(trimmed);
            out.push(Token { start: at + from, end: at + j, line: head, width, fit, breakable: breakable || ch.is_whitespace(), forced, line_height });
            rest = tail;
            from = j;
        }
        at = end;
    }
    out
}

fn split_token(token: Token, room: Pixels, text: &str) -> (Token, Token) {
    let local = &text[token.start..token.end];
    let mut cut = token.line.closest_index_for_x(room).min(local.len());
    while cut > 0 && (!local.is_char_boundary(cut) || token.line.x_for_index(cut) > room) {
        cut -= 1;
    }
    if cut == 0 {
        cut = local.chars().next().map_or(local.len(), char::len_utf8);
    }
    let (head, tail) = token.line.split_at(cut);
    let head_width = head.width();
    let tail_width = tail.width();
    let tail_fit = (token.fit - head_width).max(px(0.));
    (
        Token { start: token.start, end: token.start + cut, width: head_width, fit: head_width, line: head, breakable: false, forced: false, line_height: token.line_height },
        Token { start: token.start + cut, end: token.end, width: tail_width, fit: tail_fit, line: tail, ..token },
    )
}

fn build(spec: &Spec, wrap: Option<Pixels>, window: &mut Window) -> Laid {
    let text = spec.text.as_ref();
    let strut = window.text_system().shape_line(" ".into(), spec.strut_size, &[TextRun { len: 1, ..spec.strut.clone() }], None);
    let strut_height = spec.strut_size * spec.multiple;
    let strut_half = (strut_height - (strut.ascent + strut.descent)) / 2.0;
    let (strut_above, strut_below) = (strut_half + strut.ascent, strut_half + strut.descent);

    // Group tokens into lines.
    let mut rows: Vec<(Vec<Token>, bool)> = Vec::new();
    let mut row: Vec<Token> = Vec::new();
    let mut x = px(0.);
    let mut pending: Vec<Token> = Vec::new();
    let mut all = tokens(spec, window).into_iter().peekable();
    let limit = wrap.unwrap_or(px(f32::MAX));
    loop {
        // One unbreakable group: tokens up to and including a break point.
        pending.clear();
        while let Some(token) = all.next() {
            let stop = token.breakable || token.forced;
            pending.push(token);
            if stop {
                break;
            }
        }
        if pending.is_empty() {
            break;
        }
        let group_fit = pending.iter().rev().skip(1).map(|t| t.width).fold(px(0.), |a, b| a + b) + pending.last().map_or(px(0.), |t| t.fit);
        if !row.is_empty() && x + group_fit > limit {
            rows.push((std::mem::take(&mut row), false));
            x = px(0.);
        }
        for mut token in pending.drain(..) {
            while x + token.fit > limit && token.end - token.start > 1 && token.line.x_for_index(1) < token.fit {
                let room = limit - x;
                if room <= px(0.) && !row.is_empty() {
                    rows.push((std::mem::take(&mut row), false));
                    x = px(0.);
                    continue;
                }
                let (head, tail) = split_token(token, room.max(px(0.)), text);
                row.push(head);
                rows.push((std::mem::take(&mut row), false));
                x = px(0.);
                token = tail;
            }
            x += token.width;
            let forced = token.forced;
            row.push(token);
            if forced {
                rows.push((std::mem::take(&mut row), true));
                x = px(0.);
            }
        }
    }
    let trailing_break = rows.last().is_some_and(|(_, forced)| *forced);
    if !row.is_empty() || rows.is_empty() || trailing_break {
        rows.push((row, true));
    }
    if let Some(last) = rows.last_mut() {
        last.1 = true;
    }

    let width = wrap.unwrap_or_else(|| rows.iter().map(|(r, _)| r.iter().map(|t| t.width).fold(px(0.), |a, b| a + b)).fold(px(0.), Pixels::max));
    let mut lines = Vec::new();
    let mut top = px(0.);
    let mut cursor = 0;
    for (row, last) in rows {
        let mut above = strut_above;
        let mut below = strut_below;
        for t in &row {
            let half = (t.line_height - (t.line.ascent + t.line.descent)) / 2.0;
            above = above.max(half + t.line.ascent);
            below = below.max(half + t.line.descent);
        }
        let content = row.iter().rev().skip(1).map(|t| t.width).fold(px(0.), |a, b| a + b) + row.last().map_or(px(0.), |t| t.fit);
        let free = (width - content).max(px(0.));
        let (mut x, gap) = match spec.align {
            FlowAlign::Left => (px(0.), px(0.)),
            FlowAlign::Center => (free / 2.0, px(0.)),
            FlowAlign::Right => (free, px(0.)),
            FlowAlign::Justify => {
                let gaps = row.iter().rev().skip(1).filter(|t| t.breakable).count();
                if last || gaps == 0 { (px(0.), px(0.)) } else { (px(0.), free / gaps as f32) }
            }
        };
        let start = row.first().map_or(cursor, |t| t.start);
        let end = row.last().map_or(cursor, |t| t.end);
        let empty_x = x;
        let count = row.len();
        let pieces = row
            .into_iter()
            .enumerate()
            .map(|(n, t)| {
                let half = (t.line_height - (t.line.ascent + t.line.descent)) / 2.0;
                let piece = Piece { start: t.start, end: t.end, x, top: above - (half + t.line.ascent), line_height: t.line_height, line: t.line };
                x += t.width;
                if n + 1 < count && t.breakable {
                    x += gap;
                }
                piece
            })
            .collect();
        let height = above + below;
        lines.push(Line { top, height, start, end, empty_x, pieces });
        top += height;
        cursor = end;
    }
    Laid { wrap, lines, origin: Point::default(), size: size(width, top), text: spec.text.clone() }
}

impl FlowLayout {
    pub fn bounds(&self) -> Bounds<Pixels> {
        self.0.borrow().as_ref().map_or_else(Bounds::default, |l| Bounds::new(l.origin, l.size))
    }

    /// Where the caret before byte `index` is drawn, and how tall it is.
    pub fn caret(&self, index: usize) -> (Point<Pixels>, Pixels) {
        let laid = self.0.borrow();
        let Some(laid) = laid.as_ref() else { return (Point::default(), px(16.)) };
        let Some(line) = line_for(laid, index) else { return (laid.origin, px(16.)) };
        let x = match line.pieces.iter().find(|p| index >= p.start && index < p.end).or_else(|| line.pieces.last().filter(|p| index >= p.end)) {
            Some(p) => p.x + p.line.x_for_index(index.min(p.end) - p.start),
            None => line.pieces.iter().find(|p| index <= p.start).map_or(line.empty_x, |p| p.x),
        };
        (point(laid.origin.x + x, laid.origin.y + line.top), line.height)
    }

    /// The byte index nearest a window point.
    pub fn index_at(&self, position: Point<Pixels>) -> usize {
        let laid = self.0.borrow();
        let Some(laid) = laid.as_ref() else { return 0 };
        let y = position.y - laid.origin.y;
        let Some(number) = laid.lines.iter().position(|l| y < l.top + l.height).or(laid.lines.len().checked_sub(1)) else { return 0 };
        let line = &laid.lines[number];
        let last = number + 1 == laid.lines.len();
        let x = position.x - laid.origin.x;
        let Some(first) = line.pieces.first() else { return line.start };
        if x <= first.x {
            return line.start;
        }
        for p in &line.pieces {
            if x < p.x + p.line.width() {
                return p.start + p.line.closest_index_for_x(x - p.x).min(p.end - p.start);
            }
        }
        line_end(laid, line, last)
    }

    /// The start or end of the visual line holding byte `index`.
    pub fn line_edge(&self, index: usize, end: bool) -> usize {
        let laid = self.0.borrow();
        let Some(laid) = laid.as_ref() else { return index };
        let Some(number) = laid.lines.iter().position(|l| index >= l.start && (index < l.end || l.start == l.end)).or(laid.lines.len().checked_sub(1)) else {
            return index;
        };
        let line = &laid.lines[number];
        if end { line_end(laid, line, number + 1 == laid.lines.len()) } else { line.start }
    }
}

/// The last caret position on a line: before its trailing space when the
/// text wraps, so the caret stays on that line.
fn line_end(laid: &Laid, line: &Line, last: bool) -> usize {
    if last {
        return line.end;
    }
    let text = laid.text.as_ref();
    let mut end = line.end;
    while end > line.start && text[..end].ends_with(|c: char| c.is_whitespace() && c != '\n') {
        end -= text[..end].chars().next_back().map_or(1, char::len_utf8);
    }
    if text[..line.end].ends_with('\n') { line.end - 1 } else { end }
}

fn line_for(laid: &Laid, index: usize) -> Option<&Line> {
    laid.lines
        .iter()
        .find(|l| index >= l.start && index < l.end)
        .or_else(|| laid.lines.iter().rev().find(|l| index >= l.start))
        .or(laid.lines.first())
}

/// The element. Build one per frame; its `layout()` handle answers caret and
/// click questions about what was painted.
pub struct FlowText {
    spec: Rc<Spec>,
    layout: FlowLayout,
}

impl FlowText {
    pub fn new(text: impl Into<SharedString>, runs: Vec<FlowRun>, align: FlowAlign, multiple: f32, strut: TextRun, strut_size: Pixels) -> Self {
        let spec = Spec { text: text.into(), runs, align, multiple, strut, strut_size };
        Self { spec: Rc::new(spec), layout: FlowLayout::default() }
    }

    pub fn layout(&self) -> &FlowLayout {
        &self.layout
    }
}

impl IntoElement for FlowText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for FlowText {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, _: &mut App) -> (LayoutId, ()) {
        let spec = self.spec.clone();
        let state = self.layout.clone();
        let id = window.request_measured_layout(Default::default(), move |known, available, window, _| {
            let wrap = known.width.or(match available.width {
                AvailableSpace::Definite(width) => Some(width),
                _ => None,
            });
            if let Some(laid) = state.0.borrow().as_ref()
                && laid.wrap == wrap
            {
                return laid.size;
            }
            let laid = build(&spec, wrap, window);
            let size = laid.size;
            *state.0.borrow_mut() = Some(laid);
            size
        });
        (id, ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, _: &mut App) {
        let stale = self.layout.0.borrow().as_ref().is_none_or(|l| l.wrap != Some(bounds.size.width));
        if stale {
            *self.layout.0.borrow_mut() = Some(build(&self.spec, Some(bounds.size.width), window));
        }
        if let Some(laid) = self.layout.0.borrow_mut().as_mut() {
            laid.origin = bounds.origin;
        }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), _: &mut (), window: &mut Window, cx: &mut App) {
        let laid = self.layout.0.borrow();
        let Some(laid) = laid.as_ref() else { return };
        for background in [true, false] {
            for line in &laid.lines {
                for p in &line.pieces {
                    let origin = point(laid.origin.x + p.x, laid.origin.y + line.top + p.top);
                    let _ = if background {
                        p.line.paint_background(origin, p.line_height, TextAlign::Left, None, window, cx)
                    } else {
                        p.line.paint(origin, p.line_height, TextAlign::Left, None, window, cx)
                    };
                }
            }
        }
    }
}
