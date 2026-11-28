//! The update feed, read as strictly as the channel publishes it.
//!
//! The file is electron-builder's update feed, in the small YAML subset the
//! gateway itself accepts on publish (`parseFeed` in zvndev/markie
//! server/src/private-releases.ts): no tags, no anchors, no nesting beyond the
//! one `files` list. electron-updater in an installed Electron super-nightly
//! reads the same file. Anything else is refused rather than guessed at, so a
//! feed this app acts on is one the gateway validated.
//!
//! The public feeds are electron-builder's own output for both Mac
//! architectures: an x64 ZIP and DMG for Intel Macs (Electron) and an arm64
//! ZIP and DMG (Markie RS). Only the arm64 ZIP of the feed's version is ever
//! taken; the other entries must be well formed and are otherwise ignored.

use crate::version::Version;
use crate::Lane;

/// The gateway's cap on a feed file.
pub const MAX_FEED_BYTES: usize = 64 * 1024;
/// The gateway's cap on one artifact: 512 MiB.
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// The file this Mac takes from a version: the arm64 ZIP, named as
/// electron-builder names it (`${productName}-${version}-${arch}.${ext}`).
pub fn artifact_name(version: &Version) -> String {
    format!("Markie-{version}-arm64.zip")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feed {
    pub version: Version,
    /// `Markie-<version>-arm64.zip`, never a path or a URL.
    pub artifact: String,
    /// Base64 SHA-512 of the artifact.
    pub sha512: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FeedError {
    #[error("the update feed is too large")]
    TooLarge,
    #[error("the update feed is not valid text")]
    Encoding,
    #[error("the update feed has a line this app does not understand")]
    Syntax,
    #[error("the update feed repeats a field")]
    Duplicate,
    #[error("the update feed's version is not one this channel publishes")]
    Version,
    #[error("the update feed does not name exactly this version's download")]
    Artifact,
    #[error("the update feed's checksum or size is not valid")]
    Integrity,
}

fn scalar(raw: &str) -> &str {
    let quoted = raw.len() >= 2
        && ((raw.starts_with('\'') && raw.ends_with('\'')) || (raw.starts_with('"') && raw.ends_with('"')));
    if quoted { &raw[1..raw.len() - 1] } else { raw }
}

/// 86 base64 characters and `==`: 64 bytes.
fn is_sha512(text: &str) -> bool {
    text.len() == 88
        && text.ends_with("==")
        && text[..86].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn size(text: &str) -> Option<u64> {
    let plain = !text.is_empty() && text.len() <= 12 && text.bytes().all(|b| b.is_ascii_digit()) && !text.starts_with('0');
    let n: u64 = plain.then(|| text.parse().ok()).flatten()?;
    (n <= MAX_ARTIFACT_BYTES).then_some(n)
}

#[derive(Default)]
struct Entry<'a> {
    url: &'a str,
    sha512: Option<&'a str>,
    size: Option<&'a str>,
    block_map: Option<()>,
}

/// The super-nightly feed.
pub fn parse(bytes: &[u8]) -> Result<Feed, FeedError> {
    parse_for(bytes, &crate::SUPER_NIGHTLY)
}

/// A feed of `lane`: its version shapes, and `blockMapSize` where the lane has it.
pub fn parse_for(bytes: &[u8], lane: &Lane) -> Result<Feed, FeedError> {
    if bytes.len() > MAX_FEED_BYTES {
        return Err(FeedError::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| FeedError::Encoding)?.replace("\r\n", "\n");
    if text.chars().any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}')) {
        return Err(FeedError::Syntax);
    }
    let (mut version, mut path, mut top_sha, mut release_date) = (None, None, None, None);
    let mut files: Vec<Entry> = Vec::new();
    let (mut saw_files, mut in_files) = (false, false);
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        if line == "files:" {
            if saw_files {
                return Err(FeedError::Duplicate);
            }
            (saw_files, in_files) = (true, true);
            continue;
        }
        if in_files {
            if let Some(url) = line.strip_prefix("  - url: ") {
                if files.len() >= 32 {
                    return Err(FeedError::Syntax);
                }
                files.push(Entry { url: scalar(url), ..Default::default() });
                continue;
            }
            if lane.block_maps
                && let (Some(value), Some(entry)) = (line.strip_prefix("    blockMapSize: "), files.last_mut())
            {
                if entry.block_map.is_some() {
                    return Err(FeedError::Duplicate);
                }
                size(scalar(value)).ok_or(FeedError::Integrity)?;
                entry.block_map = Some(());
                continue;
            }
            let property = line
                .strip_prefix("    sha512: ")
                .map(|v| (true, v))
                .or_else(|| line.strip_prefix("    size: ").map(|v| (false, v)));
            if let (Some((is_sha, value)), Some(entry)) = (property, files.last_mut()) {
                let slot = if is_sha { &mut entry.sha512 } else { &mut entry.size };
                if slot.is_some() {
                    return Err(FeedError::Duplicate);
                }
                *slot = Some(scalar(value));
                continue;
            }
        }
        let (key, value) = line.split_once(": ").ok_or(FeedError::Syntax)?;
        let slot = match key {
            "version" => &mut version,
            "path" => &mut path,
            "sha512" => &mut top_sha,
            "releaseDate" => &mut release_date,
            _ => return Err(FeedError::Syntax),
        };
        if value.is_empty() {
            return Err(FeedError::Syntax);
        }
        if slot.is_some() {
            return Err(FeedError::Duplicate);
        }
        *slot = Some(scalar(value));
        in_files = false;
    }

    let version = version.and_then(Version::parse).filter(|v| (lane.accepts)(v)).ok_or(FeedError::Version)?;
    let expected = artifact_name(&version);
    // A feed may list more than one file (an Electron build can carry an x64
    // ZIP too). Every name must be a plain file name, none repeated, and this
    // Mac's file, the arm64 ZIP of this version, must be there.
    let plain = |name: &str| {
        !name.is_empty()
            && name.len() <= 200
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            && !name.starts_with(['.', '-'])
            && !name.contains("..")
    };
    if files.is_empty() || !files.iter().all(|f| plain(f.url)) {
        return Err(FeedError::Artifact);
    }
    for (at, file) in files.iter().enumerate() {
        if files[..at].iter().any(|earlier| earlier.url == file.url) {
            return Err(FeedError::Duplicate);
        }
    }
    let entry = files.iter().find(|f| f.url == expected).ok_or(FeedError::Artifact)?;
    let sha512 = entry.sha512.filter(|s| is_sha512(s)).ok_or(FeedError::Integrity)?;
    let size = entry.size.and_then(size).ok_or(FeedError::Integrity)?;
    // The top-level `path` and `sha512` (electron-builder's legacy pair) name
    // one of the listed files, with that file's hash.
    let legacy = files.iter().find(|f| Some(f.url) == path).ok_or(FeedError::Artifact)?;
    if top_sha.is_none() || top_sha != legacy.sha512 {
        return Err(FeedError::Integrity);
    }
    if release_date.is_some_and(|d| d.len() > 40 || !d.bytes().all(|b| b.is_ascii_alphanumeric() || b"-:.+".contains(&b))) {
        return Err(FeedError::Syntax);
    }
    Ok(Feed { version, artifact: expected, sha512: sha512.to_string(), size })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::Engine as _;
    use sha2::Digest as _;

    pub(crate) fn sha(data: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(data))
    }

    /// The text the publisher writes and the gateway serves.
    pub(crate) fn feed_text(version: &str, data: &[u8]) -> String {
        let name = format!("Markie-{version}-arm64.zip");
        let hash = sha(data);
        format!(
            "version: {version}\nfiles:\n  - url: {name}\n    sha512: {hash}\n    size: {}\npath: {name}\nsha512: {hash}\nreleaseDate: '2026-11-24T18:00:00.000Z'\n",
            data.len()
        )
    }

    const V: &str = "0.1.0-super-nightly.7";
    const DATA: &[u8] = b"synthetic nightly bytes";

    /// A public feed as electron-builder writes it for both Mac
    /// architectures: x64 and arm64 ZIPs, then x64 and arm64 DMGs, with the
    /// legacy pair naming the x64 ZIP. Made-up bytes; the shape is the one on
    /// the public store.
    pub(crate) fn public_feed_text(version: &str, arm: &[u8], intel: &[u8]) -> String {
        let entry = |name: String, data: &[u8]| format!("  - url: {name}\n    sha512: {}\n    size: {}\n", sha(data), data.len());
        format!(
            "version: {version}\nfiles:\n{}{}{}{}path: Markie-{version}-x64.zip\nsha512: {}\nreleaseDate: 2026-11-20T05:31:25.494Z\n",
            entry(format!("Markie-{version}-x64.zip"), intel),
            entry(format!("Markie-{version}-arm64.zip"), arm),
            entry(format!("Markie-{version}-x64.dmg"), b"intel dmg"),
            entry(format!("Markie-{version}-arm64.dmg"), b"arm dmg"),
            sha(intel),
        )
    }

    const P: &str = "0.10.0";
    const ARM: &[u8] = b"synthetic markie rs zip";
    const INTEL: &[u8] = b"synthetic electron x64 zip, longer";

    #[test]
    fn a_public_feed_gives_the_arm64_zip_and_nothing_else() {
        for lane in [&crate::PUBLIC_STABLE, &crate::PUBLIC_EARLY] {
            let feed = parse_for(public_feed_text(P, ARM, INTEL).as_bytes(), lane).unwrap();
            assert_eq!(feed.version.to_string(), P);
            assert_eq!(feed.artifact, "Markie-0.10.0-arm64.zip");
            assert_eq!((feed.sha512.as_str(), feed.size), (sha(ARM).as_str(), ARM.len() as u64));
            // The legacy early-access shape and a release candidate read too.
            for version in ["0.10.1-beta.2", "0.10.0-rc.1"] {
                assert_eq!(parse_for(public_feed_text(version, ARM, INTEL).as_bytes(), lane).unwrap().version.to_string(), version);
            }
        }
    }

    #[test]
    fn a_public_feed_without_an_arm64_zip_offers_nothing_even_with_an_x64_zip_or_an_arm64_dmg() {
        let lane = &crate::PUBLIC_STABLE;
        let good = public_feed_text(P, ARM, INTEL);
        let arm_zip = format!("  - url: Markie-{P}-arm64.zip\n    sha512: {}\n    size: {}\n", sha(ARM), ARM.len());
        // Electron's old Intel-only feed: an x64 ZIP and DMG.
        let intel_only = good.replace(&arm_zip, "").replace(&format!("  - url: Markie-{P}-arm64.dmg\n    sha512: {}\n    size: 7\n", sha(b"arm dmg")), "");
        assert_eq!(parse_for(intel_only.as_bytes(), lane), Err(FeedError::Artifact));
        // An arm64 DMG is not the ZIP: the updater never takes a disk image.
        assert_eq!(parse_for(good.replace(&arm_zip, "").as_bytes(), lane), Err(FeedError::Artifact));
        // An x64 file named as if it were arm64 is still checked by its own hash and size.
        let swapped = good.replace(&format!("sha512: {}\n    size: {}\n  - url: Markie-{P}-x64.dmg", sha(ARM), ARM.len()), &format!("sha512: {}\n    size: {}\n  - url: Markie-{P}-x64.dmg", sha(INTEL), INTEL.len()));
        let feed = parse_for(swapped.as_bytes(), lane).unwrap();
        assert_eq!((feed.sha512, feed.size), (sha(INTEL), INTEL.len() as u64), "the download is held to these, and the bundle check refuses an Intel Electron app");
        // Universal or other names are not this Mac's file either.
        assert_eq!(parse_for(good.replace(&format!("Markie-{P}-arm64.zip"), &format!("Markie-{P}-universal.zip")).as_bytes(), lane), Err(FeedError::Artifact));
        assert_eq!(parse_for(good.replace(&format!("Markie-{P}-arm64.zip"), &format!("Markie-{P}-arm64-mac.zip")).as_bytes(), lane), Err(FeedError::Artifact));
    }

    #[test]
    fn each_lane_reads_only_its_own_versions_and_fields() {
        let public = public_feed_text(P, ARM, INTEL);
        assert_eq!(parse(public.as_bytes()), Err(FeedError::Version), "the nightly never takes a public release");
        let nightly = feed_text(V, DATA);
        assert_eq!(parse_for(nightly.as_bytes(), &crate::PUBLIC_STABLE), Err(FeedError::Version), "the public app never takes a super-nightly");
        for bad in ["0.10.0-alpha.1", "0.10.0+build.7", "v0.10.0", "0.10"] {
            assert_eq!(parse_for(public.replace(&format!("version: {P}"), &format!("version: {bad}")).as_bytes(), &crate::PUBLIC_STABLE), Err(FeedError::Version), "{bad}");
        }
        // blockMapSize, as electron-builder writes it under a differential ZIP: public only.
        let mapped = public.replace(&format!("    size: {}\n  - url: Markie-{P}-x64.dmg", ARM.len()), &format!("    size: {}\n    blockMapSize: 117234\n  - url: Markie-{P}-x64.dmg", ARM.len()));
        assert!(mapped.contains("blockMapSize"));
        assert_eq!(parse_for(mapped.as_bytes(), &crate::PUBLIC_STABLE).unwrap().artifact, "Markie-0.10.0-arm64.zip");
        assert_eq!(parse_for(mapped.replace("blockMapSize: 117234", "blockMapSize: lots").as_bytes(), &crate::PUBLIC_STABLE), Err(FeedError::Integrity));
        assert_eq!(parse_for(mapped.replace("    blockMapSize: 117234\n", "    blockMapSize: 1\n    blockMapSize: 2\n").as_bytes(), &crate::PUBLIC_STABLE), Err(FeedError::Duplicate));
        let nightly_mapped = nightly.replace(&format!("    size: {}\n", DATA.len()), &format!("    size: {}\n    blockMapSize: 117234\n", DATA.len()));
        assert_eq!(parse(nightly_mapped.as_bytes()), Err(FeedError::Syntax));
    }

    #[test]
    fn reads_the_feed_the_publisher_writes() {
        let feed = parse(feed_text(V, DATA).as_bytes()).unwrap();
        assert_eq!(feed.version.to_string(), V);
        assert_eq!(feed.artifact, "Markie-0.1.0-super-nightly.7-arm64.zip");
        assert_eq!(feed.sha512, sha(DATA));
        assert_eq!(feed.size, DATA.len() as u64);
        // Windows line endings and no release date read the same.
        let crlf = feed_text(V, DATA).replace('\n', "\r\n");
        assert_eq!(parse(crlf.as_bytes()).unwrap(), feed);
        let undated = feed_text(V, DATA).replace("releaseDate: '2026-11-24T18:00:00.000Z'\n", "");
        assert_eq!(parse(undated.as_bytes()).unwrap(), feed);
        let quoted = feed_text(V, DATA).replace(&format!("version: {V}"), &format!("version: \"{V}\""));
        assert_eq!(parse(quoted.as_bytes()).unwrap(), feed);
    }

    #[test]
    fn takes_the_arm64_zip_from_a_feed_that_lists_more_than_one_file() {
        // An Electron super-nightly built for both architectures.
        let (arm, intel) = (b"arm64 bytes".as_slice(), b"x64 bytes, longer".as_slice());
        let text = format!(
            "version: {V}\nfiles:\n  - url: Markie-{V}-x64.zip\n    sha512: {x}\n    size: {xs}\n  - url: Markie-{V}-arm64.zip\n    sha512: {a}\n    size: {as_}\npath: Markie-{V}-x64.zip\nsha512: {x}\nreleaseDate: '2026-11-24T18:00:00.000Z'\n",
            x = sha(intel), xs = intel.len(), a = sha(arm), as_ = arm.len()
        );
        let feed = parse(text.as_bytes()).unwrap();
        assert_eq!(feed.artifact, format!("Markie-{V}-arm64.zip"));
        assert_eq!((feed.sha512.as_str(), feed.size), (sha(arm).as_str(), arm.len() as u64));
        // With no arm64 file there is nothing for this Mac.
        let intel_only = feed_text(V, DATA).replace("-arm64.zip", "-x64.zip");
        assert_eq!(parse(intel_only.as_bytes()), Err(FeedError::Artifact));
        // The legacy pair must still name a listed file with its own hash.
        assert_eq!(parse(text.replace(&format!("path: Markie-{V}-x64.zip"), "path: other.zip").as_bytes()), Err(FeedError::Artifact));
        assert_eq!(parse(text.replace(&format!("\nsha512: {}", sha(intel)), &format!("\nsha512: {}", sha(arm))).as_bytes()), Err(FeedError::Integrity));
    }

    #[test]
    fn refuses_every_feed_the_gateway_would_refuse() {
        let good = feed_text(V, DATA);
        let name = "Markie-0.1.0-super-nightly.7-arm64.zip";
        let hash = sha(DATA);
        let cases: Vec<(String, FeedError)> = vec![
            (good.replace(&format!("version: {V}"), "version: 0.1.0"), FeedError::Version),
            (good.replace(&format!("version: {V}"), "version: 0.1.0-rs-nightly.7"), FeedError::Version),
            (good.replace(&format!("version: {V}"), "version: 0.1.0-super-nightly.8"), FeedError::Artifact),
            (good.replace(&format!("version: {V}\n"), ""), FeedError::Version),
            (good.replace(&format!("- url: {name}"), &format!("- url: https://evil.example/{name}")), FeedError::Artifact),
            (good.replace(&format!("- url: {name}"), &format!("- url: ../{name}")), FeedError::Artifact),
            (good.replace(&format!("- url: {name}"), "- url: Markie-0.9.4-rs-nightly.1-arm64-mac.zip"), FeedError::Artifact),
            (good.replace(&format!("path: {name}"), "path: latest-mac.yml"), FeedError::Artifact),
            (good.replace(&format!("path: {name}\n"), ""), FeedError::Artifact),
            (good.replace("files:\n", ""), FeedError::Syntax),
            (good.replace(&format!("  - url: {name}\n    sha512: {hash}\n    size: {}\n", DATA.len()), ""), FeedError::Artifact),
            (good.replace("files:\n", &format!("files:\n  - url: {name}\n    sha512: {hash}\n    size: {}\n", DATA.len())), FeedError::Duplicate),
            (good.replace(&format!("size: {}", DATA.len()), "size: 0"), FeedError::Integrity),
            (good.replace(&format!("size: {}", DATA.len()), "size: 023"), FeedError::Integrity),
            (good.replace(&format!("size: {}", DATA.len()), "size: -23"), FeedError::Integrity),
            (good.replace(&format!("size: {}", DATA.len()), "size: 1e3"), FeedError::Integrity),
            (good.replace(&format!("size: {}", DATA.len()), &format!("size: {}", MAX_ARTIFACT_BYTES + 1)), FeedError::Integrity),
            (good.replace(&format!("    size: {}\n", DATA.len()), ""), FeedError::Integrity),
            (good.replace(&format!("    sha512: {hash}"), "    sha512: not-a-hash"), FeedError::Integrity),
            (good.replace(&format!("    sha512: {hash}"), &format!("    sha512: {}", sha(b"other"))), FeedError::Integrity),
            (good.replace(&format!("\nsha512: {hash}"), &format!("\nsha512: {}", sha(b"other"))), FeedError::Integrity),
            (format!("{good}path: duplicate.zip\n"), FeedError::Duplicate),
            (format!("{good}files:\n"), FeedError::Duplicate),
            (good.replace(&format!("    size: {}\n", DATA.len()), &format!("    size: {0}\n    size: {0}\n", DATA.len())), FeedError::Duplicate),
            (good.replace("files:", "files: &anchor"), FeedError::Syntax),
            (good.replace("files:", "files: !!seq"), FeedError::Syntax),
            (good.replace("releaseDate:", "unknownField:"), FeedError::Syntax),
            (good.replace("releaseDate: '2026-11-24T18:00:00.000Z'", "releaseDate: '$(reboot)'"), FeedError::Syntax),
            (format!("{good}\u{1}"), FeedError::Syntax),
            (format!("{good}{{\"json\": true}}\n"), FeedError::Syntax),
            (String::new(), FeedError::Version),
            ("<html>Not found</html>".to_string(), FeedError::Syntax),
        ];
        for (text, want) in cases {
            assert_eq!(parse(text.as_bytes()), Err(want), "{text}");
        }
        assert_eq!(parse(&[0xff, 0xfe, 0x00]), Err(FeedError::Encoding));
        assert_eq!(parse(&vec![b'a'; MAX_FEED_BYTES + 1]), Err(FeedError::TooLarge));
    }
}
