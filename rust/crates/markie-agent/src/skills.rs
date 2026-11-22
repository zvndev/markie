//! Classify the device index without walking the disk again. Only read the
//! first 64 KiB of a representative SKILL.md for its description.
use markie_core::{formats::FormatKind, index::IndexedDoc};
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

fn file_kind(p: &str, n: &str) -> Kind {
    let folder = |names: &[&str]| names.iter().any(|name| p.contains(name));
    if matches!(n, "claude.md" | "agents.md" | "gemini.md" | ".cursorrules") {
        Kind::Instructions
    } else if p.contains("/skills/") {
        Kind::Skill
    } else if folder(&["/commands/", "/prompts/"]) {
        Kind::Command
    } else if p.contains("/agents/") {
        Kind::Agent
    } else if folder(&[
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

pub fn from_index(files: &[IndexedDoc], roots: &[(Tool, PathBuf)], home: &Path) -> Vec<Row> {
    let mut folders: BTreeMap<(Tool, PathBuf), (u8, Row)> = BTreeMap::new();
    let mut rows = Vec::new();
    for file in files
        .iter()
        .filter(|file| file.format == FormatKind::Markdown)
    {
        let path = file
            .path
            .strip_prefix(home)
            .unwrap_or(&file.path)
            .to_string_lossy()
            .replace('\\', "/");
        let full = format!("/{path}");
        let p = full.to_lowercase();
        let n = file.name.to_ascii_lowercase();
        if CACHE.iter().any(|part| p.contains(part)) {
            continue;
        }
        let root = roots.iter().find(|(_, dir)| file.path.starts_with(dir));
        let kind = file_kind(&p, &n);
        let tool = root
            .filter(|_| kind == Kind::Skill)
            .map(|(tool, _)| *tool)
            .or_else(|| {
                if n == "claude.md" || p.contains("/.claude/") {
                    Some(Tool::Claude)
                } else if n == "agents.md" || p.contains("/.codex/") {
                    Some(Tool::Codex)
                } else if n == "gemini.md" {
                    Some(Tool::Gemini)
                } else if n == ".cursorrules" || p.contains("/.cursor/") {
                    Some(Tool::Cursor)
                } else if p.contains("/.gemini/") {
                    Some(Tool::Gemini)
                } else if p.contains("/.agents/") {
                    Some(Tool::Universal)
                } else {
                    None
                }
            });
        let Some(tool) = tool else { continue };
        let skill_folder = (kind == Kind::Skill)
            .then(|| {
                file.path.ancestors().find(|path| {
                    path.parent()
                        .and_then(Path::file_name)
                        .is_some_and(|name| name.eq_ignore_ascii_case("skills"))
                        && path != &file.path
                })
            })
            .flatten()
            .map(Path::to_path_buf);
        let folder = skill_folder.clone().unwrap_or_else(|| file.dir.clone());
        let label = if kind == Kind::Skill {
            skill_folder
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| file.name.clone())
        } else if n == "readme.md" {
            format!(
                "{}/{}",
                file.dir.file_name().unwrap_or_default().to_string_lossy(),
                file.name
            )
        } else {
            file.name.clone()
        };
        let row = Row {
            tool,
            kind,
            label,
            path: file.path.clone(),
            removable: n == "skill.md" && root.is_some_and(|(_, r)| folder.parent() == Some(r)),
            folder: (kind == Kind::Skill).then_some(folder.clone()),
            description: None,
        };
        if kind != Kind::Skill {
            rows.push(row);
            continue;
        }
        let key = if skill_folder.is_some() {
            folder
        } else {
            file.path.clone()
        };
        let priority = match n.as_str() {
            "skill.md" => 0,
            "readme.md" => 1,
            _ => 2,
        };
        let entry = folders
            .entry((tool, key))
            .or_insert_with(|| (priority, row.clone()));
        if (priority, &row.path) < (entry.0, &entry.1.path) {
            *entry = (priority, row);
        }
    }
    for (_, (_, mut row)) in folders {
        if row
            .path
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("skill.md"))
            && let Ok(path) = crate::guarded_path(&row.path.to_string_lossy(), home, false)
            && let Ok(file) = File::open(path)
        {
            let mut bytes = Vec::new();
            if file.take(64 * 1024).read_to_end(&mut bytes).is_ok() {
                row.description = description(&String::from_utf8_lossy(&bytes));
            }
        }
        rows.push(row);
    }
    rows.sort_by(|a, b| {
        (a.tool, a.kind, a.label.to_lowercase(), &a.path).cmp(&(
            b.tool,
            b.kind,
            b.label.to_lowercase(),
            &b.path,
        ))
    });
    rows
}

pub fn description(text: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let fields = lines
        .by_ref()
        .take_while(|line| line.trim_end() != "---")
        .collect::<Vec<_>>();
    // take_while consumes the closing delimiter. Check directly to distinguish
    // a complete front matter block from a truncated read.
    if !text.lines().skip(1).any(|line| line.trim_end() == "---") {
        return None;
    }
    for (index, line) in fields.iter().enumerate() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim_end() != "description" {
            continue;
        }
        let value = value.trim();
        if let Some(style) = value.chars().next().filter(|c| matches!(c, '|' | '>'))
            && value[1..]
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '-' | '+'))
        {
            let block = fields[index + 1..]
                .iter()
                .copied()
                .take_while(|line| line.trim().is_empty() || line.starts_with(char::is_whitespace))
                .collect::<Vec<_>>();
            let indent = value[1..]
                .trim_matches(['-', '+'])
                .parse::<usize>()
                .ok()
                .or_else(|| {
                    block
                        .iter()
                        .find(|line| !line.trim().is_empty())
                        .map(|line| line.len() - line.trim_start().len())
                })
                .unwrap_or(0);
            let mut out = String::new();
            let mut nonempty = false;
            for line in block {
                if !line.trim().is_empty() && line.len() - line.trim_start().len() < indent {
                    break;
                }
                let part = if line.trim().is_empty() {
                    ""
                } else {
                    line.get(indent..).unwrap_or(line.trim_start())
                };
                if !out.is_empty() {
                    out.push(if style == '>' && nonempty && !part.is_empty() {
                        ' '
                    } else {
                        '\n'
                    });
                }
                out.push_str(part);
                nonempty = !part.is_empty();
            }
            return (!out.trim().is_empty()).then(|| out.trim_end().into());
        }
        let out = if let Some(quoted) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\''))
        {
            quoted.replace("''", "'")
        } else if value.starts_with('"') {
            serde_json::from_str::<String>(value).ok()?
        } else {
            if value.starts_with(['[', '{', '&', '*', '!', '#']) {
                return None;
            }
            value
                .split_once(" #")
                .map_or(value, |(s, _)| s)
                .trim_end()
                .into()
        };
        return (!out.is_empty()).then_some(out);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let dirs = roots(h, None, Some(h.join("moved-codex")));
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
            h,
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
        assert!(!cursor.removable);
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
