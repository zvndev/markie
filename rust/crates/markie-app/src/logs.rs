//! Crash log and opt-in crash reporting. A port of `electron/crash-log.js`,
//! `crash-reporting.js` and `sentry-envelope.js`.
//!
//! - `markie-crash.log` in Markie RS's own data folder, 1 MB with one
//!   generation of history (`markie-crash.log.1`), one line per entry:
//!   `[<ISO time>] <kind> <detail>`.
//! - `crash-reporting.json` holds the consent, `{"enabled": true}` or not.
//!   Anything that is not literally `true` reads as no.
//! - A report leaves the machine only when the user opted in, a DSN is
//!   configured and the payload went through `scrub_text`. The committed DSN
//!   is empty, so a stock build is inert, exactly like Electron's.
//!
//! The panic hook is Rust's stand-in for Electron's `uncaughtException` and
//! `unhandledRejection` handlers: the panic is written to the log (and sent,
//! when allowed) before the default hook runs.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

pub const FILE_NAME: &str = "markie-crash.log";
pub const DEFAULT_MAX_BYTES: u64 = 1024 * 1024;
pub const CONSENT_FILE: &str = "crash-reporting.json";
/// `electron/crash-reporting.config.json`'s DSN. Empty: reporting is inert.
pub const CONFIG_DSN: &str = "";

gpui_kit::actions!(markie_logs, [RevealCrashLog]);

/// Finder on macOS, File Explorer on Windows, and neither name is right on Linux.
pub fn reveal_menu_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Reveal Crash Log in Finder"
    } else if cfg!(target_os = "windows") {
        "Show Crash Log in Explorer"
    } else {
        "Show Crash Log"
    }
}

// ── The log file ──

pub struct CrashLog {
    pub path: PathBuf,
    pub previous_path: PathBuf,
    max_bytes: u64,
}

impl CrashLog {
    pub fn new(dir: &Path) -> Self {
        Self::with_max(dir, DEFAULT_MAX_BYTES)
    }

    pub fn with_max(dir: &Path, max_bytes: u64) -> Self {
        let path = dir.join(FILE_NAME);
        let previous_path = dir.join(format!("{FILE_NAME}.1"));
        Self { path, previous_path, max_bytes }
    }

    /// Keep one generation. Rotating instead of truncating keeps the entries
    /// that explain a crash loop after the loop writes over the cap.
    fn rotate_if_needed(&self, incoming: u64) {
        let Ok(meta) = std::fs::metadata(&self.path) else { return };
        if meta.len() + incoming <= self.max_bytes {
            return;
        }
        let _ = std::fs::remove_file(&self.previous_path);
        if std::fs::rename(&self.path, &self.previous_path).is_err() {
            let _ = std::fs::write(&self.path, "");
        }
    }

    /// Append one entry. Never panics: this runs on failure paths.
    pub fn log(&self, kind: &str, detail: &str) -> bool {
        let entry = format_entry(&iso_now(), kind, detail);
        self.rotate_if_needed(entry.len() as u64);
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| f.write_all(entry.as_bytes()))
            .is_ok()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn read(&self) -> String {
        std::fs::read_to_string(&self.path).unwrap_or_default()
    }
}

/// `[<time>] <kind> <detail>\n`. An empty detail still leaves the space, as
/// the JavaScript template does.
pub fn format_entry(at: &str, kind: &str, detail: &str) -> String {
    format!("[{at}] {kind} {detail}\n")
}

/// `new Date().toISOString()`: UTC, milliseconds, `Z`.
pub fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn data_dir() -> PathBuf {
    markie_core::paths::data_dir()
}

pub fn crash_log() -> CrashLog {
    CrashLog::new(&data_dir())
}

/// `logCrash(kind, detail)`: console, file, then the consent-gated upload.
pub fn log_crash(kind: &str, detail: &str) {
    let _ = std::panic::catch_unwind(|| {
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), "{kind}: {detail}");
    });
    crash_log().log(kind, detail);
    upload_crash(kind, detail, false);
}

// ── Consent ──

pub fn consent_path(dir: &Path) -> PathBuf {
    dir.join(CONSENT_FILE)
}

/// Fails closed: only a literal `true` under `enabled` is consent.
pub fn read_consent(dir: &Path) -> bool {
    std::fs::read_to_string(consent_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|v| v.get("enabled") == Some(&Value::Bool(true)))
}

/// `JSON.stringify({enabled}, null, 2) + "\n"`. Answers whether it stuck.
pub fn write_consent(dir: &Path, enabled: bool) -> bool {
    let _ = std::fs::create_dir_all(dir);
    std::fs::write(consent_path(dir), format!("{{\n  \"enabled\": {enabled}\n}}\n")).is_ok()
}

/// `MARKIE_SENTRY_DSN`, else the committed config, else none.
pub fn crash_dsn(env: Option<&str>, config: &str) -> Option<String> {
    if let Some(v) = env.map(str::trim).filter(|v| !v.is_empty()) {
        return Some(v.to_string());
    }
    let c = config.trim();
    (!c.is_empty()).then(|| c.to_string())
}

pub fn configured_dsn() -> Option<String> {
    crash_dsn(std::env::var("MARKIE_SENTRY_DSN").ok().as_deref(), CONFIG_DSN)
}

// ── Sentry envelope ──

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dsn {
    pub public_key: String,
    pub host: String,
    pub project_id: String,
    pub envelope_url: String,
}

pub fn parse_dsn(dsn: &str) -> Option<Dsn> {
    let u = url::Url::parse(dsn.trim()).ok()?;
    let public_key = u.username().to_string();
    let project_id = u.path().trim_start_matches('/').to_string();
    if public_key.is_empty() || project_id.is_empty() {
        return None;
    }
    let host = match u.port() {
        Some(p) => format!("{}:{p}", u.host_str()?),
        None => u.host_str()?.to_string(),
    };
    let envelope_url = format!("{}://{host}/api/{project_id}/envelope/", u.scheme());
    Some(Dsn { public_key, host, project_id, envelope_url })
}

pub fn sentry_auth_header(dsn: &Dsn, client_version: &str) -> String {
    format!("Sentry sentry_version=7, sentry_client=markie/{client_version}, sentry_key={}", dsn.public_key)
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

/// Remove anything that identifies the user or their documents. Paths
/// collapse to their basename; Markie's own `app://` and `http(s)://` URLs are
/// kept; `file://` is not protected, so its path goes through the path rule.
pub fn scrub_text(text: &str, home: &str) -> String {
    static URL: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    if text.is_empty() {
        return String::new();
    }
    let mut protected: Vec<String> = Vec::new();
    let out = re(&URL, r#"(?:app|https?)://[^\s)'"]+"#).replace_all(text, |c: &regex::Captures| {
        protected.push(c[0].to_string());
        format!("\u{0}URL{}\u{0}", protected.len() - 1)
    });
    let mut out = re(&PATH, r#"(?:/[^\s/:()'"]+){2,}"#)
        .replace_all(&out, |c: &regex::Captures| {
            let m = &c[0];
            m[m.rfind('/').map_or(0, |i| i + 1)..].to_string()
        })
        .into_owned();
    if !home.is_empty() {
        out = out.split(home).collect::<Vec<_>>().join("~");
        let user = &home[home.rfind('/').map_or(0, |i| i + 1)..];
        if !user.is_empty() {
            // JavaScript's `(^|[^A-Za-z0-9_-])user(?=$|[^A-Za-z0-9_-])`, without lookahead.
            out = replace_whole_word(&out, user, "~");
        }
    }
    re(&TOKEN, "\u{0}URL(\\d+)\u{0}")
        .replace_all(&out, |c: &regex::Captures| {
            c[1].parse::<usize>().ok().and_then(|i| protected.get(i).cloned()).unwrap_or_default()
        })
        .into_owned()
}

fn replace_whole_word(text: &str, word: &str, with: &str) -> String {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if rest.starts_with(word) {
            let before_ok = text[..i].chars().next_back().is_none_or(|c| !is_word(c));
            let after_ok = rest[word.len()..].chars().next().is_none_or(|c| !is_word(c));
            if before_ok && after_ok {
                out.push_str(with);
                i += word.len();
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Sentry frames from a stack. Reads V8 frames (`at fn (file:1:2)`) as the
/// JavaScript does, and Rust backtrace frames (`N: fn` then `at file:line:col`).
/// Sentry renders the crashing frame last, so the list is reversed.
pub fn parse_stack_frames(stack: &str, home: &str) -> Vec<Value> {
    static NAMED: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Regex> = OnceLock::new();
    static RUST_FN: OnceLock<Regex> = OnceLock::new();
    static RUST_AT: OnceLock<Regex> = OnceLock::new();
    let named = re(&NAMED, r"^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$");
    let bare = re(&BARE, r"^\s*at\s+(.+?):(\d+):(\d+)\s*$");
    let rust_fn = re(&RUST_FN, r"^\s*\d+:\s+(\S.*?)\s*$");
    let rust_at = re(&RUST_AT, r"^\s*at\s+(.+?):(\d+):(\d+)\s*$");
    let mut frames = Vec::new();
    let mut pending_fn: Option<String> = None;
    let num = |s: &str| s.parse::<u64>().unwrap_or(0);
    for line in stack.lines() {
        if let Some(m) = named.captures(line) {
            let file = scrub_text(&m[2], home);
            frames.push(json!({"function": &m[1], "filename": file, "abs_path": file, "lineno": num(&m[3]), "colno": num(&m[4]), "in_app": true}));
            pending_fn = None;
            continue;
        }
        if let Some(m) = rust_fn.captures(line) {
            if let Some(f) = pending_fn.take() {
                frames.push(json!({"function": f, "in_app": false}));
            }
            pending_fn = Some(m[1].to_string());
            continue;
        }
        if let Some(m) = bare.captures(line).or_else(|| rust_at.captures(line)) {
            let file = scrub_text(&m[1], home);
            let mut frame = json!({"filename": file, "abs_path": file, "lineno": num(&m[2]), "colno": num(&m[3]), "in_app": true});
            if let Some(f) = pending_fn.take() {
                frame["function"] = Value::String(f);
            }
            frames.push(frame);
        }
    }
    if let Some(f) = pending_fn.take() {
        frames.push(json!({"function": f, "in_app": false}));
    }
    frames.reverse();
    frames
}

/// "TypeError: boom" gives "TypeError".
fn exception_type(stack: &str, fallback: &str) -> String {
    static TYPE: OnceLock<Regex> = OnceLock::new();
    let first = stack.lines().next().unwrap_or("");
    re(&TYPE, r"^([A-Za-z_$][\w$]*Error|[A-Za-z_$][\w$]*Exception)\b")
        .captures(first)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// What `crashRecord(kind, detail)` builds in main.js.
#[derive(Debug, Clone)]
pub struct CrashRecord {
    pub at: String,
    pub source: String,
    pub message: String,
    pub stack: Option<String>,
    pub version: String,
    pub platform: String,
}

pub fn crash_record(kind: &str, detail: &str) -> CrashRecord {
    // A panic's payload is what an Error's message is in main.js: the record
    // carries it as the message, the way `detail instanceof Error` does there.
    let message = match detail.lines().next() {
        Some(first) if kind == "panic" && !first.is_empty() => first.to_string(),
        _ => kind.to_string(),
    };
    CrashRecord {
        at: iso_now(),
        source: "main".into(),
        message,
        stack: (!detail.is_empty()).then(|| detail.to_string()),
        version: env!("CARGO_PKG_VERSION").into(),
        platform: format!("{}/{}", node_platform(), node_arch()),
    }
}

/// `process.platform`'s spelling.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `process.arch`'s spelling.
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn event_id() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The request body: envelope header, item header, event, newline-delimited.
pub fn sentry_envelope(record: &CrashRecord, home: &str, environment: &str) -> String {
    let message = scrub_text(if record.message.is_empty() { "Unknown error" } else { &record.message }, home);
    let stack = record.stack.clone().unwrap_or_default();
    let frames = parse_stack_frames(&stack, home);
    let sent_at = iso_now();
    let id = event_id();
    let mut value = json!({"type": exception_type(&stack, "Error"), "value": message});
    if !frames.is_empty() {
        value["stacktrace"] = json!({"frames": frames});
    }
    let event = json!({
        "event_id": id,
        "timestamp": record.at,
        "platform": "native",
        "level": "error",
        "logger": format!("markie.{}", record.source),
        "release": record.version,
        "environment": environment,
        "tags": {"source": record.source, "platform": record.platform},
        "exception": {"values": [value]},
    });
    [json!({"event_id": id, "sent_at": sent_at}).to_string(), json!({"type": "event"}).to_string(), event.to_string()].join("\n")
}

/// Consent-gated, DSN-gated, never fails loudly. `wait` blocks (up to 5 s)
/// so a panic report can leave before the process ends.
pub fn upload_crash(kind: &str, detail: &str, wait: bool) {
    let dir = data_dir();
    if !read_consent(&dir) {
        return;
    }
    let Some(dsn) = configured_dsn().and_then(|d| parse_dsn(&d)) else { return };
    let home = markie_core::paths::home_dir().to_string_lossy().into_owned();
    let environment = if cfg!(debug_assertions) { "development" } else { "production" };
    let body = sentry_envelope(&crash_record(kind, detail), &home, environment);
    let auth = sentry_auth_header(&dsn, env!("CARGO_PKG_VERSION"));
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
        rt.block_on(async move {
            let Ok(client) = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build() else { return };
            let _ = client
                .post(&dsn.envelope_url)
                .header("Content-Type", "application/x-sentry-envelope")
                .header("X-Sentry-Auth", auth)
                .body(body)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await;
        });
        let _ = tx.send(());
    });
    if wait {
        let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
    }
}

/// Log every panic, then let the default hook print it.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "panic".to_string()
        };
        let location = info.location().map(|l| format!(" at {}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
        let backtrace = std::backtrace::Backtrace::force_capture();
        let detail = format!("{message}{location}\n{backtrace}");
        crash_log().log("panic", &detail);
        upload_crash("panic", &detail, true);
        default(info);
    }));
}

// ── Reveal Crash Log ──

/// `revealCrashLog`: an empty-state dialog when nothing was ever logged,
/// otherwise the file selected in Finder.
pub fn reveal_crash_log(window: &mut gpui_kit::Window, cx: &mut gpui_kit::App) {
    let log = crash_log();
    if !log.path.exists() {
        let _ = window.prompt(
            gpui_kit::PromptLevel::Info,
            "No crashes have been recorded yet.",
            Some("If Markie RS does crash, this is where the report will be."),
            &["OK"],
            cx,
        );
        return;
    }
    reveal_in_file_manager(&log.path);
}

pub fn reveal_in_file_manager(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("/usr/bin/open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn();
}

// ── Settings › Advanced: Error reporting ──

/// The "Error reporting" block of Settings › Advanced. `None` when no DSN is
/// configured: there is nowhere to report to, so Electron offers no switch.
pub fn render_crash_setting(cx: &gpui_kit::App) -> Option<gpui_kit::AnyElement> {
    use gpui_kit::component::checkbox::Checkbox;
    use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
    use gpui_kit::*;
    configured_dsn()?;
    let enabled = read_consent(&data_dir());
    let muted = cx.theme().muted_foreground;
    Some(
        v_flex()
            .gap_1()
            .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(muted).child("ERROR REPORTING"))
            .child(
                h_flex()
                    .items_start()
                    .justify_between()
                    .gap_3()
                    .child(
                        v_flex().text_size(px(12.)).child("Send crash reports").child(
                            div().text_size(px(11.)).text_color(muted).child(
                                "Off by default. When on, Markie sends the error and where in the code it happened, so crashes get fixed. Never your documents, their contents, or their file paths.",
                            ),
                        ),
                    )
                    .child(Checkbox::new("crash-consent").checked(enabled).on_click(|checked, _, cx| {
                        write_consent(&data_dir(), *checked);
                        cx.refresh_windows();
                    })),
            )
            .child(
                div()
                    .id("crash-log-reveal")
                    .text_size(px(11.))
                    .text_color(muted)
                    .cursor_pointer()
                    .child("Show the crash log")
                    .on_click(|_, window, cx| reveal_crash_log(window, cx)),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_format_matches_electron() {
        assert_eq!(format_entry("2026-11-22T10:00:00.000Z", "panic", "boom"), "[2026-11-22T10:00:00.000Z] panic boom\n");
        assert_eq!(format_entry("t", "kind", ""), "[t] kind \n");
        let now = iso_now();
        assert!(now.ends_with('Z') && now.len() == 24, "{now}");
    }

    #[test]
    fn log_rotates_one_generation() {
        let dir = tempfile::tempdir().unwrap();
        let log = CrashLog::with_max(dir.path(), 60);
        assert!(log.log("first", "a"));
        assert!(log.log("second", "b"));
        assert!(log.log("third", "c"));
        assert!(log.read().contains("third"));
        let previous = std::fs::read_to_string(&log.previous_path).unwrap();
        assert!(previous.contains("second") || previous.contains("first"));
        assert!(!log.read().contains("first"));
    }

    #[test]
    fn consent_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!read_consent(dir.path()));
        std::fs::write(consent_path(dir.path()), r#"{"enabled":"yes"}"#).unwrap();
        assert!(!read_consent(dir.path()));
        std::fs::write(consent_path(dir.path()), "not json").unwrap();
        assert!(!read_consent(dir.path()));
        assert!(write_consent(dir.path(), true));
        assert_eq!(std::fs::read_to_string(consent_path(dir.path())).unwrap(), "{\n  \"enabled\": true\n}\n");
        assert!(read_consent(dir.path()));
        assert!(write_consent(dir.path(), false));
        assert!(!read_consent(dir.path()));
    }

    #[test]
    fn dsn_rules() {
        assert_eq!(crash_dsn(None, ""), None);
        assert_eq!(crash_dsn(Some("  "), " "), None);
        assert_eq!(crash_dsn(Some(" https://k@o1.ingest.sentry.io/42 "), "x").as_deref(), Some("https://k@o1.ingest.sentry.io/42"));
        assert_eq!(crash_dsn(None, "https://c@h/1").as_deref(), Some("https://c@h/1"));
        assert_eq!(CONFIG_DSN, "", "a stock build must stay inert");
        let d = parse_dsn("https://abc@o1.ingest.sentry.io/42").unwrap();
        assert_eq!(d.public_key, "abc");
        assert_eq!(d.project_id, "42");
        assert_eq!(d.envelope_url, "https://o1.ingest.sentry.io/api/42/envelope/");
        assert_eq!(sentry_auth_header(&d, "0.1.0"), "Sentry sentry_version=7, sentry_client=markie/0.1.0, sentry_key=abc");
        assert!(parse_dsn("https://o1.ingest.sentry.io/42").is_none());
        assert!(parse_dsn("https://abc@o1.ingest.sentry.io/").is_none());
        assert!(parse_dsn("nonsense").is_none());
    }

    #[test]
    fn scrub_matches_the_javascript() {
        let home = "/Users/mark";
        assert_eq!(scrub_text("open /Users/mark/Desktop/Q3 salary.md failed", home), "open Q3 salary.md failed");
        assert_eq!(scrub_text("at x (app://markie/assets/index-abc.js:1:2)", home), "at x (app://markie/assets/index-abc.js:1:2)");
        assert_eq!(scrub_text("file:///Users/mark/Desktop/secret.md", home), "file://secret.md");
        assert_eq!(scrub_text("mark wrote markdown", home), "~ wrote markdown");
        assert_eq!(scrub_text("home is /Users/mark", home), "home is ~");
        assert_eq!(scrub_text("", home), "");
        assert_eq!(scrub_text("https://api.markiedocs.com/api/docs/x", home), "https://api.markiedocs.com/api/docs/x");
    }

    #[test]
    fn frames_from_v8_and_rust() {
        let v8 = "TypeError: boom\n    at render (app://markie/a.js:10:5)\n    at app://markie/b.js:3:1";
        let frames = parse_stack_frames(v8, "");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1]["function"], "render");
        assert_eq!(frames[0]["lineno"], 3);
        assert_eq!(exception_type(v8, "Error"), "TypeError");
        let rust = "   0: markie_rs::logs::boom\n             at /Users/mark/src/logs.rs:10:5\n   1: std::rt::lang_start";
        let frames = parse_stack_frames(rust, "/Users/mark");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1]["function"], "markie_rs::logs::boom");
        assert_eq!(frames[1]["filename"], "logs.rs");
        assert_eq!(frames[0]["function"], "std::rt::lang_start");
    }

    #[test]
    fn envelope_shape_and_scrubbing() {
        let mut record = crash_record("panic", "could not open /Users/mark/Notes/plan.md at src/x.rs:1:2\n   0: f\n             at /Users/mark/x.rs:1:2");
        record.version = "0.1.0".into();
        record.platform = "darwin/arm64".into();
        let body = sentry_envelope(&record, "/Users/mark", "production");
        let lines: Vec<&str> = body.split('\n').collect();
        assert_eq!(lines.len(), 3);
        let head: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(head["event_id"].as_str().unwrap().len(), 32);
        assert_eq!(lines[1], r#"{"type":"event"}"#);
        let event: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(event["release"], "0.1.0");
        assert_eq!(event["logger"], "markie.main");
        assert_eq!(event["tags"]["platform"], "darwin/arm64");
        assert!(!body.contains("/Users/mark"), "{body}");
        assert!(body.contains("plan.md"));
    }
}
