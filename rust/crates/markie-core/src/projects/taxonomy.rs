//! The tree the Projects panel shows: assignments, then per-project blocks,
//! most recent first, Unfiled last. A port of `src/lib/projects/taxonomy.ts`
//! and `search.ts` (`filterTaxonomy`).

use std::collections::HashMap;

use super::assign::{AssignmentSource, EngineFile, Pin, UNFILED, assign_projects};
use super::cluster::{BlockRecord, PriorAssignment, derive_blocks};
use super::rules::MarkieRules;
use super::{iso_from_ms, max_of, min_of, ms_from_iso};

#[derive(Clone, Debug, PartialEq)]
pub struct BlockNode {
    pub id: String,
    pub name: String,
    pub made: f64,
    pub updated: f64,
    pub files: Vec<EngineFile>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectNode {
    /// What every stored decision is keyed by. Never changes on rename.
    pub key: String,
    /// The user's own name if they gave one, otherwise the key.
    pub name: String,
    pub made: f64,
    pub updated: f64,
    pub file_count: usize,
    pub blocks: Vec<BlockNode>,
    /// Files that never clustered with anything.
    pub loose_files: Vec<EngineFile>,
    pub is_unfiled: bool,
}

impl ProjectNode {
    /// Every file in the project once, newest first: what the side panel lists.
    pub fn files(&self) -> Vec<&EngineFile> {
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<&EngineFile> = self
            .blocks
            .iter()
            .flat_map(|b| b.files.iter())
            .chain(self.loose_files.iter())
            .filter(|f| seen.insert(f.path.as_str()))
            .collect();
        out.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal));
        out
    }

    /// The folder most of the files share, when at least two do. Rows in that
    /// folder skip their folder line.
    pub fn common_dir(&self) -> Option<String> {
        let files = self.files();
        if files.len() < 2 {
            return None;
        }
        let mut counts: Vec<(&str, usize)> = Vec::new();
        for f in &files {
            match counts.iter_mut().find(|(d, _)| *d == f.dir) {
                Some(c) => c.1 += 1,
                None => counts.push((&f.dir, 1)),
            }
        }
        let (mut best, mut n) = (None, 0);
        for (d, c) in counts {
            if c > n {
                best = Some(d);
                n = c;
            }
        }
        best.filter(|_| n > 1).map(str::to_string)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectNameRecord {
    pub project: String,
    pub custom_name: Option<String>,
    pub user_created: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AssignmentRow {
    pub path: String,
    pub project: String,
    pub block_id: Option<String>,
    pub source: AssignmentSource,
    pub mtime_ms: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Taxonomy {
    pub projects: Vec<ProjectNode>,
    pub total_files: usize,
    pub unfiled_count: usize,
    pub ignored_count: usize,
    pub assignment_rows: Vec<AssignmentRow>,
    pub block_upserts: Vec<BlockRecord>,
}

pub struct TaxonomyInputs<'a> {
    pub pins: &'a [Pin],
    pub rules: &'a MarkieRules,
    pub prior_assignments: &'a [PriorAssignment],
    pub known_blocks: &'a [BlockRecord],
    pub project_names: &'a [ProjectNameRecord],
    pub home: &'a str,
    pub now: f64,
}

fn fixed_block_id(project: &str, block: &str) -> String {
    format!("f_{project}::{block}")
}

/// Most recent first, Unfiled always last.
pub fn by_recency_unfiled_last(a: &ProjectNode, b: &ProjectNode) -> std::cmp::Ordering {
    a.is_unfiled
        .cmp(&b.is_unfiled)
        .then(b.updated.partial_cmp(&a.updated).unwrap_or(std::cmp::Ordering::Equal))
}

fn by_mtime_desc(a: &EngineFile, b: &EngineFile) -> std::cmp::Ordering {
    b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal)
}

pub fn build_taxonomy(files: &[EngineFile], o: &TaxonomyInputs) -> Taxonomy {
    let named: HashMap<&str, &ProjectNameRecord> = o.project_names.iter().map(|r| (r.project.as_str(), r)).collect();
    let display = |key: &str| {
        named
            .get(key)
            .and_then(|r| r.custom_name.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(key)
            .to_string()
    };
    let assigned = assign_projects(files, o.pins, o.rules, o.home);
    let file_by_path: HashMap<&str, &EngineFile> = files.iter().map(|f| (f.path.as_str(), f)).collect();
    let prior_by_path: HashMap<&str, &PriorAssignment> =
        o.prior_assignments.iter().map(|p| (p.path.as_str(), p)).collect();
    let known_by_id: HashMap<&str, &BlockRecord> = o.known_blocks.iter().map(|b| (b.block_id.as_str(), b)).collect();

    // Insertion-ordered grouping by project.
    let mut project_order: Vec<&str> = Vec::new();
    let mut by_project: HashMap<&str, Vec<&super::assign::ProjectAssignment>> = HashMap::new();
    for a in &assigned.assignments {
        by_project
            .entry(a.project.as_str())
            .or_insert_with(|| {
                project_order.push(a.project.as_str());
                Vec::new()
            })
            .push(a);
    }
    let mut known_by_project: HashMap<&str, Vec<&BlockRecord>> = HashMap::new();
    for b in o.known_blocks {
        known_by_project.entry(b.project.as_str()).or_default().push(b);
    }

    let mut assignment_rows = Vec::new();
    let mut block_upserts = Vec::new();
    let mut projects = Vec::new();

    for project in &project_order {
        let members = &by_project[project];
        let mut block_order: Vec<String> = Vec::new();
        let mut block_files: HashMap<String, Vec<&EngineFile>> = HashMap::new();
        let mut add_to = |id: &str, f: &'_ EngineFile, order: &mut Vec<String>| {
            let _ = f;
            if !block_files.contains_key(id) {
                order.push(id.to_string());
            }
            block_files.entry(id.to_string()).or_default().push(file_by_path[f.path.as_str()]);
        };
        let mut declared: HashMap<String, String> = HashMap::new();
        let mut to_cluster: Vec<&EngineFile> = Vec::new();
        let mut source_by_path: HashMap<&str, AssignmentSource> = HashMap::new();
        let mut project_rows: Vec<AssignmentRow> = Vec::new();

        for a in members {
            let Some(f) = file_by_path.get(a.path.as_str()).copied() else { continue };
            let fixed = a
                .pinned_block_id
                .clone()
                .or_else(|| a.fixed_block.as_deref().map(|b| fixed_block_id(project, b)));
            let Some(fixed) = fixed else {
                to_cluster.push(f);
                source_by_path.insert(&f.path, a.source);
                continue;
            };
            if let Some(b) = &a.fixed_block {
                declared.insert(fixed.clone(), b.clone());
            }
            add_to(&fixed, f, &mut block_order);
            project_rows.push(AssignmentRow {
                path: a.path.clone(),
                project: project.to_string(),
                block_id: Some(fixed),
                source: a.source,
                mtime_ms: f.mtime_ms,
            });
        }

        let priors: Vec<&PriorAssignment> =
            to_cluster.iter().filter_map(|f| prior_by_path.get(f.path.as_str()).copied()).collect();
        let known = known_by_project.get(project).cloned().unwrap_or_default();
        let derived = derive_blocks(project, &to_cluster, &priors, &known, &o.rules.clustering, o.now);
        let derived_by_id: HashMap<&str, &BlockRecord> =
            derived.blocks.iter().map(|b| (b.block_id.as_str(), b)).collect();
        for f in &to_cluster {
            let id = derived.by_path.get(&f.path).cloned();
            if let Some(id) = &id {
                add_to(id, f, &mut block_order);
            }
            project_rows.push(AssignmentRow {
                path: f.path.clone(),
                project: project.to_string(),
                block_id: id,
                source: source_by_path.get(f.path.as_str()).copied().unwrap_or(AssignmentSource::Derived),
                mtime_ms: f.mtime_ms,
            });
        }

        let mut blocks = Vec::new();
        let mut loose: Vec<EngineFile> = Vec::new();
        let mut dissolved = std::collections::HashSet::new();
        for id in &block_order {
            let entry = &block_files[id];
            let known = known_by_id.get(id.as_str());
            let drv = derived_by_id.get(id.as_str());
            if entry.len() == 1
                && drv.is_some()
                && known.is_none_or(|k| k.custom_name.is_none() && k.merged_into.is_none())
            {
                loose.push(entry[0].clone());
                dissolved.insert(id.clone());
                continue;
            }
            let auto = drv
                .map(|d| d.auto_name.clone())
                .or_else(|| known.map(|k| k.auto_name.clone()))
                .or_else(|| declared.get(id).cloned())
                .unwrap_or_else(|| id.clone());
            let made = min_of(entry.iter().map(|f| f.birthtime_ms.unwrap_or(f.mtime_ms)));
            let updated = max_of(entry.iter().map(|f| f.mtime_ms));
            let mut files: Vec<EngineFile> = entry.iter().map(|f| (*f).clone()).collect();
            files.sort_by(by_mtime_desc);
            let custom = known.and_then(|k| k.custom_name.clone());
            blocks.push(BlockNode { id: id.clone(), name: custom.clone().unwrap_or_else(|| auto.clone()), made, updated, files });
            block_upserts.push(BlockRecord {
                block_id: id.clone(),
                project: project.to_string(),
                auto_name: auto,
                custom_name: custom,
                merged_into: known.and_then(|k| k.merged_into.clone()),
                created_at: known.map_or_else(|| iso_from_ms(made), |k| k.created_at.clone()),
                updated_at: iso_from_ms(updated),
            });
        }
        blocks.sort_by(|a: &BlockNode, b| b.updated.partial_cmp(&a.updated).unwrap_or(std::cmp::Ordering::Equal));
        loose.sort_by(by_mtime_desc);
        for mut row in project_rows {
            if row.block_id.as_ref().is_some_and(|b| dissolved.contains(b)) {
                row.block_id = None;
            }
            assignment_rows.push(row);
        }
        let made_times: Vec<f64> =
            blocks.iter().map(|b| b.made).chain(loose.iter().map(|f| f.birthtime_ms.unwrap_or(f.mtime_ms))).collect();
        let updated_times: Vec<f64> = blocks.iter().map(|b| b.updated).chain(loose.iter().map(|f| f.mtime_ms)).collect();
        projects.push(ProjectNode {
            key: project.to_string(),
            name: display(project),
            made: if made_times.is_empty() { o.now } else { min_of(made_times) },
            updated: if updated_times.is_empty() { o.now } else { max_of(updated_times) },
            file_count: members.len(),
            blocks,
            loose_files: loose,
            is_unfiled: *project == UNFILED,
        });
    }

    // Projects the user made by hand, with no files yet.
    for rec in o.project_names {
        if !rec.user_created || by_project.contains_key(rec.project.as_str()) {
            continue;
        }
        let made = ms_from_iso(&rec.created_at).unwrap_or(o.now);
        projects.push(ProjectNode {
            key: rec.project.clone(),
            name: display(&rec.project),
            made,
            updated: made,
            file_count: 0,
            blocks: Vec::new(),
            loose_files: Vec::new(),
            is_unfiled: false,
        });
    }
    // JavaScript's sort is stable, and so is this one.
    projects.sort_by(by_recency_unfiled_last);
    Taxonomy {
        total_files: assigned.assignments.len(),
        unfiled_count: by_project.get(UNFILED).map_or(0, Vec::len),
        ignored_count: assigned.ignored,
        projects,
        assignment_rows,
        block_upserts,
    }
}

/// One query over project, block and file names at once.
pub fn filter_taxonomy(projects: &[ProjectNode], filter: &str) -> Vec<ProjectNode> {
    let q = filter.trim().to_lowercase();
    if q.is_empty() {
        return projects.to_vec();
    }
    let hit = |f: &EngineFile| f.name.to_lowercase().contains(&q) || f.path.to_lowercase().contains(&q);
    let mut out = Vec::new();
    for p in projects {
        if p.name.to_lowercase().contains(&q) || p.key.to_lowercase().contains(&q) {
            out.push(p.clone());
            continue;
        }
        let mut blocks = Vec::new();
        for b in &p.blocks {
            if b.name.to_lowercase().contains(&q) {
                blocks.push(b.clone());
                continue;
            }
            let files: Vec<EngineFile> = b.files.iter().filter(|f| hit(f)).cloned().collect();
            if !files.is_empty() {
                blocks.push(BlockNode { files, ..b.clone() });
            }
        }
        let loose: Vec<EngineFile> = p.loose_files.iter().filter(|f| hit(f)).cloned().collect();
        if !blocks.is_empty() || !loose.is_empty() {
            let file_count = blocks.iter().map(|b: &BlockNode| b.files.len()).sum::<usize>() + loose.len();
            out.push(ProjectNode { blocks, loose_files: loose, file_count, ..p.clone() });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::assign::file;
    use super::*;

    const H: f64 = 3_600_000.0;

    fn inputs<'a>(rules: &'a MarkieRules, names: &'a [ProjectNameRecord], pins: &'a [Pin]) -> TaxonomyInputs<'a> {
        TaxonomyInputs { pins, rules, prior_assignments: &[], known_blocks: &[], project_names: names, home: "/Users/k", now: 0.0 }
    }

    fn repo_file(path: &str, repo: &str, mtime: f64) -> EngineFile {
        let mut f = file(path, mtime);
        f.repo_name = Some(repo.into());
        f
    }

    #[test]
    fn builds_projects_blocks_and_loose_files() {
        let files = vec![
            repo_file("/Users/k/c/app/docs/a.md", "app", 10.0 * H),
            repo_file("/Users/k/c/app/docs/b.md", "app", 11.0 * H),
            repo_file("/Users/k/c/app/x.md", "app", 500.0 * H),
            file("/Users/k/loose.md", 900.0 * H),
            file("/Users/k/Documents/Thesis/ch1.md", 50.0 * H),
        ];
        let rules = MarkieRules::default();
        let t = build_taxonomy(&files, &inputs(&rules, &[], &[]));
        let keys: Vec<_> = t.projects.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, vec!["app", "Thesis", "Unfiled"], "newest first, Unfiled last");
        let app = &t.projects[0];
        assert_eq!(app.file_count, 3);
        assert_eq!(app.blocks.len(), 1);
        assert_eq!(app.blocks[0].files.len(), 2);
        assert_eq!(app.loose_files.len(), 1, "a block of one dissolves");
        assert_eq!(app.files()[0].name, "x.md");
        assert_eq!(app.common_dir().as_deref(), Some("/Users/k/c/app/docs"));
        assert_eq!(t.unfiled_count, 1);
        assert_eq!(t.total_files, 5);
        let dissolved = t.assignment_rows.iter().find(|r| r.path.ends_with("x.md")).unwrap();
        assert_eq!(dissolved.block_id, None);
        assert!(t.block_upserts.iter().all(|b| b.project != "Unfiled" || b.block_id.starts_with("b_")));
    }

    #[test]
    fn renames_created_projects_and_fixed_blocks() {
        let mut fm = file("/Users/k/n/one.md", 5.0 * H);
        fm.fm_project = Some("Launch".into());
        fm.fm_block = Some("Copy".into());
        let files = vec![fm, repo_file("/Users/k/c/app/a.md", "app", 1.0 * H)];
        let names = vec![
            ProjectNameRecord { project: "app".into(), custom_name: Some(" Markie ".into()), user_created: false, created_at: "2026-01-01T00:00:00.000Z".into(), updated_at: String::new() },
            ProjectNameRecord { project: "Empty".into(), custom_name: None, user_created: true, created_at: "1970-01-01T00:00:00.000Z".into(), updated_at: String::new() },
        ];
        let rules = MarkieRules::default();
        let t = build_taxonomy(&files, &inputs(&rules, &names, &[]));
        let launch = t.projects.iter().find(|p| p.key == "Launch").unwrap();
        assert_eq!(launch.blocks[0].id, "f_Launch::Copy");
        assert_eq!(launch.blocks[0].name, "Copy", "a declared block survives with one file");
        let app = t.projects.iter().find(|p| p.key == "app").unwrap();
        assert_eq!(app.name, "Markie");
        let empty = t.projects.iter().find(|p| p.key == "Empty").unwrap();
        assert_eq!(empty.file_count, 0);
        assert_eq!(t.projects.last().unwrap().key, "Empty", "made at the epoch, so oldest");
    }

    #[test]
    fn filter_matches_projects_blocks_and_files() {
        let files = vec![
            repo_file("/Users/k/c/app/docs/plan.md", "app", 10.0 * H),
            repo_file("/Users/k/c/app/docs/notes.md", "app", 11.0 * H),
            repo_file("/Users/k/c/web/readme.md", "web", 1.0 * H),
        ];
        let rules = MarkieRules::default();
        let t = build_taxonomy(&files, &inputs(&rules, &[], &[]));
        let by_name = filter_taxonomy(&t.projects, "WEB");
        assert_eq!(by_name.len(), 1);
        let by_file = filter_taxonomy(&t.projects, "plan");
        assert_eq!(by_file.len(), 1);
        assert_eq!(by_file[0].file_count, 1);
        assert_eq!(filter_taxonomy(&t.projects, "  ").len(), 2);
        assert!(filter_taxonomy(&t.projects, "zzz").is_empty());
    }
}
