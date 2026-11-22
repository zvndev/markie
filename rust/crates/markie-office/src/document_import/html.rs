//! HTML to a new plain-text copy. Ported from `src/lib/document-import/html.ts`.
//!
//! The TypeScript parses into an inert `<template>`. Reuse Markie's HTML
//! Standard parser with the same fragment context and enforce input/output
//! budgets around parsing.
//! Nothing is executed, fetched or attached to any live document.

use super::{DocumentImportError, DocumentImportLimits, ImportErrorCode, ImportResult, ImportedDocumentText, TextAccumulator, decode_import_text};

const OMIT: &[&str] = &[
    "script", "style", "noscript", "template", "head", "title", "meta", "base", "link", "iframe", "frame", "frameset", "noembed", "noframes",
    "object", "embed", "form", "input", "button", "select", "textarea", "option", "datalist", "output", "canvas", "svg", "math", "audio",
    "video", "source", "track", "picture", "img",
];
const BLOCK: &[&str] = &[
    "address", "article", "aside", "blockquote", "details", "summary", "div", "dl", "dt", "dd", "footer", "header", "h1", "h2", "h3", "h4",
    "h5", "h6", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "ul",
];

fn limit(message: &str) -> DocumentImportError {
    DocumentImportError::new(ImportErrorCode::LimitExceeded, message)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Namespace {
    Html,
    Foreign,
}

#[derive(Debug)]
enum Node {
    Text(String),
    Comment,
    Element(Element),
}

#[derive(Debug)]
struct Element {
    name: String,
    namespace: Namespace,
    attributes: Vec<(String, String)>,
    children: Vec<Node>,
}

impl Element {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attributes.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// Budget lexical nodes before parsing allocates a tree. Not an HTML parser.
fn preflight(source: &str, limits: &DocumentImportLimits) -> ImportResult<()> {
    let b = source.as_bytes();
    let mut nodes = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"<!--") {
            nodes += 1;
            if nodes > limits.max_nodes {
                return Err(limit("HTML comments exceed the node budget."));
            }
            let Some(end) = source[i + 4..].find("-->") else {
                return Err(DocumentImportError::new(ImportErrorCode::Malformed, "HTML comment is not terminated."));
            };
            i = i + 4 + end + 3;
            continue;
        }
        let closing = b.get(i + 1) == Some(&b'/');
        let name_at = i + 1 + usize::from(closing);
        let tag = b.get(name_at).is_some_and(|c| c.is_ascii_alphabetic());
        let mut name_end = name_at;
        if tag {
            while name_end < b.len() && name_end - i < 256 && (b[name_end].is_ascii_alphanumeric() || b[name_end] == b':' || b[name_end] == b'-') {
                name_end += 1;
            }
        }
        let doctype = !tag && b.len() >= i + 10 && b[i..i + 9].eq_ignore_ascii_case(b"<!doctype") && b[i + 9].is_ascii_whitespace();
        if !tag && !doctype {
            i += 1;
            continue;
        }
        if tag && !closing {
            nodes += 1;
            if nodes > limits.max_nodes {
                return Err(limit("HTML markup exceeds the node budget."));
            }
        }
        let name = if tag { source[name_at..name_end].to_ascii_lowercase() } else { String::new() };
        let mut quote = 0u8;
        i += 1;
        while i < b.len() {
            let c = b[i];
            if quote != 0 {
                if c == quote {
                    quote = 0;
                }
            } else if c == b'"' || c == b'\'' {
                quote = c;
            } else if c == b'>' {
                break;
            }
            i += 1;
        }
        if tag && !closing && name == "plaintext" {
            break;
        }
        if tag && !closing && ["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes"].contains(&name.as_str()) {
            match find_close_tag(source, i + 1, &name) {
                Some(at) => {
                    i = at;
                    continue;
                }
                None => break,
            }
        }
        i += 1;
    }
    Ok(())
}

/// Case-insensitive `</name` followed by tab, LF, FF, CR, space, `/` or `>`.
fn find_close_tag(source: &str, from: usize, name: &str) -> Option<usize> {
    let b = source.as_bytes();
    let n = name.len();
    let mut i = from.min(b.len());
    while i + 2 + n < b.len() + 1 {
        if b[i] == b'<' && b.get(i + 1) == Some(&b'/') && b.len() >= i + 2 + n && b[i + 2..i + 2 + n].eq_ignore_ascii_case(name.as_bytes())
            && let Some(c) = b.get(i + 2 + n)
                && matches!(c, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>')
            {
                return Some(i);
            }
        i += 1;
    }
    None
}

/// Parse an inert template with the same HTML Standard tree rules as the browser.
fn parse_template(source: &str, limits: &DocumentImportLimits) -> ImportResult<Vec<Node>> {
    use html5ever::tendril::TendrilSink as _;
    use html5ever::{QualName, local_name, namespace_url, ns};
    use markup5ever_rcdom::{Handle, NodeData, RcDom};

    fn convert(handle: &Handle, limits: &DocumentImportLimits, depth: usize, seen: &mut usize) -> ImportResult<Option<Node>> {
        *seen += 1;
        if *seen > limits.max_nodes || depth > limits.max_depth {
            return Err(limit("HTML structure exceeds the import budget."));
        }
        Ok(Some(match &handle.data {
            NodeData::Text { contents } => Node::Text(contents.borrow().to_string()),
            NodeData::Comment { .. } => Node::Comment,
            NodeData::Element { name, attrs, template_contents, .. } => {
                let template = template_contents.borrow();
                let source = template.as_ref().unwrap_or(handle);
                let mut children = Vec::new();
                for child in source.children.borrow().iter() {
                    if let Some(node) = convert(child, limits, depth + 1, seen)? {
                        children.push(node);
                    }
                }
                Node::Element(Element {
                    name: name.local.to_string(),
                    namespace: if name.ns == ns!(html) { Namespace::Html } else { Namespace::Foreign },
                    attributes: attrs.borrow().iter().map(|a| (a.name.local.to_string(), a.value.to_string())).collect(),
                    children,
                })
            }
            _ => return Ok(None),
        }))
    }

    let context = QualName::new(None, ns!(html), local_name!("template"));
    let dom = html5ever::parse_fragment(RcDom::default(), Default::default(), context, vec![]).one(source);
    let roots = dom.document.children.borrow();
    let mut nodes = Vec::new();
    let mut seen = 0;
    if let Some(root) = roots.first() {
        for child in root.children.borrow().iter() {
            if let Some(node) = convert(child, limits, 1, &mut seen)? { nodes.push(node); }
        }
    }
    Ok(nodes)
}

/// Inline `style` declarations, last one winning, without `!important`.
fn style_property(style: &str, property: &str) -> Option<String> {
    let mut found = None;
    for declaration in style.split(';') {
        let Some((name, value)) = declaration.split_once(':') else { continue };
        if name.trim().eq_ignore_ascii_case(property) {
            let value = value.trim();
            let value = value.strip_suffix("!important").map_or(value, str::trim_end);
            found = Some(value.trim().to_ascii_lowercase());
        }
    }
    found
}

fn hidden(element: &Element) -> bool {
    if element.attr("hidden").is_some()
        || element.attr("aria-hidden").is_some_and(|v| v.trim().eq_ignore_ascii_case("true"))
        || (element.name == "dialog" && element.attr("open").is_none())
    {
        return true;
    }
    let Some(style) = element.attr("style") else { return false };
    style_property(style, "display").as_deref() == Some("none")
        || matches!(style_property(style, "visibility").as_deref(), Some("hidden" | "collapse"))
        || style_property(style, "content-visibility").as_deref() == Some("hidden")
}

pub fn extract_html_text(bytes: &[u8], limits: DocumentImportLimits) -> ImportResult<ImportedDocumentText> {
    if bytes.len() > limits.max_input_bytes {
        return Err(limit("HTML source exceeds the import byte budget."));
    }
    let source = decode_import_text(bytes, false)?;
    preflight(&source, &limits)?;
    let roots = parse_template(&source, &limits)?;
    let mut output = TextAccumulator::new(&limits);
    let (mut nodes, mut omitted) = (0usize, false);
    enum Task<'a> {
        Visit { node: &'a Node, depth: usize, pre: bool },
        After { name: &'a str },
    }
    let mut stack: Vec<Task> = roots.iter().rev().map(|node| Task::Visit { node, depth: 1, pre: false }).collect();
    fn newline(output: &mut TextAccumulator) -> ImportResult<()> {
        match output.last_char() {
            Some(c) if c != '\n' => output.append("\n"),
            _ => Ok(()),
        }
    }
    while let Some(task) = stack.pop() {
        let (node, depth, pre) = match task {
            Task::After { name } => {
                if name == "td" || name == "th" {
                    output.append("\t")?;
                } else if BLOCK.contains(&name) {
                    newline(&mut output)?;
                }
                continue;
            }
            Task::Visit { node, depth, pre } => (node, depth, pre),
        };
        nodes += 1;
        if nodes > limits.max_nodes || depth > limits.max_depth {
            return Err(limit("HTML structure exceeds the import budget."));
        }
        let element = match node {
            Node::Text(value) => {
                let mut text = value.clone();
                if !pre {
                    text = collapse_html_space(&text);
                    let last = output.last_char();
                    if (last.is_none() || matches!(last, Some('\t' | '\n' | ' '))) && text.starts_with(' ') {
                        text.remove(0);
                    }
                }
                output.append(&text)?;
                continue;
            }
            Node::Comment => continue,
            Node::Element(e) => e,
        };
        let name = element.name.as_str();
        if element.namespace != Namespace::Html || OMIT.contains(&name) || hidden(element) {
            omitted = true;
            continue;
        }
        if name == "br" {
            output.append("\n")?;
            continue;
        }
        if BLOCK.contains(&name) {
            newline(&mut output)?;
        }
        let mut children: Vec<&Node> = element.children.iter().collect();
        if name == "details" && element.attr("open").is_none() {
            children = children
                .into_iter()
                .filter(|n| matches!(n, Node::Element(e) if e.name == "summary"))
                .take(1)
                .collect();
            omitted = true;
        }
        stack.push(Task::After { name });
        for child in children.into_iter().rev() {
            stack.push(Task::Visit { node: child, depth: depth + 1, pre: pre || name == "pre" });
        }
    }
    let text = finish(&output.result());
    let mut warnings = vec![
        "HTML was converted to a new plain-text copy. Formatting, CSS layout, links, media, forms, scripts and embedded content are not preserved; no URLs are fetched.".to_string(),
        "Visibility from external stylesheets or stylesheet class rules is not evaluated. Explicit hidden/aria-hidden/inline-hidden content is excluded.".to_string(),
    ];
    if omitted {
        warnings.push("Hidden, non-HTML, active, embedded or metadata content was omitted.".into());
    }
    Ok(ImportedDocumentText { text, warnings })
}

/// `replace(/[\t\n\r\f ]+/g, " ")`
fn collapse_html_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if matches!(c, '\t' | '\n' | '\r' | '\u{c}' | ' ') {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `.replace(/[ \t]+\n/g, "\n").replace(/\t$/, "").replace(/\n$/, "")`
fn finish(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending = String::new();
    for c in text.chars() {
        match c {
            ' ' | '\t' => pending.push(c),
            '\n' => {
                pending.clear();
                out.push('\n');
            }
            _ => {
                out.push_str(&pending);
                pending.clear();
                out.push(c);
            }
        }
    }
    out.push_str(&pending);
    if out.ends_with('\t') {
        out.pop();
    }
    if out.ends_with('\n') {
        out.pop();
    }
    out
}
