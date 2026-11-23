//! Diagnostics for a window that stops answering: a main-thread stall
//! watchdog and an input trace. Both are off in a normal run.
//!
//! - `MARKIE_RS_WATCHDOG=1` (always on in debug builds): the main thread
//!   beats every 250 ms. When a beat is more than 2 s late, a watcher thread
//!   appends a line to `main-thread-stalls.log` in Markie RS's data folder
//!   and writes the main thread's stack beside it with macOS `sample`, so the
//!   next freeze names its blocking call. A recovered stall is logged too.
//!   While it runs the app holds a latency-critical activity, so App Nap
//!   does not throttle the beat of a window in the background; a stack that
//!   shows the main thread idle in its event loop is still logged as a late
//!   timer rather than a block.
//! - `MARKIE_RS_DEBUG_INPUT=1`: every mouse press and release and key press
//!   AppKit hands the app is printed to stderr, with the window it targets,
//!   the key window and the first responder (`logs::trace_input`). A press
//!   with no release here never reached the app.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use gpui_kit::App;

/// How late a beat may be before the main thread counts as blocked.
pub const STALL: Duration = Duration::from_secs(2);
const BEAT: Duration = Duration::from_millis(250);

pub fn enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("MARKIE_RS_WATCHDOG").is_ok_and(|v| v == "1")
}

/// Milliseconds since `start` at the last beat.
static LAST_BEAT: AtomicU64 = AtomicU64::new(0);

/// What the watcher decides each time it looks.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Fine,
    /// Newly blocked for this long: report it once.
    Stalled(Duration),
    /// Still blocked, already reported.
    StillStalled,
    /// Answering again after a reported stall of about this long.
    Recovered(Duration),
}

/// The watcher's state machine, apart from clocks and files so it can be
/// tested: `late` is how long ago the last beat was.
#[derive(Default)]
pub struct Watcher {
    reported: Option<Duration>,
}

impl Watcher {
    pub fn look(&mut self, late: Duration) -> Verdict {
        match (self.reported, late > STALL) {
            (None, true) => {
                self.reported = Some(late);
                Verdict::Stalled(late)
            }
            (Some(worst), true) => {
                self.reported = Some(worst.max(late));
                Verdict::StillStalled
            }
            (Some(worst), false) => {
                self.reported = None;
                Verdict::Recovered(worst)
            }
            (None, false) => Verdict::Fine,
        }
    }
}

pub fn log_path(data: &Path) -> PathBuf {
    data.join("main-thread-stalls.log")
}

fn append(data: &Path, line: &str) {
    let _ = std::fs::create_dir_all(data);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path(data)) {
        let _ = writeln!(f, "[{}] {line}", chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
}

/// Starts the beat on the main thread and the watcher beside it.
pub fn start(cx: &mut App) {
    if !enabled() {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
        let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep | NSActivityOptions::LatencyCritical,
            &NSString::from_str("Markie RS main-thread watchdog"),
        );
        // Held for the life of the process.
        std::mem::forget(activity);
    }
    let origin = Instant::now();
    let now_ms = move || origin.elapsed().as_millis() as u64;
    LAST_BEAT.store(now_ms(), Ordering::Relaxed);
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(BEAT).await;
            LAST_BEAT.store(now_ms(), Ordering::Relaxed);
        }
    })
    .detach();
    let data = markie_core::paths::data_dir();
    std::thread::Builder::new()
        .name("markie-watchdog".into())
        .spawn(move || {
            let mut watcher = Watcher::default();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let late = Duration::from_millis(now_ms().saturating_sub(LAST_BEAT.load(Ordering::Relaxed)));
                match watcher.look(late) {
                    Verdict::Stalled(late) => {
                        let stack = data.join(format!("main-thread-stall-{}.txt", chrono::Utc::now().format("%Y%m%dT%H%M%S")));
                        append(&data, &format!("main thread blocked for {} ms; its stack: {}", late.as_millis(), stack.display()));
                        eprintln!("markie-rs: main thread blocked for {} ms; stack in {}", late.as_millis(), stack.display());
                        // `sample` names the frames of every thread, main first.
                        let _ = std::process::Command::new("/usr/bin/sample")
                            .args([&std::process::id().to_string(), "1", "-file"])
                            .arg(&stack)
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status();
                        if std::fs::read_to_string(&stack).is_ok_and(|text| main_thread_idle(&text)) {
                            append(&data, "the main thread was idle in its event loop: the beat timer ran late (App Nap or a sleeping Mac), nothing blocked it");
                        }
                    }
                    Verdict::Recovered(worst) => append(&data, &format!("main thread answering again after at least {} ms", worst.as_millis())),
                    Verdict::Fine | Verdict::StillStalled => {}
                }
            }
        })
        .ok();
}

/// Whether a `sample` report shows the main thread only waiting for events:
/// its heaviest stack ends in the run loop's `mach_msg` under
/// `_DPSNextEvent`, with no other frame taking samples.
pub fn main_thread_idle(report: &str) -> bool {
    let Some(start) = report.find("com.apple.main-thread") else { return false };
    let main: Vec<&str> = report[start..].lines().skip(1).take_while(|l| l.trim_start().starts_with('+')).collect();
    let total = main.first().and_then(|l| samples(l));
    let waiting = main.iter().find(|l| l.contains("__CFRunLoopServiceMachPort")).and_then(|l| samples(l));
    main.iter().any(|l| l.contains("_DPSNextEvent")) && total.is_some() && total == waiting
}

/// The sample count that leads a `sample` call-tree line.
fn samples(line: &str) -> Option<u32> {
    line.trim_start_matches(|c: char| c == ' ' || c == '+' || c == '!' || c == ':' || c == '|').split_whitespace().next()?.parse().ok()
}

/// The AppKit side of `MARKIE_RS_DEBUG_INPUT=1`.
#[cfg(target_os = "macos")]
pub fn trace_appkit_input() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventType};
    if !std::env::var("MARKIE_RS_DEBUG_INPUT").is_ok_and(|v| v == "1") {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else { return };
    let mask = NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp | NSEventMask::KeyDown;
    let block = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event on the main thread.
        let e = unsafe { event.as_ref() };
        let kind = match e.r#type() {
            NSEventType::LeftMouseDown => "down",
            NSEventType::LeftMouseUp => "up",
            NSEventType::KeyDown => "key",
            _ => "other",
        };
        let app = NSApplication::sharedApplication(mtm);
        let key = app.keyWindow();
        let responder = key
            .as_ref()
            .and_then(|w| w.firstResponder())
            .map(|r| r.class().name().to_string_lossy().into_owned())
            .unwrap_or_else(|| "none".into());
        let at = e.locationInWindow();
        crate::logs::trace_input(|| {
            format!(
                "appkit {kind} window {} at ({:.0}, {:.0}); key window {} ({}); active {}",
                e.windowNumber(),
                at.x,
                at.y,
                key.as_ref().map_or(-1, |w| w.windowNumber()),
                responder,
                app.isActive()
            )
        });
        event.as_ptr()
    });
    // SAFETY: the handler returns the event it was given.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    // The monitor lives as long as the app.
    std::mem::forget(monitor);
}

#[cfg(not(target_os = "macos"))]
pub fn trace_appkit_input() {}

#[cfg(test)]
mod tests {
    use super::{Duration, Verdict, Watcher, main_thread_idle};

    const IDLE: &str = "Call graph:
    866 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)
    + 866 start  (in dyld) + 6992
    +   866 -[NSApplication run]  (in AppKit) + 368
    +     866 _DPSNextEvent  (in AppKit) + 576
    +       866 __CFRunLoopServiceMachPort  (in CoreFoundation) + 160
    +         866 mach_msg  (in libsystem_kernel.dylib) + 24
    866 Thread_2: markie-rs-instance
    + 866 __accept  (in libsystem_kernel.dylib) + 8
";

    #[test]
    fn an_idle_event_loop_is_not_a_block() {
        assert!(main_thread_idle(IDLE));
        let busy = IDLE.replace("+       866 __CFRunLoopServiceMachPort", "+       866 _RNvMarkieRender").replace("+         866 mach_msg", "+         866 open");
        assert!(!main_thread_idle(&busy));
        let partly = IDLE.replace("+       866 __CFRunLoopServiceMachPort", "+       500 __CFRunLoopServiceMachPort");
        assert!(!main_thread_idle(&partly), "366 samples were spent elsewhere");
        assert!(!main_thread_idle("no main thread here"));
    }

    #[test]
    fn a_stall_is_reported_once_then_its_recovery() {
        let mut w = Watcher::default();
        let ms = Duration::from_millis;
        assert_eq!(w.look(ms(300)), Verdict::Fine);
        assert_eq!(w.look(ms(2000)), Verdict::Fine, "exactly two seconds is not yet a stall");
        assert_eq!(w.look(ms(2400)), Verdict::Stalled(ms(2400)));
        assert_eq!(w.look(ms(5200)), Verdict::StillStalled);
        assert_eq!(w.look(ms(100)), Verdict::Recovered(ms(5200)));
        assert_eq!(w.look(ms(100)), Verdict::Fine);
        assert_eq!(w.look(ms(3000)), Verdict::Stalled(ms(3000)), "a new stall is reported again");
    }
}
