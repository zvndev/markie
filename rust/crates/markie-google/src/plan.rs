//! Local-only changes as Docs API requests on the changed ranges only.
//!
//! For each chunk the diff says changed only here (`merge.rs`), back to
//! front so earlier indices stay put:
//! - a changed paragraph, heading or list item that pairs with one in the
//!   Doc is edited in place: the characters between the common start and
//!   end are deleted and the new ones inserted, and only characters whose
//!   bold, italic, strikethrough, link or code font differ are restyled;
//! - new blocks are inserted by splitting a neighbouring paragraph, so they
//!   keep its list when they belong to it, then given their named style,
//!   marks and bullets;
//! - removed blocks are deleted whole; a block before a table or at the end
//!   of the body keeps its newline, emptied, as the API requires.
//!
//! Every chunk is applied to a copy of the Doc (`model.rs`) as it is planned,
//! the copy is read back through the converter, and the chunk is kept only
//! if the Doc then says what the file says there. Anything else stays
//! unsent and is named: a table, an image, a footnote and the like never
//! reach Google from Markie, and nothing else in the Doc is touched.
use crate::convert::{Segment, Src, doc_to_markdown};
use crate::md::{self, Block, Kind, ListKind, Marks, Parsed};
use crate::merge::{Chunk, ChunkKind};
use crate::model::{DocModel, Mode, ParaRange, marks_of, preset_for};
use serde_json::{Value, json};

/// The font Markie writes code in.
pub const CODE_FONT: &str = "Courier New";

/// Every text style field Markdown has no say in, reset on new text so it
/// never takes on a neighbour's colour, size or highlight.
const RESET_FIELDS: &str = "bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link";
const PARA_RESET_FIELDS: &str = "namedStyleType,alignment,indentStart,indentFirstLine,indentEnd,spaceAbove,spaceBelow,lineSpacing";

/// The Doc as sync sees it: the model, its Markdown, and each block's origin.
#[derive(Debug, Clone)]
pub struct RemoteView {
    pub model: DocModel,
    pub markdown: String,
    pub parsed: Parsed,
    pub src: Vec<Src>,
    pub tabs: usize,
}

/// Read a Doc for sync. Fails when the model can't hold it exactly.
pub fn remote_view(doc: &Value) -> Result<RemoteView, String> {
    let converted = doc_to_markdown(doc);
    let model = DocModel::from_doc(doc)?;
    // The model must give back exactly what Google sent, as Markdown.
    if converted.tabs <= 1 && doc_to_markdown(&model.to_doc()).markdown != converted.markdown {
        return Err("the Doc did not read back the same".into());
    }
    let parsed = md::parse(&converted.markdown);
    let src = map_segments(&parsed, &converted.segments);
    Ok(RemoteView { model, markdown: converted.markdown, parsed, src, tabs: converted.tabs })
}

/// Each parsed block's origin: the segment its text starts in. Two blocks
/// from one segment, or one with none, are read-only.
pub fn map_segments(parsed: &Parsed, segments: &[Segment]) -> Vec<Src> {
    let mut used = vec![0usize; segments.len()];
    let hits: Vec<Option<usize>> = parsed.blocks.iter().map(|b| segments.iter().position(|s| s.bytes.start <= b.range.start && b.range.start < s.bytes.end.max(s.bytes.start + 1))).collect();
    for i in hits.iter().flatten() {
        used[*i] += 1;
    }
    hits.iter()
        .map(|h| match h {
            Some(i) if used[*i] == 1 => segments[*i].src.clone(),
            Some(i) => Src { read_only: Some("this part of the Doc"), ..segments[*i].src.clone() },
            None => Src { read_only: Some("this part of the Doc"), ..Default::default() },
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub requests: Vec<Value>,
    /// The Doc as it reads once the requests are applied.
    pub after: DocModel,
    /// How many changed pieces are in `requests`.
    pub sent: usize,
    /// Why the other pieces stay unsent, in plain words, each reason once.
    pub held: Vec<&'static str>,
}

impl Plan {
    fn hold(&mut self, why: &'static str) {
        if !self.held.contains(&why) {
            self.held.push(why);
        }
    }
}

/// One planned step inside a chunk, in Doc order.
#[derive(Debug, Clone)]
enum Step {
    Pair(usize, usize),
    Del(usize),
    Ins(usize),
}

struct Planner<'a> {
    sim: DocModel,
    reqs: Vec<Value>,
    mode: Mode,
    local: &'a Parsed,
    remote: &'a RemoteView,
}

fn range(s: usize, e: usize) -> Value {
    json!({"startIndex": s, "endIndex": e})
}

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The text a block becomes in a Doc paragraph.
fn doc_text(b: &Block) -> String {
    let t: String = b.runs.iter().map(|r| r.text.as_str()).collect();
    let t = if matches!(b.kind, Kind::Heading(_)) { t.replace('\u{b}', " ") } else { t };
    let t = t.replace(['\n', '\r'], " ");
    t.trim_matches(|c: char| md::is_space(c)).to_string()
}

/// The marks each character of a block's Doc text should carry.
fn desired_marks(b: &Block) -> Vec<(char, Marks)> {
    let chars = md::styled_chars(&b.runs);
    let chars: Vec<(char, Marks)> = md::trim_chars(&chars).to_vec();
    let checked = matches!(b.kind, Kind::Item { list: ListKind::Check, checked: true, .. });
    chars
        .into_iter()
        .map(|(c, mut m)| {
            if matches!(b.kind, Kind::Heading(_)) {
                m.bold = false;
            }
            if checked && !md::is_space(c) {
                m.strike = true;
            }
            let c = if matches!(b.kind, Kind::Heading(_)) && c == '\u{b}' { ' ' } else if c == '\n' || c == '\r' { ' ' } else { c };
            (c, m)
        })
        .collect()
}

fn named_for(k: &Kind) -> &'static str {
    match k {
        Kind::Heading(1) => "HEADING_1",
        Kind::Heading(2) => "HEADING_2",
        Kind::Heading(3) => "HEADING_3",
        Kind::Heading(4) => "HEADING_4",
        Kind::Heading(5) => "HEADING_5",
        Kind::Heading(6) => "HEADING_6",
        _ => "NORMAL_TEXT",
    }
}

fn same_named(current: &str, want: &str) -> bool {
    current == want || (want == "HEADING_1" && current == "TITLE") || (want == "NORMAL_TEXT" && current == "NAMED_STYLE_TYPE_UNSPECIFIED")
}

/// A text style body and field mask that sets `fields` of `m`.
fn style_body(m: &Marks, fields: &[&str]) -> (Value, String) {
    let mut st = serde_json::Map::new();
    for f in fields {
        match *f {
            "bold" if m.bold => {
                st.insert("bold".into(), json!(true));
            }
            "italic" if m.italic => {
                st.insert("italic".into(), json!(true));
            }
            "strikethrough" if m.strike => {
                st.insert("strikethrough".into(), json!(true));
            }
            "link" if m.link.is_some() => {
                st.insert("link".into(), json!({"url": m.link.clone().unwrap()}));
            }
            "weightedFontFamily" if m.code => {
                st.insert("weightedFontFamily".into(), json!({"fontFamily": CODE_FONT}));
            }
            _ => {}
        }
    }
    (Value::Object(st), fields.join(","))
}

fn differing(a: &Marks, b: &Marks) -> Vec<&'static str> {
    let mut f = Vec::new();
    if a.bold != b.bold {
        f.push("bold");
    }
    if a.italic != b.italic {
        f.push("italic");
    }
    if a.strike != b.strike {
        f.push("strikethrough");
    }
    if a.link.as_deref().map(md::norm_url) != b.link.as_deref().map(md::norm_url) {
        f.push("link");
    }
    if a.code != b.code {
        f.push("weightedFontFamily");
    }
    f
}

impl<'a> Planner<'a> {
    fn push(&mut self, req: Value) -> Result<(), String> {
        self.sim.apply(&req, self.mode, "markie")?;
        self.reqs.push(req);
        Ok(())
    }

    /// Style `[start, start + chars.len())` to `want`, where it differs from
    /// what is there; `skip_strike` leaves strikethrough alone.
    fn restyle(&mut self, start: usize, chars: &[(char, Marks)], fresh: bool) -> Result<(), String> {
        // Back to front over runs with the same wanted marks and the same differences.
        let mut runs: Vec<(usize, usize, Marks, Vec<&'static str>)> = Vec::new();
        let mut pos = start;
        for (c, want) in chars {
            let n = c.len_utf16();
            if md::is_space(*c) {
                pos += n;
                continue;
            }
            let have = if fresh { Marks::default() } else { self.sim.units[pos].style.as_ref().pipe(marks_of).visible(*c) };
            let diff = differing(&have, want);
            if !diff.is_empty() {
                match runs.last_mut() {
                    Some((_, e, m, d)) if *e == pos && m == want && *d == diff => *e = pos + n,
                    _ => runs.push((pos, pos + n, want.clone(), diff)),
                }
            }
            pos += n;
        }
        for (s, e, m, fields) in runs.into_iter().rev() {
            let (st, mask) = style_body(&m, &fields);
            self.push(json!({"updateTextStyle": {"range": range(s, e), "textStyle": st, "fields": mask}}))?;
        }
        Ok(())
    }

    /// Insert `blocks` (local indices) at boundary `x`. Returns the from-end
    /// positions of each new paragraph, block by block.
    fn insert(&mut self, x: usize, blocks: &[usize]) -> Result<Vec<(usize, Vec<(usize, usize)>)>, &'static str> {
        let mut paras: Vec<(usize, String)> = Vec::new();
        for &l in blocks {
            let b = &self.local.blocks[l];
            match &b.kind {
                Kind::Code(lines) => paras.extend(lines.iter().map(|t| (l, t.replace(['\u{b}', '\r'], " ")))),
                k if k.is_text() => paras.push((l, doc_text(b))),
                _ => return Err("this kind of block"),
            }
        }
        let body: String = paras.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join("\n");
        let (at, text) = if x > 0 && self.sim.is_paragraph_start(x) {
            (x, format!("{body}\n"))
        } else if x > 1 && self.sim.units.get(x - 1).is_some_and(|u| u.is_newline()) {
            (x - 1, format!("\n{body}"))
        } else {
            return Err("a place Markie can't insert at");
        };
        if body.encode_utf16().any(|c| c <= 0x08 || ((0x0c..=0x1f).contains(&c) && c != 0x0b)) {
            return Err("control characters");
        }
        let total = len16(&text);
        self.push(json!({"insertText": {"location": {"index": at}, "text": text}})).map_err(|_| "a place Markie can't insert at")?;
        // New text starts at x in both forms.
        let span_end = x + total;
        let fail = |_| "this edit";
        self.push(json!({"updateTextStyle": {"range": range(x, span_end), "textStyle": {}, "fields": RESET_FIELDS}})).map_err(fail)?;
        // Paragraph by paragraph: named style and marks, back to front.
        let mut starts = Vec::new();
        let mut p = x;
        for (_, t) in &paras {
            starts.push(p);
            p += len16(t) + 1;
        }
        let mut out: Vec<(usize, Vec<(usize, usize)>)> = Vec::new();
        for (i, (l, t)) in paras.iter().enumerate().rev() {
            let b = &self.local.blocks[*l];
            let s = starts[i];
            let nl = s + len16(t);
            self.push(json!({"updateParagraphStyle": {"range": range(s, nl + 1), "paragraphStyle": {"namedStyleType": named_for(&b.kind)}, "fields": PARA_RESET_FIELDS}})).map_err(fail)?;
            if let Kind::Code(_) = b.kind {
                let m = Marks { code: true, ..Default::default() };
                let (st, mask) = style_body(&m, &["weightedFontFamily"]);
                self.push(json!({"updateTextStyle": {"range": range(s, nl + 1), "textStyle": st, "fields": mask}})).map_err(fail)?;
            } else {
                let chars = desired_marks(b);
                self.restyle(s, &chars, true).map_err(fail)?;
            }
            let len = self.sim.len();
            match out.last_mut() {
                Some((ol, v)) if ol == l => v.insert(0, (len - s, len - nl)),
                _ => out.push((*l, vec![(len - s, len - nl)])),
            }
        }
        out.reverse();
        Ok(out)
    }

    /// Edit one paragraph in place to say what local block `l` says.
    /// Spaces at either end of the Doc's paragraph are left as they are.
    fn pair(&mut self, p: ParaRange, l: usize) -> Result<(usize, usize), &'static str> {
        let b = &self.local.blocks[l];
        let all: Vec<u16> = self.sim.text(p).encode_utf16().collect();
        let is_sp = |c: &u16| char::from_u32(*c as u32).is_some_and(md::is_space);
        let lead = all.iter().take_while(|c| is_sp(c)).count();
        let trail = all[lead..].iter().rev().take_while(|c| is_sp(c)).count();
        let have = &all[lead..all.len() - trail];
        let base = p.start + lead;
        let want_chars = desired_marks(b);
        let want: Vec<u16> = want_chars
            .iter()
            .flat_map(|(c, _)| {
                let mut buf = [0u16; 2];
                c.encode_utf16(&mut buf).to_vec()
            })
            .collect();
        // Common start and end, never splitting a surrogate pair.
        let mut pre = 0;
        while pre < have.len() && pre < want.len() && have[pre] == want[pre] {
            pre += 1;
        }
        while pre > 0 && (0xdc00..0xe000).contains(&have.get(pre).copied().unwrap_or(0)) {
            pre -= 1;
        }
        let mut suf = 0;
        while suf < have.len() - pre && suf < want.len() - pre && have[have.len() - 1 - suf] == want[want.len() - 1 - suf] {
            suf += 1;
        }
        while suf > 0 && (0xdc00..0xe000).contains(&have[have.len() - suf]) {
            suf -= 1;
        }
        let fail = |_| "this edit";
        let mut offs = Vec::with_capacity(want_chars.len() + 1);
        let mut o = 0;
        for (c, _) in &want_chars {
            offs.push(o);
            o += c.len_utf16();
        }
        offs.push(o);
        let ci = |u: usize| offs.iter().position(|&x| x >= u).unwrap_or(want_chars.len());
        let (pre_c, suf_c) = (ci(pre), ci(want.len() - suf));
        // The end first: restyle the kept end where marks changed.
        self.restyle(base + have.len() - suf, &want_chars[suf_c..], false).map_err(fail)?;
        // The middle: delete, insert, style.
        let (ds, de) = (base + pre, base + have.len() - suf);
        if de > ds {
            self.push(json!({"deleteContentRange": {"range": range(ds, de)}})).map_err(fail)?;
        }
        let mid: String = want_chars[pre_c..suf_c].iter().map(|(c, _)| *c).collect();
        if !mid.is_empty() {
            self.push(json!({"insertText": {"location": {"index": ds}, "text": mid}})).map_err(fail)?;
            let e = ds + len16(&mid);
            self.push(json!({"updateTextStyle": {"range": range(ds, e), "textStyle": {}, "fields": RESET_FIELDS}})).map_err(fail)?;
            self.restyle(ds, &want_chars[pre_c..suf_c], true).map_err(fail)?;
        }
        // The start: restyle where marks changed.
        self.restyle(base, &want_chars[..pre_c], false).map_err(fail)?;
        let np = self.sim.paragraph_at(p.start).ok_or("this edit")?;
        let named = named_for(&b.kind);
        if !same_named(&self.sim.named_style(np), named) {
            self.push(json!({"updateParagraphStyle": {"range": range(np.start, np.end()), "paragraphStyle": {"namedStyleType": named}, "fields": "namedStyleType"}})).map_err(fail)?;
        }
        let len = self.sim.len();
        Ok((len - np.start, len - np.newline))
    }

    /// Delete whole remote blocks `rs` (consecutive in the Doc).
    fn delete(&mut self, rs: &[usize]) -> Result<(), &'static str> {
        let fail = |_| "this edit";
        let s = self.remote.src[rs[0]].start.ok_or("this part of the Doc")? as usize;
        let e = self.remote.src[*rs.last().unwrap()].end.ok_or("this part of the Doc")? as usize;
        if self.sim.units[s..e].iter().any(|u| matches!(u.kind, crate::model::UKind::Opaque { .. })) {
            // Not contiguous paragraphs: one block at a time, back to front.
            if rs.len() == 1 {
                return Err("this part of the Doc");
            }
            for r in rs.iter().rev() {
                self.delete(&[*r])?;
            }
            return Ok(());
        }
        let keep_newline = e >= self.sim.len() || matches!(self.sim.units[e].kind, crate::model::UKind::Opaque { .. });
        if !keep_newline {
            return self.push(json!({"deleteContentRange": {"range": range(s, e)}})).map_err(fail);
        }
        if e - 1 > s {
            self.push(json!({"deleteContentRange": {"range": range(s, e - 1)}})).map_err(fail)?;
        }
        // The emptied paragraph left behind: plain, no bullet. (A suggested
        // delete leaves the text in place, marked, so look the paragraph up.)
        let p = self.sim.paragraph_at(s).ok_or("this edit")?;
        if self.sim.bullet(p).is_some() {
            self.push(json!({"deleteParagraphBullets": {"range": range(p.start, p.end())}})).map_err(fail)?;
        }
        self.push(json!({"updateParagraphStyle": {"range": range(p.start, p.end()), "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}, "fields": PARA_RESET_FIELDS}})).map_err(fail)
    }

    /// Bullets for a chunk's text paragraphs once their text is in place.
    fn bullets(&mut self, paras: &[(usize, usize, usize)]) -> Result<(), &'static str> {
        let fail = |_| "this edit";
        let len = self.sim.len();
        // (local block, paragraph now, wanted bullet)
        let items: Vec<(ParaRange, Option<(ListKind, usize)>)> = paras
            .iter()
            .map(|(l, fs, fnl)| {
                let p = ParaRange { start: len - fs, newline: len - fnl };
                let want = match self.local.blocks[*l].kind {
                    Kind::Item { list, level, .. } => Some((list, level)),
                    _ => None,
                };
                (p, want)
            })
            .collect();
        // Runs that need bullets made, grouped by kind; and paragraphs that need none.
        let mut runs: Vec<(ListKind, Vec<(ParaRange, usize)>)> = Vec::new();
        let mut clear: Vec<ParaRange> = Vec::new();
        let mut last_create: Option<usize> = None;
        for (i, (p, want)) in items.iter().enumerate() {
            let have = self.sim.bullet(*p).map(|(_, k, l)| (k, l));
            match want {
                None if have.is_some() => clear.push(*p),
                Some(w) if have != Some(*w) => {
                    if self.sim.text(*p).starts_with('\t') {
                        return Err("list items that start with a tab");
                    }
                    match runs.last_mut() {
                        Some((k, v)) if *k == w.0 && last_create == Some(i.wrapping_sub(1)) => v.push((*p, w.1)),
                        _ => runs.push((w.0, vec![(*p, w.1)])),
                    }
                    last_create = Some(i);
                }
                _ => {}
            }
        }
        // Back to front: the last change first.
        enum Op {
            Clear(ParaRange),
            Run(ListKind, Vec<(ParaRange, usize)>),
        }
        let mut ops: Vec<(usize, Op)> = clear.into_iter().map(|p| (p.start, Op::Clear(p))).chain(runs.into_iter().map(|(k, v)| (v[0].0.start, Op::Run(k, v)))).collect();
        ops.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
        for (_, op) in ops {
            match op {
                Op::Clear(p) => {
                    self.push(json!({"deleteParagraphBullets": {"range": range(p.start, p.end())}})).map_err(fail)?;
                    self.push(json!({"updateParagraphStyle": {"range": range(p.start, p.end()), "paragraphStyle": {}, "fields": "indentStart,indentFirstLine"}})).map_err(fail)?;
                }
                Op::Run(kind, v) => {
                    let (s, e) = (v[0].0.start, v.last().unwrap().0.end());
                    if v.iter().any(|(p, _)| self.sim.bullet(*p).is_some()) {
                        self.push(json!({"deleteParagraphBullets": {"range": range(s, e)}})).map_err(fail)?;
                    }
                    let mut tabs = 0;
                    for (p, level) in v.iter().rev() {
                        if *level > 0 {
                            self.push(json!({"insertText": {"location": {"index": p.start}, "text": "\t".repeat(*level)}})).map_err(fail)?;
                            tabs += level;
                        }
                    }
                    self.push(json!({"createParagraphBullets": {"range": range(s, e + tabs), "bulletPreset": preset_for(kind)}})).map_err(fail)?;
                }
            }
        }
        Ok(())
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

/// How alike two texts are, 0 to 1, from their common start and end.
fn alike(a: &str, b: &str) -> f32 {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let n = a.len().max(b.len());
    if n == 0 {
        return 1.0;
    }
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    (pre + suf) as f32 / n as f32
}

/// Line up a chunk's remote and local blocks: pairs where a paragraph can
/// be edited in place, deletes and inserts for the rest.
fn align(remote: &RemoteView, local: &Parsed, r: std::ops::Range<usize>, l: std::ops::Range<usize>) -> Vec<Step> {
    let (n, m) = (r.len(), l.len());
    let pairable = |ri: usize, li: usize| -> Option<f32> {
        let (rb, lb) = (&remote.parsed.blocks[ri], &local.blocks[li]);
        if !rb.kind.is_text() || !lb.kind.is_text() || remote.src[ri].read_only.is_some() {
            return None;
        }
        Some(1.0 - alike(&doc_text(rb), &doc_text(lb)))
    };
    const INDEL: f32 = 0.6;
    let w = m + 1;
    let mut cost = vec![0f32; (n + 1) * w];
    for i in (0..=n).rev() {
        for j in (0..=m).rev() {
            if i == n && j == m {
                continue;
            }
            let mut best = f32::MAX;
            if i < n {
                best = best.min(cost[(i + 1) * w + j] + INDEL);
            }
            if j < m {
                best = best.min(cost[i * w + j + 1] + INDEL);
            }
            if i < n && j < m && let Some(c) = pairable(r.start + i, l.start + j) {
                best = best.min(cost[(i + 1) * w + j + 1] + c);
            }
            cost[i * w + j] = best;
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut steps = Vec::new();
    while i < n || j < m {
        let here = cost[i * w + j];
        if i < n && j < m && let Some(c) = pairable(r.start + i, l.start + j) && (here - (cost[(i + 1) * w + j + 1] + c)).abs() < 1e-4 {
            steps.push(Step::Pair(r.start + i, l.start + j));
            i += 1;
            j += 1;
        } else if i < n && (here - (cost[(i + 1) * w + j] + INDEL)).abs() < 1e-4 {
            steps.push(Step::Del(r.start + i));
            i += 1;
        } else {
            steps.push(Step::Ins(l.start + j));
            j += 1;
        }
    }
    steps
}

/// Why a chunk can't be sent, before trying.
fn blocked(remote: &RemoteView, local: &Parsed, c: &Chunk) -> Option<&'static str> {
    for i in c.remote.clone() {
        if let Some(why) = remote.src[i].read_only {
            return Some(why);
        }
        if remote.src[i].start.is_none() {
            return Some("this part of the Doc");
        }
    }
    for i in c.local.clone() {
        let b = &local.blocks[i];
        if let Some(why) = b.read_only {
            return Some(why);
        }
        // The converter reads a paragraph in a monospace font as a code block.
        let words: Vec<&md::Run> = b.runs.iter().filter(|r| !r.text.trim().is_empty()).collect();
        if b.kind == Kind::Paragraph && !words.is_empty() && words.iter().all(|r| r.code) {
            return Some("paragraphs that are only code");
        }
        // The converter reads an item that is all struck through as ticked.
        if matches!(b.kind, Kind::Item { list: ListKind::Check, checked: false, .. }) && !words.is_empty() && words.iter().all(|r| r.strike) {
            return Some("unticked checklist items that are all struck through");
        }
        if matches!(b.kind, Kind::Item { list: ListKind::Check, checked: true, .. }) {
            // Ticking a box: only when the Doc already has it ticked.
            let same = c.remote.clone().any(|r| matches!(remote.parsed.blocks[r].kind, Kind::Item { list: ListKind::Check, checked: true, .. }) && doc_text(&remote.parsed.blocks[r]) == doc_text(b));
            if !same {
                return Some("ticked checkboxes");
            }
        }
    }
    // Unticking a box is the same question the other way round.
    for r in c.remote.clone() {
        if matches!(remote.parsed.blocks[r].kind, Kind::Item { list: ListKind::Check, checked: true, .. })
            && c.local.clone().any(|l| matches!(local.blocks[l].kind, Kind::Item { list: ListKind::Check, checked: false, .. }) && doc_text(&local.blocks[l]) == doc_text(&remote.parsed.blocks[r]))
        {
            return Some("ticked checkboxes");
        }
    }
    None
}

/// The boundary in the Doc before remote block `r` (or the body's end).
fn boundary_before(remote: &RemoteView, r: usize) -> usize {
    (r..remote.src.len()).find_map(|i| remote.src[i].start).map(|s| s as usize).unwrap_or(remote.model.len())
}

/// The boundary in the Doc after remote block `r`.
fn boundary_after(remote: &RemoteView, r: Option<usize>) -> usize {
    match r {
        None => 1,
        Some(r) => (0..=r).rev().find_map(|i| remote.src[i].end).map(|e| e as usize).unwrap_or(1),
    }
}

/// Plan every chunk changed only here. `chunks` comes from `merge::diff3`
/// over (base, local, remote) keys.
pub fn plan(remote: &RemoteView, local: &Parsed, chunks: &[Chunk], mode: Mode) -> Plan {
    let mut planner = Planner { sim: remote.model.clone(), reqs: Vec::new(), mode, local, remote };
    let mut out = Plan { requests: Vec::new(), after: remote.model.clone(), sent: 0, held: Vec::new() };
    let pieces: Vec<Chunk> = chunks.iter().filter(|c| c.kind == ChunkKind::LocalOnly).flat_map(|c| split(remote, local, c)).collect();
    if remote.tabs > 1 {
        if !pieces.is_empty() {
            out.hold("Docs with tabs");
        }
        return out;
    }
    let start: Vec<String> = remote.parsed.blocks.iter().map(|b| b.key.clone()).collect();
    // First everything at once, checked once: a nested item may read oddly
    // until the item above it exists.
    {
        let mut want = start.clone();
        let mut held = Vec::new();
        let mut ok = true;
        let mut sent = 0;
        for c in pieces.iter().rev() {
            if let Some(why) = blocked(remote, local, c) {
                held.push(why);
                continue;
            }
            if plan_chunk(&mut planner, c).is_err() {
                ok = false;
                break;
            }
            want.splice(c.remote.clone(), local.blocks[c.local.clone()].iter().map(|b| b.key.clone()));
            sent += 1;
        }
        if ok && md::parse(&doc_to_markdown(&planner.sim.to_doc()).markdown).blocks.into_iter().map(|b| b.key).collect::<Vec<_>>() == want {
            for why in held {
                out.hold(why);
            }
            out.sent = sent;
            out.requests = planner.reqs;
            out.after = planner.sim;
            return out;
        }
        planner.sim = remote.model.clone();
        planner.reqs.clear();
    }
    // Then piece by piece, so what can't go holds back only itself.
    let mut expected = start;
    for c in pieces.iter().rev() {
        if let Some(why) = try_piece(&mut planner, &mut expected, c) {
            // Block by block, so one awkward block holds back only itself.
            if c.remote.len() + c.local.len() > 1 {
                let mut singles: Vec<Chunk> = c.remote.clone().map(|r| Chunk { remote: r..r + 1, local: c.local.start..c.local.start, ..c.clone() }).collect();
                singles.extend(c.local.clone().map(|l| Chunk { remote: c.remote.end..c.remote.end, local: l..l + 1, ..c.clone() }));
                for s in singles.iter().rev() {
                    match try_piece(&mut planner, &mut expected, s) {
                        Some(why) => out.hold(why),
                        None => out.sent += 1,
                    }
                }
            } else {
                out.hold(why);
            }
        } else {
            out.sent += 1;
        }
    }
    out.requests = planner.reqs;
    out.after = planner.sim;
    out
}

/// Plan one piece onto the copy; keep it only if the copy then reads as
/// `expected` with the piece's local blocks in place. Returns why not.
fn try_piece(planner: &mut Planner, expected: &mut Vec<String>, c: &Chunk) -> Option<&'static str> {
    if let Some(why) = blocked(planner.remote, planner.local, c) {
        return Some(why);
    }
    let (sim0, n0) = (planner.sim.clone(), planner.reqs.len());
    let why = match plan_chunk(planner, c) {
        Ok(()) => {
            let mut want = expected.clone();
            want.splice(c.remote.clone(), planner.local.blocks[c.local.clone()].iter().map(|b| b.key.clone()));
            let got: Vec<String> = md::parse(&doc_to_markdown(&planner.sim.to_doc()).markdown).blocks.into_iter().map(|b| b.key).collect();
            if got == want {
                *expected = want;
                return None;
            }
            if std::env::var_os("MARKIE_PLAN_DEBUG").is_some() {
                eprintln!("piece {c:?} failed:\n want {want:?}\n got {got:?}");
            }
            // Two code blocks side by side are one in a Doc.
            if c.local.clone().any(|l| matches!(planner.local.blocks[l].kind, Kind::Code(_))) { "code blocks right next to each other" } else { "this edit" }
        }
        Err(why) => {
            if std::env::var_os("MARKIE_PLAN_DEBUG").is_some() {
                eprintln!("piece {c:?} refused: {why}");
            }
            why
        }
    };
    planner.sim = sim0;
    planner.reqs.truncate(n0);
    Some(why)
}

/// Cut a chunk into pieces that can be sent or held on their own: each
/// pair of matching blocks, and each run of inserts and deletes between.
/// A table edited next to a paragraph then holds back only the table.
fn split(remote: &RemoteView, local: &Parsed, c: &Chunk) -> Vec<Chunk> {
    let (n, m) = (c.remote.len(), c.local.len());
    if n == 0 || m == 0 {
        return vec![c.clone()];
    }
    let kind_of = |k: &Kind| std::mem::discriminant(k);
    let cost = |ri: usize, li: usize| -> Option<f32> {
        let (rb, lb) = (&remote.parsed.blocks[ri], &local.blocks[li]);
        let both_text = rb.kind.is_text() && lb.kind.is_text();
        if !both_text && kind_of(&rb.kind) != kind_of(&lb.kind) {
            return None;
        }
        Some(1.0 - alike(&rb.key, &lb.key))
    };
    const INDEL: f32 = 0.6;
    let w = m + 1;
    let mut t = vec![0f32; (n + 1) * w];
    for i in (0..=n).rev() {
        for j in (0..=m).rev() {
            if i == n && j == m {
                continue;
            }
            let mut best = f32::MAX;
            if i < n {
                best = best.min(t[(i + 1) * w + j] + INDEL);
            }
            if j < m {
                best = best.min(t[i * w + j + 1] + INDEL);
            }
            if i < n && j < m && let Some(x) = cost(c.remote.start + i, c.local.start + j) {
                best = best.min(t[(i + 1) * w + j + 1] + x);
            }
            t[i * w + j] = best;
        }
    }
    let mut out: Vec<Chunk> = Vec::new();
    let (mut i, mut j) = (0, 0);
    let (mut gi, mut gj) = (0, 0);
    let flush = |out: &mut Vec<Chunk>, gi: usize, gj: usize, i: usize, j: usize| {
        if i > gi || j > gj {
            out.push(Chunk { kind: ChunkKind::LocalOnly, base: c.base.clone(), remote: c.remote.start + gi..c.remote.start + i, local: c.local.start + gj..c.local.start + j });
        }
    };
    while i < n || j < m {
        let here = t[i * w + j];
        if i < n && j < m && let Some(x) = cost(c.remote.start + i, c.local.start + j) && (here - (t[(i + 1) * w + j + 1] + x)).abs() < 1e-4 {
            flush(&mut out, gi, gj, i, j);
            // Identical blocks need no piece of their own.
            if remote.parsed.blocks[c.remote.start + i].key != local.blocks[c.local.start + j].key {
                flush(&mut out, i, j, i + 1, j + 1);
            }
            i += 1;
            j += 1;
            (gi, gj) = (i, j);
        } else if i < n && (here - (t[(i + 1) * w + j] + INDEL)).abs() < 1e-4 {
            i += 1;
        } else {
            j += 1;
        }
    }
    flush(&mut out, gi, gj, i, j);
    out
}

fn plan_chunk(p: &mut Planner, c: &Chunk) -> Result<(), &'static str> {
    let remote = p.remote;
    let steps = align(remote, p.local, c.remote.clone(), c.local.clone());
    // Group: inserts before a remote block (or at the end), deletes in runs.
    let mut paras: Vec<(usize, usize, usize)> = Vec::new();
    let mut i = steps.len();
    while i > 0 {
        i -= 1;
        match &steps[i] {
            Step::Ins(_) => {
                let mut j = i;
                while j > 0 && matches!(steps[j - 1], Step::Ins(_)) {
                    j -= 1;
                }
                let blocks: Vec<usize> = steps[j..=i].iter().map(|s| if let Step::Ins(l) = s { *l } else { unreachable!() }).collect();
                // The boundary: after the remote block before these, else the chunk's start.
                let prev_r = steps[..j].iter().rev().find_map(|s| match s {
                    Step::Pair(r, _) | Step::Del(r) => Some(*r),
                    _ => None,
                });
                let x = match prev_r {
                    Some(r) => boundary_after(remote, Some(r)),
                    None if c.remote.start > 0 => boundary_after(remote, Some(c.remote.start - 1)),
                    None => {
                        let next = steps[i + 1..].iter().find_map(|s| match s {
                            Step::Pair(r, _) | Step::Del(r) => Some(*r),
                            _ => None,
                        });
                        match next {
                            Some(r) => boundary_before(remote, r),
                            None => boundary_before(remote, c.remote.end),
                        }
                    }
                };
                let x = if c.remote.start == 0 && prev_r.is_none() { x.min(boundary_before(remote, c.remote.start)) } else { x };
                for (l, v) in p.insert(x, &blocks)? {
                    // Code lines too: they must lose a bullet they took from a neighbour.
                    paras.extend(v.into_iter().map(|(fs, fnl)| (l, fs, fnl)));
                }
                i = j;
            }
            Step::Del(_) => {
                let mut j = i;
                while j > 0 && matches!(steps[j - 1], Step::Del(_)) {
                    j -= 1;
                }
                let rs: Vec<usize> = steps[j..=i].iter().map(|s| if let Step::Del(r) = s { *r } else { unreachable!() }).collect();
                p.delete(&rs)?;
                i = j;
            }
            Step::Pair(r, l) => {
                let s = remote.src[*r].start.ok_or("this part of the Doc")? as usize;
                let para = p.sim.paragraph_at(s).ok_or("this part of the Doc")?;
                if !p.sim.plain_paragraph(para) || Some(para.end() as i64) != remote.src[*r].end {
                    return Err(remote.src[*r].read_only.unwrap_or("this part of the Doc"));
                }
                let (fs, fnl) = p.pair(para, *l)?;
                paras.push((*l, fs, fnl));
            }
        }
    }
    paras.sort_by_key(|(_, fs, _)| std::cmp::Reverse(*fs));
    p.bullets(&paras)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge::diff3;

    fn body(paras: &[(&str, &str)]) -> Value {
        let mut content = vec![json!({"endIndex": 1, "sectionBreak": {}})];
        let mut i = 1i64;
        for (text, style) in paras {
            let n = text.encode_utf16().count() as i64 + 1;
            content.push(json!({"startIndex": i, "endIndex": i + n, "paragraph": {"elements": [{"startIndex": i, "endIndex": i + n, "textRun": {"content": format!("{text}\n"), "textStyle": {}}}], "paragraphStyle": {"namedStyleType": style}}}));
            i += n;
        }
        json!({"tabs": [{"tabProperties": {"tabId": "t.0"}, "documentTab": {"body": {"content": content}}}]})
    }

    /// Plan base → local against `doc`, apply, and read the Doc back.
    fn roundtrip(doc: &Value, local: &str) -> (String, Plan) {
        let view = remote_view(doc).unwrap();
        let base = md::parse(&view.markdown);
        let local = md::parse(local);
        let chunks = diff3(&base.keys(), &local.keys(), &view.parsed.keys());
        let plan = plan(&view, &local, &chunks, Mode::Edit);
        let mut m = view.model.clone();
        for r in &plan.requests {
            m.apply(r, Mode::Edit, "").unwrap();
        }
        (doc_to_markdown(&m.to_doc()).markdown, plan)
    }

    #[test]
    fn a_word_typed_into_a_paragraph_is_one_insert() {
        let doc = body(&[("Hello world", "NORMAL_TEXT"), ("Second", "NORMAL_TEXT")]);
        let (md, plan) = roundtrip(&doc, "Hello brave world\n\nSecond\n");
        assert_eq!(md, "Hello brave world\n\nSecond\n");
        assert_eq!(plan.requests[0], json!({"insertText": {"location": {"index": 7}, "text": "brave "}}));
        assert!(plan.requests.iter().all(|r| r.get("deleteContentRange").is_none()));
    }

    #[test]
    fn new_blocks_get_styles_lists_and_marks() {
        let doc = body(&[("Intro", "NORMAL_TEXT"), ("End", "NORMAL_TEXT")]);
        let local = "Intro\n\n## Steps\n\n1. one **bold**\n2. two\n    - nested `code`\n\nEnd\n";
        let (md, plan) = roundtrip(&doc, local);
        assert_eq!(md::parse(&md).keys(), md::parse(local).keys(), "{md}");
        assert!(plan.held.is_empty());
    }

    #[test]
    fn deleting_the_last_paragraph_keeps_the_body_newline() {
        let doc = body(&[("Keep", "NORMAL_TEXT"), ("Drop", "HEADING_2")]);
        let (md, plan) = roundtrip(&doc, "Keep\n");
        assert_eq!(md, "Keep\n");
        assert!(plan.held.is_empty());
    }

    #[test]
    fn a_heading_level_change_is_one_paragraph_style() {
        let doc = body(&[("Title", "HEADING_1"), ("Body", "NORMAL_TEXT")]);
        let (md, plan) = roundtrip(&doc, "## Title\n\nBody\n");
        assert_eq!(md, "## Title\n\nBody\n");
        assert_eq!(plan.requests.len(), 1);
    }

    #[test]
    fn tables_stay_unsent_and_untouched() {
        let mut doc = body(&[("Before", "NORMAL_TEXT")]);
        let content = doc.pointer_mut("/tabs/0/documentTab/body/content").unwrap().as_array_mut().unwrap();
        content.push(json!({"startIndex": 8, "endIndex": 16, "table": {"rows": 1, "columns": 1, "tableRows": [{"startIndex": 9, "endIndex": 15, "tableCells": [{"startIndex": 10, "endIndex": 15, "content": [{"startIndex": 11, "endIndex": 15, "paragraph": {"elements": [{"startIndex": 11, "endIndex": 15, "textRun": {"content": "Pen\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}]}]}]}}));
        content.push(json!({"startIndex": 16, "endIndex": 17, "paragraph": {"elements": [{"startIndex": 16, "endIndex": 17, "textRun": {"content": "\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}));
        let view = remote_view(&doc).unwrap();
        assert!(view.markdown.contains("| Pen |"), "{}", view.markdown);
        let local = view.markdown.replace("Pen", "Pencil").replace("Before", "Before, edited");
        let (md, plan) = roundtrip(&doc, &local);
        assert_eq!(plan.held, ["tables"]);
        assert!(md.starts_with("Before, edited\n\n| Pen |"), "{md}");
    }
}
