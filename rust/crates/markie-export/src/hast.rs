//! A small owned HTML tree, the Rust stand-in for hast.
//!
//! Electron runs every export and every `.wd` preview through unified:
//! `rehype-raw` parses HTML with parse5, plugins walk the hast tree, and
//! `hast-util-to-html` writes it back. Here html5ever parses (the same HTML
//! standard tree builder parse5 implements), the passes walk [`Node`], and
//! [`to_html`] writes it the way hast-util-to-html does: void elements with no
//! slash, boolean attributes bare, `&` and `<` escaped in text, `&` and `"`
//! escaped in attribute values.

use std::cell::RefCell;

use html5ever::tendril::TendrilSink;
use html5ever::{LocalName, QualName, local_name, namespace_url, ns};
use markup5ever_rcdom::{Handle, NodeData, RcDom};

/// Which namespace an element came from. Foreign content keeps its own
/// attribute casing (`viewBox`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Space {
    Html,
    Svg,
    MathMl,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub tag: String,
    pub space: Space,
    /// Attribute names as written in HTML (lower case for HTML elements).
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    /// A `<template>`'s contents, kept apart from `children` as hast does.
    pub content: Option<Vec<Node>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Element(Element),
    Text(String),
    Comment(String),
    /// Markup inserted by a trusted pass (rendered math). Written verbatim and
    /// never walked by a sanitizer, so it must only ever be built in Rust.
    Raw(String),
}

impl Element {
    pub fn new(tag: &str) -> Self {
        Self { tag: tag.to_string(), space: Space::Html, attrs: Vec::new(), children: Vec::new(), content: None }
    }

    pub fn with_attr(mut self, name: &str, value: &str) -> Self {
        self.set(name, value);
        self
    }

    pub fn with_children(mut self, children: Vec<Node>) -> Self {
        self.children = children;
        self
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn has(&self, name: &str) -> bool {
        self.attrs.iter().any(|(k, _)| k == name)
    }

    pub fn set(&mut self, name: &str, value: &str) {
        if let Some(slot) = self.attrs.iter_mut().find(|(k, _)| k == name) {
            slot.1 = value.to_string();
        } else {
            self.attrs.push((name.to_string(), value.to_string()));
        }
    }

    pub fn remove(&mut self, name: &str) -> Option<String> {
        let at = self.attrs.iter().position(|(k, _)| k == name)?;
        Some(self.attrs.remove(at).1)
    }

    /// The element's class list.
    pub fn classes(&self) -> Vec<&str> {
        self.get("class").map(|c| c.split_ascii_whitespace().collect()).unwrap_or_default()
    }

    pub fn has_class(&self, class: &str) -> bool {
        self.classes().contains(&class)
    }

    /// The concatenated text of this element's descendants.
    pub fn text(&self) -> String {
        let mut out = String::new();
        collect_text(&self.children, &mut out);
        out
    }
}

fn collect_text(nodes: &[Node], out: &mut String) {
    for node in nodes {
        match node {
            Node::Text(t) => out.push_str(t),
            Node::Element(e) => collect_text(&e.children, out),
            _ => {}
        }
    }
}

/// Text of a node list.
pub fn text_of(nodes: &[Node]) -> String {
    let mut out = String::new();
    collect_text(nodes, &mut out);
    out
}

/// Parses an HTML fragment in a `<body>` context, the way rehype-raw parses a
/// document's raw HTML into the tree around it. Comments are kept; the
/// sanitizers drop them.
pub fn parse_fragment(html: &str) -> Vec<Node> {
    let context = QualName::new(None, ns!(html), local_name!("body"));
    let dom = html5ever::parse_fragment(RcDom::default(), Default::default(), context, vec![]).one(html);
    let document = dom.document;
    // The fragment parser puts everything under a synthetic <html> element.
    let root = document.children.borrow().first().cloned();
    match root {
        Some(root) => convert_children(&root),
        None => Vec::new(),
    }
}

fn convert_children(handle: &Handle) -> Vec<Node> {
    handle.children.borrow().iter().filter_map(convert).collect()
}

fn convert(handle: &Handle) -> Option<Node> {
    match &handle.data {
        NodeData::Text { contents } => Some(Node::Text(contents.borrow().to_string())),
        NodeData::Comment { contents } => Some(Node::Comment(contents.to_string())),
        NodeData::Element { name, attrs, template_contents, .. } => {
            let space = if name.ns == ns!(svg) {
                Space::Svg
            } else if name.ns == ns!(mathml) {
                Space::MathMl
            } else {
                Space::Html
            };
            let attrs = attrs
                .borrow()
                .iter()
                .map(|a| {
                    let local = a.name.local.to_string();
                    // html5ever gives a foreign element's `xmlns` an empty prefix.
                    let name = match a.name.prefix.as_ref() {
                        Some(prefix) if !prefix.is_empty() => format!("{prefix}:{local}"),
                        _ => local,
                    };
                    (name, a.value.to_string())
                })
                .collect();
            let content = template(template_contents);
            Some(Node::Element(Element {
                tag: name.local.to_string(),
                space,
                attrs,
                children: convert_children(handle),
                content,
            }))
        }
        _ => None,
    }
}

fn template(contents: &RefCell<Option<Handle>>) -> Option<Vec<Node>> {
    contents.borrow().as_ref().map(convert_children)
}

const VOID: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "image", "img", "input", "keygen", "link",
    "meta", "param", "source", "track", "wbr",
];

/// HTML attributes hast reads as booleans. hast-util-to-html writes a true one
/// as the bare name.
const BOOLEAN: &[&str] = &[
    "allowfullscreen", "async", "autofocus", "autoplay", "checked", "compact", "controls", "default", "defer", "disabled",
    "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nohref", "noresize", "noshade",
    "novalidate", "nowrap", "open", "playsinline", "readonly", "required", "reversed", "scoped", "seamless", "selected",
    "typemustmatch",
];

pub fn is_boolean_attr(name: &str) -> bool {
    BOOLEAN.contains(&name)
}

pub fn is_void(tag: &str) -> bool {
    VOID.contains(&tag)
}

/// Writes nodes the way hast-util-to-html does by default.
pub fn to_html(nodes: &[Node]) -> String {
    let mut out = String::new();
    write_nodes(nodes, &mut out, false);
    out
}

fn write_nodes(nodes: &[Node], out: &mut String, raw_text: bool) {
    for node in nodes {
        match node {
            Node::Text(t) => {
                if raw_text {
                    out.push_str(t);
                } else {
                    escape_text_into(t, out);
                }
            }
            Node::Comment(c) => {
                out.push_str("<!--");
                out.push_str(c);
                out.push_str("-->");
            }
            Node::Raw(r) => out.push_str(r),
            Node::Element(e) => write_element(e, out),
        }
    }
}

fn write_element(e: &Element, out: &mut String) {
    out.push('<');
    out.push_str(&e.tag);
    for (name, value) in &e.attrs {
        out.push(' ');
        out.push_str(name);
        if e.space == Space::Html && is_boolean_attr(name) && (value.is_empty() || value.eq_ignore_ascii_case(name)) {
            continue;
        }
        out.push_str("=\"");
        escape_attr_into(value, out);
        out.push('"');
    }
    // hast-util-to-html's default (`closeEmptyElements: false`) writes an
    // empty SVG or MathML element with an end tag, as `<path d=""></path>`.
    out.push('>');
    if e.space == Space::Html && is_void(&e.tag) {
        return;
    }
    if let Some(content) = &e.content {
        write_nodes(content, out, false);
    }
    let raw = e.space == Space::Html && matches!(e.tag.as_str(), "script" | "style");
    write_nodes(&e.children, out, raw);
    out.push_str("</");
    out.push_str(&e.tag);
    out.push('>');
}

pub fn escape_text_into(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&#x26;"),
            '<' => out.push_str("&#x3C;"),
            _ => out.push(c),
        }
    }
}

pub fn escape_attr_into(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&#x26;"),
            '"' => out.push_str("&#x22;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
}

pub fn escape_text(text: &str) -> String {
    let mut out = String::new();
    escape_text_into(text, &mut out);
    out
}

pub fn escape_attr(text: &str) -> String {
    let mut out = String::new();
    escape_attr_into(text, &mut out);
    out
}

/// Visits every element, parents before children, with mutable access.
pub fn walk_mut(nodes: &mut [Node], f: &mut dyn FnMut(&mut Element)) {
    for node in nodes {
        if let Node::Element(e) = node {
            f(e);
            walk_mut(&mut e.children, f);
            if let Some(content) = &mut e.content {
                walk_mut(content, f);
            }
        }
    }
}

/// A local name for html5ever lookups.
pub fn local(name: &str) -> LocalName {
    LocalName::from(name)
}
