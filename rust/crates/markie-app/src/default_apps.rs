//! Settings › Files, "Open with Markie": `electron/default-apps.js` and
//! `src/components/default-apps-section.tsx`.
//!
//! The dev build Markie RS claims no file types, so the section shows the same
//! formats and who opens them today, with every claim button disabled and the
//! reason written in place. The Mac app (the `nightly` or `public` feature) is
//! Markie and declares its document types, so it claims a format the way
//! Electron does: `LSSetDefaultRoleHandlerForContentType` for every content
//! type of the format, all roles, `com.zvn.markie`. Reading the current
//! handler is the same LaunchServices call Electron's Swift makes; both are
//! made directly here, without Swift.

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
/// The Mac app declares Markie's document types and claims them from here.
pub const MAIN_BUILD_NOTE: &str = "Formats already set to open with Markie keep doing so after an update. You can change any of these back in Finder: Get Info on a file, then Open With and Change All.";

/// The line under the list, for this build.
pub fn note() -> &'static str {
    if can_claim() { MAIN_BUILD_NOTE } else { SIDE_BUILD_NOTE }
}

/// Whether this build may make itself the default: the Mac app, which is
/// `com.zvn.markie` and declares every one of these types. Never the dev build.
pub const fn can_claim() -> bool {
    markie_core::paths::MAC_APP && cfg!(target_os = "macos")
}

/// The content types to claim for `ids` (or every format, for "Use Markie for
/// all"), in `FORMATS` order, each once. Unknown ids are ignored, as
/// `formatById` returns nothing for them.
pub fn utis_for(ids: &[&str]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for format in FORMATS.iter().filter(|f| ids.contains(&f.id)) {
        for uti in format.utis {
            if !out.contains(uti) {
                out.push(uti);
            }
        }
    }
    out
}

/// Make Markie the default for every content type of the formats `ids`.
/// Ok when LaunchServices took every one, as `setScript` exits 0.
pub fn claim(ids: &[&str]) -> Result<(), String> {
    if !can_claim() {
        return Err(SIDE_BUILD_NOTE.into());
    }
    let utis = utis_for(ids);
    if utis.is_empty() {
        return Err("Choose a file type to open with Markie.".into());
    }
    let refused: Vec<&str> = utis.iter().copied().filter(|uti| set_default_handler(uti, MARKIE_BUNDLE_ID).is_err()).collect();
    if refused.is_empty() { Ok(()) } else { Err(format!("macOS did not make Markie the default for {}.", refused.join(", "))) }
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

/// `LSSetDefaultRoleHandlerForContentType(uti, kLSRolesAll, bundle_id)`, as
/// Electron's `setScript` calls it. Err carries the OSStatus.
#[cfg(target_os = "macos")]
pub fn set_default_handler(uti: &str, bundle_id: &str) -> Result<(), i32> {
    use std::ffi::c_void;
    type CFStringRef = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(alloc: *const c_void, bytes: *const u8, len: isize, encoding: u32, external: u8) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32, handler: CFStringRef) -> i32;
    }
    const UTF8: u32 = 0x0800_0100;
    const ROLES_ALL: u32 = 0xFFFF_FFFF;
    if !valid_uti(uti) || !valid_uti(bundle_id) {
        return Err(-50); // paramErr
    }
    // SAFETY: plain CoreFoundation calls; both created strings are released.
    unsafe {
        let name = CFStringCreateWithBytes(std::ptr::null(), uti.as_ptr(), uti.len() as isize, UTF8, 0);
        let handler = CFStringCreateWithBytes(std::ptr::null(), bundle_id.as_ptr(), bundle_id.len() as isize, UTF8, 0);
        let status = if name.is_null() || handler.is_null() { -50 } else { LSSetDefaultRoleHandlerForContentType(name, ROLES_ALL, handler) };
        if !name.is_null() {
            CFRelease(name);
        }
        if !handler.is_null() {
            CFRelease(handler);
        }
        if status == 0 { Ok(()) } else { Err(status) }
    }
}

/// `UTI_RE` in `electron/default-apps.js`: dotted words, at least two.
pub fn valid_uti(text: &str) -> bool {
    let mut parts = text.split('.');
    let first = parts.next().unwrap_or("");
    let ok = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    ok(first) && text.contains('.') && parts.all(ok)
}

/// Windows (registry `UserChoice`) and Linux (`xdg-mime query default`) are
/// not read yet; the section then says default apps are a macOS feature.
#[cfg(not(target_os = "macos"))]
pub fn default_handler(_uti: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn set_default_handler(_uti: &str, _bundle_id: &str) -> Result<(), i32> {
    Err(-1)
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
        if !markie_core::paths::MAC_APP {
            assert!(status().iter().all(|f| !f.markie_rs));
        }
        let _ = default_handler("public.plain-text");
    }

    #[test]
    fn claims_every_type_of_the_chosen_formats_once_in_order() {
        assert_eq!(utis_for(&["markdown"]), ["net.daringfireball.markdown"]);
        assert_eq!(utis_for(&["rtf", "markdown", "rtf"]), ["net.daringfireball.markdown", "public.rtf"]);
        let all: Vec<&str> = FORMATS.iter().map(|f| f.id).collect();
        assert_eq!(
            utis_for(&all),
            [
                "net.daringfireball.markdown",
                "public.plain-text",
                "com.zvn.markie.darkmown",
                "org.openxmlformats.wordprocessingml.document",
                "public.rtf",
                "org.oasis-open.opendocument.text"
            ]
        );
        assert!(utis_for(&["csv", "nonsense"]).is_empty(), "only the offered formats");
    }

    #[test]
    fn the_dev_build_never_claims_and_says_why() {
        if !markie_core::paths::MAC_APP {
            assert!(!can_claim());
            assert_eq!(claim(&["markdown"]), Err(SIDE_BUILD_NOTE.to_string()));
        } else {
            assert_eq!(claim(&[]), Err("Choose a file type to open with Markie.".to_string()));
        }
    }

    #[test]
    fn only_well_formed_content_types_reach_launch_services() {
        for good in ["net.daringfireball.markdown", "public.plain-text", "com.zvn.markie", "org.oasis-open.opendocument.text"] {
            assert!(valid_uti(good), "{good}");
        }
        for bad in ["", "public", ".public", "public.", "a..b", "a.b c", "a.b\"", "a.b;rm", "a/b.c"] {
            assert!(!valid_uti(bad), "{bad}");
        }
        #[cfg(target_os = "macos")]
        assert_eq!(set_default_handler("not a uti", MARKIE_BUNDLE_ID), Err(-50), "refused before LaunchServices");
    }

    /// The same six formats, labels and content types Electron offers,
    /// read from `electron/default-apps.js` itself.
    #[test]
    fn the_formats_are_electrons_own_list() {
        let source = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../electron/default-apps.js")).unwrap();
        for f in FORMATS {
            let line = source.lines().find(|l| l.contains(&format!("id: \"{}\"", f.id))).unwrap_or_else(|| panic!("{} is not in Electron's list", f.id));
            assert!(line.contains(&format!("label: \"{}\"", f.label)), "{}", f.id);
            for uti in f.utis {
                assert!(line.contains(&format!("\"{uti}\"")), "{} {uti}", f.id);
            }
            for ext in f.extensions {
                assert!(line.contains(&format!("\"{ext}\"")), "{} {ext}", f.id);
            }
        }
        assert_eq!(source.matches("{ id: \"").count(), FORMATS.len(), "Electron offers no format this list lacks");
    }
}
