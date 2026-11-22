//! What macOS hands a running Markie RS: files from Finder or `open -a`, and
//! `markie-rs://` links, the Google and Apple sign-in hand-back. Files go to
//! the workspace and hand-back links to the cloud sign-in code
//! (workspace/account.rs). Anything else is dropped.

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

/// The sign-in hand-back links among the URLs, in order. Only Markie RS's own
/// `markie-rs` scheme; never `markie://`, which belongs to the Electron app.
pub fn hand_back_links(urls: &[String]) -> Vec<String> {
    urls.iter().filter(|raw| markie_cloud::auth::is_hand_back_link(raw)).cloned().collect()
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

/// Tell Launch Services that this copy of Markie RS answers `markie-rs://`,
/// the way Electron calls `setAsDefaultProtocolClient` at launch. With several
/// builds on one Mac (agents' worktrees), the copy that launched last is the
/// one the browser hands a Google or Apple sign-in back to. Only an `.app`
/// bundle registers; `cargo run` does nothing.
#[cfg(target_os = "macos")]
pub fn register_url_scheme() {
    use std::ffi::c_void;
    use std::os::unix::ffi::OsStrExt;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(alloc: *const c_void, buffer: *const u8, len: isize, is_dir: u8) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSRegisterURL(url: *const c_void, update: u8) -> i32;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    // …/Markie RS.app/Contents/MacOS/markie-rs
    let Some(bundle) = exe.ancestors().nth(3).filter(|p| p.extension().is_some_and(|e| e == "app")) else { return };
    let bytes = bundle.as_os_str().as_bytes();
    // SAFETY: plain CoreFoundation calls on a path we own; the URL is released.
    unsafe {
        let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, 1);
        if url.is_null() {
            return;
        }
        let _ = LSRegisterURL(url, 1);
        CFRelease(url);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn register_url_scheme() {}

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

    #[test]
    fn keeps_only_markie_rs_links_for_sign_in() {
        let urls = vec![
            "file:///tmp/a.md".to_string(),
            "markie-rs://auth?token=t&state=abcdef01".to_string(),
            "markie://auth?token=t&state=abcdef01".to_string(),
            "https://api.markiedocs.com/auth/desktop-bridge".to_string(),
        ];
        assert_eq!(hand_back_links(&urls), vec!["markie-rs://auth?token=t&state=abcdef01".to_string()]);
    }
}
