//! Markie Nightly's updates: when to check, and what to tell the user.
//!
//! Only the nightly build (`paths::NIGHTLY`) running from its `.app` bundle
//! with its real data folder updates itself. The dev "Markie RS" build, a
//! `cargo run`, a scratch data folder and a local test server never do. What a
//! check actually does is `markie-update`; docs/rust-port/NIGHTLY.md.
//!
//! Checks run on their own thread, at launch and every few hours, and from
//! App › Check for Updates…. An automatic check is silent unless it installed
//! something: signed out, not the owner, offline and every refused download
//! say nothing. A check the user asked for always answers.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use gpui_kit::*;
use markie_core::paths;
use markie_update::bundle::SystemTools;
use markie_update::gateway::Gateway;
use markie_update::{NightlyVersion, Outcome, UpdateError, Updater};

actions!(markie_updates, [CheckForUpdates]);

/// After launch, once the window is up and the session is restored.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
/// "Every few hours."
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// What this run updates: the bundle it was started from, at the version it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub target: PathBuf,
    pub current: NightlyVersion,
}

/// Whether a run updates itself, and what. Pure, so every "no" is tested.
pub fn decide(nightly: bool, exe: Option<&Path>, scratch: bool, dev_server: bool, version: &str) -> Option<Plan> {
    if !nightly || scratch || dev_server {
        return None;
    }
    Some(Plan { target: markie_update::swap::bundle_of(exe?)?, current: NightlyVersion::parse(version)? })
}

fn plan() -> Option<&'static Plan> {
    static PLAN: OnceLock<Option<Plan>> = OnceLock::new();
    PLAN.get_or_init(|| {
        decide(
            paths::NIGHTLY,
            std::env::current_exe().ok().as_deref(),
            std::env::var_os("MARKIE_RS_DATA_DIR").is_some(),
            crate::workspace::account::server_config().dev,
            paths::APP_VERSION,
        )
    })
    .as_ref()
}

/// Whether this run has an updater at all: the menu item exists only then.
pub fn active() -> bool {
    plan().is_some()
}

fn work_dir() -> PathBuf {
    paths::data_dir().join("updates")
}

/// One check at a time, whoever asked.
static CHECKING: AtomicBool = AtomicBool::new(false);
/// The version this run already swapped in and has not restarted into.
static PENDING: Mutex<Option<NightlyVersion>> = Mutex::new(None);

/// The whole check, blocking: Keychain read, network, verification, swap.
fn check(plan: &Plan) -> Result<Outcome, UpdateError> {
    // The Markie Cloud session this app already holds; never a test server's.
    let tokens = crate::workspace::account::shared_tokens();
    let token = markie_cloud::tokens::session_for(&*tokens, markie_cloud::DEFAULT_SERVER).map(|session| session.token);
    let Some(gateway) = Gateway::production(&format!("MarkieNightly/{}", paths::APP_VERSION)) else {
        return Err(UpdateError::Io(std::io::Error::other("no HTTPS client")));
    };
    let pending = *PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let updater = Updater { gateway: &gateway, tools: &SystemTools, current: plan.current, target: plan.target.clone(), work_dir: work_dir() };
    let outcome = updater.run(token.as_deref(), pending)?;
    if let Outcome::Installed { version, .. } = &outcome {
        *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(*version);
    }
    Ok(outcome)
}

/// Run one check off the main thread. None when one is already running.
async fn check_in_background(plan: &'static Plan) -> Option<Result<Outcome, UpdateError>> {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return None;
    }
    let (tx, rx) = futures::channel::oneshot::channel();
    let spawned = std::thread::Builder::new().name("markie-update".into()).spawn(move || {
        let _ = tx.send(check(plan));
    });
    let result = match spawned {
        Ok(_) => rx.await.ok(),
        Err(_) => None,
    };
    CHECKING.store(false, Ordering::SeqCst);
    result
}

/// What to say after a check. `asked`: the user chose Check for Updates….
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Nothing,
    Info { message: String, detail: Option<String> },
    Problem { message: String, detail: String },
    /// A new version is in place: offer Restart.
    Ready { version: String },
}

pub fn notice(result: &Result<Outcome, UpdateError>, asked: bool) -> Notice {
    let app = paths::APP_NAME;
    match result {
        // The one thing an automatic check announces.
        Ok(Outcome::Installed { version, .. }) => Notice::Ready { version: version.to_string() },
        _ if !asked => Notice::Nothing,
        Ok(Outcome::RestartPending { version }) => Notice::Ready { version: version.to_string() },
        Ok(Outcome::SignedOut) => Notice::Info {
            message: "Sign in to Markie Cloud to check for updates.".into(),
            detail: Some(format!("{app} gets its updates through your Markie Cloud account.")),
        },
        Ok(Outcome::NotAvailable) => Notice::Info { message: "No update is available.".into(), detail: None },
        Ok(Outcome::UpToDate { current }) => Notice::Info { message: format!("{app} is up to date."), detail: Some(format!("Version {current}")) },
        Err(error) => Notice::Problem { message: "Couldn't check for updates.".into(), detail: error.to_string() },
    }
}

fn show(notice: Notice, window: &mut Window, cx: &mut App) {
    match notice {
        Notice::Nothing => {}
        Notice::Info { message, detail } => {
            let _ = window.prompt(PromptLevel::Info, &message, detail.as_deref(), &["OK"], cx);
        }
        Notice::Problem { message, detail } => {
            let _ = window.prompt(PromptLevel::Warning, &message, Some(&detail), &["OK"], cx);
        }
        Notice::Ready { version } => {
            let answer = window.prompt(
                PromptLevel::Info,
                &format!("{} {version} is ready.", paths::APP_NAME),
                Some("Restart to start using it. The version you are running now is kept, in case you need to go back."),
                &["Restart Now", "Later"],
                cx,
            );
            cx.spawn(async move |cx| {
                if answer.await == Ok(0) {
                    let _ = cx.update(restart);
                }
            })
            .detach();
        }
    }
}

/// App › Check for Updates…
pub fn check_now(window: AnyWindowHandle, cx: &mut App) {
    let Some(plan) = plan() else { return };
    cx.spawn(async move |cx| {
        let Some(result) = check_in_background(plan).await else { return };
        if let Err(error) = &result {
            eprintln!("markie-rs: update check failed: {error}");
        }
        let notice = notice(&result, true);
        let _ = window.update(cx, |_, window, cx| show(notice, window, cx));
    })
    .detach();
}

/// The launch check and the one every few hours. Does nothing in a build
/// that does not update itself.
pub fn start(window: AnyWindowHandle, cx: &mut App) {
    let Some(plan) = plan() else { return };
    cx.on_action(move |_: &CheckForUpdates, cx| check_now(window, cx));
    cx.spawn(async move |cx| {
        cx.background_executor().timer(FIRST_CHECK_AFTER).await;
        loop {
            // A roll back in progress: the file stops automatic checks only.
            if !markie_update::updater::paused_marker(&work_dir()).exists()
                && let Some(result) = check_in_background(plan).await
            {
                if let Err(error) = &result {
                    eprintln!("markie-rs: update check failed: {error}");
                }
                let notice = notice(&result, false);
                let _ = window.update(cx, |_, window, cx| show(notice, window, cx));
            }
            cx.background_executor().timer(CHECK_EVERY).await;
        }
    })
    .detach();
}

/// Waits for this process to exit, then opens the bundle again. The pid and
/// the path are arguments, never part of the script text.
fn relaunch_command(pid: u32, app: &Path) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(r#"while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.2; done; exec /usr/bin/open "$2""#)
        .arg("markie-relaunch")
        .arg(pid.to_string())
        .arg(app)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Its own process group, so quitting the app does not take it along.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command
}

/// Quit the way Quit does, and come back as the bundle now in place.
pub fn restart(cx: &mut App) {
    if let Some(plan) = plan() {
        let _ = relaunch_command(std::process::id(), &plan.target).spawn();
    }
    crate::instance::release(&paths::data_dir());
    cx.quit();
}

#[cfg(test)]
mod tests {
    use super::{Notice, Plan, decide, notice, relaunch_command};
    use markie_update::gateway::GatewayError;
    use markie_update::{NightlyVersion, Outcome, UpdateError};
    use std::path::{Path, PathBuf};

    const EXE: &str = "/Applications/Markie Nightly.app/Contents/MacOS/markie-rs";
    const V: &str = "0.1.0-rs-nightly.7";

    fn version(text: &str) -> NightlyVersion {
        NightlyVersion::parse(text).unwrap()
    }

    #[test]
    fn only_the_installed_nightly_updates_itself() {
        let plan = decide(true, Some(Path::new(EXE)), false, false, V).unwrap();
        assert_eq!(plan, Plan { target: PathBuf::from("/Applications/Markie Nightly.app"), current: version(V) });
        // The dev build, a scratch data folder, a test server, a bare binary
        // from `cargo run`, and a version that is not a nightly's.
        assert_eq!(decide(false, Some(Path::new(EXE)), false, false, V), None);
        assert_eq!(decide(true, Some(Path::new(EXE)), true, false, V), None);
        assert_eq!(decide(true, Some(Path::new(EXE)), false, true, V), None);
        assert_eq!(decide(true, Some(Path::new("/repo/rust/target/release/markie-rs")), false, false, V), None);
        assert_eq!(decide(true, None, false, false, V), None);
        assert_eq!(decide(true, Some(Path::new(EXE)), false, false, "0.1.0"), None);
    }

    #[test]
    fn this_test_run_has_no_updater() {
        assert!(!super::active(), "a test binary is not an installed nightly");
    }

    #[test]
    fn an_automatic_check_speaks_only_when_it_installed_something() {
        let quiet: Vec<Result<Outcome, UpdateError>> = vec![
            Ok(Outcome::SignedOut),
            Ok(Outcome::NotAvailable),
            Ok(Outcome::UpToDate { current: version(V) }),
            Ok(Outcome::RestartPending { version: version(V) }),
            Err(UpdateError::Gateway(GatewayError::Offline)),
            Err(UpdateError::Gateway(GatewayError::Integrity)),
            Err(UpdateError::Gateway(GatewayError::Status(500))),
        ];
        for result in &quiet {
            assert_eq!(notice(result, false), Notice::Nothing, "{result:?}");
        }
        let installed = Ok(Outcome::Installed { version: version(V), previous: None });
        assert_eq!(notice(&installed, false), Notice::Ready { version: V.into() });
    }

    #[test]
    fn a_check_the_user_asked_for_always_answers() {
        let say = |result: Result<Outcome, UpdateError>| notice(&result, true);
        assert!(matches!(say(Ok(Outcome::SignedOut)), Notice::Info { message, .. } if message.contains("Sign in to Markie Cloud")));
        assert_eq!(say(Ok(Outcome::NotAvailable)), Notice::Info { message: "No update is available.".into(), detail: None });
        assert!(matches!(say(Ok(Outcome::UpToDate { current: version(V) })), Notice::Info { message, detail } if message.ends_with("is up to date.") && detail.as_deref() == Some("Version 0.1.0-rs-nightly.7")));
        assert_eq!(say(Ok(Outcome::RestartPending { version: version(V) })), Notice::Ready { version: V.into() });
        assert_eq!(say(Ok(Outcome::Installed { version: version(V), previous: None })), Notice::Ready { version: V.into() });
        assert!(matches!(say(Err(UpdateError::Gateway(GatewayError::Offline))), Notice::Problem { detail, .. } if detail.contains("could not be reached")));
    }

    #[test]
    fn the_relaunch_helper_takes_the_pid_and_path_as_arguments() {
        let app = Path::new("/Applications/Markie Nightly.app; rm -rf ~ \"$(reboot)\"");
        let command = relaunch_command(4242, app);
        let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(command.get_program(), "/bin/sh");
        assert_eq!(args.len(), 5);
        assert_eq!(args[0], "-c");
        assert!(!args[1].contains("Markie") && !args[1].contains("4242"), "the script text holds no data: {}", args[1]);
        assert!(args[1].contains("/usr/bin/open \"$2\"") && args[1].contains("/bin/kill -0 \"$1\""));
        assert_eq!(&args[3..], ["4242", app.to_str().unwrap()]);
    }
}
