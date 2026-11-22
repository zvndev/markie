#![cfg(unix)]

use markie_agent::{
    COMMENTS_UNAVAILABLE,
    bridge::{Bridge, DISCOVERY, SOCKET},
};
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

#[test]
fn real_node_mcp_and_client_only_reach_the_scratch_bridge() {
    // sockaddr_un is small on macOS; prefer a short scratch location.
    let scratch = tempfile::tempdir_in("/tmp").unwrap();
    let file = scratch.path().join("fixture.md");
    fs::write(&file, "# Scratch fixture\n").unwrap();
    let bridge = Bridge::start(scratch.path(), |req| {
        if req.method.starts_with("comments_") {
            return Err(COMMENTS_UNAVAILABLE.into());
        }
        Ok(json!({"method":req.method, "params":req.params}))
    })
    .unwrap();
    let dir = scratch.path().join("agent");
    assert_eq!(
        bridge.discovery(),
        dir.canonicalize().unwrap().join(DISCOVERY)
    );
    for (path, mode) in [
        (&dir, 0o700),
        (&dir.join(SOCKET), 0o600),
        (&dir.join(DISCOVERY), 0o600),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
    assert!(Bridge::start(scratch.path(), |_| Ok(json!(null))).is_err());
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/bridge-client.mjs"))
        .arg(scratch.path())
        .env("HOME", scratch.path())
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .output()
        .expect("Node is required for the MCP compatibility gate");
    assert!(
        output.status.success(),
        "Node compatibility checks failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    drop(bridge);
    assert!(!dir.join(SOCKET).exists());
    assert!(!dir.join(DISCOVERY).exists());
}
