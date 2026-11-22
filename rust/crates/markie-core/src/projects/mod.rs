//! Projects: the virtual taxonomy. Files stay where they are on disk; this is
//! a structure of Markie's own over them (project, then block, then file).
//!
//! A port of `src/lib/projects/*` (assign, cluster, rules, taxonomy, search),
//! `electron/mdmeta.js`, `electron/frontmatter.js`, `electron/projects-config.js`
//! and the Projects half of `electron/registry.js`. Same rules, same ids, same
//! tables, so a decision made in one app reads the same in the other.

pub mod assign;
pub mod cluster;
pub mod config;
pub mod frontmatter;
pub mod meta;
pub mod rules;
pub mod store;
pub mod taxonomy;

pub use assign::{EngineFile, UNFILED};
pub use taxonomy::{BlockNode, ProjectNode, Taxonomy, build_taxonomy, filter_taxonomy};

/// `new Date(ms).toISOString()`.
pub fn iso_from_ms(ms: f64) -> String {
    let ms = if ms.is_finite() { ms.floor() as i64 } else { 0 };
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// `Date.parse` for the ISO strings this module writes.
pub fn ms_from_iso(s: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis() as f64)
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// What the Projects panel needs, computed in one pass.
#[derive(Clone, Debug, Default)]
pub struct ProjectsState {
    pub taxonomy: Taxonomy,
    /// The rules document's parse error, shown above the list. The tree was
    /// built from the last rules that parsed.
    pub rules_error: Option<String>,
    pub config_path: std::path::PathBuf,
    pub home: String,
    /// Metadata still owed for some files (the time budget ran out).
    pub preparing: bool,
}

/// The whole `useProjects` pipeline: refresh metadata, read decisions, parse
/// rules with a last-known-good fallback, build the tree, and persist the
/// derived cache. Call it off the UI thread.
pub fn compute(
    db: &rusqlite::Connection,
    index: &[crate::index::IndexedDoc],
    config_dir: &std::path::Path,
    home: &std::path::Path,
    meta_budget: std::time::Duration,
) -> anyhow::Result<ProjectsState> {
    store::ensure_tables(db)?;
    let mut known = store::meta_all(db)?;
    let fresh = meta::refresh_meta(index, &known, home, meta_budget);
    if !fresh.updated.is_empty() {
        store::meta_upsert_many(db, &fresh.updated)?;
        for m in fresh.updated {
            known.insert(m.path.clone(), m);
        }
    }
    let files: Vec<EngineFile> = index
        .iter()
        .filter(|d| d.format == crate::formats::FormatKind::Markdown)
        .map(|d| {
            let path = d.path.to_string_lossy().into_owned();
            let m = known.get(&path);
            EngineFile {
                name: d.name.clone(),
                dir: d.dir.to_string_lossy().into_owned(),
                mtime_ms: d.mtime_ms,
                birthtime_ms: m.and_then(|m| m.birthtime_ms),
                fm_project: m.and_then(|m| m.fm_project.clone()),
                fm_block: m.and_then(|m| m.fm_block.clone()),
                repo_name: m.and_then(|m| m.repo_name.clone()),
                path,
            }
        })
        .collect();

    let cfg = config::read_config(config_dir);
    let (rules, rules_error) = match rules::parse_rules(&cfg.content) {
        Ok(r) => (r, None),
        Err(e) => {
            let fallback = store::config_get(db, "rules-known-good")?
                .and_then(|good| rules::parse_rules(&good).ok())
                .unwrap_or_default();
            (fallback, Some(e))
        }
    };
    let fingerprint = store::index_fingerprint(index.iter().map(|d| (d.path.to_str().unwrap_or(""), d.mtime_ms)));
    let priors = store::assignments_get(db, &fingerprint)?;
    let blocks = store::blocks_all(db)?;
    let pins = store::pins_all(db)?;
    let names = store::projects_all(db)?;
    let home_s = home.to_string_lossy().into_owned();
    let taxonomy = build_taxonomy(
        &files,
        &taxonomy::TaxonomyInputs {
            pins: &pins,
            rules: &rules,
            prior_assignments: &priors,
            known_blocks: &blocks,
            project_names: &names,
            home: &home_s,
            now: now_ms(),
        },
    );
    store::block_upsert_many(db, &taxonomy.block_upserts)?;
    if priors.is_empty() {
        store::assignments_save(db, &fingerprint, &taxonomy.assignment_rows)?;
    }
    if rules_error.is_none() {
        store::config_set(db, "rules-known-good", &cfg.content)?;
        store::config_set(db, "rules-error", "")?;
    }
    Ok(ProjectsState { taxonomy, rules_error, config_path: cfg.path, home: home_s, preparing: fresh.remaining > 0 })
}

pub(crate) fn min_of(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::INFINITY, f64::min)
}

pub(crate) fn max_of(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::NEG_INFINITY, f64::max)
}

#[cfg(test)]
mod tests {
    #[test]
    fn compute_end_to_end_keeps_decisions() {
        use crate::formats::FormatKind;
        use crate::index::IndexedDoc;
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::create_dir_all(h.join("code/app/.git")).unwrap();
        std::fs::create_dir_all(h.join("code/app/docs")).unwrap();
        let mut index = Vec::new();
        for (i, name) in ["a.md", "b.md", "c.csv"].iter().enumerate() {
            let p = h.join("code/app/docs").join(name);
            std::fs::write(&p, "x").unwrap();
            index.push(IndexedDoc {
                name: name.to_string(),
                dir: p.parent().unwrap().into(),
                path: p,
                mtime_ms: 1_000.0 + i as f64,
                size: 1,
                format: crate::formats::classify(name),
                snippet: None,
            });
        }
        assert_eq!(index[2].format, FormatKind::Csv);
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let cfg_dir = h.join("Documents/Markie");
        let s = super::compute(&db, &index, &cfg_dir, h, std::time::Duration::from_secs(5)).unwrap();
        assert!(!cfg_dir.exists(), "computing never writes the config document");
        assert_eq!(s.taxonomy.projects.len(), 1);
        let app = &s.taxonomy.projects[0];
        assert_eq!((app.key.as_str(), app.file_count), ("app", 2), "only Markdown enters the taxonomy");
        let block = app.blocks[0].id.clone();
        super::store::block_set_name(&db, &block, Some("Docs work")).unwrap();
        super::store::project_set_name(&db, "app", Some("Markie")).unwrap();
        let s = super::compute(&db, &index, &cfg_dir, h, std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(s.taxonomy.projects[0].name, "Markie");
        assert_eq!(s.taxonomy.projects[0].blocks[0].name, "Docs work");

        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(cfg_dir.join("Projects.md"), "---\nmarkie_rules: 7\n---\n").unwrap();
        let s = super::compute(&db, &index, &cfg_dir, h, std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(s.rules_error.as_deref(), Some("markie_rules must be a mapping"));
        assert_eq!(s.taxonomy.projects.len(), 1, "the last good rules still build the tree");
    }

    #[test]
    fn iso_round_trip() {
        assert_eq!(super::iso_from_ms(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::iso_from_ms(1_700_000_000_123.7), "2023-11-14T22:13:20.123Z");
        assert_eq!(super::ms_from_iso("2023-11-14T22:13:20.123Z"), Some(1_700_000_000_123.0));
    }
}
