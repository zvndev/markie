//! The rs-nightly feed, read as strictly as the gateway writes it.
//!
//! The file is the small YAML subset the gateway itself accepts on publish
//! (`parseFeed` in zvndev/markie server/src/private-releases.ts): no tags, no
//! anchors, no nesting beyond the one `files` list. Anything else is refused
//! rather than guessed at, so a feed this app acts on is one the gateway
//! validated.

use crate::version::NightlyVersion;

/// The gateway's cap on a feed file.
pub const MAX_FEED_BYTES: usize = 64 * 1024;
/// The gateway's cap on one artifact: 512 MiB.
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// The one file an rs-nightly version consists of.
pub fn artifact_name(version: &NightlyVersion) -> String {
    format!("Markie-Nightly-{version}-arm64.zip")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feed {
    pub version: NightlyVersion,
    /// `Markie-Nightly-<version>-arm64.zip`, never a path or a URL.
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
    #[error("the update feed's version is not a nightly version")]
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
}

pub fn parse(bytes: &[u8]) -> Result<Feed, FeedError> {
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

    let version = version.and_then(NightlyVersion::parse).ok_or(FeedError::Version)?;
    let expected = artifact_name(&version);
    // One version is one file, so the list is exactly that file, and the
    // top-level `path` and `sha512` (electron-builder's legacy pair) repeat it.
    let [entry] = files.as_slice() else { return Err(FeedError::Artifact) };
    if entry.url != expected || path != Some(expected.as_str()) {
        return Err(FeedError::Artifact);
    }
    let sha512 = entry.sha512.filter(|s| is_sha512(s)).ok_or(FeedError::Integrity)?;
    let size = entry.size.and_then(size).ok_or(FeedError::Integrity)?;
    if top_sha != Some(sha512) {
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
        let name = format!("Markie-Nightly-{version}-arm64.zip");
        let hash = sha(data);
        format!(
            "version: {version}\nfiles:\n  - url: {name}\n    sha512: {hash}\n    size: {}\npath: {name}\nsha512: {hash}\nreleaseDate: '2026-11-24T18:00:00.000Z'\n",
            data.len()
        )
    }

    const V: &str = "0.1.0-rs-nightly.7";
    const DATA: &[u8] = b"synthetic nightly bytes";

    #[test]
    fn reads_the_feed_the_publisher_writes() {
        let feed = parse(feed_text(V, DATA).as_bytes()).unwrap();
        assert_eq!(feed.version.to_string(), V);
        assert_eq!(feed.artifact, "Markie-Nightly-0.1.0-rs-nightly.7-arm64.zip");
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
    fn refuses_every_feed_the_gateway_would_refuse() {
        let good = feed_text(V, DATA);
        let name = "Markie-Nightly-0.1.0-rs-nightly.7-arm64.zip";
        let hash = sha(DATA);
        let cases: Vec<(String, FeedError)> = vec![
            (good.replace(&format!("version: {V}"), "version: 0.1.0"), FeedError::Version),
            (good.replace(&format!("version: {V}"), "version: 0.1.0-super-nightly.7"), FeedError::Version),
            (good.replace(&format!("version: {V}"), "version: 0.1.0-rs-nightly.8"), FeedError::Artifact),
            (good.replace(&format!("version: {V}\n"), ""), FeedError::Version),
            (good.replace(&format!("- url: {name}"), &format!("- url: https://evil.example/{name}")), FeedError::Artifact),
            (good.replace(&format!("- url: {name}"), &format!("- url: ../{name}")), FeedError::Artifact),
            (good.replace(&format!("- url: {name}"), "- url: Markie-0.9.4-super-nightly.1-arm64-mac.zip"), FeedError::Artifact),
            (good.replace(&format!("path: {name}"), "path: latest-mac.yml"), FeedError::Artifact),
            (good.replace(&format!("path: {name}\n"), ""), FeedError::Artifact),
            (good.replace("files:\n", ""), FeedError::Syntax),
            (good.replace(&format!("  - url: {name}\n    sha512: {hash}\n    size: {}\n", DATA.len()), ""), FeedError::Artifact),
            (good.replace("files:\n", &format!("files:\n  - url: {name}\n    sha512: {hash}\n    size: {}\n", DATA.len())), FeedError::Artifact),
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
