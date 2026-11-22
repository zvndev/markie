//! Document links are versioned pointers, never file uploads.
use crate::assets::{decoded_ref, destinations, without_code};
use crate::docs::DocsClient;
use crate::error::{CloudError, Result};
use crate::sync::hash_content;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)>]{1,2048}))(?:\s+"[^"]*")?\s*\)"#).unwrap()
});
static DEFINITION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))").unwrap()
});
static HTML: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    #[serde(rename = "ref")]
    pub reference: String,
    pub target: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Transfer {
    pub fingerprint: Option<String>,
    pub refused: Option<u16>,
}

pub fn references(content: &str) -> Vec<String> {
    let Some(text) = without_code(content) else {
        return Vec::new();
    };
    let markdown =
        destinations(&LINK, &text).filter(|(at, _)| *at == 0 || text.as_bytes()[*at - 1] != b'!');
    let mut found: Vec<_> = markdown
        .chain(destinations(&DEFINITION, &text))
        .chain(destinations(&HTML, &text))
        .collect();
    found.sort_by_key(|(at, _)| *at);
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter_map(|(_, dest)| decoded_ref(dest))
        .filter(|r| {
            Path::new(r)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| {
                    matches!(
                        e.to_ascii_lowercase().as_str(),
                        "md" | "markdown" | "mdx" | "txt"
                    )
                })
                && seen.insert(r.clone())
        })
        .take(500)
        .collect()
}

fn absolute_link(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                normal.pop();
            }
            Component::CurDir => {}
            _ => normal.push(c),
        }
    }
    path.canonicalize().unwrap_or(normal)
}

/// Only destinations already in this same origin and account are eligible.
pub fn resolve(
    file: &Path,
    content: &str,
    cloud_id: impl Fn(&Path) -> Option<String>,
) -> Vec<Link> {
    let folder = file.parent().unwrap_or_else(|| Path::new(""));
    references(content)
        .into_iter()
        .filter_map(|reference| {
            let target = cloud_id(&absolute_link(&folder.join(&reference)))?;
            Some(Link { reference, target })
        })
        .collect()
}

pub fn fingerprint(links: &[Link]) -> String {
    let mut pairs: Vec<_> = links.iter().map(|p| (&p.reference, &p.target)).collect();
    pairs.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    hash_content(&serde_json::to_string(&pairs).unwrap())
}

pub async fn reconcile(
    docs: &DocsClient<'_>,
    id: &str,
    version: i64,
    links: &[Link],
    previous: &Transfer,
) -> Result<Transfer> {
    let fingerprint = fingerprint(links);
    if previous.fingerprint.as_deref() == Some(&fingerprint) {
        return Ok(previous.clone());
    }
    let answer = docs
        .put_links(id, json!({"links": links, "baseVersion": version}))
        .await?;
    let refused = match answer.status {
        200 => None,
        400 | 413 => Some(answer.status),
        _ => return Err(answer.into_ok().err().unwrap_or(CloudError::Unreadable)),
    };
    Ok(Transfer {
        fingerprint: Some(fingerprint),
        refused,
    })
}

pub async fn fetch(docs: &DocsClient<'_>, id: &str) -> Result<Vec<Link>> {
    Ok(fetch_all(docs, id).await?.0)
}

/// The server's answer for a document's links: the ones this account may
/// follow, and the references it knows but would not name a target for
/// (doc-link-open.js "none": "This document isn't shared with you.").
pub async fn fetch_all(docs: &DocsClient<'_>, id: &str) -> Result<(Vec<Link>, Vec<String>)> {
    let value = docs.links(id).await?;
    #[derive(Deserialize)]
    struct Answer {
        #[serde(rename = "ref")]
        reference: String,
        target: Option<String>,
    }
    let links: Vec<Answer> =
        serde_json::from_value(value.get("links").cloned().ok_or(CloudError::Unreadable)?)
            .map_err(|_| CloudError::Unreadable)?;
    let mut open = Vec::new();
    let mut refused = Vec::new();
    for row in links {
        match row.target.filter(|t| !t.is_empty()) {
            Some(target) => open.push(Link { reference: row.reference, target }),
            None => refused.push(row.reference),
        }
    }
    Ok((open, refused))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_local_ordered_document_pointers() {
        let md = "[read](<a%20b.md#head>) ![not a link](image.md) [url](https://a/b.md)\n\
                  [other]: ../c.TXT\n<a href='d.mdx?foo'>Doc</a> [skip](q.docx)";
        assert_eq!(references(md), ["a b.md", "../c.TXT", "d.mdx"]);
        let links = resolve(Path::new("/example/sub/a.md"), md, |p| {
            (p == Path::new("/example/c.TXT")).then(|| "some-id".into())
        });
        assert_eq!(
            links,
            [Link {
                reference: "../c.TXT".into(),
                target: "some-id".into()
            }]
        );
    }
}
