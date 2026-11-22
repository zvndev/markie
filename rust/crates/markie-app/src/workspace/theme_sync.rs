//! The cloud half of theming (`src/lib/theme-sync.ts`): the preset store
//! follows the account across devices. At sign-in the account's store is
//! pulled (`pullCloudThemes`); when the account has none yet, this
//! computer's is pushed. Every theme change is pushed (`pushCloudThemes`),
//! fire and forget, and does nothing when signed out.

use gpui_kit::*;
use markie_core::theme::ThemeStore;
use serde_json::{Value, json};

use super::Workspace;
use super::account::{AccountStore, run_bg};

pub(super) const THEMES_PATH: &str = "/api/me/themes";

/// What `GET /api/me/themes` said.
#[derive(Debug, PartialEq)]
pub(super) enum Pulled {
    /// The account has a store: keep it.
    Store(ThemeStore),
    /// Signed in with nothing stored yet: push ours.
    Empty,
    /// Signed out or unreachable: leave everything as it is.
    Unreachable,
}

pub(super) fn read_pull(body: Option<Value>) -> Pulled {
    let Some(body) = body else { return Pulled::Unreachable };
    match body.get("store") {
        Some(Value::Null) | None => Pulled::Empty,
        Some(store) => match serde_json::from_value::<ThemeStore>(store.clone()) {
            Ok(store) => Pulled::Store(store.normalized()),
            // Electron saves whatever came; a store it cannot read loads as
            // the default there, so it is the default here too.
            Err(_) => Pulled::Store(ThemeStore::default()),
        },
    }
}

/// The body `pushCloudThemes` sends.
pub(super) fn push_body(store: &ThemeStore) -> Value {
    json!({ "store": serde_json::to_value(store).unwrap_or(Value::Null) })
}

/// `pushCloudThemes`: send the store on screen to the account.
pub(super) fn push_cloud_themes(cx: &App) {
    let Some(account) = AccountStore::global(cx) else { return };
    let account = account.read(cx);
    if account.user().is_none() {
        return;
    }
    let Some((rt, client)) = account.backend() else { return };
    let body = push_body(&crate::themes::store(cx));
    rt.spawn(async move {
        let _ = client.put(THEMES_PATH, body).await;
    });
}

impl Workspace {
    /// `pullCloudThemes` once the account is known.
    pub(super) fn pull_cloud_themes(&mut self, cx: &mut Context<Self>) {
        let Some(account) = AccountStore::global(cx) else { return };
        let account = account.read(cx);
        let Some(user) = account.user().map(|u| u.id.clone()) else { return };
        let Some((rt, client)) = account.backend() else { return };
        run_bg(
            &rt,
            cx,
            async move { client.get(THEMES_PATH).await.ok().filter(|a| a.ok()).and_then(|a| a.json().ok()) },
            move |this: &mut Self, body, cx| {
                // A sign-out or another account while it ran: not theirs.
                if super::account::signed_in_user(cx).map(|u| u.id) != Some(user) {
                    return;
                }
                match read_pull(body) {
                    Pulled::Store(store) => {
                        crate::themes::apply_store(store, None, cx);
                        this.shell.template = crate::themes::store(cx).active_template().id.clone();
                        this.save_theme_store(cx);
                        cx.notify();
                    }
                    Pulled::Empty => push_cloud_themes(cx),
                    Pulled::Unreachable => {}
                }
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{Pulled, ThemeStore, push_body, read_pull};
    use serde_json::json;

    #[test]
    fn a_pull_keeps_the_accounts_store_or_asks_for_ours() {
        assert_eq!(read_pull(None), Pulled::Unreachable);
        assert_eq!(read_pull(Some(json!({ "store": null }))), Pulled::Empty);
        assert_eq!(read_pull(Some(json!({}))), Pulled::Empty);
        let store = ThemeStore::default().choose_template("paper", markie_core::theme::Tone::Light);
        let Pulled::Store(got) = read_pull(Some(json!({ "store": serde_json::to_value(&store).unwrap() }))) else { panic!() };
        assert_eq!(got.active_template().id, "paper");
    }

    #[test]
    fn the_push_wraps_the_store_like_theme_sync() {
        let store = ThemeStore::default();
        let body = push_body(&store);
        assert_eq!(body["store"]["activeId"], "markie-dark");
        assert_eq!(serde_json::from_value::<ThemeStore>(body["store"].clone()).unwrap(), store);
    }
}
