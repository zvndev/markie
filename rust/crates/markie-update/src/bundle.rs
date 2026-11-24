//! Is the unpacked bundle really Markie Nightly, signed by the right team?
//!
//! macOS answers that, not this code: `codesign` checks the signature against
//! a requirement naming the bundle id, Apple's Developer ID chain and the
//! team, and `spctl` asks Gatekeeper whether it would run (notarized, not
//! revoked). The system tools are run by absolute path with an empty
//! environment. `Tools` is the seam the tests use to stand in for them.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BundleError {
    #[error("the update could not be unpacked")]
    Unpack,
    #[error("the update is not a {} bundle", crate::BUNDLE_NAME)]
    Shape,
    #[error("the update holds a link that leaves its own bundle")]
    Link,
    #[error("the update is not {}", crate::BUNDLE_ID)]
    Identity,
    #[error("the update is version {found}, not the {expected} the feed named")]
    Version { expected: String, found: String },
    #[error("the update's code signature is not valid")]
    Signature,
    #[error("the update is not signed by Developer ID team {}", crate::TEAM_ID)]
    Team,
    #[error("macOS Gatekeeper does not accept the update")]
    Gatekeeper,
    #[error("a macOS tool needed to check the update could not run")]
    Tool,
}

/// What a real bundle must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expect {
    pub bundle_id: String,
    pub team_id: String,
    pub version: String,
}

impl Expect {
    pub fn nightly(version: &crate::NightlyVersion) -> Self {
        Self { bundle_id: crate::BUNDLE_ID.into(), team_id: crate::TEAM_ID.into(), version: version.to_string() }
    }

    /// The code requirement: this bundle id, Apple's Developer ID chain, this
    /// team. The standard Developer ID requirement, as `codesign -d -r-` shows
    /// it for a notarized app.
    pub fn requirement(&self) -> String {
        format!(
            "identifier \"{}\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
             and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{}\"",
            self.bundle_id, self.team_id
        )
    }
}

pub const DITTO: &str = "/usr/bin/ditto";
pub const CODESIGN: &str = "/usr/bin/codesign";
pub const SPCTL: &str = "/usr/sbin/spctl";
pub const PLUTIL: &str = "/usr/bin/plutil";

/// Runs a system tool. The app uses `SystemTools`; tests answer for the tools.
pub trait Tools {
    fn run(&self, program: &str, args: &[&OsStr]) -> std::io::Result<Output>;
}

pub struct SystemTools;

impl Tools for SystemTools {
    fn run(&self, program: &str, args: &[&OsStr]) -> std::io::Result<Output> {
        Command::new(program).args(args).env_clear().stdin(Stdio::null()).output()
    }
}

fn ok(tools: &dyn Tools, program: &str, args: &[&OsStr]) -> Result<Output, BundleError> {
    tools.run(program, args).map_err(|_| BundleError::Tool)
}

/// Unpack a ZIP `archive::inspect` has passed into `dest`, a folder that does
/// not exist yet, and return the bundle inside it.
pub fn unpack(tools: &dyn Tools, zip: &Path, dest: &Path) -> Result<PathBuf, BundleError> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dest).map_err(|_| BundleError::Unpack)?;
    let output = ok(tools, DITTO, &["-x".as_ref(), "-k".as_ref(), zip.as_os_str(), dest.as_os_str()])?;
    if !output.status.success() {
        return Err(BundleError::Unpack);
    }
    let app = dest.join(crate::BUNDLE_NAME);
    // Exactly the bundle, nothing beside it.
    let beside: Vec<_> = std::fs::read_dir(dest).map_err(|_| BundleError::Unpack)?.filter_map(Result::ok).map(|e| e.file_name()).collect();
    if beside.len() != 1 || beside[0] != OsStr::new(crate::BUNDLE_NAME) {
        return Err(BundleError::Shape);
    }
    contained(&app)?;
    Ok(app)
}

/// A real directory whose every symlink points inside it.
pub fn contained(app: &Path) -> Result<(), BundleError> {
    let meta = std::fs::symlink_metadata(app).map_err(|_| BundleError::Shape)?;
    if !meta.file_type().is_dir() {
        return Err(BundleError::Shape);
    }
    let root = app.canonicalize().map_err(|_| BundleError::Shape)?;
    let mut pending = vec![app.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|_| BundleError::Shape)? {
            let entry = entry.map_err(|_| BundleError::Shape)?;
            let kind = entry.file_type().map_err(|_| BundleError::Shape)?;
            if kind.is_symlink() {
                let target = std::fs::read_link(entry.path()).map_err(|_| BundleError::Link)?;
                let resolved = entry.path().canonicalize().map_err(|_| BundleError::Link)?;
                if target.is_absolute() || !resolved.starts_with(&root) {
                    return Err(BundleError::Link);
                }
            } else if kind.is_dir() {
                pending.push(entry.path());
            } else if !kind.is_file() {
                // No sockets, devices or pipes in an app bundle.
                return Err(BundleError::Shape);
            }
        }
    }
    Ok(())
}

fn plist_value(tools: &dyn Tools, plist: &Path, key: &str) -> Result<String, BundleError> {
    let output = ok(tools, PLUTIL, &["-extract".as_ref(), key.as_ref(), "raw".as_ref(), "-o".as_ref(), "-".as_ref(), plist.as_os_str()])?;
    if !output.status.success() {
        return Err(BundleError::Shape);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The fields `codesign --display --verbose=4` prints, read from its output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Signature {
    pub identifier: Option<String>,
    pub team: Option<String>,
    pub developer_id: bool,
    pub hardened_runtime: bool,
}

pub fn parse_signature(display: &str) -> Signature {
    let mut signature = Signature::default();
    let mut first_authority = true;
    for line in display.lines() {
        if let Some(value) = line.strip_prefix("Identifier=") {
            signature.identifier.get_or_insert_with(|| value.to_string());
        } else if let Some(value) = line.strip_prefix("TeamIdentifier=") {
            signature.team.get_or_insert_with(|| value.to_string());
        } else if let Some(value) = line.strip_prefix("Authority=") {
            // The leaf certificate is the first Authority line.
            if first_authority {
                signature.developer_id = value.starts_with("Developer ID Application: ");
            }
            first_authority = false;
        } else if let Some(value) = line.strip_prefix("CodeDirectory ") {
            // "… flags=0x10000(runtime) …"
            signature.hardened_runtime = value
                .split_whitespace()
                .find_map(|field| field.strip_prefix("flags="))
                .and_then(|flags| flags.split_once('(').map(|(_, names)| names.trim_end_matches(')').to_string()))
                .is_some_and(|names| names.split(',').any(|name| name == "runtime"));
        }
    }
    signature
}

/// Every check a bundle must pass before it replaces the running one.
pub fn verify(tools: &dyn Tools, app: &Path, expect: &Expect) -> Result<(), BundleError> {
    if app.file_name() != Some(OsStr::new(crate::BUNDLE_NAME)) {
        return Err(BundleError::Shape);
    }
    contained(app)?;
    // The signature first: nothing inside the bundle is read as data until
    // macOS has vouched for all of it. It seals every file, and is valid
    // against Apple's roots.
    let sealed = ok(tools, CODESIGN, &["--verify".as_ref(), "--deep".as_ref(), "--strict".as_ref(), app.as_os_str()])?;
    if !sealed.status.success() {
        return Err(BundleError::Signature);
    }
    // And it is this app, from this team, on a Developer ID certificate.
    let requirement = format!("={}", expect.requirement());
    let ours = ok(tools, CODESIGN, &["--verify".as_ref(), "--deep".as_ref(), "--strict".as_ref(), "-R".as_ref(), requirement.as_ref(), app.as_os_str()])?;
    if !ours.status.success() {
        return Err(BundleError::Team);
    }
    let display = ok(tools, CODESIGN, &["--display".as_ref(), "--verbose=4".as_ref(), app.as_os_str()])?;
    if !display.status.success() {
        return Err(BundleError::Signature);
    }
    // codesign prints the description on stderr.
    let signature = parse_signature(&String::from_utf8_lossy(&display.stderr));
    if signature.identifier.as_deref() != Some(expect.bundle_id.as_str()) {
        return Err(BundleError::Identity);
    }
    if signature.team.as_deref() != Some(expect.team_id.as_str()) || !signature.developer_id {
        return Err(BundleError::Team);
    }
    if !signature.hardened_runtime {
        return Err(BundleError::Signature);
    }
    let gatekeeper = ok(tools, SPCTL, &["--assess".as_ref(), "--type".as_ref(), "execute".as_ref(), app.as_os_str()])?;
    if !gatekeeper.status.success() {
        return Err(BundleError::Gatekeeper);
    }
    // Now the sealed Info.plist: this app, and the version the feed promised.
    let plist = app.join("Contents/Info.plist");
    if plist_value(tools, &plist, "CFBundleIdentifier")? != expect.bundle_id {
        return Err(BundleError::Identity);
    }
    let found = plist_value(tools, &plist, "CFBundleShortVersionString")?;
    if found != expect.version {
        return Err(BundleError::Version { expected: expect.version.clone(), found });
    }
    let executable = plist_value(tools, &plist, "CFBundleExecutable")?;
    let plain_name = !executable.is_empty() && !executable.contains(['/', '\\']) && executable != "." && executable != "..";
    if !plain_name || !std::fs::symlink_metadata(app.join("Contents/MacOS").join(&executable)).is_ok_and(|m| m.file_type().is_file()) {
        return Err(BundleError::Shape);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::unix::process::ExitStatusExt as _;
    use std::process::ExitStatus;

    pub(crate) const VERSION: &str = "0.1.0-rs-nightly.7";

    pub(crate) fn expect() -> Expect {
        Expect::nightly(&crate::NightlyVersion::parse(VERSION).unwrap())
    }

    pub(crate) fn display(identifier: &str, team: &str, authority: &str, flags: &str) -> String {
        format!(
            "Executable=/tmp/x/Markie Nightly.app/Contents/MacOS/markie-rs\nIdentifier={identifier}\nFormat=app bundle with Mach-O thin (arm64)\n\
             CodeDirectory v=20500 size=1234 flags={flags} hashes=30+7 location=embedded\nAuthority={authority}\n\
             Authority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTimestamp=24 Nov 2026 at 12:00:00\nTeamIdentifier={team}\n"
        )
    }

    pub(crate) fn good_display() -> String {
        display("com.zvn.markie.nightly", "3VU8SG5TD9", "Developer ID Application: Kirby Campbell (3VU8SG5TD9)", "0x10000(runtime)")
    }

    /// Stands in for the system tools: real `ditto` and `plutil` (they read
    /// only the fixture), scripted `codesign` and `spctl`.
    pub(crate) struct FakeTools {
        pub sealed: bool,
        pub ours: bool,
        pub display: String,
        pub gatekeeper: bool,
        pub calls: RefCell<Vec<String>>,
    }

    impl FakeTools {
        pub fn good() -> Self {
            Self { sealed: true, ours: true, display: good_display(), gatekeeper: true, calls: RefCell::new(Vec::new()) }
        }
    }

    fn status(success: bool) -> ExitStatus {
        ExitStatus::from_raw(if success { 0 } else { 1 << 8 })
    }

    impl Tools for FakeTools {
        fn run(&self, program: &str, args: &[&OsStr]) -> std::io::Result<Output> {
            let line = format!("{program} {}", args.iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "));
            self.calls.borrow_mut().push(line);
            let answer = |success: bool, stderr: &str| Ok(Output { status: status(success), stdout: Vec::new(), stderr: stderr.as_bytes().to_vec() });
            match program {
                CODESIGN if args.contains(&OsStr::new("--display")) => answer(true, &self.display),
                CODESIGN if args.contains(&OsStr::new("-R")) => answer(self.ours, ""),
                CODESIGN => answer(self.sealed, ""),
                SPCTL => answer(self.gatekeeper, ""),
                _ => SystemTools.run(program, args),
            }
        }
    }

    /// A bundle-shaped folder with the given identity. Not signed.
    pub(crate) fn fixture(parent: &Path, bundle_id: &str, version: &str, marker: &str) -> PathBuf {
        let app = parent.join(crate::BUNDLE_NAME);
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::create_dir_all(app.join("Contents/Resources")).unwrap();
        std::fs::write(app.join("Contents/MacOS/markie-rs"), format!("#!/bin/sh\necho {marker}\n")).unwrap();
        std::fs::write(app.join("Contents/Resources/marker.txt"), marker).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
                 <plist version=\"1.0\"><dict>\n<key>CFBundleIdentifier</key><string>{bundle_id}</string>\n\
                 <key>CFBundleShortVersionString</key><string>{version}</string>\n<key>CFBundleExecutable</key><string>markie-rs</string>\n\
                 <key>CFBundlePackageType</key><string>APPL</string>\n</dict></plist>\n"
            ),
        )
        .unwrap();
        app
    }

    #[test]
    fn reads_codesigns_description() {
        let s = parse_signature(&good_display());
        assert_eq!(s.identifier.as_deref(), Some("com.zvn.markie.nightly"));
        assert_eq!(s.team.as_deref(), Some("3VU8SG5TD9"));
        assert!(s.developer_id && s.hardened_runtime);
        let adhoc = parse_signature("Identifier=com.zvn.markie.nightly\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+1 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n");
        assert_eq!(adhoc.team.as_deref(), Some("not set"));
        assert!(!adhoc.developer_id && !adhoc.hardened_runtime);
        // A Developer ID named further down the chain, or in a later repeated
        // field, does not count: only the first of each is the signer's.
        let chained = parse_signature("Authority=Apple Development: Someone (AAAAAAAAAA)\nAuthority=Developer ID Application: Kirby Campbell (3VU8SG5TD9)\nTeamIdentifier=AAAAAAAAAA\nTeamIdentifier=3VU8SG5TD9\n");
        assert!(!chained.developer_id);
        assert_eq!(chained.team.as_deref(), Some("AAAAAAAAAA"));
        let both = parse_signature("CodeDirectory v=20500 size=1 flags=0x10002(adhoc,runtime) hashes=1+1 location=embedded\n");
        assert!(both.hardened_runtime);
        assert!(!parse_signature("CodeDirectory v=20500 size=1 flags=0x0(none) hashes=1+1 location=embedded\n").hardened_runtime);
    }

    #[test]
    fn the_requirement_names_the_bundle_the_chain_and_the_team() {
        let requirement = expect().requirement();
        assert!(requirement.contains("identifier \"com.zvn.markie.nightly\""));
        assert!(requirement.contains("anchor apple generic"));
        assert!(requirement.contains("certificate leaf[subject.OU] = \"3VU8SG5TD9\""));
        assert!(requirement.contains("1.2.840.113635.100.6.1.13"), "the Developer ID Application leaf extension");
    }

    #[test]
    fn a_right_bundle_passes_and_each_wrong_one_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let app = fixture(dir.path(), "com.zvn.markie.nightly", VERSION, "new");
        let tools = FakeTools::good();
        assert_eq!(verify(&tools, &app, &expect()), Ok(()));
        let calls = tools.calls.borrow().join("\n");
        assert!(calls.contains("--verify --deep --strict"), "{calls}");
        assert!(calls.contains("-R =identifier \"com.zvn.markie.nightly\""), "{calls}");
        assert!(calls.contains("/usr/sbin/spctl --assess --type execute"), "{calls}");

        let failing = |change: fn(&mut FakeTools)| {
            let mut tools = FakeTools::good();
            change(&mut tools);
            verify(&tools, &app, &expect())
        };
        assert_eq!(failing(|t| t.sealed = false), Err(BundleError::Signature));
        assert_eq!(failing(|t| t.ours = false), Err(BundleError::Team));
        assert_eq!(failing(|t| t.gatekeeper = false), Err(BundleError::Gatekeeper));
        assert_eq!(failing(|t| t.display = display("com.zvn.markie.nightly", "AAAAAAAAAA", "Developer ID Application: Someone Else (AAAAAAAAAA)", "0x10000(runtime)")), Err(BundleError::Team));
        assert_eq!(failing(|t| t.display = display("com.zvn.markie.nightly", "not set", "", "0x2(adhoc)")), Err(BundleError::Team));
        assert_eq!(failing(|t| t.display = display("com.zvn.markie.nightly", "3VU8SG5TD9", "Apple Development: Kirby Campbell (3VU8SG5TD9)", "0x10000(runtime)")), Err(BundleError::Team));
        assert_eq!(failing(|t| t.display = display("com.zvn.markie", "3VU8SG5TD9", "Developer ID Application: Kirby Campbell (3VU8SG5TD9)", "0x10000(runtime)")), Err(BundleError::Identity));
        assert_eq!(failing(|t| t.display = display("com.zvn.markie.nightly", "3VU8SG5TD9", "Developer ID Application: Kirby Campbell (3VU8SG5TD9)", "0x0(none)")), Err(BundleError::Signature));
    }

    #[test]
    fn the_plist_must_carry_this_identity_and_the_feeds_version() {
        let tools = FakeTools::good();
        for (bundle_id, version, want) in [
            ("com.zvn.markie", VERSION, BundleError::Identity),
            ("com.zvn.markie.rs", VERSION, BundleError::Identity),
            ("com.zvn.markie.nightly", "0.1.0-rs-nightly.6", BundleError::Version { expected: VERSION.into(), found: "0.1.0-rs-nightly.6".into() }),
            ("com.zvn.markie.nightly", "0.1.0", BundleError::Version { expected: VERSION.into(), found: "0.1.0".into() }),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let app = fixture(dir.path(), bundle_id, version, "x");
            assert_eq!(verify(&tools, &app, &expect()), Err(want));
        }
        // A missing executable, a missing plist, and a wrongly named bundle.
        let dir = tempfile::tempdir().unwrap();
        let app = fixture(dir.path(), "com.zvn.markie.nightly", VERSION, "x");
        std::fs::remove_file(app.join("Contents/MacOS/markie-rs")).unwrap();
        assert_eq!(verify(&tools, &app, &expect()), Err(BundleError::Shape));
        std::fs::remove_file(app.join("Contents/Info.plist")).unwrap();
        assert_eq!(verify(&tools, &app, &expect()), Err(BundleError::Shape));
        let renamed = dir.path().join("Markie.app");
        std::fs::rename(&app, &renamed).unwrap();
        assert_eq!(verify(&tools, &renamed, &expect()), Err(BundleError::Shape));
    }

    #[test]
    fn links_that_leave_the_bundle_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let app = fixture(dir.path(), "com.zvn.markie.nightly", VERSION, "x");
        std::os::unix::fs::symlink("marker.txt", app.join("Contents/Resources/inside")).unwrap();
        assert_eq!(contained(&app), Ok(()));
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "x").unwrap();
        for target in ["../../../outside.txt", outside.to_str().unwrap(), "missing"] {
            let link = app.join("Contents/Resources/escape");
            std::os::unix::fs::symlink(target, &link).unwrap();
            assert_eq!(contained(&app), Err(BundleError::Link), "{target}");
            assert_eq!(verify(&FakeTools::good(), &app, &expect()), Err(BundleError::Link));
            std::fs::remove_file(&link).unwrap();
        }
        // The bundle itself may not be a link to one.
        let real = dir.path().join("real");
        std::fs::rename(&app, &real).unwrap();
        std::os::unix::fs::symlink(&real, &app).unwrap();
        assert_eq!(contained(&app), Err(BundleError::Shape));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unpacks_only_an_archive_holding_exactly_the_bundle() {
        use crate::archive::tests::{file, zip};
        let dir = tempfile::tempdir().unwrap();
        let plist = "Markie Nightly.app/Contents/Info.plist";
        let good = dir.path().join("good.zip");
        std::fs::write(&good, zip(&[file("Markie Nightly.app/", b""), file("Markie Nightly.app/Contents/", b""), file(plist, b"<plist/>")])).unwrap();
        let app = unpack(&SystemTools, &good, &dir.path().join("good")).unwrap();
        assert_eq!(std::fs::read(app.join("Contents/Info.plist")).unwrap(), b"<plist/>");
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(dir.path().join("good")).unwrap().permissions()) & 0o777, 0o700);
        // The folder must be new: nothing is unpacked over what is there.
        assert_eq!(unpack(&SystemTools, &good, &dir.path().join("good")), Err(BundleError::Unpack));
        let garbage = dir.path().join("garbage.zip");
        std::fs::write(&garbage, b"not a zip").unwrap();
        assert_eq!(unpack(&SystemTools, &garbage, &dir.path().join("garbage")), Err(BundleError::Unpack));
    }

    /// The real macOS tools against real bundles this test signs ad hoc: none
    /// of them is Developer ID signed by the team, so every one is refused.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_tools_refuse_unsigned_adhoc_and_tampered_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let app = fixture(dir.path(), "com.zvn.markie.nightly", VERSION, "x");
        assert_eq!(verify(&SystemTools, &app, &expect()), Err(BundleError::Signature), "unsigned");

        let signed = Command::new(CODESIGN).args(["--force", "--sign", "-", "--options", "runtime"]).arg(&app).output().unwrap();
        assert!(signed.status.success(), "ad-hoc signing failed: {}", String::from_utf8_lossy(&signed.stderr));
        // Sealed, but by nobody: the team requirement fails.
        assert_eq!(verify(&SystemTools, &app, &expect()), Err(BundleError::Team), "ad hoc");

        std::fs::write(app.join("Contents/Resources/marker.txt"), "tampered").unwrap();
        assert_eq!(verify(&SystemTools, &app, &expect()), Err(BundleError::Signature), "tampered after signing");
    }
}
