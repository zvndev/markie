//! A scripted run of the sign-in and sync steps, for proving the Cloud
//! integration end to end when nobody can click the window (an agent whose
//! session may not capture or send input to it).
//!
//! `MARKIE_RS_TEST_DRIVE=<file.json>` names the steps. It is honoured only
//! with a scratch data folder (`MARKIE_RS_DATA_DIR`) and a test server on this
//! computer (`MARKIE_RS_CLOUD_SERVER`), so it can never act on Kirby's real
//! account or a real server. Every step calls the code a click would:
//!
//! - `{"signIn": {"email": "...", "serverLog": "<server log>"}}`: the sign-in
//!   sheet's email-code route (`send_code`, then `verify_code` with the code
//!   the console-mail server wrote to its log), landing in the AccountStore.
//! - `{"syncOn": true}`: the sync opt-in sheet's "Turn on sync" for the open
//!   document (`cloud_text` with `TextAction::Enable`).
//! - `{"syncOff": "pause"}` or `{"syncOff": "delete"}`: Stop syncing.
//! - `{"waitFor": "<path>"}`: wait until that file exists (a step outside
//!   the app, such as sharing from another session, is done).
//! - `{"delayMs": 500}`.
//!
//! Each step logs one line to stderr. Nothing logs a token or a code.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui_kit::*;
use markie_cloud::sync::SyncState;
use serde::Deserialize;

use super::Workspace;
use super::account::{AccountStore, server_config};
use super::cloud::TextAction;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
enum Step {
    SignIn { email: String, #[serde(rename = "serverLog")] server_log: PathBuf },
    SyncOn(#[allow(dead_code)] bool),
    SyncOff(String),
    WaitFor(PathBuf),
    DelayMs(u64),
}

#[derive(Deserialize)]
struct Script {
    steps: Vec<Step>,
}

const STEP_TIMEOUT: Duration = Duration::from_secs(90);

fn log(what: impl AsRef<str>) {
    eprintln!("markie-rs drive: {}", what.as_ref());
}

/// The script, when this run may follow one.
fn script() -> Option<Vec<Step>> {
    let file = std::env::var_os("MARKIE_RS_TEST_DRIVE")?;
    if std::env::var_os("MARKIE_RS_DATA_DIR").is_none() || !server_config().dev {
        log("ignored: only with a scratch data folder and a test server on this computer");
        return None;
    }
    match std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Script>(&t).ok()) {
        Some(s) => Some(s.steps),
        None => {
            log("ignored: not a drive script");
            None
        }
    }
}

impl Workspace {
    /// Start the script, if there is one, once the window exists.
    pub(super) fn start_test_drive(&mut self, cx: &mut Context<Self>) {
        let Some(steps) = script() else { return };
        cx.spawn(async move |this, cx| {
            for step in steps {
                log(format!("step {}", describe(&step)));
                let started = Instant::now();
                // Kick the step off.
                let kicked = this.update(cx, |w, cx| w.drive_kick(&step, cx));
                if !matches!(kicked, Ok(true)) {
                    log("stopped: the step could not start");
                    return;
                }
                // Then wait until it is done.
                loop {
                    cx.background_executor().timer(Duration::from_millis(250)).await;
                    let done = this.update(cx, |w, cx| w.drive_done(&step, started, cx));
                    match done {
                        Ok(Some(true)) => break,
                        Ok(Some(false)) => {}
                        _ => {
                            log("stopped");
                            return;
                        }
                    }
                    if started.elapsed() > STEP_TIMEOUT {
                        log("stopped: the step timed out");
                        return;
                    }
                }
                log(format!("done {}", describe(&step)));
            }
            log("script finished");
        })
        .detach();
    }

    fn drive_kick(&mut self, step: &Step, cx: &mut Context<Self>) -> bool {
        let open = self.doc.as_ref().map(|d| d.path.clone());
        match step {
            Step::SignIn { email, server_log } => {
                let Some(store) = AccountStore::global(cx) else { return false };
                store.update(cx, |s, cx| s.sign_in_with_logged_code(email.clone(), server_log.clone(), cx));
                true
            }
            Step::SyncOn(_) => {
                let Some(path) = open else { return false };
                self.cloud_text(path, TextAction::Enable, None, cx);
                true
            }
            Step::SyncOff(how) => {
                let Some(path) = open else { return false };
                let action = if how == "delete" { TextAction::Delete } else { TextAction::Pause };
                self.cloud_text(path, action, None, cx);
                true
            }
            Step::WaitFor(_) | Step::DelayMs(_) => true,
        }
    }

    /// Some(true) when the step is done, Some(false) while it runs, None when
    /// it failed.
    fn drive_done(&mut self, step: &Step, started: Instant, cx: &mut Context<Self>) -> Option<bool> {
        let open = self.doc.as_ref().map(|d| d.path.clone());
        match step {
            Step::SignIn { .. } => {
                let signed_in = AccountStore::global(cx).is_some_and(|s| s.read(cx).user().is_some());
                Some(signed_in && self.cloud.selected_scope().is_some())
            }
            Step::SyncOn(_) | Step::SyncOff(_) => {
                let path = open?;
                if self.cloud.busy.contains(&path) {
                    return Some(false);
                }
                if let Some(notice) = self.cloud.notice.clone() {
                    log(format!("notice: {notice}"));
                    return None;
                }
                let state = self.cloud.bindings.get(&path).map(|b| b.record.state);
                let want = match step {
                    Step::SyncOn(_) => SyncState::Synced,
                    Step::SyncOff(how) if how == "delete" => SyncState::LocalOnly,
                    _ => SyncState::Paused,
                };
                Some(state == Some(want))
            }
            Step::WaitFor(path) => Some(path.exists()),
            Step::DelayMs(ms) => Some(started.elapsed() >= Duration::from_millis(*ms)),
        }
    }
}

fn describe(step: &Step) -> String {
    match step {
        Step::SignIn { .. } => "sign in with an emailed code".into(),
        Step::SyncOn(_) => "turn sync on for the open document".into(),
        Step::SyncOff(how) => format!("stop syncing ({how})"),
        Step::WaitFor(p) => format!("wait for {}", p.display()),
        Step::DelayMs(ms) => format!("wait {ms} ms"),
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: that brings in GPUI's own `test` macro.
    use super::{Script, Step};

    #[test]
    fn scripts_parse_every_step() {
        let s: Script = serde_json::from_str(
            r#"{"steps":[{"signIn":{"email":"success@simulator.amazonses.com","serverLog":"/tmp/x.log"}},{"syncOn":true},{"waitFor":"/tmp/go"},{"syncOff":"pause"},{"delayMs":5}]}"#,
        )
        .unwrap();
        assert_eq!(s.steps.len(), 5);
        assert!(matches!(&s.steps[3], Step::SyncOff(h) if h == "pause"));
    }
}
