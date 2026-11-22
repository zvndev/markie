//! The model as a shared room holds it: y-prosemirror's XML for the TipTap
//! schema, independent of any CRDT library.
//!
//! y-prosemirror (here `@tiptap/y-tiptap`) writes each ProseMirror node as
//! an XmlElement named after the node, with every non-null attribute set as
//! an XML attribute (numbers and booleans stay typed). Text is an XmlText
//! whose formatting attributes are the marks, `{markName: markAttrs}`. Inline
//! atoms (math, hard breaks) are XmlElements between text pieces.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::model::*;

pub type Attrs = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq)]
pub enum RoomNode {
    Element { name: String, attrs: Attrs, children: Vec<RoomNode> },
    /// Formatted runs of one XmlText.
    Text(Vec<(String, Attrs)>),
}

fn el(name: &str, attrs: Attrs, children: Vec<RoomNode>) -> RoomNode {
    RoomNode::Element { name: name.into(), attrs, children }
}

fn attrs<const N: usize>(pairs: [(&str, Value); N]) -> Attrs {
    pairs.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.to_string(), v)).collect()
}

pub fn to_room(nodes: &[Node]) -> Vec<RoomNode> {
    nodes.iter().map(node_to_room).collect()
}

fn node_to_room(n: &Node) -> RoomNode {
    match n {
        Node::Paragraph { content, align } => {
            el("paragraph", attrs([("textAlign", json!(align))]), inlines_to_room(content))
        }
        Node::Heading { level, content, align } => el(
            "heading",
            attrs([("level", json!(level)), ("textAlign", json!(align))]),
            inlines_to_room(content),
        ),
        Node::Blockquote(c) => el("blockquote", Attrs::new(), to_room(c)),
        Node::BulletList { tight, items } => el(
            "bulletList",
            attrs([("tight", json!(tight))]),
            items.iter().map(|i| el("listItem", Attrs::new(), to_room(i))).collect(),
        ),
        Node::OrderedList { tight, start, items } => el(
            "orderedList",
            attrs([("tight", json!(tight)), ("start", json!(start))]),
            items.iter().map(|i| el("listItem", Attrs::new(), to_room(i))).collect(),
        ),
        Node::TaskList { items } => el(
            "taskList",
            Attrs::new(),
            items
                .iter()
                .map(|i| el("taskItem", attrs([("checked", json!(i.checked))]), to_room(&i.content)))
                .collect(),
        ),
        Node::CodeBlock { language, code } => el(
            "codeBlock",
            attrs([("language", json!(language))]),
            if code.is_empty() { vec![] } else { vec![RoomNode::Text(vec![(code.clone(), Attrs::new())])] },
        ),
        Node::HorizontalRule => el("horizontalRule", Attrs::new(), vec![]),
        Node::Table { rows } => el(
            "table",
            Attrs::new(),
            rows.iter()
                .map(|r| {
                    el(
                        "tableRow",
                        Attrs::new(),
                        r.iter()
                            .map(|c| {
                                el(
                                    if c.header { "tableHeader" } else { "tableCell" },
                                    attrs([
                                        ("colspan", json!(1)),
                                        ("rowspan", json!(1)),
                                        ("align", json!(c.align.map(|a| a.name()))),
                                    ]),
                                    to_room(&c.content),
                                )
                            })
                            .collect(),
                    )
                })
                .collect(),
        ),
        Node::Image { src, alt, title, width } => el(
            "image",
            attrs([("src", json!(src)), ("alt", json!(alt)), ("title", json!(title)), ("width", json!(width))]),
            vec![],
        ),
        Node::MathBlock { source } => el("mathBlock", attrs([("source", json!(source))]), vec![]),
        Node::Embed { url } => el("embed", attrs([("url", json!(url))]), vec![]),
    }
}

pub fn marks_to_attrs(m: &Marks) -> Attrs {
    let mut a = Attrs::new();
    let empty = || Value::Object(Default::default());
    if m.bold {
        a.insert("bold".into(), empty());
    }
    if m.italic {
        a.insert("italic".into(), empty());
    }
    if m.strike {
        a.insert("strike".into(), empty());
    }
    if m.underline {
        a.insert("underline".into(), empty());
    }
    if m.code {
        a.insert("code".into(), empty());
    }
    if let Some(l) = &m.link {
        // TipTap's Link defaults, which y-prosemirror writes in full.
        a.insert(
            "link".into(),
            json!({
                "href": l.href,
                "target": "_blank",
                "rel": "noopener noreferrer nofollow",
                "class": null,
                "title": l.title,
            }),
        );
    }
    if let Some(h) = &m.highlight {
        a.insert("highlight".into(), json!({ "color": h.color }));
    }
    if let Some(t) = &m.text_style {
        a.insert(
            "textStyle".into(),
            json!({ "color": t.color, "fontFamily": t.font_family, "fontSize": t.font_size }),
        );
    }
    a
}

fn inlines_to_room(c: &[Inline]) -> Vec<RoomNode> {
    let mut out: Vec<RoomNode> = Vec::new();
    for i in c {
        match i {
            Inline::Text { text, marks } => {
                if text.is_empty() {
                    continue;
                }
                let run = (text.clone(), marks_to_attrs(marks));
                if let Some(RoomNode::Text(runs)) = out.last_mut() {
                    match runs.last_mut() {
                        Some((t, a)) if *a == run.1 => t.push_str(&run.0),
                        _ => runs.push(run),
                    }
                } else {
                    out.push(RoomNode::Text(vec![run]));
                }
            }
            Inline::Math { source } => out.push(el("mathInline", attrs([("source", json!(source))]), vec![])),
            Inline::HardBreak => out.push(el("hardBreak", Attrs::new(), vec![])),
        }
    }
    out
}

#[derive(Debug)]
pub struct RoomError(pub String);

impl std::fmt::Display for RoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RoomError {}

fn err<T>(s: impl Into<String>) -> Result<T, RoomError> {
    Err(RoomError(s.into()))
}

pub fn from_room(nodes: &[RoomNode]) -> Result<Vec<Node>, RoomError> {
    nodes.iter().map(room_to_node).collect()
}

fn s(a: &Attrs, k: &str) -> Option<String> {
    a.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn room_to_node(r: &RoomNode) -> Result<Node, RoomError> {
    let RoomNode::Element { name, attrs: a, children } = r else {
        return err("text where a block was expected");
    };
    Ok(match name.as_str() {
        "paragraph" => Node::Paragraph { content: room_inlines(children)?, align: s(a, "textAlign") },
        "heading" => Node::Heading {
            level: a.get("level").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
            content: room_inlines(children)?,
            align: s(a, "textAlign"),
        },
        "blockquote" => Node::Blockquote(from_room(children)?),
        "bulletList" => Node::BulletList {
            tight: a.get("tight").and_then(|v| v.as_bool()).unwrap_or(false),
            items: list_items(children, "listItem")?,
        },
        "orderedList" => Node::OrderedList {
            tight: a.get("tight").and_then(|v| v.as_bool()).unwrap_or(false),
            start: a.get("start").and_then(|v| v.as_u64()).unwrap_or(1),
            items: list_items(children, "listItem")?,
        },
        "taskList" => Node::TaskList {
            items: children
                .iter()
                .map(|c| match c {
                    RoomNode::Element { name, attrs, children } if name == "taskItem" => Ok(TaskItem {
                        checked: attrs.get("checked").and_then(|v| v.as_bool()).unwrap_or(false),
                        content: from_room(children)?,
                    }),
                    _ => err("taskList holds something other than taskItem"),
                })
                .collect::<Result<_, _>>()?,
        },
        "codeBlock" => Node::CodeBlock {
            language: s(a, "language"),
            code: children
                .iter()
                .map(|c| match c {
                    RoomNode::Text(runs) => runs.iter().map(|(t, _)| t.as_str()).collect::<String>(),
                    _ => String::new(),
                })
                .collect(),
        },
        "horizontalRule" => Node::HorizontalRule,
        "table" => Node::Table {
            rows: children
                .iter()
                .map(|row| match row {
                    RoomNode::Element { name, children, .. } if name == "tableRow" => children
                        .iter()
                        .map(|cell| match cell {
                            RoomNode::Element { name, attrs, children }
                                if name == "tableHeader" || name == "tableCell" =>
                            {
                                Ok(Cell {
                                    header: name == "tableHeader",
                                    align: s(attrs, "align").and_then(|x| Align::from_name(&x)),
                                    content: from_room(children)?,
                                })
                            }
                            _ => err("tableRow holds something other than a cell"),
                        })
                        .collect::<Result<Vec<_>, _>>(),
                    _ => err("table holds something other than tableRow"),
                })
                .collect::<Result<_, _>>()?,
        },
        "image" => Node::Image {
            src: s(a, "src").unwrap_or_default(),
            alt: s(a, "alt"),
            title: s(a, "title"),
            width: a.get("width").and_then(|v| {
                v.as_u64().map(|n| n as u32).or_else(|| v.as_str().and_then(crate::html::normalize_width))
            }),
        },
        "mathBlock" => Node::MathBlock { source: s(a, "source").unwrap_or_default() },
        "embed" => Node::Embed { url: s(a, "url").unwrap_or_default() },
        other => return err(format!("node `{other}` is not in the Markie RS model yet")),
    })
}

fn list_items(children: &[RoomNode], item: &str) -> Result<Vec<Vec<Node>>, RoomError> {
    children
        .iter()
        .map(|c| match c {
            RoomNode::Element { name, children, .. } if name == item => from_room(children),
            _ => err(format!("list holds something other than {item}")),
        })
        .collect()
}

pub fn attrs_to_marks(a: &Attrs) -> Result<Marks, RoomError> {
    let mut m = Marks::default();
    for (k, v) in a {
        match k.as_str() {
            "bold" => m.bold = true,
            "italic" => m.italic = true,
            "strike" => m.strike = true,
            "underline" => m.underline = true,
            "code" => m.code = true,
            "link" => {
                m.link = Some(Link {
                    href: v.get("href").and_then(|h| h.as_str()).unwrap_or("").to_string(),
                    title: v.get("title").and_then(|h| h.as_str()).map(|s| s.to_string()),
                    style: LinkStyle::Inline,
                })
            }
            "highlight" => {
                m.highlight = Some(Highlight { color: v.get("color").and_then(|c| c.as_str()).map(|s| s.to_string()) })
            }
            "textStyle" => {
                let f = |k: &str| v.get(k).and_then(|c| c.as_str()).map(|s| s.to_string());
                m.text_style = Some(TextStyle { color: f("color"), font_family: f("fontFamily"), font_size: f("fontSize") })
            }
            other => return err(format!("mark `{other}` is not in the Markie RS model yet")),
        }
    }
    Ok(m)
}

fn room_inlines(children: &[RoomNode]) -> Result<Vec<Inline>, RoomError> {
    let mut out = Vec::new();
    for c in children {
        match c {
            RoomNode::Text(runs) => {
                for (t, a) in runs {
                    out.push(Inline::Text { text: t.clone(), marks: attrs_to_marks(a)? });
                }
            }
            RoomNode::Element { name, attrs, .. } => match name.as_str() {
                "mathInline" => out.push(Inline::Math { source: s(attrs, "source").unwrap_or_default() }),
                "hardBreak" => out.push(Inline::HardBreak),
                other => return err(format!("inline node `{other}` is not in the Markie RS model yet")),
            },
        }
    }
    Ok(normalize_inlines(out))
}

/// The room's JSON, for tests and for comparing with the Node side.
pub fn to_json(nodes: &[RoomNode]) -> Value {
    Value::Array(
        nodes
            .iter()
            .map(|n| match n {
                RoomNode::Element { name, attrs, children } => {
                    json!({"name": name, "attrs": attrs, "children": to_json(children)})
                }
                RoomNode::Text(runs) => {
                    json!({"text": runs.iter().map(|(t, a)| json!({"insert": t, "attributes": a})).collect::<Vec<_>>()})
                }
            })
            .collect(),
    )
}
