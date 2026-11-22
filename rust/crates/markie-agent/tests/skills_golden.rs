//! The Skills view rows Electron builds for a fixture tree
//! (scripts/skills-goldens.mjs runs its own code), against `from_index`.
use markie_agent::skills::{Kind, Tool, from_index, tool_roots};
use markie_core::{formats::FormatKind, index::IndexedDoc};
use serde_json::{Value, json};
use std::fs;

fn tool(t: Tool) -> &'static str {
    match t {
        Tool::Claude => "claude",
        Tool::Codex => "codex",
        Tool::Cursor => "cursor",
        Tool::Gemini => "gemini",
        Tool::Universal => "universal",
    }
}

fn kind(k: Kind) -> &'static str {
    match k {
        Kind::Skill => "skill",
        Kind::Instructions => "instructions",
        Kind::Command => "command",
        Kind::Agent => "agent",
        Kind::Memory => "memory",
        Kind::Other => "other",
    }
}

#[test]
fn rows_match_electrons_skills_view() {
    let golden: Value = serde_json::from_str(include_str!("goldens/skills.json")).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let home = scratch.path().canonicalize().unwrap();
    let mut files = Vec::new();
    for pair in golden["files"].as_array().unwrap() {
        let (rel, text) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        let path = home.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        files.push(IndexedDoc {
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            dir: path.parent().unwrap().to_path_buf(),
            path,
            format: FormatKind::Markdown,
            mtime_ms: 0.,
            size: text.len() as u64,
            snippet: None,
        });
    }
    let rel = |p: &std::path::Path| p.strip_prefix(&home).unwrap().to_string_lossy().into_owned();
    let rows: Vec<Value> = from_index(&files, &tool_roots(&home, None, None))
        .iter()
        .map(|r| {
            json!({
                "tool": tool(r.tool), "kind": kind(r.kind), "label": r.label,
                "path": rel(&r.path), "folder": r.folder.as_deref().map(rel),
                "removable": r.removable, "description": r.description,
            })
        })
        .collect();
    let want = golden["rows"].as_array().unwrap();
    for (i, (got, want)) in rows.iter().zip(want).enumerate() {
        assert_eq!(got, want, "row {i}");
    }
    assert_eq!(rows.len(), want.len());
}
