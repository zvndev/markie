//! The precedence ladder, first match wins: manual pin, front matter, path
//! rule, derived fallback. A port of `src/lib/projects/assign.ts`. This decides
//! only the project; blocks come from `cluster`.

use std::collections::{HashMap, HashSet};

use super::rules::{CompiledRules, MarkieRules, RuleOutcome, compile_glob, normalize};

#[derive(Clone, Debug, PartialEq)]
pub struct EngineFile {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub mtime_ms: f64,
    pub birthtime_ms: Option<f64>,
    pub fm_project: Option<String>,
    pub fm_block: Option<String>,
    pub repo_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pin {
    pub path: String,
    pub project: String,
    pub block_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssignmentSource {
    Pin,
    Frontmatter,
    Rule,
    Derived,
}

impl AssignmentSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pin => "pin",
            Self::Frontmatter => "frontmatter",
            Self::Rule => "rule",
            Self::Derived => "derived",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "pin" => Self::Pin,
            "frontmatter" => Self::Frontmatter,
            "rule" => Self::Rule,
            _ => Self::Derived,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectAssignment {
    pub path: String,
    pub project: String,
    pub fixed_block: Option<String>,
    pub pinned_block_id: Option<String>,
    pub source: AssignmentSource,
}

pub const UNFILED: &str = "Unfiled";
pub const CONTAINER_MIN_REPOS: usize = 3;
const MAX_CONTAINER_DEPTH: usize = 6;
const DEFAULT_CONTAINER_NAMES: [&str; 3] = ["Desktop", "Documents", "Downloads"];

fn trim(p: &str) -> String {
    normalize(p).trim_end_matches('/').to_string()
}

fn rel_segments(dir: &str, home: &str) -> Option<Vec<String>> {
    let d = trim(dir);
    let h = trim(home);
    if d == h {
        return Some(Vec::new());
    }
    let rest = d.strip_prefix(&format!("{h}/"))?;
    Some(rest.split('/').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Directories holding at least three different repositories.
pub fn discover_containers(files: &[EngineFile], home: &str) -> HashSet<String> {
    let h = trim(home);
    let mut repos_under: HashMap<String, HashSet<&str>> = HashMap::new();
    for file in files {
        let Some(repo) = file.repo_name.as_deref() else { continue };
        let Some(segs) = rel_segments(&file.dir, home) else { continue };
        let mut at = h.clone();
        for seg in segs.iter().take(MAX_CONTAINER_DEPTH) {
            repos_under.entry(at.clone()).or_default().insert(repo);
            at = format!("{at}/{seg}");
        }
    }
    repos_under.into_iter().filter(|(_, r)| r.len() >= CONTAINER_MIN_REPOS).map(|(d, _)| d).collect()
}

/// The project a folder falls in: step down from home through every container
/// and stop at the first folder that is not one.
pub fn container_child(dir: &str, home: &str, is_container: &dyn Fn(&str) -> bool) -> Option<String> {
    let segs = rel_segments(dir, home)?;
    let h = trim(home);
    let defaults: HashSet<String> =
        std::iter::once(h.clone()).chain(DEFAULT_CONTAINER_NAMES.iter().map(|n| format!("{h}/{n}"))).collect();
    let container = |d: &str| defaults.contains(d) || is_container(d);
    let mut at = h.clone();
    for seg in &segs {
        if !container(&at) {
            break;
        }
        at = format!("{at}/{seg}");
    }
    if at == h || container(&at) {
        return None;
    }
    Some(at[at.rfind('/').map_or(0, |i| i + 1)..].to_string())
}

pub struct Assigned {
    pub assignments: Vec<ProjectAssignment>,
    pub ignored: usize,
}

pub fn assign_projects(files: &[EngineFile], pins: &[Pin], rules: &MarkieRules, home: &str) -> Assigned {
    let pin_by_path: HashMap<&str, &Pin> = pins.iter().map(|p| (p.path.as_str(), p)).collect();
    let discovered = discover_containers(files, home);
    let extra: Vec<_> = rules.containers.iter().map(|g| compile_glob(g, home)).collect();
    let exempt: Vec<_> = rules.not_containers.iter().map(|g| compile_glob(g, home)).collect();
    let is_container = |d: &str| {
        if exempt.iter().any(|re| re.is_match(d)) {
            return false;
        }
        discovered.contains(d) || extra.iter().any(|re| re.is_match(d))
    };
    let compiled = CompiledRules::new(rules, home);
    // container_child is a pure function of the folder; memoize per folder.
    let mut by_dir: HashMap<&str, Option<String>> = HashMap::new();
    let mut out = Vec::with_capacity(files.len());
    let mut ignored = 0;
    for file in files {
        if let Some(pin) = pin_by_path.get(file.path.as_str()) {
            out.push(ProjectAssignment {
                path: file.path.clone(),
                project: pin.project.clone(),
                fixed_block: None,
                pinned_block_id: pin.block_id.clone(),
                source: AssignmentSource::Pin,
            });
            continue;
        }
        if let Some(project) = file.fm_project.clone() {
            out.push(ProjectAssignment {
                path: file.path.clone(),
                project,
                fixed_block: file.fm_block.clone(),
                pinned_block_id: None,
                source: AssignmentSource::Frontmatter,
            });
            continue;
        }
        match compiled.apply(&file.path, &file.dir, file.repo_name.as_deref()) {
            Some(RuleOutcome::Ignored) => {
                ignored += 1;
                continue;
            }
            Some(RuleOutcome::Placed { project, block }) => {
                out.push(ProjectAssignment {
                    path: file.path.clone(),
                    project,
                    fixed_block: block,
                    pinned_block_id: None,
                    source: AssignmentSource::Rule,
                });
                continue;
            }
            None => {}
        }
        let project = match &file.repo_name {
            Some(r) => r.clone(),
            None => by_dir
                .entry(file.dir.as_str())
                .or_insert_with(|| container_child(&file.dir, home, &is_container))
                .clone()
                .unwrap_or_else(|| UNFILED.to_string()),
        };
        out.push(ProjectAssignment {
            path: file.path.clone(),
            project,
            fixed_block: None,
            pinned_block_id: None,
            source: AssignmentSource::Derived,
        });
    }
    Assigned { assignments: out, ignored }
}

#[cfg(test)]
pub(crate) fn file(path: &str, mtime: f64) -> EngineFile {
    let (dir, name) = path.rsplit_once('/').unwrap();
    EngineFile {
        path: path.into(),
        name: name.into(),
        dir: dir.into(),
        mtime_ms: mtime,
        birthtime_ms: None,
        fm_project: None,
        fm_block: None,
        repo_name: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/k";

    #[test]
    fn container_child_walks_through_shelves() {
        let none = |_: &str| false;
        assert_eq!(container_child("/Users/k/Documents/Thesis/ch1", HOME, &none).as_deref(), Some("Thesis"));
        assert_eq!(container_child("/Users/k/Documents", HOME, &none), None);
        assert_eq!(container_child("/Users/k", HOME, &none), None);
        assert_eq!(container_child("/Users/k/Notes", HOME, &none).as_deref(), Some("Notes"));
        assert_eq!(container_child("/elsewhere/x", HOME, &none), None);
        let coding = |d: &str| d == "/Users/k/Desktop/Coding" || d == "/Users/k/Desktop/Coding/ZVN";
        assert_eq!(
            container_child("/Users/k/Desktop/Coding/ZVN/research/a", HOME, &coding).as_deref(),
            Some("research")
        );
    }

    #[test]
    fn discovers_shelves_with_three_repos() {
        let mut files = Vec::new();
        for repo in ["a", "b", "c"] {
            let mut f = file(&format!("/Users/k/Code/{repo}/README.md"), 1.0);
            f.repo_name = Some(repo.into());
            files.push(f);
        }
        let found = discover_containers(&files, HOME);
        assert!(found.contains("/Users/k/Code"));
        assert!(found.contains("/Users/k"));
        assert!(!found.contains("/Users/k/Code/a"));
    }

    #[test]
    fn ladder_order_pin_frontmatter_rule_derived() {
        let rules = super::super::rules::parse_rules(
            "---\nmarkie_rules:\n  rules:\n    - match: ~/Notes/**\n      project: Notes\n---\n",
        )
        .unwrap();
        let mut fm = file("/Users/k/Notes/fm.md", 1.0);
        fm.fm_project = Some("Declared".into());
        fm.fm_block = Some("B".into());
        let mut repo = file("/Users/k/Elsewhere/r/x.md", 1.0);
        repo.repo_name = Some("r".into());
        let files = vec![
            file("/Users/k/Notes/pinned.md", 1.0),
            fm,
            file("/Users/k/Notes/ruled.md", 1.0),
            repo,
            file("/Users/k/loose.md", 1.0),
            file("/Users/k/Downloads/x.md", 1.0),
        ];
        let pins = vec![Pin { path: "/Users/k/Notes/pinned.md".into(), project: "Mine".into(), block_id: Some("b_1".into()) }];
        let a = assign_projects(&files, &pins, &rules, HOME);
        let got: Vec<_> = a.assignments.iter().map(|x| (x.project.as_str(), x.source)).collect();
        assert_eq!(
            got,
            vec![
                ("Mine", AssignmentSource::Pin),
                ("Declared", AssignmentSource::Frontmatter),
                ("Notes", AssignmentSource::Rule),
                ("r", AssignmentSource::Derived),
                (UNFILED, AssignmentSource::Derived),
            ]
        );
        assert_eq!(a.ignored, 1);
        assert_eq!(a.assignments[0].pinned_block_id.as_deref(), Some("b_1"));
        assert_eq!(a.assignments[1].fixed_block.as_deref(), Some("B"));
    }
}
