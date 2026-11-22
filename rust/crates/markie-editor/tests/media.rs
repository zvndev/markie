//! The pure helpers behind pictures, colours and fonts.

use markie_editor::media::{Source, css_color, css_size, font_family, resolve, sniff, youtube_id};

#[test]
fn colours_from_marks() {
    let a = css_color("#dc2626").unwrap();
    let b = css_color("rgb(220, 38, 38)").unwrap();
    assert!((a.h - b.h).abs() < 1e-3 && (a.s - b.s).abs() < 1e-3 && (a.l - b.l).abs() < 1e-3);
    assert!(css_color("#abc").is_some());
    assert!(css_color("red").is_some());
    assert!(css_color("banana").is_none());
}

#[test]
fn sizes_and_fonts() {
    assert_eq!(css_size("20px", 16.), Some(20.));
    assert_eq!(css_size("1.5em", 16.), Some(24.));
    assert_eq!(css_size("12pt", 16.), Some(16.));
    assert_eq!(css_size("nonsense", 16.), None);
    assert_eq!(font_family("Georgia, Charter, serif").as_deref(), Some("Georgia"));
    assert_eq!(font_family("'Iowan Old Style', Palatino").as_deref(), Some("Iowan Old Style"));
    assert_eq!(font_family("var(--font-geist-sans)"), None);
}

#[test]
fn picture_sources() {
    let base = std::path::Path::new("/docs");
    assert!(matches!(resolve("shot.png", Some(base)), Source::Local(p) if p == std::path::Path::new("/docs/shot.png")));
    assert!(matches!(resolve("a%20b.png", Some(base)), Source::Local(p) if p.ends_with("a b.png")));
    assert!(matches!(resolve("https://x.com/a.png", None), Source::Remote(_)));
    assert!(matches!(resolve("data:image/png;base64,iVBORw0KGgo=", None), Source::Inline(_)));
    assert!(matches!(resolve("rel.png", None), Source::None));
    assert!(sniff(b"\x89PNG\r\n").is_some());
    assert!(sniff(b"<svg xmlns=").is_some());
}

#[test]
fn youtube_thumbnails() {
    assert_eq!(youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
    assert_eq!(youtube_id("https://youtu.be/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
    assert_eq!(youtube_id("https://www.youtube.com/shorts/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
    assert_eq!(youtube_id("https://vimeo.com/123456789"), None);
}
