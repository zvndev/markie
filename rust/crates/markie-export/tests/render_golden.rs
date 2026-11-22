//! Electron's export HTML against Markie RS's, for every fixture.
//!
//! The goldens come from Electron's own TypeScript (`scripts/goldens.mjs`).
//! Two things differ by design and are normalised before comparing:
//! - math: KaTeX HTML there, markie-math SVG here. Both become `[math]` with
//!   their TeX, so the formula boundaries must still agree.
//! - highlight token spans: highlight.js there, syntect here. The code text
//!   and the `hljs language-x` class must still agree.
//!
//! Runs of newlines collapse to one, because rehype-raw and html5ever both
//! foster-parent a table's whitespace out of it, in slightly different counts.

use std::path::PathBuf;

fn dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)
}

/// Removes the element that starts at `at` (a `<span ...`), returning the end.
fn span_end(s: &str, at: usize) -> usize {
    let mut depth = 0;
    let mut i = at;
    while i < s.len() {
        if s[i..].starts_with("<span") {
            depth += 1;
            i += 5;
        } else if s[i..].starts_with("</span>") {
            depth -= 1;
            i += 7;
            if depth == 0 {
                return i;
            }
        } else {
            i += s[i..].chars().next().unwrap().len_utf8();
        }
    }
    s.len()
}

fn tex_of(span: &str) -> String {
    // KaTeX: the annotation. Markie: the hidden mathml span. Error: the text.
    let marker = "<annotation encoding=\"application/x-tex\">";
    if let Some(a) = span.find(marker) {
        let rest = &span[a + marker.len()..];
        return rest[..rest.find("</annotation>").unwrap()].to_string();
    }
    if let Some(a) = span.find("<span class=\"katex-mathml\" hidden>") {
        let rest = &span[a + 34..];
        return rest[..rest.find("</span>").unwrap()].to_string();
    }
    let open = span.find('>').unwrap() + 1;
    span[open..span.len() - 7].to_string()
}

fn normalize(html: &str) -> String {
    let mut s = html.to_string();
    for class in ["<span class=\"katex-display\">", "<span class=\"katex\">", "<span class=\"katex-error\""] {
        while let Some(at) = s.find(class) {
            let end = span_end(&s, at);
            let tex = tex_of(&s[at..end]).replace("&#x26;", "&").replace("&amp;", "&").replace("&#x3C;", "<").replace("&lt;", "<");
            let display = class.contains("display");
            s.replace_range(at..end, &format!("[math{} {}]", if display { " display" } else { "" }, tex.trim()));
        }
    }
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
fn math_is_svg_from_markie_math() {
    let html = markie_export::render_markdown_html("Inline $x^2$ here.\n\n$$\n\\frac{1}{2}\n$$\n");
    assert!(html.contains("<span class=\"katex\"><span class=\"katex-mathml\" hidden>x^2</span><svg"), "{html}");
    assert!(html.contains("<span class=\"katex-display\"><span class=\"katex\">"), "{html}");
}
