//! Sharing, people, public links, Live Doc addresses and collab tickets.
//! Port of makeSharesClient and makePeopleClient in src/lib/auth-client.ts.
use crate::client::{CloudClient, seg};
use crate::collab::COLLAB_SCHEMA_VERSION;
use crate::docs::Role;
use crate::error::{CloudError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareAccess {
    pub role: Role,
    #[serde(rename = "canRead")]
    pub can_read: bool,
    #[serde(rename = "canEdit")]
    pub can_edit: bool,
    #[serde(rename = "canManage")]
    pub can_manage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareMember {
    pub user_id: Option<String>,
    pub role: Role,
    #[serde(default)]
    pub created_at: Option<String>,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub waiting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareContact {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedByMeDoc {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(rename = "memberCount", default)]
    pub member_count: i64,
    #[serde(rename = "pendingCount", default)]
    pub pending_count: i64,
}

/// What adding a person did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddStatus {
    /// They can open it now.
    Member,
    /// No account yet: an invite waits for that address.
    Invited,
    /// They have not accepted this sender: it waits in their requests.
    Requested,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveDocAddress {
    pub url: String,
    pub shared: bool,
    pub network: Option<Vec<String>>,
}

/// What the document's server answered when asked for a live-editing pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollabTicketAnswer {
    Ticket { ticket: String, expires_at: i64 },
    /// A server from before tickets: connect with `?token=`.
    Legacy,
    Failed { status: u16 },
}

pub struct SharesClient<'a> {
    client: &'a CloudClient,
    /// Once this server issued a ticket (or refused one by name), a 404 never
    /// again reads as "no ticket route".
    issues_tickets: AtomicBool,
}

impl<'a> SharesClient<'a> {
    pub fn new(client: &'a CloudClient) -> Self {
        Self { client, issues_tickets: AtomicBool::new(false) }
    }

    fn doc(id: &str, tail: &str) -> String {
        format!("/api/docs/{}{tail}", seg(id))
    }

    pub async fn access(&self, doc_id: &str) -> Result<ShareAccess> {
        let v = self.client.get(&Self::doc(doc_id, "/access")).await?.json()?;
        serde_json::from_value(v["access"].clone()).map_err(|_| CloudError::Unreadable)
    }

    pub async fn shared_by_me(&self) -> Result<Vec<SharedByMeDoc>> {
        let v = self.client.get("/api/docs/shared-by-me").await?.json()?;
        serde_json::from_value(v.get("docs").cloned().unwrap_or(json!([]))).map_err(|_| CloudError::Unreadable)
    }

    pub async fn contacts(&self) -> Result<Vec<ShareContact>> {
        let v = self.client.get("/api/docs/share-contacts").await?.json()?;
        serde_json::from_value(v.get("contacts").cloned().unwrap_or(json!([]))).map_err(|_| CloudError::Unreadable)
    }

    pub async fn list(&self, doc_id: &str) -> Result<Vec<ShareMember>> {
        let v = self.client.get(&Self::doc(doc_id, "/shares")).await?.json()?;
        serde_json::from_value(v.get("shares").cloned().unwrap_or(json!([]))).map_err(|_| CloudError::Unreadable)
    }

    /// Invite by email as viewer or editor.
    pub async fn add(&self, doc_id: &str, email: &str, role: Role) -> Result<AddStatus> {
        let a = self.client.post(&Self::doc(doc_id, "/shares"), json!({ "email": email, "role": role })).await?;
        let v = a.json()?;
        serde_json::from_value(v.get("status").cloned().unwrap_or(Value::Null)).map_err(|_| CloudError::Unreadable)
    }

    /// Remove a member or invite. Returns the new public link when removing
    /// someone rotated it.
    pub async fn remove(&self, doc_id: &str, id_or_email: &str) -> Result<Option<String>> {
        let v = self.client.delete(&Self::doc(doc_id, &format!("/shares/{}", seg(id_or_email)))).await?.json()?;
        let rotated = v.get("publicLinkRotated").and_then(Value::as_bool) == Some(true);
        Ok(if rotated { v.get("url").and_then(Value::as_str).map(str::to_string) } else { None })
    }

    pub async fn public_link(&self, doc_id: &str) -> Result<Option<String>> {
        let v = self.client.get(&Self::doc(doc_id, "/public-link")).await?.json()?;
        Ok(v.get("url").and_then(Value::as_str).map(str::to_string))
    }

    pub async fn create_public_link(&self, doc_id: &str) -> Result<String> {
        let v = self.client.post(&Self::doc(doc_id, "/public-link"), json!({})).await?.json()?;
        v.get("url").and_then(Value::as_str).map(str::to_string).ok_or(CloudError::Unreadable)
    }

    pub async fn revoke_public_link(&self, doc_id: &str) -> Result<()> {
        self.client.delete(&Self::doc(doc_id, "/public-link")).await?.into_ok()?;
        Ok(())
    }

    pub async fn live_doc_address(&self, doc_id: &str) -> Result<LiveDocAddress> {
        let v = self.client.get(&Self::doc(doc_id, "/live-doc")).await?.json()?;
        parse_live_doc(&v).ok_or(CloudError::Unreadable)
    }

    /// `POST /api/docs/:id/collab-ticket {schema: 2}`.
    pub async fn collab_ticket(&self, doc_id: &str) -> CollabTicketAnswer {
        let res = self.client.post(&Self::doc(doc_id, "/collab-ticket"), json!({ "schema": COLLAB_SCHEMA_VERSION })).await;
        let a = match res {
            Ok(a) => a,
            Err(_) => return CollabTicketAnswer::Failed { status: 0 },
        };
        let data = a.data.as_ref();
        let ticket = if a.ok() { data.and_then(|d| d.get("ticket")).and_then(Value::as_str).unwrap_or("") } else { "" };
        if !ticket.is_empty() {
            self.issues_tickets.store(true, Ordering::SeqCst);
            let expires_at = data.and_then(|d| d.get("expiresAt")).and_then(Value::as_i64).unwrap_or(0);
            return CollabTicketAnswer::Ticket { ticket: ticket.to_string(), expires_at };
        }
        let refused_by_route = data.and_then(|d| d.get("error")).and_then(Value::as_str) == Some("no_ticket");
        if refused_by_route || a.status == 429 {
            self.issues_tickets.store(true, Ordering::SeqCst);
        }
        let no_route = (a.status == 404 || a.status == 405) && !refused_by_route;
        if no_route && !self.issues_tickets.load(Ordering::SeqCst) { CollabTicketAnswer::Legacy } else { CollabTicketAnswer::Failed { status: a.status } }
    }
}

/// An https address, or http on a loopback name for local development.
fn live_doc_url(v: &Value) -> Option<String> {
    let u = url::Url::parse(v.as_str()?).ok()?;
    let host = u.host_str().unwrap_or_default();
    let local = host == "localhost" || host.ends_with(".localhost");
    (u.scheme() == "https" || (u.scheme() == "http" && local)).then(|| u.to_string())
}

fn parse_live_doc(v: &Value) -> Option<LiveDocAddress> {
    let url = live_doc_url(v.get("url")?)?;
    let shared = v.get("access").and_then(Value::as_str) == Some("shared");
    let network = match v.get("network") {
        Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(
            a.iter()
                .filter_map(Value::as_str)
                .filter(|o| {
                    o.strip_prefix("https://").is_some_and(|rest| {
                        let (host, port) = rest.split_once(':').map(|(h, p)| (h, Some(p))).unwrap_or((rest, None));
                        (1..=253).contains(&host.len())
                            && host.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
                            && port.is_none_or(|p| (1..=5).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit()))
                    })
                })
                .take(50)
                .map(str::to_string)
                .collect(),
        ),
        _ => Some(Vec::new()),
    };
    Some(LiveDocAddress { url, shared, network })
}

/// Someone wants to share a document with this account and is not accepted yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareRequest {
    #[serde(rename = "docId")]
    pub doc_id: String,
    pub name: String,
    pub kind: String,
    pub role: Role,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub sender: Person,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub email: String,
    #[serde(default)]
    pub since: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct People {
    pub accepted: Vec<Person>,
    pub blocked: Vec<Person>,
}

pub struct PeopleClient<'a> {
    client: &'a CloudClient,
}

impl<'a> PeopleClient<'a> {
    pub fn new(client: &'a CloudClient) -> Self {
        Self { client }
    }

    pub async fn requests(&self) -> Result<(Vec<ShareRequest>, usize)> {
        let v = self.client.get("/api/people/requests").await?.json()?;
        let list: Vec<ShareRequest> = serde_json::from_value(v.get("requests").cloned().unwrap_or(json!([]))).map_err(|_| CloudError::Unreadable)?;
        let count = v.get("count").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(list.len());
        Ok((list, count))
    }

    pub async fn people(&self) -> Result<People> {
        let v = self.client.get("/api/people").await?.json()?;
        let get = |k: &str| serde_json::from_value::<Vec<Person>>(v.get(k).cloned().unwrap_or(json!([]))).map_err(|_| CloudError::Unreadable);
        Ok(People { accepted: get("accepted")?, blocked: get("blocked")? })
    }

    async fn post_ok(&self, path: &str) -> Result<()> {
        self.client.post(path, json!({})).await?.into_ok().map(|_| ())
    }

    pub async fn accept(&self, sender_id: &str) -> Result<()> {
        self.post_ok(&format!("/api/people/{}/accept", seg(sender_id))).await
    }
    pub async fn decline(&self, doc_id: &str) -> Result<()> {
        self.post_ok(&format!("/api/people/requests/{}/decline", seg(doc_id))).await
    }
    pub async fn block(&self, sender_id: &str) -> Result<()> {
        self.post_ok(&format!("/api/people/{}/block", seg(sender_id))).await
    }
    pub async fn unblock(&self, sender_id: &str) -> Result<()> {
        self.post_ok(&format!("/api/people/{}/unblock", seg(sender_id))).await
    }
    pub async fn remove(&self, sender_id: &str) -> Result<()> {
        self.client.delete(&format!("/api/people/{}", seg(sender_id))).await?.into_ok().map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_doc_addresses_are_filtered() {
        let v = json!({ "url": "https://live.example.com/x", "access": "shared", "network": ["https://a.example.com", "http://b.example.com", "https://c.example.com:8443", 4] });
        let a = parse_live_doc(&v).unwrap();
        assert!(a.shared);
        assert_eq!(a.network, Some(vec!["https://a.example.com".to_string(), "https://c.example.com:8443".to_string()]));
        assert!(parse_live_doc(&json!({ "url": "http://evil.example.com" })).is_none());
        assert!(parse_live_doc(&json!({ "url": "http://app.localhost:5173/" })).is_some());
        let a = parse_live_doc(&json!({ "url": "https://x.example.com", "network": null })).unwrap();
        assert_eq!((a.shared, a.network), (false, None));
        assert_eq!(parse_live_doc(&json!({ "url": "https://x.example.com" })).unwrap().network, Some(vec![]));
    }
}
