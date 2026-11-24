//! `X.Y.Z-super-nightly.N`, the version shape of the super-nightly channel
//! (`privateSettings` in zvndev/markie scripts/private-release.mjs; the gateway
//! allows more, the channel's publishers do not use it).

use std::fmt;

/// Ordered by X, Y, Z, then N: a later nightly of the same base is newer, and
/// any nightly of a later base is newer than every nightly of an earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NightlyVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub build: u64,
}

const MARKER: &str = "-super-nightly.";

/// A plain number: no sign, no leading zero, short enough never to overflow.
fn number(text: &str) -> Option<u64> {
    let plain = !text.is_empty() && text.len() <= 15 && text.bytes().all(|b| b.is_ascii_digit());
    if !plain || (text.len() > 1 && text.starts_with('0')) {
        return None;
    }
    text.parse().ok()
}

impl NightlyVersion {
    pub fn parse(text: &str) -> Option<Self> {
        let (base, build) = text.split_once(MARKER)?;
        let mut parts = base.split('.');
        let (major, minor, patch) = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
        if parts.next().is_some() {
            return None;
        }
        Some(Self { major, minor, patch, build: number(build)? })
    }
}

impl fmt::Display for NightlyVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}{MARKER}{}", self.major, self.minor, self.patch, self.build)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_lanes_exact_shape_and_round_trips() {
        let v = NightlyVersion::parse("0.1.0-super-nightly.7").unwrap();
        assert_eq!(v, NightlyVersion { major: 0, minor: 1, patch: 0, build: 7 });
        assert_eq!(v.to_string(), "0.1.0-super-nightly.7");
        assert_eq!(NightlyVersion::parse("12.34.56-super-nightly.0").unwrap().to_string(), "12.34.56-super-nightly.0");
        for bad in [
            "", "0.1.0", "0.1.0-super-nightly", "0.1.0-super-nightly.", "0.1.0-super-nightly.07", "0.1.0-super-nightly.7.1",
            "0.1.0-super-nightly.x", "0.1.0-super-nightly.-1", "0.1.0-super-nightly.+1", "0.1.0-super-nightly. 7", " 0.1.0-super-nightly.7",
            "0.1.0-super-nightly.7\n", "0.1-super-nightly.7", "0.1.0.0-super-nightly.7", "01.1.0-super-nightly.7", "0.1.0-rs-nightly.7",
            "0.1.0-RS-NIGHTLY.7", "v0.1.0-super-nightly.7", "0.1.0-super-nightly.7-super-nightly.8", "0.1.0-super-nightly.9999999999999999",
            "٠.1.0-super-nightly.7",
        ] {
            assert_eq!(NightlyVersion::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn orders_by_base_version_then_build() {
        let v = |s| NightlyVersion::parse(s).unwrap();
        assert!(v("0.1.0-super-nightly.10") > v("0.1.0-super-nightly.9"), "numeric, not text");
        assert!(v("0.1.1-super-nightly.1") > v("0.1.0-super-nightly.99"));
        assert!(v("0.2.0-super-nightly.1") > v("0.1.9-super-nightly.99"));
        assert!(v("1.0.0-super-nightly.0") > v("0.99.99-super-nightly.99"));
        assert_eq!(v("0.1.0-super-nightly.7"), v("0.1.0-super-nightly.7"));
    }
}
