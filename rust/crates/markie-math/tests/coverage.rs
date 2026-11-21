//! Audit every LaTeX command the mitex spec knows against the Typst we ship.
//!
//! mitex 0.2.4 maps commands to Typst names fixed at its release; Typst has
//! renamed some symbols since. This test renders each command alone and
//! fails if one that should work does not, so a typst bump that renames more
//! symbols is caught here. Run with `--nocapture` to see the list.

use markie_math::{MathStyle, render};

const STANDARD: &str = include_str!("../typst/mitex/latex/standard.typ");

/// Commands that are not math (text-mode structure, preamble, figures) or
/// that need special context, so rendering them alone says nothing.
fn skip(name: &str, def: &str) -> bool {
    def.starts_with("ignore-sym")
        // color-map entries and fields of multi-line definitions
        || def.starts_with("rgb(")
        || matches!(name, "kind" | "alias" | "handle" | "textwidth")
        || def.contains("define-glob-env")
        || def.contains("is-itemize")
        || def.contains("is-enumerate")
        || def.contains("is-table")
        || def.contains("quote(block")
        || def.contains("#heading")
        || def.contains("#footnote")
        || def.contains("#mitex")
        || def.contains("#text")
        || def.starts_with("define-infix")
        || def.starts_with("left1-op")
        || matches!(name, "item" | "label" | "ref" | "eqref" | "cite" | "footnote" | "caption" | "tag" | "nonumber" | "notag" | "includegraphics" | "hline" | "toprule" | "midrule" | "bottomrule" | "centering" | "left" | "right" | "middle" | "big" | "Big" | "bigg" | "Bigg" | "bigl" | "bigr" | "Bigl" | "Bigr" | "biggl" | "biggr" | "Biggl" | "Biggr" | "bigm" | "Bigm" | "biggm" | "Biggm")
}

fn probe(name: &str, def: &str) -> String {
    match name {
        "color" => return r"\color{red} x".into(),
        "textcolor" | "colorbox" => return format!("\\{name}{{red}}{{y}}"),
        "raisebox" => return r"\raisebox{0.5em}{y}".into(),
        "vspace" | "hspace" => return format!("x \\{name}{{1em}} y"),
        _ => {}
    }
    if def.contains("define-env") || def.contains("matrix-handle") {
        let arg = if def.starts_with("define-env(1") { "{cc}" } else { "" };
        let body = if def.contains("is-matrix") || def.contains("matrix-handle") { "a & b \\\\ c & d" } else { "x &= y" };
        return format!("\\begin{{{name}}}{arg} {body} \\end{{{name}}}");
    }
    if def.starts_with("define-cmd(2") || def.starts_with("cmd2") {
        return format!("\\{name}{{x}}{{y}}");
    }
    if def.starts_with("define-cmd(1")
        || def.starts_with("cmd1")
        || def.starts_with("define-glob-cmd")
        || def.starts_with("arrow-handle")
        || def.starts_with("limits-handle")
    {
        return format!("\\{name}{{x}}");
    }
    if def.starts_with("define-greedy") || def.starts_with("greedy-handle") {
        return format!("\\{name} x");
    }
    format!("\\{name}")
}

#[test]
fn every_spec_command_renders() {
    let style = MathStyle::default();
    let (mut tried, mut failed) = (0usize, Vec::new());
    for line in STANDARD.lines() {
        // Entries look like `  name: define-sym("alias"),`.
        let Some(rest) = line.strip_prefix("  ") else { continue };
        if rest.starts_with(' ') || rest.starts_with("//") {
            continue;
        }
        let Some((name, def)) = rest.split_once(": ") else { continue };
        let name = name.trim_matches('"');
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphabetic() || c == '*') {
            continue;
        }
        if skip(name, def) {
            continue;
        }
        let tex = probe(name, def);
        tried += 1;
        if let Err(e) = render(&tex, false, &style) {
            failed.push(format!("{tex}  ->  {e}"));
        }
    }
    eprintln!("probed {tried} commands, {} failed", failed.len());
    for f in &failed {
        eprintln!("  {f}");
    }
    assert!(tried > 600, "parsed too few commands ({tried}); did standard.typ change shape?");
    assert!(failed.is_empty(), "{} commands fail; see stderr", failed.len());
}

/// Opt-in: render the KaTeX command probes from `scripts/katex-probes.mjs`.
///
///   node scripts/katex-probes.mjs <katex dir> > probes.tsv
///   MARKIE_KATEX_PROBES=probes.tsv MARKIE_KATEX_PROBE_DUMP=out.jsonl \
///     cargo test -p markie-math --test coverage katex -- --nocapture
///   node scripts/katex-compare.mjs out.jsonl <katex dir>
#[test]
fn katex_command_probes() {
    let Ok(path) = std::env::var("MARKIE_KATEX_PROBES") else {
        eprintln!("MARKIE_KATEX_PROBES not set; skipping");
        return;
    };
    let text = std::fs::read_to_string(&path).expect("read probes");
    let style = MathStyle::default();
    let mut dump = std::env::var("MARKIE_KATEX_PROBE_DUMP").ok().map(|p| std::fs::File::create(p).expect("dump"));
    let (mut n, mut ok) = (0usize, 0usize);
    for line in text.lines() {
        let (tex, display) = match (line.strip_prefix("I\t"), line.strip_prefix("D\t")) {
            (Some(t), _) => (t, false),
            (_, Some(t)) => (t, true),
            _ => continue,
        };
        n += 1;
        let r = render(tex, display, &style);
        if r.is_ok() {
            ok += 1;
        }
        if let Some(out) = dump.as_mut() {
            use std::io::Write;
            let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\t', "\\t");
            let err = r.as_ref().err().map(|e| format!("\"{}\"", esc(&e.to_string()))).unwrap_or_else(|| "null".into());
            writeln!(out, "{{\"tex\":\"{}\",\"display\":{display},\"ok\":{},\"err\":{err}}}", esc(tex), r.is_ok()).unwrap();
        }
    }
    eprintln!("KaTeX probes: {ok}/{n} render");
}
