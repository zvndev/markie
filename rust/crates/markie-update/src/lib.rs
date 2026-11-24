//! Markie's updater on the Mac super-nightly channel.
//!
//! The Rust app is the Mac app. On the private super-nightly channel it
//! updates from the same lane of the private gateway that Electron Markie's
//! super-nightly builds read, in the same feed format, so one feed serves
//! both: an installed Electron super-nightly updates itself into this app
//! through electron-updater and Squirrel.Mac, and from then on this crate
//! does the updating (docs/rust-port/NIGHTLY.md). One check, in order:
//!
//! 1. Ask the gateway for the feed with the Markie Cloud bearer token the app
//!    already holds. No token, or a gateway that answers 404 (the token is not
//!    the owner's), is "no updates" and nothing more happens.
//! 2. Read the feed strictly (`feed`) and stop unless it names a newer version.
//! 3. Download the arm64 ZIP it names, from the gateway origin only, refusing
//!    redirects, and check its size and SHA-512 against the feed (`gateway`).
//! 4. Check the ZIP's entry names before unpacking it (`archive`), unpack it to
//!    a private folder, and check the bundle inside: code signature, Developer
//!    ID team, bundle id, version, Gatekeeper (`bundle`).
//! 5. Swap it in place of the running bundle in one atomic step, keeping the
//!    old one for a roll back (`swap`).
//!
//! The bundle that arrives is whatever the channel published under Markie's
//! identity. That is normally the next Rust build; it may be an Electron
//! super-nightly with a higher version, which is the channel's roll back.
//!
//! Everything here is plain blocking code with no UI, so each step is tested
//! with fixtures; the app (markie-app `updates.rs`) only decides when to run
//! it and what to say.

pub mod archive;
pub mod bundle;
pub mod feed;
pub mod gateway;
pub mod swap;
pub mod updater;
pub mod version;

pub use updater::{Outcome, UpdateError, Updater};
pub use version::NightlyVersion;

/// The reviewed private gateway. The token is sent here and nowhere else.
pub const GATEWAY_ORIGIN: &str = "https://markie-nightly.zvndev.com";
/// The channel's closed prefix on the gateway: Electron Markie's super-nightly lane.
pub const LANE_PREFIX: &str = "/private-releases/super-nightly/";
/// electron-updater's name for the Mac feed of channel `super-nightly`.
pub const FEED_NAME: &str = "super-nightly-mac.yml";
/// Markie's identity on the Mac. A downloaded bundle must be exactly this.
pub const BUNDLE_ID: &str = "com.zvn.markie";
pub const BUNDLE_NAME: &str = "Markie.app";
/// Kirby Campbell's Developer ID team.
pub const TEAM_ID: &str = "3VU8SG5TD9";
