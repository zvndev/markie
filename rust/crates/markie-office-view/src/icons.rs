//! The Word toolbar's icons, drawn from the same SVG paths as Electron's
//! `formatting-toolbar.tsx` and `word-document-editor.tsx`: a 24-unit box,
//! 1.8 stroke, round caps and joins, painted at 15 px in the text color.

macro_rules! icon {
    ($name:ident, $body:literal) => {
        pub const $name: &[u8] = concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">"#,
            $body,
            "</svg>"
        )
        .as_bytes();
    };
}

icon!(PAGE_SETUP, r#"<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8.5 7h7M8.5 17h7M8.5 7v10M15.5 7v10" stroke-dasharray="1.6 2"/>"#);
icon!(SPACING, r#"<path d="M11 6h9M11 12h9M11 18h9M5 4v16M3 6l2-2 2 2M3 18l2 2 2-2"/>"#);
icon!(UNDO, r#"<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>"#);
icon!(REDO, r#"<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>"#);
icon!(HISTORY, r#"<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>"#);
icon!(ZOOM_OUT, r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/>"#);
icon!(ZOOM_IN, r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>"#);
icon!(MINUS, r#"<path d="M5 12h14"/>"#);
icon!(PLUS, r#"<path d="M12 5v14"/><path d="M5 12h14"/>"#);
icon!(LINK, r#"<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>"#);
icon!(IMAGE, r#"<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>"#);
icon!(BULLETS, r#"<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>"#);
icon!(NUMBERED, r#"<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/>"#);
icon!(ALIGN_LEFT, r#"<path d="M3 6h18"/><path d="M3 12h12"/><path d="M3 18h15"/>"#);
icon!(ALIGN_CENTER, r#"<path d="M3 6h18"/><path d="M6 12h12"/><path d="M5 18h14"/>"#);
icon!(ALIGN_RIGHT, r#"<path d="M3 6h18"/><path d="M9 12h12"/><path d="M6 18h15"/>"#);
icon!(CLEAR, r#"<path d="m16 16 5-5"/><path d="m21 16-5-5"/><path d="m3 19 6.5-6.5"/><path d="m13 3 8 8"/><path d="M3 19h8"/>"#);
icon!(MORE, r#"<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>"#);
icon!(CHEVRON, r#"<path d="m6 9 6 6 6-6"/>"#);
