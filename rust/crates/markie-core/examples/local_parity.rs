//! Dump what Markie RS's index, global search and Projects make of a folder,
//! as JSON, so `rust/scripts/parity/local-parity.mjs` can run Electron's own
//! code on the same rows and compare. Usage:
//! `cargo run -p markie-core --example local_parity -- <home> <query>...`

use std::time::Duration;

use markie_core::doc_text::{SearchOptions, TextCache, search_documents, search_pool};
use markie_core::index::{ScanOptions, scan};
use serde_json::json;

fn main() {
    let mut args = std::env::args().skip(1);
    let home = std::path::PathBuf::from(args.next().expect("home folder"));
    // `--unbounded` lifts the 1.8 s search budget on both sides, so a
    // comparison measures the rules rather than which runtime reads faster.
    let mut queries: Vec<String> = args.collect();
    let unbounded = queries.first().is_some_and(|q| q == "--unbounded");
    if unbounded {
        queries.remove(0);
    }
    let budget = if unbounded { Duration::from_secs(3600) } else { Duration::from_millis(1800) };
    let snap = scan(&ScanOptions::for_home(&home));
    let rows = search_pool(&snap.files, &[]);
    let cache = std::sync::Mutex::new(TextCache::default());
    let searches: Vec<_> = queries
        .iter()
        .map(|q| {
            let r = search_documents(&rows, q, &SearchOptions { supersede: false, max_time: budget, ..Default::default() }, &cache);
            json!({ "query": q, "partial": r.partial, "scanned": r.scanned, "results": r.results.iter().map(|h| json!({
                "path": h.path, "nameHit": h.name_hit, "excerpt": h.excerpt.as_ref().map(|e| e.text.clone()),
            })).collect::<Vec<_>>() })
        })
        .collect();
    let db = rusqlite::Connection::open_in_memory().unwrap();
    let state = markie_core::projects::compute(&db, &snap.files, &home.join("Documents/Markie"), &home, Duration::from_secs(10)).unwrap();
    let projects: Vec<_> = state
        .taxonomy
        .projects
        .iter()
        .map(|p| json!({
            "key": p.key, "name": p.name, "fileCount": p.file_count,
            "blocks": p.blocks.iter().map(|b| json!({"id": b.id, "name": b.name, "files": b.files.iter().map(|f| &f.path).collect::<Vec<_>>()})).collect::<Vec<_>>(),
            "loose": p.loose_files.iter().map(|f| &f.path).collect::<Vec<_>>(),
        }))
        .collect();
    let out = json!({
        "rows": snap.files.iter().map(|d| json!({"path": d.path, "name": d.name, "dir": d.dir, "format": d.format, "mtimeMs": d.mtime_ms})).collect::<Vec<_>>(),
        "unbounded": unbounded,
        "searches": searches,
        "projects": projects,
        "ignored": state.taxonomy.ignored_count,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
