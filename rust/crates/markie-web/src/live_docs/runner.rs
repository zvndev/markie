//! The Live Docs dev server (`electron/live-docs-preview.js`): find the
//! project's Darkmown CLI and the user's Node through the login shell, run
//! `darkmown dev` on a loopback port behind a watchdog that dies with Markie,
//! wait until it answers, and stop it by process group.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::json::{self, Json};

pub const DARKMOWN_PACKAGE: &str = "@zvndev/darkmown";
pub const READY_PATH: &str = "/__wd/dev-client.js";
const LOOPBACK: &str = "127.0.0.1";
const MIN_NODE_MAJOR: u32 = 20;
pub const NODE_MISSING_MESSAGE: &str = "Markie could not find Node.js. Darkmown projects run on Node 20 or newer. Install it from nodejs.org or with Homebrew (brew install node), then try again.";
const LOG_LINES: usize = 40;

/// Electron's watchdog, verbatim: it ends the dev server when Markie goes.
pub const WATCHDOG_SCRIPT: &str = "\"use strict\";\nconst { spawn } = require(\"child_process\");\nconst [cli, ...args] = process.argv.slice(1);\nconst child = spawn(process.execPath, [cli, ...args], { stdio: [\"ignore\", \"inherit\", \"inherit\"] });\nlet stopping = false;\nconst stop = () => {\n  if (stopping) return;\n  stopping = true;\n  try { child.kill(\"SIGTERM\"); } catch {}\n  setTimeout(() => { try { child.kill(\"SIGKILL\"); } catch {} process.exit(0); }, 3000).unref();\n};\nprocess.stdin.on(\"end\", stop);\nprocess.stdin.on(\"close\", stop);\nprocess.stdin.on(\"error\", stop);\nprocess.stdin.resume();\nfor (const signal of [\"SIGTERM\", \"SIGINT\", \"SIGHUP\"]) process.on(signal, stop);\nchild.on(\"error\", () => process.exit(1));\nchild.on(\"exit\", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));";

pub struct Checked {
    pub root: PathBuf,
    pub name: String,
    pub reasons: Vec<String>,
}

fn read_package_json(root: &Path) -> Option<Json> {
    let file = root.join("package.json");
    let meta = std::fs::metadata(&file).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    let v = json::parse(&std::fs::read_to_string(file).ok()?)?;
    matches!(v, Json::Obj(_)).then_some(v)
}

fn depends_on_darkmown(pkg: &Json) -> bool {
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].iter().any(|f| pkg.get(f).and_then(|d| d.get(DARKMOWN_PACKAGE)).is_some())
}

/// `checkProjectFolder`: a Darkmown project folder, not the disk or home.
pub fn check_project_folder(candidate: &Path, home: &Path) -> Result<Checked, (&'static str, String)> {
    let s = candidate.to_string_lossy();
    if s.is_empty() || s.len() > 4096 || s.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') || !candidate.is_absolute() {
        return Err(("invalid-path", "Choose a folder on this Mac.".into()));
    }
    let root = std::fs::canonicalize(candidate).map_err(|_| ("missing", "That folder no longer exists.".to_string()))?;
    if !root.is_dir() {
        return Err(("not-a-folder", "Choose a folder, not a file.".into()));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string_lossy().into_owned());
    let home_real = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let holds_home = home_real.ancestors().any(|a| a == root);
    if root.parent().is_none() || holds_home {
        return Err(("too-broad", format!("{name} is not a project folder. Choose the folder that holds the project's site/pages.")));
    }
    let mut reasons = Vec::new();
    if root.join("site/pages").is_dir() {
        reasons.push("has site/pages".to_string());
    }
    if read_package_json(&root).is_some_and(|p| depends_on_darkmown(&p)) {
        reasons.push(format!("depends on {DARKMOWN_PACKAGE}"));
    }
    if reasons.is_empty() {
        return Err(("not-a-project", format!("{name} is not a Darkmown project. It has no site/pages folder, and its package.json does not depend on {DARKMOWN_PACKAGE}.")));
    }
    Ok(Checked { root, name, reasons })
}

/// `findDarkmownCli`.
pub fn find_darkmown_cli(root: &Path) -> Result<PathBuf, (&'static str, String)> {
    let bin = root.join("node_modules/.bin/darkmown");
    if bin.is_file() {
        return Ok(bin);
    }
    if let Some(pkg) = read_package_json(root)
        && pkg.get("name").and_then(Json::as_str) == Some(DARKMOWN_PACKAGE)
        && let Some(own) = pkg.get("bin").and_then(|b| b.get("darkmown")).and_then(Json::as_str)
    {
        let p = root.join(own);
        if p.starts_with(root) && p.is_file() {
            return Ok(p);
        }
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Err(("not-installed", format!("Darkmown is not installed in {name}. Run npm install in that folder, then try again.")))
}

const PATH_PROBE: &str = "echo __MARKIE_PATH__; /usr/bin/printenv PATH; echo __MARKIE_PATH_END__";

/// The last PATH the probe printed.
pub fn parse_path_probe(stdout: &str) -> Option<String> {
    let mut found = None;
    let mut rest = stdout;
    while let Some(a) = rest.find("__MARKIE_PATH__") {
        let after = &rest[a + 15..];
        let after = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n'));
        let Some(after) = after else { break };
        let line_end = after.find(['\r', '\n']).unwrap_or(after.len());
        let tail = &after[line_end..];
        let tail = tail.strip_prefix("\r\n").or_else(|| tail.strip_prefix('\n')).unwrap_or(tail);
        if tail.starts_with("__MARKIE_PATH_END__") {
            found = Some(after[..line_end].to_string());
        }
        rest = &after[line_end..];
    }
    found.map(|f| f.trim().to_string()).filter(|f| !f.is_empty())
}

pub fn find_executable(name: &str, search_path: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    search_path.split(':').filter(|d| d.starts_with('/')).map(|d| Path::new(d).join(name)).find(|c| std::fs::metadata(c).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

pub fn node_major(version: &str) -> Option<u32> {
    let v = version.trim().strip_prefix('v').unwrap_or(version.trim());
    let (major, _) = v.split_once('.')?;
    major.parse().ok()
}

#[derive(Clone, Debug)]
pub struct NodeFound {
    pub node: PathBuf,
    pub version: String,
    pub path: String,
    pub via: String,
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// `resolveNode`: the user's Node through their login shell, version 20 or newer.
pub fn resolve_node() -> Result<NodeFound, (&'static str, String)> {
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    for flags in [&["-l"][..], &["-i", "-l"][..]] {
        let mut cmd = Command::new(&shell);
        cmd.args(flags).arg("-c").arg(PATH_PROBE).env("MARKIE_RESOLVING_ENVIRONMENT", "1");
        let Some(stdout) = run_with_timeout(cmd, Duration::from_secs(10)) else { continue };
        let Some(search) = parse_path_probe(&stdout) else { continue };
        let Some(node) = find_executable("node", &search) else { continue };
        let mut v = Command::new(&node);
        v.arg("--version").env("PATH", &search);
        let version = run_with_timeout(v, Duration::from_secs(5)).unwrap_or_default().trim().to_string();
        let Some(major) = node_major(&version) else { continue };
        if major < MIN_NODE_MAJOR {
            return Err(("node-too-old", format!("Darkmown needs Node {MIN_NODE_MAJOR} or newer. Markie found {version} at {}.", node.display())));
        }
        let base = Path::new(&shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(NodeFound { node, version, path: search, via: format!("{base} {}", flags.join(" ")) });
    }
    Err(("node-missing", NODE_MISSING_MESSAGE.into()))
}

pub fn preview_origin(port: u16) -> String {
    format!("http://{LOOPBACK}:{port}")
}

/// `navigationDecision`: the dev server's own pages stay; web pages open in
/// the browser; everything else is blocked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    External,
    Block,
}

pub fn navigation_decision(target: &str, origin: &str) -> Navigation {
    let Ok(url) = url::Url::parse(target) else { return Navigation::Block };
    if url.scheme() == "http" && url.origin().ascii_serialization() == origin && url.username().is_empty() && url.password().is_none() {
        return Navigation::Allow;
    }
    if external_web_target(target).is_some() { Navigation::External } else { Navigation::Block }
}

/// `externalWebTarget`: an http(s) page with a host and no credentials.
pub fn external_web_target(target: &str) -> Option<String> {
    if target.len() > 8192 || target.chars().any(|c| (c as u32) <= 0x20 || c == '\u{7f}') {
        return None;
    }
    let url = url::Url::parse(target).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty()) && url.username().is_empty() && url.password().is_none()).then(|| url.to_string())
}

fn pick_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind((LOOPBACK, 0))?.local_addr()?.port())
}

/// One HTTP GET of the readiness script: 200 and a JavaScript content type.
pub fn probe_ready(origin: &str) -> bool {
    let Some(addr) = origin.strip_prefix("http://") else { return false };
    let Ok(sock) = addr.parse() else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&sock, Duration::from_millis(1500)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    if s.write_all(format!("GET {READY_PATH} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes()).is_err() {
        return false;
    }
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 16 * 1024 {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
    head.starts_with("http/1.1 200") && head.lines().any(|l| l.starts_with("content-type:") && l.contains("javascript"))
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for d in chars.by_ref() {
                if ('@'..='~').contains(&d) {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

pub struct DevServer {
    child: Child,
    pub origin: String,
    pub port: u16,
    pub cli: PathBuf,
    pub node: NodeFound,
    pub log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl DevServer {
    /// Starts `darkmown dev` for `root` and waits until it answers.
    pub fn start(root: &Path, ready_timeout: Duration) -> Result<DevServer, (&'static str, String, Vec<String>)> {
        let no_log = |(c, m): (&'static str, String)| (c, m, Vec::new());
        let cli = find_darkmown_cli(root).map_err(no_log)?;
        let node = resolve_node().map_err(no_log)?;
        let mut last = None;
        for _attempt in 0..2 {
            let port = pick_port().map_err(|_| ("start-failed", "The Darkmown dev server could not start.".to_string(), vec![]))?;
            let mut cmd = Command::new(&node.node);
            cmd.args(["-e", WATCHDOG_SCRIPT, "--"]).arg(&cli).arg("dev").current_dir(root);
            cmd.env_clear();
            for (k, v) in std::env::vars() {
                if !(k.starts_with("ELECTRON_") || k == "DARKMOWN_ALLOWED_HOSTS" || k == "MARKIE_RESOLVING_ENVIRONMENT") {
                    cmd.env(k, v);
                }
            }
            cmd.env("PATH", &node.path).env("PORT", port.to_string()).env("HOST", LOOPBACK).env("NO_COLOR", "1").env("FORCE_COLOR", "0");
            cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0);
            }
            let mut child = cmd.spawn().map_err(|e| ("start-failed", e.to_string(), vec![]))?;
            let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)].into_iter().flatten() {
                let log = log.clone();
                std::thread::spawn(move || {
                    let mut reader = std::io::BufReader::new(stream);
                    let mut line = String::new();
                    while std::io::BufRead::read_line(&mut reader, &mut line).is_ok_and(|n| n > 0) {
                        let clean = strip_ansi(line.trim_end());
                        if !clean.trim().is_empty() {
                            let mut l = log.lock().unwrap();
                            l.push(if clean.chars().count() > 500 { format!("{}…", clean.chars().take(500).collect::<String>()) } else { clean });
                            if l.len() > LOG_LINES {
                                l.remove(0);
                            }
                        }
                        line.clear();
                    }
                });
            }
            let origin = preview_origin(port);
            let deadline = Instant::now() + ready_timeout;
            let mut server = DevServer { child, origin, port, cli: cli.clone(), node: node.clone(), log };
            loop {
                if let Ok(Some(_)) = server.child.try_wait() {
                    let log = server.log.lock().unwrap().clone();
                    let in_use = log.iter().any(|l| l.contains("EADDRINUSE"));
                    last = Some(("start-failed", "The Darkmown dev server stopped before it was ready.".to_string(), log));
                    if in_use {
                        break;
                    }
                    return Err(last.unwrap());
                }
                if probe_ready(&server.origin) {
                    return Ok(server);
                }
                if Instant::now() >= deadline {
                    let log = server.log.lock().unwrap().clone();
                    server.stop();
                    return Err(("start-timeout", format!("The Darkmown dev server did not answer within {} seconds.", ready_timeout.as_secs()), log));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        Err(last.unwrap_or(("start-failed", "The Darkmown dev server could not start.".into(), vec![])))
    }

    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// SIGTERM to the process group, then SIGKILL after 3 s.
    pub fn stop(&mut self) {
        drop(self.child.stdin.take());
        let pid = self.child.id() as i32;
        unsafe {
            libc_kill(-pid, 15);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc_kill(-pid, 9);
        }
        let _ = self.child.wait();
    }
}

impl Drop for DevServer {
    fn drop(&mut self) {
        if self.running() {
            self.stop();
        }
    }
}

unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_probe_takes_the_last_block() {
        let out = "motd\n__MARKIE_PATH__\n/a:/b\n__MARKIE_PATH_END__\n__MARKIE_PATH__\n/opt/homebrew/bin:/usr/bin\n__MARKIE_PATH_END__\n";
        assert_eq!(parse_path_probe(out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(parse_path_probe("nothing"), None);
        assert_eq!(node_major("v22.3.0"), Some(22));
    }

    #[test]
    fn navigation_rules() {
        let o = "http://127.0.0.1:4321";
        assert_eq!(navigation_decision("http://127.0.0.1:4321/docs", o), Navigation::Allow);
        assert_eq!(navigation_decision("https://example.com/", o), Navigation::External);
        assert_eq!(navigation_decision("http://127.0.0.1:9999/", o), Navigation::External);
        assert_eq!(navigation_decision("file:///etc/passwd", o), Navigation::Block);
        assert_eq!(navigation_decision("javascript:alert(1)", o), Navigation::Block);
    }

    /// A fake Darkmown CLI that answers the readiness probe, run through the
    /// real watchdog with the user's Node, then stopped by process group.
    #[test]
    fn starts_and_stops_a_dev_server() {
        let Ok(_node) = resolve_node() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        std::fs::create_dir_all(root.join("site/pages")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
        let cli = root.join("node_modules/.bin/darkmown");
        std::fs::write(&cli, "require('http').createServer((q, s) => { s.writeHead(q.url === '/__wd/dev-client.js' ? 200 : 404, {'content-type': 'text/javascript'}); s.end('//ok'); }).listen(+process.env.PORT, process.env.HOST);\n").unwrap();
        let mut server = DevServer::start(&root, Duration::from_secs(20)).unwrap_or_else(|e| panic!("{e:?}"));
        assert!(probe_ready(&server.origin));
        server.stop();
        assert!(!probe_ready(&server.origin));
    }
}
