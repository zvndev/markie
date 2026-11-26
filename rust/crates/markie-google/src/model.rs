//! A Doc's body as the Docs API indexes it: one unit per UTF-16 code unit,
//! from index 0 (the section break) to the body's last newline.
//!
//! Two things use it. The write planner (`plan.rs`) applies its own
//! requests to a copy before sending them, reads the result back through
//! the converter, and only sends what comes out right. The fake Google
//! (`fake.rs`) keeps every made-up Doc in it and applies `batchUpdate`.
//!
//! What it follows is Google's request reference,
//! <https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request>:
//! - insertText goes inside a paragraph, never at a table's start; inserted
//!   text takes the style of the character before it, and a newline makes a
//!   paragraph whose style and bullet are copied from the one it splits;
//!   control characters U+0000-U+0008 and U+000C-U+001F are dropped;
//! - deleteContentRange refuses the body's last newline, part of a table or
//!   other element, the newline before a table, table of contents or section
//!   break, and half a surrogate pair;
//! - createParagraphBullets counts and removes leading tabs for the nesting
//!   level, and joins the list just before when its preset matches;
//! - deleteParagraphBullets keeps the look of the nesting with an indent;
//! - a style `fields` mask resets each named field the body leaves unset.
//!
//! In `SUGGEST` mode the same requests become suggestions: inserted text is
//! marked `suggestedInsertionIds`, deleted text stays with
//! `suggestedDeletionIds`, and style changes are recorded beside the style.
//! The converter reads a Doc as if every suggestion were accepted.
use crate::convert::is_monospace;
use crate::md::{ListKind, Marks};
use serde_json::{Map, Value, json};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct Para {
    pub style: Value,
    pub bullet: Option<Value>,
    /// Everything else on the paragraph, kept as Google sent it
    /// (positioned objects, suggested style and bullet changes).
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub enum UKind {
    Text(u16),
    /// Ends a paragraph and carries its style.
    Newline(Arc<Para>),
    /// An inline element that is not text (an image, a footnote mark, a
    /// rule): `len` units, only the first holds it.
    Inline { el: Arc<Value>, first: bool, orig: i64 },
    /// A table, table of contents or section break, kept whole.
    Opaque { el: Arc<Value>, first: bool, orig: i64 },
}

#[derive(Debug, Clone)]
pub struct Unit {
    pub kind: UKind,
    pub style: Arc<Value>,
    /// `suggestedInsertionIds`, `suggestedDeletionIds` and
    /// `suggestedTextStyleChanges`, when there are any.
    pub sugg: Option<Arc<Value>>,
}

impl Unit {
    fn in_paragraph(&self) -> bool {
        !matches!(self.kind, UKind::Opaque { .. })
    }
    pub fn is_newline(&self) -> bool {
        matches!(self.kind, UKind::Newline(_))
    }
}

/// What a request did to positions, for merging with a collaborator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Xf {
    Ins { at: usize, len: usize },
    Del { start: usize, end: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Edit,
    Suggest,
}

#[derive(Debug, Clone)]
pub struct DocModel {
    pub units: Vec<Unit>,
    pub lists: Map<String, Value>,
    /// The Doc as read, for everything the model leaves alone.
    pub doc: Value,
    /// Whether the body sat in `tabs[0].documentTab`.
    tabbed: bool,
    counter: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParaRange {
    pub start: usize,
    /// Index of the paragraph's newline.
    pub newline: usize,
}

impl ParaRange {
    pub fn end(&self) -> usize {
        self.newline + 1
    }
}

fn empty_style() -> Arc<Value> {
    Arc::new(json!({}))
}

fn shift(v: &mut Value, delta: i64) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                if (k == "startIndex" || k == "endIndex") && x.is_i64() {
                    *x = json!(x.as_i64().unwrap() + delta);
                } else {
                    shift(x, delta);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| shift(x, delta)),
        _ => {}
    }
}

fn sugg_of(run: &Value) -> Option<Arc<Value>> {
    let mut m = Map::new();
    for k in ["suggestedInsertionIds", "suggestedDeletionIds"] {
        if let Some(a) = run.get(k).and_then(Value::as_array).filter(|a| !a.is_empty()) {
            m.insert(k.into(), Value::Array(a.clone()));
        }
    }
    if let Some(o) = run.get("suggestedTextStyleChanges").and_then(Value::as_object).filter(|o| !o.is_empty()) {
        m.insert("suggestedTextStyleChanges".into(), Value::Object(o.clone()));
    }
    (!m.is_empty()).then(|| Arc::new(Value::Object(m)))
}

/// The list kind a list's first nesting level shows, as the converter reads it.
pub fn list_kind_of(list: Option<&Value>, level: usize) -> ListKind {
    let props = list.and_then(|l| l.pointer("/listProperties/nestingLevels")).and_then(Value::as_array).and_then(|a| a.get(level));
    let Some(props) = props else { return ListKind::Bullet };
    if props.get("glyphSymbol").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return ListKind::Bullet;
    }
    match props.get("glyphType").and_then(Value::as_str).unwrap_or("GLYPH_TYPE_UNSPECIFIED") {
        "DECIMAL" | "ZERO_DECIMAL" | "ALPHA" | "UPPER_ALPHA" | "ROMAN" | "UPPER_ROMAN" => ListKind::Ordered,
        "GLYPH_TYPE_UNSPECIFIED" => ListKind::Check,
        _ => ListKind::Bullet,
    }
}

/// The preset Markie asks for, for each kind of list.
pub fn preset_for(kind: ListKind) -> &'static str {
    match kind {
        ListKind::Bullet => "BULLET_DISC_CIRCLE_SQUARE",
        ListKind::Ordered => "NUMBERED_DECIMAL_ALPHA_ROMAN",
        ListKind::Check => "BULLET_CHECKBOX",
    }
}

fn preset_kind(preset: &str) -> Option<ListKind> {
    match preset {
        p if p.starts_with("NUMBERED_") => Some(ListKind::Ordered),
        "BULLET_CHECKBOX" => Some(ListKind::Check),
        p if p.starts_with("BULLET_") => Some(ListKind::Bullet),
        _ => None,
    }
}

/// A new list's properties for a preset, nine levels as Google makes them.
fn list_for(preset: &str) -> Value {
    let levels: Vec<Value> = (0..9)
        .map(|i| {
            let indent = json!({"magnitude": 36 * (i + 1) - 18, "unit": "PT"});
            let start = json!({"magnitude": 36 * (i + 1), "unit": "PT"});
            let symbol = ["\u{25cf}", "\u{25cb}", "\u{25a0}"][i % 3];
            let glyph = ["DECIMAL", "ALPHA", "ROMAN"][i % 3];
            match preset_kind(preset).unwrap_or(ListKind::Bullet) {
                ListKind::Bullet => json!({"glyphSymbol": symbol, "glyphFormat": format!("%{i}"), "indentFirstLine": indent, "indentStart": start}),
                ListKind::Ordered => json!({"glyphType": glyph, "glyphFormat": format!("%{i}."), "startNumber": 1, "indentFirstLine": indent, "indentStart": start}),
                ListKind::Check => json!({"glyphFormat": format!("%{i}"), "indentFirstLine": indent, "indentStart": start}),
            }
        })
        .collect();
    json!({"listProperties": {"nestingLevels": levels}})
}

/// The characters stripped from inserted text.
fn stripped(c: u16) -> bool {
    c <= 0x08 || (0x0c..=0x1f).contains(&c)
}

pub type ApplyResult = Result<Vec<Xf>, String>;

impl DocModel {
    /// Read a Doc as `documents.get` returns it (with or without tabs).
    pub fn from_doc(doc: &Value) -> Result<Self, String> {
        let tabbed = doc.get("tabs").and_then(Value::as_array).is_some_and(|t| !t.is_empty());
        let tab = if tabbed { doc.pointer("/tabs/0/documentTab").ok_or("no documentTab")? } else { doc };
        let content = tab.pointer("/body/content").and_then(Value::as_array).cloned().unwrap_or_default();
        let lists = tab.get("lists").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut units: Vec<Unit> = Vec::new();
        for el in &content {
            let start = el.get("startIndex").and_then(Value::as_i64).unwrap_or(0);
            let end = el.get("endIndex").and_then(Value::as_i64).ok_or("element without endIndex")?;
            if units.len() as i64 != start {
                return Err(format!("element at {start} after {} units", units.len()));
            }
            if let Some(p) = el.get("paragraph") {
                let mut extra = p.as_object().cloned().unwrap_or_default();
                extra.remove("elements");
                let style = extra.remove("paragraphStyle").unwrap_or_else(|| json!({}));
                let bullet = extra.remove("bullet");
                let para = Arc::new(Para { style, bullet, extra });
                let elements = p.get("elements").and_then(Value::as_array).cloned().unwrap_or_default();
                for e in &elements {
                    if let Some(run) = e.get("textRun") {
                        let style = Arc::new(run.get("textStyle").cloned().unwrap_or_else(|| json!({})));
                        let sugg = sugg_of(run);
                        let content = run.get("content").and_then(Value::as_str).unwrap_or_default();
                        for ch in content.chars() {
                            if ch == '\n' {
                                units.push(Unit { kind: UKind::Newline(para.clone()), style: style.clone(), sugg: sugg.clone() });
                            } else {
                                let mut buf = [0u16; 2];
                                for cu in ch.encode_utf16(&mut buf) {
                                    units.push(Unit { kind: UKind::Text(*cu), style: style.clone(), sugg: sugg.clone() });
                                }
                            }
                        }
                    } else {
                        let s = e.get("startIndex").and_then(Value::as_i64).unwrap_or(units.len() as i64);
                        let n = e.get("endIndex").and_then(Value::as_i64).unwrap_or(s + 1) - s;
                        let inner = e.as_object().and_then(|o| o.iter().find(|(k, _)| *k != "startIndex" && *k != "endIndex")).map(|(_, v)| v.clone()).unwrap_or_default();
                        let style = Arc::new(inner.get("textStyle").cloned().unwrap_or_else(|| json!({})));
                        let sugg = sugg_of(&inner);
                        let el = Arc::new(e.clone());
                        for k in 0..n.max(1) {
                            units.push(Unit { kind: UKind::Inline { el: el.clone(), first: k == 0, orig: s }, style: style.clone(), sugg: sugg.clone() });
                        }
                    }
                }
                if units.len() as i64 != end || !units.last().is_some_and(Unit::is_newline) {
                    return Err(format!("paragraph {start}..{end} does not end in its newline"));
                }
            } else {
                let el = Arc::new(el.clone());
                for k in 0..(end - start) {
                    units.push(Unit { kind: UKind::Opaque { el: el.clone(), first: k == 0, orig: start }, style: empty_style(), sugg: None });
                }
            }
        }
        Ok(Self { units, lists, doc: doc.clone(), tabbed, counter: 0 })
    }

    /// The Doc as `documents.get` would return it now.
    pub fn to_doc(&self) -> Value {
        let mut content = Vec::new();
        let mut i = 0;
        let n = self.units.len();
        while i < n {
            match &self.units[i].kind {
                UKind::Opaque { el, orig, .. } => {
                    let mut j = i + 1;
                    while j < n && matches!(&self.units[j].kind, UKind::Opaque { el: e, first: false, .. } if Arc::ptr_eq(e, el)) {
                        j += 1;
                    }
                    let mut v = (**el).clone();
                    shift(&mut v, i as i64 - orig);
                    if let Some(o) = v.as_object_mut() {
                        if i > 0 || o.contains_key("startIndex") {
                            o.insert("startIndex".into(), json!(i));
                        }
                        o.insert("endIndex".into(), json!(j));
                    }
                    content.push(v);
                    i = j;
                }
                _ => {
                    let mut j = i;
                    while j < n && !self.units[j].is_newline() {
                        j += 1;
                    }
                    let j = j.min(n - 1);
                    let UKind::Newline(para) = &self.units[j].kind else { break };
                    let mut elements = Vec::new();
                    let mut k = i;
                    while k <= j {
                        match &self.units[k].kind {
                            UKind::Inline { el, orig, .. } => {
                                let mut m = k + 1;
                                while m < j && matches!(&self.units[m].kind, UKind::Inline { el: e, first: false, .. } if Arc::ptr_eq(e, el)) {
                                    m += 1;
                                }
                                let mut v = (**el).clone();
                                shift(&mut v, k as i64 - orig);
                                if let Some(o) = v.as_object_mut() {
                                    o.insert("startIndex".into(), json!(k));
                                    o.insert("endIndex".into(), json!(m));
                                    // Its suggestion marks follow the unit.
                                    if let Some((_, inner)) = o.iter_mut().find(|(key, _)| *key != "startIndex" && *key != "endIndex") {
                                        if let Some(inner) = inner.as_object_mut() {
                                            inner.remove("suggestedInsertionIds");
                                            inner.remove("suggestedDeletionIds");
                                            inner.remove("suggestedTextStyleChanges");
                                            if let Some(s) = self.units[k].sugg.as_deref().and_then(Value::as_object) {
                                                inner.extend(s.clone());
                                            }
                                            inner.insert("textStyle".into(), (*self.units[k].style).clone());
                                        }
                                    }
                                }
                                elements.push(v);
                                k = m;
                            }
                            _ => {
                                let mut m = k;
                                let mut cus: Vec<u16> = Vec::new();
                                while m <= j {
                                    let u = &self.units[m];
                                    let same = |a: &Unit| (Arc::ptr_eq(&a.style, &self.units[k].style) || a.style == self.units[k].style) && a.sugg == self.units[k].sugg;
                                    match &u.kind {
                                        UKind::Text(c) if same(u) => cus.push(*c),
                                        UKind::Newline(_) if same(u) => cus.push(b'\n' as u16),
                                        _ => break,
                                    }
                                    m += 1;
                                }
                                if m == k {
                                    break;
                                }
                                let mut run = json!({"content": String::from_utf16_lossy(&cus), "textStyle": (*self.units[k].style).clone()});
                                if let Some(s) = self.units[k].sugg.as_deref().and_then(Value::as_object) {
                                    run.as_object_mut().unwrap().extend(s.clone());
                                }
                                elements.push(json!({"startIndex": k, "endIndex": m, "textRun": run}));
                                k = m;
                            }
                        }
                    }
                    let mut p = para.extra.clone();
                    p.insert("elements".into(), Value::Array(elements));
                    p.insert("paragraphStyle".into(), para.style.clone());
                    if let Some(b) = &para.bullet {
                        p.insert("bullet".into(), b.clone());
                    }
                    content.push(json!({"startIndex": i, "endIndex": j + 1, "paragraph": Value::Object(p)}));
                    i = j + 1;
                }
            }
        }
        let mut doc = self.doc.clone();
        let tab = if self.tabbed { doc.pointer_mut("/tabs/0/documentTab").unwrap() } else { &mut doc };
        tab["body"] = json!({"content": content});
        if !self.lists.is_empty() || tab.get("lists").is_some() {
            tab["lists"] = Value::Object(self.lists.clone());
        }
        doc
    }

    pub fn len(&self) -> usize {
        self.units.len()
    }

    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }

    /// Every paragraph, in order.
    pub fn paragraphs(&self) -> Vec<ParaRange> {
        let mut out = Vec::new();
        let mut start: Option<usize> = None;
        for (i, u) in self.units.iter().enumerate() {
            match &u.kind {
                UKind::Opaque { .. } => start = None,
                UKind::Newline(_) => {
                    out.push(ParaRange { start: start.unwrap_or(i), newline: i });
                    start = None;
                }
                _ => {
                    start.get_or_insert(i);
                }
            }
        }
        out
    }

    /// The paragraph holding index `i`.
    pub fn paragraph_at(&self, i: usize) -> Option<ParaRange> {
        if !self.units.get(i)?.in_paragraph() {
            return None;
        }
        let mut s = i;
        while s > 0 && self.units[s - 1].in_paragraph() && !self.units[s - 1].is_newline() {
            s -= 1;
        }
        let mut e = i;
        while e < self.units.len() && !self.units[e].is_newline() {
            e += 1;
        }
        (e < self.units.len()).then_some(ParaRange { start: s, newline: e })
    }

    pub fn para(&self, p: ParaRange) -> &Para {
        match &self.units[p.newline].kind {
            UKind::Newline(para) => para,
            _ => unreachable!("a paragraph ends in its newline"),
        }
    }

    /// Whether the paragraph holds only text: no images, chips, footnotes,
    /// rules or suggestions.
    pub fn plain_paragraph(&self, p: ParaRange) -> bool {
        let para = self.para(p);
        !para.extra.contains_key("suggestedParagraphStyleChanges")
            && !para.extra.contains_key("suggestedBulletChanges")
            && !para.extra.get("positionedObjectIds").and_then(Value::as_array).is_some_and(|a| !a.is_empty())
            && self.units[p.start..=p.newline].iter().all(|u| u.sugg.is_none() && matches!(u.kind, UKind::Text(_) | UKind::Newline(_)))
    }

    /// The paragraph's text without its newline.
    pub fn text(&self, p: ParaRange) -> String {
        let cus: Vec<u16> = self.units[p.start..p.newline].iter().filter_map(|u| if let UKind::Text(c) = u.kind { Some(c) } else { None }).collect();
        String::from_utf16_lossy(&cus)
    }

    /// The marks Markdown sees on each unit of a paragraph's text.
    pub fn marks(&self, p: ParaRange) -> Vec<Marks> {
        self.units[p.start..p.newline].iter().map(|u| marks_of(&u.style)).collect()
    }

    pub fn named_style(&self, p: ParaRange) -> String {
        self.para(p).style.get("namedStyleType").and_then(Value::as_str).unwrap_or("NORMAL_TEXT").to_string()
    }

    /// The paragraph's list kind and nesting level, if it has a bullet.
    pub fn bullet(&self, p: ParaRange) -> Option<(String, ListKind, usize)> {
        let b = self.para(p).bullet.as_ref()?;
        let id = b.get("listId").and_then(Value::as_str)?.to_string();
        let level = b.get("nestingLevel").and_then(Value::as_u64).unwrap_or(0) as usize;
        Some((id.clone(), list_kind_of(self.lists.get(&id), level), level))
    }

    /// What follows index `i`: nothing (end of body), a paragraph, or a table-like element.
    pub fn is_paragraph_start(&self, i: usize) -> bool {
        self.units.get(i).is_some_and(Unit::in_paragraph) && (i == 0 || !self.units[i - 1].in_paragraph() || self.units[i - 1].is_newline())
    }

    fn next_id(&mut self, prefix: &str) -> String {
        loop {
            self.counter += 1;
            let id = format!("{prefix}.markie{}", self.counter);
            if !self.lists.contains_key(&id) {
                return id;
            }
        }
    }

    /// Apply one request. `sugg_id` names the suggestion in `Suggest` mode.
    pub fn apply(&mut self, req: &Value, mode: Mode, sugg_id: &str) -> ApplyResult {
        let obj = req.as_object().filter(|o| o.len() == 1).ok_or("a request has exactly one kind")?;
        let (kind, body) = obj.iter().next().unwrap();
        if body.pointer("/location/tabId").is_some() || body.pointer("/range/tabId").is_some() || body.pointer("/location/segmentId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
            return Err("Markie writes only the body of a one-tab Doc".into());
        }
        let range = || -> Result<(usize, usize), String> {
            let s = body.pointer("/range/startIndex").and_then(Value::as_u64).ok_or("range.startIndex")? as usize;
            let e = body.pointer("/range/endIndex").and_then(Value::as_u64).ok_or("range.endIndex")? as usize;
            if s >= e || e > self.units.len() || s == 0 {
                return Err(format!("range {s}..{e} is outside the body"));
            }
            Ok((s, e))
        };
        match kind.as_str() {
            "insertText" => {
                let at = body.pointer("/location/index").and_then(Value::as_u64).ok_or("location.index")? as usize;
                let text = body.get("text").and_then(Value::as_str).ok_or("text")?;
                self.insert_text(at, text, mode, sugg_id)
            }
            "deleteContentRange" => {
                let (s, e) = range()?;
                self.delete(s, e, mode, sugg_id)
            }
            "updateTextStyle" => {
                let (s, e) = range()?;
                let style = body.get("textStyle").cloned().unwrap_or_else(|| json!({}));
                let fields = fields_of(body, &style)?;
                self.text_style(s, e, &style, &fields, mode, sugg_id);
                Ok(Vec::new())
            }
            "updateParagraphStyle" => {
                let (s, e) = range()?;
                let style = body.get("paragraphStyle").cloned().unwrap_or_else(|| json!({}));
                let fields = fields_of(body, &style)?;
                self.paragraph_style(s, e, &style, &fields, mode, sugg_id);
                Ok(Vec::new())
            }
            "createParagraphBullets" => {
                let (s, e) = range()?;
                let preset = body.get("bulletPreset").and_then(Value::as_str).ok_or("bulletPreset")?;
                preset_kind(preset).ok_or("unknown bulletPreset")?;
                Ok(self.create_bullets(s, e, preset, mode, sugg_id))
            }
            "deleteParagraphBullets" => {
                let (s, e) = range()?;
                self.delete_bullets(s, e, mode, sugg_id);
                Ok(Vec::new())
            }
            other => Err(format!("this fake does not know {other}")),
        }
    }

    fn insert_text(&mut self, at: usize, text: &str, mode: Mode, sugg_id: &str) -> ApplyResult {
        if at == 0 || at >= self.units.len() || !self.units[at].in_paragraph() {
            return Err(format!("index {at} must be inside the bounds of an existing paragraph"));
        }
        if matches!(self.units[at].kind, UKind::Text(c) if (0xdc00..0xe000).contains(&c)) {
            return Err("index splits a surrogate pair".into());
        }
        if matches!(&self.units[at].kind, UKind::Inline { first: false, .. }) {
            return Err("index is inside an inline element".into());
        }
        let host = self.paragraph_at(at).ok_or("no paragraph at index")?;
        let para = match &self.units[host.newline].kind {
            UKind::Newline(p) => p.clone(),
            _ => unreachable!(),
        };
        // The character before, unless the paragraph starts here.
        let style = if at > host.start { self.units[at - 1].style.clone() } else { self.units[at].style.clone() };
        let sugg = (mode == Mode::Suggest).then(|| Arc::new(json!({"suggestedInsertionIds": [sugg_id]})));
        let mut new_units = Vec::new();
        for cu in text.encode_utf16() {
            if stripped(cu) {
                continue;
            }
            let kind = if cu == b'\n' as u16 { UKind::Newline(Arc::new((*para).clone())) } else { UKind::Text(cu) };
            new_units.push(Unit { kind, style: style.clone(), sugg: sugg.clone() });
        }
        let len = new_units.len();
        self.units.splice(at..at, new_units);
        Ok(if len > 0 { vec![Xf::Ins { at, len }] } else { Vec::new() })
    }

    fn delete(&mut self, s: usize, e: usize, mode: Mode, sugg_id: &str) -> ApplyResult {
        let n = self.units.len();
        if e >= n && self.units[n - 1].is_newline() {
            return Err("can't delete the last newline of the body".into());
        }
        let boundary_ok = |i: usize| -> bool {
            match self.units.get(i).map(|u| &u.kind) {
                Some(UKind::Opaque { first, .. }) | Some(UKind::Inline { first, .. }) => *first,
                Some(UKind::Text(c)) => !(0xdc00..0xe000).contains(c),
                _ => true,
            }
        };
        if !boundary_ok(s) || !boundary_ok(e) {
            return Err("can't delete part of a table, element or surrogate pair".into());
        }
        // The newline before a table, table of contents or section break goes only with it.
        for i in s..e {
            if self.units[i].is_newline() && matches!(self.units.get(i + 1).map(|u| &u.kind), Some(UKind::Opaque { .. })) && i + 1 >= e {
                return Err("can't delete the newline before a table without the table".into());
            }
        }
        if mode == Mode::Suggest {
            for u in &mut self.units[s..e] {
                let mut m = u.sugg.as_deref().cloned().unwrap_or_else(|| json!({}));
                m["suggestedDeletionIds"] = json!([sugg_id]);
                u.sugg = Some(Arc::new(m));
            }
            return Ok(Vec::new());
        }
        self.units.drain(s..e);
        Ok(vec![Xf::Del { start: s, end: e }])
    }

    fn text_style(&mut self, s: usize, e: usize, style: &Value, fields: &[String], mode: Mode, sugg_id: &str) {
        for u in &mut self.units[s..e] {
            if matches!(u.kind, UKind::Opaque { .. }) {
                continue;
            }
            if mode == Mode::Suggest {
                let mut m = u.sugg.as_deref().cloned().unwrap_or_else(|| json!({}));
                let mut state = Map::new();
                let mut st = Map::new();
                for f in fields {
                    state.insert(format!("{f}Suggested"), json!(true));
                    if let Some(v) = style.get(f) {
                        st.insert(f.clone(), v.clone());
                    }
                }
                merge_suggestion(&mut m, "suggestedTextStyleChanges", sugg_id, "textStyle", "textStyleSuggestionState", st, state);
                u.sugg = Some(Arc::new(m));
                continue;
            }
            let mut next = (*u.style).clone();
            for f in fields {
                match style.get(f) {
                    Some(v) => next[f] = v.clone(),
                    None => {
                        next.as_object_mut().map(|o| o.remove(f));
                    }
                }
            }
            u.style = Arc::new(next);
        }
    }

    fn paragraphs_in(&self, s: usize, e: usize) -> Vec<ParaRange> {
        self.paragraphs().into_iter().filter(|p| p.start < e && p.end() > s).collect()
    }

    fn set_para(&mut self, p: ParaRange, f: impl FnOnce(&mut Para)) {
        if let UKind::Newline(para) = &self.units[p.newline].kind {
            let mut next = (**para).clone();
            f(&mut next);
            self.units[p.newline].kind = UKind::Newline(Arc::new(next));
        }
    }

    fn paragraph_style(&mut self, s: usize, e: usize, style: &Value, fields: &[String], mode: Mode, sugg_id: &str) {
        for p in self.paragraphs_in(s, e) {
            self.set_para(p, |para| {
                if mode == Mode::Suggest {
                    let mut state = Map::new();
                    let mut st = Map::new();
                    for f in fields {
                        state.insert(format!("{f}Suggested"), json!(true));
                        if let Some(v) = style.get(f) {
                            st.insert(f.clone(), v.clone());
                        }
                    }
                    let mut holder = Value::Object(std::mem::take(&mut para.extra));
                    merge_suggestion(&mut holder, "suggestedParagraphStyleChanges", sugg_id, "paragraphStyle", "paragraphStyleSuggestionState", st, state);
                    para.extra = match holder {
                        Value::Object(m) => m,
                        _ => Map::new(),
                    };
                    return;
                }
                for f in fields {
                    match style.get(f) {
                        Some(v) => para.style[f] = v.clone(),
                        None => {
                            para.style.as_object_mut().map(|o| o.remove(f));
                        }
                    }
                }
            });
        }
    }

    fn create_bullets(&mut self, s: usize, e: usize, preset: &str, mode: Mode, sugg_id: &str) -> Vec<Xf> {
        let paras = self.paragraphs_in(s, e);
        let Some(first) = paras.first().copied() else { return Vec::new() };
        let kind = preset_kind(preset).unwrap();
        // The list just before, when its preset matches.
        let before = (first.start > 0).then(|| self.paragraph_at(first.start - 1)).flatten();
        let joined = before.and_then(|b| self.bullet(b)).filter(|(id, _, _)| list_kind_of(self.lists.get(id), 0) == kind).map(|(id, _, _)| id);
        let list_id = match joined {
            Some(id) => id,
            None => {
                let id = self.next_id("kix");
                let mut list = list_for(preset);
                if mode == Mode::Suggest {
                    list["suggestedInsertionIds"] = json!([sugg_id]);
                }
                self.lists.insert(id.clone(), list);
                id
            }
        };
        let mut xfs = Vec::new();
        // Back to front, so earlier paragraphs keep their indices.
        for p in paras.into_iter().rev() {
            let tabs = self.units[p.start..p.newline].iter().take_while(|u| matches!(u.kind, UKind::Text(9))).count();
            let bullet = json!({"listId": list_id, "nestingLevel": tabs, "textStyle": {}});
            let p2 = p;
            self.set_para(p2, |para| {
                if mode == Mode::Suggest {
                    para.extra.insert("suggestedBulletChanges".into(), json!({sugg_id: {"bullet": bullet, "bulletSuggestionState": {"listIdSuggested": true, "nestingLevelSuggested": true}}}));
                } else {
                    para.bullet = Some(bullet);
                    // A bullet's own indent replaces one left by an earlier delete.
                    para.style.as_object_mut().map(|o| {
                        o.remove("indentStart");
                        o.remove("indentFirstLine");
                    });
                }
            });
            if tabs > 0 {
                if mode == Mode::Suggest {
                    for u in &mut self.units[p.start..p.start + tabs] {
                        let mut m = u.sugg.as_deref().cloned().unwrap_or_else(|| json!({}));
                        m["suggestedDeletionIds"] = json!([sugg_id]);
                        u.sugg = Some(Arc::new(m));
                    }
                } else {
                    self.units.drain(p.start..p.start + tabs);
                    xfs.push(Xf::Del { start: p.start, end: p.start + tabs });
                }
            }
        }
        xfs
    }

    fn delete_bullets(&mut self, s: usize, e: usize, mode: Mode, sugg_id: &str) {
        for p in self.paragraphs_in(s, e) {
            let level = self.bullet(p).map(|(_, _, l)| l);
            let Some(level) = level else { continue };
            self.set_para(p, |para| {
                if mode == Mode::Suggest {
                    para.extra.insert("suggestedBulletChanges".into(), json!({sugg_id: {"bulletSuggestionState": {"listIdSuggested": true}}}));
                } else {
                    para.bullet = None;
                    para.style["indentStart"] = json!({"magnitude": 36 * (level + 1), "unit": "PT"});
                }
            });
        }
    }

    /// Accept or reject every suggestion, as the Doc's owner would.
    pub fn resolve_suggestions(&mut self, accept: bool) {
        let mut out = Vec::with_capacity(self.units.len());
        for mut u in std::mem::take(&mut self.units) {
            if let Some(s) = u.sugg.take() {
                let deleted = s.get("suggestedDeletionIds").is_some();
                let inserted = s.get("suggestedInsertionIds").is_some();
                if (accept && deleted) || (!accept && inserted) {
                    continue;
                }
                if accept && let Some(changes) = s.get("suggestedTextStyleChanges") {
                    let run = json!({"textStyle": *u.style, "suggestedTextStyleChanges": changes});
                    u.style = Arc::new(crate::convert::accepted_text_style(&run));
                }
            }
            if let UKind::Newline(p) = &u.kind {
                let mut p = (**p).clone();
                if let Some(Value::Object(changes)) = p.extra.remove("suggestedParagraphStyleChanges") {
                    for c in changes.values().filter(|_| accept) {
                        if let (Some(st), Some(state)) = (c.get("paragraphStyle"), c.get("paragraphStyleSuggestionState").and_then(Value::as_object)) {
                            for (k, on) in state {
                                if on.as_bool() == Some(true) {
                                    let f = k.trim_end_matches("Suggested");
                                    match st.get(f) {
                                        Some(v) => p.style[f] = v.clone(),
                                        None => {
                                            p.style.as_object_mut().map(|o| o.remove(f));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(Value::Object(changes)) = p.extra.remove("suggestedBulletChanges") {
                    for c in changes.values().filter(|_| accept) {
                        p.bullet = c.get("bullet").filter(|b| b.get("listId").is_some()).cloned();
                    }
                }
                u.kind = UKind::Newline(Arc::new(p));
            }
            out.push(u);
        }
        self.units = out;
        for list in self.lists.values_mut() {
            list.as_object_mut().map(|o| o.remove("suggestedInsertionIds"));
        }
    }

    /// Whether the Doc has suggestions waiting.
    pub fn has_suggestions(&self) -> bool {
        self.units.iter().any(|u| u.sugg.is_some() || matches!(&u.kind, UKind::Newline(p) if p.extra.contains_key("suggestedParagraphStyleChanges") || p.extra.contains_key("suggestedBulletChanges")))
    }
}

/// One suggestion's style change, merged with what the same suggestion
/// already changed, so a batch reads as one suggestion per range.
fn merge_suggestion(holder: &mut Value, key: &str, id: &str, style_key: &str, state_key: &str, st: Map<String, Value>, state: Map<String, Value>) {
    let changes = holder.as_object_mut().unwrap().entry(key.to_string()).or_insert_with(|| json!({}));
    let entry = changes.as_object_mut().unwrap().entry(id.to_string()).or_insert_with(|| json!({style_key: {}, state_key: {}}));
    for (f, _) in &state {
        let f = f.trim_end_matches("Suggested");
        match st.get(f) {
            Some(v) => entry[style_key][f] = v.clone(),
            None => {
                entry[style_key].as_object_mut().map(|o| o.remove(f));
            }
        }
    }
    let prior = entry[state_key].as_object_mut().unwrap();
    prior.extend(state);
}

fn fields_of(body: &Value, style: &Value) -> Result<Vec<String>, String> {
    let fields = body.get("fields").and_then(Value::as_str).ok_or("fields is required")?;
    if fields.trim().is_empty() {
        return Err("at least one field must be specified".into());
    }
    if fields.trim() == "*" {
        return Ok(style.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default());
    }
    Ok(fields.split(',').map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect())
}

/// What Markdown sees of a text style.
pub fn marks_of(style: &Value) -> Marks {
    let flag = |k: &str| style.get(k).and_then(Value::as_bool).unwrap_or(false);
    let font = style.pointer("/weightedFontFamily/fontFamily").and_then(Value::as_str).unwrap_or_default();
    Marks { bold: flag("bold"), italic: flag("italic"), strike: flag("strikethrough"), code: is_monospace(font), link: style.pointer("/link/url").and_then(Value::as_str).map(str::to_string) }
}

// ------------------------------------------------------------------ merging

/// `a` moved past `b` (both from the same revision). `a_first` breaks ties:
/// two inserts at one index put `a` first.
pub fn transform(a: Xf, b: Xf, a_first: bool) -> Vec<Xf> {
    match (a, b) {
        (Xf::Ins { at, len }, Xf::Ins { at: bat, len: blen }) => {
            if at < bat || (at == bat && a_first) { vec![Xf::Ins { at, len }] } else { vec![Xf::Ins { at: at + blen, len }] }
        }
        (Xf::Ins { at, len }, Xf::Del { start, end }) => {
            let at = if at <= start { at } else if at >= end { at - (end - start) } else { start };
            vec![Xf::Ins { at, len }]
        }
        (Xf::Del { start, end }, Xf::Ins { at, len }) => {
            if at >= end {
                vec![Xf::Del { start, end }]
            } else if at <= start {
                vec![Xf::Del { start: start + len, end: end + len }]
            } else {
                // Text inserted inside a deleted range survives: two deletes, back to front.
                vec![Xf::Del { start: at + len, end: end + len }, Xf::Del { start, end: at }]
            }
        }
        (Xf::Del { start, end }, Xf::Del { start: bs, end: be }) => {
            let map = |i: usize| if i <= bs { i } else if i >= be { i - (be - bs) } else { bs };
            let (s, e) = (map(start), map(end));
            if s < e { vec![Xf::Del { start: s, end: e }] } else { Vec::new() }
        }
    }
}

/// Move a sequence `a` past a sequence `b` (both from the same revision).
/// Returns `a` as it applies after `b`, and `b` as it applies after `a`.
pub fn transform_seq(a: &[Xf], b: &[Xf], a_first: bool) -> (Vec<Xf>, Vec<Xf>) {
    match (a.len(), b.len()) {
        (0, _) | (_, 0) => (a.to_vec(), b.to_vec()),
        (1, 1) => (transform(a[0], b[0], a_first), transform(b[0], a[0], !a_first)),
        (1, _) => {
            let (x1, y0) = transform_seq(a, &b[..1], a_first);
            let (x2, rest) = transform_seq(&x1, &b[1..], a_first);
            (x2, [y0, rest].concat())
        }
        _ => {
            let (x0, ys1) = transform_seq(&a[..1], b, a_first);
            let (rest, ys2) = transform_seq(&a[1..], &ys1, a_first);
            ([x0, rest].concat(), ys2)
        }
    }
}

/// Where index `i` (an insertion point) lands after `ops`.
pub fn map_point(i: usize, ops: &[Xf], before_ties: bool) -> usize {
    let mut i = i;
    for &op in ops {
        i = match op {
            Xf::Ins { at, len } => {
                if i > at || (i == at && !before_ties) { i + len } else { i }
            }
            Xf::Del { start, end } => {
                if i >= end { i - (end - start) } else if i > start { start } else { i }
            }
        };
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(paras: &[(&str, Value)]) -> Value {
        let mut content = vec![json!({"endIndex": 1, "sectionBreak": {}})];
        let mut i = 1;
        for (text, style) in paras {
            let n = text.encode_utf16().count() as i64 + 1;
            content.push(json!({"startIndex": i, "endIndex": i + n, "paragraph": {"elements": [{"startIndex": i, "endIndex": i + n, "textRun": {"content": format!("{text}\n"), "textStyle": style}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}));
            i += n;
        }
        json!({"tabs": [{"tabProperties": {"tabId": "t.0"}, "documentTab": {"body": {"content": content}}}]})
    }

    #[test]
    fn a_doc_round_trips_through_the_model() {
        let d = doc(&[("Hello", json!({})), ("Wörld 🙂", json!({"bold": true}))]);
        let m = DocModel::from_doc(&d).unwrap();
        assert_eq!(m.to_doc(), d);
        assert_eq!(m.paragraphs().len(), 2);
        assert_eq!(m.text(m.paragraphs()[1]), "Wörld 🙂");
    }

    #[test]
    fn inserting_a_newline_copies_the_paragraph_style() {
        let mut m = DocModel::from_doc(&doc(&[("ab", json!({}))])).unwrap();
        m.apply(&json!({"updateParagraphStyle": {"range": {"startIndex": 1, "endIndex": 2}, "paragraphStyle": {"namedStyleType": "HEADING_2"}, "fields": "namedStyleType"}}), Mode::Edit, "").unwrap();
        m.apply(&json!({"insertText": {"location": {"index": 2}, "text": "\nc"}}), Mode::Edit, "").unwrap();
        let ps = m.paragraphs();
        assert_eq!((m.text(ps[0]), m.text(ps[1])), ("a".into(), "c\u{0}".replace('\u{0}', "b")));
        assert_eq!(m.named_style(ps[1]), "HEADING_2");
    }

    #[test]
    fn deletes_that_would_break_the_body_are_refused() {
        let mut m = DocModel::from_doc(&doc(&[("ab", json!({}))])).unwrap();
        assert!(m.apply(&json!({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": 4}}}), Mode::Edit, "").is_err());
        assert!(m.apply(&json!({"insertText": {"location": {"index": 0}, "text": "x"}}), Mode::Edit, "").is_err());
        assert!(m.apply(&json!({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": 3}}}), Mode::Edit, "").is_ok());
    }

    #[test]
    fn bullets_count_and_remove_leading_tabs_and_join_the_list_before() {
        let mut m = DocModel::from_doc(&doc(&[("a", json!({})), ("\tb", json!({}))])).unwrap();
        m.apply(&json!({"createParagraphBullets": {"range": {"startIndex": 1, "endIndex": 2}, "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}}), Mode::Edit, "").unwrap();
        let xf = m.apply(&json!({"createParagraphBullets": {"range": {"startIndex": 3, "endIndex": 5}, "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}}), Mode::Edit, "").unwrap();
        assert_eq!(xf, vec![Xf::Del { start: 3, end: 4 }]);
        let ps = m.paragraphs();
        let (a, b) = (m.bullet(ps[0]).unwrap(), m.bullet(ps[1]).unwrap());
        assert_eq!(a.0, b.0, "one list");
        assert_eq!((a.2, b.2), (0, 1));
        assert_eq!(m.text(ps[1]), "b");
    }

    #[test]
    fn suggestions_leave_the_text_and_resolve_either_way() {
        let base = DocModel::from_doc(&doc(&[("ab", json!({}))])).unwrap();
        let mut m = base.clone();
        m.apply(&json!({"insertText": {"location": {"index": 2}, "text": "X"}}), Mode::Suggest, "s1").unwrap();
        m.apply(&json!({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": 2}}}), Mode::Suggest, "s1").unwrap();
        assert!(m.has_suggestions());
        let md = crate::convert::doc_to_markdown(&m.to_doc()).markdown;
        assert_eq!(md, "Xb\n");
        let mut accepted = m.clone();
        accepted.resolve_suggestions(true);
        assert_eq!(accepted.text(accepted.paragraphs()[0]), "Xb");
        m.resolve_suggestions(false);
        assert_eq!(m.text(m.paragraphs()[0]), "ab");
    }

    #[test]
    fn concurrent_inserts_and_deletes_transform() {
        assert_eq!(transform(Xf::Ins { at: 5, len: 2 }, Xf::Ins { at: 1, len: 3 }, true), vec![Xf::Ins { at: 8, len: 2 }]);
        assert_eq!(transform(Xf::Del { start: 5, end: 9 }, Xf::Del { start: 7, end: 12 }, true), vec![Xf::Del { start: 5, end: 7 }]);
        assert_eq!(transform(Xf::Del { start: 2, end: 6 }, Xf::Ins { at: 4, len: 1 }, true), vec![Xf::Del { start: 5, end: 7 }, Xf::Del { start: 2, end: 4 }]);
        assert_eq!(map_point(10, &[Xf::Ins { at: 3, len: 2 }, Xf::Del { start: 0, end: 1 }], false), 11);
        let (a, b) = transform_seq(&[Xf::Ins { at: 10, len: 3 }, Xf::Del { start: 1, end: 2 }], &[Xf::Ins { at: 4, len: 5 }], true);
        assert_eq!(a, vec![Xf::Ins { at: 15, len: 3 }, Xf::Del { start: 1, end: 2 }]);
        assert_eq!(b, vec![Xf::Ins { at: 3, len: 5 }]);
    }
}
