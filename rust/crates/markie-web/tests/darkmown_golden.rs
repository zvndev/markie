//! Darkmown previews against Electron's, for every fixture and frame variant.
//! The compiler is Electron's pinned JavaScript; its output (the goldens'
//! `compiled.json`) is the input here, and the finished srcdoc and warnings
//! must equal what `compileDarkmownPreview` built, byte for byte.

use std::path::PathBuf;

use markie_web::darkmown::limits::validate_preview_source;
use markie_web::darkmown::preview::{ColorScheme, Compiled, PreviewOptions, build_preview};
use markie_web::json::{self, Json};

fn dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)
}

const BASE: &str = "markie-asset://wd-0123456789abcdef0123456789abcdef";

fn variant(name: &str) -> (bool, PreviewOptions) {
    match name {
        "untrusted" => (false, PreviewOptions::default()),
        "trusted" => (true, PreviewOptions::default()),
        "trusted-dark" => (true, PreviewOptions { color_scheme: Some(ColorScheme::Dark), ..Default::default() }),
        "untrusted-links" => (false, PreviewOptions { links: true, picture_base: Some(BASE.into()), ..Default::default() }),
        "trusted-links" => (true, PreviewOptions { links: true, picture_base: Some(BASE.into()), ..Default::default() }),
        other => panic!("unknown variant {other}"),
    }
}

#[test]
fn previews_match_electron() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for entry in std::fs::read_dir(dir("fixtures")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("wd") {
            continue;
        }
        let stem = path.file_stem().unwrap().to_str().unwrap().to_string();
        let source = std::fs::read_to_string(&path).unwrap();
        let compiled = json::parse(&std::fs::read_to_string(dir("goldens").join(format!("{stem}.compiled.json"))).unwrap()).unwrap();
        let previews = json::parse(&std::fs::read_to_string(dir("goldens").join(format!("{stem}.preview.json"))).unwrap()).unwrap();
        let Json::Obj(previews) = previews else { panic!() };
        let limits = validate_preview_source(&source);
        for (name, expected) in previews {
            let (trusted, options) = variant(&name);
            if let Some(Json::Str(error)) = expected.get("error") {
                // Either the cheap limits refuse it (ported) or the JavaScript
                // compiler does (it runs in the web view, not here).
                match &limits {
                    Err(e) => assert_eq!(e, error, "{stem} {name}"),
                    Ok(()) => assert!(compiled.get("error").is_some() || error.contains("nested loops"), "{stem} {name}: {error}"),
                }
                continue;
            }
            assert!(limits.is_ok(), "{stem}: limits refused what Electron previews");
            let input = Compiled {
                body_html: compiled.get("bodyHtml").and_then(Json::as_str).unwrap().to_string(),
                title: compiled.get("title").and_then(Json::as_str).unwrap().to_string(),
                warnings: compiled.get("warnings").and_then(Json::as_arr).unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect(),
            };
            let ours = build_preview(&input, trusted, &options).unwrap_or_else(|e| panic!("{stem} {name}: {e}"));
            let src = expected.get("srcDoc").and_then(Json::as_str).unwrap();
            let warnings: Vec<String> = expected.get("warnings").and_then(Json::as_arr).unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect();
            if ours.src_doc != src || ours.warnings != warnings {
                let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/web-export/darkmown");
                std::fs::create_dir_all(&out).unwrap();
                std::fs::write(out.join(format!("{stem}.{name}.electron.html")), src.replace("><", ">\n<")).unwrap();
                std::fs::write(out.join(format!("{stem}.{name}.rs.html")), ours.src_doc.replace("><", ">\n<")).unwrap();
                failures.push(format!("{stem}.{name} (warnings {:?} vs {:?})", ours.warnings.len(), warnings.len()));
            }
            checked += 1;
        }
    }
    assert!(checked > 100, "only {checked} previews checked");
    assert!(failures.is_empty(), "{} differ: {failures:?}", failures.len());
}
