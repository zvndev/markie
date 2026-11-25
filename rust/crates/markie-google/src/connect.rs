//! One "Import from Google Docs…": connect (or reconnect) and pick, in one
//! trip to the system browser. Google's desktop Picker always runs inside
//! the OAuth flow, so every pick is a fresh consent with `trigger_onepick`.
use crate::api::GoogleApi;
use crate::config::ClientConfig;
use crate::error::{GoogleError, Result};
use crate::oauth::{self, PickFlow};
use crate::tokens::Grant;
use markie_vault::device::SecretStore;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picked {
    pub file_ids: Vec<String>,
    /// The account's email, when Google tells a `drive.file` grant.
    pub email: Option<String>,
}

/// Open the Picker with `open` (the system browser in the app), wait for the
/// redirect, exchange the code and keep the grant.
pub fn connect_and_pick<S: SecretStore>(
    cfg: &ClientConfig,
    grant: &Grant<S>,
    login_hint: Option<&str>,
    open: &dyn Fn(&str),
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Picked> {
    let flow = PickFlow::start()?;
    open(&flow.authorize_url(cfg, login_hint));
    let redirect = flow.wait(timeout, cancel)?;
    let http = oauth::http_client();
    let tokens = oauth::exchange_code(&http, cfg, &flow, &redirect.code)?;
    // Google may grant less than asked. Without drive.file nothing below works.
    if tokens.scope.as_deref().is_some_and(|s| !s.split(' ').any(|s| s == crate::DRIVE_FILE_SCOPE)) {
        return Err(GoogleError::Cancelled);
    }
    grant.accept(&tokens)?;
    let email = GoogleApi::new(cfg, grant).account_email().ok().flatten();
    Ok(Picked { file_ids: redirect.picked_file_ids, email })
}
