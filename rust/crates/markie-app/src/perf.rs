//! Performance instrumentation for `rust/scripts/bench`, off unless
//! `MARKIE_RS_PERF=1`. When off, every call here is one relaxed atomic load
//! and nothing is drawn, so the app looks and behaves the same.
//!
//! When on, the app writes one line per event to stderr:
//!   `markie-perf {"event":"…","t":<epoch ms>,…}`
//!
//! Events:
//! - `first_paint`: the first frame painted, ever.
//! - `open`: a document was opened and the first frame showing it painted.
//!   `ms` is from the start of `open_path` to the end of that frame's paint;
//!   `launch` is true for the document opened at startup.
//! - `key`: a keystroke and the next frame painted after it. `ms` is from the
//!   keystroke reaching the app to the end of that frame's paint.
//! - `scroll_frame`: a frame painted while scroll events arrive. `cost` is
//!   that frame's own work (render, layout, prepaint, paint) and `gap` the
//!   time since the previous painted frame.
//! - `scan`: the device index scan finished (`ms`, `files`).
//!
//! Every event also carries `cost`: the frame's CPU time on the main thread
//! from the start of the workspace render to the end of its paint. GPU work
//! and the compositor come after that and are not included.

use std::cell::RefCell;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use gpui_kit::*;

fn flag() -> &'static bool {
    static ON: OnceLock<bool> = OnceLock::new();
    ON.get_or_init(|| std::env::var("MARKIE_RS_PERF").is_ok_and(|v| v == "1"))
}

pub fn enabled() -> bool {
    *flag()
}

#[derive(Default)]
struct State {
    painted_once: bool,
    frame_start: Option<Instant>,
    last_paint: Option<Instant>,
    /// Pending opens: when `open_path` started, and whether it is the launch one.
    open: Option<(Instant, bool)>,
    key: Option<Instant>,
    last_scroll: Option<Instant>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn emit(event: &str, fields: &str) {
    eprintln!("markie-perf {{\"event\":\"{event}\",\"t\":{:.3}{fields}}}", epoch_ms());
}

/// Called once at startup: watches keystrokes before they are dispatched.
pub fn init(cx: &mut App) {
    if !enabled() {
        return;
    }
    emit("main", "");
    cx.intercept_keystrokes(|_, _, _| {
        STATE.with_borrow_mut(|s| {
            s.key.get_or_insert_with(Instant::now);
        });
    })
    .detach();
}

/// The start of a document open. One before the first paint is the launch one.
pub fn open_started() {
    if enabled() {
        STATE.with_borrow_mut(|s| s.open = Some((Instant::now(), !s.painted_once)));
    }
}

pub fn scan_done(elapsed_ms: u128, files: usize) {
    if enabled() {
        emit("scan", &format!(",\"ms\":{elapsed_ms},\"files\":{files}"));
    }
}

/// The start of the workspace render, which begins each frame.
pub fn frame_start() {
    if enabled() {
        STATE.with_borrow_mut(|s| s.frame_start = Some(Instant::now()));
    }
}

/// A zero-size element painted last in the workspace: its paint is the end
/// of the frame's main-thread work. `None` when instrumentation is off.
pub fn marker() -> Option<AnyElement> {
    if !enabled() {
        return None;
    }
    Some(
        canvas(
            |_, _, _| (),
            |_, _, window, _| {
                window.on_mouse_event(|_: &ScrollEvent, phase, _, _| {
                    if phase == DispatchPhase::Capture {
                        STATE.with_borrow_mut(|s| s.last_scroll = Some(Instant::now()));
                    }
                });
                painted();
            },
        )
        .absolute()
        .size_0()
        .into_any_element(),
    )
}

fn painted() {
    let now = Instant::now();
    STATE.with_borrow_mut(|s| {
        let cost = s.frame_start.take().map_or(0.0, |t| ms(now - t));
        if !s.painted_once {
            s.painted_once = true;
            emit("first_paint", &format!(",\"cost\":{cost:.3}"));
        }
        if let Some((t, launch)) = s.open.take() {
            emit("open", &format!(",\"ms\":{:.3},\"cost\":{cost:.3},\"launch\":{launch}", ms(now - t)));
        }
        if let Some(t) = s.key.take() {
            emit("key", &format!(",\"ms\":{:.3},\"cost\":{cost:.3}", ms(now - t)));
        }
        if s.last_scroll.is_some_and(|t| now - t < std::time::Duration::from_millis(80)) {
            let gap = s.last_paint.map_or(0.0, |p| ms(now - p));
            emit("scroll_frame", &format!(",\"cost\":{cost:.3},\"gap\":{gap:.3}"));
        }
        s.last_paint = Some(now);
    });
}
