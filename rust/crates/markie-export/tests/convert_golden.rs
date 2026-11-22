//! Converted copies against Electron's bytes, for every fixture and format.
//! The goldens are `convertForExport` and `markdownBlocks` run by
//! `scripts/goldens.mjs` over the same fixtures.

use std::path::PathBuf;

use markie_export::convert::{ExportFormat, SourceKind, convert_for_export, markdown_blocks};

fn dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)
}

fn fixtures() -> Vec<(String, String, SourceKind)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir("fixtures")).unwrap() {
        let path = entry.unwrap().path();
        let kind = match path.extension().and_then(|e| e.to_str()) {
            Some("md") => SourceKind::Markdown,
            Some("txt") => SourceKind::Text,
            _ => continue,
        };
        out.push((path.file_stem().unwrap().to_str().unwrap().to_string(), std::fs::read_to_string(&path).unwrap(), kind));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn blocks_match_electron() {
    for (stem, text, kind) in fixtures() {
        if kind != SourceKind::Markdown {
            continue;
        }
        let golden: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir("goldens").join(format!("{stem}.blocks.json"))).unwrap()).unwrap();
        let ours = serde_json::to_value(markdown_blocks(&text.replace("\r\n", "\n"))).unwrap();
        if golden != ours {
            let g = golden.as_array().unwrap();
            let o = ours.as_array().unwrap();
            for (i, (a, b)) in g.iter().zip(o.iter()).enumerate() {
                assert_eq!(a, b, "{stem}: block {i} differs");
            }
            assert_eq!(g.len(), o.len(), "{stem}: block count differs");
        }
    }
}

#[test]
fn bytes_match_electron() {
    let mut differ = Vec::new();
    for (stem, text, kind) in fixtures() {
        for format in ExportFormat::ALL {
            let golden = dir("goldens").join(format!("{stem}.convert.{}", format.info().extension));
            let Ok(expected) = std::fs::read(&golden) else { continue };
            let ours = convert_for_export(&text, kind, format).unwrap_or_else(|e| panic!("{stem} {:?}: {e}", format));
            if ours != expected {
                let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/web-export/convert");
                std::fs::create_dir_all(&out).unwrap();
                std::fs::write(out.join(format!("{stem}.rs.{}", format.info().extension)), &ours).unwrap();
                differ.push(format!("{stem}.{}", format.info().extension));
            }
        }
    }
    assert!(differ.is_empty(), "differ from Electron: {differ:?}");
}
