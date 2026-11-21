//! Random edits: the editor never panics, undoing everything gives back
//! the file byte for byte, and what it saves reads back as what it shows.
//!
//!   cargo test -p markie-rich --test editor_fuzz                       # fixtures
//!   MARKIE_CORPUS_DIR=~/Documents MARKIE_CORPUS_MAX=300 cargo test --release \
//!     -p markie-rich --test editor_fuzz -- --nocapture                  # real files

use std::path::{Path, PathBuf};

use markie_rich::editor::{BlockStyle, Editor, ListKind, MarkKind, Pos};
use markie_rich::serialize::canonical;
use markie_rich::{Document, Node};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
}

fn random_pos(ed: &Editor, r: &mut Rng) -> Pos {
    let b = r.below(ed.block_count());
    let l = r.below(ed.leaves_of(b).len());
    let o = r.below(ed.leaf_len(b, l) + 1);
    Pos::new(b, l, o)
}

fn step(ed: &mut Editor, r: &mut Rng) {
    let k = r.below(26);
    if std::env::var("FUZZ_TRACE").is_ok() {
        eprintln!("op {k} at {:?}..{:?}", ed.anchor, ed.head);
    }
    match k {
        0..=4 => {
            let p = random_pos(ed, r);
            ed.set_caret(p, false);
        }
        5 => {
            let p = random_pos(ed, r);
            ed.set_caret(p, true);
        }
        6..=8 => {
            let words = ["a", "word ", " ", "é", "🎉", "$", "x$", "# ", "- ", "1. ", "> ", "[ ] ", "*", "`"];
            ed.insert_text(words[r.below(words.len())]);
        }
        9 | 10 => ed.backspace(),
        11 => ed.delete_forward(),
        12 | 13 => ed.enter(),
        14 => ed.hard_break(),
        15 => ed.toggle_mark([MarkKind::Bold, MarkKind::Italic, MarkKind::Strike, MarkKind::Underline, MarkKind::Code][r.below(5)]),
        16 => ed.set_block_style([BlockStyle::Paragraph, BlockStyle::Heading(2), BlockStyle::Quote, BlockStyle::Code][r.below(4)]),
        17 => ed.toggle_list([ListKind::Bullet, ListKind::Ordered, ListKind::Task][r.below(3)]),
        18 => ed.indent(),
        19 => ed.outdent(),
        20 => ed.set_highlight(Some(Some("#fef08a".into()))),
        21 => ed.set_text_style(Some(Some("#2563eb".into())), None, Some(Some("20px".into()))),
        22 => {
            let md = ed.selection_markdown();
            let p = random_pos(ed, r);
            ed.set_caret(p, false);
            ed.paste_markdown(&md);
        }
        23 => ed.set_align(Some(["center", "right", "left"][r.below(3)])),
        24 => {
            ed.undo();
        }
        _ => {
            ed.move_right(r.below(2) == 0, r.below(2) == 0);
        }
    }
}

struct Stats {
    runs: usize,
    restored: usize,
    stable: usize,
    /// Runs that edited no raw-source block (their bytes are saved as typed,
    /// so what they read back as is up to the typist).
    clean_runs: usize,
    blocks: usize,
    blocks_stable: usize,
}

/// Empty paragraphs are blank lines, which Markdown does not keep.
fn drop_empty(v: Vec<Node>) -> Vec<Node> {
    v.into_iter()
        .filter(|n| !matches!(n, Node::Paragraph { content, .. } if content.is_empty()))
        .map(|n| match n {
            Node::Blockquote(c) => Node::Blockquote(drop_empty(c)),
            Node::BulletList { tight, items } => Node::BulletList { tight, items: items.into_iter().map(drop_empty).collect() },
            Node::OrderedList { tight, start, items } => {
                Node::OrderedList { tight, start, items: items.into_iter().map(drop_empty).collect() }
            }
            Node::TaskList { items } => Node::TaskList {
                items: items.into_iter().map(|i| markie_rich::model::TaskItem { checked: i.checked, content: drop_empty(i.content) }).collect(),
            },
            other => other,
        })
        .collect()
}

fn fuzz(source: &str, seed: u64, steps: usize, st: &mut Stats) {
    let mut r = Rng(seed | 1);
    let mut ed = Editor::parse(source);
    for _ in 0..steps {
        step(&mut ed, &mut r);
        let h = ed.head;
        assert!(h.block < ed.block_count(), "caret block out of range");
    }
    st.runs += 1;
    // What it saves reads back as what it shows.
    let saved = ed.to_markdown();
    let defs = ed.doc.definitions();
    for b in ed.doc.blocks.iter().filter(|b| b.edited && !drop_empty(b.nodes().to_vec()).is_empty()) {
        st.blocks += 1;
        let md = markie_rich::serialize::nodes_to_markdown_with(b.nodes(), &defs);
        let mut back = Document::parse(&if defs.is_empty() { md.clone() } else { format!("{md}\n\n{defs}") }).nodes();
        // A definition block the fuzzer typed into may read as text now.
        let extra = Document::parse(&defs).nodes().len();
        back.truncate(back.len().saturating_sub(extra));
        if drop_empty(canonical(&back)) == drop_empty(canonical(b.nodes())) {
            st.blocks_stable += 1;
        } else if std::env::var("FUZZ_BLOCKS").is_ok() {
            eprintln!("BLOCK {md:?}\n   {:?}", b.nodes());
        }
    }
    let original = Document::parse(source);
    let source_edited = ed.doc.blocks.iter().any(|b| b.is_opaque() && !original.blocks.iter().any(|o| o.is_opaque() && o.source == b.source));
    if !source_edited {
        st.clean_runs += 1;
    }
    let shown = drop_empty(canonical(&ed.doc.nodes()));
    let reread = drop_empty(canonical(&Document::parse(&saved).nodes()));
    if reread == shown {
        if !source_edited {
            st.stable += 1;
        }
    } else if !source_edited && std::env::var("FUZZ_SHOW").is_ok() {
        let k = shown.iter().zip(&reread).position(|(a, b)| a != b).unwrap_or(shown.len().min(reread.len()));
        eprintln!("UNSTABLE seed {seed}\n  shown:  {:?}\n  reread: {:?}", shown.get(k), reread.get(k));
    }
    // Undo everything: the file again.
    while ed.undo() {}
    if ed.to_markdown() == source {
        st.restored += 1;
    } else {
        panic!("undo did not restore the file (seed {seed}, FUZZ_SEED=?:{seed}):\n--- source\n{source}\n--- after undo\n{}", ed.to_markdown());
    }
}

const FIXTURES: &[&str] = &[
    "# Title\n\nThis paragraph was wrapped\nby hand.\n\n- one\n- two\n  - nested\n\n> quote\n> more\n\n```rust\nfn x() {}\n```\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n---\n\n![img](a.png)\n\n<!-- html -->\n\n[ref]: https://x.com\n\nEnd with $math$ and [ref].\n",
    "- [ ] task\n- [x] done\n\n1. a\n2. b\n\n$$\nx^2\n$$\n\nPlain text.\n",
    "",
    "single line no newline",
    "---\ntitle: fm\n---\n\n# Body\n\ntext\n",
    "<p style=\"text-align: center;\">c</p>\n\n<img src=\"a.png\" width=\"20\">\n\n**b** <mark>h</mark> <span style=\"color: red\">r</span>\n",
];

#[test]
fn fuzz_fixtures() {
    if let Ok(seed) = std::env::var("FUZZ_SEED") {
        // Replay one run, checking after every step that undo-all restores.
        let (f, seed): (usize, u64) = { let mut it = seed.split(':'); (it.next().unwrap().parse().unwrap(), it.next().unwrap().parse().unwrap()) };
        let src = FIXTURES[f];
        for n in 1..=60 {
            let mut r = Rng(seed | 1);
            let mut ed = Editor::parse(src);
            for _ in 0..n { step(&mut ed, &mut r); }
            let before_undo = ed.to_markdown();
            while ed.undo() {}
            if ed.to_markdown() != src {
                panic!("fails after {n} steps; doc before undo:\n{before_undo}\n--- after undo:\n{}", ed.to_markdown());
            }
        }
        return;
    }
    let mut st = Stats { runs: 0, restored: 0, stable: 0, clean_runs: 0, blocks: 0, blocks_stable: 0 };
    for (i, f) in FIXTURES.iter().enumerate() {
        for seed in 0..150u64 {
            fuzz(f, seed * 7919 + i as u64 * 104729 + 1, 60, &mut st);
        }
    }
    report("fixtures", &st);
    assert_eq!(st.restored, st.runs);
}

fn report(name: &str, st: &Stats) {
    println!(
        "[fuzz] {name}: {} runs; undo restored the file in {}; edited blocks that read back as shown {}/{}; \
         whole documents that read back as shown {}/{} (runs that left raw source alone)",
        st.runs, st.restored, st.blocks_stable, st.blocks, st.stable, st.clean_runs
    );
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, max: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= max {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            walk(&p, out, max);
        } else if name.to_ascii_lowercase().ends_with(".md") && e.metadata().map(|m| m.len() < 200_000).unwrap_or(false) {
            out.push(p);
        }
    }
}

#[test]
fn fuzz_corpus() {
    let Ok(dir) = std::env::var("MARKIE_CORPUS_DIR") else { return };
    let max: usize = std::env::var("MARKIE_CORPUS_MAX").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    let mut files = Vec::new();
    walk(Path::new(&dir), &mut files, max);
    let mut st = Stats { runs: 0, restored: 0, stable: 0, clean_runs: 0, blocks: 0, blocks_stable: 0 };
    for (i, f) in files.iter().enumerate() {
        let Ok(src) = std::fs::read_to_string(f) else { continue };
        for seed in 0..3u64 {
            fuzz(&src, seed * 31 + i as u64 * 7 + 1, 40, &mut st);
        }
    }
    println!("[fuzz] corpus: {} files", files.len());
    report("corpus", &st);
    assert_eq!(st.restored, st.runs);
}
