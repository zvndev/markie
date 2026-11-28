//! Markie's updates on the Mac: when to check, and what to tell the user.
//!
//! Only the Mac app (`paths::MAC_APP`: the nightly or the public build)
//! running from its `.app` bundle with its real data folder updates itself.
//! The dev "Markie RS" build, a `cargo run`, a scratch data folder and a
//! local test server never do. What a check actually does is `markie-update`;
//! docs/rust-port/NIGHTLY.md and docs/rust-port/PUBLIC.md.
//!
//! The nightly asks the private gateway with the Markie Cloud sign-in. The
//! public app reads the public store's stable feed, or its early-access feed
//! when "Get new versions early" is on (`update-channel.json`, the file and
//! shape Electron Markie keeps), and never needs a sign-in.
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
use markie_update::{Lane, Outcome, UpdateError, Updater, Version};

actions!(markie_updates, [CheckForUpdates]);

/// After launch, once the window is up and the session is restored.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
/// "Every few hours."
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// What this run updates: the bundle it was started from, at the version it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub target: PathBuf,
    pub current: Version,
}

/// Which builds update themselves, and from which channel's feeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// The dev build: no updater.
    None,
    /// The private gateway, with the Markie Cloud sign-in.
    SuperNightly,
    /// The public store's stable feed, or its early-access feed.
    Public,
}

impl Channel {
    pub const fn of_this_build() -> Self {
        if paths::NIGHTLY {
            Channel::SuperNightly
        } else if paths::PUBLIC {
            Channel::Public
        } else {
            Channel::None
        }
    }

    /// The version shapes this build may report.
    fn accepts(self, version: &Version) -> bool {
        match self {
            Channel::None => false,
            Channel::SuperNightly => version.is_super_nightly(),
            Channel::Public => version.is_public(),
        }
    }

    /// The lane a check reads now.
    pub fn lane(self, early_access: bool) -> Option<&'static Lane> {
        match self {
            Channel::None => None,
            Channel::SuperNightly => Some(&markie_update::SUPER_NIGHTLY),
            Channel::Public => Some(markie_update::public_lane(early_access)),
        }
    }
}

/// Whether a run updates itself, and what. Pure, so every "no" is tested.
pub fn decide(channel: Channel, exe: Option<&Path>, scratch: bool, dev_server: bool, version: &str) -> Option<Plan> {
    if channel == Channel::None || scratch || dev_server {
        return None;
    }
    let current = Version::parse(version).filter(|v| channel.accepts(v))?;
    Some(Plan { target: markie_update::swap::bundle_of(exe?)?, current })
}

/// "Get new versions early": Electron Markie's `update-channel.json`, in this
/// app's data folder. `{ "beta": true }` opts in; anything else, a missing
/// file or a broken one included, is the stable feed, because "I can't tell"
/// must never move someone onto builds they did not ask for
/// (`electron/update-channel.js`).
pub mod early_access {
    use std::path::{Path, PathBuf};

    pub const FILE: &str = "update-channel.json";

    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(FILE)
    }

    /// Only a literal `true` is consent.
    pub fn parse(text: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("beta").and_then(|b| b.as_bool())) == Some(true)
    }

    pub fn read(data_dir: &Path) -> bool {
        std::fs::read_to_string(path(data_dir)).is_ok_and(|text| parse(&text))
    }

    /// Whether it stuck, so the switch never shows what is not saved.
    pub fn write(data_dir: &Path, on: bool) -> bool {
        let text = format!("{}\n", serde_json::json!({ "beta": on }));
        std::fs::create_dir_all(data_dir).is_ok() && markie_core::save::atomic_write(&path(data_dir), text.as_bytes()).is_ok()
    }
}

fn plan() -> Option<&'static Plan> {
    static PLAN: OnceLock<Option<Plan>> = OnceLock::new();
    PLAN.get_or_init(|| {
        decide(
            Channel::of_this_build(),
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
static PENDING: Mutex<Option<Version>> = Mutex::new(None);

/// The whole check, blocking: Keychain read, network, verification, swap.
fn check(plan: &Plan) -> Result<Outcome, UpdateError> {
    let channel = Channel::of_this_build();
    let Some(lane) = channel.lane(early_access::read(&paths::data_dir())) else {
        return Err(UpdateError::Io(std::io::Error::other("this build has no update channel")));
    };
    // The Markie Cloud session this app already holds, never a test server's,
    // and only for the lane that needs it: the public store is asked nothing
    // with a sign-in, and the Keychain is not even read for it.
    let token = if lane.token {
        let tokens = crate::workspace::account::shared_tokens();
        markie_cloud::tokens::session_for(&*tokens, markie_cloud::DEFAULT_SERVER).map(|session| session.token)
    } else {
        None
    };
    let Some(gateway) = Gateway::for_lane(lane, &format!("Markie/{}", paths::APP_VERSION)) else {
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
    use super::{Channel, Notice, Plan, decide, early_access, notice, relaunch_command};
    use markie_update::gateway::GatewayError;
    use markie_update::{Outcome, UpdateError, Version};
    use std::path::{Path, PathBuf};

    const EXE: &str = "/Applications/Markie.app/Contents/MacOS/Markie";
    /// The executable of the Rust Mac builds up to 0.10.0-super-nightly.8.
    const OLD_EXE: &str = "/Applications/Markie.app/Contents/MacOS/markie-rs";
    const V: &str = "0.1.0-super-nightly.7";

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn only_the_installed_nightly_updates_itself() {
        let nightly = Channel::SuperNightly;
        let plan = decide(nightly, Some(Path::new(EXE)), false, false, V).unwrap();
        assert_eq!(plan, Plan { target: PathBuf::from("/Applications/Markie.app"), current: version(V) });
        // A nightly still running as markie-rs updates the same bundle, and restarts it by its path.
        assert_eq!(decide(nightly, Some(Path::new(OLD_EXE)), false, false, V).unwrap(), plan);
        // The dev build, a scratch data folder, a test server, a bare binary
        // from `cargo run`, and a version that is not a nightly's.
        assert_eq!(decide(Channel::None, Some(Path::new(EXE)), false, false, V), None);
        assert_eq!(decide(nightly, Some(Path::new(EXE)), true, false, V), None);
        assert_eq!(decide(nightly, Some(Path::new(EXE)), false, true, V), None);
        assert_eq!(decide(nightly, Some(Path::new("/repo/rust/target/release/markie-rs")), false, false, V), None);
        assert_eq!(decide(nightly, None, false, false, V), None);
        assert_eq!(decide(nightly, Some(Path::new(EXE)), false, false, "0.1.0"), None);
    }

    #[test]
    fn the_installed_public_app_updates_itself_from_the_public_feeds() {
        let public = Channel::Public;
        for v in ["0.10.0", "0.10.0-rc.1", "0.10.1"] {
            assert_eq!(decide(public, Some(Path::new(EXE)), false, false, v).unwrap().current, version(v));
        }
        assert_eq!(decide(public, Some(Path::new(EXE)), false, false, V), None, "a super-nightly version is not this build's");
        assert_eq!(decide(public, Some(Path::new(EXE)), true, false, "0.10.0"), None);
        assert_eq!(decide(public, Some(Path::new("/repo/rust/target/release/markie-rs")), false, false, "0.10.0"), None);
        // Stable unless early access is on, and never the private gateway.
        assert_eq!(public.lane(false), Some(&markie_update::PUBLIC_STABLE));
        assert_eq!(public.lane(true), Some(&markie_update::PUBLIC_EARLY));
        assert_eq!(Channel::SuperNightly.lane(true), Some(&markie_update::SUPER_NIGHTLY), "the nightly has one feed");
        assert_eq!(Channel::None.lane(false), None);
        assert!(!public.lane(false).unwrap().token && Channel::SuperNightly.lane(false).unwrap().token);
    }

    #[test]
    fn this_build_has_the_channel_its_features_name() {
        let want = if markie_core::paths::NIGHTLY {
            Channel::SuperNightly
        } else if markie_core::paths::PUBLIC {
            Channel::Public
        } else {
            Channel::None
        };
        assert_eq!(Channel::of_this_build(), want);
    }

    #[test]
    fn early_access_is_on_only_when_the_file_says_exactly_true() {
        assert!(early_access::parse(r#"{"beta":true}"#));
        assert!(early_access::parse("{\n  \"beta\": true,\n  \"leftEarlyFrom\": \"0.9.0\"\n}\n"));
        for off in [r#"{"beta":false}"#, r#"{"beta":"true"}"#, r#"{"beta":1}"#, "{}", "true", "", "{not json", r#"{"Beta":true}"#] {
            assert!(!early_access::parse(off), "{off:?}");
        }
        let dir = tempfile::tempdir().unwrap();
        assert!(!early_access::read(dir.path()), "no file is stable");
        assert!(early_access::write(dir.path(), true));
        assert!(early_access::read(dir.path()));
        assert_eq!(std::fs::read_to_string(early_access::path(dir.path())).unwrap(), "{\"beta\":true}\n");
        assert!(early_access::write(dir.path(), false));
        assert!(!early_access::read(dir.path()));
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
        assert!(matches!(say(Ok(Outcome::UpToDate { current: version(V) })), Notice::Info { message, detail } if message.ends_with("is up to date.") && detail.as_deref() == Some("Version 0.1.0-super-nightly.7")));
        assert_eq!(say(Ok(Outcome::RestartPending { version: version(V) })), Notice::Ready { version: V.into() });
        assert_eq!(say(Ok(Outcome::Installed { version: version(V), previous: None })), Notice::Ready { version: V.into() });
        assert!(matches!(say(Err(UpdateError::Gateway(GatewayError::Offline))), Notice::Problem { detail, .. } if detail.contains("could not be reached")));
    }

    #[test]
    fn the_relaunch_helper_takes_the_pid_and_path_as_arguments() {
        let app = Path::new("/Applications/Markie.app; rm -rf ~ \"$(reboot)\"");
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
