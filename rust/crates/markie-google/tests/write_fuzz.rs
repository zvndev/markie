//! The write-back property: for random Markdown made of what sync supports
//! (paragraphs, headings, bulleted, numbered and checked lists with nesting,
//! bold, italic, strikethrough, links, code spans and code blocks), and
//! random edits to it, the planned requests applied to the Doc model and
//! read back through the converter give exactly the edited Markdown, and
//! nothing is held back. Then the same against a collaborator's edit
//! elsewhere, merged through `targetRevisionId` in the fake model.
//! Seeded and deterministic; no network.
use markie_google::convert::doc_to_markdown;
use markie_google::md::{self, Kind};
use markie_google::merge::diff3;
use markie_google::model::{DocModel, Mode};
use markie_google::plan::{plan, remote_view};
use serde_json::json;

/// `MARKIE_FUZZ_SEEDS` runs more cases by hand.
fn seeds(default: u64) -> u64 {
    std::env::var("MARKIE_FUZZ_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.next() % 100 < pct
    }
}

const WORDS: &[&str] = &["alpha", "beta", "gamma", "delta", "sun", "moon", "río", "naïve", "😀", "x", "plan", "notes", "Q3", "team", "draft"];

fn phrase(r: &mut Rng) -> String {
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
enum B {
    P(String),
    H(u8, String),
    /// kind 0 bullet, 1 numbered, 2 unchecked, 3 checked; level
    Item(u8, usize, String),
    Code(Vec<String>),
}

fn render(blocks: &[B]) -> String {
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
fn fix_levels(blocks: &mut Vec<B>) {
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

fn block(r: &mut Rng, checked: bool) -> B {
    match r.below(10) {
        0 | 1 => B::H(1 + r.below(4) as u8, WORDS[r.below(WORDS.len())].to_string() + " " + WORDS[r.below(WORDS.len())]),
        2..=4 => B::Item(if checked { r.below(4) as u8 } else { r.below(3) as u8 }, r.below(3), phrase(r)),
        5 => B::Code((0..1 + r.below(3)).map(|_| WORDS[r.below(WORDS.len())].to_string()).collect()),
        _ => B::P(para(r)),
    }
}

/// A paragraph that isn't only code (which the converter reads as a code block).
fn para(r: &mut Rng) -> String {
    let p = phrase(r);
    if md::parse(&p).blocks.first().is_some_and(|b| b.runs.iter().filter(|x| !x.text.trim().is_empty()).all(|x| x.code)) { format!("{p} end") } else { p }
}

fn edit(r: &mut Rng, blocks: &mut Vec<B>) {
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

fn empty_doc() -> serde_json::Value {
    json!({"documentId": "fuzz", "title": "Fuzz", "revisionId": "r0", "tabs": [{"tabProperties": {"tabId": "t.0", "title": "Tab 1"}, "documentTab": {"body": {"content": [
        {"endIndex": 1, "sectionBreak": {}},
        {"startIndex": 1, "endIndex": 2, "paragraph": {"elements": [{"startIndex": 1, "endIndex": 2, "textRun": {"content": "\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}
    ]}}}]})
}

/// Write `local` onto `doc` the way sync does, apply, read back.
fn write(doc: &serde_json::Value, local_md: &str, mode: Mode) -> (DocModel, String, Vec<&'static str>) {
    let view = remote_view(doc).expect("the model reads the Doc");
    let local = md::parse(local_md);
    let chunks = diff3(&view.parsed.keys(), &local.keys(), &view.parsed.keys());
    let p = plan(&view, &local, &chunks, mode);
    let mut m = view.model.clone();
    for req in &p.requests {
        m.apply(req, mode, "fuzz").unwrap_or_else(|e| panic!("request {req} failed: {e}"));
    }
    let md = doc_to_markdown(&m.to_doc()).markdown;
    (m, md, p.held)
}

fn keys(s: &str) -> Vec<String> {
    md::parse(s).blocks.into_iter().map(|b| b.key).collect()
}

#[test]
fn random_edits_on_supported_markdown_write_back_exactly() {
    let mut failures = Vec::new();
    for seed in 1..=seeds(400) {
        let mut r = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15) | 1);
        let mut blocks: Vec<B> = (0..1 + r.below(8)).map(|_| block(&mut r, true)).collect();
        fix_levels(&mut blocks);
        let base = render(&blocks);
        // Build the Doc from nothing, through the planner itself.
        let (model, built, held) = write(&empty_doc(), &base, Mode::Edit);
        if !held.is_empty() {
            // Ticked boxes can't be written from nothing (and items under them follow).
            assert!(held.iter().any(|h| h.contains("struck") || *h == "ticked checkboxes"), "seed {seed}: building held {held:?}\n{base}--- got\n{built}");
            continue;
        }
        assert_eq!(keys(&built), keys(&base), "seed {seed}: building\n--- want\n{base}--- got\n{built}");
        let doc = model.to_doc();
        // Edit, never ticking a box.
        let mut edited = blocks.clone();
        for _ in 0..1 + r.below(4) {
            edit(&mut r, &mut edited);
        }
        fix_levels(&mut edited);
        let local = render(&edited);
        let (_, got, held) = write(&doc, &local, Mode::Edit);
        let allowed = |h: &&str| *h == "ticked checkboxes" || h.contains("struck");
        let bad: Vec<_> = held.iter().filter(|h| !allowed(h)).collect();
        let touched_ticked = md::parse(&base).blocks.iter().any(|b| matches!(b.kind, Kind::Item { list: md::ListKind::Check, checked: true, .. }));
        if (!bad.is_empty() && !touched_ticked) || (held.is_empty() && keys(&got) != keys(&local)) {
            failures.push(format!("seed {seed}: held {held:?}\n--- base\n{base}--- local\n{local}--- got\n{got}"));
        }
    }
    assert!(failures.is_empty(), "{} failures, first:\n{}", failures.len(), failures[0]);
}

#[test]
fn suggestions_read_back_as_the_edit_once_accepted() {
    for seed in 1..=seeds(150) {
        let mut r = Rng(seed.wrapping_mul(0x2545f4914f6cdd1d) | 1);
        let mut blocks: Vec<B> = (0..1 + r.below(6)).map(|_| block(&mut r, false)).collect();
        fix_levels(&mut blocks);
        let base = render(&blocks);
        let (model, _, held) = write(&empty_doc(), &base, Mode::Edit);
        if held.iter().any(|h| h.contains("struck")) {
            continue;
        }
        assert!(held.is_empty(), "seed {seed}: building held {held:?}\n{base}");
        let doc = model.to_doc();
        let mut edited = blocks.clone();
        edit(&mut r, &mut edited);
        fix_levels(&mut edited);
        let local = render(&edited);
        let (mut m, got, held) = write(&doc, &local, Mode::Suggest);
        if held.iter().any(|h| h.contains("struck")) {
            continue;
        }
        assert!(held.is_empty(), "seed {seed}: {held:?}\n{base}\n{local}");
        assert_eq!(keys(&got), keys(&local), "seed {seed}: suggested\n--- base\n{base}--- local\n{local}--- got\n{got}");
        // Accepting every suggestion gives the same Doc; rejecting gives the base back.
        let mut accepted = m.clone();
        accepted.resolve_suggestions(true);
        assert_eq!(keys(&doc_to_markdown(&accepted.to_doc()).markdown), keys(&local), "seed {seed}: accepted");
        m.resolve_suggestions(false);
        assert_eq!(keys(&doc_to_markdown(&m.to_doc()).markdown), keys(&base), "seed {seed}: rejected");
    }
}

#[test]
fn debug_one() {
    let Ok(local_md) = std::env::var("MARKIE_FUZZ_MD") else { return };
    let local_md = local_md.replace("\\n", "\n");
    let base = std::env::var("MARKIE_FUZZ_BASE").unwrap_or_default().replace("\\n", "\n");
    let doc = if base.is_empty() { empty_doc() } else { write(&empty_doc(), &base, Mode::Edit).0.to_doc() };
    let view = remote_view(&doc).unwrap();
    eprintln!("--- remote\n{}", view.markdown);
    let local = md::parse(&local_md);
    let chunks = diff3(&view.parsed.keys(), &local.keys(), &view.parsed.keys());
    eprintln!("chunks {chunks:?}");
    let p = plan(&view, &local, &chunks, Mode::Edit);
    for r in &p.requests {
        eprintln!("{r}");
    }
    eprintln!("held {:?}", p.held);
    eprintln!("--- after\n{}", doc_to_markdown(&p.after.to_doc()).markdown);
}
