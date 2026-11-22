//! Inline layout for one leaf: our own line breaking over shaped runs.
//!
//! GPUI's `StyledText` takes one font size for a whole text and no inline
//! boxes, and a rich editor needs both: the `fontSize` mark sizes a run, and
//! an inline formula is a picture in the line. So each run is shaped on its
//! own (GPUI caches the shaping per frame), words are placed greedily, and
//! every line takes the tallest ascent and descent on it. The same structure
//! answers caret positions and clicks.

use std::ops::Range;
use std::sync::Arc;

use gpui_kit::*;

/// How a run of text looks.
#[derive(Clone, Debug)]
pub struct SegStyle {
    pub font: Font,
    pub size: Pixels,
    pub color: Hsla,
    pub background: Option<Hsla>,
    pub underline: bool,
    pub strike: bool,
    /// Room inside the run's background at its two ends (inline code's
    /// `padding: 0.2em 0.4em`). Zero for plain text.
    pub pad_x: Pixels,
    /// A hairline round the background (inline code's `border`).
    pub border: Option<Hsla>,
}

#[derive(Clone)]
pub enum SegKind {
    Text(String, SegStyle),
    /// An inline picture (a formula): its size and where its baseline is
    /// from its top. Without a picture yet, the fallback text is drawn.
    Box { width: Pixels, height: Pixels, baseline: Pixels, image: Option<Arc<Image>>, fallback: Option<(String, SegStyle)> },
    /// A line break (a hard break, or a newline in code).
    Break,
}

#[derive(Clone)]
pub struct Seg {
    pub kind: SegKind,
    /// The leaf units this segment stands for.
    pub units: Range<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Clone)]
pub struct LeafSpec {
    pub segs: Vec<Seg>,
    /// The style of an empty leaf (for its height and the caret).
    pub base: SegStyle,
    /// Line height as a multiple of each run's font size.
    pub line_height: f32,
    pub align: Align,
    pub len: usize,
}

enum PlacedKind {
    /// `lead` is the padding before the glyphs; `seg` groups the pieces of
    /// one run so its background is drawn as one box.
    Text { shaped: ShapedLine, style: SegStyle, chars: Vec<usize>, lead: Pixels, seg: usize },
    Box { height: Pixels, baseline: Pixels, image: Option<Arc<Image>>, fallback: Option<ShapedLine> },
    Break,
}

struct Placed {
    units: Range<usize>,
    x: Pixels,
    width: Pixels,
    ascent: Pixels,
    descent: Pixels,
    line: usize,
    kind: PlacedKind,
}

#[derive(Clone, Debug)]
pub struct Line {
    pub top: Pixels,
    pub height: Pixels,
    /// Baseline distance from the line's top.
    pub baseline: Pixels,
    pub units: Range<usize>,
    pub x_offset: Pixels,
    items: Range<usize>,
}

pub struct Laid {
    pub width: Pixels,
    pub height: Pixels,
    pub lines: Vec<Line>,
    items: Vec<Placed>,
    pub len: usize,
}

fn run(text_len: usize, s: &SegStyle) -> TextRun {
    TextRun {
        len: text_len,
        font: s.font.clone(),
        color: s.color,
        background_color: None,
        underline: s.underline.then(|| UnderlineStyle { thickness: px(1.), color: Some(s.color), wavy: false }),
        strikethrough: s.strike.then(|| StrikethroughStyle { thickness: px(1.), color: Some(s.color) }),
    }
}

fn shape(text: &str, s: &SegStyle, window: &Window) -> ShapedLine {
    window.text_system().shape_line(SharedString::from(text.to_string()), s.size, &[run(text.len(), s)], None)
}

/// Byte offset of each char in `text`, plus the end.
fn char_bytes(text: &str) -> Vec<usize> {
    let mut v: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    v.push(text.len());
    v
}

fn metrics(s: &SegStyle, window: &Window) -> (Pixels, Pixels) {
    let ts = window.text_system();
    let id = ts.resolve_font(&s.font);
    (ts.ascent(id, s.size), ts.descent(id, s.size))
}

/// A shaped word (or a picture, or a break) before it is placed.
struct Piece {
    units: Range<usize>,
    kind: PlacedKind,
    width: Pixels,
    ascent: Pixels,
    descent: Pixels,
    /// Width without trailing spaces: what has to fit on the line.
    fit: Pixels,
    /// No space after it: it and the next piece are one word ("**a**," is
    /// two runs and no break opportunity).
    joins_next: bool,
    text: Option<(String, SegStyle)>,
}

fn pieces(spec: &LeafSpec, window: &Window) -> Vec<Piece> {
    let mut out = Vec::new();
    for (seg_index, seg) in spec.segs.iter().enumerate() {
        match &seg.kind {
            SegKind::Break => out.push(Piece {
                units: seg.units.clone(),
                kind: PlacedKind::Break,
                width: px(0.),
                ascent: px(0.),
                descent: px(0.),
                fit: px(0.),
                joins_next: false,
                text: None,
            }),
            SegKind::Box { width: w, height, baseline, image, fallback } => {
                let fb = fallback.as_ref().filter(|_| image.is_none()).map(|(t, s)| shape(t, s, window));
                let (w, asc, desc) = match &fb {
                    Some(f) => (f.width, f.ascent, f.descent),
                    None => (*w, *baseline, *height - *baseline),
                };
                out.push(Piece {
                    units: seg.units.clone(),
                    kind: PlacedKind::Box { height: *height, baseline: *baseline, image: image.clone(), fallback: fb },
                    width: w,
                    ascent: asc,
                    descent: desc,
                    fit: w,
                    joins_next: false,
                    text: None,
                });
            }
            SegKind::Text(text, style) => {
                let chars: Vec<(usize, char)> = text.char_indices().collect();
                let mut k = 0usize;
                let first_piece = out.len();
                while k < chars.len() {
                    let start = k;
                    while k < chars.len() && !chars[k].1.is_whitespace() {
                        k += 1;
                    }
                    while k < chars.len() && chars[k].1.is_whitespace() {
                        k += 1;
                    }
                    let b0 = chars[start].0;
                    let b1 = if k < chars.len() { chars[k].0 } else { text.len() };
                    let piece = &text[b0..b1];
                    let shaped = shape(piece, style, window);
                    let trimmed = piece.trim_end();
                    let fit = shaped.x_for_index(trimmed.len());
                    let lead = if out.len() == first_piece { style.pad_x } else { px(0.) };
                    let trail = if k >= chars.len() { style.pad_x } else { px(0.) };
                    out.push(Piece {
                        units: seg.units.start + start..seg.units.start + k,
                        width: lead + shaped.width + trail,
                        ascent: shaped.ascent,
                        descent: shaped.descent,
                        fit: lead + fit + trail,
                        joins_next: trimmed.len() == piece.len(),
                        kind: PlacedKind::Text { chars: char_bytes(piece), shaped, style: style.clone(), lead, seg: seg_index },
                        text: Some((piece.to_string(), style.clone())),
                    });
                }
            }
        }
    }
    out
}

/// Lay the leaf out in `width`.
pub fn layout(spec: &LeafSpec, width: Pixels, window: &Window) -> Laid {
    let width = width.max(px(20.));
    let ps = pieces(spec, window);
    let mut items: Vec<Placed> = Vec::new();
    let mut line = 0usize;
    let mut x = px(0.);
    let mut line_has = false;
    let place = |p: Piece, x: &mut Pixels, line: usize, items: &mut Vec<Placed>| {
        items.push(Placed { units: p.units, x: *x, width: p.width, ascent: p.ascent, descent: p.descent, line, kind: p.kind });
        *x += p.width;
    };
    let mut ps = ps.into_iter().peekable();
    let mut group: Vec<Piece> = Vec::new();
    loop {
        // The next word: pieces up to one that ends in a space.
        group.clear();
        while let Some(p) = ps.peek() {
            if matches!(p.kind, PlacedKind::Break) && !group.is_empty() {
                break;
            }
            let p = ps.next().unwrap();
            let done = matches!(p.kind, PlacedKind::Break) || !p.joins_next;
            group.push(p);
            if done {
                break;
            }
        }
        if group.is_empty() {
            break;
        }
        if matches!(group[0].kind, PlacedKind::Break) {
            let p = group.remove(0);
            items.push(Placed { units: p.units, x, width: px(0.), ascent: px(0.), descent: px(0.), line, kind: PlacedKind::Break });
            line += 1;
            x = px(0.);
            line_has = false;
            continue;
        }
        let n = group.len();
        let fit: Pixels = group[..n - 1].iter().map(|p| p.width).fold(px(0.), |a, b| a + b) + group[n - 1].fit;
        if line_has && x + fit > width {
            line += 1;
            x = px(0.);
            line_has = false;
        }
        if fit <= width - x || line_has {
            for p in group.drain(..) {
                place(p, &mut x, line, &mut items);
            }
            line_has = true;
            continue;
        }
        // A word longer than the line: piece by piece, cutting a piece
        // where it overflows.
        for p in group.drain(..) {
            if line_has && x + p.fit > width {
                line += 1;
                x = px(0.);
                line_has = false;
            }
            let Some((text, style)) = p.text.clone().filter(|_| p.fit > width - x) else {
                place(p, &mut x, line, &mut items);
                line_has = true;
                continue;
            };
            let seg = match &p.kind {
                PlacedKind::Text { seg, .. } => *seg,
                _ => usize::MAX,
            };
            let mut piece: &str = &text;
            let mut unit0 = p.units.start;
            while !piece.is_empty() {
                let shaped = shape(piece, &style, window);
                if shaped.x_for_index(piece.trim_end().len()) <= width - x || piece.chars().count() == 1 {
                    let n = piece.chars().count();
                    let w = shaped.width;
                    items.push(Placed {
                        units: unit0..unit0 + n,
                        x,
                        width: w,
                        ascent: shaped.ascent,
                        descent: shaped.descent,
                        line,
                        kind: PlacedKind::Text { chars: char_bytes(piece), shaped, style: style.clone(), lead: px(0.), seg },
                    });
                    x += w;
                    line_has = true;
                    break;
                }
                let mut cut = shaped.closest_index_for_x(width - x).min(piece.len());
                while cut > 0 && !piece.is_char_boundary(cut) {
                    cut -= 1;
                }
                if cut == 0 {
                    if line_has {
                        line += 1;
                        x = px(0.);
                        line_has = false;
                        continue;
                    }
                    cut = piece.chars().next().unwrap().len_utf8();
                }
                let head = &piece[..cut];
                let n = head.chars().count();
                let hs = shape(head, &style, window);
                items.push(Placed {
                    units: unit0..unit0 + n,
                    x,
                    width: hs.width,
                    ascent: hs.ascent,
                    descent: hs.descent,
                    line,
                    kind: PlacedKind::Text { chars: char_bytes(head), shaped: hs, style: style.clone(), lead: px(0.), seg },
                });
                line += 1;
                x = px(0.);
                line_has = false;
                unit0 += n;
                piece = &piece[cut..];
            }
        }
    }
    // Lines.
    let (base_asc, base_desc) = metrics(&spec.base, window);
    let line_count = line + 1;
    let mut lines: Vec<Line> = Vec::with_capacity(line_count);
    let mut top = px(0.);
    let mut idx = 0usize;
    for l in 0..line_count {
        let start = idx;
        while idx < items.len() && items[idx].line == l {
            idx += 1;
        }
        let range = start..idx;
        let mut asc = px(0.);
        let mut desc = px(0.);
        let mut lh = px(0.);
        let mut any = false;
        let mut w = px(0.);
        for it in &items[range.clone()] {
            if matches!(it.kind, PlacedKind::Break) {
                continue;
            }
            any = true;
            asc = asc.max(it.ascent);
            desc = desc.max(it.descent);
            let size = match &it.kind {
                PlacedKind::Text { style, .. } => style.size,
                _ => spec.base.size,
            };
            lh = lh.max(size * spec.line_height);
            w = w.max(it.x + it.width);
        }
        if !any {
            asc = base_asc;
            desc = base_desc;
            lh = spec.base.size * spec.line_height;
        }
        let height = lh.max(asc + desc);
        let baseline = (height - (asc + desc)) / 2. + asc;
        let units = if range.is_empty() {
            // An empty line: at the unit after the break before it.
            let at = if start > 0 { items[start - 1].units.end } else { 0 };
            at..at
        } else {
            items[range.start].units.start..items[range.end - 1].units.end
        };
        let x_offset = match spec.align {
            Align::Left => px(0.),
            Align::Center => ((width - w) / 2.).max(px(0.)),
            Align::Right => (width - w).max(px(0.)),
        };
        lines.push(Line { top, height, baseline, units, x_offset, items: range });
        top += height;
    }
    Laid { width, height: top, lines, items, len: spec.len }
}

impl Laid {
    /// The line holding unit `u`. At a soft wrap the caret goes to the
    /// line that starts there, unless `upstream` keeps it at the end of the
    /// line before.
    pub fn line_of(&self, u: usize, upstream: bool) -> usize {
        let n = self.lines.len();
        for (i, l) in self.lines.iter().enumerate() {
            if u >= l.units.start && u < l.units.end {
                if self.ends_with_break(i) && u + 1 == l.units.end {
                    return i; // just before the break
                }
                return i;
            }
            if u == l.units.end {
                if self.ends_with_break(i) && l.units.end > l.units.start {
                    continue; // after a break: the next line
                }
                if upstream || i + 1 == n {
                    return i;
                }
            }
        }
        n.saturating_sub(1)
    }

    fn ends_with_break(&self, line: usize) -> bool {
        let l = &self.lines[line];
        l.items.end > l.items.start && matches!(self.items[l.items.end - 1].kind, PlacedKind::Break)
    }

    /// x of unit `u` on line `line`, relative to the leaf.
    pub fn x_of(&self, u: usize, line: usize) -> Pixels {
        let l = &self.lines[line];
        let mut last_end = px(0.);
        for it in &self.items[l.items.clone()] {
            if u <= it.units.start {
                return l.x_offset + it.x;
            }
            if u <= it.units.end {
                let x = match &it.kind {
                    PlacedKind::Text { shaped, chars, lead, .. } => {
                        let k = (u - it.units.start).min(chars.len() - 1);
                        it.x + *lead + shaped.x_for_index(chars[k])
                    }
                    PlacedKind::Box { .. } => it.x + it.width,
                    PlacedKind::Break => it.x,
                };
                return l.x_offset + x;
            }
            last_end = it.x + it.width;
        }
        l.x_offset + last_end
    }

    /// The caret rectangle for unit `u`, relative to the leaf.
    pub fn caret(&self, u: usize, upstream: bool) -> Bounds<Pixels> {
        let line = self.line_of(u, upstream);
        let l = &self.lines[line];
        let x = self.x_of(u, line);
        Bounds::new(point(x, l.top), size(px(2.), l.height))
    }

    /// The unit nearest a point relative to the leaf.
    pub fn unit_at(&self, p: Point<Pixels>) -> usize {
        let line = self
            .lines
            .iter()
            .position(|l| p.y < l.top + l.height)
            .unwrap_or(self.lines.len().saturating_sub(1));
        self.unit_at_line_x(line, p.x)
    }

    /// The unit nearest `x` on `line`.
    pub fn unit_at_line_x(&self, line: usize, x: Pixels) -> usize {
        let Some(l) = self.lines.get(line) else { return 0 };
        let x = x - l.x_offset;
        let items = &self.items[l.items.clone()];
        let visible: Vec<&Placed> = items.iter().filter(|i| !matches!(i.kind, PlacedKind::Break)).collect();
        if visible.is_empty() {
            return l.units.start;
        }
        for it in &visible {
            if x < it.x + it.width {
                return match &it.kind {
                    PlacedKind::Text { shaped, chars, lead, .. } => {
                        let byte = shaped.closest_index_for_x(x - it.x - *lead);
                        let k = chars.iter().position(|b| *b >= byte).unwrap_or(chars.len() - 1);
                        it.units.start + k
                    }
                    PlacedKind::Box { .. } => {
                        if x < it.x + it.width / 2. { it.units.start } else { it.units.end }
                    }
                    PlacedKind::Break => it.units.start,
                };
            }
        }
        // Past the end of a soft-wrapped line: before its trailing space,
        // which is where the line visibly ends.
        let last = visible.last().unwrap();
        let end = last.units.end;
        let wrapped = line + 1 < self.lines.len() && !self.ends_with_break(line);
        if wrapped {
            if let PlacedKind::Text { shaped, chars, .. } = &last.kind {
                let text_end = shaped.text.trim_end().len();
                let k = chars.iter().position(|b| *b >= text_end).unwrap_or(chars.len() - 1);
                return last.units.start + k;
            }
        }
        end
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// Rectangles covering units `range`, relative to the leaf. A line the
    /// selection runs past gets a little extra width for its line end.
    pub fn selection_rects(&self, range: Range<usize>) -> Vec<Bounds<Pixels>> {
        let mut out = Vec::new();
        for (i, l) in self.lines.iter().enumerate() {
            let visible_end = if self.ends_with_break(i) { l.units.end.saturating_sub(1) } else { l.units.end };
            let a = range.start.max(l.units.start);
            let b = range.end.min(visible_end);
            let continues = range.end > visible_end && range.start <= visible_end;
            if a > b || (a == b && !continues) {
                continue;
            }
            let x0 = self.x_of(a, i);
            let mut x1 = self.x_of(b, i);
            if continues {
                x1 += px(5.);
            }
            if x1 > x0 {
                out.push(Bounds::new(point(x0, l.top), size(x1 - x0, l.height)));
            }
        }
        out
    }

    /// Paint at `origin` (the leaf's top left).
    pub fn paint(&self, origin: Point<Pixels>, window: &mut Window, cx: &mut App) {
        for l in &self.lines {
            // Backgrounds first, one box per run on each line, so a run of
            // inline code reads as one chip and not as one per word.
            let items = &self.items[l.items.clone()];
            let mut k = 0;
            while k < items.len() {
                let PlacedKind::Text { style, seg, .. } = &items[k].kind else {
                    k += 1;
                    continue;
                };
                let Some(bg) = style.background else {
                    k += 1;
                    continue;
                };
                let (x0, mut x1) = (items[k].x, items[k].x + items[k].width);
                let (mut asc, mut desc) = (items[k].ascent, items[k].descent);
                let mut j = k + 1;
                while j < items.len() {
                    match &items[j].kind {
                        PlacedKind::Text { seg: s2, .. } if s2 == seg => {
                            x1 = items[j].x + items[j].width;
                            asc = asc.max(items[j].ascent);
                            desc = desc.max(items[j].descent);
                            j += 1;
                        }
                        _ => break,
                    }
                }
                let base_y = origin.y + l.top + l.baseline;
                let pad_y = if style.border.is_some() { style.size * 0.2 } else { px(0.) };
                let b = Bounds::new(
                    point(origin.x + l.x_offset + x0, base_y - asc - pad_y),
                    size(x1 - x0, asc + desc + pad_y * 2.),
                );
                let mut q = fill(b, bg);
                if let Some(c) = style.border {
                    q = q.corner_radii(px(5.)).border_widths(px(1.)).border_color(c);
                }
                window.paint_quad(q);
                k = j;
            }
            for it in &self.items[l.items.clone()] {
                let x = origin.x + l.x_offset + it.x;
                let base_y = origin.y + l.top + l.baseline;
                match &it.kind {
                    PlacedKind::Text { shaped, lead, .. } => {
                        let _ = shaped.paint(
                            point(x + *lead, base_y - it.ascent),
                            it.ascent + it.descent,
                            TextAlign::Left,
                            None,
                            window,
                            cx,
                        );
                    }
                    PlacedKind::Box { height, baseline, image, fallback } => {
                        if let Some(f) = fallback {
                            let _ = f.paint(point(x, base_y - f.ascent), f.ascent + f.descent, TextAlign::Left, None, window, cx);
                        } else if let Some(img) = image {
                            if let Some(data) = img.clone().use_render_image(window, cx) {
                                let b = Bounds::new(point(x, base_y - *baseline), size(it.width, *height));
                                let _ = window.paint_image(b, b, Corners::default(), data, 0, false);
                            }
                        }
                    }
                    PlacedKind::Break => {}
                }
            }
        }
    }
}
