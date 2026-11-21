//! Opt-in corpus audit, the Rust side of `rich-roundtrip.corpus.test.tsx`.
//!
//!   MARKIE_CORPUS_DIR=~/Documents cargo test -p markie-rich --test corpus -- --nocapture
//!
//! For every Markdown file it checks that a zero-edit save is byte for byte
//! the file, and for every editable block that an edit would be written in a
//! form that reads back as what the user saw (stable). MARKIE_CORPUS_REPORT
//! appends the numbers as one JSON line.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use markie_rich::serialize::is_stable;
use markie_rich::Document;

fn walk(dir: &Path, out: &mut Vec<PathBuf>, max: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
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
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            walk(&p, out, max);
        } else if ft.is_file() {
            let lower = name.to_ascii_lowercase();
            if (lower.ends_with(".md") || lower.ends_with(".markdown"))
                && e.metadata().map(|m| m.len() < 2_000_000).unwrap_or(false)
            {
                out.push(p);
            }
        }
    }
}

#[test]
fn corpus_zero_edit_and_edit_stability() {
    let Ok(dir) = std::env::var("MARKIE_CORPUS_DIR") else {
        eprintln!("MARKIE_CORPUS_DIR not set; skipping");
        return;
    };
    let max: usize = std::env::var("MARKIE_CORPUS_MAX").ok().and_then(|s| s.parse().ok()).unwrap_or(5000);
    let mut files = Vec::new();
    walk(Path::new(&dir), &mut files, max);
    assert!(!files.is_empty());

    let started = Instant::now();
    let (mut exact, mut not_utf8) = (0usize, 0usize);
    let (mut blocks, mut opaque, mut stable, mut verbatim) = (0usize, 0usize, 0usize, 0usize);
    let mut docs_all_stable = 0usize;
    let mut failures: Vec<String> = Vec::new();
    let mut unstable_samples: Vec<String> = Vec::new();
    for f in &files {
        let Ok(bytes) = fs::read(f) else { continue };
        let Ok(md) = String::from_utf8(bytes) else {
            not_utf8 += 1;
            continue;
        };
        let doc = Document::parse(&md);
        if doc.to_markdown() == md {
            exact += 1;
        } else if failures.len() < 20 {
            failures.push(f.display().to_string());
        }
        let defs = doc.definitions();
        let mut doc_stable = true;
        for b in &doc.blocks {
            blocks += 1;
            if b.is_opaque() {
                opaque += 1;
                continue;
            }
            if is_stable(b.nodes(), &defs) {
                stable += 1;
            } else {
                doc_stable = false;
                if unstable_samples.len() < 25 {
                    unstable_samples.push(format!("{}: {:?}", f.display(), b.source.chars().take(160).collect::<String>()));
                }
            }
            if markie_rich::serialize::nodes_to_markdown_with(b.nodes(), &defs) == b.source {
                verbatim += 1;
            }
        }
        if doc_stable {
            docs_all_stable += 1;
        }
    }
    let n = files.len() - not_utf8;
    let editable = blocks - opaque;
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    println!("[corpus] {n} files ({not_utf8} not UTF-8 skipped), {:.2} ms per document", ms / n as f64);
    println!("[corpus] zero-edit byte-identical: {exact}/{n}");
    println!("[corpus] blocks: {blocks}, opaque (kept as source): {opaque}, editable: {editable}");
    println!("[corpus] editable blocks whose edit reads back as shown: {stable}/{editable}");
    println!("[corpus] documents with every block stable: {docs_all_stable}/{n}");
    println!("[corpus] editable blocks the serializer writes exactly as the source: {verbatim}/{editable}");
    println!("[corpus] zero-edit failures: {failures:#?}");
    println!("[corpus] unstable samples: {unstable_samples:#?}");
    if let Ok(report) = std::env::var("MARKIE_CORPUS_REPORT") {
        use std::io::Write;
        let line = serde_json::json!({
            "dir": dir, "files": n, "zeroEditExact": exact, "blocks": blocks, "opaque": opaque,
            "editable": editable, "stable": stable, "verbatim": verbatim, "docsAllStable": docs_all_stable,
            "msPerDoc": ms / n as f64,
        });
        let mut f = fs::OpenOptions::new().create(true).append(true).open(report).unwrap();
        writeln!(f, "{line}").unwrap();
    }
    assert_eq!(exact, n, "zero-edit must be byte-identical for every document");
}
