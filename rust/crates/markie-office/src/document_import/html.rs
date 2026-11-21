//! HTML to a new plain-text copy. Ported from `src/lib/document-import/html.ts`.
//!
//! The TypeScript parses into an inert `<template>` (WHATWG HTML section 4.12.3)
//! with the browser's parser. Rust has no browser, so this module carries its
//! own bounded tokenizer (WHATWG section 13.2.5: data, RCDATA, RAWTEXT, script
//! data, PLAINTEXT, tags, attributes, comments, character references) and a
//! reduced tree builder with the implied-end-tag rules that change text
//! boundaries (p, li, dd/dt, headings, table rows and cells, void elements).
//! Nothing is executed, fetched or attached to any live document.

use super::html_entities::NAMED;
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
const VOID: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source",
    "track", "wbr",
];
/// Start tags that close an open `p` (WHATWG "in body" insertion mode).
const CLOSES_P: &[&str] = &[
    "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure",
    "footer", "header", "hgroup", "main", "menu", "nav", "ol", "p", "search", "section", "summary", "ul", "h1", "h2", "h3", "h4", "h5", "h6",
    "pre", "listing", "form", "table", "hr", "xmp", "plaintext", "li", "dd", "dt",
];
const RAW_TEXT: &[&str] = &["script", "style", "xmp", "iframe", "noembed", "noframes"];
const RCDATA: &[&str] = &["title", "textarea"];

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
        if b[i] == b'<' && b.get(i + 1) == Some(&b'/') && b.len() >= i + 2 + n && b[i + 2..i + 2 + n].eq_ignore_ascii_case(name.as_bytes()) {
            if let Some(c) = b.get(i + 2 + n)
                && matches!(c, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>')
            {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// WHATWG 13.2.5.73 numeric character reference end state replacements.
fn numeric_reference(code: u32) -> char {
    const C1: [u32; 32] = [
        0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90,
        0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
    ];
    if code == 0 || code > 0x10ffff || (0xd800..=0xdfff).contains(&code) {
        return '\u{fffd}';
    }
    if (0x80..=0x9f).contains(&code) {
        return char::from_u32(C1[(code - 0x80) as usize]).unwrap_or('\u{fffd}');
    }
    char::from_u32(code).unwrap_or('\u{fffd}')
}

/// Decodes character references in text (or, with `attribute`, in an attribute value).
fn decode_references(text: &str, attribute: bool) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        if b[i] != b'&' {
            i += 1;
            continue;
        }
        out.push_str(&text[last..i]);
        let start = i;
        i += 1;
        if b.get(i) == Some(&b'#') {
            let hex = matches!(b.get(i + 1), Some(b'x' | b'X'));
            let digits_at = i + 1 + usize::from(hex);
            let mut j = digits_at;
            while j < b.len() && (if hex { b[j].is_ascii_hexdigit() } else { b[j].is_ascii_digit() }) {
                j += 1;
            }
            if j == digits_at {
                // Absence of digits: the text is not a reference.
                i = start + 1;
                last = start;
                continue;
            }
            let digits = &text[digits_at..j];
            let code = u32::from_str_radix(digits.trim_start_matches('0').get(..8).unwrap_or(digits.trim_start_matches('0')), if hex { 16 } else { 10 })
                .ok()
                .map(|c| if digits.trim_start_matches('0').len() > 8 { 0x110000 } else { c })
                .unwrap_or(0);
            if b.get(j) == Some(&b';') {
                j += 1;
            }
            out.push(numeric_reference(code));
            i = j;
            last = j;
            continue;
        }
        // Longest named match: names are at most 32 bytes.
        let mut best: Option<(usize, &str)> = None;
        let mut end = i;
        while end < b.len() && end - i < 33 && (b[end].is_ascii_alphanumeric() || b[end] == b';') {
            end += 1;
            if let Ok(index) = NAMED.binary_search_by(|(name, _)| (*name).cmp(&text[i..end])) {
                best = Some((end, NAMED[index].1));
            }
            if b[end - 1] == b';' {
                break;
            }
        }
        match best {
            Some((end, chars)) => {
                let ends_with_semicolon = b[end - 1] == b';';
                let next = b.get(end).copied();
                if attribute && !ends_with_semicolon && next.is_some_and(|c| c == b'=' || c.is_ascii_alphanumeric()) {
                    i = start + 1;
                    last = start;
                    continue;
                }
                out.push_str(chars);
                i = end;
                last = end;
            }
            None => {
                i = start + 1;
                last = start;
            }
        }
    }
    out.push_str(&text[last..]);
    out
}

enum Token {
    Start { name: String, attributes: Vec<(String, String)>, self_closing: bool },
    End { name: String },
    Text(String),
    Comment,
}

/// WHATWG-shaped tokenizer over the decoded source.
fn tokenize(source: &str) -> Vec<Token> {
    let b = source.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut text_start = 0;
    let flush_text = |tokens: &mut Vec<Token>, from: usize, to: usize| {
        if from < to {
            tokens.push(Token::Text(decode_references(&source[from..to], false)));
        }
    };
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &b[i..];
        if rest.starts_with(b"<!--") {
            flush_text(&mut tokens, text_start, i);
            // `<!-->` and `<!--->` end abruptly.
            let end = if rest.starts_with(b"<!-->") {
                i + 5
            } else if rest.starts_with(b"<!--->") {
                i + 6
            } else {
                source[i + 4..].find("-->").map_or(b.len(), |e| i + 4 + e + 3)
            };
            tokens.push(Token::Comment);
            i = end;
            text_start = i;
            continue;
        }
        if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case(b"<!doctype") {
            flush_text(&mut tokens, text_start, i);
            i = source[i..].find('>').map_or(b.len(), |e| i + e + 1);
            text_start = i;
            continue;
        }
        if rest.starts_with(b"<!") || rest.starts_with(b"<?") || (rest.starts_with(b"</") && rest.get(2).is_some_and(|c| !c.is_ascii_alphabetic() && *c != b'>')) {
            // Bogus comment up to the next `>`.
            flush_text(&mut tokens, text_start, i);
            i = source[i + 1..].find('>').map_or(b.len(), |e| i + 1 + e + 1);
            tokens.push(Token::Comment);
            text_start = i;
            continue;
        }
        if rest.starts_with(b"</>") {
            flush_text(&mut tokens, text_start, i);
            i += 3;
            text_start = i;
            continue;
        }
        let closing = rest.get(1) == Some(&b'/');
        let name_at = i + 1 + usize::from(closing);
        if !b.get(name_at).is_some_and(|c| c.is_ascii_alphabetic()) {
            i += 1;
            continue;
        }
        flush_text(&mut tokens, text_start, i);
        let mut j = name_at;
        while j < b.len() && !matches!(b[j], b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>') {
            j += 1;
        }
        let name = source[name_at..j].to_ascii_lowercase();
        let mut attributes: Vec<(String, String)> = Vec::new();
        let mut self_closing = false;
        loop {
            while j < b.len() && matches!(b[j], b'\t' | b'\n' | b'\x0c' | b'\r' | b' ') {
                j += 1;
            }
            if j >= b.len() {
                break;
            }
            if b[j] == b'>' {
                j += 1;
                break;
            }
            if b[j] == b'/' {
                j += 1;
                if b.get(j) == Some(&b'>') {
                    self_closing = true;
                    j += 1;
                    break;
                }
                continue;
            }
            let attr_start = j;
            j += 1;
            while j < b.len() && !matches!(b[j], b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>' | b'=') {
                j += 1;
            }
            let attr_name = source[attr_start..j].to_ascii_lowercase();
            while j < b.len() && matches!(b[j], b'\t' | b'\n' | b'\x0c' | b'\r' | b' ') {
                j += 1;
            }
            let mut value = String::new();
            if b.get(j) == Some(&b'=') {
                j += 1;
                while j < b.len() && matches!(b[j], b'\t' | b'\n' | b'\x0c' | b'\r' | b' ') {
                    j += 1;
                }
                match b.get(j) {
                    Some(&q) if q == b'"' || q == b'\'' => {
                        let close = source[j + 1..].find(q as char).map_or(b.len(), |e| j + 1 + e);
                        value = decode_references(&source[j + 1..close], true);
                        j = (close + 1).min(b.len());
                    }
                    Some(_) => {
                        let v = j;
                        while j < b.len() && !matches!(b[j], b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'>') {
                            j += 1;
                        }
                        value = decode_references(&source[v..j], true);
                    }
                    None => {}
                }
            }
            // Duplicate attributes: the first one wins.
            if !closing && !attributes.iter().any(|(n, _)| *n == attr_name) {
                attributes.push((attr_name, value));
            }
        }
        i = j;
        text_start = i;
        if closing {
            tokens.push(Token::End { name });
            continue;
        }
        let raw = RAW_TEXT.contains(&name.as_str());
        let rcdata = RCDATA.contains(&name.as_str());
        let plaintext = name == "plaintext";
        tokens.push(Token::Start { name: name.clone(), attributes, self_closing });
        if plaintext {
            if i < b.len() {
                tokens.push(Token::Text(source[i..].to_string()));
            }
            return tokens;
        }
        if raw || rcdata {
            let close = find_close_tag(source, i, &name).unwrap_or(b.len());
            if close > i {
                let content = &source[i..close];
                tokens.push(Token::Text(if rcdata { decode_references(content, false) } else { content.to_string() }));
            }
            i = close;
            text_start = i;
        }
    }
    flush_text(&mut tokens, text_start, b.len());
    tokens
}

/// Reduced tree construction for a template fragment.
fn build(tokens: Vec<Token>) -> Vec<Node> {
    struct Open {
        element: Element,
    }
    let mut roots: Vec<Node> = Vec::new();
    let mut stack: Vec<Open> = Vec::new();
    fn close_top(stack: &mut Vec<Open>, roots: &mut Vec<Node>) {
        if let Some(open) = stack.pop() {
            let node = Node::Element(open.element);
            match stack.last_mut() {
                Some(parent) => parent.element.children.push(node),
                None => roots.push(node),
            }
        }
    }
    fn insert(stack: &mut [Open], roots: &mut Vec<Node>, node: Node) {
        match stack.last_mut() {
            Some(parent) => {
                if let (Node::Text(t), Some(Node::Text(prev))) = (&node, parent.element.children.last_mut()) {
                    prev.push_str(t);
                    return;
                }
                parent.element.children.push(node);
            }
            None => {
                if let (Node::Text(t), Some(Node::Text(prev))) = (&node, roots.last_mut()) {
                    prev.push_str(t);
                    return;
                }
                roots.push(node);
            }
        }
    }
    let position = |stack: &[Open], name: &str, stop: &[&str]| -> Option<usize> {
        for (index, open) in stack.iter().enumerate().rev() {
            if open.element.name == name && open.element.namespace == Namespace::Html {
                return Some(index);
            }
            if stop.contains(&open.element.name.as_str()) {
                return None;
            }
        }
        None
    };
    const SCOPE: &[&str] = &["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template", "svg", "math"];
    let button_scope: Vec<&str> = SCOPE.iter().copied().chain(["button"]).collect();
    let list_scope: Vec<&str> = SCOPE.iter().copied().chain(["ol", "ul"]).collect();
    for token in tokens {
        match token {
            Token::Text(text) => insert(&mut stack, &mut roots, Node::Text(text)),
            Token::Comment => insert(&mut stack, &mut roots, Node::Comment),
            Token::Start { name, attributes, self_closing } => {
                let foreign = stack.last().is_some_and(|o| o.element.namespace == Namespace::Foreign);
                // In a template fragment, html/head/body start tags are ignored.
                if !foreign && matches!(name.as_str(), "html" | "head" | "body") {
                    continue;
                }
                let namespace = if foreign || name == "svg" || name == "math" { Namespace::Foreign } else { Namespace::Html };
                if namespace == Namespace::Html {
                    if CLOSES_P.contains(&name.as_str())
                        && let Some(at) = position(&stack, "p", &button_scope)
                    {
                        while stack.len() > at {
                            close_top(&mut stack, &mut roots);
                        }
                    }
                    if name.len() == 2
                        && name.starts_with('h')
                        && name.as_bytes()[1].is_ascii_digit()
                        && stack.last().is_some_and(|o| o.element.name.len() == 2 && o.element.name.starts_with('h') && o.element.name.as_bytes()[1].is_ascii_digit())
                    {
                        close_top(&mut stack, &mut roots);
                    }
                    let implied: &[&str] = match name.as_str() {
                        "li" => &["li"],
                        "dd" | "dt" => &["dd", "dt"],
                        "tr" => &["tr", "td", "th"],
                        "td" | "th" => &["td", "th"],
                        "option" => &["option"],
                        _ => &[],
                    };
                    for target in implied {
                        let stop: Vec<&str> = if name == "li" { list_scope.clone() } else { vec!["table", "template", "html"] };
                        if let Some(at) = position(&stack, target, &stop) {
                            while stack.len() > at {
                                close_top(&mut stack, &mut roots);
                            }
                        }
                    }
                }
                let element = Element { name: name.clone(), namespace, attributes, children: Vec::new() };
                let void = namespace == Namespace::Html && VOID.contains(&name.as_str());
                if void || (namespace == Namespace::Foreign && self_closing) {
                    insert(&mut stack, &mut roots, Node::Element(element));
                } else {
                    stack.push(Open { element });
                }
            }
            Token::End { name } => {
                if matches!(name.as_str(), "html" | "head" | "body") {
                    continue;
                }
                if name == "br" {
                    insert(&mut stack, &mut roots, Node::Element(Element { name, namespace: Namespace::Html, attributes: vec![], children: vec![] }));
                    continue;
                }
                let found = stack.iter().rposition(|o| o.element.name == name);
                match found {
                    Some(at) => {
                        while stack.len() > at {
                            close_top(&mut stack, &mut roots);
                        }
                    }
                    None if name == "p" => {
                        insert(&mut stack, &mut roots, Node::Element(Element { name, namespace: Namespace::Html, attributes: vec![], children: vec![] }));
                    }
                    None => {}
                }
            }
        }
    }
    while !stack.is_empty() {
        close_top(&mut stack, &mut roots);
    }
    roots
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
    let roots = build(tokenize(&source));
    // Include omitted subtrees in budgets, not merely visible output nodes.
    let mut budget: Vec<(&Node, usize)> = roots.iter().map(|n| (n, 1)).collect();
    let mut structural = 0usize;
    while let Some((node, depth)) = budget.pop() {
        structural += 1;
        if structural > limits.max_nodes || depth > limits.max_depth {
            return Err(limit("HTML structure exceeds the import budget."));
        }
        if let Node::Element(e) = node {
            for child in &e.children {
                budget.push((child, depth + 1));
            }
        }
    }
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
