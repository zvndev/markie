//! The user's organization document, `Projects.md`, in the default Markie
//! folder. A port of `electron/projects-config.js`. Markie only ever rewrites
//! the region below the overview marker.
//!
//! One difference by design: Electron writes the template the first time the
//! Projects tab asks for the config. Markie RS reads an existing document but
//! writes the template only when the user asks to edit it, so opening the tab
//! in this side build never creates a file in the user's Documents folder.

use std::path::{Path, PathBuf};

pub const OVERVIEW_MARKER: &str = "<!-- markie:overview -->";

pub const DEFAULT_PROJECTS_MD: &str = r#"---
markie_rules:
  version: 1
  clustering:
    gap_hours: 24
    min_files: 1
    max_blocks_per_project: 30
  dumping_grounds:
    - "~/Downloads/**"
    - "~/.*/**"
  containers: []
  not_containers: []
  rules: []
  ignore: []
---
# Projects

This document controls how Markie organizes your markdown into projects and
blocks. Nothing here moves a file: your files stay exactly where they are, and
this is the view over them.

Edit the rules in the front matter above like any other document; Markie
re-reads them when you save. A rule looks like this:

```yaml
rules:
  - match: "~/Desktop/Coding/**"
    project: "{repo}"
  - match: "~/Documents/Notes/**"
    project: Notes
    block: "{folder}"
```

`{repo}` becomes the containing git repository's name, and `{folder}`
becomes the file's parent folder. Rules are tried in order and the first match
wins. Anything matching an `ignore` glob stays out of the Projects views
entirely (Browse still shows it).

`dumping_grounds` is the same idea for the places nobody writes their work:
an inbox like `~/Downloads`, and the hidden folders under your home that
belong to applications and agents. Delete a line to bring one back.

`containers` are folders that HOLD projects rather than being one, so the
folder inside them becomes the project instead. Markie finds most of them by
itself (any folder with several git repositories under it), and these two lists
are how you add one it missed or take back one it should not have taken.

Markie decides where a file belongs in this order: a file you moved by hand,
then a `markie: {project, block}` declaration in the file's own front matter,
then the rules above, then the folder and editing history it can see.

<!-- markie:overview -->
(The Projects view can write a listing of your projects here.)
"#;

pub struct ProjectsConfig {
    pub path: PathBuf,
    /// Empty when the document does not exist yet.
    pub content: String,
    pub exists: bool,
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("Projects.md")
}

/// Read the document without creating it.
pub fn read_config(dir: &Path) -> ProjectsConfig {
    let path = config_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(content) => ProjectsConfig { path, content, exists: true },
        Err(_) => ProjectsConfig { path, content: String::new(), exists: false },
    }
}

/// Electron's `ensureProjectsConfig`: the existing document, or the template
/// written once.
pub fn ensure_config(dir: &Path) -> std::io::Result<ProjectsConfig> {
    let cfg = read_config(dir);
    if cfg.exists {
        return Ok(cfg);
    }
    std::fs::create_dir_all(dir)?;
    crate::save::atomic_write(&cfg.path, DEFAULT_PROJECTS_MD.as_bytes())?;
    Ok(ProjectsConfig { path: cfg.path, content: DEFAULT_PROJECTS_MD.into(), exists: true })
}

/// Replace everything below the marker, keeping every byte above it.
pub fn write_overview_section(content: &str, listing: &str) -> String {
    let body = format!("{OVERVIEW_MARKER}\n{listing}");
    match content.find(OVERVIEW_MARKER) {
        Some(i) => format!("{}{body}", &content[..i]),
        None => {
            let sep = if content.ends_with('\n') { "\n" } else { "\n\n" };
            format!("{content}{sep}{body}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_rewrites_only_below_the_marker() {
        let doc = format!("---\na: 1\n---\nmine\n{OVERVIEW_MARKER}\nold listing\n");
        assert_eq!(write_overview_section(&doc, "- new"), format!("---\na: 1\n---\nmine\n{OVERVIEW_MARKER}\n- new"));
        assert_eq!(write_overview_section("x", "L"), format!("x\n\n{OVERVIEW_MARKER}\nL"));
        assert_eq!(write_overview_section("x\n", "L"), format!("x\n\n{OVERVIEW_MARKER}\nL"));
    }

    #[test]
    fn reads_without_creating_and_ensures_once() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("Markie");
        assert!(!read_config(&d).exists);
        assert!(!d.exists(), "reading never creates the folder");
        let made = ensure_config(&d).unwrap();
        assert_eq!(made.content, DEFAULT_PROJECTS_MD);
        std::fs::write(&made.path, "mine").unwrap();
        assert_eq!(ensure_config(&d).unwrap().content, "mine");
    }
}
