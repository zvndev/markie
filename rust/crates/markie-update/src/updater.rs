//! One update check, start to finish.

use crate::bundle::{self, BundleError, Expect, Tools};
use crate::gateway::{FeedAnswer, Gateway, GatewayError, sendable_token};
use crate::swap::{self, SwapError};
use crate::{NightlyVersion, archive};
use std::path::{Path, PathBuf};

/// How a check ended without an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// No Markie Cloud session: nothing was asked of the gateway.
    SignedOut,
    /// The gateway has nothing for this account.
    NotAvailable,
    /// The feed's version is the running one, or older.
    UpToDate { current: NightlyVersion },
    /// `version` was swapped in earlier in this run; a restart starts it.
    RestartPending { version: NightlyVersion },
    /// `version` was verified and is now the installed bundle.
    Installed { version: NightlyVersion, previous: Option<PathBuf> },
}

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error(transparent)]
    Gateway(#[from] GatewayError),
    #[error(transparent)]
    Archive(#[from] archive::ArchiveError),
    #[error(transparent)]
    Bundle(#[from] BundleError),
    #[error(transparent)]
    Swap(#[from] SwapError),
    #[error("the update could not be prepared: {0}")]
    Io(#[from] std::io::Error),
}

pub struct Updater<'a> {
    pub gateway: &'a Gateway,
    pub tools: &'a dyn Tools,
    /// The version of the running process.
    pub current: NightlyVersion,
    /// The bundle the running process was started from.
    pub target: PathBuf,
    /// A private folder of this app's: downloads are staged in `staging`
    /// under it, the replaced bundle kept in `previous`.
    pub work_dir: PathBuf,
}

/// The file whose presence stops automatic checks (docs/rust-port/NIGHTLY.md,
/// "Roll back"). A check the user asks for still runs.
pub fn paused_marker(work_dir: &Path) -> PathBuf {
    work_dir.join("paused")
}

impl Updater<'_> {
    /// `token`: the Markie Cloud bearer token, if signed in. `pending`: a
    /// version this process already installed and has not restarted into.
    pub fn run(&self, token: Option<&str>, pending: Option<NightlyVersion>) -> Result<Outcome, UpdateError> {
        let Some(token) = token.filter(|t| sendable_token(t)) else { return Ok(Outcome::SignedOut) };
        let feed = match self.gateway.feed(token)? {
            FeedAnswer::NotAvailable => return Ok(Outcome::NotAvailable),
            FeedAnswer::Feed(feed) => feed,
        };
        if let Some(version) = pending.filter(|p| feed.version <= *p) {
            return Ok(Outcome::RestartPending { version });
        }
        if feed.version <= self.current {
            return Ok(Outcome::UpToDate { current: self.current });
        }
        // Before the download: is there anywhere to put it?
        swap::installable(&self.target)?;

        let staging = self.work_dir.join("staging");
        match std::fs::remove_dir_all(&staging) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&staging)?;
        let result = self.stage_and_install(token, &feed, &staging);
        let _ = std::fs::remove_dir_all(&staging);
        let previous = result?;
        Ok(Outcome::Installed { version: feed.version, previous })
    }

    fn stage_and_install(&self, token: &str, feed: &crate::feed::Feed, staging: &Path) -> Result<Option<PathBuf>, UpdateError> {
        let zip = staging.join(&feed.artifact);
        self.gateway.download(token, feed, &zip)?;
        archive::inspect(&mut std::fs::File::open(&zip)?)?;
        let app = bundle::unpack(self.tools, &zip, &staging.join("unpacked"))?;
        let expect = Expect::nightly(&feed.version);
        bundle::verify(self.tools, &app, &expect)?;
        let recheck = |copy: &Path| bundle::verify(self.tools, copy, &expect).map_err(|e| e.to_string());
        let installed = swap::install(&app, &self.target, &self.work_dir.join("previous"), &recheck)?;
        Ok(installed.previous)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::bundle::tests::{FakeTools, VERSION, fixture};
    use crate::gateway::tests::{Mocked, TOKEN};
    use crate::{BUNDLE_NAME, LANE_PREFIX};
    use std::process::Command;

    const OLD: &str = "0.1.0-rs-nightly.6";

    struct Scene {
        dir: tempfile::TempDir,
        target: PathBuf,
        work_dir: PathBuf,
        mocked: Mocked,
    }

    fn marker(app: &Path) -> String {
        std::fs::read_to_string(app.join("Contents/Resources/marker.txt")).unwrap()
    }

    /// A ZIP of a fixture bundle, made the way the release script makes it.
    fn zipped(dir: &Path, bundle_id: &str, version: &str, marker: &str) -> Vec<u8> {
        let source = dir.join(format!("zip-source-{marker}"));
        std::fs::create_dir_all(&source).unwrap();
        let app = fixture(&source, bundle_id, version, marker);
        let zip = dir.join(format!("{marker}.zip"));
        let made = Command::new("/usr/bin/ditto").args(["-c", "-k", "--keepParent"]).arg(&app).arg(&zip).status().unwrap();
        assert!(made.success());
        std::fs::read(zip).unwrap()
    }

    fn scene() -> Scene {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        std::fs::create_dir_all(&apps).unwrap();
        let target = fixture(&apps, "com.zvn.markie.nightly", OLD, "old");
        let work_dir = dir.path().join("data/updates");
        Scene { dir, target, work_dir, mocked: Mocked::start() }
    }

    impl Scene {
        fn run(&self, tools: &FakeTools, token: Option<&str>, pending: Option<&str>) -> Result<Outcome, UpdateError> {
            let gateway = self.mocked.gateway();
            let updater = Updater { gateway: &gateway, tools, current: NightlyVersion::parse(OLD).unwrap(), target: self.target.clone(), work_dir: self.work_dir.clone() };
            updater.run(token, pending.map(|p| NightlyVersion::parse(p).unwrap()))
        }
        fn untouched(&self) {
            assert_eq!(marker(&self.target), "old", "the installed bundle must not change");
            assert!(!self.work_dir.join("staging").exists(), "nothing staged is left behind");
            assert!(!self.work_dir.join("previous").exists());
        }
    }

    #[test]
    fn a_newer_signed_nightly_is_downloaded_verified_and_swapped_in() {
        let s = scene();
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie.nightly", VERSION, "new"));
        let outcome = s.run(&FakeTools::good(), Some(TOKEN), None).unwrap();
        let previous = s.work_dir.join("previous").join(BUNDLE_NAME);
        assert_eq!(outcome, Outcome::Installed { version: NightlyVersion::parse(VERSION).unwrap(), previous: Some(previous.clone()) });
        assert_eq!(marker(&s.target), "new");
        assert_eq!(marker(&previous), "old");
        assert!(!s.work_dir.join("staging").exists());
        // Every request went to the lane, with the token, and nowhere else.
        let requests = s.mocked.requests();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert!(request.url.path().starts_with(LANE_PREFIX));
            assert_eq!(request.headers.get("authorization").unwrap(), &format!("Bearer {TOKEN}"));
        }
        // The same process checking again does not download it a second time.
        assert_eq!(s.run(&FakeTools::good(), Some(TOKEN), Some(VERSION)).unwrap(), Outcome::RestartPending { version: NightlyVersion::parse(VERSION).unwrap() });
        assert_eq!(s.mocked.requests().len(), 3);
    }

    #[test]
    fn signed_out_or_not_the_owner_is_quietly_no_update() {
        let s = scene();
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie.nightly", VERSION, "new"));
        assert_eq!(s.run(&FakeTools::good(), None, None).unwrap(), Outcome::SignedOut);
        assert_eq!(s.run(&FakeTools::good(), Some("not a sendable token"), None).unwrap(), Outcome::SignedOut);
        assert!(s.mocked.requests().is_empty(), "signed out asks the gateway nothing");
        // The mock, like the gateway, answers anyone but the owner 404.
        assert_eq!(s.run(&FakeTools::good(), Some("another-accounts-token"), None).unwrap(), Outcome::NotAvailable);
        assert_eq!(s.mocked.requests().len(), 1, "only the feed was asked for");
        s.untouched();
    }

    #[test]
    fn the_same_or_an_older_feed_changes_nothing() {
        for published in [OLD, "0.1.0-rs-nightly.5", "0.0.9-rs-nightly.99"] {
            let s = scene();
            s.mocked.publish(published, &zipped(s.dir.path(), "com.zvn.markie.nightly", published, "new"));
            assert_eq!(s.run(&FakeTools::good(), Some(TOKEN), None).unwrap(), Outcome::UpToDate { current: NightlyVersion::parse(OLD).unwrap() });
            assert_eq!(s.mocked.requests().len(), 1, "no download for {published}");
            s.untouched();
        }
    }

    #[test]
    fn a_bundle_that_fails_any_check_is_never_swapped_in() {
        let wrong: [(&str, fn(&mut FakeTools)); 4] = [
            ("signature", |t| t.sealed = false),
            ("team", |t| t.ours = false),
            ("gatekeeper", |t| t.gatekeeper = false),
            ("adhoc", |t| t.display = crate::bundle::tests::display("com.zvn.markie.nightly", "not set", "", "0x2(adhoc)")),
        ];
        for (name, change) in wrong {
            let s = scene();
            s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie.nightly", VERSION, "new"));
            let mut tools = FakeTools::good();
            change(&mut tools);
            assert!(matches!(s.run(&tools, Some(TOKEN), None), Err(UpdateError::Bundle(_))), "{name}");
            s.untouched();
        }
        // The wrong app, or a version other than the feed's, inside a ZIP whose hash is right.
        for (bundle_id, inner) in [("com.zvn.markie", VERSION), ("com.zvn.markie.rs", VERSION), ("com.zvn.markie.nightly", "0.1.0-rs-nightly.99")] {
            let s = scene();
            s.mocked.publish(VERSION, &zipped(s.dir.path(), bundle_id, inner, "new"));
            assert!(matches!(s.run(&FakeTools::good(), Some(TOKEN), None), Err(UpdateError::Bundle(_))), "{bundle_id} {inner}");
            s.untouched();
        }
    }

    #[test]
    fn the_real_macos_tools_refuse_an_unsigned_download() {
        let s = scene();
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie.nightly", VERSION, "new"));
        let gateway = s.mocked.gateway();
        let updater = Updater { gateway: &gateway, tools: &bundle::SystemTools, current: NightlyVersion::parse(OLD).unwrap(), target: s.target.clone(), work_dir: s.work_dir.clone() };
        assert!(matches!(updater.run(Some(TOKEN), None), Err(UpdateError::Bundle(BundleError::Signature))));
        s.untouched();
    }

    #[test]
    fn a_download_that_differs_from_the_feed_is_dropped_before_unpacking() {
        use crate::feed::tests::feed_text;
        use crate::FEED_NAME;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};
        let s = scene();
        let real = zipped(s.dir.path(), "com.zvn.markie.nightly", VERSION, "new");
        let mut served = real.clone();
        let middle = served.len() / 2;
        served[middle] ^= 0xff;
        s.mocked.mount(Mock::given(method("GET")).and(path(format!("{LANE_PREFIX}{FEED_NAME}"))).respond_with(ResponseTemplate::new(200).set_body_string(feed_text(VERSION, &real))));
        s.mocked.mount(Mock::given(method("GET")).and(path(format!("{LANE_PREFIX}Markie-Nightly-{VERSION}-arm64.zip"))).respond_with(ResponseTemplate::new(200).set_body_bytes(served)));
        let tools = FakeTools::good();
        assert!(matches!(s.run(&tools, Some(TOKEN), None), Err(UpdateError::Gateway(GatewayError::Integrity))));
        assert!(tools.calls.borrow().is_empty(), "nothing was unpacked or inspected");
        s.untouched();
    }

    #[test]
    fn an_archive_reaching_outside_the_bundle_is_refused_before_unpacking() {
        use crate::archive::tests::{file, zip};
        let s = scene();
        let evil = zip(&[file("Markie Nightly.app/Contents/Info.plist", b"x"), file("Markie Nightly.app/../../escaped.txt", b"x")]);
        s.mocked.publish(VERSION, &evil);
        let tools = FakeTools::good();
        assert!(matches!(s.run(&tools, Some(TOKEN), None), Err(UpdateError::Archive(archive::ArchiveError::Escape))));
        assert!(tools.calls.borrow().is_empty());
        assert!(!s.dir.path().join("data/escaped.txt").exists() && !s.dir.path().join("escaped.txt").exists());
        s.untouched();
    }

    #[test]
    fn a_copy_macos_is_running_from_a_temporary_place_is_not_updated() {
        let mut s = scene();
        let translocated = s.dir.path().join("AppTranslocation/ABCD/d");
        std::fs::create_dir_all(&translocated).unwrap();
        s.target = fixture(&translocated, "com.zvn.markie.nightly", OLD, "old");
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie.nightly", VERSION, "new"));
        assert!(matches!(s.run(&FakeTools::good(), Some(TOKEN), None), Err(UpdateError::Swap(SwapError::Translocated))));
        assert_eq!(s.mocked.requests().len(), 1, "refused before the download");
        s.untouched();
    }

    #[test]
    fn the_pause_marker_is_inside_the_work_folder() {
        assert_eq!(paused_marker(Path::new("/data/updates")), Path::new("/data/updates/paused"));
    }
}
