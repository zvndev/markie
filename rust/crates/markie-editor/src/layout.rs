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
    /// CSS `letter-spacing`, added after every character.
    pub tracking: Pixels,
    /// CSS `text-transform: uppercase`: drawn in capitals, stored as written.
    pub upper: bool,
    /// A link's `border-bottom`: a 1px line under the run's box, solid or dotted.
    pub under: Option<(Hsla, bool)>,
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
    /// CSS `text-align: justify`: every line but the last (and one ended by
    /// a break) is spread to the full width.
    Justify,
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
    /// CSS `text-indent`: the first line starts this far in.
    pub indent: Pixels,
    /// Text drawn before the first line that is no part of the document (a
    /// heading's section number, CSS `::before`). The caret never enters it.
    pub prefix: Option<(String, SegStyle)>,
    /// Set each line's height on a whole device pixel (the window's scale).
    pub snap: Option<f32>,
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
    /// The first line's prefix (a section number) and where it starts.
    prefix: Option<ShapedLine>,
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
                let upper;
                let text: &String = if style.upper {
                    upper = uppercase(text);
                    &upper
                } else {
                    text
                };
                if style.tracking != px(0.) {
                    // Letter-spacing: each character is placed on its own,
                    // with the spacing after it, as CSS does.
                    let chars: Vec<char> = text.chars().collect();
                    for (k, c) in chars.iter().enumerate() {
                        let piece = c.to_string();
                        let shaped = shape(&piece, style, window);
                        let space = c.is_whitespace();
                        let width = shaped.width + style.tracking;
                        out.push(Piece {
                            units: seg.units.start + k..seg.units.start + k + 1,
                            width,
                            ascent: shaped.ascent,
                            descent: shaped.descent,
                            fit: if space { px(0.) } else { width },
                            joins_next: !space,
                            kind: PlacedKind::Text { chars: char_bytes(&piece), shaped, style: style.clone(), lead: px(0.), seg: seg_index },
                            text: None,
                        });
                    }
                    continue;
                }
                let chars: Vec<(usize, char)> = text.char_indices().collect();
                let mut k = 0usize;
                let first_piece = out.len();
                while k < chars.len() {
                    let start = k;
                    while k < chars.len() && !chars[k].1.is_whitespace() {
                        k += 1;
                        // Chromium may break after a hyphen inside a word
                        // ("keepers-" / "log", "ENG-" / "8575").
                        if hyphen_break(&chars, start, k) {
                            break;
                        }
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
                        joins_next: trimmed.len() == piece.len() && !ends_in_hyphen(piece),
                        kind: PlacedKind::Text { chars: char_bytes(piece), shaped, style: style.clone(), lead, seg: seg_index },
                        text: Some((piece.to_string(), style.clone())),
                    });
                }
            }
        }
    }
    out
}

/// A break opportunity after `chars[k - 1]`: a hyphen with a character of
/// the word before it and a letter or digit after it.
fn hyphen_break(chars: &[(usize, char)], start: usize, k: usize) -> bool {
    k > start + 1 && chars[k - 1].1 == '-' && chars.get(k).is_some_and(|c| c.1.is_alphanumeric())
}

/// A piece that ends in a hyphen after part of a word: the next run may
/// start on the next line, as with a space.
fn ends_in_hyphen(piece: &str) -> bool {
    piece.ends_with('-') && piece.chars().count() > 1
}

/// `text-transform: uppercase`, one character for one, so every unit of the
/// leaf keeps its place (a character whose capital is two, like ß, is left).
fn uppercase(text: &str) -> String {
    text.chars()
        .map(|c| {
            let mut up = c.to_uppercase();
            match (up.next(), up.next()) {
                (Some(u), None) => u,
                _ => c,
            }
        })
        .collect()
}

/// CSS's min-content and max-content widths of a leaf, as `layout` breaks
/// it: its widest word, and its longest line when nothing wraps. A table
/// sizes its columns from these, so a column is never narrower than a word
/// its cells cannot break, and text fits the width it was measured for.
pub fn intrinsic(spec: &LeafSpec, window: &Window) -> (Pixels, Pixels) {
    let start = spec.indent.max(px(0.)) + spec.prefix.as_ref().map(|(t, s)| shape(t, s, window).width).unwrap_or(px(0.));
    let ps = pieces(spec, window);
    let (mut min, mut max) = (px(0.), start);
    let mut x = start;
    let mut i = 0;
    while i < ps.len() {
        if matches!(ps[i].kind, PlacedKind::Break) {
            x = px(0.);
            i += 1;
            continue;
        }
        // One word: pieces up to one that ends in a space, as `layout` groups them.
        let (mut full, mut fit) = (px(0.), px(0.));
        while i < ps.len() && !matches!(ps[i].kind, PlacedKind::Break) {
            let p = &ps[i];
            fit = full + p.fit;
            full += p.width;
            i += 1;
            if !p.joins_next {
                break;
            }
        }
        min = min.max(fit);
        max = max.max(x + fit);
        x += full;
    }
    (min, max)
}

/// Lay the leaf out in `width`.
pub fn layout(spec: &LeafSpec, width: Pixels, window: &Window) -> Laid {
    let width = width.max(px(20.));
    let ps = pieces(spec, window);
    let mut items: Vec<Placed> = Vec::new();
    let mut line = 0usize;
    let prefix = spec.prefix.as_ref().map(|(text, style)| shape(text, style, window));
    // The first line starts after its indent and its prefix.
    let mut x = spec.indent.max(px(0.)).min(width / 2.) + prefix.as_ref().map(|p| p.width).unwrap_or(px(0.));
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
        let mut height = lh.max(asc + desc);
        if let Some(scale) = spec.snap.filter(|s| *s > 0.) {
            height = px((f32::from(height) * scale).round() / scale);
        }
        let baseline = (height - (asc + desc)) / 2. + asc;
        let units = if range.is_empty() {
            // An empty line: at the unit after the break before it.
            let at = if start > 0 { items[start - 1].units.end } else { 0 };
            at..at
        } else {
            items[range.start].units.start..items[range.end - 1].units.end
        };
        let x_offset = match spec.align {
            Align::Left | Align::Justify => px(0.),
            Align::Center => ((width - w) / 2.).max(px(0.)),
            Align::Right => (width - w).max(px(0.)),
        };
        lines.push(Line { top, height, baseline, units, x_offset, items: range });
        top += height;
    }
    if spec.align == Align::Justify {
        justify(&mut items, &lines, width);
    }
    Laid { width, height: top, lines, items, len: spec.len, prefix }
}

/// Spread each wrapped line to `width` by widening the gaps between its
/// words. The last line, and a line a break ends, stay as they are.
fn justify(items: &mut [Placed], lines: &[Line], width: Pixels) {
    for (i, l) in lines.iter().enumerate() {
        let range = l.items.clone();
        if i + 1 == lines.len() || range.len() < 2 || matches!(items[range.end - 1].kind, PlacedKind::Break) {
            continue;
        }
        let ends_in_space = |it: &Placed| matches!(&it.kind, PlacedKind::Text { shaped, .. } if shaped.text.ends_with(char::is_whitespace));
        let last = &items[range.end - 1];
        let visible = match &last.kind {
            PlacedKind::Text { shaped, lead, .. } => last.x + *lead + shaped.x_for_index(shaped.text.trim_end().len()),
            _ => last.x + last.width,
        };
        let gaps = items[range.start..range.end - 1].iter().filter(|it| ends_in_space(it)).count();
        let extra = width - visible;
        if gaps == 0 || extra <= px(0.) {
            continue;
        }
        let each = extra / gaps as f32;
        let mut shift = px(0.);
        for k in range {
            items[k].x += shift;
            if ends_in_space(&items[k]) {
                shift += each;
            }
        }
    }
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
        if let (Some(prefix), Some(l)) = (&self.prefix, self.lines.first()) {
            // Before the first line's own text, wherever alignment put it.
            let first = self.items[l.items.clone()].first().map(|it| it.x).unwrap_or(prefix.width);
            let x = origin.x + l.x_offset + first - prefix.width;
            let _ = prefix.paint(point(x, origin.y + l.top + l.baseline - prefix.ascent), prefix.ascent + prefix.descent, TextAlign::Left, None, window, cx);
        }
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
                if style.background.is_none() && style.border.is_none() && style.under.is_none() {
                    k += 1;
                    continue;
                }
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
                // Inline code's `padding: 0.2em 0.4em` and `border-radius: 5px`.
                let chip = style.pad_x > px(0.) || style.border.is_some();
                let pad_y = if chip { style.size * 0.2 } else { px(0.) };
                let b = Bounds::new(
                    point(origin.x + l.x_offset + x0, base_y - asc - pad_y),
                    size(x1 - x0, asc + desc + pad_y * 2.),
                );
                if style.background.is_some() || style.border.is_some() {
                    let mut q = fill(b, style.background.unwrap_or(gpui_kit::transparent_black()));
                    if chip {
                        q = q.corner_radii(px(5.));
                    }
                    if let Some(c) = style.border {
                        q = q.border_widths(px(1.)).border_color(c);
                    }
                    window.paint_quad(q);
                }
                if let Some((color, dotted)) = style.under {
                    // A link's `border-bottom`: under the run's own box, not
                    // through its descenders as a text underline would be.
                    let last = &items[j - 1];
                    let end = match &last.kind {
                        PlacedKind::Text { shaped, lead, .. } => last.x + *lead + shaped.x_for_index(shaped.text.trim_end().len()),
                        _ => x1,
                    };
                    let (left, y) = (origin.x + l.x_offset + x0, base_y + desc);
                    let w = (end - x0).max(px(0.));
                    if dotted {
                        let mut at = px(0.);
                        while at + px(1.) <= w {
                            window.paint_quad(fill(Bounds::new(point(left + at, y), size(px(1.), px(1.))), color));
                            at += px(2.);
                        }
                    } else {
                        window.paint_quad(fill(Bounds::new(point(left, y), size(w, px(1.))), color));
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::{ends_in_hyphen, hyphen_break};

    /// Where a word may break, as Chromium broke the words of a table in
    /// Electron's frame (`.autoloop/runs/table-styles/compare`).
    fn breaks(word: &str) -> Vec<String> {
        let chars: Vec<(usize, char)> = word.char_indices().collect();
        let (mut out, mut start, mut k) = (Vec::new(), 0, 0);
        while k < chars.len() {
            k += 1;
            if hyphen_break(&chars, start, k) || k == chars.len() {
                out.push(chars[start..k].iter().map(|c| c.1).collect());
                start = k;
            }
        }
        out
    }

    #[test]
    fn words_break_after_their_hyphens() {
        assert_eq!(breaks("keepers-log"), ["keepers-", "log"]);
        assert_eq!(breaks("ENG-8575,"), ["ENG-", "8575,"]);
        assert_eq!(breaks("NT-0001-AAAA"), ["NT-", "0001-", "AAAA"]);
        // Not before a hyphen, not after a leading one, not before punctuation.
        assert_eq!(breaks("-5"), ["-5"]);
        assert_eq!(breaks("a--b"), ["a--", "b"]);
        assert_eq!(breaks("end-."), ["end-."]);
        assert_eq!(breaks("x-"), ["x-"]);
    }

    #[test]
    fn a_run_ending_in_a_hyphen_ends_a_word() {
        assert!(ends_in_hyphen("north-"));
        assert!(!ends_in_hyphen("-"));
        assert!(!ends_in_hyphen("north"));
    }
}
