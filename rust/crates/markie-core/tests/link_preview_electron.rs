//! Markie RS's link preview rules against Electron's, on the same inputs.
//! The fixture is Electron's own output (`rust/scripts/parity/link-preview-cases.mjs`).

use markie_core::link_preview::{is_private_address, parse_meta, parse_target};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/link_preview_electron.json")).unwrap()
}

fn opt(v: &Value) -> Option<String> {
    v.as_str().map(String::from)
}

#[test]
fn parse_meta_matches_electron() {
    let mut bad = Vec::new();
    for case in fixture()["meta"].as_array().unwrap() {
        let html = case["html"].as_str().unwrap();
        let ours = parse_meta(html);
        let e = &case["out"];
        let theirs = (opt(&e["title"]), opt(&e["description"]), opt(&e["siteName"]), opt(&e["imageUrl"]));
        let mine = (ours.title, ours.description, ours.site_name, ours.image_url);
        if mine != theirs {
            bad.push(format!("{html:?}\n  electron {theirs:?}\n  rs       {mine:?}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn parse_target_matches_electron() {
    let mut bad = Vec::new();
    for case in fixture()["targets"].as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        let mine = parse_target(url).map(|u| u.to_string());
        let theirs = opt(&case["out"]);
        if mine != theirs {
            bad.push(format!("{:?}: electron {theirs:?}, rs {mine:?}", &url[..url.len().min(80)]));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// Electron reads the second group of a compressed IPv6 address (`3fff::1`)
/// as `parseInt("", 16)`, which is NaN, so its range checks on that group
/// never fire. Markie RS reads the address as the address it is, and refuses
/// these: stricter, never looser.
const STRICTER_THAN_ELECTRON: &[&str] = &["3fff::1"];

#[test]
fn private_addresses_match_electron() {
    let mut bad = Vec::new();
    for case in fixture()["private"].as_array().unwrap() {
        let a = case["address"].as_str().unwrap();
        let (mine, theirs) = (is_private_address(a.parse().unwrap()), case["out"].as_bool().unwrap());
        if STRICTER_THAN_ELECTRON.contains(&a) {
            assert!(mine && !theirs, "{a} is no longer a known difference");
        } else if mine != theirs {
            bad.push(format!("{a}: electron {theirs}, rs {mine}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
