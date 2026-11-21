//! Opt-in corpus audit: render every formula in real Markdown files.
//!
//!   MARKIE_CORPUS_DIR=~/Desktop/Coding/ZVN MARKIE_CORPUS_MAX=5000 \
//!     cargo test --release -p markie-math --features corpus --test corpus -- --nocapture
//!
//! Formulas are found the way the editor finds them: `markie_rich::Document`
//! parses each file and we walk the nodes for `Inline::Math` and
//! `Node::MathBlock`. Reports count, success rate, median and p95 render time,
//! and samples of failures. MARKIE_CORPUS_REPORT appends one JSON line.
//! MARKIE_CORPUS_DUMP writes every formula and its result as JSON lines, which
//! `scripts/katex-compare.mjs` checks against KaTeX itself.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use markie_math::{MathError, MathStyle, render, strip_delimiters};
use markie_rich::{Document, Inline, Node};

fn walk(dir: &Path, out: &mut Vec<PathBuf>, max: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= max {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name.starts_with("target-") {
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

fn collect_inline(content: &[Inline], out: &mut Vec<String>) {
    for i in content {
        if let Inline::Math { source } = i {
            out.push(source.clone());
        }
    }
}

fn collect(nodes: &[Node], out: &mut Vec<String>) {
    for n in nodes {
        match n {
            Node::Paragraph { content, .. } | Node::Heading { content, .. } => collect_inline(content, out),
            Node::MathBlock { source } => out.push(source.clone()),
            Node::Blockquote(children) => collect(children, out),
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                for item in items {
                    collect(item, out);
                }
            }
            Node::TaskList { items } => {
                for item in items {
                    collect(&item.content, out);
                }
            }
            Node::Table { rows } => {
                for row in rows {
                    for cell in row {
                        collect(&cell.content, out);
                    }
                }
            }
            _ => {}
        }
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

#[test]
fn corpus_math_renders() {
    let Ok(dir) = std::env::var("MARKIE_CORPUS_DIR") else {
        eprintln!("MARKIE_CORPUS_DIR not set; skipping");
        return;
    };
    let max: usize = std::env::var("MARKIE_CORPUS_MAX").ok().and_then(|s| s.parse().ok()).unwrap_or(5000);
    let mut files = Vec::new();
    walk(Path::new(&dir), &mut files, max);
    assert!(!files.is_empty(), "no Markdown files under {dir}");

    markie_math::warm_up();
    let style = MathStyle::default();
    let started = Instant::now();
    let (mut files_with_math, mut total, mut ok, mut not_delimited) = (0usize, 0usize, 0usize, 0usize);
    let (mut inline_n, mut display_n) = (0usize, 0usize);
    let mut times: Vec<Duration> = Vec::new();
    let mut slowest: Vec<(Duration, String)> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut unique = 0usize;
    let mut dump = std::env::var("MARKIE_CORPUS_DUMP").ok().and_then(|p| fs::File::create(p).ok());

    for f in &files {
        let Ok(md) = fs::read_to_string(f) else { continue };
        let doc = Document::parse(&md);
        let mut sources = Vec::new();
        collect(&doc.nodes(), &mut sources);
        if sources.is_empty() {
            continue;
        }
        files_with_math += 1;
        for src in sources {
            let Some((tex, display)) = strip_delimiters(&src) else {
                not_delimited += 1;
                continue;
            };
            total += 1;
            if display { display_n += 1 } else { inline_n += 1 }
            if seen.insert((tex.to_string(), display)) {
                unique += 1;
            }
            let t0 = Instant::now();
            let result = render(tex, display, &style);
            let dt = t0.elapsed();
            times.push(dt);
            if let Some(out) = dump.as_mut() {
                let err = result.as_ref().err().map(|e| e.to_string());
                let _ = writeln!(
                    out,
                    "{{\"tex\":{},\"display\":{display},\"ok\":{},\"err\":{},\"us\":{}}}",
                    json_str(tex),
                    result.is_ok(),
                    err.as_deref().map(json_str).unwrap_or_else(|| "null".into()),
                    dt.as_micros()
                );
            }
            slowest.push((dt, tex.chars().take(80).collect()));
            match result {
                Ok(r) => {
                    ok += 1;
                    debug_assert!(r.width_pt > 0.0);
                }
                Err(e) => {
                    let key = match &e {
                        MathError::Convert(m) => format!("convert: {}", m.lines().next().unwrap_or("")),
                        MathError::Typeset(m) => format!("typeset: {}", m.split(';').next().unwrap_or("")),
                        other => other.to_string(),
                    };
                    *reasons.entry(key).or_default() += 1;
                    if failures.len() < 40 {
                        let short: String = tex.chars().take(120).collect();
                        failures.push(format!("{}  [{}]  {short:?}\n      -> {e}", f.display(), if display { "display" } else { "inline" }));
                    }
                }
            }
        }
    }
    times.sort();
    slowest.sort_by(|a, b| b.0.cmp(&a.0));
    let rate = if total == 0 { 100.0 } else { ok as f64 * 100.0 / total as f64 };
    let median = percentile(&times, 0.5);
    let p95 = percentile(&times, 0.95);
    let p99 = percentile(&times, 0.99);
    let max_t = times.last().copied().unwrap_or_default();
    eprintln!("files scanned: {}, files with math: {files_with_math}", files.len());
    eprintln!("formulas: {total} ({inline_n} inline, {display_n} display, {unique} unique), not delimited: {not_delimited}");
    eprintln!("rendered: {ok}/{total} = {rate:.2}%");
    eprintln!("time per formula: median {median:?}, p95 {p95:?}, p99 {p99:?}, max {max_t:?}");
    eprintln!("wall time: {:?}", started.elapsed());
    eprintln!("failure reasons:");
    let mut by_count: Vec<_> = reasons.iter().collect();
    by_count.sort_by(|a, b| b.1.cmp(a.1));
    for (r, n) in by_count.iter().take(25) {
        eprintln!("  {n:>5}  {r}");
    }
    eprintln!("failure samples:");
    for f in &failures {
        eprintln!("  {f}");
    }
    eprintln!("slowest:");
    for (d, t) in slowest.iter().take(5) {
        eprintln!("  {d:?}  {t:?}");
    }
    if let Ok(path) = std::env::var("MARKIE_CORPUS_REPORT")
        && let Ok(mut out) = fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(
            out,
            "{{\"kind\":\"math\",\"files\":{},\"files_with_math\":{files_with_math},\"formulas\":{total},\"ok\":{ok},\"median_us\":{},\"p95_us\":{}}}",
            files.len(),
            median.as_micros(),
            p95.as_micros()
        );
    }
}
