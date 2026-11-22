//! Classify the device index without walking the disk again. Only read the
//! first 64 KiB of a representative SKILL.md for its description.
use markie_core::index::IndexedDoc;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tool {
    Claude,
    Codex,
    Cursor,
    Gemini,
    Universal,
}

impl Tool {
    pub const ALL: [Self; 5] = [
        Self::Claude,
        Self::Codex,
        Self::Cursor,
        Self::Gemini,
        Self::Universal,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
            Self::Gemini => "Gemini",
            Self::Universal => "Universal",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Skill,
    Instructions,
    Command,
    Agent,
    Memory,
    Other,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Skill => "Skills",
            Self::Instructions => "Instructions",
            Self::Command => "Commands",
            Self::Agent => "Subagents",
            Self::Memory => "Memory & notes",
            Self::Other => "Other",
        }
    }
}

#[derive(Clone)]
pub struct Row {
    pub tool: Tool,
    pub kind: Kind,
    pub label: String,
    pub path: PathBuf,
    pub folder: Option<PathBuf>,
    pub removable: bool,
    pub description: Option<String>,
}

const CACHE: &[&str] = &[
    "/plugins/cache/",
    "/plugins/marketplaces/",
    "/bundled-marketplaces/",
    "/vendor_imports/",
    "/.tmp/",
    "/tmp/",
    "/node_modules/",
    "/.git/",
    "/caches/",
    "/.cache/",
    "/.trash/",
    "/.removed-skills/",
    "/backups/",
    "/shell-snapshots/",
    "/paste-cache/",
    "/browser-profiles/",
    "/file-history/",
];

pub fn roots(home: &Path, claude: Option<PathBuf>, codex: Option<PathBuf>) -> Vec<(Tool, PathBuf)> {
    let mut dirs = [
        (Tool::Claude, ".claude"),
        (Tool::Codex, ".codex"),
        (Tool::Cursor, ".cursor"),
        (Tool::Gemini, ".gemini"),
        (Tool::Universal, ".agents"),
    ]
    .into_iter()
    .map(|(tool, dir)| (tool, home.join(dir).join("skills")))
    .collect::<Vec<_>>();
    dirs.extend(
        [
            claude.map(|p| (Tool::Claude, p.join("skills"))),
            codex.map(|p| (Tool::Codex, p.join("skills"))),
        ]
        .into_iter()
        .flatten(),
    );
    dirs
}

pub fn trash_target(path: &Path, roots: &[(Tool, PathBuf)]) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() {
        return Err("That is not a skill folder.");
    }
    let real = path
        .canonicalize()
        .map_err(|_| "That skill folder is not there any more.")?;
    if !real.is_dir() {
        return Err("That is not a skill folder.");
    }
    let permitted = roots
        .iter()
        .filter_map(|(_, dir)| dir.canonicalize().ok())
        .any(|dir| {
            real.parent().is_some_and(|parent| {
                if cfg!(windows) {
                    parent
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&dir.to_string_lossy())
                } else {
                    parent == dir
                }
            })
        });
    if !permitted {
        return Err("Markie only removes skills from your agents' skills folders.");
    }
    Ok(real)
}

/// `agentFileKind` (src/lib/agent-files.ts) on a lower-cased, `/` path.
fn file_kind(p: &str, n: &str) -> Kind {
    let any = |names: &[&str]| names.iter().any(|name| p.contains(name));
    if matches!(n, "claude.md" | "agents.md" | "gemini.md" | ".cursorrules") {
        Kind::Instructions
    } else if p.contains("/skills/") {
        Kind::Skill
    } else if any(&["/commands/", "/prompts/"]) {
        Kind::Command
    } else if p.contains("/agents/") {
        Kind::Agent
    } else if any(&[
        "/agent-memory/",
        "/memory/",
        "/projects/",
        "/sessions/",
        "/transcripts/",
        "/plans/",
        "/tasks/",
        "/jobs/",
    ]) {
        Kind::Memory
    } else if p.contains("/.cursor/rules/") {
        Kind::Instructions
    } else {
        Kind::Other
    }
}

/// electron/mdindex.js `skillRoots`: the folder each tool keeps its files in,
/// the configured Claude and Codex homes replacing the conventional ones.
pub fn tool_roots(home: &Path, claude: Option<PathBuf>, codex: Option<PathBuf>) -> Vec<(Tool, PathBuf)> {
    vec![
        (Tool::Claude, claude.unwrap_or_else(|| home.join(".claude"))),
        (Tool::Codex, codex.unwrap_or_else(|| home.join(".codex"))),
        (Tool::Cursor, home.join(".cursor")),
        (Tool::Gemini, home.join(".gemini")),
        (Tool::Universal, home.join(".agents")),
    ]
}

/// `skillGroupFor` (src/lib/skills-panel.ts). `skill_tool` is the index's
/// `row.skill.tool`, which only a SKILL.md under a tool root has.
fn group_for(p: &str, n: &str, skill_tool: Option<Tool>) -> Option<Tool> {
    if is_cached(p) {
        return None;
    }
    if skill_tool.is_some() {
        return skill_tool;
    }
    // classifyAgentFile (mcp/agent-classify.mjs), then the folder fallbacks.
    if n == "claude.md" || p.contains("/.claude/") {
        Some(Tool::Claude)
    } else if n == "agents.md" || p.contains("/.codex/") {
        Some(Tool::Codex)
    } else if n == "gemini.md" {
        Some(Tool::Gemini)
    } else if n == ".cursorrules" || p.contains("/.cursor/rules/") || p.contains("/.cursor/") {
        Some(Tool::Cursor)
    } else if p.contains("/.gemini/") {
        Some(Tool::Gemini)
    } else if p.contains("/.agents/") {
        Some(Tool::Universal)
    } else {
        None
    }
}

fn is_cached(p: &str) -> bool {
    CACHE.iter().any(|part| p.contains(part))
}

fn slashed(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// `skillRootOf`: the folder right under the last `/skills/`, when the file
/// sits inside it rather than directly in `skills`.
fn skill_root_of(path: &str) -> Option<String> {
    let marker = path.to_lowercase().rfind("/skills/")?;
    let after = &path[marker + "/skills/".len()..];
    let name = after.split('/').next().filter(|n| !n.is_empty())?;
    after.contains('/').then(|| format!("{}/skills/{name}", &path[..marker]))
}

/// `skillToolFor`: which tool root a SKILL.md is under.
fn skill_tool(path: &Path, tool_roots: &[(Tool, PathBuf)]) -> Option<Tool> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if name != "skill.md" {
        return None;
    }
    tool_roots
        .iter()
        .find(|(_, root)| path.starts_with(root) && path != root)
        .map(|(tool, _)| *tool)
}

/// The SKILL.md description, read as mdindex.js reads it: the first 64 KiB.
fn read_description(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path).ok()?.take(64 * 1024).read_to_end(&mut bytes).ok()?;
    description(&String::from_utf8_lossy(&bytes))
}

/// `agentFileLabel`: a SKILL.md or README.md is named with its folder.
fn file_label(path: &str, name: &str) -> String {
    let n = name.to_lowercase();
    if n != "skill.md" && n != "readme.md" {
        return name.into();
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.len().checked_sub(2).map(|i| segments[i]) {
        Some(parent) => format!("{parent}/{name}"),
        None => name.into(),
    }
}

/// A stand-in for `localeCompare` in the default collation: case folded.
fn label_order(a: &Row, b: &Row) -> std::cmp::Ordering {
    a.label
        .to_lowercase()
        .cmp(&b.label.to_lowercase())
        // ICU puts lower case first among labels that differ only in case.
        .then_with(|| b.label.cmp(&a.label))
}

/// The Skills view's rows, as skills-view.tsx builds them from the device
/// index: skills collapsed to one row per skill folder, every other agent file
/// one row each, grouped by tool and kind and sorted by label.
pub fn from_index(files: &[IndexedDoc], tool_roots: &[(Tool, PathBuf)]) -> Vec<Row> {
    let mut skills: BTreeMap<Tool, Vec<&IndexedDoc>> = BTreeMap::new();
    let mut rows = Vec::new();
    for file in files {
        let full = slashed(&file.path);
        let p = full.to_lowercase();
        let n = file.name.to_lowercase();
        let kind = file_kind(&p, &n);
        if kind == Kind::Skill {
            if let Some(tool) = group_for(&p, &n, skill_tool(&file.path, tool_roots)) {
                skills.entry(tool).or_default().push(file);
            }
            continue;
        }
        let Some(tool) = group_for(&p, &n, None) else { continue };
        rows.push(Row {
            tool,
            kind,
            label: file_label(&full, &file.name),
            path: file.path.clone(),
            folder: None,
            removable: false,
            description: None,
        });
    }
    for (tool, files) in skills {
        // collapseSkills: one row per skill folder, in first-seen order.
        let mut folders: Vec<(String, Vec<&IndexedDoc>)> = Vec::new();
        let mut loose = Vec::new();
        for file in files {
            match skill_root_of(&slashed(&file.path)) {
                Some(root) => match folders.iter_mut().find(|(r, _)| *r == root) {
                    Some((_, group)) => group.push(file),
                    None => folders.push((root, vec![file])),
                },
                None => loose.push(file),
            }
        }
        let skill_row = |file: &IndexedDoc, label: String, folder: PathBuf| {
            let tool_of = skill_tool(&file.path, tool_roots);
            Row {
                tool,
                kind: Kind::Skill,
                label,
                path: file.path.clone(),
                folder: Some(folder),
                removable: tool_of.is_some(),
                // mdindex.js describes every SKILL.md, in a tool root or not.
                description: file
                    .name
                    .eq_ignore_ascii_case("skill.md")
                    .then(|| read_description(&file.path))
                    .flatten(),
            }
        };
        for (root, group) in folders {
            // skillEntry: the SKILL.md, else the shallowest file.
            let entry = group
                .iter()
                .find(|f| f.name.eq_ignore_ascii_case("skill.md"))
                .copied()
                .unwrap_or_else(|| {
                    let depth = |f: &IndexedDoc| slashed(&f.path).split('/').count();
                    *group
                        .iter()
                        .min_by(|a, b| depth(a).cmp(&depth(b)).then_with(|| a.path.cmp(&b.path)))
                        .expect("a skill folder has a file")
                });
            let label = root.rsplit('/').next().unwrap_or(&root).to_owned();
            rows.push(skill_row(entry, label, PathBuf::from(&root)));
        }
        for file in loose {
            rows.push(skill_row(file, file.name.clone(), file.dir.clone()));
        }
    }
    rows.sort_by(|a, b| {
        (a.tool, a.kind)
            .cmp(&(b.tool, b.kind))
            .then_with(|| label_order(a, b))
    });
    rows
}

pub use crate::frontmatter::description;

/// electron/registry.js's two skill tables, column for column. Electron 0.9.7
/// creates them and nothing reads them yet; Markie RS keeps the same shape in
/// its own registry so a catalog can use them later.
pub const SKILL_TABLES: &str = "CREATE TABLE IF NOT EXISTS skill_sources (
       id TEXT PRIMARY KEY,
       added_at TEXT
     );
     CREATE TABLE IF NOT EXISTS skill_installs (
       path TEXT PRIMARY KEY,
       target TEXT NOT NULL,
       name TEXT NOT NULL,
       source TEXT,
       skill_path TEXT,
       folder_hash TEXT,
       root TEXT,
       installed_at TEXT NOT NULL
     );";

/// Creates the skill tables in Markie RS's registry, idempotently.
pub fn ensure_skill_tables(registry: &markie_core::registry::Registry) -> Result<(), String> {
    registry.conn().execute_batch(SKILL_TABLES).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use markie_core::formats::FormatKind;
    use std::fs;

    fn file(home: &Path, rel: &str, text: &str) -> IndexedDoc {
        let path = home.join(rel);
        let dir = path.parent().unwrap().to_path_buf();
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, text).unwrap();
        IndexedDoc {
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            path,
            dir,
            format: FormatKind::Markdown,
            mtime_ms: 0.,
            size: text.len() as u64,
            snippet: None,
        }
    }

    #[test]
    fn root_precedence_cache_exclusion_deduplication_and_descriptions() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let dirs = tool_roots(h, None, Some(h.join("moved-codex")));
        let rows = from_index(
            &[
                file(
                    h,
                    "moved-codex/skills/quality/SKILL.md",
                    "---\ndescription: >-\n  Review code\n  for quality\n---\n",
                ),
                file(
                    h,
                    "moved-codex/skills/quality/refs/README.md",
                    "supporting notes",
                ),
                file(
                    h,
                    ".claude/plugins/cache/other/skills/example/SKILL.md",
                    "cached",
                ),
                file(h, "project/CLAUDE.md", "instructions"),
                file(
                    h,
                    "project/.cursor/skills/demo/SKILL.md",
                    "---\ndescription: 'A ''quoted'' skill'\n---",
                ),
                file(h, ".gemini/skills/y/SKILL.md", "skill"),
                file(h, ".agents/skills/z/SKILL.md", "skill"),
            ],
            &dirs,
        );
        assert_eq!(rows.len(), 5);
        assert_eq!(rows.iter().map(|r| r.tool).collect::<Vec<_>>(), Tool::ALL);
        let codex = rows.iter().find(|r| r.tool == Tool::Codex).unwrap();
        assert_eq!(
            codex.description.as_deref(),
            Some("Review code for quality")
        );
        assert_eq!(codex.label, "quality");
        assert!(codex.removable);
        let cursor = rows.iter().find(|r| r.tool == Tool::Cursor).unwrap();
        assert_eq!(cursor.description.as_deref(), Some("A 'quoted' skill"));
        let claude = rows.iter().find(|r| r.tool == Tool::Claude).unwrap();
        assert_eq!((claude.kind, claude.label.as_str()), (Kind::Instructions, "CLAUDE.md"));
        assert!(!cursor.removable);
    }

    #[test]
    fn the_registry_gets_electrons_skill_tables() {
        let registry = markie_core::registry::Registry::in_memory().unwrap();
        ensure_skill_tables(&registry).unwrap();
        ensure_skill_tables(&registry).unwrap();
        let columns = |table: &str| -> Vec<String> {
            let mut stmt = registry.conn().prepare(&format!("PRAGMA table_info({table})")).unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(columns("skill_sources"), ["id", "added_at"]);
        assert_eq!(
            columns("skill_installs"),
            ["path", "target", "name", "source", "skill_path", "folder_hash", "root", "installed_at"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn trash_guard_only_allows_direct_real_install_directories() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let actual = h.join(".claude/skills/actual");
        let project = h.join("project/.claude/skills/project-skill");
        fs::create_dir_all(actual.join("refs")).unwrap();
        fs::create_dir_all(&project).unwrap();
        let link = h.join(".claude/skills/link");
        std::os::unix::fs::symlink(&project, &link).unwrap();
        let roots = roots(h, None, None);
        assert_eq!(
            trash_target(&actual, &roots).unwrap(),
            actual.canonicalize().unwrap()
        );
        for p in [&link, &project, &actual.join("refs")] {
            assert!(trash_target(p, &roots).is_err());
        }
    }
}
