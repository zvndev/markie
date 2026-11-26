//! The random Markdown generator the property tests share.
#![allow(dead_code)]
use markie_google::md;
use serde_json::json;

/// `MARKIE_FUZZ_SEEDS` runs more cases by hand.
pub fn seeds(default: u64) -> u64 {
    std::env::var("MARKIE_FUZZ_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    pub fn chance(&mut self, pct: u64) -> bool {
        self.next() % 100 < pct
    }
}

pub const WORDS: &[&str] = &["alpha", "beta", "gamma", "delta", "sun", "moon", "río", "naïve", "😀", "x", "plan", "notes", "Q3", "team", "draft"];

pub fn phrase(r: &mut Rng) -> String {
    let n = 1 + r.below(5);
    let mut out = Vec::new();
    for _ in 0..n {
        let w = WORDS[r.below(WORDS.len())].to_string();
        let w = match r.below(9) {
            0 => format!("**{w}**"),
            1 => format!("*{w}*"),
            2 => format!("~~{w}~~"),
            3 => format!("`{w}`"),
            4 => format!("[{w}](https://example.com/{})", r.below(9)),
            _ => w,
        };
        out.push(w);
    }
    out.join(" ")
}

#[derive(Clone)]
pub enum B {
    P(String),
    H(u8, String),
    /// kind 0 bullet, 1 numbered, 2 unchecked, 3 checked; level
    Item(u8, usize, String),
    Code(Vec<String>),
}

pub fn render(blocks: &[B]) -> String {
    let mut out = String::new();
    let mut prev_item = false;
    for (i, b) in blocks.iter().enumerate() {
        let is_item = matches!(b, B::Item(..));
        if i > 0 {
            out.push_str(if is_item && prev_item { "\n" } else { "\n\n" });
        }
        match b {
            B::P(t) => out.push_str(t),
            B::H(n, t) => out.push_str(&format!("{} {t}", "#".repeat(*n as usize))),
            B::Item(k, level, t) => {
                let marker = ["-", "1.", "- [ ]", "- [x]"][*k as usize];
                out.push_str(&format!("{}{marker} {t}", "    ".repeat(*level)));
            }
            B::Code(lines) => out.push_str(&format!("```\n{}\n```", lines.join("\n"))),
        }
        prev_item = is_item;
    }
    out.push('\n');
    out
}

/// Keep list nesting valid (a list starts at level 0 and goes one deeper at
/// most) and keep code blocks apart: side by side they are one in a Doc.
pub fn fix_levels(blocks: &mut Vec<B>) {
    let mut i = 1;
    while i < blocks.len() {
        if matches!(blocks[i - 1], B::Code(_)) && matches!(blocks[i], B::Code(_)) {
            blocks.insert(i, B::P("between".into()));
        }
        i += 1;
    }
    let mut prev: Option<(u8, usize)> = None;
    for b in blocks.iter_mut() {
        if let B::P(t) = b
            && md::parse(t).blocks.first().is_none_or(|x| x.runs.iter().filter(|r| !r.text.trim().is_empty()).all(|r| r.code))
        {
            t.push_str(" end");
        }
        if let B::Item(k, level, _) = b {
            let max = prev.map_or(0, |(_, l)| l + 1);
            *level = (*level).min(max);
            // One kind per level run keeps the converter's list ids honest.
            if let Some((pk, pl)) = prev
                && pl == *level
                && (pk == 1) != (*k == 1)
            {
                *k = pk;
            }
            prev = Some((*k, *level));
        } else {
            prev = None;
        }
    }
}

pub fn block(r: &mut Rng, checked: bool) -> B {
    match r.below(10) {
        0 | 1 => B::H(1 + r.below(4) as u8, WORDS[r.below(WORDS.len())].to_string() + " " + WORDS[r.below(WORDS.len())]),
        2..=4 => B::Item(if checked { r.below(4) as u8 } else { r.below(3) as u8 }, r.below(3), phrase(r)),
        5 => B::Code((0..1 + r.below(3)).map(|_| WORDS[r.below(WORDS.len())].to_string()).collect()),
        _ => B::P(para(r)),
    }
}

/// A paragraph that isn't only code (which the converter reads as a code block).
pub fn para(r: &mut Rng) -> String {
    let p = phrase(r);
    if md::parse(&p).blocks.first().is_some_and(|b| b.runs.iter().filter(|x| !x.text.trim().is_empty()).all(|x| x.code)) { format!("{p} end") } else { p }
}

pub fn edit(r: &mut Rng, blocks: &mut Vec<B>) {
    let n = blocks.len();
    match r.below(8) {
        0 if n > 1 => {
            blocks.remove(r.below(n));
        }
        1 | 2 => {
            let at = r.below(n + 1);
            blocks.insert(at, block(r, false));
        }
        3 if n > 0 => {
            // Change a block's kind or level.
            let i = r.below(n);
            let text = match &blocks[i] {
                B::P(t) | B::H(_, t) | B::Item(_, _, t) => t.clone(),
                B::Code(l) => l.join(" "),
            };
            let text = if matches!(blocks[i], B::H(..)) { text } else { text };
            blocks[i] = match r.below(4) {
                0 => B::P(text),
                1 => B::H(1 + r.below(3) as u8, WORDS[r.below(WORDS.len())].into()),
                _ => B::Item(r.below(3) as u8, r.below(3), text),
            };
        }
        _ if n > 0 => {
            // Edit words inside a block.
            let i = r.below(n);
            let add = phrase(r);
            match &mut blocks[i] {
                B::P(t) | B::Item(_, _, t) => {
                    let words: Vec<&str> = t.split(' ').collect();
                    let cut = r.below(words.len() + 1);
                    let mut w: Vec<String> = words.iter().map(|s| s.to_string()).collect();
                    if r.chance(40) && !w.is_empty() {
                        w.remove(cut.min(w.len() - 1));
                    }
                    if r.chance(70) || w.is_empty() {
                        w.insert(cut.min(w.len()), add);
                    }
                    *t = w.join(" ");
                }
                B::H(_, t) => t.push_str(" more"),
                B::Code(l) => l.push("added()".into()),
            }
        }
        _ => blocks.push(B::P(para(r))),
    }
}

pub fn empty_doc() -> serde_json::Value {
    json!({"documentId": "fuzz", "title": "Fuzz", "revisionId": "r0", "tabs": [{"tabProperties": {"tabId": "t.0", "title": "Tab 1"}, "documentTab": {"body": {"content": [
        {"endIndex": 1, "sectionBreak": {}},
        {"startIndex": 1, "endIndex": 2, "paragraph": {"elements": [{"startIndex": 1, "endIndex": 2, "textRun": {"content": "\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}
    ]}}}]})
}

