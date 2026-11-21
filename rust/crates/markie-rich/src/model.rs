//! The editor model: the TipTap schema as Rust types.
//!
//! Node and mark names follow `src/lib/rich-extensions.ts` because they are
//! what a shared room holds (see `room.rs`). A few fields exist only on the
//! Rust side, such as how a link was written in the source. They let an
//! edited block write its links back in the author's own style, and they are
//! never sent to a room.

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Paragraph(Vec<Inline>),
    Heading { level: u8, content: Vec<Inline> },
    Blockquote(Vec<Node>),
    BulletList { tight: bool, items: Vec<Vec<Node>> },
    OrderedList { tight: bool, start: u64, items: Vec<Vec<Node>> },
    TaskList { items: Vec<TaskItem> },
    CodeBlock { language: Option<String>, code: String },
    HorizontalRule,
    Table { rows: Vec<Vec<Cell>> },
    Image { src: String, alt: Option<String>, title: Option<String> },
    MathBlock { source: String },
    Embed { url: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskItem {
    pub checked: bool,
    pub content: Vec<Node>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    pub fn name(self) -> &'static str {
        match self {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
        }
    }
    pub fn from_name(s: &str) -> Option<Align> {
        match s {
            "left" => Some(Align::Left),
            "center" => Some(Align::Center),
            "right" => Some(Align::Right),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub header: bool,
    pub align: Option<Align>,
    pub content: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text { text: String, marks: Marks },
    /// `$…$` with its delimiters, byte for byte (TipTap `mathInline`).
    Math { source: String },
    HardBreak,
}

impl Inline {
    pub fn text(s: impl Into<String>) -> Inline {
        Inline::Text { text: s.into(), marks: Marks::default() }
    }
    pub fn marked(s: impl Into<String>, marks: Marks) -> Inline {
        Inline::Text { text: s.into(), marks }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub underline: bool,
    pub code: bool,
    pub link: Option<Link>,
}

impl Marks {
    pub fn is_plain(&self) -> bool {
        *self == Marks::default()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Link {
    pub href: String,
    pub title: Option<String>,
    /// Rust only: how the source wrote it, for writing an edited block back.
    pub style: LinkStyle,
}

/// Two links are the same link when a room would say so: style is local.
impl PartialEq for Link {
    fn eq(&self, other: &Self) -> bool {
        self.href == other.href && self.title == other.title
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum LinkStyle {
    #[default]
    Inline,
    /// `<https://…>`, or a bare URL that linkify turned into a link.
    Autolink,
    /// `[text][label]`, `[text][]` or `[text]`, with its label.
    Reference(String),
}

/// Merge adjacent text runs with equal marks and drop empty ones, so two
/// models that mean the same thing compare equal.
pub fn normalize_inlines(inlines: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(inlines.len());
    for inline in inlines {
        match inline {
            Inline::Text { text, marks } => {
                if text.is_empty() {
                    continue;
                }
                if let Some(Inline::Text { text: prev, marks: pm }) = out.last_mut() {
                    if *pm == marks {
                        prev.push_str(&text);
                        continue;
                    }
                }
                out.push(Inline::Text { text, marks });
            }
            other => out.push(other),
        }
    }
    out
}

/// Plain text of inline content, for display and tests.
pub fn inline_text(inlines: &[Inline]) -> String {
    let mut s = String::new();
    for i in inlines {
        match i {
            Inline::Text { text, .. } => s.push_str(text),
            Inline::Math { source } => s.push_str(source),
            Inline::HardBreak => s.push('\n'),
        }
    }
    s
}
