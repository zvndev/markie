//! The section rail: H1 to H3 headings of a markdown document, with the line
//! each starts on. Parsed with a CommonMark parser, so headings inside code
//! fences and front matter do not count and setext headings do.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Section {
    pub level: u8,
    pub text: String,
    /// 0-based line in the full text, front matter included.
    pub line: usize,
}

/// Byte length of a leading YAML front matter block, or 0.
pub fn front_matter_len(text: &str) -> usize {
    let Some(rest) = text.strip_prefix("---") else { return 0 };
    if !rest.starts_with('\n') && !rest.starts_with("\r\n") {
        return 0;
    }
    let mut offset = 3 + if rest.starts_with("\r\n") { 2 } else { 1 };
    for line in text[offset..].split_inclusive('\n') {
        offset += line.len();
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" || trimmed == "..." {
            return offset;
        }
    }
    0
}

pub fn sections(text: &str) -> Vec<Section> {
    let fm = front_matter_len(text);
    let body = &text[fm..];
    let base_line = text[..fm].matches('\n').count();
    let mut out = Vec::new();
    let mut current: Option<(u8, usize, String)> = None;
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for (event, range) in Parser::new_ext(body, opts).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                let level = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    _ => 0,
                };
                if level > 0 {
                    let line = base_line + body[..range.start].matches('\n').count();
                    current = Some((level, line, String::new()));
                }
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some((_, _, s)) = current.as_mut() {
                    s.push_str(&t);
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, line, text)) = current.take() {
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        out.push(Section { level, text, line });
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_code_and_front_matter_and_reads_setext() {
        let text = "---\ntitle: x\n# not\n---\n# One\n\n```\n# fake\n```\n\nTwo `code`\n---\n\n#### deep\n";
        let s = sections(text);
        assert_eq!(
            s,
            vec![
                Section { level: 1, text: "One".into(), line: 4 },
                Section { level: 2, text: "Two code".into(), line: 10 },
            ]
        );
    }
}
