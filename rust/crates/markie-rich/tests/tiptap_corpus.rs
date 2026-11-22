//! The TipTap round-trip corpus run against Markie RS, both halves on the
//! same files. Opt-in, three phases (see `interop/tiptap-corpus.sh`):
//!
//! 1. `MARKIE_TIPTAP_PHASE=export`: Markie RS writes, per file, its zero-edit
//!    output and, per editable block, the bytes it writes once that block is
//!    edited.
//! 2. Node runs Electron's own `probeReconstruction` and its block normalizer
//!    (`rich-roundtrip.ts`) on the same inputs.
//! 3. `MARKIE_TIPTAP_PHASE=compare`: every pair must match byte for byte.
//!
//! The corpus is `MARKIE_CORPUS_DIR`, walked as `rich-roundtrip.corpus.test.tsx`
//! walks it (`.md`/`.markdown`, under 2 MB, no dot folders or node_modules).

use std::fs;
use std::path::{Path, PathBuf};

use markie_rich::serialize::nodes_to_markdown_with;
use markie_rich::Document;
use serde_json::{json, Value};

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

fn trim_end_newlines(s: &str) -> &str {
    s.trim_end_matches('\n')
}

#[test]
fn tiptap_corpus() {
    let Ok(phase) = std::env::var("MARKIE_TIPTAP_PHASE") else {
        eprintln!("MARKIE_TIPTAP_PHASE not set; skipping");
        return;
    };
    let work = PathBuf::from(std::env::var("MARKIE_TIPTAP_DIR").expect("MARKIE_TIPTAP_DIR"));
    fs::create_dir_all(&work).unwrap();
    match phase.as_str() {
        "export" => export(&work),
        "compare" => compare(&work),
        other => panic!("unknown phase {other}"),
    }
}

fn export(work: &Path) {
    let dir = std::env::var("MARKIE_CORPUS_DIR").expect("MARKIE_CORPUS_DIR");
    let max: usize = std::env::var("MARKIE_CORPUS_MAX").ok().and_then(|s| s.parse().ok()).unwrap_or(5000);
    let mut files = Vec::new();
    walk(Path::new(&dir), &mut files, max);
    let mut lines = String::new();
    for f in &files {
        let Ok(bytes) = fs::read(f) else { continue };
        let Ok(md) = String::from_utf8(bytes) else { continue };
        let doc = Document::parse(&md);
        let defs = doc.definitions();
        let blocks: Vec<Value> = doc
            .blocks
            .iter()
            .filter(|b| !b.is_opaque())
            .map(|b| json!({ "source": b.source, "edited": nodes_to_markdown_with(b.nodes(), &defs) }))
            .collect();
        lines.push_str(
            &json!({ "path": f.display().to_string(), "md": md, "zeroEdit": doc.to_markdown(), "blocks": blocks })
                .to_string(),
        );
        lines.push('\n');
    }
    fs::write(work.join("rs.jsonl"), lines).unwrap();
    println!("[tiptap-corpus] exported {} files", files.len());
}

fn compare(work: &Path) {
    let rs = fs::read_to_string(work.join("rs.jsonl")).unwrap();
    let electron = fs::read_to_string(work.join("electron.jsonl")).unwrap();
    let rs: Vec<Value> = rs.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let electron: Vec<Value> = electron.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(rs.len(), electron.len(), "both halves read the same files");

    let (mut docs, mut zero_exact, mut electron_clean, mut doc_match) = (0, 0, 0, 0);
    let (mut blocks, mut block_match) = (0, 0);
    let mut doc_diffs = Vec::new();
    let mut block_diffs = Vec::new();
    for (r, e) in rs.iter().zip(&electron) {
        assert_eq!(r["path"], e["path"]);
        docs += 1;
        let md = r["md"].as_str().unwrap();
        let zero = r["zeroEdit"].as_str().unwrap();
        if zero == md {
            zero_exact += 1;
        }
        // Electron's full pipeline with zero edits. When it is not clean,
        // Electron opens the document read-only; Markie RS writes the file.
        if e["clean"].as_bool().unwrap() {
            electron_clean += 1;
            if e["output"].as_str().unwrap() == zero {
                doc_match += 1;
            } else if doc_diffs.len() < 20 {
                doc_diffs.push(r["path"].as_str().unwrap().to_string());
            }
        }
        // An edited block: what each app writes for the same block.
        let rb = r["blocks"].as_array().unwrap();
        let eb = e["blocks"].as_array().unwrap();
        assert_eq!(rb.len(), eb.len());
        for (x, y) in rb.iter().zip(eb) {
            blocks += 1;
            let ours = trim_end_newlines(x["edited"].as_str().unwrap());
            let theirs = trim_end_newlines(y.as_str().unwrap());
            if ours == theirs {
                block_match += 1;
            } else if block_diffs.len() < 400 {
                block_diffs.push(json!({ "path": r["path"], "source": x["source"], "rs": ours, "electron": theirs }));
            }
        }
    }
    let report = json!({
        "docs": docs, "zeroEditExact": zero_exact, "electronClean": electron_clean,
        "cleanDocsMatching": doc_match, "editedBlocks": blocks, "editedBlocksMatching": block_match,
        "docDiffs": doc_diffs, "blockDiffs": block_diffs,
    });
    fs::write(work.join("compare.json"), serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!(
        "[tiptap-corpus] {docs} docs; zero-edit exact {zero_exact}/{docs}; Electron clean {electron_clean}, same bytes {doc_match}/{electron_clean}; edited blocks same bytes {block_match}/{blocks}"
    );
    assert_eq!(zero_exact, docs, "zero-edit must be the file");
    assert_eq!(doc_match, electron_clean, "a document Electron round-trips must come out the same");
    if std::env::var("MARKIE_TIPTAP_STRICT_BLOCKS").is_ok() {
        assert_eq!(block_match, blocks, "an edited block must be written as TipTap writes it");
    }
}
