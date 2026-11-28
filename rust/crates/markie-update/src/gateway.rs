//! The two requests the updater makes: the feed, and the ZIP it names.
//!
//! Both go to the lane's origin under the lane prefix, and neither follows a
//! redirect: a redirect is how a trusted address turns into one nobody
//! reviewed, and on the private gateway it would carry the token along. The
//! private gateway gets the bearer token; the public store never gets one.

use crate::feed::{self, Feed, MAX_FEED_BYTES};
use crate::Lane;
use base64::Engine as _;
use sha2::Digest as _;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("the update server could not be reached")]
    Offline,
    #[error("the update server answered {0}")]
    Status(u16),
    #[error(transparent)]
    Feed(#[from] feed::FeedError),
    #[error("the download does not match the update feed")]
    Integrity,
    #[error("the download could not be saved: {0}")]
    Io(#[from] std::io::Error),
}

/// What the gateway said about the feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedAnswer {
    /// 404: this token is not the owner's, or nothing is published. The
    /// gateway answers both the same way on purpose.
    NotAvailable,
    Feed(Feed),
}

/// The shape the gateway accepts (`requireOwner`); anything else is never sent.
pub fn sendable_token(token: &str) -> bool {
    let body = token.trim_end_matches('=');
    token.len() - body.len() <= 2
        && (1..=4096).contains(&body.len())
        && body.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~+/-".contains(&b))
}

pub struct Gateway {
    origin: String,
    lane: &'static Lane,
    client: reqwest::blocking::Client,
}

impl Gateway {
    /// The reviewed super-nightly gateway, HTTPS only.
    pub fn production(user_agent: &str) -> Option<Self> {
        Self::for_lane(&crate::SUPER_NIGHTLY, user_agent)
    }

    /// A lane's reviewed origin, HTTPS only.
    pub fn for_lane(lane: &'static Lane, user_agent: &str) -> Option<Self> {
        Self::build(lane.origin, lane, true, user_agent)
    }

    /// A mock super-nightly gateway on this computer, for tests.
    #[cfg(test)]
    pub(crate) fn at(origin: &str) -> Self {
        Self::at_lane(origin, &crate::SUPER_NIGHTLY)
    }

    /// A mock of `lane` on this computer, for tests.
    #[cfg(test)]
    pub(crate) fn at_lane(origin: &str, lane: &'static Lane) -> Self {
        Self::build(origin, lane, false, "markie-update-tests").expect("test client")
    }

    pub fn lane(&self) -> &'static Lane {
        self.lane
    }

    fn build(origin: &str, lane: &'static Lane, https_only: bool, user_agent: &str) -> Option<Self> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(https_only)
            .connect_timeout(Duration::from_secs(15))
            .user_agent(user_agent)
            .build()
            .ok()?;
        Some(Self { origin: origin.trim_end_matches('/').to_string(), lane, client })
    }

    /// `token` is sent only to a lane that takes one.
    fn get(&self, name: &str, token: Option<&str>, timeout: Duration) -> Result<reqwest::blocking::Response, GatewayError> {
        let url = format!("{}{}{name}", self.origin, self.lane.prefix);
        let mut request = self.client.get(&url).header("Accept-Encoding", "identity").timeout(timeout);
        if let Some(token) = token.filter(|_| self.lane.token) {
            request = request.bearer_auth(token);
        }
        let response = request.send().map_err(|_| GatewayError::Offline)?;
        // Redirects are off, so a 3xx arrives as itself and is refused below.
        // This also holds if a proxy on the way answered for another address.
        if response.url().as_str() != url {
            return Err(GatewayError::Status(response.status().as_u16()));
        }
        Ok(response)
    }

    pub fn feed(&self, token: Option<&str>) -> Result<FeedAnswer, GatewayError> {
        let response = self.get(self.lane.feed, token, Duration::from_secs(30))?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 | 404 => return Ok(FeedAnswer::NotAvailable),
            other => return Err(GatewayError::Status(other)),
        }
        if response.content_length().is_some_and(|n| n > MAX_FEED_BYTES as u64) {
            return Err(feed::FeedError::TooLarge.into());
        }
        let mut bytes = Vec::new();
        response.take(MAX_FEED_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| GatewayError::Offline)?;
        Ok(FeedAnswer::Feed(feed::parse_for(&bytes, self.lane)?))
    }

    /// Download the feed's artifact to `dest`, which must not exist. The file
    /// is there afterwards only if its size and SHA-512 are the feed's.
    pub fn download(&self, token: Option<&str>, feed: &Feed, dest: &Path) -> Result<(), GatewayError> {
        let mut response = self.get(&feed.artifact, token, Duration::from_secs(30 * 60))?;
        if response.status().as_u16() != 200 {
            return Err(GatewayError::Status(response.status().as_u16()));
        }
        if response.content_length().is_some_and(|n| n != feed.size) {
            return Err(GatewayError::Integrity);
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(dest)?;
        let result = (|| {
            let mut hash = sha2::Sha512::new();
            let mut received: u64 = 0;
            let mut buffer = vec![0u8; 256 * 1024];
            loop {
                let n = response.read(&mut buffer).map_err(|_| GatewayError::Offline)?;
                if n == 0 {
                    break;
                }
                received += n as u64;
                if received > feed.size {
                    return Err(GatewayError::Integrity);
                }
                hash.update(&buffer[..n]);
                file.write_all(&buffer[..n])?;
            }
            file.sync_all()?;
            let digest = base64::engine::general_purpose::STANDARD.encode(hash.finalize());
            if received != feed.size || digest != feed.sha512 {
                return Err(GatewayError::Integrity);
            }
            Ok(())
        })();
        drop(file);
        if result.is_err() {
            let _ = std::fs::remove_file(dest);
        }
        result
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::feed::tests::feed_text;
    use crate::{FEED_NAME, GATEWAY_ORIGIN, LANE_PREFIX};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    pub(crate) const TOKEN: &str = "synthetic-owner-token";
    const V: &str = "0.1.0-super-nightly.7";
    const ZIP: &[u8] = b"synthetic zip bytes, not a real archive";

    /// A mock gateway on its own runtime, so the blocking client can call it
    /// from the test thread.
    pub(crate) struct Mocked {
        pub runtime: tokio::runtime::Runtime,
        pub server: MockServer,
    }

    impl Mocked {
        pub fn start() -> Self {
            let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
            let server = runtime.block_on(MockServer::start());
            Self { runtime, server }
        }
        pub fn mount(&self, mock: Mock) {
            self.runtime.block_on(mock.mount(&self.server));
        }
        pub fn gateway(&self) -> Gateway {
            Gateway::at(&self.server.uri())
        }
        /// The owner's feed and artifact, as the real gateway serves them.
        pub fn publish(&self, version: &str, zip: &[u8]) {
            let name = format!("Markie-{version}-arm64.zip");
            self.mount(
                Mock::given(method("GET"))
                    .and(path(format!("{LANE_PREFIX}{FEED_NAME}")))
                    .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
                    .respond_with(ResponseTemplate::new(200).set_body_string(feed_text(version, zip))),
            );
            self.mount(
                Mock::given(method("GET"))
                    .and(path(format!("{LANE_PREFIX}{name}")))
                    .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
                    .respond_with(ResponseTemplate::new(200).set_body_bytes(zip.to_vec())),
            );
        }
        pub fn public_gateway(&self, lane: &'static Lane) -> Gateway {
            Gateway::at_lane(&self.server.uri(), lane)
        }
        /// A public feed and both ZIPs it lists, served to anyone, as the
        /// public store serves them.
        pub fn publish_public(&self, lane: &Lane, version: &str, arm: &[u8], intel: &[u8]) {
            self.mount(
                Mock::given(method("GET"))
                    .and(path(format!("{}{}", lane.prefix, lane.feed)))
                    .respond_with(ResponseTemplate::new(200).set_body_string(crate::feed::tests::public_feed_text(version, arm, intel))),
            );
            for (arch, bytes) in [("arm64", arm), ("x64", intel)] {
                self.mount(
                    Mock::given(method("GET"))
                        .and(path(format!("{}Markie-{version}-{arch}.zip", lane.prefix)))
                        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.to_vec())),
                );
            }
        }
        pub fn requests(&self) -> Vec<wiremock::Request> {
            self.runtime.block_on(self.server.received_requests()).unwrap_or_default()
        }
    }

    #[test]
    fn the_owner_gets_the_feed_and_everyone_else_gets_nothing() {
        let mocked = Mocked::start();
        mocked.publish(V, ZIP);
        let gateway = mocked.gateway();
        let FeedAnswer::Feed(feed) = gateway.feed(Some(TOKEN)).unwrap() else { panic!("the owner's feed") };
        assert_eq!(feed.version.to_string(), V);
        // wiremock answers an unmatched request 404, as the real gateway
        // answers a token that is not the owner's.
        assert_eq!(gateway.feed(Some("someone-elses-token")).unwrap(), FeedAnswer::NotAvailable);
        for request in mocked.requests() {
            assert!(request.url.path().starts_with(LANE_PREFIX), "{}", request.url);
        }
    }

    #[test]
    fn a_redirect_is_refused_and_never_followed_with_the_token() {
        let mocked = Mocked::start();
        let elsewhere = Mocked::start();
        elsewhere.publish(V, ZIP);
        for status in [301, 302, 307, 308] {
            let location = format!("{}{LANE_PREFIX}{FEED_NAME}", elsewhere.server.uri());
            mocked.runtime.block_on(mocked.server.reset());
            mocked.mount(Mock::given(method("GET")).respond_with(ResponseTemplate::new(status).insert_header("location", location.as_str())));
            assert!(matches!(mocked.gateway().feed(Some(TOKEN)), Err(GatewayError::Status(s)) if s == status));
            let feed = feed::parse(feed_text(V, ZIP).as_bytes()).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let dest = dir.path().join("download.zip");
            assert!(matches!(mocked.gateway().download(Some(TOKEN), &feed, &dest), Err(GatewayError::Status(s)) if s == status));
            assert!(!dest.exists());
        }
        assert!(elsewhere.requests().is_empty(), "the other server must never hear from us");
    }

    #[test]
    fn server_errors_and_bad_feeds_are_errors_not_updates() {
        let mocked = Mocked::start();
        for status in [200u16, 206, 418, 500, 503] {
            mocked.runtime.block_on(mocked.server.reset());
            mocked.mount(Mock::given(method("GET")).respond_with(ResponseTemplate::new(status).set_body_string("<html>maintenance</html>")));
            let answer = mocked.gateway().feed(Some(TOKEN));
            if status == 200 {
                assert!(matches!(answer, Err(GatewayError::Feed(_))), "{answer:?}");
            } else {
                assert!(matches!(answer, Err(GatewayError::Status(s)) if s == status), "{answer:?}");
            }
        }
        mocked.runtime.block_on(mocked.server.reset());
        mocked.mount(Mock::given(method("GET")).respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'a'; MAX_FEED_BYTES + 10])));
        assert!(matches!(mocked.gateway().feed(Some(TOKEN)), Err(GatewayError::Feed(feed::FeedError::TooLarge))));
        // Nothing listening at all.
        let dead = Gateway::at("http://127.0.0.1:9");
        assert!(matches!(dead.feed(Some(TOKEN)), Err(GatewayError::Offline)));
    }

    #[test]
    fn a_download_is_kept_only_when_size_and_sha512_match_the_feed() {
        let dir = tempfile::tempdir().unwrap();
        let feed = feed::parse(feed_text(V, ZIP).as_bytes()).unwrap();
        let serve = |body: Vec<u8>| {
            let mocked = Mocked::start();
            mocked.mount(Mock::given(method("GET")).and(path(format!("{LANE_PREFIX}{}", feed.artifact))).respond_with(ResponseTemplate::new(200).set_body_bytes(body)));
            mocked
        };

        let good = serve(ZIP.to_vec());
        let dest = dir.path().join("good.zip");
        good.gateway().download(Some(TOKEN), &feed, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), ZIP);
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&dest).unwrap().permissions()) & 0o777, 0o600);
        // An existing file is never overwritten.
        assert!(matches!(good.gateway().download(Some(TOKEN), &feed, &dest), Err(GatewayError::Io(_))));
        assert_eq!(std::fs::read(&dest).unwrap(), ZIP);

        let mut flipped = ZIP.to_vec();
        flipped[3] ^= 1;
        let mut longer = ZIP.to_vec();
        longer.extend_from_slice(b"extra");
        for (name, body) in [("flipped", flipped), ("short", ZIP[..ZIP.len() - 1].to_vec()), ("long", longer), ("empty", Vec::new())] {
            let dest = dir.path().join(format!("{name}.zip"));
            assert!(matches!(serve(body).gateway().download(Some(TOKEN), &feed, &dest), Err(GatewayError::Integrity)), "{name}");
            assert!(!dest.exists(), "{name} must leave nothing behind");
        }
        for status in [206u16, 404, 500] {
            let mocked = Mocked::start();
            mocked.mount(Mock::given(method("GET")).respond_with(ResponseTemplate::new(status).set_body_bytes(ZIP.to_vec())));
            let dest = dir.path().join(format!("status-{status}.zip"));
            assert!(matches!(mocked.gateway().download(Some(TOKEN), &feed, &dest), Err(GatewayError::Status(s)) if s == status));
            assert!(!dest.exists());
        }
    }

    #[test]
    fn the_public_lanes_read_their_own_feed_and_never_send_a_token() {
        let (arm, intel) = (b"synthetic arm64 zip".as_slice(), b"synthetic x64 zip, longer".as_slice());
        for (early, feed_name) in [(false, "latest-mac.yml"), (true, "beta-mac.yml")] {
            let lane = crate::public_lane(early);
            let mocked = Mocked::start();
            mocked.publish_public(lane, "0.10.0", arm, intel);
            let gateway = mocked.public_gateway(lane);
            // A token handed in by mistake still never leaves the app.
            let FeedAnswer::Feed(feed) = gateway.feed(Some(TOKEN)).unwrap() else { panic!("the public feed") };
            assert_eq!((feed.version.to_string(), feed.artifact.as_str()), ("0.10.0".to_string(), "Markie-0.10.0-arm64.zip"));
            let dir = tempfile::tempdir().unwrap();
            let dest = dir.path().join("download.zip");
            gateway.download(None, &feed, &dest).unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), arm, "the arm64 ZIP, never the x64 one");
            let requests = mocked.requests();
            let paths: Vec<_> = requests.iter().map(|r| r.url.path().to_string()).collect();
            assert_eq!(paths, [format!("/markie-releases/mac/{feed_name}"), "/markie-releases/mac/Markie-0.10.0-arm64.zip".to_string()]);
            for request in &requests {
                assert!(request.headers.get("authorization").is_none(), "no token goes to the public store");
            }
        }
    }

    #[test]
    fn a_public_feed_that_is_missing_is_no_update_and_a_bad_one_is_an_error() {
        let mocked = Mocked::start();
        let gateway = mocked.public_gateway(&crate::PUBLIC_STABLE);
        assert_eq!(gateway.feed(None).unwrap(), FeedAnswer::NotAvailable, "nothing published answers 404");
        mocked.mount(Mock::given(method("GET")).respond_with(ResponseTemplate::new(200).set_body_string(feed_text(V, ZIP))));
        assert!(matches!(gateway.feed(None), Err(GatewayError::Feed(feed::FeedError::Version))), "a super-nightly feed on the public store is refused");
    }

    #[test]
    fn the_public_production_origin_is_the_store_electron_reads() {
        let gateway = Gateway::for_lane(&crate::PUBLIC_STABLE, "markie-update-tests").unwrap();
        assert_eq!(gateway.origin, "https://s3.us-east-005.backblazeb2.com");
        assert_eq!(gateway.lane(), &crate::PUBLIC_STABLE);
        let plain = Gateway::build("http://127.0.0.1:9", &crate::PUBLIC_STABLE, true, "markie-update-tests").unwrap();
        assert!(matches!(plain.feed(None), Err(GatewayError::Offline)), "HTTPS only");
    }

    #[test]
    fn only_tokens_the_gateway_would_read_are_sent() {
        for good in ["abc", "a.b_c~d+e/f-g", "abc=", "abc==", &"a".repeat(4096)] {
            assert!(sendable_token(good), "{good}");
        }
        for bad in ["", "=", "abc===", "a b", "a\nb", "a\r\nX-Injected: 1", "tökén", "a,b", &"a".repeat(4097)] {
            assert!(!sendable_token(bad), "{bad:?}");
        }
    }

    #[test]
    fn production_is_the_reviewed_https_origin() {
        assert_eq!(GATEWAY_ORIGIN, "https://markie-nightly.zvndev.com");
        let gateway = Gateway::production("markie-update-tests").unwrap();
        assert_eq!(gateway.origin, GATEWAY_ORIGIN);
        // https_only: the production client refuses a plain-http origin outright.
        let plain = Gateway::build("http://127.0.0.1:9", &crate::SUPER_NIGHTLY, true, "markie-update-tests").unwrap();
        assert!(matches!(plain.feed(Some(TOKEN)), Err(GatewayError::Offline)));
    }
}
