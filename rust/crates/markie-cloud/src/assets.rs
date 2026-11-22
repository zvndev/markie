//! Local media discovery, version-guarded upload, and revalidated downloads.
use crate::docs::DocsClient;
use crate::error::{CloudError, Result};
use crate::sync::hash_content;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const MAX_ASSET_BYTES: usize = 95_000_000;
pub(crate) const MAX_EXTRACT_CHARS: usize = 4 * 1024 * 1024;
const MAX_REFS: usize = 2000;
const MAX_LINK_BYTES: usize = 1024 * 1024;

static CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\x60{3}.*?\x60{3}|~~~.*?~~~|\x60[^\x60\n]*\x60").unwrap());
static IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"!\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)>]{1,2048}))(?:\s+"[^"]*")?\s*\)"#).unwrap()
});
static HTML: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)<(?:img|video|audio|source)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#,
    )
    .unwrap()
});
static URI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap());

pub(crate) fn without_code(text: &str) -> Option<std::borrow::Cow<'_, str>> {
    (text.encode_utf16().take(MAX_EXTRACT_CHARS + 1).count() <= MAX_EXTRACT_CHARS)
        .then(|| CODE.replace_all(text, ""))
}

pub(crate) fn decoded_ref(src: &str) -> Option<String> {
    if src.starts_with("//") || URI.is_match(src) {
        return None;
    }
    let src = src.trim().split(['?', '#']).next()?;
    let decoded = percent_encoding::percent_decode_str(src)
        .decode_utf8()
        .ok()?;
    (!decoded.is_empty() && decoded.len() <= 2048 && !decoded.bytes().any(|b| b.is_ascii_control()))
        .then(|| decoded.into_owned())
}

pub(crate) fn destinations<'a>(
    re: &Regex,
    text: &'a str,
) -> impl Iterator<Item = (usize, &'a str)> {
    re.captures_iter(text).filter_map(|c| {
        Some((
            c.get(0)?.start(),
            c.iter().skip(1).flatten().next()?.as_str(),
        ))
    })
}

pub fn references(text: &str) -> Vec<String> {
    let Some(text) = without_code(text) else {
        return Vec::new();
    };
    let mut found: Vec<_> = destinations(&IMAGE, &text)
        .chain(destinations(&HTML, &text))
        .collect();
    found.sort_by_key(|(at, _)| *at);
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter_map(|(_, src)| decoded_ref(src))
        .filter(|r| seen.insert(r.clone()))
        .collect()
}

pub fn mime(reference: &str) -> Option<&'static str> {
    let ext = Path::new(reference)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => return None,
    })
}

fn escapes(reference: &str) -> bool {
    let mut r = std::borrow::Cow::Borrowed(reference);
    for _ in 0..3 {
        let Ok(decoded) = percent_encoding::percent_decode_str(&r).decode_utf8() else {
            break;
        };
        if decoded == r {
            break;
        }
        r = std::borrow::Cow::Owned(decoded.into_owned());
    }
    if r.starts_with(['/', '\\']) || r.as_bytes().get(1) == Some(&b':') {
        return true;
    }
    let mut depth = 0;
    for part in r.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." if depth == 0 => return true,
            ".." => depth -= 1,
            _ => depth += 1,
        }
    }
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skipped {
    #[serde(rename = "ref")]
    pub reference: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Transfer {
    pub fingerprint: Option<String>,
    pub refused: Option<u16>,
    pub skipped: Vec<Skipped>,
}

#[derive(Serialize)]
struct AssetRef {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
}

struct Entry {
    at: usize,
    path: PathBuf,
    mime: &'static str,
}

fn fingerprint(refs: &[AssetRef]) -> String {
    let mut lines: Vec<_> = refs
        .iter()
        .map(|r| format!("{}\t{}", r.reference, r.hash.as_deref().unwrap_or_default()))
        .collect();
    lines.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    hash_content(&lines.join("\n"))
}

fn skipped(reference: &str, reason: &str) -> Skipped {
    Skipped {
        reference: reference.into(),
        reason: reason.into(),
    }
}

fn collect(
    file: &Path,
    content: &str,
    roots: &[PathBuf],
    private: bool,
) -> (Vec<AssetRef>, Vec<Entry>, Vec<Skipped>) {
    let folder = file.parent().and_then(|p| p.canonicalize().ok());
    let roots: Vec<_> = if private {
        roots.iter().filter_map(|r| r.canonicalize().ok()).collect()
    } else {
        Vec::new()
    };
    let mut refs = Vec::new();
    let mut entries = Vec::new();
    let mut dropped = Vec::new();
    let mut cost = 64;
    let mut overflow = false;
    for reference in references(content) {
        cost += serde_json::to_string(&reference).map_or(2048, |s| s.len()) + 83;
        overflow |= refs.len() >= MAX_REFS || cost > MAX_LINK_BYTES;
        if overflow {
            if dropped.len() < MAX_REFS {
                dropped.push(skipped(&reference, "count"));
            }
            continue;
        }
        if !private && escapes(&reference) {
            dropped.push(skipped(&reference, "outside"));
            continue;
        }
        let at = refs.len();
        let mut push = AssetRef {
            reference: reference.clone(),
            hash: None,
        };
        let result = (|| {
            let media = mime(&reference).ok_or("type")?;
            let folder = folder.as_ref().ok_or("outside")?;
            let path = folder
                .join(&reference)
                .canonicalize()
                .map_err(|_| "outside")?;
            if !path.starts_with(folder) && !roots.iter().any(|r| path.starts_with(r)) {
                return Err("outside");
            }
            let meta = path.metadata().map_err(|_| "outside")?;
            if !meta.is_file() {
                return Err("outside");
            }
            if meta.len() > MAX_ASSET_BYTES as u64 {
                return Err("size");
            }
            let mut hash = Sha256::new();
            let stream = File::open(&path).map_err(|_| "outside")?;
            let n = std::io::copy(&mut stream.take(MAX_ASSET_BYTES as u64 + 1), &mut hash)
                .map_err(|_| "outside")?;
            if n > MAX_ASSET_BYTES as u64 {
                return Err("size");
            }
            push.hash = Some(hex::encode(hash.finalize()));
            Ok(Entry {
                at,
                path,
                mime: media,
            })
        })();
        match result {
            Ok(entry) => entries.push(entry),
            Err(reason) => dropped.push(skipped(&reference, reason)),
        }
        refs.push(push);
    }
    (refs, entries, dropped)
}

/// Reconcile media for an acknowledged snapshot. No upload is attempted from
/// a collocated path outside the allowed roots, even when exposure is unknown.
pub async fn reconcile(
    docs: &DocsClient<'_>,
    id: &str,
    version: i64,
    file: &Path,
    content: &str,
    roots: &[PathBuf],
    private: bool,
    previous: &Transfer,
) -> Result<Transfer> {
    let (mut refs, entries, mut dropped) = collect(file, content, roots, private);
    let attempted = fingerprint(&refs);
    if previous.fingerprint.as_deref() == Some(&attempted) {
        return Ok(previous.clone());
    }
    if !entries.is_empty() {
        let mut hashes: Vec<_> = refs.iter().filter_map(|r| r.hash.clone()).collect();
        hashes.sort_unstable();
        hashes.dedup();
        // Bound the request independently of the reference count.
        let mut needed = HashSet::new();
        for chunk in hashes.chunks(256) {
            let response = docs.missing_assets(id, chunk).await?;
            let missing: Vec<String> = serde_json::from_value(
                response
                    .get("missing")
                    .cloned()
                    .ok_or(CloudError::Unreadable)?,
            )
            .map_err(|_| CloudError::Unreadable)?;
            needed.extend(missing);
        }
        let mut refused = HashSet::new();
        for entry in entries {
            let reference = &mut refs[entry.at];
            let hash = reference.hash.clone().expect("collected media has a hash");
            if refused.contains(&hash) {
                dropped.push(skipped(&reference.reference, "type or size"));
                reference.hash = None;
                continue;
            }
            if !needed.remove(&hash) {
                continue;
            }
            let mut attempt = 0;
            loop {
                let mut bytes = Vec::new();
                File::open(&entry.path)
                    .and_then(|f| f.take(MAX_ASSET_BYTES as u64 + 1).read_to_end(&mut bytes))
                    .map_err(|_| CloudError::Invalid("A local asset could not be read.".into()))?;
                if bytes.len() > MAX_ASSET_BYTES || hex::encode(Sha256::digest(&bytes)) != hash {
                    return Err(CloudError::Invalid(
                        "A local asset changed during upload.".into(),
                    ));
                }
                match docs
                    .put_asset(&hash, bytes, entry.mime)
                    .await
                    .and_then(|a| a.into_ok())
                {
                    Ok(_) => break,
                    Err(e) if matches!(e.status(), Some(413 | 415)) => {
                        dropped.push(skipped(
                            &reference.reference,
                            if e.status() == Some(413) {
                                "size"
                            } else {
                                "type"
                            },
                        ));
                        refused.insert(hash);
                        reference.hash = None;
                        break;
                    }
                    Err(e)
                        if attempt >= 2
                            || matches!(e, CloudError::StaleSession | CloudError::NotSignedIn)
                            || e.status() == Some(503) =>
                    {
                        return Err(e);
                    }
                    Err(_) => {
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
                    }
                }
            }
        }
    }
    let answer = docs
        .link_assets(id, json!({"refs": refs, "baseVersion": version}))
        .await?;
    let refused = match answer.status {
        400 | 413 | 415 | 422 => Some(answer.status),
        _ => {
            let value = answer.json()?;
            if let Some(rows) = value.get("droppedRefs").and_then(|v| v.as_array()) {
                for row in rows {
                    if let (Some(r), Some(reason)) = (row["ref"].as_str(), row["reason"].as_str()) {
                        dropped.push(skipped(
                            r,
                            if reason == "escaping" {
                                "outside"
                            } else {
                                "type"
                            },
                        ));
                    }
                }
            }
            None
        }
    };
    Ok(Transfer {
        fingerprint: Some(attempted),
        refused,
        skipped: dropped,
    })
}

/// Downloads and revalidates references in the single shared media cache.
pub async fn revalidate(
    docs: &DocsClient<'_>,
    cache: &crate::asset_cache::AssetCache,
    account: &str,
    origin: &str,
    id: &str,
    reference: &str,
) -> Result<PathBuf> {
    let expected = mime(reference).ok_or(CloudError::Refused)?;
    let key = cache.key(account, origin, id, reference).ok_or(CloudError::StaleSession)?;
    let lock = cache.request(&key);
    let mut request = lock.lock().await;
    docs.check_asset_scope(account, origin)?;
    let now = markie_core::clock::now_ms();
    let bad_cache = |error: std::io::Error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            CloudError::StaleSession
        } else {
            CloudError::Unreadable
        }
    };
    let previous = cache.lookup(&key, now, false).map_err(bad_cache)?;
    if let Some(result) = request.as_ref() {
        return match result {
            Ok(_) => previous.map(|(path, _)| path).ok_or(CloudError::Unreadable),
            Err(error) => Err(error.clone()),
        };
    }
    let result = async {
        if let Some((path, entry)) = &previous && entry.fresh(now) { return Ok(path.clone()); }
        let tag = previous.as_ref().map(|(_, entry)| format!("\"{}\"", entry.hash));
        let retain = |failure| {
            docs.check_asset_scope(account, origin)?;
            cache.lookup(&key, markie_core::clock::now_ms(), false).map_err(bad_cache)?
                .map(|(path, _)| path).ok_or(failure)
        };
        let answer = match docs.fetch_asset(id, reference, tag.as_deref()).await {
            Ok(answer) => answer,
            Err(error @ (CloudError::Offline | CloudError::TooLarge)) => return retain(error),
            Err(error) => return Err(error),
        };
        if answer.status == 304 {
            return cache.lookup(&key, markie_core::clock::now_ms(), true).map_err(bad_cache)?
                .map(|(path, _)| path).ok_or(CloudError::Unreadable);
        }
        if matches!(answer.status, 401 | 403 | 404 | 410) {
            cache.forget(&key).map_err(bad_cache)?;
        } else if answer.status >= 500 {
            return retain(answer.into_ok().unwrap_err());
        }

        let answer = answer.into_ok()?;
        let Some(hash) = answer.etag.as_deref().and_then(parse_etag) else { return retain(CloudError::Unreadable) };
        if answer.content_type.as_deref() != Some(expected) || answer.bytes.len() > MAX_ASSET_BYTES {
            return retain(CloudError::Unreadable);
        }
        // A failed replacement does not displace a good retained copy. The cache
        // checks the session generation before serving or committing either one.
        match cache.store(key.clone(), expected, hash, &answer.bytes, markie_core::clock::now_ms()).map_err(bad_cache) {
            Err(CloudError::Unreadable) => retain(CloudError::Unreadable),
            result => result,
        }
    }.await;
    *request = Some(result.clone());
    result
}

fn parse_etag(tag: &str) -> Option<&str> {
    let value = tag.strip_prefix('"')?.strip_suffix('"')?;
    crate::asset_cache::valid_hash(value).then_some(value)
}

/// Never overwrite a pre-existing name, including an unresolvable symlink.
pub fn create_copy(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_media_in_order_without_code_or_lazy_attributes() {
        let src = r#"<video src="clip.mp4"></video> ![x](<a%20b.png?x#y> "title")
<img data-src="ignored.png" SRC='other.svg'> ![](https://a/x.png) ![](a%20b.png)"#;
        let src = format!("{src}\n\x60![](code.png)\x60\n~~~\n![](fence.png)\n~~~");
        assert_eq!(references(&src), ["clip.mp4", "a b.png", "other.svg"]);
    }

    #[tokio::test]
    async fn asset_cache_revalidates_retains_and_forgets_like_electron() {
        use crate::asset_cache::{AssetCache, CACHE_VALID_FOR};
        use crate::client::CloudClient;
        use crate::origin::Trust;
        use crate::tokens::{MemoryTokenStore, Session, TokenStore};
        use std::sync::{Arc, RwLock};
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let origin = server.uri();
        let tokens = Arc::new(MemoryTokenStore::new());
        tokens.put(&origin, Some(&Session { token: "synthetic".into(), user_id: Some("alice".into()) })).unwrap();
        let trust = Arc::new(RwLock::new(Trust::new([], true)));
        let client = CloudClient::new(&origin, trust, tokens, crate::http::Transport::new()).unwrap();
        let docs = DocsClient::new(&client);
        let dir = tempfile::tempdir().unwrap();
        let cache = AssetCache::for_account(dir.path(), "alice", &origin).unwrap();
        let key = cache.key("alice", &origin, "doc_1", "pic.png").unwrap();
        let hash = hash_content("synthetic asset");
        let tag = format!("\"{hash}\"");
        let stale_at = || markie_core::clock::now_ms() - CACHE_VALID_FOR.as_millis() as i64 - 1;
        let seed = || cache.store(key.clone(), "image/png", &hash, b"synthetic asset", stale_at()).unwrap();
        let retained = seed();
        Mock::given(method("GET")).and(path("/api/docs/doc_1/assets/file")).and(header("if-none-match", tag.as_str()))
            .respond_with(ResponseTemplate::new(304)).expect(1).mount(&server).await;
        for _ in 0..2 {
            assert_eq!(revalidate(&docs, &cache, "alice", &origin, "doc_1", "pic.png").await.unwrap(), retained);
        }
        server.verify().await;
        server.reset().await;
        seed();
        Mock::given(method("GET")).and(path("/api/docs/doc_1/assets/file")).and(header("if-none-match", tag.as_str()))
            .respond_with(ResponseTemplate::new(503).set_delay(std::time::Duration::from_millis(25)))
            .expect(1).mount(&server).await;
        let fetch = || revalidate(&docs, &cache, "alice", &origin, "doc_1", "pic.png");
        let (first, second) = tokio::join!(fetch(), fetch());
        assert_eq!(first.unwrap(), retained);
        assert_eq!(second.unwrap(), retained);
        assert!(!cache.lookup(&key, markie_core::clock::now_ms(), false).unwrap().unwrap().1.fresh(markie_core::clock::now_ms()));
        server.verify().await;
        server.reset().await;
        Mock::given(method("GET")).and(path("/api/docs/doc_1/assets/file")).and(header("if-none-match", tag.as_str()))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "image/png")
                .insert_header("etag", tag.as_str()).set_body_bytes(b"wrong bytes".to_vec()))
            .expect(1).mount(&server).await;
        assert_eq!(revalidate(&docs, &cache, "alice", &origin, "doc_1", "pic.png").await.unwrap(), retained);
        assert_eq!(fs::read(&retained).unwrap(), b"synthetic asset");
        server.verify().await;
        for status in [401, 403, 404, 410] {
            server.reset().await;
            seed();
            Mock::given(method("GET")).and(path("/api/docs/doc_1/assets/file")).and(header("if-none-match", tag.as_str()))
                .respond_with(ResponseTemplate::new(status)).expect(1).mount(&server).await;
            assert_eq!(revalidate(&docs, &cache, "alice", &origin, "doc_1", "pic.png").await.unwrap_err().status(), Some(status));
            assert!(!retained.exists());
            server.verify().await;
        }
    }

    #[tokio::test]
    async fn an_offline_copy_still_requires_an_active_account() {
        use crate::asset_cache::{AssetCache, CACHE_VALID_FOR};
        use crate::client::CloudClient;
        use crate::origin::Trust;
        use crate::tokens::{MemoryTokenStore, Session, TokenStore};
        use std::sync::{Arc, RwLock};

        let origin = "http://127.0.0.1:0";
        let tokens = Arc::new(MemoryTokenStore::new());
        tokens.put(origin, Some(&Session { token: "synthetic".into(), user_id: Some("alice".into()) })).unwrap();
        let trust = Arc::new(RwLock::new(Trust::new([], true)));
        let client = CloudClient::new(origin, trust, tokens.clone(), crate::http::Transport::new()).unwrap();
        let docs = DocsClient::new(&client);
        let dir = tempfile::tempdir().unwrap();
        let cache = AssetCache::for_account(dir.path(), "alice", origin).unwrap();
        let key = cache.key("alice", origin, "doc_1", "pic.png").unwrap();
        let cached = cache.store(
            key, "image/png", &hash_content("synthetic asset"), b"synthetic asset",
            markie_core::clock::now_ms() - CACHE_VALID_FOR.as_millis() as i64 - 1,
        ).unwrap();
        assert_eq!(revalidate(&docs, &cache, "alice", origin, "doc_1", "pic.png").await.unwrap(), cached);
        tokens.put(origin, None).unwrap();
        assert_eq!(revalidate(&docs, &cache, "alice", origin, "doc_1", "pic.png").await.unwrap_err(), CloudError::NotSignedIn);
    }

    #[test]
    fn exposure_refuses_encoded_escapes_and_symlinks() {
        assert!(escapes("%252e%252e/x.png"));
        assert!(escapes("a\\..\\..\\x.png"));
        assert!(!escapes("a/../x.png"));
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("doc");
        fs::create_dir(&folder).unwrap();
        fs::write(root.path().join("x.png"), b"test").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path().join("x.png"), folder.join("alias.png")).unwrap();
        let from = folder.join("readme.md");
        let content = "![](../x.png) ![](alias.png)";
        let (_, exposed, _) = collect(&from, content, &[root.path().into()], false);
        assert!(exposed.is_empty());
        let (_, private, _) = collect(&from, content, &[root.path().into()], true);
        assert_eq!(private.len(), if cfg!(unix) { 2 } else { 1 });
    }
}
