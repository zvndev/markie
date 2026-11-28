//! The path agents were set up with for Electron Markie,
//! `node /Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs`,
//! reaches the Rust app's bridge in the public Mac app.
//!
//! The Resources folder is laid out by the same script the bundle uses
//! (`scripts/stage-mcp.sh`): Electron's server at the pinned commit, the
//! adapter, the hand-over at `mcp/markie-mcp.mjs` and the identity file. The
//! test then talks MCP JSON-RPC over stdio to `node mcp/markie-mcp.mjs`, with
//! a scratch HOME, and checks every bridge call lands on a real Rust `Bridge`
//! in the data folder the build names.
//!
//! In the default build the bridge answers as "Markie RS", so the identity
//! file is left out and the adapter takes the dev build's folder. Run with
//! `--features markie-core/public` for the public app's exact identity:
//!
//!   cargo test -p markie-agent --test public_mcp
//!   cargo test -p markie-agent --features markie-core/public --test public_mcp
#![cfg(unix)]

use markie_agent::bridge::{Bridge, DISCOVERY, SOCKET};
use markie_core::paths;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

fn stage(resources: &Path) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/stage-mcp.sh");
    let output = Command::new("bash").arg(&script).arg(resources).output().unwrap();
    assert!(output.status.success(), "stage-mcp.sh failed: {}", String::from_utf8_lossy(&output.stderr));
}

struct Mcp {
    child: std::process::Child,
    lines: std::io::Lines<BufReader<std::process::ChildStdout>>,
    next_id: u64,
}

impl Mcp {
    fn start(entry: &Path, home: &Path) -> Self {
        let mut child = Command::new("node")
            .arg(entry)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("Node is required for the MCP gate");
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Self { child, lines, next_id: 1 }
    }

    fn ask(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let stdin = self.child.stdin.as_mut().unwrap();
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        let line = self.lines.next().expect("the MCP server answered").unwrap();
        let answer: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(answer["id"], id, "{line}");
        answer
    }

    fn call(&mut self, tool: &str, arguments: Value) -> Value {
        self.ask("tools/call", json!({"name": tool, "arguments": arguments}))["result"].clone()
    }

    fn text(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    fn finish(mut self) {
        drop(self.child.stdin.take());
        let status = self.child.wait().unwrap();
        assert!(status.success(), "the MCP server exited with {status}");
    }
}

#[test]
fn the_electron_mcp_path_reaches_the_rust_bridge_over_stdio() {
    // sockaddr_un is small on macOS: keep the scratch home short.
    let scratch = tempfile::tempdir_in("/tmp").unwrap();
    let home = scratch.path().canonicalize().unwrap();
    let resources = home.join("Markie.app/Contents/Resources");
    stage(&resources);
    if !paths::PUBLIC {
        // The bridge in this test binary answers as the dev build.
        std::fs::remove_file(resources.join("app-identity.json")).unwrap();
    }

    // The data folder the build names, under the scratch home, as macOS lays it out.
    let base = if cfg!(target_os = "macos") { home.join("Library/Application Support") } else { home.join(".local/share") };
    let data: PathBuf = base.join(paths::PROFILE_NAME);
    let document = home.join("Documents/plan.md");
    std::fs::create_dir_all(document.parent().unwrap()).unwrap();
    std::fs::write(&document, "# A made-up plan\n\nShip the public lane.\n").unwrap();

    let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let log = seen.clone();
    let bridge = Bridge::start(&data, move |request| {
        log.lock().unwrap().push((request.method.clone(), request.params.clone()));
        Ok(json!({"answeredBy": paths::APP_NAME, "method": request.method}))
    })
    .unwrap();
    assert!(data.join("agent").join(SOCKET).exists() && data.join("agent").join(DISCOVERY).exists());

    // The path in people's MCP settings.
    let entry = resources.join("mcp/markie-mcp.mjs");
    let mut mcp = Mcp::start(&entry, &home);
    let init = mcp.ask("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "public-lane-test", "version": "1"}}));
    assert!(init["result"]["serverInfo"]["name"].as_str().unwrap_or_default().contains("markie"), "{init}");
    let tools = mcp.ask("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    for name in ["markie_read_document", "markie_open_in_markie", "markie_cloud_status", "markie_cloud_sync"] {
        assert!(names.contains(&name), "{name} in {names:?}");
    }

    let path = document.to_str().unwrap();
    // Bridge calls go to the Rust app.
    let status = mcp.call("markie_cloud_status", json!({"path": path}));
    assert!(Mcp::text(&status).contains("cloud_status") && Mcp::text(&status).contains(paths::APP_NAME), "{status}");
    let opened = mcp.call("markie_open_in_markie", json!({"path": path}));
    assert!(Mcp::text(&opened).contains("open_in_markie"), "{opened}");
    // Local file tools work without the app, through Electron's own code.
    let read = mcp.call("markie_read_document", json!({"path": path}));
    assert!(Mcp::text(&read).contains("Ship the public lane."), "{read}");
    mcp.finish();

    let calls = seen.lock().unwrap().clone();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(methods, ["cloud_status", "open_in_markie"]);
    assert_eq!(calls[1].1["path"], path);

    // With the app quit, the same path says so, and does not start Electron or anything else.
    drop(bridge);
    let mut mcp = Mcp::start(&entry, &home);
    let closed = mcp.call("markie_open_in_markie", json!({"path": path}));
    assert_eq!(closed["isError"], true, "{closed}");
    assert!(Mcp::text(&closed).contains(&format!("{} isn't running", paths::APP_NAME)), "{closed}");
    mcp.finish();
}

#[test]
fn the_bundled_server_is_electrons_own_at_the_pinned_commit() {
    let scratch = tempfile::tempdir().unwrap();
    let resources = scratch.path().join("Resources");
    stage(&resources);
    let pin = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/mcp/PIN")).unwrap();
    assert_eq!(std::fs::read_to_string(resources.join("mcp-server/COMMIT")).unwrap().trim(), pin.trim());
    // Byte for byte the file at that commit.
    let at_pin = Command::new("git").args(["show", &format!("{}:mcp/markie-mcp.mjs", pin.trim())]).current_dir(env!("CARGO_MANIFEST_DIR")).output().unwrap();
    assert!(at_pin.status.success());
    assert_eq!(std::fs::read(resources.join("mcp-server/markie-mcp.mjs")).unwrap(), at_pin.stdout);
    // The entry agents run is the hand-over, never Electron's server with Electron's discovery.
    let entry = std::fs::read_to_string(resources.join("mcp/markie-mcp.mjs")).unwrap();
    assert!(entry.contains("../markie-rs-mcp.mjs"));
    assert_eq!(std::fs::read_dir(resources.join("mcp")).unwrap().count(), 1, "only the hand-over sits in mcp/");
    assert_eq!(std::fs::read_to_string(resources.join("app-identity.json")).unwrap(), "{\"appName\":\"Markie\",\"profileName\":\"Markie App\"}\n");
}
