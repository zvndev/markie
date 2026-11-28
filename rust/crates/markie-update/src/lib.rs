//! Markie's updater on the Mac: the super-nightly channel and the public feeds.
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
//! The public Mac app (docs/rust-port/PUBLIC.md) runs the same check against
//! a different `Lane`: the public release store Electron Markie's installed
//! Mac apps read, with no token and no owner check. Its feeds,
//! `latest-mac.yml` and, with early access on, `beta-mac.yml`, list Markie RS
//! as the arm64 ZIP and Electron for Intel Macs as the x64 ZIP; this crate
//! only ever takes the arm64 ZIP. Every check after the feed is the same.
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
pub use version::Version;

/// The reviewed private gateway. The token is sent here and nowhere else.
pub const GATEWAY_ORIGIN: &str = "https://markie-nightly.zvndev.com";
/// The channel's closed prefix on the gateway: Electron Markie's super-nightly lane.
pub const LANE_PREFIX: &str = "/private-releases/super-nightly/";
/// electron-updater's name for the Mac feed of channel `super-nightly`.
pub const FEED_NAME: &str = "super-nightly-mac.yml";
/// Markie's identity on the Mac. A downloaded bundle must be exactly this.
pub const BUNDLE_ID: &str = "com.zvn.markie";
pub const BUNDLE_NAME: &str = "Markie.app";
/// Its `CFBundleExecutable`, Electron Markie's own. Squirrel.Mac, inside an
/// installed Electron Markie, names the installed bundle after the update's
/// executable: a Rust bundle with any other name would land as
/// /Applications/<name>.app. Builds up to 0.10.0-super-nightly.8 carried
/// "markie-rs"; the swap does not care what the bundle it replaces carries.
pub const EXECUTABLE: &str = "Markie";
/// Kirby Campbell's Developer ID team.
pub const TEAM_ID: &str = "3VU8SG5TD9";

/// Where one channel's feed and downloads live, and what it publishes.
#[derive(Debug)]
pub struct Lane {
    /// HTTPS origin. Every request goes here and nowhere else.
    pub origin: &'static str,
    /// The closed path prefix the feed and the artifacts sit under.
    pub prefix: &'static str,
    /// electron-builder's feed file for this channel on the Mac.
    pub feed: &'static str,
    /// The private gateway serves the owner only: the Markie Cloud token is
    /// required, and a check without one asks nothing. The public store takes
    /// no token, and none is ever sent to it.
    pub token: bool,
    /// The version shapes this channel publishes.
    pub accepts: fn(&Version) -> bool,
    /// electron-builder writes `blockMapSize` under a ZIP built for
    /// differential download. The private lane's publisher never does, and
    /// its gateway would refuse it; the public store has it from older builds.
    pub block_maps: bool,
}

/// Two lanes are the same when they read the same feed the same way.
impl PartialEq for Lane {
    fn eq(&self, other: &Self) -> bool {
        (self.origin, self.prefix, self.feed, self.token, self.block_maps) == (other.origin, other.prefix, other.feed, other.token, other.block_maps)
    }
}
impl Eq for Lane {}

/// The private super-nightly lane on the reviewed gateway.
pub const SUPER_NIGHTLY: Lane = Lane {
    origin: GATEWAY_ORIGIN,
    prefix: LANE_PREFIX,
    feed: FEED_NAME,
    token: true,
    accepts: Version::is_super_nightly,
    block_maps: false,
};

/// The public release store, as installed Electron Markie reads it.
/// electron-builder's S3 provider, with the endpoint and bucket in
/// zvndev/markie `server/download-manifest.json`, builds this URL
/// (`${endpoint}/${bucket}/${path}`), so Markie RS and every installed
/// Electron Mac app read the very same objects. markiedocs.com/download is the
/// website's route to the DMGs, not a feed.
pub const PUBLIC_ORIGIN: &str = "https://s3.us-east-005.backblazeb2.com";
pub const PUBLIC_PREFIX: &str = "/markie-releases/mac/";

/// The public stable feed.
pub const PUBLIC_STABLE: Lane = Lane {
    origin: PUBLIC_ORIGIN,
    prefix: PUBLIC_PREFIX,
    feed: "latest-mac.yml",
    token: false,
    accepts: Version::is_public,
    block_maps: true,
};

/// The public early-access feed: "Get new versions early" in Settings.
pub const PUBLIC_EARLY: Lane = Lane { feed: "beta-mac.yml", ..PUBLIC_STABLE };

/// The public lane for the early-access setting.
pub fn public_lane(early_access: bool) -> &'static Lane {
    if early_access { &PUBLIC_EARLY } else { &PUBLIC_STABLE }
}

#[cfg(test)]
mod lane_tests {
    use super::*;

    #[test]
    fn the_public_lanes_are_the_store_installed_electron_reads_and_take_no_token() {
        assert_eq!(public_lane(false).feed, "latest-mac.yml");
        assert_eq!(public_lane(true).feed, "beta-mac.yml");
        for lane in [&PUBLIC_STABLE, &PUBLIC_EARLY] {
            assert_eq!(format!("{}{}", lane.origin, lane.prefix), "https://s3.us-east-005.backblazeb2.com/markie-releases/mac/");
            assert!(!lane.token, "the public store needs no sign-in");
            assert!((lane.accepts)(&Version::parse("0.10.0").unwrap()));
            assert!((lane.accepts)(&Version::parse("0.9.0-beta.2").unwrap()));
            assert!(!(lane.accepts)(&Version::parse("0.10.0-super-nightly.3").unwrap()));
        }
        // The super-nightly lane is unchanged: the gateway, the owner's token, its own shape only.
        assert_eq!((SUPER_NIGHTLY.origin, SUPER_NIGHTLY.prefix, SUPER_NIGHTLY.feed), ("https://markie-nightly.zvndev.com", "/private-releases/super-nightly/", "super-nightly-mac.yml"));
        assert!(SUPER_NIGHTLY.token && !SUPER_NIGHTLY.block_maps);
        assert!(!(SUPER_NIGHTLY.accepts)(&Version::parse("0.10.0").unwrap()));
    }
}
