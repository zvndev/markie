//! Markie Nightly's updater.
//!
//! Markie Nightly is the private build of Markie RS (docs/rust-port/NIGHTLY.md).
//! It updates from the rs-nightly lane of the private gateway and from nowhere
//! else. One check, in order:
//!
//! 1. Ask the gateway for the feed with the Markie Cloud bearer token the app
//!    already holds. No token, or a gateway that answers 404 (the token is not
//!    the owner's), is "no updates" and nothing more happens.
//! 2. Read the feed strictly (`feed`) and stop unless it names a newer version.
//! 3. Download the one ZIP it names, from the gateway origin only, refusing
//!    redirects, and check its size and SHA-512 against the feed (`gateway`).
//! 4. Check the ZIP's entry names before unpacking it (`archive`), unpack it to
//!    a private folder, and check the bundle inside: code signature, Developer
//!    ID team, bundle id, version, Gatekeeper (`bundle`).
//! 5. Swap it in place of the running bundle in one atomic step, keeping the
//!    old one for a roll back (`swap`).
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
/// The lane's closed prefix on the gateway.
pub const LANE_PREFIX: &str = "/private-releases/rs-nightly/";
pub const FEED_NAME: &str = "rs-nightly-mac.yml";
/// Markie Nightly's identity. A downloaded bundle must be exactly this.
pub const BUNDLE_ID: &str = "com.zvn.markie.nightly";
pub const BUNDLE_NAME: &str = "Markie Nightly.app";
/// Kirby Campbell's Developer ID team.
pub const TEAM_ID: &str = "3VU8SG5TD9";
