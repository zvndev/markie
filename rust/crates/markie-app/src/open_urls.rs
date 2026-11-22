//! What macOS hands a running Markie RS: files from Finder or `open -a`, and
//! `markie-rs://` links, the Google and Apple sign-in hand-back. Files go to
//! the workspace and hand-back links to the cloud sign-in code
//! (workspace/account.rs). Anything else is dropped.

use std::path::PathBuf;

use gpui_kit::{App, Window};

/// The local files among the URLs macOS passed, in order. Anything that is not
/// a `file://` URL is skipped here.
pub fn file_paths(urls: &[String]) -> Vec<PathBuf> {
    urls.iter().filter_map(|raw| file_path(raw)).collect()
}

fn file_path(raw: &str) -> Option<PathBuf> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

/// A desktop launcher can pass local URLs, while the CLI passes paths.
pub fn launch_file_paths(args: &[String]) -> Vec<PathBuf> {
    args.iter().filter_map(|arg| {
        if arg.contains("://") {
            return file_path(arg);
        }
        (!arg.starts_with('-')).then(|| PathBuf::from(arg))
    }).collect()
}

/// The sign-in hand-back links among the URLs, in order. Only Markie RS's own
/// `markie-rs` scheme; never `markie://`, which belongs to the Electron app.
pub fn hand_back_links(urls: &[String]) -> Vec<String> {
    urls.iter().filter(|raw| markie_cloud::auth::is_hand_back_link(raw)).cloned().collect()
}

/// The `markie-rs://` links among the URLs, except the sign-in hand-back
/// (`markie-rs://auth`), which the cloud sign-in code takes.
pub fn deep_links(urls: &[String]) -> Vec<String> {
    urls.iter()
        .filter(|u| crate::deeplinks::classify(u) != crate::deeplinks::Kind::Ignore && !crate::deeplinks::is_auth(u))
        .cloned()
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
    fn linux_launcher_advertises_only_the_side_build_scheme() {
        let entry = include_str!("../../../scripts/com.zvn.markie.rs.desktop");
        assert!(entry.lines().any(|line| line == "Exec=markie-rs %U"));
        assert_eq!(
            entry.lines().filter(|line| line.starts_with("MimeType=")).collect::<Vec<_>>(),
            ["MimeType=x-scheme-handler/markie-rs;"]
        );
    }

    #[test]
    fn cold_launch_accepts_paths_and_desktop_urls_in_argument_order() {
        let url = if cfg!(windows) { "file:///C:/tmp/a%20b.docx" } else { "file:///tmp/a%20b.docx" };
        let args = [url, "Notes.md", "markie-rs://doc?id=1", "markie://auth", "--unrecognized", "https://example.org/x"]
            .map(str::to_string);
        let mut expected = file_paths(&args);
        assert_eq!(expected.len(), 1);
        assert_eq!(expected[0].file_name().unwrap(), "a b.docx");
        expected.push(PathBuf::from("Notes.md"));
        assert_eq!(launch_file_paths(&args), expected);
    }

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
        assert_eq!(deep_links(&urls), Vec::<String>::new(), "auth belongs to the sign-in code");
        let more = vec!["markie-rs://open?token=t".to_string(), "markie://open?token=t".to_string(), "markie-rs://doc?id=1".to_string()];
        assert_eq!(deep_links(&more), vec!["markie-rs://open?token=t".to_string(), "markie-rs://doc?id=1".to_string()]);
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
