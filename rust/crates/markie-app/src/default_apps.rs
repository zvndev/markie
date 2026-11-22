//! Settings › Files, "Open with Markie": `electron/default-apps.js` and
//! `src/components/default-apps-section.tsx`.
//!
//! Markie RS is a side build and claims no file types, so the section shows
//! the same formats and who opens them today, with every claim button
//! disabled and the reason written in place. Reading the current handler is
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

pub fn supported() -> bool {
    cfg!(target_os = "macos")
}

/// The section, for Settings › Files.
pub fn render_section(cx: &gpui_kit::App) -> gpui_kit::AnyElement {
    use gpui_kit::component::button::Button;
    use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, IconName, Sizable as _, h_flex, v_flex};
    use gpui_kit::prelude::FluentBuilder as _;
    use gpui_kit::*;
    let theme = cx.theme();
    let muted = theme.muted_foreground;
    let border = theme.border;
    if !supported() {
        return div().text_size(px(12.)).text_color(muted).child("Default apps can be chosen in the Markie desktop app on macOS.").into_any_element();
    }
    let statuses = status();
    let green = theme.success;
    v_flex()
        .gap_3()
        .child(
            h_flex()
                .items_start()
                .justify_between()
                .gap_4()
                .child(
                    v_flex()
                        .gap_1()
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(muted).child("OPEN WITH MARKIE"))
                        .child(div().max_w(px(380.)).text_size(px(11.5)).text_color(muted).child(SIDE_BUILD_NOTE)),
                )
                .child(Button::new("default-apps-all").small().label("Use Markie RS for all").disabled(true)),
        )
        .child(v_flex().rounded_lg().border_1().border_color(border).children(FORMATS.iter().zip(statuses).enumerate().map(|(i, (f, s))| {
            h_flex()
                .gap_3()
                .px_3()
                .py_2()
                .when(i > 0, |el| el.border_t_1().border_color(border))
                .child(div().text_color(muted).child(Icon::new(IconName::File).small()))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(div().text_size(px(12.5)).child(f.label))
                        .child(div().text_size(px(10.5)).font_family("Menlo").text_color(muted).child(f.extensions.join("  ")))
                        .children(f.note.map(|n| div().text_size(px(11.)).text_color(muted).child(n))),
                )
                .child(if s.markie {
                    h_flex().gap_1().text_size(px(11.5)).text_color(green).child(Icon::new(IconName::Check).xsmall()).child("Markie").into_any_element()
                } else {
                    Button::new(SharedString::from(format!("default-app-{}", f.id))).xsmall().label("Use Markie RS").disabled(true).into_any_element()
                })
        })))
        .into_any_element()
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
