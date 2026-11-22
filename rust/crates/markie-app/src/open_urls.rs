//! What macOS hands a running Markie RS: files from Finder or `open -a`.
//!
//! `markie-rs://` links (the Google and Apple sign-in hand-back) arrive on the
//! same callback; they are not files and are left to the cloud sign-in code.

use std::path::PathBuf;

use gpui_kit::{App, Window};

/// The local files among the URLs macOS passed, in order. Anything that is not
/// a `file://` URL is skipped here.
pub fn file_paths(urls: &[String]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|raw| url::Url::parse(raw).ok())
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok())
        .collect()
}

/// Un-minimize the window, raise it and make Markie RS the active app.
/// `activate_window` alone orders a window front but leaves a minimized one in
/// the Dock.
pub fn bring_to_front(window: &mut Window, cx: &mut App) {
    deminiaturize(window);
    cx.activate(true);
    window.activate_window();
}

#[cfg(target_os = "macos")]
fn deminiaturize(window: &Window) {
    use objc2_app_kit::NSView;
    use raw_window_handle::RawWindowHandle;

    let Ok(handle) = raw_window_handle::HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else { return };
    // SAFETY: GPUI hands out the live NSView of this window; we only read its
    // window and ask AppKit to restore it, on the main thread.
    let view: &NSView = unsafe { appkit.ns_view.cast::<NSView>().as_ref() };
    if let Some(ns_window) = view.window() {
        if ns_window.isMiniaturized() {
            ns_window.deminiaturize(None);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn deminiaturize(_window: &Window) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_local_files_in_order() {
        let urls = vec![
            "file:///Users/someone/Notes/plan%20one.md".to_string(),
            "markie-rs://auth?token=t&state=abcdef01".to_string(),
            "https://example.com/a.md".to_string(),
            "file:///tmp/b.docx".to_string(),
            "not a url".to_string(),
        ];
        assert_eq!(
            file_paths(&urls),
            vec![PathBuf::from("/Users/someone/Notes/plan one.md"), PathBuf::from("/tmp/b.docx")]
        );
    }
}
