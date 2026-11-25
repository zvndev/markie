//! The Library's Projects tab and the ⇧⌘F body search: the wiring from the
//! shell to `markie_core::projects` and `markie_core::doc_text`. The panel
//! mirrors `src/components/projects-panel.tsx`: one search field, projects
//! newest first with Unfiled last, each opening to its files newest first.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::doc_text::{SHARED_CACHE, SearchOptions, search_documents};
use markie_core::paths;
use markie_core::path_display::compact_dir;
use markie_core::projects::{ProjectsState, filter_taxonomy};
use markie_core::registry::Registry;

use super::Workspace;
use super::chrome::hover_fill;
use crate::themes::Palette;

/// One line of the Projects list.
#[derive(Clone, Debug, PartialEq)]
pub enum ProjectRow {
    Project { key: String, name: String, files: usize, open: bool, unfiled: bool },
    /// `dir` is None when the file sits in the folder most of its project shares.
    File { path: PathBuf, name: String, dir: Option<PathBuf> },
}

pub(super) struct Projects {
    pub state: Option<ProjectsState>,
    computing: bool,
    /// Projects the user opened or shut. Absent means "no opinion".
    toggled: HashMap<String, bool>,
    filter: Entity<InputState>,
    query: String,
    _body_search: Task<()>,
}

impl Projects {
    pub(super) fn new(window: &mut Window, cx: &mut Context<Workspace>) -> (Self, Subscription) {
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Search projects and files"));
        let sub = cx.subscribe(&filter, |this: &mut Workspace, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.projects.query = state.read(cx).value().to_string();
                cx.notify();
            }
        });
        let me = Self {
            state: None,
            computing: false,
            toggled: HashMap::new(),
            filter,
            query: String::new(),
            _body_search: Task::ready(()),
        };
        (me, sub)
    }

    /// The rows to draw for the current state, query and open document.
    pub fn rows(&self, active: Option<&std::path::Path>) -> Vec<ProjectRow> {
        project_rows(self.state.as_ref(), &self.query, &self.toggled, active)
    }
}

/// Pure, so it can be tested without a window.
pub fn project_rows(
    state: Option<&ProjectsState>,
    query: &str,
    toggled: &HashMap<String, bool>,
    active: Option<&std::path::Path>,
) -> Vec<ProjectRow> {
    let Some(state) = state else { return Vec::new() };
    let searching = !query.trim().is_empty();
    let active = active.map(|p| p.to_string_lossy().into_owned());
    let mut rows = Vec::new();
    for p in filter_taxonomy(&state.taxonomy.projects, query) {
        let files = p.files();
        let holds_active = active.as_ref().is_some_and(|a| files.iter().any(|f| &f.path == a));
        let open = searching || toggled.get(&p.key).copied().unwrap_or(holds_active);
        rows.push(ProjectRow::Project { key: p.key.clone(), name: p.name.clone(), files: p.file_count, open, unfiled: p.is_unfiled });
        if open {
            let shared = p.common_dir();
            for f in files {
                rows.push(ProjectRow::File {
                    path: PathBuf::from(&f.path),
                    name: f.name.clone(),
                    dir: (shared.as_deref() != Some(f.dir.as_str())).then(|| PathBuf::from(&f.dir)),
                });
            }
        }
    }
    rows
}

impl Workspace {
    /// Rebuild the taxonomy off the UI thread on its own registry connection.
    pub(super) fn compute_projects(&mut self, cx: &mut Context<Self>) {
        if self.projects.computing || self.library.docs().is_empty() {
            return;
        }
        self.projects.computing = true;
        let index = self.library.docs().to_vec();
        let db_path = paths::data_dir().join("registry.db");
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let reg = Registry::open(&db_path)?;
                    markie_core::projects::compute(reg.conn(), &index, &paths::default_root(), &paths::home_dir(), Duration::from_secs(20))
                })
                .await;
            this.update(cx, |this, cx| {
                this.projects.computing = false;
                match result {
                    Ok(state) => this.projects.state = Some(state),
                    Err(e) => eprintln!("markie-rs: projects unavailable: {e:#}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// What follows a file the app renamed or moved, as Electron's
    /// `afterWorkspaceMove` does: every path-keyed registry row (recent, star,
    /// project pin and assignment, metadata), the office recovery history and
    /// local comments. Text version history stays keyed to the old path, as
    /// in Electron, whose snapshots are not moved either.
    pub(super) fn follow_move(&mut self, from: &std::path::Path, to: &std::path::Path, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let moved = if to.is_dir() {
                let sep = std::path::MAIN_SEPARATOR;
                reg.move_prefix(&format!("{}{sep}", from.display()), &format!("{}{sep}", to.display()))
            } else {
                reg.move_path(from, to)
            };
            if let Err(e) = moved {
                eprintln!("markie-rs: registry move failed: {e:#}");
            }
        }
        let _ = self.recovery.moved(from, to);
        markie_cloud::comments::local::LocalComments::new(&paths::data_dir()).move_records(from, to);
        self.refresh_lists(cx);
        self.compute_projects(cx);
    }

    /// Settings › Agents › "Organizing rules for Projects": open `Projects.md`, writing the template
    /// only now if it does not exist.
    pub(super) fn open_projects_config(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match markie_core::projects::config::ensure_config(&paths::default_root()) {
            Ok(cfg) => self.open_path(&cfg.path, window, cx),
            Err(e) => eprintln!("markie-rs: Projects.md unavailable: {e}"),
        }
    }

    /// Run Electron's global search over the whole index once typing pauses.
    /// A newer query drops this task; the core's generation counter stops a
    /// search already running.
    pub(super) fn schedule_body_search(&mut self, cx: &mut Context<Self>) {
        let req = self.shell.search.body_search().filter(|r| !r.text.trim().is_empty());
        let Some(req) = req else {
            self.projects._body_search = Task::ready(());
            return;
        };
        self.projects._body_search = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            let (text, formats) = (req.text.clone(), req.formats.clone());
            let resp = cx
                .background_spawn(async move {
                    let opts = SearchOptions { formats: req.formats, ..Default::default() };
                    search_documents(&req.pool, &req.text, &opts, &SHARED_CACHE)
                })
                .await;
            this.update(cx, |this, cx| {
                this.shell.search.set_body_results(&text, &formats, resp);
                cx.notify();
            })
            .ok();
        });
    }

    /// The body-search pool: the index plus recent files the walk missed.
    pub(super) fn build_search_pool(&mut self) {
        let recent: Vec<PathBuf> = self
            .registry
            .as_ref()
            .and_then(|r| r.recent(200).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.path)
            .collect();
        self.library.build_pool(&recent);
    }

    pub(super) fn render_projects(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let pr = &self.projects;
        let current = self.doc.as_ref().map(|d| d.path.clone());
        let rows = pr.rows(current.as_deref());
        let home = paths::home_dir();
        let empty = if pr.state.is_none() {
            if self.library.scanning || pr.computing { "Still finding your markdown…" } else { "No projects yet." }
        } else if pr.state.as_ref().is_some_and(|s| s.preparing) {
            "Working out where everything belongs…"
        } else if !pr.query.trim().is_empty() {
            "Nothing matches that."
        } else {
            "No projects yet."
        };
        let error = pr.state.as_ref().and_then(|s| s.rules_error.clone());
        let n = rows.len();
        v_flex()
            .flex_1()
            .min_h_0()
            .child(div().flex_none().px(px(8.)).pt(px(8.)).pb(px(6.)).child(super::rail::filter_field(&pr.filter, 12., &p)))
            .when_some(error, |el, e| {
                el.child(
                    div()
                        .mx(px(8.))
                        .mb(px(6.))
                        .px(px(8.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.yellow)
                        .text_size(px(11.))
                        .text_color(p.yellow)
                        .child(e),
                )
            })
            .child(if n == 0 {
                div().flex_1().px(px(12.)).py(px(12.)).text_size(px(12.)).text_color(p.muted).child(empty).into_any_element()
            } else {
                uniform_list(
                    "projects-list",
                    n,
                    cx.processor(move |_this, range: std::ops::Range<usize>, _window, cx| {
                        range
                            .map(|ix| match rows[ix].clone() {
                                ProjectRow::Project { key, name, files, open, unfiled } => h_flex()
                                    .id(SharedString::from(format!("project-{key}")))
                                    .mx(px(4.))
                                    .gap(px(4.))
                                    .px(px(6.))
                                    .py(px(4.))
                                    .rounded(px(6.))
                                    .hover(|s| s.bg(hover_fill(&p)))
                                    .child(div().flex_none().text_size(px(9.)).text_color(p.muted).child(if open { "▼" } else { "▶" }))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(px(12.5))
                                            .text_color(if unfiled { p.muted } else { p.foreground })
                                            .child(name),
                                    )
                                    .child(div().flex_none().pr(px(4.)).text_size(px(11.)).text_color(p.muted).child(files.to_string()))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        let current = this.doc.as_ref().map(|d| d.path.clone());
                                        let open = this.projects.rows(current.as_deref()).iter().any(
                                            |r| matches!(r, ProjectRow::Project { key: k, open: true, .. } if *k == key),
                                        );
                                        this.projects.toggled.insert(key.clone(), !open);
                                        cx.notify();
                                    }))
                                    .into_any_element(),
                                ProjectRow::File { path, name, dir } => {
                                    let active = current.as_ref() == Some(&path);
                                    let open_path = path.clone();
                                    v_flex()
                                        .id(SharedString::from(format!("pfile-{}", path.display())))
                                        .mx(px(4.))
                                        .pl(px(22.))
                                        .pr(px(8.))
                                        .py(px(3.))
                                        .rounded(px(6.))
                                        .when(active, |el| el.bg(p.accent))
                                        .when(!active, |el| el.hover(|s| s.bg(hover_fill(&p))))
                                        .child(div().w_full().truncate().text_size(px(12.)).text_color(p.foreground).child(name))
                                        .when_some(dir, |el, d| {
                                            el.child(div().w_full().truncate().text_size(px(10.5)).text_color(p.muted).child(compact_dir(&d, &home, 2)))
                                        })
                                        .on_click(cx.listener(move |this, _, window, cx| this.open_path(&open_path, window, cx)))
                                        .into_any_element()
                                }
                            })
                            .collect::<Vec<_>>()
                    }),
                )
                .flex_1()
                .into_any_element()
            })
            .into_any_element()
    }
}

/// `.markie-search-mark`: the status yellow at 30 % behind the words, and a
/// 70 % line under them (Chromium's inset box shadow).
pub(super) fn marked(text: &str, ranges: &[(usize, usize)], p: &Palette) -> StyledText {
    let style = HighlightStyle {
        background_color: Some(p.yellow.opacity(0.3)),
        underline: Some(UnderlineStyle { color: Some(p.yellow.opacity(0.7)), thickness: px(1.), wavy: false }),
        ..Default::default()
    };
    let highlights: Vec<_> = markie_core::doc_text::merge_marks(ranges.to_vec())
        .into_iter()
        .filter(|(a, b)| a < b && *b <= text.len() && text.is_char_boundary(*a) && text.is_char_boundary(*b))
        .map(|(a, b)| (a..b, style))
        .collect();
    StyledText::new(text.to_string()).with_highlights(highlights)
}

#[cfg(test)]
mod tests {
    use super::{HashMap, PathBuf, ProjectRow, project_rows};
    use markie_core::projects::ProjectsState;
    use markie_core::projects::{ProjectNode, Taxonomy, assign::EngineFile};

    fn f(path: &str, m: f64) -> EngineFile {
        let (dir, name) = path.rsplit_once('/').unwrap();
        EngineFile { path: path.into(), name: name.into(), dir: dir.into(), mtime_ms: m, birthtime_ms: None, fm_project: None, fm_block: None, repo_name: None }
    }

    fn state() -> ProjectsState {
        let node = |key: &str, files: Vec<EngineFile>| ProjectNode {
            key: key.into(),
            name: key.into(),
            made: 0.0,
            updated: 0.0,
            file_count: files.len(),
            blocks: Vec::new(),
            loose_files: files,
            is_unfiled: key == "Unfiled",
        };
        ProjectsState {
            taxonomy: Taxonomy {
                projects: vec![
                    node("app", vec![f("/a/docs/one.md", 2.0), f("/a/docs/two.md", 1.0), f("/a/three.md", 3.0)]),
                    node("Unfiled", vec![f("/x/y.md", 1.0)]),
                ],
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn the_open_documents_project_opens_and_shared_folders_hide() {
        let s = state();
        let rows = project_rows(Some(&s), "", &HashMap::new(), None);
        assert_eq!(rows.len(), 2, "everything shut with no open document");
        let rows = project_rows(Some(&s), "", &HashMap::new(), Some(std::path::Path::new("/a/docs/two.md")));
        assert_eq!(rows.len(), 5);
        match &rows[1] {
            ProjectRow::File { name, dir, .. } => assert_eq!((name.as_str(), dir.clone()), ("three.md", Some(PathBuf::from("/a")))),
            _ => panic!(),
        }
        assert!(matches!(&rows[2], ProjectRow::File { dir: None, .. }), "the shared folder is not repeated");
        let shut: HashMap<_, _> = [("app".to_string(), false)].into();
        assert_eq!(project_rows(Some(&s), "", &shut, Some(std::path::Path::new("/a/docs/two.md"))).len(), 2);
        let found = project_rows(Some(&s), "y.md", &shut, None);
        assert_eq!(found.len(), 2, "searching opens every match");
    }

    /// The pieces `follow_move` calls, on fixtures: one rename carries the
    /// recent, the star, the project pin, office recovery and comments.
    #[test]
    fn a_move_carries_every_record() {
        use markie_cloud::comments::local::LocalComments;
        use markie_core::office_recovery::RecoveryStore;
        use markie_core::registry::Registry;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let (from, to) = (dir.path().join("a.docx"), dir.path().join("b.docx"));
        let notes = (dir.path().join("n.md"), dir.path().join("m.md"));
        std::fs::write(&from, b"x").unwrap();
        std::fs::write(&notes.0, "hello world").unwrap();
        let reg = Registry::in_memory().unwrap();
        reg.track_opened(&from).unwrap();
        reg.toggle_star(&from, "file").unwrap();
        markie_core::projects::store::ensure_tables(reg.conn()).unwrap();
        markie_core::projects::store::pin_set(reg.conn(), &from.to_string_lossy(), "P", None).unwrap();
        let recovery = RecoveryStore::new(&data);
        recovery.put(&from, "docx", b"x").unwrap();
        let comments = LocalComments::new(&data);
        comments.add_from_agent(&notes.0, "hello world", "world", "a note", None, None, None, "agent").unwrap();

        std::fs::rename(&from, &to).unwrap();
        std::fs::rename(&notes.0, &notes.1).unwrap();
        reg.move_path(&from, &to).unwrap();
        recovery.moved(&from, &to).unwrap();
        assert_eq!(comments.move_records(&notes.0, &notes.1), 1);

        assert_eq!(reg.recent(5).unwrap()[0].path, to);
        assert!(reg.is_starred(&to).unwrap());
        assert_eq!(markie_core::projects::store::pins_all(reg.conn()).unwrap()[0].path, to.to_string_lossy());
        assert_eq!(recovery.list(&to).len(), 1);
        assert!(recovery.list(&from).is_empty());
        assert_eq!(comments.threads(&notes.1).len(), 1);
    }
}
