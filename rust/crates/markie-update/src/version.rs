//! The version shapes Markie's Mac channels publish, ordered as semver orders
//! them (electron-updater compares with `semver`, so both apps agree on what
//! is newer):
//!
//! - `X.Y.Z-super-nightly.N`, the super-nightly channel (`privateSettings` in
//!   zvndev/markie scripts/private-release.mjs);
//! - `X.Y.Z`, a public release, on the stable feed and, before its soak ends,
//!   on the early-access feed under the same number;
//! - `X.Y.Z-beta.N`, the legacy early-access shape, and `X.Y.Z-rc.N`, a
//!   release candidate built for testing.
//!
//! Anything else (build metadata, other tags, leading zeros) is refused rather
//! than guessed at. Which shapes a channel takes is `Lane::accepts`.

use std::fmt;

/// A prerelease tag. The order is semver's: tags compare as ASCII text, and
/// "beta" < "rc" < "super-nightly".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tag {
    Beta,
    Rc,
    SuperNightly,
}

impl Tag {
    fn text(self) -> &'static str {
        match self {
            Tag::Beta => "beta",
            Tag::Rc => "rc",
            Tag::SuperNightly => "super-nightly",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "beta" => Some(Tag::Beta),
            "rc" => Some(Tag::Rc),
            "super-nightly" => Some(Tag::SuperNightly),
            _ => None,
        }
    }
}

/// Ordered by X, Y, Z, then a release above every prerelease of the same
/// X.Y.Z, then the tag, then N as a number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// None for a release.
    pub pre: Option<(Tag, u64)>,
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre, other.pre) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => a.cmp(&b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// A plain number: no sign, no leading zero, short enough never to overflow.
fn number(text: &str) -> Option<u64> {
    let plain = !text.is_empty() && text.len() <= 15 && text.bytes().all(|b| b.is_ascii_digit());
    if !plain || (text.len() > 1 && text.starts_with('0')) {
        return None;
    }
    text.parse().ok()
}

impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        let (base, pre) = match text.split_once('-') {
            Some((base, pre)) => {
                // The tag is everything up to the last dot; "super-nightly" has a dash of its own.
                let (tag, build) = pre.rsplit_once('.')?;
                (base, Some((Tag::parse(tag)?, number(build)?)))
            }
            None => (text, None),
        };
        let mut parts = base.split('.');
        let (major, minor, patch) = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
        if parts.next().is_some() {
            return None;
        }
        Some(Self { major, minor, patch, pre })
    }

    pub fn is_super_nightly(&self) -> bool {
        matches!(self.pre, Some((Tag::SuperNightly, _)))
    }

    /// A shape the public feeds carry or a public build reports: a release,
    /// a legacy early-access beta, or a release candidate.
    pub fn is_public(&self) -> bool {
        matches!(self.pre, None | Some((Tag::Beta | Tag::Rc, _)))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some((tag, build)) = self.pre {
            write!(f, "-{}.{build}", tag.text())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_channels_exact_shapes_and_round_trips() {
        let v = Version::parse("0.1.0-super-nightly.7").unwrap();
        assert_eq!(v, Version { major: 0, minor: 1, patch: 0, pre: Some((Tag::SuperNightly, 7)) });
        assert_eq!(v.to_string(), "0.1.0-super-nightly.7");
        for good in ["12.34.56-super-nightly.0", "0.10.0", "0.10.0-rc.1", "0.9.0-beta.3", "1.0.0"] {
            assert_eq!(Version::parse(good).unwrap().to_string(), good);
        }
        for bad in [
            "", "0.1.0-super-nightly", "0.1.0-super-nightly.", "0.1.0-super-nightly.07", "0.1.0-super-nightly.7.1",
            "0.1.0-super-nightly.x", "0.1.0-super-nightly.-1", "0.1.0-super-nightly.+1", "0.1.0-super-nightly. 7", " 0.1.0-super-nightly.7",
            "0.1.0-super-nightly.7\n", "0.1-super-nightly.7", "0.1.0.0-super-nightly.7", "01.1.0-super-nightly.7", "0.1.0-rs-nightly.7",
            "0.1.0-RS-NIGHTLY.7", "v0.1.0-super-nightly.7", "0.1.0-super-nightly.7-super-nightly.8", "0.1.0-super-nightly.9999999999999999",
            "٠.1.0-super-nightly.7", "0.10.0+build.1", "0.10.0-alpha.1", "0.10.0-beta", "0.10.0-rc", "0.10.0-rc.1+x", "0.10", "0.10.0-",
            "0.10.0-Beta.1", "0.10.0 ", "0.10.0-beta.01",
        ] {
            assert_eq!(Version::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn orders_by_base_version_then_build() {
        let v = |s| Version::parse(s).unwrap();
        assert!(v("0.1.0-super-nightly.10") > v("0.1.0-super-nightly.9"), "numeric, not text");
        assert!(v("0.1.1-super-nightly.1") > v("0.1.0-super-nightly.99"));
        assert!(v("0.2.0-super-nightly.1") > v("0.1.9-super-nightly.99"));
        assert!(v("1.0.0-super-nightly.0") > v("0.99.99-super-nightly.99"));
        assert_eq!(v("0.1.0-super-nightly.7"), v("0.1.0-super-nightly.7"));
        // The bridge from Electron: 0.10.0 is above every 0.9.x.
        assert!(v("0.10.0-super-nightly.1") > v("0.9.8-super-nightly.2"));
    }

    #[test]
    fn orders_public_versions_as_semver_does() {
        let v = |s| Version::parse(s).unwrap();
        // A release is above its own prereleases, and below the next patch's.
        assert!(v("0.10.0") > v("0.10.0-rc.1"));
        assert!(v("0.10.0") > v("0.10.0-beta.9"));
        assert!(v("0.10.0-rc.1") > v("0.10.0-beta.9"), "\"rc\" > \"beta\" as text");
        assert!(v("0.10.0-rc.10") > v("0.10.0-rc.2"));
        assert!(v("0.10.1-beta.1") > v("0.10.0"));
        assert!(v("0.10.0") > v("0.9.7"));
        assert!(v("0.10.0-rc.1") > v("0.9.7"), "the release candidate sees the last Electron release as older");
        assert!(v("0.10.0") > v("0.10.0-super-nightly.8"));
        assert!(v("0.10.0").is_public() && v("0.10.0-rc.1").is_public() && v("0.9.0-beta.2").is_public());
        assert!(!v("0.10.0-super-nightly.1").is_public());
        assert!(v("0.10.0-super-nightly.1").is_super_nightly() && !v("0.10.0").is_super_nightly());
    }
}
