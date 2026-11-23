//! Electron's export HTML against Markie RS's, for every fixture.
//!
//! The goldens come from Electron's own TypeScript (`scripts/goldens.mjs`,
//! and `scripts/katex-goldens.mjs` for the math fixture).
//! These differ by design and are normalised before comparing:
//! - highlight token spans: highlight.js there, syntect here. The code text
//!   and the `hljs language-x` class must still agree.
//! - [`katex_versions`]: Electron renders with KaTeX 0.19.1, Markie RS with
//!   katex-rs, which ports KaTeX 0.18.5. Three markup differences remain, none
//!   of which moves a pixel (`.autoloop/runs/katex-look/`).
//!
//! Runs of newlines collapse to one, because rehype-raw and html5ever both
//! foster-parent a table's whitespace out of it, in slightly different counts.

use std::path::PathBuf;

fn dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)
}

const MSPACE: &str = "<span class=\"mspace\" style=\"margin-right:";

/// Where the `<span class="mspace" ...></span>` starting at `at` ends.
fn mspace_end(s: &str, at: usize) -> Option<usize> {
    s[at..].starts_with(MSPACE).then(|| s[at..].find("></span>").map(|e| at + e + 8)).flatten()
}

/// The markup KaTeX 0.18.5 (katex-rs) and 0.19.1 write differently, written
/// one way. Each is invisible on the page:
/// - Spacing glue next to an explicit space: 0.19.1 puts the glue after the
///   space, 0.18.5 before. Both are empty inline blocks with a right margin,
///   so a run of them is sorted.
/// - A small `\left` or `\right` delimiter: 0.18.5 wraps the glyph in a
///   class-only `span.mopen` (or `mclose`) inside `span.delimcenter`. No rule
///   styles that span.
/// - An extensible arrow's row: 0.19.1 classes it `svg-align`
///   (`text-align:left`), but the arrow fills the row, so nothing moves.
/// - An error's tooltip: some messages are worded as KaTeX 0.18 did.
fn katex_versions(html: &str) -> String {
    let mut s = html.replace("<span class=\"svg-align\" style=", "<span style=");
    for class in ["mopen", "mclose"] {
        let inner = format!("<span class=\"{class}\">");
        let mut from = 0;
        while let Some(at) = s[from..].find(&format!("<span class=\"{class} delimcenter\"")).map(|a| from + a) {
            let open_end = at + s[at..].find('>').unwrap() + 1;
            if s[open_end..].starts_with(&inner) {
                let close = open_end + s[open_end..].find("</span>").unwrap();
                s.replace_range(close..close + 7, "");
                s.replace_range(open_end..open_end + inner.len(), "");
            }
            from = open_end;
        }
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if let Some(mut end) = mspace_end(&s, i) {
            let mut run = vec![&s[i..end]];
            while let Some(next) = mspace_end(&s, end) {
                run.push(&s[end..next]);
                end = next;
            }
            run.sort();
            out.extend(run);
            i = end;
        } else {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    let mut s = out;
    let marker = "<span class=\"katex-error\" title=\"ParseError: KaTeX parse error";
    let mut from = 0;
    while let Some(at) = s[from..].find(marker).map(|a| from + a + marker.len()) {
        let quote = at + s[at..].find('"').unwrap();
        s.replace_range(at..quote, "");
        from = at;
    }
    s
}

fn normalize(html: &str) -> String {
    let s = katex_versions(html);
    // Token spans inside code blocks.
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(pre) = rest.find("<pre>") {
        out.push_str(&rest[..pre]);
        let end = rest[pre..].find("</pre>").map(|e| pre + e + 6).unwrap_or(rest.len());
        let mut block = rest[pre..end].to_string();
        while let Some(a) = block.find("<span") {
            let close = block[a..].find('>').unwrap() + a + 1;
            block.replace_range(a..close, "");
        }
        out.push_str(&block.replace("</span>", ""));
        rest = &rest[end..];
    }
    out.push_str(rest);
    let mut collapsed = String::new();
    for c in out.chars() {
        if c == '\n' && collapsed.ends_with('\n') {
            continue;
        }
        collapsed.push(c);
    }
    collapsed.trim().to_string()
}

#[test]
fn render_matches_electron() {
    let mut failures = Vec::new();
    for entry in std::fs::read_dir(dir("fixtures")).unwrap() {
        let path = entry.unwrap().path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "md" && ext != "txt" {
            continue;
        }
        let stem = path.file_stem().unwrap().to_str().unwrap().to_string();
        let text = std::fs::read_to_string(&path).unwrap();
        let golden = std::fs::read_to_string(dir("goldens").join(format!("{stem}.render.html"))).unwrap();
        let ours = markie_export::render_markdown_html(&text);
        let (a, b) = (normalize(&golden), normalize(&ours));
        if a != b {
            let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/web-export/render");
            std::fs::create_dir_all(&out).unwrap();
            std::fs::write(out.join(format!("{stem}.electron.html")), &a).unwrap();
            std::fs::write(out.join(format!("{stem}.rs.html")), &b).unwrap();
            failures.push(stem);
        }
    }
    assert!(failures.is_empty(), "render differs for {failures:?}; see .autoloop/runs/web-export/render");
}

#[test]
fn code_blocks_get_the_hljs_class() {
    let html = markie_export::render_markdown_html("```js\nconst a = 1;\n```\n");
    assert!(html.starts_with("<pre><code class=\"hljs language-js\"><span class=\"hljs-keyword\">const</span>"), "{html}");
}

#[test]
fn math_is_katex_html() {
    let html = markie_export::render_markdown_html("Inline $x^2$ here.\n\n$$\n\\frac{1}{2}\n$$\n");
    assert!(html.starts_with("<p>Inline <span class=\"katex\"><span class=\"katex-mathml\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding=\"application/x-tex\">x^2</annotation></semantics></math></span><span class=\"katex-html\" aria-hidden=\"true\">"), "{html}");
    assert!(html.contains("<span class=\"katex-display\"><span class=\"katex\"><span class=\"katex-mathml\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\" display=\"block\">"), "{html}");
    assert!(html.contains("<span class=\"mord mathnormal\">x</span>"), "{html}");
}

#[test]
fn math_errors_are_written_as_rehype_katex_does() {
    let html = markie_export::render_markdown_html("Broken $\\frac{1}{$ here.\n");
    assert!(
        html.contains("<span class=\"katex-error\" title=\"ParseError: KaTeX parse error: Unexpected end of input in a macro argument, expected &#x27;}&#x27; at end of input: \\frac{1}{\" style=\"color:#cc0000\">\\frac{1}{</span>"),
        "{html}"
    );
}

/// Inline, display and fenced math, fractions, roots, big operators,
/// matrices, cases, alignment, delimiters, Greek, accents, fonts, arrows and
/// two parse errors: KaTeX's HTML exactly as Electron's export carries it,
/// apart from [`katex_versions`].
#[test]
fn math_matches_electron_katex() {
    let text = std::fs::read_to_string(dir("fixtures").join("math/katex.md")).unwrap();
    let golden = std::fs::read_to_string(dir("goldens").join("math/katex.render.html")).unwrap();
    let ours = markie_export::render_markdown_html(&text);
    let (a, b) = (katex_versions(&golden), katex_versions(&ours));
    if a != b {
        let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/katex-look/render");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("katex.electron.html"), &a).unwrap();
        std::fs::write(out.join("katex.rs.html"), &b).unwrap();
    }
    let at = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
    assert!(a == b, "math differs from byte {at}: ...{}... (see .autoloop/runs/katex-look/render)", &b[at.saturating_sub(120)..(at + 120).min(b.len())]);
    assert_eq!(ours.matches("class=\"katex\"").count(), 44, "formulas drawn");
    assert_eq!(ours.matches("class=\"katex-error\"").count(), 2, "formulas refused");
}

/// The page around an export: KaTeX's stylesheet with its fonts, then the
/// theme, as `buildPDFHTML` writes it, in both themes.
#[test]
fn export_page_matches_electron() {
    for theme in [markie_export::Theme::Light, markie_export::Theme::Dark] {
        let golden = std::fs::read_to_string(dir("goldens").join(format!("math/page.{}.html", theme.name()))).unwrap();
        let ours = markie_export::build_pdf_html("{BODY}", theme);
        assert!(ours.contains(markie_export::styles::KATEX_CSS), "{theme:?}: the KaTeX stylesheet is missing");
        assert_eq!(ours.replacen(markie_export::styles::KATEX_CSS, "{KATEX_CSS}", 1), golden, "{theme:?}");
    }
    // The fonts KaTeX's HTML asks for, embedded as Electron embeds them.
    for face in ["KaTeX_Main", "KaTeX_Math", "KaTeX_AMS", "KaTeX_Size1", "KaTeX_Size4", "KaTeX_Caligraphic", "KaTeX_Typewriter"] {
        assert!(markie_export::styles::KATEX_CSS.contains(&format!("font-family:{face};")), "{face}");
    }
    assert_eq!(markie_export::styles::KATEX_CSS.matches("data:font/woff2;base64,").count(), 12);
}

/// Writes both apps' Export HTML page for the math fixture, in both themes,
/// to .autoloop/runs/katex-look/pages for the headless Chromium comparison.
/// Electron's pages come from `scripts/katex-goldens.mjs` run with
/// `KATEX_LOOK_PAGES` set.
#[test]
#[ignore]
fn write_math_pages() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/katex-look/pages");
    std::fs::create_dir_all(&out).unwrap();
    let text = std::fs::read_to_string(dir("fixtures").join("math/katex.md")).unwrap();
    for theme in [markie_export::Theme::Light, markie_export::Theme::Dark] {
        let html = markie_export::build_pdf_html(&markie_export::render_markdown_html(&text), theme);
        let html = markie_export::assets::inline_local_images(&html, Some(&dir("fixtures/math")), &Default::default());
        std::fs::write(out.join(format!("katex.{}.rs.html", theme.name())), html).unwrap();
    }
}

/// The colour group the export stylesheet gives a highlight.js class (the
/// same groups in light and dark): keyword, string, title, built-in, comment,
/// number, params. Other classes take their parent's colour.
fn colour_of(class: &str) -> Option<char> {
    class.split_whitespace().find_map(|c| match c {
        "hljs-keyword" => Some('k'),
        "hljs-string" => Some('s'),
        "hljs-title" | "hljs-function" => Some('t'),
        "hljs-built_in" | "hljs-type" | "hljs-variable" => Some('b'),
        "hljs-comment" => Some('c'),
        "hljs-number" | "hljs-attr" | "hljs-literal" => Some('n'),
        "hljs-params" | "hljs-subst" => Some('p'),
        _ => None,
    })
}

/// Each code block as (language, text, colour group per character).
fn code_colours(html: &str) -> Vec<(String, Vec<char>, Vec<char>)> {
    let mut blocks = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find("<pre><code class=\"") {
        let open = &rest[at + 18..];
        let class_end = open.find('"').unwrap();
        let lang = open[..class_end].split_whitespace().find_map(|c| c.strip_prefix("language-")).unwrap_or("").to_string();
        let body_start = open.find('>').unwrap() + 1;
        let body_end = open.find("</code></pre>").unwrap();
        let body = &open[body_start..body_end];
        let (mut text, mut colours, mut stack) = (Vec::new(), Vec::new(), vec!['-']);
        let mut i = 0;
        while i < body.len() {
            let s = &body[i..];
            if let Some(tag) = s.strip_prefix("<span class=\"") {
                let end = tag.find('"').unwrap();
                let top = *stack.last().unwrap();
                stack.push(colour_of(&tag[..end]).unwrap_or(top));
                i += 13 + end + 2;
            } else if s.starts_with("</span>") {
                stack.pop();
                i += 7;
            } else if s.starts_with('&') {
                let end = s.find(';').unwrap();
                let c = match &s[1..end] {
                    "lt" | "#x3C" => '<',
                    "gt" | "#x3E" => '>',
                    "amp" | "#x26" => '&',
                    "quot" | "#x22" => '"',
                    "#x27" | "#39" => '\'',
                    e => panic!("entity {e}"),
                };
                text.push(c);
                colours.push(*stack.last().unwrap());
                i += end + 1;
            } else {
                let c = s.chars().next().unwrap();
                text.push(c);
                colours.push(if c.is_whitespace() { ' ' } else { *stack.last().unwrap() });
                i += c.len_utf8();
            }
        }
        blocks.push((lang, text, colours));
        rest = &open[body_end..];
    }
    blocks
}

/// Code in the export gets the colour Electron's highlight.js gives it,
/// character by character, through the same stylesheet.
#[test]
fn code_colours_match_highlight_js() {
    let mut report = Vec::new();
    for name in ["everything", "code"] {
        let text = std::fs::read_to_string(dir("fixtures").join(format!("{name}.md"))).unwrap();
        let golden = code_colours(&std::fs::read_to_string(dir("goldens").join(format!("{name}.render.html"))).unwrap());
        let ours = code_colours(&markie_export::render_markdown_html(&text));
        assert_eq!(golden.len(), ours.len(), "{name}: code blocks");
        for ((lang, gt, gc), (_, ot, oc)) in golden.iter().zip(&ours) {
            assert_eq!(gt, ot, "{name} {lang}: code text");
            let mut line = String::new();
            for (i, ((t, g), o)) in gt.iter().zip(gc).zip(oc).enumerate() {
                if g != o && !t.is_whitespace() {
                    let from = gt[..i].iter().rposition(|c| *c == '\n').map_or(0, |p| p + 1);
                    let to = gt[i..].iter().position(|c| *c == '\n').map_or(gt.len(), |p| i + p);
                    let l: String = gt[from..to].iter().collect();
                    if l != line {
                        let gl: String = gc[from..to].iter().collect();
                        let ol: String = oc[from..to].iter().collect();
                        report.push(format!("{name} {lang}:\n  {l}\n  {gl}  (highlight.js)\n  {ol}  (here)"));
                        line = l;
                    }
                }
            }
        }
    }
    assert!(report.is_empty(), "{} lines differ:\n{}", report.len(), report.join("\n"));
}

/// Writes Markie RS's HTML export of each fixture (the page Export HTML
/// saves) to .autoloop/runs/native-print/html, for screenshots next to
/// Electron's.
#[test]
#[ignore]
fn write_html_exports() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/native-print/html");
    std::fs::create_dir_all(&out).unwrap();
    for name in ["everything", "prices", "prices-edge", "code"] {
        let text = std::fs::read_to_string(dir("fixtures").join(format!("{name}.md"))).unwrap();
        let html = markie_export::build_pdf_html(&markie_export::render_markdown_html(&text), markie_export::Theme::Light);
        let html = markie_export::assets::inline_local_images(&html, Some(&dir("fixtures")), &Default::default());
        std::fs::write(out.join(format!("{name}.rs.html")), html).unwrap();
    }
}
