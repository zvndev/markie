//! What the share dialog, the banner and the people lists say, and the rules
//! behind them. Ports of src/lib/share-role.ts, general-access.ts,
//! share-access-view.ts and the pure parts of share-dialog.tsx, wording
//! included: the wording is part of the feature.
use crate::docs::Role;
use crate::origin::doc_link_origin;
use crate::sharing::{ShareAccess, ShareContact, ShareMember};
use std::collections::HashSet;

pub const MAX_SUGGESTIONS: usize = 6;

/// `^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$` on the trimmed value.
pub fn is_email(value: &str) -> bool {
    let v = value.trim();
    let bad = |c: char| c.is_whitespace() || c == '@' || c == ',' || c == ';';
    let Some((local, domain)) = v.split_once('@') else { return false };
    if local.is_empty() || local.chars().any(bad) || domain.chars().any(bad) {
        return false;
    }
    // A dot with something on both sides, somewhere in the domain.
    domain.char_indices().any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// Contacts matching the query by address or name, minus everyone already
/// on the document, at most six.
pub fn suggestions<'a>(contacts: &'a [ShareContact], query: &str, taken: &HashSet<String>) -> Vec<&'a ShareContact> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    contacts
        .iter()
        .filter(|c| !taken.contains(&c.email.to_lowercase()))
        .filter(|c| c.email.to_lowercase().contains(&q) || c.name.as_deref().unwrap_or("").to_lowercase().contains(&q))
        .take(MAX_SUGGESTIONS)
        .collect()
}

/// "a", "a and b", "a, b and c".
pub fn list_of(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 | 2 => items.join(" and "),
        n => format!("{} and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

/// What Send would send: the chosen addresses, plus a finished address still
/// in the field.
pub fn to_send(pending: &[String], query: &str) -> Vec<String> {
    let typed = query.trim().to_lowercase();
    let mut out = pending.to_vec();
    if is_email(&typed) && !pending.contains(&typed) {
        out.push(typed);
    }
    out
}

/// The flash line after Send.
pub fn send_summary(shared: &[String], requested: &[String], invited: &[String]) -> Option<String> {
    let mut lines = Vec::new();
    if !shared.is_empty() {
        lines.push(format!("Shared with {}.", list_of(shared)));
    }
    if !requested.is_empty() {
        lines.push(format!(
            "Asked {}. It reaches {} once they accept you in Markie.",
            list_of(requested),
            if requested.len() == 1 { "them" } else { "each of them" }
        ));
    }
    if !invited.is_empty() {
        lines.push(format!(
            "Invited {}. {} an email, and it reaches them once they join and accept you.",
            list_of(invited),
            if invited.len() == 1 { "They get" } else { "Each gets" }
        ));
    }
    (!lines.is_empty()).then(|| lines.join(" "))
}

/// The error line after Send, when some addresses failed.
pub fn send_failures(failed: &[(String, String)], sent: usize) -> Option<String> {
    if failed.is_empty() {
        return None;
    }
    if failed.len() == 1 && sent == 1 {
        return Some(failed[0].1.clone());
    }
    Some(failed.iter().map(|(e, m)| format!("{e}: {m}")).collect::<Vec<_>>().join(" "))
}

/// What a role permits, spelled out.
pub fn role_description(role: Role) -> &'static str {
    match role {
        Role::Owner => "Can edit, share, and delete",
        Role::Editor => "Can edit, but not share",
        Role::Viewer => "Can read, but not edit",
    }
}

pub fn role_label(role: Role) -> &'static str {
    match role {
        Role::Owner => "Owner",
        Role::Editor => "Editor",
        Role::Viewer => "Viewer",
    }
}

/// The line beside the role picker while inviting.
pub fn invite_role_line(role: Role) -> &'static str {
    if role == Role::Editor { "Can edit and comment" } else { "Can read and comment" }
}

pub const LIVE_DOC_PRIVATE_LINE: &str = "Live Docs are always private. Share with people instead.";
pub const LIVE_DOC_PUBLIC_LEFTOVER_LINE: &str = "Anyone with its public link can still open this Live Doc. Live Docs should be private: turn the link off.";

/// A Live Doc, by the server's rule: the name ends in `.wd`.
pub fn is_live_doc_name(name: &str) -> bool {
    name.trim().to_lowercase().ends_with(".wd")
}

/// The line under General access.
pub fn general_access_line(public: bool, busy: bool) -> &'static str {
    if busy {
        "Updating…"
    } else if public {
        "Anyone on the internet with the link can view"
    } else {
        "Only people with access can open with the link"
    }
}

pub fn share_members_empty_line(access: Option<&ShareAccess>) -> &'static str {
    match access {
        None => "People with access could not be loaded.",
        Some(a) if a.can_manage => "Not shared with anyone yet.",
        Some(_) => "No other joined collaborators are visible yet.",
    }
}

pub const ACCESS_UNLOADED_LINE: &str = "Access details could not be loaded. Sign in again or check your connection before changing sharing.";
pub const LINK_ROTATED_LINE: &str = "The public link changed because you removed someone. Share the new link wherever you had posted the old one.";

/// The second line of a member row.
pub fn member_sub_line(m: &ShareMember) -> String {
    if m.pending {
        "Invited, not joined yet".into()
    } else if m.waiting {
        "Waiting for them to accept".into()
    } else {
        m.email.clone()
    }
}

/// The document's private page: `/d/:id` on the docs origin.
pub fn private_url(server: &str, doc_id: &str) -> String {
    format!("{}/d/{}", doc_link_origin(server), crate::client::seg(doc_id))
}

/// The link Copy hands out: the public page when anyone may open it, else
/// the private page. A Live Doc's leftover public link is never handed out.
pub fn link_to_copy(server: &str, doc_id: &str, file_name: &str, public_url: Option<&str>) -> String {
    match public_url {
        Some(u) if !is_live_doc_name(file_name) => u.to_string(),
        _ => private_url(server, doc_id),
    }
}

/// What the current user may do with the open document (share-role.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareRoleState {
    /// No cloud copy, or signed out: nothing to enforce.
    Local,
    /// The server has not answered yet.
    Checking,
    /// The server could not be asked and no role was ever proved here.
    Unreachable,
    Owner,
    Editor,
    Viewer,
}

impl ShareRoleState {
    pub fn from_role(r: Role) -> Self {
        match r {
            Role::Owner => ShareRoleState::Owner,
            Role::Editor => ShareRoleState::Editor,
            Role::Viewer => ShareRoleState::Viewer,
        }
    }
}

/// `roleFor`: owners are not in the member list; only an explicit editor
/// grant unlocks editing.
pub fn role_for(members: Option<&[ShareMember]>, my_user_id: Option<&str>, owner_id: Option<&str>) -> Role {
    if let (Some(me), Some(owner)) = (my_user_id, owner_id) {
        if me == owner {
            return Role::Owner;
        }
    }
    let (Some(me), Some(members)) = (my_user_id, members) else { return Role::Viewer };
    match members.iter().find(|m| m.user_id.as_deref() == Some(me)) {
        Some(m) if m.role == Role::Editor => Role::Editor,
        _ => Role::Viewer,
    }
}

/// `canEditDocument`: checking and unreachable are read-only on purpose.
pub fn can_edit_document(state: ShareRoleState) -> bool {
    matches!(state, ShareRoleState::Local | ShareRoleState::Owner | ShareRoleState::Editor)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BannerKind {
    Checking,
    Unreachable,
    ViewOnly,
}

/// The strip above the document that explains why typing does nothing.
pub fn share_banner_for(state: ShareRoleState, shared_by: Option<&str>) -> Option<(BannerKind, String)> {
    match state {
        ShareRoleState::Checking => Some((BannerKind::Checking, "Checking your access…".into())),
        ShareRoleState::Unreachable => Some((
            BannerKind::Unreachable,
            "Can't reach the server, and this document's access was never confirmed on this machine. Read-only until it is.".into(),
        )),
        ShareRoleState::Viewer => Some((
            BannerKind::ViewOnly,
            match shared_by {
                Some(by) => format!("Shared with you by {by} · view only"),
                None => "Shared with you · view only".into(),
            },
        )),
        _ => None,
    }
}

/// Said when the server closes the room with 4403 (rich-view.tsx).
pub const ACCESS_REVOKED_LINE: &str = "Your access to this document was removed. It's read-only now — copy anything you still need.";
/// Said when no live session could start (share-banner.tsx).
pub const LIVE_UNAVAILABLE_LINE: &str = "The live session could not load. You are editing your copy alone.";
/// Said while a live rich session leaves the file alone (live-room-carry.ts).
pub const LIVE_FILE_REFUSAL_NOTE: &str = "Live edits stay in the live session. Your file isn't updated from the live session, because it has raw HTML, an HTML comment, a footnote, a picture address or other markdown that live editing can't keep exactly.";
/// Shown over Source while a session is live.
pub const LIVE_SOURCE_LINE: &str = "Live session. Edit in Rich.";
/// A room this build cannot draw, or a claim the server never answered.
pub const LIVE_JOIN_FAILED_LINE: &str = "Couldn't join the live session. You're editing the local copy.";

/// The share requests copy (share-people.tsx).
pub const REQUESTS_INTRO: &str = "Nothing someone shares reaches your Markie until you accept them. Accepting a person brings in everything they have shared with you, and what they share later.";
pub const PEOPLE_INTRO: &str = "What these people share lands in your Markie. Removing someone takes everything they shared out of your Markie at once.";
pub const PEOPLE_EMPTY: &str = "Nobody yet. When someone shares with you, accept them in Requests.";

/// A person's display name: their name, else their address.
pub fn who(name: Option<&str>, email: &str) -> String {
    name.filter(|n| !n.is_empty()).unwrap_or(email).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(email: &str, role: Role, user: Option<&str>) -> ShareMember {
        ShareMember { user_id: user.map(str::to_string), role, created_at: None, email: email.into(), name: None, pending: false, waiting: false }
    }

    #[test]
    fn emails_follow_the_dialogs_rule() {
        assert!(is_email("success@simulator.amazonses.com"));
        assert!(is_email("  a@b.co "));
        assert!(!is_email("a@b"));
        assert!(!is_email("a b@c.d"));
        assert!(!is_email("a@b.c,d"));
        assert!(!is_email("@b.co"));
        assert!(!is_email("a@.co"));
        assert!(is_email("a@x..co"));
    }

    #[test]
    fn summary_lines_read_like_electrons() {
        let one = vec!["a@x.io".to_string()];
        let two = vec!["a@x.io".to_string(), "b@x.io".to_string()];
        let three = vec!["a@x.io".to_string(), "b@x.io".to_string(), "c@x.io".to_string()];
        assert_eq!(list_of(&three), "a@x.io, b@x.io and c@x.io");
        assert_eq!(send_summary(&one, &[], &[]).unwrap(), "Shared with a@x.io.");
        assert_eq!(send_summary(&[], &two, &[]).unwrap(), "Asked a@x.io and b@x.io. It reaches each of them once they accept you in Markie.");
        assert_eq!(send_summary(&[], &[], &one).unwrap(), "Invited a@x.io. They get an email, and it reaches them once they join and accept you.");
        assert_eq!(send_summary(&[], &[], &[]), None);
        assert_eq!(to_send(&one, " B@x.io "), vec!["a@x.io".to_string(), "b@x.io".to_string()]);
        assert_eq!(to_send(&one, "b@x"), one);
    }

    #[test]
    fn suggestions_skip_people_already_on_the_doc() {
        let contacts = vec![
            ShareContact { email: "ada@x.io".into(), name: Some("Ada".into()) },
            ShareContact { email: "bob@x.io".into(), name: None },
        ];
        let mut taken = HashSet::new();
        assert_eq!(suggestions(&contacts, "a", &taken).len(), 1);
        taken.insert("ada@x.io".to_string());
        assert!(suggestions(&contacts, "ada", &taken).is_empty());
        assert!(suggestions(&contacts, "", &taken).is_empty());
    }

    #[test]
    fn roles_and_banners() {
        let members = vec![member("e@x.io", Role::Editor, Some("u2")), member("v@x.io", Role::Viewer, Some("u3"))];
        assert_eq!(role_for(Some(&members), Some("u1"), Some("u1")), Role::Owner);
        assert_eq!(role_for(Some(&members), Some("u2"), Some("u1")), Role::Editor);
        assert_eq!(role_for(Some(&members), Some("u3"), Some("u1")), Role::Viewer);
        assert_eq!(role_for(None, Some("u2"), Some("u1")), Role::Viewer);
        assert!(!can_edit_document(ShareRoleState::Checking));
        assert!(can_edit_document(ShareRoleState::Local));
        assert_eq!(share_banner_for(ShareRoleState::Viewer, Some("Ada")).unwrap().1, "Shared with you by Ada · view only");
        assert_eq!(share_banner_for(ShareRoleState::Editor, None), None);
    }

    #[test]
    fn links() {
        assert_eq!(private_url("https://api.markiedocs.com", "abc"), "https://markiedocs.com/d/abc");
        assert_eq!(private_url("http://localhost:18787", "abc"), "http://localhost:18787/d/abc");
        assert_eq!(link_to_copy("https://api.markiedocs.com", "abc", "a.md", Some("https://markiedocs.com/s/t")), "https://markiedocs.com/s/t");
        assert_eq!(link_to_copy("https://api.markiedocs.com", "abc", "a.wd", Some("https://markiedocs.com/s/t")), "https://markiedocs.com/d/abc");
    }
}
