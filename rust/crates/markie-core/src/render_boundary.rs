//! Catch document projection failures before they enter the platform's
//! layout or paint callbacks. Panics elsewhere still use the fatal hook.

use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, PanicHookInfo, catch_unwind};

thread_local! {
    static CAPTURE: RefCell<Option<Option<String>>> = const { RefCell::new(None) };
}

pub fn capture_panic(info: &PanicHookInfo<'_>) -> bool {
    CAPTURE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else { return false };
        let Some(report) = slot.as_mut() else { return false };
        let location = info.location().map(|loc| format!("\n{loc}")).unwrap_or_default();
        *report = Some(format!(
            "{}{location}\n{}",
            message(info.payload()),
            std::backtrace::Backtrace::force_capture(),
        ));
        true
    })
}

fn message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload.downcast_ref::<String>().map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("Document projection panicked.")
}

pub fn project<T>(draw: impl FnOnce() -> T) -> Result<T, String> {
    let previous = CAPTURE.with(|slot| slot.replace(Some(None)));
    let result = catch_unwind(AssertUnwindSafe(draw));
    let report = CAPTURE.with(|slot| slot.replace(previous)).flatten();
    result.map_err(|payload| report.unwrap_or_else(|| message(payload.as_ref()).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_projection_does_not_prevent_the_replacement_from_rendering() {
        assert_eq!(project(|| panic!("synthetic render fault")).unwrap_err(), "synthetic render fault");
        assert_eq!(project(|| 42).unwrap(), 42);
        assert!(CAPTURE.with(|slot| slot.borrow().is_none()));
    }
}
