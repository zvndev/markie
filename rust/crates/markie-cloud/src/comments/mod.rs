//! Comment threads. Cloud threads (this file) are a port of
//! src/lib/comments.ts; local comments on Markdown files are `local`, with
//! their quote anchors in `anchor` and the rich-view projection in `project`.
//!
//! The anchor is opaque here: for rich rooms it is y-prosemirror
//! RelativePosition JSON into the XmlFragment, which belongs to the rich
//! editor work. This client carries it through unchanged.
pub mod anchor;
pub mod local;
pub mod project;

use crate::client::{CloudClient, seg};
use crate::error::{CloudError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadComment {
    pub id: String,
    pub thread_id: String,
    pub author_id: String,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_email: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus {
    Open,
    Resolved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommentThread {
    pub id: String,
    pub doc_id: String,
    pub anchor: Value,
    pub status: ThreadStatus,
    pub created_by: String,
    pub created_at: String,
    #[serde(default)]
    pub comments: Vec<ThreadComment>,
}

pub struct CommentsClient<'a> {
    client: &'a CloudClient,
}

impl<'a> CommentsClient<'a> {
    pub fn new(client: &'a CloudClient) -> Self {
        Self { client }
    }

    fn base(doc_id: &str) -> String {
        format!("/api/docs/{}/threads", seg(doc_id))
    }

    pub async fn list(&self, doc_id: &str) -> Result<Vec<CommentThread>> {
        let v = self.client.get(&Self::base(doc_id)).await?.json()?;
        serde_json::from_value(v.get("threads").cloned().unwrap_or(json!([]))).map_err(|_| CloudError::Unreadable)
    }

    /// Open a thread with its first comment. Returns the thread id.
    pub async fn create_thread(&self, doc_id: &str, anchor: Value, body: &str) -> Result<String> {
        let v = self.client.post(&Self::base(doc_id), json!({ "anchor": anchor, "body": body })).await?.json()?;
        v.get("id").and_then(Value::as_str).map(str::to_string).ok_or(CloudError::Unreadable)
    }

    pub async fn reply(&self, doc_id: &str, thread_id: &str, body: &str) -> Result<String> {
        let path = format!("{}/{}/comments", Self::base(doc_id), seg(thread_id));
        let v = self.client.post(&path, json!({ "body": body })).await?.json()?;
        v.get("id").and_then(Value::as_str).map(str::to_string).ok_or(CloudError::Unreadable)
    }

    pub async fn set_status(&self, doc_id: &str, thread_id: &str, status: ThreadStatus) -> Result<()> {
        let path = format!("{}/{}/status", Self::base(doc_id), seg(thread_id));
        self.client.post(&path, json!({ "status": status })).await?.into_ok().map(|_| ())
    }

    pub async fn delete_comment(&self, doc_id: &str, thread_id: &str, comment_id: &str) -> Result<()> {
        let path = format!("{}/{}/comments/{}", Self::base(doc_id), seg(thread_id), seg(comment_id));
        self.client.delete(&path).await?.into_ok().map(|_| ())
    }
}
