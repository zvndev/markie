//! Device index scan and Library search timings, for `rust/scripts/bench`.
//!
//!   cargo run --release -p markie-core --example perf_index -- [runs] [query…]
//!
//! Scans the home folder `runs` times (read only, the app's own budget and
//! rules), then runs each query against the last snapshot. Prints one JSON
//! object: scan times, file counts, and per-query latencies in ms.

use std::time::Instant;

use markie_core::index::{ScanOptions, scan};
use markie_core::search::{LibraryQuery, search_library};

fn main() {
    let mut args = std::env::args().skip(1);
    let runs: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(5);
    let mut queries: Vec<String> = args.collect();
    if queries.is_empty() {
        queries = ["readme", "plan", "markie perf", "zzzz-no-match", "a"].map(String::from).to_vec();
    }
    let home = dirs::home_dir().expect("home folder");
    let opts = ScanOptions::from_env(&home, Vec::new());

    let mut scans = Vec::new();
    let mut snapshot = None;
    for _ in 0..runs {
        let t = Instant::now();
        let snap = scan(&opts);
        scans.push(t.elapsed().as_secs_f64() * 1000.0);
        snapshot = Some(snap);
    }
    let snap = snapshot.expect("at least one run");
    let with_snippets = snap.files.iter().filter(|f| f.snippet.is_some()).count();

    let mut query_rows = Vec::new();
    for q in &queries {
        let query = LibraryQuery { text: q.clone(), formats: Vec::new() };
        let mut times = Vec::new();
        let mut hits = 0;
        for _ in 0..runs.max(5) {
            let t = Instant::now();
            hits = search_library(&snap.files, &query).len();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        query_rows.push(serde_json::json!({ "query": q, "ms": times, "hits": hits }));
    }
    let out = serde_json::json!({
        "scan_ms": scans,
        "files": snap.files.len(),
        "dirs": snap.dirs,
        "snippets": with_snippets,
        "truncated": format!("{:?}", snap.truncated),
        "queries": query_rows,
    });
    println!("{out}");
}
