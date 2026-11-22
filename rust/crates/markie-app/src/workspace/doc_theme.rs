//! Owner-pinned document themes (page.tsx `enforcedTheme`,
//! `getDocTheme`): a member of a shared Markie Cloud document reads it in
//! the owner's pinned theme while it is open. The person's own store is
//! kept aside, never written, and painted again when another document opens.
//! While a pinned theme shows, theme changes are not kept (Electron locks
//! the theme then).

use gpui_kit::*;
use markie_cloud::collab::runtime;
use markie_cloud::sharing::ShareMember;
use markie_core::theme::{ThemePreset, ThemeStore, ThemeTokens};
use serde_json::Value;

use super::Workspace;

pub(super) const PINNED_ID: &str = "doc-pinned";

/// `getDocTheme`'s answer: `{ tokens }`, null when nothing is pinned.
pub(super) fn read_doc_theme(body: Option<Value>) -> Option<ThemeTokens> {
    let tokens = body?.get("tokens")?.clone();
    if tokens.is_null() {
        return None;
    }
    serde_json::from_value(tokens).ok()
}

/// Pinned themes live on Markie Cloud only, and apply to its members.
pub(super) fn pinned_applies(on_markie_cloud: bool, members: &[ShareMember], me: &str) -> bool {
    on_markie_cloud && members.iter().any(|m| m.user_id.as_deref() == Some(me))
}

/// The person's store with the pinned tokens as the active preset.
pub(super) fn pinned_store(own: &ThemeStore, tokens: ThemeTokens) -> ThemeStore {
    let mut store = own.clone();
    store.custom.retain(|p| p.id != PINNED_ID);
    store.custom.push(ThemePreset { id: PINNED_ID.into(), name: "Owner theme".into(), built_in: None, template_id: None, tone: None, tokens });
    store.active_id = PINNED_ID.into();
    store.overrides = None;
    store.typography = None;
    store
}

impl Workspace {
    /// After the server named the members (collab.rs `collab_resolved`).
    pub(super) fn check_doc_theme(&mut self, members: &[ShareMember], me: &str, cx: &mut Context<Self>) {
        let Some(doc) = &self.collab.cloud else { return };
        let on_cloud = markie_cloud::origin::is_cloud_origin(doc.account.client.origin());
        if !pinned_applies(on_cloud, members, me) {
            self.release_doc_theme(cx);
            return;
        }
        let client = doc.account.client.clone();
        let path = format!("/api/docs/{}/theme", markie_cloud::client::seg(&doc.doc_id));
        let doc_id = doc.doc_id.clone();
        let task = runtime::handle().spawn(async move { client.get(&path).await.ok().filter(|a| a.ok()).and_then(|a| a.json().ok()) });
        self._doc_theme = Some(cx.spawn(async move |this, cx| {
            let Ok(body) = task.await else { return };
            this.update(cx, |this, cx| {
                // Superseded: another document is open now.
                if this.collab.cloud.as_ref().map(|d| d.doc_id.as_str()) != Some(doc_id.as_str()) {
                    return;
                }
                match read_doc_theme(body) {
                    Some(tokens) => {
                        let own = this.own_theme.clone().unwrap_or_else(|| crate::themes::store(cx));
                        crate::themes::apply_store(pinned_store(&own, tokens), None, cx);
                        this.own_theme = Some(own);
                    }
                    None => this.release_doc_theme(cx),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Paint the person's own store again.
    pub(super) fn release_doc_theme(&mut self, cx: &mut Context<Self>) {
        self._doc_theme = None;
        if let Some(own) = self.own_theme.take() {
            crate::themes::apply_store(own, None, cx);
            cx.notify();
        }
    }

    /// `themeLocked`.
    pub(super) fn doc_theme_pinned(&self) -> bool {
        self.own_theme.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::{PINNED_ID, pinned_applies, pinned_store, read_doc_theme};
    use markie_cloud::docs::Role;
    use markie_cloud::sharing::ShareMember;
    use markie_core::theme::{ThemeStore, ThemeTokens};
    use serde_json::json;

    fn member(id: &str) -> ShareMember {
        serde_json::from_value(json!({ "user_id": id, "role": "editor", "email": "x@example.com" })).unwrap()
    }

    #[test]
    fn only_members_on_markie_cloud_read_the_pinned_theme() {
        let members = [member("me")];
        assert!(pinned_applies(true, &members, "me"));
        assert!(!pinned_applies(false, &members, "me"), "pinned themes live on Markie Cloud only");
        assert!(!pinned_applies(true, &members, "someone else"));
        let _ = Role::Editor;
    }

    #[test]
    fn the_answer_and_the_store_follow_get_doc_theme() {
        assert_eq!(read_doc_theme(None), None);
        assert_eq!(read_doc_theme(Some(json!({ "tokens": null }))), None);
        let tokens = ThemeTokens { background: "#101010".into(), ..Default::default() };
        let got = read_doc_theme(Some(json!({ "tokens": serde_json::to_value(&tokens).unwrap() }))).unwrap();
        assert_eq!(got.background, "#101010");
        let own = ThemeStore::default();
        let pinned = pinned_store(&own, got);
        assert_eq!(pinned.active_id, PINNED_ID);
        assert_eq!(pinned.find_theme(PINNED_ID).tokens.background, "#101010");
        assert_eq!(own.active_id, "markie-dark", "the person's own store is untouched");
    }
}
