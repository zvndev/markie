//! "Bring your documents": the first-run step that lists the folders a new
//! person keeps documents in, counts them, and brings the ticked ones in as
//! Library roots and Projects folders (`markie_core::bring_docs`).
//!
//! It opens once, over the welcome document, on a new install. An existing
//! install never sees it on its own: it opens from Settings › Files, the
//! empty Projects tab and the empty Recent page.
//!
//! Counting runs per folder in the background, so the list shows at once
//! and fills in. A protected folder (Desktop, Documents, iCloud Drive) is
//! only counted after a tap, so macOS's permission prompt follows it. A big
//! import runs a few hundred files a frame, with its progress on show.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui_kit::component::{WindowExt as _, h_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use markie_core::bring_docs::{self as bring, Candidate, CandidateKind, CountOutcome, FolderCount, Importer, TypeCounts};
use markie_core::projects::folders::Snapshot;

use super::Workspace;
use super::dialog_chrome::{self as chrome, Tokens, fade, mix};
use super::overlay::Overlay;

/// How many files an import places between frames.
const FILES_PER_FRAME: usize = 400;
const POLL: Duration = Duration::from_millis(120);

const PATH_FOLDER: &str = "M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z";
const PATH_VAULT: &str = "M12 3 4.5 7.5v9L12 21l7.5-4.5v-9zM12 3v18M4.5 7.5 12 12l7.5-4.5";
const PATH_CLOUD: &str = "M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z";
const PATH_LOCK: &str = "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z";

#[derive(Clone, Debug, PartialEq)]
pub(super) enum CountState {
    /// A protected folder no one has tapped yet.
    NotYet,
    Counting,
    Counted { counts: TypeCounts, capped: bool },
    NoAccess,
    Missing,
}

pub(super) struct Row {
    pub cand: Candidate,
    pub ticked: bool,
    pub count: CountState,
    files: Vec<PathBuf>,
    found: Arc<AtomicUsize>,
    cancel: Arc<AtomicBool>,
}

impl Row {
    fn new(cand: Candidate) -> Self {
        let count = if cand.protected { CountState::NotYet } else { CountState::Counting };
        Self { ticked: cand.preticked, cand, count, files: Vec::new(), found: Arc::default(), cancel: Arc::default() }
    }

    pub fn found(&self) -> usize {
        self.found.load(Ordering::Relaxed)
    }
}

/// An import that is running: first any ticked folder not counted yet, then
/// the Projects folders, a frame at a time.
pub(super) struct Running {
    pub done: usize,
    pub total: usize,
    /// The folder still being looked through before anything is placed.
    pub looking: Option<String>,
}

pub(crate) struct BringState {
    pub rows: Vec<Row>,
    pub discovering: bool,
    pub home: PathBuf,
    pub running: Option<Running>,
    /// Opened by the first launch, rather than from Settings or an empty page.
    pub first_run: bool,
    discover_cancel: Arc<AtomicBool>,
    /// Scenes hold counts or an import part way, to draw them.
    #[cfg(feature = "scene")]
    pub hold_counts: bool,
    #[cfg(feature = "scene")]
    pub hold_import: bool,
}

impl Drop for BringState {
    /// Closing the step stops every count still running.
    fn drop(&mut self) {
        self.discover_cancel.store(true, Ordering::Relaxed);
        for r in &self.rows {
            r.cancel.store(true, Ordering::Relaxed);
        }
    }
}

impl BringState {
    pub fn ticked(&self) -> Vec<&Row> {
        self.rows.iter().filter(|r| r.ticked && !r.cand.imported).collect()
    }

    fn row_mut(&mut self, path: &Path) -> Option<&mut Row> {
        self.rows.iter_mut().find(|r| r.cand.path == path)
    }
}

/// The step's button: "Bring in 2 folders".
pub(super) fn primary_label(ticked: usize) -> String {
    match ticked {
        0 => "Bring in folders".into(),
        1 => "Bring in 1 folder".into(),
        n => format!("Bring in {n} folders"),
    }
}

/// The notice an import leaves.
pub(super) fn done_notice(added: usize, folders: usize) -> String {
    let docs = if added == 1 { "1 document".to_string() } else { format!("{} documents", bring::thousands(added)) };
    let f = if folders == 1 { "1 folder".to_string() } else { format!("{folders} folders") };
    format!("Brought in {docs} from {f}. They are in Projects. \u{2318}Z there takes the folders back out; nothing moved on disk.")
}

/// The line under a folder: what is in it, or why there is nothing to show.
pub(super) fn status_line(row: &Row) -> String {
    match &row.count {
        CountState::NotYet => "Markie looks inside when you tap it. macOS will ask first.".into(),
        CountState::Counting => format!("Counting\u{2026} {}", bring::thousands(row.found())),
        CountState::Counted { counts, capped } if counts.total() == 0 && !capped => "No documents here".into(),
        CountState::Counted { counts, capped } => format!("{}: {}", bring::total_label(counts.total(), *capped), bring::kinds_line(counts, *capped)),
        CountState::NoAccess => "macOS didn\u{2019}t let Markie look inside. Allow it in System Settings \u{203a} Privacy & Security \u{203a} Files and Folders.".into(),
        CountState::Missing => "This folder is no longer there.".into(),
    }
}

fn scene_mode() -> bool {
    cfg!(feature = "scene") && std::env::var_os("MARKIE_RS_SCENE").is_some()
}

/// The home the step looks in: the index's, so a scratch data folder stands
/// in for home and a test never reads the real one.
fn step_home() -> PathBuf {
    super::device_scan_options(Vec::new()).home
}

impl Workspace {
    /// Show the step on the first launch of a new install, once.
    pub(super) fn bring_docs_at_first_run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if scene_mode() {
            return;
        }
        let Some(reg) = self.registry.clone() else { return };
        if !super::first_run::should_offer_bring_docs(true, reg.setting(bring::SHOWN_KEY).ok().flatten().is_some()) {
            return;
        }
        let _ = reg.set_setting(bring::SHOWN_KEY, &markie_core::clock::iso(markie_core::clock::now_ms()));
        self.open_bring_docs(true, window, cx);
    }

    /// Open "Bring your documents".
    pub(super) fn open_bring_docs(&mut self, first_run: bool, window: &mut Window, cx: &mut Context<Self>) {
        let state = BringState {
            rows: Vec::new(),
            discovering: true,
            home: step_home(),
            running: None,
            first_run,
            discover_cancel: Arc::default(),
            #[cfg(feature = "scene")]
            hold_counts: false,
            #[cfg(feature = "scene")]
            hold_import: false,
        };
        let (home, cancel) = (state.home.clone(), state.discover_cancel.clone());
        self.show_dialog(Overlay::BringDocs(Box::new(state)), window, cx);
        let (known, imported) = match &self.registry {
            // Markie's own folder of examples is a root already; it is not
            // one of the person's folders to bring in.
            Some(reg) => (
                reg.roots().unwrap_or_default().into_iter().filter(|r| *r != markie_core::paths::default_root()).collect(),
                bring::imported_roots(reg.conn()).map(|m| m.into_keys().collect()).unwrap_or_default(),
            ),
            None => (Vec::new(), Default::default()),
        };
        cx.spawn(async move |this, cx| {
            let found = cx.background_spawn(async move { bring::discover(&home, &known, &imported, &cancel) }).await;
            let _ = this.update(cx, |this, cx| {
                let Some(s) = this.bring_state() else { return };
                s.discovering = false;
                let start: Vec<PathBuf> = found.iter().filter(|c| !c.protected && !c.imported).map(|c| c.path.clone()).collect();
                s.rows = found.into_iter().map(Row::new).collect();
                for r in s.rows.iter_mut().filter(|r| r.cand.imported) {
                    r.count = CountState::NotYet;
                }
                for path in start {
                    this.bring_count(path, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn bring_state(&mut self) -> Option<&mut BringState> {
        match &mut self.dialogs.open {
            Overlay::BringDocs(s) => Some(s),
            _ => None,
        }
    }

    /// Count one folder in the background, redrawing as it goes.
    pub(super) fn bring_count(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let Some(s) = self.bring_state() else { return };
        let home = s.home.clone();
        let Some(row) = s.row_mut(&path) else { return };
        if matches!(row.count, CountState::Counted { .. }) && !row.files.is_empty() {
            return;
        }
        row.count = CountState::Counting;
        row.cancel = Arc::default();
        row.found = Arc::default();
        let (cancel, found) = (row.cancel.clone(), row.found.clone());
        let result: Arc<Mutex<Option<FolderCount>>> = Arc::default();
        let out = result.clone();
        let walk = path.clone();
        cx.background_spawn(async move {
            let c = bring::count_folder(&walk, &home, &cancel, &found);
            *out.lock().unwrap() = Some(c);
        })
        .detach();
        cx.notify();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                let ready = result.lock().unwrap().is_some();
                let alive = this
                    .update(cx, |this, cx| {
                        let Some(s) = this.bring_state() else { return false };
                        #[cfg(feature = "scene")]
                        if s.hold_counts {
                            cx.notify();
                            return true;
                        }
                        let Some(row) = s.row_mut(&path) else { return false };
                        if row.count != CountState::Counting {
                            return false;
                        }
                        if ready {
                            let c = result.lock().unwrap().take().expect("ready");
                            for inner in this.bring_counted(&path, c) {
                                this.bring_count(inner, cx);
                            }
                        }
                        cx.notify();
                        !ready
                    })
                    .unwrap_or(false);
                if !alive {
                    return;
                }
            }
        })
        .detach();
    }

    /// A count came back. Returns the vaults and exports found inside the
    /// folder, now listed below it, to count next.
    fn bring_counted(&mut self, path: &Path, c: FolderCount) -> Vec<PathBuf> {
        let mut inner = Vec::new();
        let Some(s) = self.bring_state() else { return inner };
        let home = s.home.clone();
        let Some(row) = s.row_mut(path) else { return inner };
        row.count = match c.outcome {
            CountOutcome::Done => CountState::Counted { counts: c.counts, capped: false },
            CountOutcome::Capped => CountState::Counted { counts: c.counts, capped: true },
            CountOutcome::NoAccess => CountState::NoAccess,
            CountOutcome::Missing => CountState::Missing,
            CountOutcome::Cancelled => CountState::NotYet,
        };
        row.files = c.files;
        // Vaults and exports inside a folder just opened, listed below it.
        let imported: std::collections::HashSet<PathBuf> = Default::default();
        for (p, kind) in c.specials {
            if s.rows.iter().any(|r| r.cand.path == p) || bring::is_downloads(&home, &p) {
                continue;
            }
            let mut cand = Candidate { protected: false, ..bring_candidate(&home, p, kind, &imported) };
            cand.preticked = false;
            let at = s.rows.iter().position(|r| r.cand.path == path).map_or(s.rows.len(), |i| i + 1);
            inner.push(cand.path.clone());
            s.rows.insert(at, Row::new(cand));
        }
        // Folders listed inside this one, such as a root Markie knew inside
        // Documents: macOS has already been asked, so count them now.
        if !matches!(s.rows.iter().find(|r| r.cand.path == path).map(|r| &r.count), Some(CountState::NoAccess | CountState::Missing)) {
            for r in &s.rows {
                if r.cand.path != path && r.cand.path.starts_with(path) && r.count == CountState::NotYet && !r.cand.imported {
                    inner.push(r.cand.path.clone());
                }
            }
        }
        inner
    }

    /// A tap on a folder's row: tick or untick it. Ticking a protected folder
    /// starts its count, which is when macOS asks.
    pub(super) fn bring_toggle(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let Some(s) = self.bring_state() else { return };
        if s.running.is_some() {
            return;
        }
        let Some(row) = s.row_mut(&path) else { return };
        if row.cand.imported {
            return;
        }
        row.ticked = !row.ticked;
        // A count already running carries on: closing the step stops it.
        if row.ticked && matches!(row.count, CountState::NotYet) {
            self.bring_count(path, cx);
        }
        cx.notify();
    }

    /// "Look inside" on a protected folder: count it without ticking.
    pub(super) fn bring_look_inside(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        self.bring_count(path, cx);
    }

    /// "Choose another folder…": the system folder panel.
    pub(super) fn bring_choose_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: true, prompt: Some("Bring In".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else { return };
            let _ = this.update(cx, |this, cx| {
                for p in paths {
                    this.bring_add_chosen(p, cx);
                }
            });
        })
        .detach();
    }

    pub(super) fn bring_add_chosen(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let Some(s) = self.bring_state() else { return };
        if let Some(row) = s.row_mut(&path) {
            if !row.ticked && !row.cand.imported {
                self.bring_toggle(path, cx);
            }
            return;
        }
        let home = s.home.clone();
        let mut cand = bring_candidate(&home, path.clone(), CandidateKind::Chosen, &Default::default());
        // Picked in the panel: the person asked, so it is counted now.
        cand.preticked = true;
        s.rows.push(Row::new(Candidate { protected: false, ..cand }));
        self.bring_count(path, cx);
    }

    /// Skip for now, or close.
    pub(super) fn bring_skip(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.bring_state().is_some_and(|s| s.running.is_some()) {
            return;
        }
        self.close_dialog(window, cx);
    }

    /// "Bring in": count what is not counted yet, register the roots, then
    /// make the Projects folders a frame at a time, as one ⌘Z.
    pub(super) fn bring_import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = self.bring_state() else { return };
        if s.running.is_some() || s.ticked().is_empty() {
            return;
        }
        let paths: Vec<PathBuf> = s.ticked().iter().map(|r| r.cand.path.clone()).collect();
        s.running = Some(Running { done: 0, total: 0, looking: None });
        let uncounted: Vec<PathBuf> = s
            .rows
            .iter()
            .filter(|r| paths.contains(&r.cand.path) && matches!(r.count, CountState::NotYet))
            .map(|r| r.cand.path.clone())
            .collect();
        for p in uncounted {
            self.bring_count(p, cx);
        }
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            // 1. Wait for every ticked folder's count.
            loop {
                let waiting = this
                    .update(cx, |this, cx| {
                        let s = this.bring_state()?;
                        let busy = s.rows.iter().find(|r| paths.contains(&r.cand.path) && r.count == CountState::Counting).map(|r| r.cand.name.clone());
                        if let Some(run) = &mut s.running {
                            run.looking = busy.clone();
                        }
                        cx.notify();
                        Some(busy.is_some())
                    })
                    .ok()
                    .flatten();
                match waiting {
                    Some(true) => cx.background_executor().timer(POLL).await,
                    Some(false) => break,
                    None => return,
                }
            }
            // 2. Roots, then the plan.
            let started = this
                .update(cx, |this, cx| {
                    let reg = this.registry.clone()?;
                    let s = this.bring_state()?;
                    let ticked: Vec<(PathBuf, String, Vec<PathBuf>)> =
                        s.rows.iter().filter(|r| paths.contains(&r.cand.path)).map(|r| (r.cand.path.clone(), r.cand.name.clone(), r.files.clone())).collect();
                    let outer = bring::outermost(&ticked.iter().map(|t| t.0.clone()).collect::<Vec<_>>());
                    let plans: Vec<(PathBuf, bring::PlanNode)> = ticked
                        .iter()
                        .filter(|t| outer.contains(&t.0))
                        .map(|(root, name, _)| {
                            // An outer folder also brings what was counted inside it.
                            let files: Vec<PathBuf> = ticked.iter().filter(|t| t.0.starts_with(root)).flat_map(|t| t.2.iter().cloned()).collect();
                            (root.clone(), bring::plan(root, name, &files))
                        })
                        .collect();
                    for root in &outer {
                        let _ = reg.add_root(root);
                    }
                    let before = Snapshot::take(reg.conn()).ok()?;
                    let job = Importer::new(reg.conn(), plans).ok()?;
                    if let Some(run) = &mut s.running {
                        run.looking = None;
                        run.total = job.total;
                    }
                    cx.notify();
                    Some((job, before))
                })
                .ok()
                .flatten();
            let Some((mut job, before)) = started else { return };
            // 3. A few hundred files a frame.
            loop {
                let step = this
                    .update(cx, |this, cx| {
                        #[cfg(feature = "scene")]
                        if this.bring_state().is_some_and(|s| s.hold_import) && job.done > 0 {
                            return Some(false);
                        }
                        let reg = this.registry.clone()?;
                        let finished = job.step(reg.conn(), FILES_PER_FRAME).unwrap_or(true);
                        if let Some(run) = this.bring_state().and_then(|s| s.running.as_mut()) {
                            run.done = job.done;
                        }
                        cx.notify();
                        Some(finished)
                    })
                    .ok()
                    .flatten();
                match step {
                    Some(false) => cx.background_executor().timer(Duration::from_millis(16)).await,
                    Some(true) => break,
                    None => return,
                }
            }
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(reg) = this.registry.clone() {
                    let _ = this.projects.history.push(reg.conn(), "Bring In Documents", before);
                }
                if let Some(s) = this.bring_state() {
                    s.running = None;
                }
                this.close_dialog(window, cx);
                this.reload_folders(cx);
                this.rescan(cx);
                this.show_projects_tab(cx);
                window.push_notification(done_notice(job.added, job.folders.len()), cx);
            });
        })
        .detach();
    }

    // ------------------------------------------------------------------ render

    /// Settings › Files: one row that opens the step again.
    pub(super) fn render_bring_docs_setting(&self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        div()
            .mb(px(20.))
            .pb(px(16.))
            .border_b_1()
            .border_color(fade(t.border, 0.6))
            .flex()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .child(
                div()
                    .child(div().mb(px(4.)).child(chrome::section_label("Your documents", t)))
                    .child(div().text_size(px(12.5)).child("Bring your documents"))
                    .child(
                        div()
                            .max_w(px(380.))
                            .text_size(px(11.5))
                            .line_height(px(18.))
                            .text_color(t.muted)
                            .child("Add the folders you keep documents in, such as Documents or an Obsidian vault. Nothing is moved or copied."),
                    ),
            )
            .child(
                super::settings::overlay_button("bring-docs-setting", "Choose folders\u{2026}", t)
                    .mt(px(14.))
                    .on_click(cx.listener(|this, _, window, cx| this.open_bring_docs(false, window, cx))),
            )
            .into_any_element()
    }

    pub(super) fn render_bring_docs(&mut self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::BringDocs(s) = &self.dialogs.open else { return div().into_any_element() };
        let max_h = window.viewport_size().height * 0.86;
        let home = s.home.to_string_lossy().into_owned();
        let ticked = s.ticked().len();
        let running = s.running.as_ref().map(|r| (r.done, r.total, r.looking.clone()));
        let (fg, muted, blue) = (t.foreground, t.muted, t.blue);
        let empty = !s.discovering && s.rows.is_empty();

        let header = div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .child(
                div()
                    .flex_1()
                    .when(s.first_run, |el| el.child(div().mb(px(4.)).child(chrome::section_label("Welcome to Markie", t))))
                    .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).line_height(px(26.)).child("Bring your documents"))
                    .child(
                        div()
                            .mt(px(6.))
                            .max_w(px(440.))
                            .text_size(px(12.5))
                            .line_height(px(19.))
                            .text_color(muted)
                            .child("Pick the folders you keep documents in. Each one shows up in Projects and Browse. Nothing is moved or copied."),
                    ),
            )
            .when(running.is_none(), |el| el.child(self.close_button("bring-close", t, cx)));

        let rows: Vec<AnyElement> = s.rows.iter().enumerate().map(|(i, r)| self.render_bring_row(i, r, &home, running.is_some(), t, cx)).collect();
        let list = if s.discovering {
            div().py(px(24.)).text_size(px(12.)).text_color(muted).child("Looking for document folders\u{2026}").into_any_element()
        } else if empty {
            div()
                .py(px(28.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .child(chrome::stroke_icon(PATH_FOLDER, fade(muted, 0.8), 28., 1.5))
                .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).child("No document folders found"))
                .child(div().text_size(px(12.)).text_color(muted).child("Choose the folder you keep your documents in."))
                .into_any_element()
        } else {
            div()
                .id("bring-rows")
                .rounded(px(10.))
                .border_1()
                .border_color(fade(t.border, 0.8))
                .overflow_y_scroll()
                .max_h(max_h - px(230.))
                .children(rows)
                .into_any_element()
        };

        let footer = match running {
            Some((done, total, looking)) => {
                let frac = if total == 0 { 0. } else { (done as f32 / total as f32).clamp(0., 1.) };
                let line = match looking {
                    Some(name) => format!("Looking through {name}\u{2026}"),
                    None => format!("Adding {} of {} documents to Projects\u{2026}", bring::thousands(done), bring::thousands(total)),
                };
                div()
                    .id("bring-progress")
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(div().text_size(px(12.)).text_color(fg).child(line))
                    .child(
                        div()
                            .h(px(6.))
                            .w_full()
                            .rounded(px(3.))
                            .bg(fade(t.foreground, 0.08))
                            .child(div().h_full().rounded(px(3.)).bg(blue).w(relative(if total == 0 { 0.04 } else { frac.max(0.02) }))),
                    )
                    .child(div().text_size(px(11.)).text_color(muted).child("Nothing on your disk moves. Markie only keeps a list."))
                    .into_any_element()
            }
            None => {
                let hover = t.hover_soft();
                h_flex()
                    .gap(px(8.))
                    .items_center()
                    .child(
                        div()
                            .id("bring-choose")
                            .px(px(12.))
                            .py(px(7.))
                            .rounded(px(7.))
                            .border_1()
                            .border_color(t.border)
                            .text_size(px(12.))
                            .text_color(fg)
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover))
                            .child("Choose another folder\u{2026}")
                            .on_click(cx.listener(|this, _, window, cx| this.bring_choose_folder(window, cx))),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("bring-skip")
                            .px(px(10.))
                            .py(px(7.))
                            .rounded(px(7.))
                            .text_size(px(12.))
                            .text_color(muted)
                            .cursor_pointer()
                            .hover(move |s| s.text_color(fg))
                            .child("Skip for now")
                            .on_click(cx.listener(|this, _, window, cx| this.bring_skip(window, cx))),
                    )
                    .child(
                        div()
                            .id("bring-import")
                            .px(px(14.))
                            .py(px(7.))
                            .rounded(px(7.))
                            .bg(blue)
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gpui_kit::white())
                            .when_else(ticked > 0, |el| el.cursor_pointer().hover(|s| s.opacity(0.9)), |el| el.opacity(0.45))
                            .child(primary_label(ticked))
                            .on_click(cx.listener(|this, _, window, cx| this.bring_import(window, cx))),
                    )
                    .into_any_element()
            }
        };

        self.panel(t, 14.)
            .id("bring-docs-panel")
            .w(px(600.))
            .max_w(relative(0.94))
            .max_h(max_h)
            .p(px(24.))
            .flex()
            .flex_col()
            .gap(px(18.))
            .child(header)
            .child(list)
            .child(footer)
            .into_any_element()
    }

    fn render_bring_row(&self, i: usize, r: &Row, home: &str, locked: bool, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let (fg, muted, blue) = (t.foreground, t.muted, t.blue);
        let path = r.cand.path.clone();
        let shown = markie_core::path_display::compact_home_path(&r.cand.path.to_string_lossy(), home);
        let icon = match r.cand.kind {
            CandidateKind::Obsidian | CandidateKind::Notion => PATH_VAULT,
            CandidateKind::ICloudDrive => PATH_CLOUD,
            _ => PATH_FOLDER,
        };
        let warn = matches!(r.count, CountState::NoAccess | CountState::Missing);
        let line = if r.cand.imported { "Already in Projects".to_string() } else { status_line(r) };
        let check = div()
            .size(px(16.))
            .flex_none()
            .rounded(px(4.))
            .flex()
            .items_center()
            .justify_center()
            .when_else(
                r.ticked && !r.cand.imported,
                |el| el.bg(blue).child(chrome::stroke_icon(chrome::PATH_CHECK, gpui_kit::white(), 12., 2.6)),
                |el| el.border_1().border_color(mix(t.foreground, 0.3, t.border)).bg(t.field_bg()),
            );
        let hover = t.hover_soft();
        let look = matches!(r.count, CountState::NotYet) && r.cand.protected && !r.cand.imported && !locked;
        let look_path = path.clone();
        div()
            .id(("bring-row", i))
            .flex()
            .items_start()
            .gap(px(12.))
            .px(px(14.))
            .py(px(11.))
            .when(i > 0, |el| el.border_t_1().border_color(fade(t.border, 0.6)))
            .when(!locked && !r.cand.imported, |el| el.cursor_pointer().hover(move |s| s.bg(hover)))
            .when(r.cand.imported, |el| el.opacity(0.6))
            .on_click(cx.listener(move |this, _, _, cx| this.bring_toggle(path.clone(), cx)))
            .child(div().pt(px(2.)).child(check))
            .child(div().pt(px(1.)).child(chrome::stroke_icon(icon, if r.cand.kind == CandidateKind::ICloudDrive { blue } else { mix(blue, 0.75, muted) }, 18., 1.6)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .gap(px(6.))
                            .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(fg).child(r.cand.name.clone()))
                            .when(r.cand.protected && !matches!(r.count, CountState::Counted { .. }), |el| el.child(chrome::stroke_icon(PATH_LOCK, fade(muted, 0.8), 11., 1.8))),
                    )
                    .child(div().text_size(px(11.)).text_color(muted).truncate().child(format!("{} \u{00b7} {shown}", r.cand.kind.detail())))
                    .child(div().mt(px(3.)).text_size(px(11.5)).line_height(px(16.)).text_color(if warn { t.red } else { mix(fg, 0.8, muted) }).child(line)),
            )
            .when(look, |el| {
                el.child(
                    div()
                        .id(("bring-look", i))
                        .flex_none()
                        .px(px(10.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(t.border)
                        .text_size(px(11.5))
                        .text_color(fg)
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .child("Look inside")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.bring_look_inside(look_path.clone(), cx);
                        })),
                )
            })
            .into_any_element()
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// `{state, roots?, tap?}`: "Bring your documents" over a made-up home
    /// (`scene/bring-fixture.py`). `state`: `counting` (counts held part way),
    /// `counted`, `empty` (an empty scratch home) or `importing` (held after
    /// the first frame of files). `roots`: folders, relative to the scratch
    /// home, registered first as the Electron import would. `tap`: the
    /// protected folders tapped open (default Documents).
    pub(super) fn scene_bring(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use serde_json::Value;
        let state = args.get("state").and_then(Value::as_str).unwrap_or("counted");
        match *step {
            0 => {
                let home = step_home();
                if let Some(reg) = &self.registry {
                    for r in args.get("roots").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                        let _ = reg.add_root(&home.join(r));
                    }
                }
                self.open_bring_docs(true, window, cx);
                if let Some(s) = self.bring_state() {
                    s.hold_counts = state == "counting";
                    s.hold_import = state == "importing";
                }
                *step = 1;
                false
            }
            1 => {
                let Some(s) = self.bring_state() else { return true };
                if s.discovering {
                    return false;
                }
                let taps: Vec<String> = match args.get("tap").and_then(Value::as_array) {
                    Some(a) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                    None => vec!["Documents".into()],
                };
                let paths: Vec<PathBuf> = s.rows.iter().filter(|r| taps.contains(&r.cand.name)).map(|r| r.cand.path.clone()).collect();
                for p in paths {
                    self.bring_look_inside(p, cx);
                }
                *step = 2;
                false
            }
            2 => {
                let Some(s) = self.bring_state() else { return true };
                if state == "counting" || state == "empty" {
                    return s.rows.iter().all(|r| r.count != CountState::Counting || r.found() > 0) || s.rows.is_empty();
                }
                if s.rows.iter().any(|r| r.count == CountState::Counting) {
                    return false;
                }
                if state == "importing" {
                    self.bring_import(window, cx);
                    *step = 3;
                    return false;
                }
                true
            }
            _ => self.bring_state().and_then(|s| s.running.as_ref()).is_none_or(|r| r.done > 0 && r.looking.is_none()),
        }
    }
}

/// A candidate for a folder the list did not have, named the way discovery names them.
fn bring_candidate(home: &Path, path: PathBuf, kind: CandidateKind, imported: &std::collections::HashSet<PathBuf>) -> Candidate {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    Candidate {
        protected: bring::is_protected(home, &path),
        preticked: false,
        imported: imported.contains(&path),
        name,
        kind,
        path,
    }
}

#[cfg(test)]
mod tests {
    use super::{Candidate, CandidateKind, CountState, Row, TypeCounts, done_notice, primary_label, status_line};

    fn row(kind: CandidateKind, protected: bool, count: CountState) -> Row {
        let mut r = Row::new(Candidate { path: "/made/up/Notes".into(), kind, name: "Notes".into(), protected, preticked: false, imported: false });
        r.count = count;
        r
    }

    #[test]
    fn a_protected_folder_waits_for_a_tap_and_others_count_at_once() {
        assert_eq!(row(CandidateKind::Documents, true, CountState::NotYet).count, CountState::NotYet);
        let fresh = Row::new(Candidate { path: "/made/up/Kiln".into(), kind: CandidateKind::Markie, name: "Kiln".into(), protected: false, preticked: true, imported: false });
        assert_eq!(fresh.count, CountState::Counting);
        assert!(fresh.ticked, "a pre-ticked candidate starts ticked");
    }

    #[test]
    fn each_row_says_what_it_found_or_why_not() {
        assert!(status_line(&row(CandidateKind::Documents, true, CountState::NotYet)).contains("macOS will ask"));
        let counts = TypeCounts { markdown: 1204, word: 32, text: 0, csv: 2 };
        assert_eq!(status_line(&row(CandidateKind::Markie, false, CountState::Counted { counts, capped: false })), "1,238 documents: 1,204 Markdown · 32 Word · 2 CSV");
        assert!(status_line(&row(CandidateKind::Markie, false, CountState::Counted { counts, capped: true })).starts_with("10,000+ documents"));
        assert_eq!(status_line(&row(CandidateKind::Markie, false, CountState::Counted { counts: TypeCounts::default(), capped: false })), "No documents here");
        let denied = status_line(&row(CandidateKind::Desktop, true, CountState::NoAccess));
        assert!(denied.starts_with("macOS didn\u{2019}t let Markie look inside") && !denied.contains("rror"), "a clear line, not an error");
    }

    #[test]
    fn the_button_and_notice_read_naturally() {
        assert_eq!(primary_label(0), "Bring in folders");
        assert_eq!(primary_label(1), "Bring in 1 folder");
        assert_eq!(primary_label(3), "Bring in 3 folders");
        assert!(done_notice(1, 1).starts_with("Brought in 1 document from 1 folder."));
        assert!(done_notice(10_000, 2).starts_with("Brought in 10,000 documents from 2 folders."));
    }
}
