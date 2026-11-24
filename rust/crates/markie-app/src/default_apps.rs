//! Settings › Files, "Open with Markie": `electron/default-apps.js` and
//! `src/components/default-apps-section.tsx`.
//!
//! The dev build Markie RS claims no file types, so the section shows the same
//! formats and who opens them today, with every claim button disabled and the
//! reason written in place. The Mac app (the `nightly` feature) is Markie and
//! declares its document types; claiming a format from here is not built yet. Reading the current handler is
//! the same LaunchServices call Electron's Swift makes, made directly.

pub const MARKIE_BUNDLE_ID: &str = "com.zvn.markie";

pub struct Format {
    pub id: &'static str,
    pub label: &'static str,
    pub extensions: &'static [&'static str],
    pub utis: &'static [&'static str],
    pub note: Option<&'static str>,
}

/// `DEFAULT_APP_FORMATS`, in order.
pub const FORMATS: &[Format] = &[
    Format { id: "markdown", label: "Markdown", extensions: &[".md", ".markdown", ".mdx"], utis: &["net.daringfireball.markdown"], note: None },
    Format { id: "text", label: "Plain text", extensions: &[".txt", ".text"], utis: &["public.plain-text"], note: None },
    Format { id: "darkmown", label: "Darkmown", extensions: &[".wd"], utis: &["com.zvn.markie.darkmown"], note: None },
    Format {
        id: "docx",
        label: "Word",
        extensions: &[".docx"],
        utis: &["org.openxmlformats.wordprocessingml.document"],
        note: Some("Files using features Markie can't save yet open read-only."),
    },
    Format { id: "rtf", label: "Rich Text", extensions: &[".rtf"], utis: &["public.rtf"], note: Some("Files with tables or images open read-only.") },
    Format {
        id: "odt",
        label: "OpenDocument",
        extensions: &[".odt"],
        utis: &["org.oasis-open.opendocument.text"],
        note: Some("Files using features Markie can't save yet open read-only."),
    },
];

/// Why nothing here can be claimed. Shown in place of Electron's intro line.
pub const SIDE_BUILD_NOTE: &str = "Markie RS is a side build, so it claims no file types. A double-click in Finder keeps opening files in Markie. Open a file here with Open… or Open With.";
/// The Mac app declares Markie's document types, so a default already set to
/// Markie keeps working. Setting one from here is not built yet.
pub const MAIN_BUILD_NOTE: &str = "Formats already set to open with Markie keep doing so. To make Markie the default for another format, choose Get Info on a file in Finder, then Open With and Change All.";

/// The line under the list, for this build.
pub fn note() -> &'static str {
    if markie_core::paths::NIGHTLY { MAIN_BUILD_NOTE } else { SIDE_BUILD_NOTE }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatStatus {
    pub id: &'static str,
    /// Every type of the format opens in the shipping Markie.
    pub markie: bool,
    /// Every type of the format opens in Markie RS. Should never be true.
    pub markie_rs: bool,
}

/// `parseStatus`: a format belongs to an app only when all its types do.
pub fn status_from(handler: impl Fn(&str) -> Option<String>) -> Vec<FormatStatus> {
    FORMATS
        .iter()
        .map(|f| {
            let handlers: Vec<String> = f.utis.iter().map(|u| handler(u).unwrap_or_default().to_lowercase()).collect();
            FormatStatus {
                id: f.id,
                markie: handlers.iter().all(|h| h == MARKIE_BUNDLE_ID),
                markie_rs: handlers.iter().all(|h| h == markie_core::paths::BUNDLE_ID),
            }
        })
        .collect()
}

pub fn status() -> Vec<FormatStatus> {
    status_from(default_handler)
}

/// The bundle id LaunchServices opens a content type with, for every role.
#[cfg(target_os = "macos")]
pub fn default_handler(uti: &str) -> Option<String> {
    use std::ffi::{c_char, c_void};
    type CFStringRef = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(alloc: *const c_void, bytes: *const u8, len: isize, encoding: u32, external: u8) -> CFStringRef;
        fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSCopyDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32) -> CFStringRef;
    }
    const UTF8: u32 = 0x0800_0100;
    const ROLES_ALL: u32 = 0xFFFF_FFFF;
    // SAFETY: plain CoreFoundation calls; every created or copied object is released.
    unsafe {
        let name = CFStringCreateWithBytes(std::ptr::null(), uti.as_ptr(), uti.len() as isize, UTF8, 0);
        if name.is_null() {
            return None;
        }
        let handler = LSCopyDefaultRoleHandlerForContentType(name, ROLES_ALL);
        CFRelease(name);
        if handler.is_null() {
            return None;
        }
        let mut buf = [0 as c_char; 512];
        let ok = CFStringGetCString(handler, buf.as_mut_ptr(), buf.len() as isize, UTF8) != 0;
        CFRelease(handler);
        ok.then(|| std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

/// Windows (registry `UserChoice`) and Linux (`xdg-mime query default`) are
/// not read yet; the section then says default apps are a macOS feature.
#[cfg(not(target_os = "macos"))]
pub fn default_handler(_uti: &str) -> Option<String> {
    None
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_format_belongs_to_an_app_only_when_every_type_does() {
        let s = status_from(|uti| match uti {
            "net.daringfireball.markdown" => Some("com.zvn.markie".into()),
            "public.plain-text" => Some("COM.ZVN.MARKIE".into()),
            "public.rtf" => Some("com.apple.TextEdit".into()),
            _ => None,
        });
        assert_eq!(s.len(), 6);
        assert!(s[0].markie && s[1].markie);
        assert!(!s[2].markie && !s[4].markie);
        assert!(s.iter().all(|f| !f.markie_rs));
    }

    #[test]
    fn same_formats_as_electron() {
        let ids: Vec<&str> = FORMATS.iter().map(|f| f.id).collect();
        assert_eq!(ids, ["markdown", "text", "darkmown", "docx", "rtf", "odt"]);
    }

    /// Markie RS must never be the handler of anything Electron offers.
    #[cfg(target_os = "macos")]
    #[test]
    fn markie_rs_claims_nothing_on_this_mac() {
        assert!(status().iter().all(|f| !f.markie_rs));
        let _ = default_handler("public.plain-text");
    }
}
