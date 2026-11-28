//! One update check, start to finish.

use crate::bundle::{self, BundleError, Expect, Tools};
use crate::gateway::{FeedAnswer, Gateway, GatewayError, sendable_token};
use crate::swap::{self, SwapError};
use crate::{Version, archive};
use std::path::{Path, PathBuf};

/// How a check ended without an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// No Markie Cloud session on a lane that needs one: nothing was asked
    /// of the gateway. Never the answer on the public lanes.
    SignedOut,
    /// The gateway has nothing for this account.
    NotAvailable,
    /// The feed's version is the running one, or older.
    UpToDate { current: Version },
    /// `version` was swapped in earlier in this run; a restart starts it.
    RestartPending { version: Version },
    /// `version` was verified and is now the installed bundle.
    Installed { version: Version, previous: Option<PathBuf> },
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
    pub current: Version,
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
    /// `token`: the Markie Cloud bearer token, if signed in; only a lane that
    /// takes one ever sees it. `pending`: a version this process already
    /// installed and has not restarted into.
    pub fn run(&self, token: Option<&str>, pending: Option<Version>) -> Result<Outcome, UpdateError> {
        let token = if self.gateway.lane().token {
            let Some(token) = token.filter(|t| sendable_token(t)) else { return Ok(Outcome::SignedOut) };
            Some(token)
        } else {
            None
        };
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

    fn stage_and_install(&self, token: Option<&str>, feed: &crate::feed::Feed, staging: &Path) -> Result<Option<PathBuf>, UpdateError> {
        let zip = staging.join(&feed.artifact);
        self.gateway.download(token, feed, &zip)?;
        archive::inspect(&mut std::fs::File::open(&zip)?)?;
        let app = bundle::unpack(self.tools, &zip, &staging.join("unpacked"))?;
        let expect = Expect::markie(&feed.version);
        bundle::verify(self.tools, &app, &expect)?;
        let recheck = |copy: &Path| bundle::verify(self.tools, copy, &expect).map_err(|e| e.to_string());
        let installed = swap::install(&app, &self.target, &self.work_dir.join("previous"), &recheck)?;
        Ok(installed.previous)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::bundle::tests::{FakeTools, VERSION, fixture, fixture_with};
    use crate::gateway::tests::{Mocked, TOKEN};
    use crate::{BUNDLE_NAME, LANE_PREFIX};
    use std::process::Command;

    const OLD: &str = "0.1.0-super-nightly.6";

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
        let target = fixture(&apps, "com.zvn.markie", OLD, "old");
        let work_dir = dir.path().join("data/updates");
        Scene { dir, target, work_dir, mocked: Mocked::start() }
    }

    impl Scene {
        fn run(&self, tools: &FakeTools, token: Option<&str>, pending: Option<&str>) -> Result<Outcome, UpdateError> {
            let gateway = self.mocked.gateway();
            let updater = Updater { gateway: &gateway, tools, current: Version::parse(OLD).unwrap(), target: self.target.clone(), work_dir: self.work_dir.clone() };
            updater.run(token, pending.map(|p| Version::parse(p).unwrap()))
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
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie", VERSION, "new"));
        let outcome = s.run(&FakeTools::good(), Some(TOKEN), None).unwrap();
        let previous = s.work_dir.join("previous").join(BUNDLE_NAME);
        assert_eq!(outcome, Outcome::Installed { version: Version::parse(VERSION).unwrap(), previous: Some(previous.clone()) });
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
        assert_eq!(s.run(&FakeTools::good(), Some(TOKEN), Some(VERSION)).unwrap(), Outcome::RestartPending { version: Version::parse(VERSION).unwrap() });
        assert_eq!(s.mocked.requests().len(), 3);
    }

    /// Kirby's Mac: 0.10.0-super-nightly.8 at /Applications/Markie.app, its
    /// executable `markie-rs`. The next nightly's is `Markie`. The check
    /// downloads, verifies and swaps it in under the same bundle path, and the
    /// restart (which opens that path) starts the new executable.
    #[test]
    fn a_nightly_whose_executable_is_markie_rs_updates_into_one_named_markie() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        std::fs::create_dir_all(&apps).unwrap();
        let target = fixture_with(&apps, "com.zvn.markie", OLD, "old", "markie-rs");
        let s = Scene { target, work_dir: dir.path().join("data/updates"), mocked: Mocked::start(), dir };
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie", VERSION, "new"));
        let outcome = s.run(&FakeTools::good(), Some(TOKEN), None).unwrap();
        assert!(matches!(outcome, Outcome::Installed { .. }), "{outcome:?}");
        assert_eq!(s.target, apps.join("Markie.app"));
        assert!(s.target.join("Contents/MacOS/Markie").is_file());
        assert!(!s.target.join("Contents/MacOS/markie-rs").exists());
        assert_eq!(marker(&s.target), "new");
        let names: Vec<_> = std::fs::read_dir(&apps).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, [std::ffi::OsString::from("Markie.app")]);
        assert!(s.work_dir.join("previous").join(BUNDLE_NAME).join("Contents/MacOS/markie-rs").is_file(), "the old bundle is kept for a roll back");
        assert_eq!(crate::swap::bundle_of(&s.target.join("Contents/MacOS/Markie")), Some(s.target.clone()));
    }

    #[test]
    fn a_bundle_named_for_another_executable_is_never_swapped_in() {
        let s = scene();
        let source = s.dir.path().join("zip-source-wrong");
        std::fs::create_dir_all(&source).unwrap();
        let app = fixture_with(&source, "com.zvn.markie", VERSION, "new", "markie-rs");
        let zip = s.dir.path().join("wrong.zip");
        assert!(Command::new("/usr/bin/ditto").args(["-c", "-k", "--keepParent"]).arg(&app).arg(&zip).status().unwrap().success());
        s.mocked.publish(VERSION, &std::fs::read(zip).unwrap());
        assert!(matches!(s.run(&FakeTools::good(), Some(TOKEN), None), Err(UpdateError::Bundle(BundleError::Executable { .. }))));
        s.untouched();
    }

    #[test]
    fn signed_out_or_not_the_owner_is_quietly_no_update() {
        let s = scene();
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie", VERSION, "new"));
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
        for published in [OLD, "0.1.0-super-nightly.5", "0.0.9-super-nightly.99"] {
            let s = scene();
            s.mocked.publish(published, &zipped(s.dir.path(), "com.zvn.markie", published, "new"));
            assert_eq!(s.run(&FakeTools::good(), Some(TOKEN), None).unwrap(), Outcome::UpToDate { current: Version::parse(OLD).unwrap() });
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
            ("adhoc", |t| t.display = crate::bundle::tests::display("com.zvn.markie", "not set", "", "0x2(adhoc)")),
        ];
        for (name, change) in wrong {
            let s = scene();
            s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie", VERSION, "new"));
            let mut tools = FakeTools::good();
            change(&mut tools);
            assert!(matches!(s.run(&tools, Some(TOKEN), None), Err(UpdateError::Bundle(_))), "{name}");
            s.untouched();
        }
        // The wrong app, or a version other than the feed's, inside a ZIP whose hash is right.
        for (bundle_id, inner) in [("com.zvn.markie.nightly", VERSION), ("com.zvn.markie.rs", VERSION), ("com.zvn.markie", "0.1.0-super-nightly.99")] {
            let s = scene();
            s.mocked.publish(VERSION, &zipped(s.dir.path(), bundle_id, inner, "new"));
            assert!(matches!(s.run(&FakeTools::good(), Some(TOKEN), None), Err(UpdateError::Bundle(_))), "{bundle_id} {inner}");
            s.untouched();
        }
    }

    #[test]
    fn the_real_macos_tools_refuse_an_unsigned_download() {
        let s = scene();
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie", VERSION, "new"));
        let gateway = s.mocked.gateway();
        let updater = Updater { gateway: &gateway, tools: &bundle::SystemTools, current: Version::parse(OLD).unwrap(), target: s.target.clone(), work_dir: s.work_dir.clone() };
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
        let real = zipped(s.dir.path(), "com.zvn.markie", VERSION, "new");
        let mut served = real.clone();
        let middle = served.len() / 2;
        served[middle] ^= 0xff;
        s.mocked.mount(Mock::given(method("GET")).and(path(format!("{LANE_PREFIX}{FEED_NAME}"))).respond_with(ResponseTemplate::new(200).set_body_string(feed_text(VERSION, &real))));
        s.mocked.mount(Mock::given(method("GET")).and(path(format!("{LANE_PREFIX}Markie-{VERSION}-arm64.zip"))).respond_with(ResponseTemplate::new(200).set_body_bytes(served)));
        let tools = FakeTools::good();
        assert!(matches!(s.run(&tools, Some(TOKEN), None), Err(UpdateError::Gateway(GatewayError::Integrity))));
        assert!(tools.calls.borrow().is_empty(), "nothing was unpacked or inspected");
        s.untouched();
    }

    #[test]
    fn an_archive_reaching_outside_the_bundle_is_refused_before_unpacking() {
        use crate::archive::tests::{file, zip};
        let s = scene();
        let evil = zip(&[file("Markie.app/Contents/Info.plist", b"x"), file("Markie.app/../../escaped.txt", b"x")]);
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
        s.target = fixture(&translocated, "com.zvn.markie", OLD, "old");
        s.mocked.publish(VERSION, &zipped(s.dir.path(), "com.zvn.markie", VERSION, "new"));
        assert!(matches!(s.run(&FakeTools::good(), Some(TOKEN), None), Err(UpdateError::Swap(SwapError::Translocated))));
        assert_eq!(s.mocked.requests().len(), 1, "refused before the download");
        s.untouched();
    }

    /// The updater's own checks, on a real release ZIP, before it is published:
    /// what an installed Markie will do with this exact file, short of the swap.
    /// A super-nightly ZIP or a public one (`rust/target/public/<version>/`).
    ///
    ///   MARKIE_RELEASE_ZIP=<path to Markie-<version>-arm64.zip> \
    ///     cargo test -p markie-update the_updater_accepts_the_release_zip -- --ignored
    ///
    /// `MARKIE_NIGHTLY_ZIP` is read too, as the nightly runbook names it.
    #[test]
    #[ignore = "needs MARKIE_RELEASE_ZIP: a signed, notarized release ZIP"]
    fn the_updater_accepts_the_release_zip() {
        let zip = std::env::var_os("MARKIE_RELEASE_ZIP").or_else(|| std::env::var_os("MARKIE_NIGHTLY_ZIP"));
        let zip = PathBuf::from(zip.expect("set MARKIE_RELEASE_ZIP to the release ZIP"));
        let name = zip.file_name().and_then(|n| n.to_str()).expect("a file name");
        let version = name
            .strip_prefix("Markie-")
            .and_then(|n| n.strip_suffix("-arm64.zip"))
            .and_then(Version::parse)
            .expect("the ZIP must be named Markie-<version>-arm64.zip");
        assert!(version.is_super_nightly() || version.is_public(), "{version} is no channel's version");
        assert_eq!(crate::feed::artifact_name(&version), name);
        let contents = archive::inspect(&mut std::fs::File::open(&zip).unwrap()).expect("the ZIP's table of contents");
        let dir = tempfile::tempdir().unwrap();
        let app = bundle::unpack(&bundle::SystemTools, &zip, &dir.path().join("unpacked")).expect("unpacking");
        bundle::verify(&bundle::SystemTools, &app, &Expect::markie(&version)).expect("an installed Markie would refuse this ZIP");
        eprintln!("accepted {name}: {} entries, {} bytes unpacked", contents.entries, contents.expanded_bytes);
    }

    // ---------------------------------------------------------------- public lanes

    const CURRENT: &str = "0.10.0";
    const NEXT: &str = "0.10.1";

    /// The public Mac app at 0.10.0 in /Applications, and a mock public store.
    fn public_scene() -> Scene {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        std::fs::create_dir_all(&apps).unwrap();
        let target = fixture(&apps, "com.zvn.markie", CURRENT, "old");
        let work_dir = dir.path().join("data/updates");
        Scene { dir, target, work_dir, mocked: Mocked::start() }
    }

    impl Scene {
        fn run_public(&self, tools: &FakeTools, early_access: bool) -> Result<Outcome, UpdateError> {
            let gateway = self.mocked.public_gateway(crate::public_lane(early_access));
            let updater = Updater { gateway: &gateway, tools, current: Version::parse(CURRENT).unwrap(), target: self.target.clone(), work_dir: self.work_dir.clone() };
            // A Markie Cloud token, as a signed-in app holds one: never sent here.
            updater.run(Some(TOKEN), None)
        }
        fn paths(&self) -> Vec<String> {
            self.mocked.requests().iter().map(|r| r.url.path().to_string()).collect()
        }
    }

    fn intel_zip(dir: &Path, version: &str) -> Vec<u8> {
        // Electron for Intel Macs: Markie's identity too, so only the feed's
        // file name and the arm64-only rule keep it off this Mac.
        zipped(dir, "com.zvn.markie", version, "intel")
    }

    #[test]
    fn the_public_app_takes_the_arm64_zip_from_the_stable_feed_without_signing_in() {
        let s = public_scene();
        let arm = zipped(s.dir.path(), "com.zvn.markie", NEXT, "new");
        s.mocked.publish_public(&crate::PUBLIC_STABLE, NEXT, &arm, &intel_zip(s.dir.path(), NEXT));
        let outcome = s.run_public(&FakeTools::good(), false).unwrap();
        assert!(matches!(outcome, Outcome::Installed { version, .. } if version.to_string() == NEXT));
        assert_eq!(marker(&s.target), "new", "the arm64 bundle, never the x64 one");
        assert_eq!(s.paths(), ["/markie-releases/mac/latest-mac.yml", "/markie-releases/mac/Markie-0.10.1-arm64.zip"]);
        assert!(s.mocked.requests().iter().all(|r| r.headers.get("authorization").is_none()), "no token on the public store");
    }

    #[test]
    fn early_access_reads_the_beta_feed() {
        let s = public_scene();
        let arm = zipped(s.dir.path(), "com.zvn.markie", NEXT, "new");
        s.mocked.publish_public(&crate::PUBLIC_EARLY, NEXT, &arm, &intel_zip(s.dir.path(), NEXT));
        assert!(matches!(s.run_public(&FakeTools::good(), true).unwrap(), Outcome::Installed { .. }));
        assert_eq!(s.paths(), ["/markie-releases/mac/beta-mac.yml", "/markie-releases/mac/Markie-0.10.1-arm64.zip"]);
        // With early access off, the same Mac reads only the stable feed, which here has nothing.
        let s = public_scene();
        s.mocked.publish_public(&crate::PUBLIC_EARLY, NEXT, &arm, &intel_zip(s.dir.path(), NEXT));
        assert_eq!(s.run_public(&FakeTools::good(), false).unwrap(), Outcome::NotAvailable);
        assert_eq!(s.paths(), ["/markie-releases/mac/latest-mac.yml"]);
        s.untouched();
    }

    #[test]
    fn the_public_app_never_takes_the_x64_zip() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};
        // An Intel-only feed, the shape Electron published before arm64 was split off.
        let s = public_scene();
        let intel = intel_zip(s.dir.path(), NEXT);
        let text = crate::feed::tests::public_feed_text(NEXT, b"unused", &intel);
        let arm_entry = format!("  - url: Markie-{NEXT}-arm64.zip\n    sha512: {}\n    size: 6\n", crate::feed::tests::sha(b"unused"));
        s.mocked.mount(Mock::given(method("GET")).and(path("/markie-releases/mac/latest-mac.yml")).respond_with(ResponseTemplate::new(200).set_body_string(text.replace(&arm_entry, ""))));
        assert!(matches!(s.run_public(&FakeTools::good(), false), Err(UpdateError::Gateway(GatewayError::Feed(crate::feed::FeedError::Artifact)))));
        assert_eq!(s.paths(), ["/markie-releases/mac/latest-mac.yml"], "nothing was downloaded");
        s.untouched();
    }

    #[test]
    fn the_public_app_refuses_a_wrong_team_bundle_id_or_notarization() {
        let wrong: [(&str, fn(&mut FakeTools)); 4] = [
            ("team", |t| t.ours = false),
            ("another team's Developer ID", |t| t.display = crate::bundle::tests::display("com.zvn.markie", "AAAAAAAAAA", "Developer ID Application: Someone Else (AAAAAAAAAA)", "0x10000(runtime)")),
            ("not notarized", |t| t.source = "Developer ID"),
            ("signature", |t| t.sealed = false),
        ];
        for (name, change) in wrong {
            let s = public_scene();
            s.mocked.publish_public(&crate::PUBLIC_STABLE, NEXT, &zipped(s.dir.path(), "com.zvn.markie", NEXT, "new"), &intel_zip(s.dir.path(), NEXT));
            let mut tools = FakeTools::good();
            change(&mut tools);
            assert!(matches!(s.run_public(&tools, false), Err(UpdateError::Bundle(_))), "{name}");
            s.untouched();
        }
        for bundle_id in ["com.zvn.markie.rs", "com.zvn.markie.nightly", "com.example.markie"] {
            let s = public_scene();
            s.mocked.publish_public(&crate::PUBLIC_STABLE, NEXT, &zipped(s.dir.path(), bundle_id, NEXT, "new"), &intel_zip(s.dir.path(), NEXT));
            assert!(matches!(s.run_public(&FakeTools::good(), false), Err(UpdateError::Bundle(BundleError::Identity))), "{bundle_id}");
            s.untouched();
        }
    }

    #[test]
    fn the_public_app_refuses_the_same_or_a_lower_version() {
        for published in [CURRENT, "0.9.7", "0.10.0-rc.2", "0.10.0-beta.9"] {
            let s = public_scene();
            s.mocked.publish_public(&crate::PUBLIC_STABLE, published, &zipped(s.dir.path(), "com.zvn.markie", published, "new"), &intel_zip(s.dir.path(), published));
            assert_eq!(s.run_public(&FakeTools::good(), false).unwrap(), Outcome::UpToDate { current: Version::parse(CURRENT).unwrap() }, "{published}");
            assert_eq!(s.paths().len(), 1, "no download for {published}");
            s.untouched();
        }
    }

    #[test]
    fn the_public_app_refuses_a_sha512_or_size_mismatch() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};
        let cases: [(&str, fn(&mut Vec<u8>)); 3] = [
            ("sha512", |z| { let middle = z.len() / 2; z[middle] ^= 0xff; }),
            ("shorter", |z| { z.pop(); }),
            ("longer", |z| z.extend_from_slice(b"extra")),
        ];
        for (name, change) in cases {
            let s = public_scene();
            let real = zipped(s.dir.path(), "com.zvn.markie", NEXT, "new");
            let mut served = real.clone();
            change(&mut served);
            let text = crate::feed::tests::public_feed_text(NEXT, &real, b"intel");
            s.mocked.mount(Mock::given(method("GET")).and(path("/markie-releases/mac/latest-mac.yml")).respond_with(ResponseTemplate::new(200).set_body_string(text)));
            s.mocked.mount(Mock::given(method("GET")).and(path(format!("/markie-releases/mac/Markie-{NEXT}-arm64.zip"))).respond_with(ResponseTemplate::new(200).set_body_bytes(served)));
            let tools = FakeTools::good();
            assert!(matches!(s.run_public(&tools, false), Err(UpdateError::Gateway(GatewayError::Integrity))), "{name}");
            assert!(tools.calls.borrow().is_empty(), "{name}: nothing unpacked or inspected");
            s.untouched();
        }
    }

    #[test]
    fn the_pause_marker_is_inside_the_work_folder() {
        assert_eq!(paused_marker(Path::new("/data/updates")), Path::new("/data/updates/paused"));
    }
}
