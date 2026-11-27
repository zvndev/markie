//! A Google Doc, as `documents.get` returns it with `includeTabsContent`, to
//! Markdown (CommonMark plus GFM tables, strikethrough and task lists).
//!
//! Kept: headings (Title is a level-one heading), paragraphs, bold, italic,
//! strikethrough, links, bulleted, numbered and checked lists with nesting,
//! tables, code-styled text (a monospace font) as code spans and code
//! blocks, horizontal rules, footnotes, and images. An image whose embedded
//! object carries `markieLocalSrc` (set by `images::localize` once its file
//! is saved beside the Markdown) is a Markdown image of that file; any other
//! is a link to Google, which stops working after about half an hour.
//!
//! A Doc with more than one tab becomes one file with a level-one heading per
//! tab; headings inside a tab move down one level per tab depth.
//!
//! Dropped and listed in `Converted::dropped`: underline, colours and fonts,
//! links to headings, bookmarks or tabs (the text stays), tables of contents,
//! equations. Comments and suggestions are not part of this read.
//!
//! Unverified, checked by the spike tool on real Docs: how a checklist shows
//! in the API. Here a list level with no glyph symbol and an unspecified glyph
//! type is a checklist, and an item whose text is all struck through is
//! checked.
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Converted {
    pub markdown: String,
    pub tabs: usize,
    pub images: usize,
    /// The inline and positioned object IDs of the images the Markdown
    /// shows, in order, each once: what `images::localize` downloads.
    pub image_ids: Vec<String>,
    /// What Markdown could not keep, in plain words.
    pub dropped: BTreeSet<&'static str>,
    /// For a one-tab Doc: where each Markdown block came from in the Doc.
    /// Two-way sync maps its diff onto Doc indices with these.
    pub segments: Vec<Segment>,
}

/// One Markdown block's origin: its bytes in `markdown`, the Doc index range
/// of the elements it came from, and why it can't be written back.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Segment {
    pub bytes: std::ops::Range<usize>,
    pub src: Src,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Src {
    /// `startIndex` of the first element, `endIndex` of the last.
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub read_only: Option<&'static str>,
}

impl Src {
    fn merge(&mut self, o: &Src) {
        self.start = match (self.start, o.start) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        self.end = match (self.end, o.end) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        self.read_only = self.read_only.or(o.read_only);
    }
}

/// Convert a whole Doc.
pub fn doc_to_markdown(doc: &Value) -> Converted {
    let mut tabs = Vec::new();
    if let Some(list) = doc.get("tabs").and_then(Value::as_array) {
        flatten_tabs(list, 0, &mut tabs);
    }
    if tabs.is_empty() {
        // A document read without tabs: the first tab's content at the top level.
        tabs.push(Tab { title: String::new(), depth: 0, content: doc });
    }
    let mut out = Converted { tabs: tabs.len(), ..Default::default() };
    let multi = tabs.len() > 1;
    let mut parts = Vec::new();
    let mut segments = Vec::new();
    for tab in &tabs {
        let shift = if multi { tab.depth as u8 + 1 } else { 0 };
        let mut ctx = Ctx::new(tab.content, shift);
        let mut blocks = Vec::new();
        if multi {
            let title = if tab.title.trim().is_empty() { "Untitled tab".to_string() } else { tab.title.trim().to_string() };
            blocks.push(Block::Text(format!("{} {}", "#".repeat((tab.depth + 1).min(6)), escape_text(&title, false)), Src::default()));
        }
        let content = body_content(tab.content);
        blocks.extend(ctx.blocks(content));
        blocks.extend(ctx.footnote_blocks());
        out.images += ctx.images;
        for id in std::mem::take(&mut ctx.image_ids) {
            if !out.image_ids.contains(&id) {
                out.image_ids.push(id);
            }
        }
        out.dropped.extend(ctx.dropped.iter().copied());
        let (text, segs) = assemble(&blocks);
        if !multi {
            segments = segs;
        }
        parts.push(text);
    }
    out.segments = segments;
    let mut md = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n");
    if !md.is_empty() {
        md.push('\n');
    }
    out.markdown = md;
    out
}

struct Tab<'a> {
    title: String,
    depth: usize,
    /// The tab's `documentTab`, or the document itself for a legacy read.
    content: &'a Value,
}

fn flatten_tabs<'a>(list: &'a [Value], depth: usize, out: &mut Vec<Tab<'a>>) {
    for tab in list {
        if let Some(content) = tab.get("documentTab") {
            let title = tab.pointer("/tabProperties/title").and_then(Value::as_str).unwrap_or_default().to_string();
            out.push(Tab { title, depth, content });
        }
        if let Some(children) = tab.get("childTabs").and_then(Value::as_array) {
            flatten_tabs(children, depth + 1, out);
        }
    }
}

fn body_content(tab: &Value) -> &[Value] {
    tab.pointer("/body/content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

// ------------------------------------------------------------------ blocks

#[derive(Debug, Clone, PartialEq)]
enum Block {
    /// A paragraph, heading, rule or table: blank lines around it.
    Text(String, Src),
    /// One list item, already indented and marked: items sit line by line.
    Item(String, Src),
    /// One line of a code block: consecutive lines share a fence.
    Code(String, Src),
}

/// The blocks as Markdown, and each output block's bytes and origin.
fn assemble(blocks: &[Block]) -> (String, Vec<Segment>) {
    let mut out: Vec<String> = Vec::new();
    let mut segs: Vec<Segment> = Vec::new();
    // Where the next piece starts once pieces are joined by blank lines.
    let mut pos = 0usize;
    let mut push = |out: &mut Vec<String>, piece: String, inner: Vec<(std::ops::Range<usize>, Src)>| {
        if !out.is_empty() {
            pos += 2;
        }
        for (r, src) in inner {
            segs.push(Segment { bytes: pos + r.start..pos + r.end, src });
        }
        pos += piece.len();
        out.push(piece);
    };
    let mut i = 0;
    while i < blocks.len() {
        match &blocks[i] {
            Block::Text(t, src) => {
                push(&mut out, t.clone(), vec![(0..t.len(), src.clone())]);
                i += 1;
            }
            Block::Item(..) => {
                let mut text = String::new();
                let mut inner = Vec::new();
                while let Some(Block::Item(t, src)) = blocks.get(i) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    let lead = t.len() - t.trim_start().len();
                    inner.push((text.len() + lead..text.len() + t.len(), src.clone()));
                    text.push_str(t);
                    i += 1;
                }
                push(&mut out, text, inner);
            }
            Block::Code(..) => {
                let mut lines = Vec::new();
                let mut src = Src::default();
                while let Some(Block::Code(t, s)) = blocks.get(i) {
                    lines.push(t.clone());
                    src.merge(s);
                    i += 1;
                }
                while lines.last().is_some_and(|l| l.trim().is_empty()) {
                    lines.pop();
                }
                while lines.first().is_some_and(|l| l.trim().is_empty()) {
                    lines.remove(0);
                }
                if lines.is_empty() {
                    continue;
                }
                let body = lines.join("\n");
                let fence = "`".repeat(longest_run(&body, '`').max(2) + 1);
                let piece = format!("{fence}\n{body}\n{fence}");
                let len = piece.len();
                push(&mut out, piece, vec![(0..len, src)]);
            }
        }
    }
    (out.join("\n\n"), segs)
}

fn longest_run(s: &str, c: char) -> usize {
    let (mut best, mut run) = (0, 0);
    for ch in s.chars() {
        if ch == c {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

struct Ctx<'a> {
    lists: Option<&'a Value>,
    objects: Option<&'a Value>,
    positioned: Option<&'a Value>,
    footnotes: Option<&'a Value>,
    shift: u8,
    counters: HashMap<(String, usize), usize>,
    footnote_order: Vec<(String, String)>,
    images: usize,
    image_ids: Vec<String>,
    dropped: BTreeSet<&'static str>,
    /// The element being converted: its indices and why it is read-only.
    cur: Src,
}

impl<'a> Ctx<'a> {
    fn new(tab: &'a Value, shift: u8) -> Self {
        Self {
            lists: tab.get("lists"),
            objects: tab.get("inlineObjects"),
            positioned: tab.get("positionedObjects"),
            footnotes: tab.get("footnotes"),
            shift,
            counters: HashMap::new(),
            footnote_order: Vec::new(),
            images: 0,
            image_ids: Vec::new(),
            dropped: BTreeSet::new(),
            cur: Src::default(),
        }
    }

    fn read_only(&mut self, why: &'static str) {
        self.cur.read_only.get_or_insert(why);
    }

    fn blocks(&mut self, content: &[Value]) -> Vec<Block> {
        let mut out = Vec::new();
        for el in content {
            self.cur = Src { start: el.get("startIndex").and_then(Value::as_i64), end: el.get("endIndex").and_then(Value::as_i64), read_only: None };
            if let Some(p) = el.get("paragraph") {
                out.extend(self.paragraph(p));
            } else if let Some(t) = el.get("table") {
                self.read_only("tables");
                out.extend(self.table(t));
            } else if el.get("tableOfContents").is_some() {
                self.dropped.insert("tables of contents");
            }
            // sectionBreak: nothing to show.
        }
        out
    }

    fn paragraph(&mut self, p: &Value) -> Vec<Block> {
        let elements = p.get("elements").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let accepted = accepted_paragraph(p);
        let style = accepted.style.as_str();
        if accepted.suggested {
            self.read_only("suggestions waiting in Google");
        }
        if style == "SUBTITLE" {
            self.read_only("subtitles");
        }
        let mut spans = self.spans(elements);
        let mut extra = Vec::new();
        // Floating images anchored to this paragraph follow its text.
        if let Some(ids) = p.get("positionedObjectIds").and_then(Value::as_array) {
            for id in ids.iter().filter_map(Value::as_str) {
                if let Some(link) = self.image_link(id, self.positioned.and_then(|o| o.get(id)).and_then(|o| o.get("positionedObjectProperties"))) {
                    self.read_only("images");
                    extra.push(Block::Text(link, self.cur.clone()));
                }
            }
        }
        let has_rule = elements.iter().any(|e| e.get("horizontalRule").is_some());
        let plain: String = spans.iter().filter(|s| !s.raw).map(|s| s.text.as_str()).collect();
        let empty = plain.trim().is_empty() && !spans.iter().any(|s| s.raw);
        if has_rule && empty {
            self.read_only("horizontal lines");
            let mut v = vec![Block::Text("---".into(), self.cur.clone())];
            v.extend(extra.into_iter().map(|b| self.with_src(b)));
            return v;
        }
        if has_rule {
            self.read_only("horizontal lines");
        }
        let bullet = accepted.bullet.as_ref();
        let heading = heading_level(style).map(|l| (l + self.shift).min(6));
        if bullet.is_none() && heading.is_none() {
            let mono_runs: Vec<&Span> = spans.iter().filter(|s| !s.raw && !s.text.trim().is_empty()).collect();
            let starts_mono = spans.first().is_some_and(|s| s.code && !s.raw);
            if (empty && starts_mono) || (!mono_runs.is_empty() && mono_runs.iter().all(|s| s.code) && !spans.iter().any(|s| s.raw)) {
                let text: String = spans.iter().map(|s| s.text.replace('\u{b}', "\n")).collect();
                if text.contains('\n') {
                    // A soft break inside a code line: one Docs paragraph, several lines.
                    self.read_only("code lines with line breaks");
                }
                let src = self.cur.clone();
                let mut v: Vec<Block> = text.split('\n').map(|l| Block::Code(l.to_string(), src.clone())).collect();
                v.extend(extra.into_iter().map(|b| self.with_src(b)));
                return v;
            }
        }
        if empty {
            return extra.into_iter().map(|b| self.with_src(b)).collect();
        }
        let mut blocks = Vec::new();
        if let Some(level) = heading {
            for s in &mut spans {
                s.bold = false;
                s.text = s.text.replace('\u{b}', " ");
            }
            let text = render(&spans, false);
            blocks.push(Block::Text(format!("{} {}", "#".repeat(level as usize), text.trim()), Src::default()));
        } else if let Some(bullet) = bullet {
            blocks.push(self.list_item(bullet, &mut spans));
        } else {
            let text = render(&spans, false);
            let text = if style == "SUBTITLE" { format!("*{}*", text.trim()) } else { text };
            blocks.push(Block::Text(escape_line_starts(text.trim_end()), Src::default()));
        }
        blocks.extend(extra);
        blocks.into_iter().map(|b| self.with_src(b)).collect()
    }

    /// Every block of one paragraph carries the paragraph's origin, read-only
    /// reasons found while reading it included.
    fn with_src(&self, b: Block) -> Block {
        match b {
            Block::Text(t, _) => Block::Text(t, self.cur.clone()),
            Block::Item(t, _) => Block::Item(t, self.cur.clone()),
            Block::Code(t, _) => Block::Code(t, self.cur.clone()),
        }
    }

    fn list_item(&mut self, bullet: &Value, spans: &mut [Span]) -> Block {
        let list_id = bullet.get("listId").and_then(Value::as_str).unwrap_or_default().to_string();
        let level = bullet.get("nestingLevel").and_then(Value::as_u64).unwrap_or(0).min(8) as usize;
        let props = self
            .lists
            .and_then(|l| l.get(&list_id))
            .and_then(|l| l.pointer("/listProperties/nestingLevels"))
            .and_then(Value::as_array)
            .and_then(|levels| levels.get(level));
        let kind = list_kind(props);
        // Deeper levels of this list start again under a new parent.
        self.counters.retain(|(id, l), _| !(id == &list_id && *l > level));
        let marker = match kind {
            ListKind::Ordered => {
                let n = self.counters.entry((list_id, level)).or_insert(0);
                *n += 1;
                format!("{n}.")
            }
            ListKind::Check => {
                let words: Vec<&Span> = spans.iter().filter(|s| !s.raw && !s.text.trim().is_empty()).collect();
                let checked = !words.is_empty() && words.iter().all(|s| s.strike);
                if checked {
                    for s in spans.iter_mut() {
                        s.strike = false;
                    }
                }
                if checked { "- [x]".into() } else { "- [ ]".into() }
            }
            ListKind::Bullet => "-".into(),
        };
        let indent = "    ".repeat(level);
        let text = escape_line_starts(render(spans, false).trim());
        let pad = " ".repeat(indent.len() + marker.len() + 1);
        let text = text.replace('\n', &format!("\n{pad}"));
        Block::Item(format!("{indent}{marker} {text}"), Src::default())
    }

    fn table(&mut self, t: &Value) -> Vec<Block> {
        let rows = t.get("tableRows").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let mut grid: Vec<Vec<String>> = Vec::new();
        for row in rows {
            let cells = row.get("tableCells").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            let mut line = Vec::new();
            for cell in cells {
                let content = cell.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
                let mut parts = Vec::new();
                for el in content {
                    if let Some(p) = el.get("paragraph") {
                        let elements = p.get("elements").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
                        let mut spans = self.spans(elements);
                        for s in &mut spans {
                            s.text = s.text.replace('\u{b}', " ");
                        }
                        let text = render(&spans, true);
                        let text = text.trim();
                        if !text.is_empty() {
                            parts.push(if p.get("bullet").is_some() { format!("• {text}") } else { text.to_string() });
                        }
                    } else if el.get("table").is_some() {
                        self.dropped.insert("tables inside tables");
                    }
                }
                line.push(parts.join("<br>"));
            }
            grid.push(line);
        }
        let cols = grid.iter().map(Vec::len).max().unwrap_or(0);
        if cols == 0 {
            return Vec::new();
        }
        let fmt = |row: &[String]| {
            let cells: Vec<String> = (0..cols).map(|i| row.get(i).cloned().unwrap_or_default()).collect();
            format!("| {} |", cells.join(" | "))
        };
        let mut lines = vec![fmt(&grid[0]), format!("|{}|", vec![" --- "; cols].join("|"))];
        lines.extend(grid[1..].iter().map(|r| fmt(r)));
        vec![Block::Text(lines.join("\n"), self.cur.clone())]
    }

    fn spans(&mut self, elements: &[Value]) -> Vec<Span> {
        let mut out = Vec::new();
        for el in elements {
            if suggested(el, "suggestedDeletionIds") {
                // The Doc as it reads once every suggestion is accepted.
                continue;
            }
            if suggested(el, "suggestedInsertionIds") || el.get("textRun").and_then(|r| r.get("suggestedTextStyleChanges")).and_then(Value::as_object).is_some_and(|m| !m.is_empty()) {
                self.read_only("suggestions waiting in Google");
            }
            if let Some(run) = el.get("textRun") {
                let text = run.get("content").and_then(Value::as_str).unwrap_or_default();
                let text = text.strip_suffix('\n').unwrap_or(text);
                let style = accepted_text_style(run);
                let run = &serde_json::json!({"textStyle": style});
                if text.is_empty() {
                    // The paragraph's end: it still tells whether an empty line is code.
                    if out.is_empty() {
                        let mut s = self.styled(String::new(), run.get("textStyle"));
                        s.text.clear();
                        out.push(s);
                    }
                    continue;
                }
                out.push(self.styled(text.to_string(), run.get("textStyle")));
            } else if let Some(obj) = el.get("inlineObjectElement") {
                let id = obj.get("inlineObjectId").and_then(Value::as_str).unwrap_or_default();
                let props = self.objects.and_then(|o| o.get(id)).and_then(|o| o.get("inlineObjectProperties"));
                if let Some(link) = self.image_link(id, props) {
                    self.read_only("images");
                    out.push(Span::raw(link));
                }
            } else if let Some(f) = el.get("footnoteReference") {
                self.read_only("footnotes");
                let id = f.get("footnoteId").and_then(Value::as_str).unwrap_or_default().to_string();
                let number = f.get("footnoteNumber").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| (self.footnote_order.len() + 1).to_string());
                let label: String = number.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
                out.push(Span::raw(format!("[^{label}]")));
                self.footnote_order.push((id, label));
            } else if let Some(person) = el.get("person") {
                self.read_only("people chips");
                let name = person.pointer("/personProperties/name").or_else(|| person.pointer("/personProperties/email")).and_then(Value::as_str).unwrap_or_default();
                out.push(self.styled(name.to_string(), person.get("textStyle")));
            } else if let Some(rich) = el.get("richLink") {
                self.read_only("smart chips");
                let title = rich.pointer("/richLinkProperties/title").and_then(Value::as_str).unwrap_or("link");
                let mut s = self.styled(title.to_string(), rich.get("textStyle"));
                s.link = rich.pointer("/richLinkProperties/uri").and_then(Value::as_str).map(str::to_string);
                out.push(s);
            } else if el.get("equation").is_some() {
                self.read_only("equations");
                self.dropped.insert("equations");
            } else if el.get("horizontalRule").is_none() && el.get("pageBreak").is_none() && el.get("columnBreak").is_none() {
                // autoText and anything newer: never written over.
                self.read_only("page numbers and other automatic text");
            } else if el.get("pageBreak").is_some() || el.get("columnBreak").is_some() {
                self.read_only("page breaks");
            }
            // horizontalRule, pageBreak, columnBreak, autoText: nothing inline.
        }
        out
    }

    fn styled(&mut self, text: String, style: Option<&Value>) -> Span {
        let flag = |k: &str| style.and_then(|s| s.get(k)).and_then(Value::as_bool).unwrap_or(false);
        let font = style.and_then(|s| s.pointer("/weightedFontFamily/fontFamily")).and_then(Value::as_str).unwrap_or_default();
        let link = style.and_then(|s| s.get("link"));
        let url = link.and_then(|l| l.get("url")).and_then(Value::as_str).map(str::to_string);
        if link.is_some() && url.is_none() {
            self.dropped.insert("links to headings, bookmarks and tabs");
        }
        if flag("underline") && url.is_none() {
            self.dropped.insert("underline");
        }
        if style.is_some_and(|s| s.get("foregroundColor").is_some() || s.get("backgroundColor").is_some()) {
            self.dropped.insert("text colours and highlights");
        }
        Span { text, bold: flag("bold"), italic: flag("italic"), strike: flag("strikethrough"), code: is_monospace(font), link: url, raw: false }
    }

    /// An image: a Markdown image of its saved file when `images::localize`
    /// noted one, otherwise a link. Google's `contentUri` works for about
    /// half an hour.
    fn image_link(&mut self, id: &str, props: Option<&Value>) -> Option<String> {
        let embedded = props?.get("embeddedObject")?;
        self.images += 1;
        if !id.is_empty() && !self.image_ids.iter().any(|i| i == id) {
            self.image_ids.push(id.to_string());
        }
        let alt = embedded.get("description").or_else(|| embedded.get("title")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        if let Some(dest) = embedded.get(crate::images::LOCAL_SRC).and_then(Value::as_str).filter(|d| !d.is_empty()) {
            return Some(crate::images::markdown_image(alt.unwrap_or_default(), dest));
        }
        let image = embedded.get("imageProperties");
        let uri = image.and_then(|i| i.get("sourceUri")).or_else(|| image.and_then(|i| i.get("contentUri"))).and_then(Value::as_str).filter(|u| !u.is_empty());
        let label = match alt {
            Some(alt) => format!("Image: {}", escape_text(alt, false)),
            None => "Image".to_string(),
        };
        Some(match uri {
            Some(u) => format!("[{label}]({})", link_target(u)),
            None => format!("\\[{label}\\]"),
        })
    }

    fn footnote_blocks(&mut self) -> Vec<Block> {
        let mut out = Vec::new();
        for (id, label) in std::mem::take(&mut self.footnote_order) {
            let content = self.footnotes.and_then(|f| f.get(&id)).and_then(|f| f.get("content")).and_then(Value::as_array).cloned().unwrap_or_default();
            let mut texts = Vec::new();
            for el in &content {
                if let Some(p) = el.get("paragraph") {
                    let elements = p.get("elements").and_then(Value::as_array).cloned().unwrap_or_default();
                    let spans = self.spans(&elements);
                    let t = render(&spans, false);
                    if !t.trim().is_empty() {
                        texts.push(t.trim().replace('\n', " "));
                    }
                }
            }
            out.push(Block::Text(format!("[^{label}]: {}", texts.join(" ")), Src { read_only: Some("footnotes"), ..Default::default() }));
        }
        out
    }
}

fn suggested(el: &Value, key: &str) -> bool {
    let inner = ["textRun", "inlineObjectElement", "footnoteReference", "horizontalRule", "pageBreak", "person", "richLink", "equation", "autoText", "columnBreak"];
    inner.iter().filter_map(|k| el.get(*k)).any(|v| v.get(key).and_then(Value::as_array).is_some_and(|a| !a.is_empty()))
}

/// A run's text style with its suggested changes accepted.
pub fn accepted_text_style(run: &Value) -> Value {
    let mut style = run.get("textStyle").cloned().unwrap_or_else(|| serde_json::json!({}));
    if let Some(changes) = run.get("suggestedTextStyleChanges").and_then(Value::as_object) {
        for change in changes.values() {
            let (Some(st), Some(state)) = (change.get("textStyle"), change.get("textStyleSuggestionState")) else { continue };
            for k in ["bold", "italic", "strikethrough", "underline", "link", "weightedFontFamily", "foregroundColor", "backgroundColor"] {
                if state.get(format!("{k}Suggested")).and_then(Value::as_bool) == Some(true) {
                    match st.get(k) {
                        Some(v) => style[k] = v.clone(),
                        None => {
                            if let Some(o) = style.as_object_mut() {
                                o.remove(k);
                            }
                        }
                    }
                }
            }
        }
    }
    style
}

struct AcceptedParagraph {
    style: String,
    bullet: Option<Value>,
    suggested: bool,
}

/// A paragraph's named style and bullet with suggested changes accepted.
fn accepted_paragraph(p: &Value) -> AcceptedParagraph {
    let mut style = p.pointer("/paragraphStyle/namedStyleType").and_then(Value::as_str).unwrap_or("NORMAL_TEXT").to_string();
    let mut bullet = p.get("bullet").cloned();
    let mut suggested = false;
    if let Some(changes) = p.get("suggestedParagraphStyleChanges").and_then(Value::as_object) {
        for change in changes.values() {
            suggested = true;
            if change.pointer("/paragraphStyleSuggestionState/namedStyleTypeSuggested").and_then(Value::as_bool) == Some(true) {
                style = change.pointer("/paragraphStyle/namedStyleType").and_then(Value::as_str).unwrap_or("NORMAL_TEXT").to_string();
            }
        }
    }
    if let Some(changes) = p.get("suggestedBulletChanges").and_then(Value::as_object) {
        for change in changes.values() {
            suggested = true;
            match change.get("bullet") {
                Some(b) if b.get("listId").is_some() => bullet = Some(b.clone()),
                _ => bullet = None,
            }
        }
    }
    AcceptedParagraph { style, bullet, suggested }
}

fn heading_level(style: &str) -> Option<u8> {
    match style {
        "TITLE" | "HEADING_1" => Some(1),
        "HEADING_2" => Some(2),
        "HEADING_3" => Some(3),
        "HEADING_4" => Some(4),
        "HEADING_5" => Some(5),
        "HEADING_6" => Some(6),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Bullet,
    Ordered,
    Check,
}

fn list_kind(level: Option<&Value>) -> ListKind {
    let Some(level) = level else { return ListKind::Bullet };
    if level.get("glyphSymbol").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return ListKind::Bullet;
    }
    match level.get("glyphType").and_then(Value::as_str).unwrap_or("GLYPH_TYPE_UNSPECIFIED") {
        "DECIMAL" | "ZERO_DECIMAL" | "ALPHA" | "UPPER_ALPHA" | "ROMAN" | "UPPER_ROMAN" => ListKind::Ordered,
        "GLYPH_TYPE_UNSPECIFIED" => ListKind::Check,
        _ => ListKind::Bullet,
    }
}

const MONO_FONTS: &[&str] = &["courier", "courier new", "consolas", "inconsolata", "menlo", "monaco", "source code pro", "fira code", "cousine", "andale", "lucida console", "anonymous pro", "nanum gothic coding"];

pub fn is_monospace(font: &str) -> bool {
    let f = font.trim().to_ascii_lowercase();
    !f.is_empty() && (f.contains("mono") || f.contains("code") || MONO_FONTS.iter().any(|m| f == *m || f.starts_with(&format!("{m} "))))
}

// ------------------------------------------------------------------ inline

#[derive(Debug, Clone, PartialEq)]
struct Span {
    text: String,
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    link: Option<String>,
    /// Already Markdown (an image link, a footnote mark): no escaping, no marks.
    raw: bool,
}

impl Span {
    fn raw(text: String) -> Self {
        Self { text, bold: false, italic: false, strike: false, code: false, link: None, raw: true }
    }
    fn same_marks(&self, o: &Span) -> bool {
        !self.raw && !o.raw && self.bold == o.bold && self.italic == o.italic && self.strike == o.strike && self.code == o.code && self.link == o.link
    }
}

/// Spans to Markdown. Neighbours with the same marks merge first, and
/// whitespace moves outside the marks, where emphasis can open and close.
fn render(spans: &[Span], in_table: bool) -> String {
    let mut merged: Vec<Span> = Vec::new();
    for s in spans {
        if s.text.is_empty() {
            continue;
        }
        match merged.last_mut() {
            Some(last) if last.same_marks(s) => last.text.push_str(&s.text),
            _ => merged.push(s.clone()),
        }
    }
    let mut out = String::new();
    for s in &merged {
        if s.raw {
            out.push_str(&s.text);
            continue;
        }
        let is_ws = |c: char| c.is_whitespace() || c == '\u{b}';
        let core = s.text.trim_matches(is_ws);
        if core.is_empty() {
            out.push_str(&escape_text(&s.text, in_table));
            continue;
        }
        let start = s.text.find(core).unwrap_or(0);
        let (lead, trail) = (&s.text[..start], &s.text[start + core.len()..]);
        out.push_str(&escape_text(lead, in_table));
        let mut open = String::new();
        let mut close = String::new();
        if s.link.is_some() {
            open.push('[');
        }
        if s.bold {
            open.push_str("**");
        }
        if s.italic {
            open.push('*');
        }
        if s.strike {
            open.push_str("~~");
        }
        if s.strike {
            close.push_str("~~");
        }
        if s.italic {
            close.push('*');
        }
        if s.bold {
            close.push_str("**");
        }
        let inner = if s.code { code_span(core, in_table) } else { escape_text(core, in_table) };
        out.push_str(&open);
        out.push_str(&inner);
        out.push_str(&close);
        if let Some(url) = &s.link {
            out.push_str(&format!("]({})", link_target(url)));
        }
        out.push_str(&escape_text(trail, in_table));
    }
    out
}

fn spans_of(runs: &[crate::md::Run]) -> Vec<Span> {
    runs.iter().map(|r| Span { text: r.text.clone(), bold: r.bold, italic: r.italic, strike: r.strike, code: r.code, link: r.link.clone(), raw: false }).collect()
}

/// A paragraph, heading or code block written the way the converter writes it.
pub fn render_block(b: &crate::md::Block) -> String {
    use crate::md::Kind;
    let spans = spans_of(&b.runs);
    match &b.kind {
        Kind::Heading(n) => {
            let spans: Vec<Span> = spans.into_iter().map(|mut s| {
                s.bold = false;
                s.text = s.text.replace('\u{b}', " ");
                s
            }).collect();
            format!("{} {}", "#".repeat(*n as usize), render(&spans, false).trim())
        }
        Kind::Item { level, .. } => render_item(b, *level),
        Kind::Code(lines) => {
            let body = lines.join("\n");
            let fence = "`".repeat(longest_run(&body, '`').max(2) + 1);
            format!("{fence}\n{body}\n{fence}")
        }
        _ => escape_line_starts(render(&spans, false).trim()),
    }
}

/// One list item at a nesting level, the way the converter writes it.
pub fn render_item(b: &crate::md::Block, level: usize) -> String {
    use crate::md::{Kind, ListKind};
    let marker = match &b.kind {
        Kind::Item { list: ListKind::Ordered, .. } => "1.",
        Kind::Item { list: ListKind::Check, checked: true, .. } => "- [x]",
        Kind::Item { list: ListKind::Check, .. } => "- [ ]",
        _ => "-",
    };
    let indent = "    ".repeat(level);
    let text = escape_line_starts(render(&spans_of(&b.runs), false).trim());
    let pad = " ".repeat(indent.len() + marker.len() + 1);
    format!("{indent}{marker} {}", text.replace('\n', &format!("\n{pad}")))
}

fn code_span(text: &str, in_table: bool) -> String {
    let text = text.replace('\u{b}', " ");
    let text = if in_table { text.replace('|', "\\|") } else { text };
    let ticks = "`".repeat(longest_run(&text, '`') + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') { " " } else { "" };
    format!("{ticks}{pad}{text}{pad}{ticks}")
}

fn link_target(url: &str) -> String {
    if url.contains([' ', '(', ')', '<', '>']) {
        format!("<{}>", url.replace('<', "%3C").replace('>', "%3E").replace(' ', "%20"))
    } else {
        url.to_string()
    }
}

/// Escape what Markdown would read as markup. A soft line break (Docs'
/// vertical tab) becomes a hard break.
pub fn escape_text(s: &str, in_table: bool) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        match c {
            '\\' | '*' | '`' | '[' | ']' | '<' | '~' => {
                out.push('\\');
                out.push(c);
            }
            // Inside a word an underscore is never emphasis.
            '_' => {
                let word = |j: Option<&char>| j.is_some_and(|c| c.is_alphanumeric());
                if !(i > 0 && word(chars.get(i - 1)) && word(chars.get(i + 1))) {
                    out.push('\\');
                }
                out.push('_');
            }
            '|' if in_table => out.push_str("\\|"),
            '\u{b}' => out.push_str(if in_table { " " } else { "\\\n" }),
            '\n' if in_table => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// Escape a line start that Markdown would read as a block: a heading, a
/// quote, a list item or a setext underline.
fn escape_line_starts(text: impl AsRef<str>) -> String {
    let text = text.as_ref();
    text.split('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            let lead = &line[..line.len() - trimmed.len()];
            let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
            if trimmed.starts_with('#') || trimmed.starts_with('>') || trimmed.starts_with("- ") || trimmed.starts_with("+ ") || trimmed == "-" || trimmed == "+" {
                format!("{lead}\\{trimmed}")
            } else if !trimmed.is_empty() && (trimmed.chars().all(|c| c == '=') || trimmed.chars().all(|c| c == '-')) {
                format!("{lead}\\{trimmed}")
            } else if !digits.is_empty() && digits.len() <= 9 && matches!(trimmed[digits.len()..].chars().next(), Some('.') | Some(')')) {
                format!("{lead}{digits}\\{}", &trimmed[digits.len()..])
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaping_keeps_plain_words_plain() {
        assert_eq!(escape_text("snake_case and *stars*", false), "snake_case and \\*stars\\*");
        assert_eq!(escape_text("_lead", false), "\\_lead");
        assert_eq!(escape_line_starts("# not a heading"), "\\# not a heading");
        assert_eq!(escape_line_starts("2024. A year"), "2024\\. A year");
        assert_eq!(escape_line_starts("plain"), "plain");
    }

    #[test]
    fn monospace_fonts_are_code() {
        assert!(is_monospace("Courier New"));
        assert!(is_monospace("Roboto Mono"));
        assert!(is_monospace("Source Code Pro"));
        assert!(!is_monospace("Arial"));
        assert!(!is_monospace(""));
    }

    #[test]
    fn code_spans_fence_past_backticks() {
        assert_eq!(code_span("a`b", false), "``a`b``");
        assert_eq!(code_span("`x`", false), "`` `x` ``");
    }
}
