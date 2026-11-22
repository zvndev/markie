//! Markie's own icons, drawn from the same SVG paths as the Electron app
//! (`activity-bar.tsx`, `toolbar.tsx`, `library.tsx`, `format-badge.tsx`), so
//! the two apps show identical glyphs. GPUI paints an SVG as a mask in the
//! element's text colour, so every icon here is one colour.
//!
//! Served under `markie/` by [`MarkieAssets`], which falls back to GPUI Kit's
//! bundled Lucide icons for everything else.

use std::borrow::Cow;

use gpui_kit::*;

macro_rules! stroke {
    ($sw:literal, $body:literal) => {
        concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width=""#,
            $sw,
            r#"" stroke-linecap="round" stroke-linejoin="round">"#,
            $body,
            "</svg>"
        )
    };
}

/// (asset path, SVG source).
const ICONS: &[(&str, &str)] = &[
    // Activity bar.
    ("markie/new-file.svg", stroke!("1.8", r#"<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>"#)),
    ("markie/search.svg", stroke!("1.8", r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>"#)),
    ("markie/library.svg", stroke!("1.8", r#"<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>"#)),
    ("markie/browse.svg", stroke!("1.8", r#"<circle cx="12" cy="12" r="9"/><polygon points="15.5 8.5 10.5 10.5 8.5 15.5 13.5 13.5"/>"#)),
    ("markie/cloud.svg", stroke!("1.8", r#"<path d="M7 19a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 19z"/>"#)),
    ("markie/cloud-large.svg", stroke!("1.7", r#"<path d="M7 19a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 19z"/>"#)),
    ("markie/skills.svg", stroke!("1.8", r#"<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z"/>"#)),
    ("markie/vault.svg", stroke!("1.8", r#"<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2"/>"#)),
    ("markie/pencil.svg", stroke!("1.8", r#"<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>"#)),
    ("markie/agent.svg", stroke!("1.7", r#"<rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 8V4M9 4h6"/><circle cx="9.5" cy="13" r="1" fill="black" stroke="none"/><circle cx="14.5" cy="13" r="1" fill="black" stroke="none"/><path d="M2 12v3M22 12v3"/>"#)),
    ("markie/keyboard.svg", stroke!("1.6", r#"<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 13h6"/>"#)),
    ("markie/user.svg", stroke!("1.8", r#"<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>"#)),
    // Title bar.
    ("markie/open.svg", stroke!("2", r#"<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>"#)),
    ("markie/export.svg", stroke!("2", r#"<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/>"#)),
    ("markie/chevron-down-bold.svg", stroke!("3", r#"<polyline points="6 9 12 15 18 9"/>"#)),
    ("markie/copy.svg", stroke!("1.9", r#"<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>"#)),
    ("markie/copied.svg", stroke!("1.9", r#"<path d="m5 12.5 4.5 4.5L19 7.5"/>"#)),
    ("markie/commands.svg", stroke!("1.8", r#"<path d="m5 7 5 5-5 5M13 17h6"/>"#)),
    ("markie/system.svg", stroke!("1.9", r#"<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>"#)),
    ("markie/sun.svg", stroke!("1.9", r#"<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>"#)),
    ("markie/moon.svg", stroke!("1.9", r#"<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>"#)),
    ("markie/palette.svg", stroke!("1.8", r#"<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 11c0-4.97-4.48-9-10-9z"/>"#)),
    ("markie/share.svg", stroke!("2", r#"<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>"#)),
    ("markie/save-copy.svg", stroke!("2", r#"<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>"#)),
    ("markie/download.svg", stroke!("2", r#"<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>"#)),
    ("markie/code.svg", stroke!("2", r#"<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>"#)),
    ("markie/file-lines.svg", stroke!("2", r#"<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>"#)),
    // Comments and the share dialog (comments.tsx, share-dialog.tsx).
    // Cloud page (library.tsx SYNC_STATUS, cloud-view.tsx, document-cloud-library.tsx).
    ("markie/sync-synced.svg", stroke!("1.8", r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="m9.5 13 2 2 3.5-3.5"/>"#)),
    ("markie/sync-unpushed.svg", stroke!("1.8", r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2"/>"#)),
    ("markie/sync-paused.svg", stroke!("1.8", r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M10.5 11v4M13.5 11v4"/>"#)),
    ("markie/sync-conflict.svg", stroke!("1.8", r#"<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.2"/>"#)),
    ("markie/sync-behind.svg", stroke!("1.8", r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M12 10v5M9.8 12.8 12 15l2.2-2.2"/>"#)),
    ("markie/sync-shared.svg", stroke!("1.8", r#"<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="10" r="2.3"/><path d="M16 14.6a4.5 4.5 0 0 1 5 4.4"/>"#)),
    ("markie/people.svg", stroke!("1.7", r#"<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>"#)),
    ("markie/refresh.svg", stroke!("2", r#"<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>"#)),
    ("markie/comment.svg", stroke!("2", r#"<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>"#)),
    ("markie/link.svg", stroke!("2", r#"<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>"#)),
    ("markie/lock.svg", stroke!("2", r#"<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>"#)),
    ("markie/globe.svg", stroke!("2", r#"<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>"#)),
    ("markie/check.svg", stroke!("2", r#"<polyline points="20 6 9 17 4 12"/>"#)),
    ("markie/alert.svg", stroke!("2", r#"<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>"#)),
    // Side panels.
    ("markie/plus.svg", stroke!("2", r#"<path d="M12 5v14M5 12h14"/>"#)),
    ("markie/collapse.svg", stroke!("2", r#"<path d="M15 18l-6-6 6-6"/>"#)),
    ("markie/filter-search.svg", stroke!("2", r#"<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>"#)),
    ("markie/big-search.svg", stroke!("2", r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>"#)),
    ("markie/select-chevron.svg", stroke!("2.2", r#"<path d="m6 9 6 6 6-6"/>"#)),
    ("markie/on-device.svg", stroke!("1.8", r#"<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2.5 19h19"/>"#)),
    // Format page: outline, the 12% fill, and one glyph per family.
    ("markie/fmt-page.svg", stroke!("1.5", r#"<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/>"#)),
    ("markie/fmt-fill.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" fill="black"/></svg>"#),
    ("markie/fmt-markdown.svg", stroke!("1.3", r#"<path d="M7.8 17v-5l2 2.4 2-2.4v5M14.6 12v5M13.2 15.6l1.4 1.4 1.4-1.4"/>"#)),
    ("markie/fmt-docx.svg", stroke!("1.4", r#"<path d="M8.2 11.5l1.2 5 1.6-4.2 1.6 4.2 1.2-5"/>"#)),
    ("markie/fmt-rtf.svg", stroke!("1.4", r#"<path d="M9 17l2.6-6.5L14.2 17M10 15h3.2"/>"#)),
    ("markie/fmt-odt.svg", stroke!("1.3", r#"<circle cx="10.5" cy="13" r="1.9"/><path d="M14 13h2M8.5 17h7"/>"#)),
    ("markie/fmt-csv.svg", stroke!("1.2", r#"<path d="M8 11.5h8M8 14.5h8M8 17.5h8M11 10v9"/>"#)),
    ("markie/fmt-json.svg", stroke!("1.2", r#"<path d="M10.5 10.5c-1.2 0-1.5.6-1.5 1.6v.8c0 .6-.3 1.1-1 1.1.7 0 1 .5 1 1.1v.8c0 1 .3 1.6 1.5 1.6M13.5 10.5c1.2 0 1.5.6 1.5 1.6v.8c0 .6.3 1.1 1 1.1-.7 0-1 .5-1 1.1v.8c0 1-.3 1.6-1.5 1.6"/>"#)),
    ("markie/fmt-xml.svg", stroke!("1.4", r#"<path d="M10 11.5L8 14l2 2.5M14 11.5l2 2.5-2 2.5"/>"#)),
    ("markie/fmt-yaml.svg", stroke!("1.4", r#"<path d="M8.5 11.5h3M8.5 14.5h7M10.5 17.5h5"/>"#)),
    ("markie/fmt-darkmown.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M13.6 10.6a3.4 3.4 0 1 0 2.4 5.2 3.6 3.6 0 0 1-2.4-5.2z" fill="black"/></svg>"#),
    ("markie/fmt-text.svg", stroke!("1.4", r#"<path d="M8.5 11.5h7M8.5 14.5h7M8.5 17.5h4.5"/>"#)),
    ("markie/fmt-other.svg", stroke!("1.4", r#"<path d="M8.5 13h7M8.5 16h5"/>"#)),
];

/// The Markie wordmark: the lettering (painted in the text colour) and the
/// brand-red underline, as two layers from `src/lib/brand.ts`.
const LOGO_VIEWBOX: &str = r#"viewBox="375 520 563 246""#;
const LETTERING_PATH: &str = include_str!("../assets/logo-lettering.path");
const UNDERLINE_PATH: &str = include_str!("../assets/logo-underline.path");

pub const BRAND_RED: u32 = 0xEC4431;

fn logo_layer(d: &str) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="563" height="246" {LOGO_VIEWBOX}><path fill="black" fill-rule="evenodd" d="{}"/></svg>"#,
        d.trim()
    )
}

pub struct MarkieAssets;

impl AssetSource for MarkieAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(rest) = path.strip_prefix("markie/") {
            return Ok(match rest {
                "logo-lettering.svg" => Some(Cow::Owned(logo_layer(LETTERING_PATH).into_bytes())),
                "logo-underline.svg" => Some(Cow::Owned(logo_layer(UNDERLINE_PATH).into_bytes())),
                _ => ICONS.iter().find(|(p, _)| *p == path).map(|(_, s)| Cow::Borrowed(s.as_bytes())),
            });
        }
        gpui_kit::assets::AllAssets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        gpui_kit::assets::AllAssets.list(path)
    }
}

/// The glyph asset for a document format, and its colour (dark, light).
pub fn format_glyph(format: markie_core::formats::FormatKind) -> (&'static str, u32, u32) {
    use markie_core::formats::FormatKind as F;
    match format {
        F::Markdown => ("markie/fmt-markdown.svg", 0x7dd3fc, 0x0369a1),
        F::Docx | F::Doc => ("markie/fmt-docx.svg", 0x60a5fa, 0x1d4ed8),
        F::Rtf => ("markie/fmt-rtf.svg", 0x2dd4bf, 0x0f766e),
        F::Odt => ("markie/fmt-odt.svg", 0xa5b4fc, 0x4338ca),
        F::Text => ("markie/fmt-text.svg", 0xa1a1aa, 0x52525b),
        F::Darkmown => ("markie/fmt-darkmown.svg", 0xc4b5fd, 0x6d28d9),
        F::Csv => ("markie/fmt-csv.svg", 0x4ade80, 0x15803d),
        F::Json => ("markie/fmt-json.svg", 0xfacc15, 0xa16207),
        F::Yaml => ("markie/fmt-yaml.svg", 0xfb7185, 0xbe123c),
        F::Xml => ("markie/fmt-xml.svg", 0xfdba74, 0xb45309),
        F::Html => ("markie/fmt-xml.svg", 0xfb923c, 0xc2410c),
        F::Unsupported => ("markie/fmt-other.svg", 0xa1a1aa, 0x52525b),
    }
}

/// The short label on a row's type badge (`FORMAT_LABEL` in format-badge.tsx).
pub fn format_short(format: markie_core::formats::FormatKind) -> &'static str {
    use markie_core::formats::FormatKind as F;
    match format {
        F::Markdown => "MD",
        F::Docx => "DOCX",
        F::Doc => "DOC",
        F::Rtf => "RTF",
        F::Odt => "ODT",
        F::Text => "TXT",
        F::Darkmown => "WD",
        F::Csv => "CSV",
        F::Json => "JSON",
        F::Yaml => "YAML",
        F::Xml => "XML",
        F::Html => "HTML",
        F::Unsupported => "FILE",
    }
}

#[cfg(test)]
mod tests {
    use super::{ICONS, MarkieAssets};
    use gpui_kit::AssetSource as _;

    #[test]
    fn every_icon_and_the_logo_parse_as_svg() {
        for (path, _) in ICONS {
            let bytes = MarkieAssets.load(path).unwrap().unwrap();
            let text = std::str::from_utf8(&bytes).unwrap();
            assert!(text.starts_with("<svg") && text.ends_with("</svg>"), "{path}");
        }
        for path in ["markie/logo-lettering.svg", "markie/logo-underline.svg"] {
            assert!(MarkieAssets.load(path).unwrap().unwrap().len() > 1000, "{path}");
        }
        assert!(MarkieAssets.load("markie/nope.svg").unwrap().is_none());
    }
}
