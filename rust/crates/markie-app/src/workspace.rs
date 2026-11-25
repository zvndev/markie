//! The main window: the title bar, the activity rail and its side panel on
//! the left, and the open document. Mirrors the shape of `src/app/page.tsx`;
//! the chrome itself lives in `chrome.rs` and `rail.rs`.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Editor, EditorState, InputEvent, InputState};
use gpui_kit::component::text::{TextView, TextViewState};
use gpui_kit::component::{
    ActiveTheme, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::autosave::Autosave;
use markie_core::disk::{save_conflict_action, DiskChange, DiskMemory, SaveAction};
use markie_core::document::{self, Content};
use markie_core::drafts::{Draft, Drafts};
use markie_core::history::{History, Version, Writer};
use markie_core::formats::{FormatKind, TextEncoding};
use markie_core::index::ScanOptions;
use markie_core::registry::Registry;
use markie_core::{outline, paths, stats};

use crate::actions::*;
use crate::library::{Library, PreparedSnapshot};

pub(crate) mod account;
mod account_slot;
mod agents;
mod appearance;
mod style_ui;
mod chrome;
mod csv_doc;
mod csv_table;
mod collab;
mod comments;
mod share;
mod dialog_chrome;
pub(crate) mod doc_grid;
pub(crate) mod doc_preview;
mod doc_toolbar;
mod edit_menu;
mod document_failure;
mod file_ops;
mod first_run;
mod folder_tree;
mod history_dialog;
mod history_model;
mod history_page;
mod library_rows;
mod library_area;
mod live_docs;
mod nav;
mod import_copy;
mod cloud;
mod cloud_drive;
mod cloud_office;
mod cloud_page;
mod cloud_strip;
mod servers_setting;
mod cloud_resources;
mod cloud_ui;
mod darkmown;
mod export;
mod office;
mod overlay;
mod palette;
mod panels;
mod projects;
mod rail;
mod recent_page;
mod rich;
mod text_view;
mod theme_sync;
mod doc_theme;
mod welcome;
mod untitled;
pub(crate) mod ui;
mod settings;
mod shortcuts;
mod strips;
mod skills;
pub mod source;
pub use csv_table::bind_keys as bind_csv_keys;
mod source_column;
pub(crate) mod vault;
#[cfg(feature = "scene")]
pub(crate) mod scene;

/// How long typing must pause before the edited marker, word count and
/// outline catch up.
const SETTLE_AFTER: Duration = Duration::from_millis(150);

/// The panel on the right of the document.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SidePanel {
    None,
    History,
    Outline,
    Stats,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    /// ⌘1: the rich editor (Electron's "preview").
    View,
    /// ⌘2: the Markdown source (Electron's "edit").
    Source,
    /// ⌘3: source on the left, rich on the right (Electron's "split").
    Split,
}

/// The document in the pane, and how to write it back.
struct OpenDoc {
    path: PathBuf,
    format: FormatKind,
    /// Over 1 MB: Source only, like the Electron app.
    large: bool,
    kind: DocKind,
    /// No file behind it yet (`untitled.rs`): `path` holds only its name.
    untitled: bool,
}

enum DocKind {
    Text { encoding: TextEncoding, bom: bool, saved: String },
    /// An Office file the engine could not open: a placeholder.
    Engine,
    /// DOCX, RTF, ODT and DOC in the native Word page view.
    Office(office::OfficeDoc),
    Html,
}

pub struct Workspace {
    agents: agents::AgentState,
    skills: Option<Entity<skills::SkillsPanel>>,
    pub focus_handle: FocusHandle,
    registry: Option<Rc<Registry>>,
    cloud: cloud::CloudWorkspace,
    cloud_office: cloud_office::OfficeCloud,
    cloud_search: Entity<InputState>,
    /// The Browse panel's view of the device index.
    library: Library,
    /// Title bar, rail and side panel state.
    shell: rail::Shell,
    /// The Projects tab and the ⇧⌘F body search.
    projects: projects::Projects,
    /// Settings › Appearance's live controls.
    appearance: appearance::AppearanceUi,
    /// Live Docs: the projects page and the site preview (`live_docs.rs`).
    live_docs: live_docs::LiveDocs,
    /// The open `.wd` document's preview (`workspace/darkmown.rs`).
    darkmown: darkmown::DarkmownState,
    editor: Entity<EditorState>,
    preview: Entity<TextViewState>,
    /// View mode for Markdown: the native rich editor.
    rich: Entity<markie_editor::RichView>,
    /// A CSV or TSV file's table (`csv_table.rs`), and the file's text as it
    /// stood when the Text view last took it over (`csv_doc.rs`).
    csv: Entity<csv_table::CsvTable>,
    csv_text_base: String,
    file_grants: markie_core::links::FileGrants,
    doc: Option<OpenDoc>,
    document_failure: Option<document_failure::DocumentFailure>,
    mode: Mode,
    /// In Split, the pane whose text is newest: the source editor (true) or
    /// the rich editor (false). Electron's `lastPane`.
    split_source_latest: bool,
    /// Text Split just copied into the other pane, so its change event is
    /// not copied back.
    split_echo: Option<String>,
    dirty: bool,
    /// Warnings shown above a converted copy (Electron's `session.warnings`).
    doc_notes: Vec<String>,
    import_epoch: u64,
    import_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    words: usize,
    reading_minutes: usize,
    /// The whole status-bar and statistics-panel count, kept with `words`.
    doc_stats: stats::DocStats,
    sections: Vec<outline::Section>,
    history: History,
    drafts: Drafts,
    disk: DiskMemory,
    autosave: Autosave,
    _autosave_task: Task<()>,
    /// The crash journal's debounce (`use-save-guard.ts`).
    _journal_task: Task<()>,
    /// When the journal is due after a deferred-path edit.
    journal_pacer: markie_core::drafts::JournalPacer,
    pinch: markie_editor::style::PinchZoom,
    pinch_clock: Instant,
    /// Office documents' recovery history (Electron's document library).
    recovery: markie_core::office_recovery::RecoveryStore,
    pending_office: Option<(PathBuf, u64)>,
    _recovery_task: Task<()>,
    _poll_task: Task<()>,
    /// Pending work after an edit: the exact edited marker, counts and
    /// outline, done once typing pauses instead of on every keystroke.
    settle_task: Option<Task<()>>,
    /// Drops a Recent/Starred refresh overtaken by a newer one.
    lists_generation: u64,
    /// What the file says on disk when it changed under unsaved edits.
    disk_conflict: Option<String>,
    disk_missing: bool,
    /// Unsaved text recovered from a crash, offered once at launch.
    recovered: Vec<Draft>,
    /// The version history panel, and the version being looked at.
    side: SidePanel,
    versions: Vec<Version>,
    viewing_version: Option<(String, String)>,
    /// The History page (`history_page.rs`), when it is up.
    history_page: Option<history_page::HistoryPage>,
    /// Back and Forward between places (`nav.rs`), and a place's mode and
    /// scroll waiting to be put back.
    nav: nav::NavHistory,
    pending_view: Option<nav::PendingView>,
    /// Document zoom (1.0 = 100%) and reading column width, shared by every
    /// document like the Electron app's `markie.documents.zoom.v1`.
    zoom: f32,
    page_width: f32,
    /// Source's page-width column (`source_column.rs`).
    source_column: source_column::SourceColumn,
    /// Text to put in the editor at the next render, which has the window.
    pending_editor_text: Option<String>,
    /// Live collaboration, comments and sharing (collab.rs, comments.rs, share.rs).
    collab: collab::Collab,
    /// The dialog layer: settings, palette, new document and the rest.
    dialogs: overlay::Dialogs,
    /// The Cloud page the rail's Cloud destination shows (account.rs).
    cloud_panel: Entity<account::CloudPanel>,
    /// The vault page (workspace/vault.rs), made the first time the Vault view opens.
    vault: Option<Entity<vault::VaultPage>>,
    _subscriptions: Vec<Subscription>,
    /// The person's own theme store, kept aside while an owner's pinned
    /// theme paints a shared document (doc_theme.rs).
    own_theme: Option<markie_core::theme::ThemeStore>,
    _doc_theme: Option<Task<()>>,
    /// The (document, dirty) the menu bar was last built for.
    menu_key: Option<(PathBuf, bool)>,
    /// Whether Go › Back and Forward were enabled when it was built.
    menu_nav: (bool, bool),
    /// When the device index last began a walk.
    last_scan_at: Option<std::time::Instant>,
    /// Scene mode: the Cloud scene's snapshot uploads have finished.
    #[cfg(feature = "scene")]
    scene_cloud_uploaded: bool,
}

impl Workspace {
    pub fn new(initial: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let registry = Registry::open(&paths::data_dir().join("registry.db"))
            .map(Rc::new)
            .map_err(|e| eprintln!("markie-rs: registry unavailable: {e:#}"))
            .ok();
        // Electron's library startup: with no live root, ~/Documents/Markie
        // is made and registered, so new documents have a home.
        if let Some(reg) = &registry {
            if let Err(e) = markie_core::workspace_ops::ensure_default_root(reg, &paths::default_root()) {
                eprintln!("markie-rs: Markie couldn't set up its default workspace: {e:#}");
            }
            // `seedWorkspaceExamples`: the Darkmown example, offered once.
            markie_core::workspace_ops::seed_examples(&paths::default_root(), &paths::data_dir().join("seeded-examples.json"));
            // electron/registry.js creates the skill tables with the rest.
            let _ = markie_agent::skills::ensure_skill_tables(reg);
        }

        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language("markdown")
                .line_number(true)
                .soft_wrap(true)
                .searchable(true)
        });
        let preview = cx.new(|cx| TextViewState::markdown("", cx).selectable(true));
        let cloud_search = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by name or folder"));
        let (rich, rich_sub) = Self::new_rich(window, cx);
        let (csv, csv_sub) = Self::new_csv(window, cx);

        let mut subscriptions = vec![
            cx.subscribe(&editor, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.on_edit(cx);
                }
            }),
            rich_sub,
            csv_sub,
            cx.subscribe(&cloud_search, |_, _, _: &InputEvent, cx| cx.notify()),
        ];
        subscriptions.extend(Self::watch_account(window, cx));

        // The theme store (`markie.themes.v1`); a build before it kept only
        // the template id.
        let store = match registry.as_ref().and_then(|r| r.setting("themes.v1").ok().flatten()) {
            Some(json) => markie_core::theme::ThemeStore::parse(&json),
            None => {
                let id = registry.as_ref().and_then(|r| r.setting("style_template").ok().flatten()).unwrap_or_else(|| "markie".into());
                markie_core::theme::ThemeStore::default().choose_template(&id, markie_core::theme::Tone::Dark)
            }
        };
        let template = store.active_template().id.clone();
        // This computer's code font (`markie.fonts.v1`, the shape Electron keeps).
        let code_font = registry
            .as_ref()
            .and_then(|r| r.setting("fonts.v1").ok().flatten())
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .and_then(|v| v.get("codeFont").and_then(|f| f.as_str()).map(markie_core::fonts::clean_code_font))
            .unwrap_or_default();
        cx.set_global(crate::themes::OwnCodeFont(code_font));
        crate::themes::apply_store(store, Some(window), cx);
        // The user's own light or dark choice outranks the system appearance;
        // System follows macOS, also when it changes while the app runs.
        let color_mode =
            chrome::ColorMode::parse(registry.as_ref().and_then(|r| r.setting("color_mode").ok().flatten()).as_deref());
        chrome::apply_color_mode(color_mode, window, cx);
        subscriptions.push(cx.observe_window_appearance(window, |this, window, cx| this.on_appearance_changed(window, cx)));
        // Electron's window "focus": the index walks again, at most every
        // five minutes (MD_RESCAN_INTERVAL_MS).
        subscriptions.push(cx.observe_window_activation(window, |this, window, cx| {
            if window.is_window_active() && rescan_on_focus(this.last_scan_at, std::time::Instant::now()) {
                this.rescan(cx);
            }
        }));
        subscriptions.extend(Self::watch_window_for_cloud(window, cx));
        let (shell, shell_subs) = rail::Shell::new(color_mode, template, window, cx);
        subscriptions.extend(shell_subs);
        let (projects, projects_sub) = projects::Projects::new(window, cx);
        subscriptions.push(projects_sub);
        let (appearance, appearance_subs) = appearance::AppearanceUi::new(window, cx);
        subscriptions.extend(appearance_subs);
        // Closing flushes pending saves first (Electron's close-flush.js).
        subscriptions.push(cx.on_app_quit(|this, cx| {
            this.flush_pending(cx);
            async {}
        }));
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |this, cx| this.flush_pending(cx)).ok();
            true
        });

        let library = Library::default();

        let data_dir = paths::data_dir();
        let drafts = Drafts::new(&data_dir);
        let recovered = drafts.pending();
        let recovery = markie_core::office_recovery::RecoveryStore::new(&data_dir);
        let pending_office = recovery.pending_untitled(&data_dir.join("unsaved-office"))
            .map(|(path, revision)| (path, revision.revision));
        let cloud = cloud::CloudWorkspace::new(&data_dir, registry.as_deref());
        let mut this = Self {
            agents: agents::AgentState::new(&data_dir),
            skills: None,
            focus_handle: cx.focus_handle(),
            registry,
            cloud,
            cloud_office: Default::default(),
            cloud_search,
            library,
            shell,
            projects,
            appearance,
            darkmown: Default::default(),
            live_docs: live_docs::LiveDocs::new(&data_dir),
            editor,
            preview,
            rich,
            csv,
            csv_text_base: String::new(),
            file_grants: Default::default(),
            doc: None,
            document_failure: None,
            mode: Mode::View,
            split_source_latest: false,
            split_echo: None,
            dirty: false,
            doc_notes: Vec::new(),
            import_epoch: 0,
            import_cancel: None,
            words: 0,
            reading_minutes: 0,
            doc_stats: stats::DocStats::default(),
            sections: Vec::new(),
            history: History::new(&data_dir),
            drafts,
            disk: DiskMemory::default(),
            autosave: Autosave::default(),
            _autosave_task: Task::ready(()),
            _journal_task: Task::ready(()),
            journal_pacer: Default::default(),
            pinch: Default::default(),
            pinch_clock: Instant::now(),
            recovery,
            pending_office,
            _recovery_task: Task::ready(()),
            _poll_task: Task::ready(()),
            settle_task: None,
            lists_generation: 0,
            disk_conflict: None,
            disk_missing: false,
            recovered,
            side: SidePanel::None,
            versions: Vec::new(),
            viewing_version: None,
            history_page: None,
            nav: Default::default(),
            pending_view: None,
            pending_editor_text: None,
            collab: collab::Collab::default(),
            cloud_panel: cx.new(|cx| account::CloudPanel::new(window, cx)),
            zoom: 1.0,
            page_width: 768.0,
            source_column: Default::default(),
            vault: None,
            dialogs: overlay::Dialogs::new(cx),
            _subscriptions: subscriptions,
            menu_key: None,
            menu_nav: (false, false),
            own_theme: None,
            _doc_theme: None,
            last_scan_at: None,
            #[cfg(feature = "scene")]
            scene_cloud_uploaded: false,
        };
        this.start_disk_poll(cx);
        let focus = this.watch_rich_focus(window, cx);
        this._subscriptions.extend(focus);
        this.start_agent_bridge(window, cx);
        this.start_cloud_poll(cx);
        if let Some(reg) = &this.registry {
            if let Some(z) = reg.setting("zoom").ok().flatten().and_then(|v| v.parse().ok()) {
                this.zoom = z;
            }
            if let Some(w) = reg.setting("page_width").ok().flatten().and_then(|v| v.parse().ok()) {
                this.page_width = w;
            }
        }
        this.load_link_previews(cx);
        this.refresh_lists(cx);
        this.restore_browse_open();
        this.restore_panel_width(window);
        this.restore_home_pages();
        this.build_search_pool();

        let mut first_file = None;
        for path in initial {
            if path.is_dir() {
                if let Some(reg) = &this.registry {
                    let _ = reg.add_root(&path);
                }
            } else if first_file.is_none() {
                first_file = Some(path);
            }
        }
        if let Some(path) = first_file {
            this.open_path(&path, window, cx);
        } else if this.untitled_draft_pending() {
            // Electron offers the untitled journal entry when the launch opens
            // no document: an empty untitled buffer shows the recovery strip.
            this.open_untitled(untitled::untitled_name("md"), String::new(), window, cx);
        } else {
            // Electron never reopens the last document at launch: the first
            // launch shows the welcome, every other one an empty page.
            this.open_launch_page(window, cx);
        }
        this.rescan(cx);
        this.load_saved_snapshot(cx);
        this
    }

    /// The last scan's Library, read and prepared off the main thread so a
    /// large index never delays the first frame. A fresh scan that finishes
    /// first wins.
    fn load_saved_snapshot(&mut self, cx: &mut Context<Self>) {
        if self.registry.is_none() {
            return;
        }
        let db_path = paths::data_dir().join("registry.db");
        cx.spawn(async move |this, cx| {
            let prepared = cx
                .background_spawn(async move {
                    let snapshot = Registry::open(&db_path).ok()?.load_snapshot().ok().flatten()?;
                    Some(PreparedSnapshot::new(snapshot))
                })
                .await;
            let Some(prepared) = prepared else { return };
            this.update(cx, |this, cx| {
                if this.library.scanning {
                    this.library.set_snapshot(prepared);
                    this.build_search_pool();
                    this.compute_projects(cx);
                    if this.shell.search_open {
                        this.shell.search.share_docs_from(&this.library);
                    }
                    this.shell.invalidate_browse();
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Recent and Starred, from the registry. Their rows need a stat per
    /// file, done off the main thread: on the launch path it cost 68 ms.
    fn refresh_lists(&mut self, cx: &mut Context<Self>) {
        let Some(reg) = &self.registry else {
            // No registry, no lists: the Recent page shows its empty state.
            self.shell.lists_loaded = true;
            return;
        };
        let rows = reg.recent(200).unwrap_or_default();
        self.shell.recent.set_opened_at(rows.iter().map(|r| (r.path.clone(), r.last_opened_at.clone())));
        let recent: Vec<PathBuf> = rows.into_iter().map(|r| r.path).collect();
        let starred = reg.stars().unwrap_or_default();
        self.shell.stars = starred.iter().cloned().collect();
        self.lists_generation += 1;
        let generation = self.lists_generation;
        cx.spawn(async move |this, cx| {
            let (recent, starred) = cx
                .background_spawn(async move { (Library::recent_rows_for(recent), Library::rows_for(starred)) })
                .await;
            this.update(cx, |this, cx| {
                if this.lists_generation == generation {
                    this.library.set_rows(Vec::new(), Default::default(), starred.clone());
                    let (recent, missing) = recent;
                    this.shell.recent.set_rows(recent, missing, starred);
                    this.shell.lists_loaded = true;
                    this.shell.invalidate_browse();
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }


    fn set_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        // Hundredths: Electron's zoom presets include 0.75 and 1.25.
        self.zoom = (zoom * 100.0).round().clamp(50.0, 300.0) / 100.0;
        self.save_appearance();
        cx.notify();
    }

    fn set_page_width(&mut self, width: f32, cx: &mut Context<Self>) {
        self.page_width = width.clamp(480.0, 1600.0);
        self.save_appearance();
        cx.notify();
    }

    /// `appearanceKey` in doc-appearance.ts: a Markdown document's zoom and
    /// page width are its own, keyed by path ("untitled" without one), so
    /// two files can be read differently. Anything else shares the one
    /// zoom, as Electron's documents workspace does.
    fn appearance_key(&self) -> Option<String> {
        let doc = self.doc.as_ref()?;
        if !matches!(doc.format, FormatKind::Markdown | FormatKind::Csv | FormatKind::Darkmown) {
            return None;
        }
        Some(if doc.untitled { "appearance:untitled".into() } else { format!("appearance:{}", doc.path.display()) })
    }

    fn save_appearance(&self) {
        let Some(reg) = &self.registry else { return };
        match self.appearance_key() {
            Some(key) => {
                let _ = reg.set_setting(&key, &appearance_value(self.zoom, self.page_width));
            }
            None => {
                let _ = reg.set_setting("zoom", &self.zoom.to_string());
                let _ = reg.set_setting("page_width", &self.page_width.to_string());
            }
        }
    }

    /// The opened document's own zoom and width, or the defaults when it has
    /// none (`DEFAULT_APPEARANCE`: 100 %, the template's width).
    fn load_appearance(&mut self) {
        let Some(reg) = &self.registry else { return };
        let (zoom, width) = match self.appearance_key() {
            Some(key) => reg.setting(&key).ok().flatten().as_deref().and_then(parse_appearance).unwrap_or((1.0, 768.0)),
            None => (
                reg.setting("zoom").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(1.0),
                reg.setting("page_width").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(768.0),
            ),
        };
        self.zoom = zoom;
        self.page_width = width;
    }

    fn pinch_zoom_by(&mut self, delta_y: f32, cx: &mut Context<Self>) {
        if !matches!(self.dialogs.open, overlay::Overlay::None) {
            return;
        }
        let now = self.pinch_clock.elapsed().as_secs_f64() * 1000.;
        for step in self.pinch.feed(delta_y, now) {
            self.set_zoom(markie_editor::style::step_zoom(self.zoom, step > 0), cx);
        }
    }

    fn on_zoom_in(&mut self, _: &ZoomIn, _: &mut Window, cx: &mut Context<Self>) {
        self.set_zoom(markie_editor::style::step_zoom(self.zoom, true), cx);
    }

    fn on_zoom_out(&mut self, _: &ZoomOut, _: &mut Window, cx: &mut Context<Self>) {
        self.set_zoom(markie_editor::style::step_zoom(self.zoom, false), cx);
    }

    fn on_zoom_reset(&mut self, _: &ZoomReset, _: &mut Window, cx: &mut Context<Self>) {
        self.set_zoom(1.0, cx);
    }

    fn on_wider(&mut self, _: &PageWider, _: &mut Window, cx: &mut Context<Self>) {
        self.step_page_width(true, cx);
    }

    fn on_narrower(&mut self, _: &PageNarrower, _: &mut Window, cx: &mut Context<Self>) {
        self.step_page_width(false, cx);
    }

    /// The first-run import again, by hand. It only ever adds what is not
    /// here yet (electron_import.rs), so asking twice is harmless. The dev
    /// build has no Electron profile of its own to read and says so.
    fn on_import(&mut self, _: &ImportFromMarkie, window: &mut Window, cx: &mut Context<Self>) {
        use crate::electron_import as import;
        let may = import::applies(std::env::var_os("MARKIE_RS_DATA_DIR").is_some(), account::server_config().dev);
        let (Some(profile), Some(registry), true) = (import::source(), self.registry.as_ref(), may) else {
            window.push_notification("Markie RS does not read the installed Markie profile.", cx);
            return;
        };
        let tokens = account::shared_tokens();
        let summary = import::import(&profile, &import::Targets { registry, tokens: &*tokens, data_dir: &paths::data_dir() });
        import::record(registry, &summary);
        let said = summary.notice().unwrap_or_else(|| {
            if summary.source_missing { "No Markie profile was found to bring anything over from." } else { "Nothing new to bring over from Markie." }.to_string()
        });
        self.refresh_lists(cx);
        window.push_notification(said, cx);
        cx.notify();
    }

    fn on_toggle_star(&mut self, _: &ToggleStar, _: &mut Window, cx: &mut Context<Self>) {
        let (Some(reg), Some(doc)) = (&self.registry, &self.doc) else { return };
        if doc.untitled {
            return;
        }
        let _ = reg.toggle_star(&doc.path, "file");
        self.refresh_lists(cx);
        cx.notify();
    }

    fn rescan(&mut self, cx: &mut Context<Self>) {
        if self.library.scanning {
            return;
        }
        self.library.scanning = true;
        self.last_scan_at = Some(std::time::Instant::now());
        let roots = self
            .registry
            .as_ref()
            .and_then(|r| r.roots().ok())
            .unwrap_or_default();
        let opts = device_scan_options(roots);
        let db_path = self.registry.is_some().then(|| paths::data_dir().join("registry.db"));
        // Browse shows the walk moving: how many documents it has found so far.
        let found = self.shell.browse.found.clone();
        found.store(0, std::sync::atomic::Ordering::Relaxed);
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_millis(250)).await;
                let scanning = this.update(cx, |this, cx| {
                    if this.library.scanning && this.browse_page_open() {
                        cx.notify();
                    }
                    this.library.scanning
                });
                if !scanning.unwrap_or(false) {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            // Scan, save and prepare off the main thread: saving serializes
            // every row, and the search keys lowercase every name and path.
            let prepared = cx
                .background_spawn(async move {
                    let snapshot = markie_core::index::scan_counting(&opts, Some(&found));
                    if let Some(reg) = db_path.and_then(|p| Registry::open(&p).ok()) {
                        let _ = reg.save_snapshot(&snapshot);
                    }
                    PreparedSnapshot::new(snapshot)
                })
                .await;
            this.update(cx, |this, cx| {
                crate::perf::scan_done(prepared.elapsed_ms(), prepared.len());
                this.library.scanning = false;
                this.skills_index_updated(prepared.files(), cx);
                this.library.set_snapshot(prepared);
                this.build_search_pool();
                this.compute_projects(cx);
                if this.shell.search_open {
                    this.shell.search.share_docs_from(&this.library);
                }
                this.shell.invalidate_browse();
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Files macOS handed over while the app runs (Finder, `open -a`). A
    /// folder joins the Library; the first file opens.
    pub fn open_external(&mut self, paths: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        // A file handed over while the vault shows: leave it (asking first if
        // edits are unsaved), so the file does not open out of sight.
        if self.vault_open() {
            self.close_vault(window, cx);
        }
        let mut first_file = None;
        let mut added_root = false;
        for path in paths {
            if path.is_dir() {
                if let Some(reg) = &self.registry {
                    added_root |= reg.add_root(&path).is_ok();
                }
            } else if first_file.is_none() {
                first_file = Some(path);
            }
        }
        if added_root {
            self.refresh_lists(cx);
            self.rescan(cx);
        }
        if let Some(path) = first_file {
            self.open_path(&path, window, cx);
        }
        cx.notify();
    }

    fn open_path(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        crate::perf::open_started();
        // The place being left keeps its mode and scroll for Back.
        self.nav_capture(cx);
        self.invalidate_import();
        if self.intercept_import(path, window, cx) {
            return;
        }
        self.settle(window, cx);
        self.doc_notes.clear();
        // A synced file reached through a symlink (`/tmp/…` for
        // `/private/tmp/…`, a linked folder) opens under the path its cloud
        // binding is stored at, so the badge, the update check and live
        // editing all find it, as Electron's sync does for the same file.
        let bound = self.cloud.binding_key(path);
        let path = bound.as_deref().unwrap_or(path);
        match document::open(path) {
            Ok(doc) => {
                self.document_failure = None;
                self.file_grants.grant_document(&doc.path);
                let large = doc.is_large();
                let kind = match doc.content {
                    Content::Text { text: raw, encoding, bom } => {
                        // A CSV is held as the text it is on disk and shown
                        // as a table; its Text view is an editor that only
                        // knows "\n" (`csv_doc.rs`).
                        let csv = doc.format == FormatKind::Csv;
                        let text = raw.clone();
                        let language = doc.format.editor_language();
                        // Electron shows literal text formats in a plain field:
                        // no syntax colors and no line numbers.
                        // A .wd source is a plain textarea too. Plain text
                        // from disk is Electron's main source editor instead,
                        // line numbers and all (`text_view::documents_layout`).
                        let plain = doc.format == FormatKind::Text || csv;
                        let literal = doc.format != FormatKind::Markdown && !plain && !large;
                        let editor_text = if csv { markie_core::csv_table::plain_editor_text(&text) } else { text.clone() };
                        if csv {
                            let name = doc.path.file_name().map(|n| n.to_string_lossy().into_owned());
                            self.csv_text_base = text.clone();
                            self.csv.update(cx, |table, cx| table.open(&text, name.as_deref(), cx));
                        }
                        self.editor.update(cx, |state, cx| {
                            // Soft wrap measures every line of the file with the
                            // text system before the first frame (gpui-kit has
                            // no lazy wrap): 5 s and 2.5 GB for 10 MB. Files in
                            // the large tier (Source only) open unwrapped.
                            state.set_soft_wrap(!large, window, cx);
                            state.set_highlighter(if literal || plain { "text" } else { language }, cx);
                            state.set_line_number(!literal, window, cx);
                            state.set_folding(!literal, window, cx);
                            state.set_value(editor_text, window, cx);
                        });
                        // No set_preview here: the CSV rows and the rich editor are
                        // loaded below, once `self.doc` is the new document.
                        self.update_stats(&text);
                        self.disk.remember(&doc.path, &raw, false);
                        DocKind::Text { encoding, bom, saved: text }
                    }
                    Content::Html(html) => {
                        self.preview.update(cx, |state, cx| {
                            *state = TextViewState::html(&html, cx).selectable(true);
                        });
                        self.words = 0;
                        self.doc_stats = stats::DocStats::default();
                        self.sections.clear();
                        DocKind::Html
                    }
                    Content::Engine => {
                        self.words = 0;
                        self.doc_stats = stats::DocStats::default();
                        self.sections.clear();
                        match office::open(&doc.path, doc.format, window, cx) {
                            Ok(office) => DocKind::Office(office),
                            Err(message) => {
                                // Deferred: a file passed at launch opens before the
                                // window's notification root exists.
                                window.defer(cx, move |window, cx| window.push_notification(message, cx));
                                DocKind::Engine
                            }
                        }
                    }
                };
                if doc.format == FormatKind::Csv {
                    // A newly opened CSV starts as its table, whatever its size.
                    self.mode = Mode::View;
                } else if large || (!matches!(doc.format, FormatKind::Markdown | FormatKind::Html)
                    && matches!(kind, DocKind::Text { .. }))
                {
                    self.mode = Mode::Source;
                } else if doc.format == FormatKind::Markdown && self.doc.is_none() {
                    self.mode = Mode::View;
                }
                if !mode_allowed(doc.format, large, self.mode) {
                    self.mode = Mode::View;
                }
                self.split_source_latest = false;
                self.split_echo = None;
                if let Some(old) = &self.doc {
                    self.disk.forget(&old.path);
                }
                self.doc = Some(OpenDoc { path: doc.path.clone(), format: doc.format, large, kind, untitled: false });
                self.load_appearance();
                // A page covers the document: opening one from it leaves the page.
                self.leave_page_for_document();
                self.dirty = false;
                self.autosave.cancel();
                self.disk_conflict = None;
                self.disk_missing = false;
                self.viewing_version = None;
                // The opened bytes are the first recovery revision, as in
                // Electron's import, and they match the file. Unsaved edits
                // from an earlier session stay in Recovery history.
                if matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(_))) {
                    if let Some(notice) = self.office_unsaved_notice(&doc.path) {
                        window.push_notification(notice, cx);
                    }
                }
                self.keep_office_revision(true, cx);
                if self.side == SidePanel::History {
                    self.refresh_versions();
                }
                if self.csv_table_active() {
                    self.focus_csv(window, cx);
                } else if self.mode == Mode::Source && matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. })) {
                    self.focus_editor(window, cx);
                } else if self.rich_active() {
                    if let Some(DocKind::Text { saved, .. }) = self.doc.as_ref().map(|d| &d.kind) {
                        let text = saved.clone();
                        self.load_rich(&text, cx);
                    }
                    self.focus_rich(window, cx);
                }
                if let Some(OpenDoc { kind: DocKind::Office(office), .. }) = &self.doc {
                    office.focus(window, cx);
                }
                if let Some(reg) = &self.registry {
                    let _ = reg.track_opened(&doc.path);
                }
                self.refresh_lists(cx);
                self.refresh_cloud_resources(cx);
                let title = doc
                    .path
                    .file_name()
                    .map_or_else(|| paths::APP_NAME.to_string(), |n| n.to_string_lossy().into_owned());
                window.set_window_title(&title);
                self.collab_on_open(cx);
            }
            Err(err) => {
                window.push_notification(err.to_string(), cx);
            }
        }
        cx.notify();
    }

    fn set_preview(&mut self, text: &str, format: FormatKind, cx: &mut Context<Self>) {
        if format != FormatKind::Markdown {
            return;
        }
        // Markdown View is the rich editor. The TextView preview is never
        // shown for Markdown (a large file stays in Source), so it is not fed:
        // feeding it parsed the whole file again, 10 MB included, on every
        // open and reload.
        if self.doc.as_ref().is_some_and(|d| !d.large) && text.len() <= 1_000_000 {
            self.load_rich(text, cx);
        }
    }

    fn update_stats(&mut self, text: &str) {
        let s = stats::compute(text);
        self.words = s.words;
        self.reading_minutes = s.reading_minutes;
        self.doc_stats = s;
        self.sections = outline::sections(text);
    }

    fn on_edit(&mut self, cx: &mut Context<Self>) {
        // Split view, the rich pane's echo and a live room need the text on
        // every edit. Otherwise the whole-text work waits for a pause.
        if self.mode != Mode::Split && self.split_echo.is_none() && !self.live_running() {
            self.note_edit(cx);
            return;
        }
        let text = self.editor.read(cx).value().to_string();
        if self.split_echo.as_deref() == Some(text.as_str()) {
            // The rich pane's own edit, copied over: nothing new to save.
            self.split_echo = None;
            return;
        }
        self.live_source_edit(cx);
        if self.mode == Mode::Split {
            self.split_source_latest = true;
            self.split_rich_follow(&text, cx);
        }
        let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = &self.doc else { return };
        self.dirty = &text != saved;
        self.update_stats(&text);
        self.schedule_journal(&text, cx);
        if self.dirty && self.disk_conflict.is_none() {
            self.autosave.note_change(Instant::now());
            self.schedule_autosave(cx);
        }
        cx.notify();
    }

    /// An edit in either editor. Per keystroke this is only bookkeeping:
    /// copying out the whole text, comparing it with the saved text and
    /// recounting words and headings cost milliseconds per key on a large
    /// document, so they wait for a pause in typing (`settle_edit`).
    pub(super) fn note_edit(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. })) {
            return;
        }
        self.dirty = true;
        // The crash journal does not wait for the settle: it is due 250 ms
        // after this edit (2 s past 256 K characters), as in Electron, and
        // reads the current text when it fires.
        self.schedule_journal_after_edit(cx);
        if self.disk_conflict.is_none() {
            self.autosave.note_change(Instant::now());
            self.schedule_autosave(cx);
        }
        self.settle_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SETTLE_AFTER).await;
            this.update(cx, |this, cx| {
                this.settle_task = None;
                this.settle_edit(cx);
            })
            .ok();
        }));
        cx.notify();
    }

    /// Run a pending settle now, before anything that needs the exact state.
    pub(super) fn settle_edit_now(&mut self, cx: &mut Context<Self>) {
        if self.settle_task.take().is_some() {
            self.settle_edit(cx);
        }
    }

    fn settle_edit(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = &self.doc else { return };
        let text = self.current_text(cx);
        self.dirty = &text != saved;
        if !self.dirty {
            // Typed and undone back to the saved bytes: nothing to save.
            self.autosave.cancel();
        }
        self.update_stats(&text);
        cx.notify();
    }

    /// [`Self::schedule_journal`] for an edit on the deferred path, which has
    /// no fresh copy of the text: the wait comes from the length as last
    /// counted (`doc_stats.chars`, UTF-16 units, as `journal_delay_ms` counts).
    fn schedule_journal_after_edit(&mut self, cx: &mut Context<Self>) {
        if !self.dirty || self.doc.as_ref().is_none_or(|d| d.large || !matches!(d.kind, DocKind::Text { .. })) {
            self.journal_pacer.cancel();
            self._journal_task = Task::ready(());
            return;
        }
        let wait = self.journal_pacer.note_edit(Instant::now(), self.doc_stats.chars);
        self._journal_task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |this, cx| {
                if this.journal_pacer.take_due(Instant::now()) {
                    this.journal_now(cx);
                }
            })
            .ok();
        });
    }

    /// Journal the buffer while it is dirty, debounced, whatever autosave
    /// may do: a crash between the edit and the save loses nothing. Off for
    /// a large document, as Electron's `journal: largeDocSize === null`.
    pub(super) fn schedule_journal(&mut self, text: &str, cx: &mut Context<Self>) {
        if !self.dirty || self.doc.as_ref().is_none_or(|d| d.large || !matches!(d.kind, DocKind::Text { .. })) {
            self._journal_task = Task::ready(());
            return;
        }
        let wait = Duration::from_millis(markie_core::drafts::journal_delay_ms(text));
        self._journal_task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |this, cx| this.journal_now(cx)).ok();
        });
    }

    fn journal_now(&mut self, cx: &mut Context<Self>) {
        if !self.dirty {
            return;
        }
        let Some(doc) = &self.doc else { return };
        let path = (!doc.untitled).then(|| doc.path.clone());
        let text = self.current_text(cx);
        let _ = self.drafts.save(path.as_deref(), &text);
    }

    fn schedule_autosave(&mut self, cx: &mut Context<Self>) {
        let Some(due) = self.autosave.due_at() else { return };
        let wait = due.saturating_duration_since(Instant::now()) + Duration::from_millis(10);
        self._autosave_task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |this, cx| {
                if this.autosave.take_due(Instant::now()) {
                    this.autosave_now(cx);
                } else {
                    this.schedule_autosave(cx);
                }
            })
            .ok();
        });
    }

    /// Write whatever autosave still owes, now. Never a dialog.
    fn flush_pending(&mut self, cx: &mut Context<Self>) {
        if self.document_failure.is_some() { return; }
        if matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(_))) {
            return self.office_flush_recovery(cx);
        }
        // Only a save that was armed is owed (`settle`): a restored version or
        // draft, or edits held back by an outside change, arm nothing. Their
        // text goes to the journal instead, so closing loses nothing.
        if self.autosave.is_pending() {
            self.autosave.cancel();
            self.autosave_now(cx);
        } else if self.dirty {
            self._journal_task = Task::ready(());
            self.journal_now(cx);
        }
    }

    /// Autosave never opens a dialog: a failure leaves a crash draft and the
    /// edited marker, and the next save tries again.
    fn autosave_now(&mut self, cx: &mut Context<Self>) {
        if matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(_))) {
            // Office files are never written on a timer.
            return;
        }
        // Typed and undone back to the saved bytes inside the settle delay:
        // nothing to write.
        self.settle_edit_now(cx);
        if !self.dirty {
            return;
        }
        let text = self.current_text(cx);
        if self.is_untitled() {
            // No file yet: the journal is where autosave keeps it.
            let _ = self.drafts.save(None, &text);
            return;
        }
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
        let _ = self.drafts.save(Some(&path), &text);
        // Someone else wrote the file since Markie read it: an autosave
        // refuses and raises the strip (`saveConflictAction`), and the draft
        // above keeps the unsaved text.
        if self.disk.over_cap(&path).is_some() {
            return;
        }
        if let Some(DiskChange::Changed(theirs)) = self.disk.changed_since(&path) {
            if save_conflict_action(true, false, true) == SaveAction::Refuse {
                self.note_disk_change(theirs, cx);
                return;
            }
        }
        if self.write_text(&text, cx).is_ok() {
            let _ = self.drafts.discard(&Drafts::key_for(Some(&path)));
        }
        cx.notify();
    }

    /// Keep the previous text as a version, write the new text, and remember
    /// that this write was ours.
    fn write_text(&mut self, text: &str, cx: &mut Context<Self>) -> anyhow::Result<()> {
        let Some(doc) = self.doc.as_mut() else { return Ok(()) };
        if doc.untitled {
            return Ok(());
        }
        let DocKind::Text { encoding, bom, saved } = &mut doc.kind else { return Ok(()) };
        // A CSV is written as the text it is: the table changed only the
        // cells that were edited (`markie_core::csv_table`).
        let disk_text = text.to_string();
        let _ = self.history.capture(&doc.path, &disk_text, Writer::User);
        document::save_text(&doc.path, &disk_text, *encoding, *bom)?;
        *saved = text.to_string();
        self.disk.remember(&doc.path, &disk_text, true);
        let path = doc.path.clone();
        self.dirty = false;
        if self.side == SidePanel::History {
            self.refresh_versions();
        }
        self.cloud_after_save(&path, cx);
        Ok(())
    }

    /// Check the open file once a second, like the Electron watcher, so an
    /// agent's or another app's edit shows up without a reload.
    fn start_disk_poll(&mut self, cx: &mut Context<Self>) {
        self._poll_task = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |this, cx| this.check_disk(cx)).is_err() {
                    break;
                }
            }
        });
    }

    fn check_disk(&mut self, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        if !matches!(doc.kind, DocKind::Text { .. }) || doc.untitled {
            return;
        }
        match self.disk.changed_since(&doc.path) {
            None => {
                if self.disk_missing {
                    self.disk_missing = false;
                    cx.notify();
                }
            }
            Some(DiskChange::Missing) => {
                if !self.disk_missing {
                    self.disk_missing = true;
                    cx.notify();
                }
            }
            // Like Electron, never reload on its own: the strip asks.
            Some(DiskChange::Changed(theirs)) => {
                self.settle_edit_now(cx);
                self.note_disk_change(theirs, cx)
            }
        }
    }

    /// Replace the editor's text with what is on disk, as the saved state.
    fn load_text(&mut self, path: &Path, raw: String, cx: &mut Context<Self>) {
        self.disk.remember(path, &raw, false);
        let text = raw;
        let editor_text = self.editor_text(&text, cx);
        if let Some(OpenDoc { kind: DocKind::Text { saved, .. }, format, .. }) = self.doc.as_mut() {
            *saved = text.clone();
            let format = *format;
            self.pending_editor_text = Some(editor_text);
            self.set_preview(&text, format, cx);
        }
        self.update_stats(&text);
        self.dirty = false;
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.document_failure.is_some() { return; }
        if self.workspace_page_open() && self.live_docs_open() {
            return self.live_save(cx);
        }
        if self.is_untitled() {
            return self.save_untitled(window, cx);
        }
        if let Some(OpenDoc { path, format, kind: DocKind::Office(office), .. }) = &self.doc {
            let (path, format) = (path.clone(), *format);
            self.autosave.cancel();
            if let Some(bytes) = office::save(office, &path, window, cx) {
                self.keep_office_bytes(&path, format, &bytes, true);
                if self.side == SidePanel::History {
                    self.refresh_versions();
                }
            }
            cx.notify();
            return;
        }
        let text = self.current_text(cx);
        self.autosave.cancel();
        if let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) {
            let name = path.file_name().map_or_else(|| "This document".into(), |n| n.to_string_lossy().into_owned());
            if let Some(size) = self.disk.over_cap(&path) {
                window.push_notification(markie_core::disk::over_cap_message(&name, size), cx);
                return;
            }
            // ⌘S over a file that changed on disk asks, as `save-file` does.
            if let Some(DiskChange::Changed(theirs)) = self.disk.changed_since(&path) {
                if save_conflict_action(false, false, true) == SaveAction::Ask {
                    return self.ask_before_overwrite(path, name, theirs, window, cx);
                }
            }
        }
        self.write_after_save_checks(&text, window, cx);
    }

    /// Electron's native question for a save over an outside edit.
    fn ask_before_overwrite(&mut self, path: PathBuf, name: String, theirs: String, window: &mut Window, cx: &mut Context<Self>) {
        let answer = window.prompt(
            PromptLevel::Warning,
            &format!("\"{name}\" changed on disk since you opened it."),
            Some(
                "Something else edited this file, most likely an agent or another editor. \
                 Reloading discards your unsaved edits. Overwriting discards theirs.",
            ),
            &["Reload from disk", "Overwrite", "Cancel"],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            let Ok(choice) = answer.await else { return };
            this.update_in(cx, |this, window, cx| {
                if this.doc.as_ref().map(|d| &d.path) != Some(&path) {
                    return;
                }
                match choice {
                    0 => {
                        this.disk_conflict = None;
                        this.load_text(&path, theirs, cx);
                        cx.notify();
                    }
                    1 => {
                        let text = this.current_text(cx);
                        this.write_after_save_checks(&text, window, cx);
                    }
                    _ => {}
                }
            })
            .ok();
        })
        .detach();
    }

    fn write_after_save_checks(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.to_string();
        if let Err(err) = self.write_text(&text, cx) {
            window.push_notification(format!("Markie could not save: {err:#}"), cx);
        } else if let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) {
            let _ = self.drafts.discard(&Drafts::key_for(Some(&path)));
        }
        cx.notify();
    }

    fn focus_editor(&self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = self.editor.read(cx).focus_handle(cx);
        handle.focus(window, cx);
    }

    /// ⌘E: Source from View or Split, View from Source.
    fn toggle_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let next = if self.mode == Mode::Source { Mode::View } else { Mode::Source };
        self.set_mode(next, window, cx);
    }

    /// ⌘1, ⌘2 and ⌘3. Like Electron's `requestMode`, a large or literal
    /// text document stays in Source, and only Markdown splits.
    fn set_mode(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        if self.mode == mode || !mode_allowed(doc.format, doc.large, mode) || !matches!(doc.kind, DocKind::Text { .. }) {
            return;
        }
        if doc.format == FormatKind::Csv {
            return self.csv_set_mode(mode, window, cx);
        }
        let format = doc.format;
        let was = self.mode;
        let source_latest = match was {
            Mode::Source => true,
            Mode::Split => self.split_source_latest,
            Mode::View => false,
        };
        if source_latest {
            let text = self.editor.read(cx).value().to_string();
            self.mode = mode;
            if mode != Mode::Source {
                self.set_preview(&text, format, cx);
            }
        } else {
            if self.rich_active() && mode != Mode::View {
                self.rich_to_source(window, cx);
            }
            self.mode = mode;
        }
        self.split_source_latest = mode == Mode::Split && source_latest;
        match mode {
            Mode::Source => self.focus_editor(window, cx),
            Mode::Split if was == Mode::Source => self.focus_editor(window, cx),
            _ if self.rich_active() => self.focus_rich(window, cx),
            _ => {}
        }
        cx.notify();
    }

    /// A source edit in Split: the rich pane shows it, keeping its scroll.
    fn split_rich_follow(&mut self, text: &str, cx: &mut Context<Self>) {
        let parsed = markie_rich::editor::Editor::parse(text);
        self.rich.update(cx, |r, cx| {
            r.editor = parsed;
            r.remote_changed(cx);
        });
    }

    /// A rich edit in Split: the source pane shows it.
    pub(super) fn split_source_follow(&mut self, text: String) {
        if self.mode != Mode::Split {
            return;
        }
        self.split_source_latest = false;
        self.split_echo = Some(text.clone());
        self.pending_editor_text = Some(text);
    }

    fn on_open(&mut self, _: &Open, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update_in(cx, |this, window, cx| this.open_path(&path, window, cx)).ok();
                }
            }
        })
        .detach();
    }

    fn on_open_folder(&mut self, _: &OpenFolder, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add Folder".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update(cx, |this, cx| {
                    if let Some(reg) = &this.registry {
                        for p in &paths {
                            let _ = reg.add_root(p);
                        }
                    }
                    this.rescan(cx);
                })
                .ok();
            }
        })
        .detach();
    }

    fn on_save(&mut self, _: &Save, window: &mut Window, cx: &mut Context<Self>) {
        // ⌘S over the office cloud dialog saves its cloud version, never the
        // local file (document-cloud-dialog.tsx).
        if self.office_save_shortcut(window, cx) {
            return;
        }
        self.save(window, cx);
    }

    fn on_toggle_mode(&mut self, _: &ToggleMode, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_mode(window, cx);
    }

    fn on_focus_search(&mut self, _: &FocusSearch, window: &mut Window, cx: &mut Context<Self>) {
        self.open_search(window, cx);
    }

    fn on_rescan(&mut self, _: &Rescan, _: &mut Window, cx: &mut Context<Self>) {
        self.rescan(cx);
    }

    fn refresh_versions(&mut self) {
        self.versions = match &self.doc {
            Some(doc) if matches!(doc.kind, DocKind::Office(_)) => self.office_versions(&doc.path),
            Some(doc) => {
                let mut v = self.history.list(&doc.path);
                v.reverse();
                v
            }
            None => Vec::new(),
        };
    }

    fn toggle_side(&mut self, panel: SidePanel, cx: &mut Context<Self>) {
        self.side = if self.side == panel { SidePanel::None } else { panel };
        self.viewing_version = None;
        cx.notify();
    }

    fn on_toggle_outline(&mut self, _: &ToggleOutline, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_side(SidePanel::Outline, cx);
    }

    fn on_toggle_stats(&mut self, _: &ToggleStats, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_side(SidePanel::Stats, cx);
    }

    /// The file changed on disk while there were unsaved edits.
    fn take_theirs(&mut self, cx: &mut Context<Self>) {
        let Some(theirs) = self.disk_conflict.take() else { return };
        if let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) {
            self.load_text(&path, theirs, cx);
        }
        cx.notify();
    }

    fn keep_mine(&mut self, cx: &mut Context<Self>) {
        self.disk_conflict = None;
        let text = self.current_text(cx);
        // History keeps the outside version first, so overwriting loses nothing.
        let _ = self.write_text(&text, cx);
        cx.notify();
    }

    fn render_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.render_strips(cx)
    }

    // ---------------------------------------------------------------- render

    /// Split: the source pane at 0.96fr with its hairline on the right, the
    /// rich pane at 1.04fr, as `markie-document-area--split` lays them out.
    fn render_split(&self, cx: &mut Context<Self>) -> AnyElement {
        self.sync_rich_appearance(cx);
        // One formatting row above both panes, as Electron's DocToolbar.
        let toolbar = self.rich.update(cx, |r, cx| r.split_toolbar(cx));
        let source = self.source_mouse(
            self.source_column.render(
                &self.editor,
                Editor::new(&self.editor)
                    .bordered(false)
                    .h(relative(1.))
                    .font_family(markie_editor::MONO)
                    .text_size(px(14. * self.zoom))
                    // CodeMirror's `.cm-content` line height; GPUI Kit's editor uses 1.5.
                    .line_height(relative(SOURCE_LINE_HEIGHT))
                    .into_any_element(),
                self.page_width,
                14. * self.zoom,
                SOURCE_LINE_HEIGHT,
                self.rail_sections(),
                cx,
            ),
            cx,
        );
        let theme = cx.theme();
        let panes = h_flex()
            .w_full()
            .flex_1()
            .min_h_0()
            .bg(theme.background)
            .child(
                div()
                    .h_full()
                    .min_w_0()
                    .w(relative(0.48))
                    .border_r_1()
                    .border_color(theme.border)
                    .overflow_hidden()
                    .child(source),
            )
            .child(div().h_full().min_w_0().w(relative(0.52)).overflow_hidden().child(self.rich.clone()));
        v_flex().size_full().bg(theme.background).child(toolbar).child(panes).into_any_element()
    }

    fn render_document(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.document_failure.is_none() {
            match markie_core::render_boundary::project(|| self.project_document(cx)) {
                Ok(document) => return document,
                Err(detail) => self.show_document_failure(&detail, cx),
            }
        }
        self.render_document_failure(cx)
    }

    fn project_document(&self, cx: &mut Context<Self>) -> AnyElement {
        #[cfg(debug_assertions)]
        if self.doc.is_some()
            && std::env::var_os("MARKIE_RS_DATA_DIR").is_some()
            && std::env::var_os("MARKIE_RS_RENDER_PROBE").is_some()
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            static FIRED: AtomicBool = AtomicBool::new(false);
            assert!(FIRED.swap(true, Ordering::Relaxed), "Scratch document render probe");
        }
        let theme = cx.theme();
        let Some(doc) = &self.doc else {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_3()
                .bg(theme.background)
                .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child(paths::APP_NAME))
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Pick a document from the Library, or open one."),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("empty-open")
                                .primary()
                                .label("Open…")
                                .on_click(|_, window, cx| window.dispatch_action(Box::new(Open), cx)),
                        )
                        .child(
                            Button::new("empty-new")
                                .label("New document")
                                .on_click(|_, window, cx| window.dispatch_action(Box::new(NewDocument), cx)),
                        ),
                )
                .into_any_element();
        };

        if let Some((_, text)) = &self.viewing_version {
            return div()
                .id("version-preview")
                .size_full()
                .overflow_y_scroll()
                .bg(theme.muted)
                .px(px(56.))
                .py(px(32.))
                .font_family(theme.mono_font_family.clone())
                .text_size(theme.mono_font_size)
                .child(text.clone())
                .into_any_element();
        }

        match (&doc.kind, self.mode) {
            (DocKind::Office(office), _) => office::render(office, doc.untitled, doc.format, self.zoom, cx),
            (DocKind::Engine, _) => {
                // The Office engine refused the file. Electron keeps the page
                // and shows its reason in a red strip; the reason is in the
                // notification, so the strip says what happened.
                let path = doc.path.clone();
                v_flex()
                    .size_full()
                    .bg(theme.background)
                    .child(
                        h_flex()
                            .px(px(20.))
                            .py(px(10.))
                            .gap(px(12.))
                            .text_size(px(12.))
                            .bg(theme.muted)
                            .border_b_1()
                            .border_color(theme.border)
                            .text_color(theme.danger)
                            .child(div().flex_1().child(format!("This {} document could not be opened. Nothing in the file was changed.", doc.format.label())))
                            .child(Button::new("open-system").xsmall().ghost().label("Open in default app").on_click(move |_, _, cx| cx.open_with_system(&path))),
                    )
                    .into_any_element()
            }
            // A CSV's one pane is its table, with the file's own text a switch away.
            (DocKind::Text { saved, .. }, _) if doc.format == FormatKind::Csv => self.render_csv(doc.large.then_some(saved.len()), doc.untitled, cx),
            (DocKind::Text { .. }, Mode::Split) if doc.format == FormatKind::Markdown && !doc.large => self.render_split(cx),
            (DocKind::Text { .. }, Mode::View) if doc.format == FormatKind::Markdown && !doc.large => {
                self.sync_rich_appearance(cx);
                div().size_full().child(self.rich.clone()).into_any_element()
            }
            (DocKind::Html, _) | (DocKind::Text { .. }, Mode::View) if doc.format == FormatKind::Markdown || matches!(doc.kind, DocKind::Html) => {
                let background = theme.background;
                let name = doc.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let banner = matches!(doc.kind, DocKind::Html).then(|| office::html_banner(&name, cx));
                v_flex()
                    .size_full()
                    .children(banner)
                    .bg(background)
                    .child(
                        h_flex().size_full().justify_center().child(
                            TextView::new(&self.preview)
                                .scrollable(true)
                                .selectable(true)
                                .h_full()
                                .w_full()
                                .max_w(px(self.page_width))
                                .text_size(rems(self.zoom))
                                .px(px(40.))
                                .py(px(32.)),
                        ),
                    )
                    .into_any_element()
            }
            // Literal text formats look like Electron's TextDocumentEditor.
            (DocKind::Text { .. }, _) if doc.format == FormatKind::Darkmown && !doc.large => {
                self.source_column.clear(&self.editor, cx);
                self.render_darkmown(cx)
            }
            (DocKind::Text { .. }, _) if text_view::documents_layout(doc.format, doc.untitled) && !doc.large => {
                self.source_column.clear(&self.editor, cx);
                self.render_text(cx)
            }
            _ => div()
                .size_full()
                .flex()
                .flex_col()
                .bg(theme.background)
                .when_some(
                    match &doc.kind {
                        DocKind::Text { saved, .. } if doc.large => Some(saved.len()),
                        _ => None,
                    },
                    |d, bytes| d.child(text_view::large_strip(bytes, cx)),
                )
                .when(matches!(doc.format, FormatKind::Markdown | FormatKind::Darkmown), |d| d.child(self.source_toolbar(cx)))
                .child(self.source_mouse(
                    self.source_column.render(
                        &self.editor,
                        Editor::new(&self.editor)
                            .bordered(false)
                            .h(relative(1.))
                            .font_family(markie_editor::MONO)
                            .text_size(px(14. * self.zoom))
                            .line_height(relative(SOURCE_LINE_HEIGHT))
                            .into_any_element(),
                        self.page_width,
                        14. * self.zoom,
                        SOURCE_LINE_HEIGHT,
                        self.rail_sections(),
                        cx,
                    ),
                    cx,
                ))
                .into_any_element(),
        }
    }

    /// The headings Electron's Source section rail ticks (`extractSections`:
    /// h1 to h3 with text). Plain text documents have no rail.
    fn rail_sections(&self) -> usize {
        if !self.doc.as_ref().is_some_and(|d| matches!(d.format, FormatKind::Markdown | FormatKind::Darkmown)) {
            return 0;
        }
        self.sections.iter().filter(|s| s.level <= 3 && !s.text.trim().is_empty()).count()
    }
}

/// A document's remembered zoom and page width, as one setting value.
fn appearance_value(zoom: f32, width: f32) -> String {
    format!("{zoom} {width}")
}

fn parse_appearance(value: &str) -> Option<(f32, f32)> {
    let mut parts = value.split_whitespace();
    let zoom: f32 = parts.next()?.parse().ok()?;
    let width: f32 = parts.next()?.parse().ok()?;
    (zoom > 0. && width > 0.).then_some((zoom, width))
}

/// Source mode's rows: CodeMirror's 1.4, 19.6 pt at 14 pt, as Electron draws them.
const SOURCE_LINE_HEIGHT: f32 = 1.4;

/// May `format` show in `mode`? Electron's `requestMode`: large and literal
/// text documents only edit as source, and only Markdown splits. A CSV has
/// two views of one pane, its table (View) and its text (Source), at any size.
fn mode_allowed(format: FormatKind, large: bool, mode: Mode) -> bool {
    match mode {
        Mode::Source => true,
        Mode::View => format == FormatKind::Csv || (!large && format == FormatKind::Markdown),
        Mode::Split => !large && format == FormatKind::Markdown,
    }
}

#[cfg(test)]
mod mode_tests {
    use super::{FormatKind, Mode, mode_allowed};

    #[test]
    fn markdown_takes_every_mode() {
        for mode in [Mode::View, Mode::Source, Mode::Split] {
            assert!(mode_allowed(FormatKind::Markdown, false, mode), "{mode:?}");
        }
    }

    #[test]
    fn large_and_literal_text_stay_in_source() {
        assert!(!mode_allowed(FormatKind::Markdown, true, Mode::View));
        assert!(!mode_allowed(FormatKind::Markdown, true, Mode::Split));
        assert!(mode_allowed(FormatKind::Markdown, true, Mode::Source));
        assert!(!mode_allowed(FormatKind::Text, false, Mode::View));
        assert!(!mode_allowed(FormatKind::Json, false, Mode::Split));
    }

    #[test]
    fn a_csv_is_a_table_or_its_text_at_any_size() {
        // Its one pane is the table (View), with the file's text (Source) a
        // switch away. It is never converted, so it has no rich pane to split.
        for large in [false, true] {
            assert!(mode_allowed(FormatKind::Csv, large, Mode::View));
            assert!(mode_allowed(FormatKind::Csv, large, Mode::Source));
            assert!(!mode_allowed(FormatKind::Csv, large, Mode::Split));
        }
    }
}

#[cfg(test)]
mod appearance_tests {
    use super::{appearance_value, parse_appearance};

    #[test]
    fn a_documents_zoom_and_width_round_trip() {
        assert_eq!(parse_appearance(&appearance_value(1.25, 1040.)), Some((1.25, 1040.)));
        assert_eq!(parse_appearance(&appearance_value(0.9, 768.)), Some((0.9, 768.)));
        // Anything else reads as no remembered appearance: the defaults.
        for bad in ["", "1.1", "x 768", "0 768", "1.0 -4"] {
            assert_eq!(parse_appearance(bad), None, "{bad:?}");
        }
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// `MD_RESCAN_INTERVAL_MS`.
const RESCAN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// The focus rule in electron/main.js: only after this session has walked
/// once, and not within five minutes of the last walk.
fn rescan_on_focus(last: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    last.is_some_and(|at| now.duration_since(at) >= RESCAN_INTERVAL)
}

#[cfg(test)]
mod rescan_tests {
    use super::{RESCAN_INTERVAL, rescan_on_focus};
    use std::time::{Duration, Instant};

    #[test]
    fn focus_walks_again_only_after_five_minutes() {
        let now = Instant::now();
        assert!(!rescan_on_focus(None, now), "no walk asked for yet");
        assert!(!rescan_on_focus(Some(now), now + Duration::from_secs(299)));
        assert!(rescan_on_focus(Some(now), now + RESCAN_INTERVAL));
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::perf::frame_start();
        self.refresh_menus(cx);
        if let Some(path) = self.cloud.pending_link.take() {
            self.open_path(&path, window, cx);
        }
        if let Some(text) = self.pending_editor_text.take() {
            self.editor.update(cx, |state, cx| state.set_value(text, window, cx));
        }
        self.ensure_browse_rows();
        self.nav_sync(window, cx);
        self.sync_home_pages(window, cx);
        self.sync_vault(window, cx);
        self.sync_darkmown(window, cx);
        // A video card's player is a web view too: hidden under any layer.
        let hide_video = self.document_failure.is_some() || self.web_views_covered(window, cx) || !self.rich_active();
        self.rich.update(cx, |r, _| r.set_web_views_covered(hide_video));
        let document_actions = self.doc.is_some() && self.document_failure.is_none()
            && !self.workspace_page_open() && !self.dialogs.open.is_open();
        let output_actions = document_actions && match self.doc.as_ref().map(|d| &d.kind) {
            Some(DocKind::Office(office)) => markie_export::office_pdf::can_print(office.view.read(cx).editor.rich()),
            _ => true,
        };
        if let Some(OpenDoc { kind: DocKind::Office(office), .. }) = &self.doc {
            office.view.update(cx, |view, cx| view.set_menu_suspended(!document_actions, cx));
        }
        self.sync_live_preview(window, cx);
        let banner = self.render_banner(cx);
        let cloud_banner = self.render_cloud_banner(cx);
        let history = match self.side {
            // Version history is a dialog now, like Electron's.
            SidePanel::History => None,
            SidePanel::Outline => Some(self.render_outline(cx).into_any_element()),
            // Statistics is a popover over the window (`StatsPanel`).
            SidePanel::Stats => None,
            SidePanel::None => None,
        };
        let dialogs = self.render_dialogs(window, cx);
        let root = v_flex()
            .id("workspace")
            .track_focus(&self.focus_handle)
            .key_context("Workspace")
            // Escape closes the statistics popover, as its window listener does.
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && this.side == SidePanel::Stats {
                    this.side = SidePanel::None;
                    cx.notify();
                }
            }))
            // A trackpad pinch, or ctrl + scroll, is ⌘+ and ⌘- (page.tsx).
            .on_pinch(cx.listener(|this, e: &PinchEvent, _, cx| {
                let dy = markie_editor::style::PinchZoom::wheel_delta_for_magnification(e.delta);
                this.pinch_zoom_by(dy, cx);
            }))
            // ctrl + scroll zooms and never scrolls, as Chromium's ctrl + wheel
            // does: it is caught on the way down, before the page's scroll
            // view would move under it.
            .child({
                let this = cx.entity().downgrade();
                canvas(
                    |_, _, _| {},
                    move |_, _, window, _| {
                        let this = this.clone();
                        window.on_mouse_event(move |e: &ScrollEvent, phase, _, cx| {
                            if phase == DispatchPhase::Capture && e.modifiers.control {
                                // GPUI's y is positive toward the top; a wheel's is down.
                                let dy = -f32::from(e.delta.pixel_delta(px(20.)).y);
                                let _ = this.update(cx, |this, cx| this.pinch_zoom_by(dy, cx));
                                cx.stop_propagation();
                            }
                        });
                    },
                )
                .absolute()
                .size_0()
            })
            .map(|d| Self::source_actions(d, cx))
            .map(|d| Self::edit_menu_actions(d, cx))
            .on_action(cx.listener(Self::on_open))
            .on_action(cx.listener(Self::on_navigate_back))
            .on_action(cx.listener(Self::on_navigate_forward))
            // A mouse's back and forward buttons (and the swipes some mice
            // and a three-finger trackpad swipe send as them).
            .capture_any_mouse_down(cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                if let MouseButton::Navigate(direction) = ev.button {
                    this.navigate(direction == NavigationDirection::Back, window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_action(cx.listener(Self::on_open_folder))
            .on_action(cx.listener(Self::on_new))
            .on_action(cx.listener(|this, _: &NewMarkdownDocument, window, cx| this.create_document("md", window, cx)))
            .on_action(cx.listener(|this, _: &NewWordDocument, window, cx| this.create_document("docx", window, cx)))
            .on_action(cx.listener(|this, _: &NewTextDocument, window, cx| this.create_document("txt", window, cx)))
            .on_action(cx.listener(|this, _: &NewDarkmownDocument, window, cx| this.create_document("wd", window, cx)))
            .when(document_actions, |root| root.on_action(cx.listener(Self::on_document_details)))
            .on_action(cx.listener(Self::on_save))
            .on_action(cx.listener(Self::on_toggle_mode))
            .on_action(cx.listener(Self::on_focus_search))
            .on_action(cx.listener(Self::on_rescan))
            .on_action(cx.listener(Self::on_toggle_theme))
            .on_action(cx.listener(Self::on_show_history))
            .on_action(cx.listener(Self::on_toggle_outline))
            .on_action(cx.listener(Self::on_toggle_star))
            .on_action(cx.listener(Self::on_import))
            .on_action(cx.listener(Self::on_settings))
            .on_action(cx.listener(Self::on_zoom_in))
            .on_action(cx.listener(Self::on_zoom_out))
            .on_action(cx.listener(Self::on_zoom_reset))
            .on_action(cx.listener(Self::on_wider))
            .on_action(cx.listener(Self::on_narrower))
            .on_action(cx.listener(Self::on_toggle_stats))
            .on_action(cx.listener(Self::on_palette))
            .on_action(cx.listener(Self::on_rename))
            .on_action(cx.listener(Self::on_duplicate))
            .on_action(cx.listener(Self::on_trash))
            .on_action(cx.listener(Self::on_reveal))
            .on_action(cx.listener(Self::on_copy_path))
            .on_action(cx.listener(Self::on_open_account))
            .on_action(cx.listener(Self::on_show_cloud))
            .on_action(cx.listener(Self::on_toggle_library))
            .on_action(cx.listener(Self::on_toggle_vault))
            .when(output_actions, |root| root.on_action(cx.listener(Self::on_print)).on_action(cx.listener(Self::on_export_pdf_light)))
            .on_action(cx.listener(Self::on_export_pdf_dark))
            .on_action(cx.listener(Self::on_export_html))
            // page.tsx `handleDrop`: a file dropped on the window opens.
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| this.drop_on_window(paths.paths().to_vec(), window, cx)))
            .on_action(cx.listener(Self::on_darkmown_source_view))
            .on_action(cx.listener(Self::on_darkmown_preview_view))
            .on_action(cx.listener(Self::on_darkmown_split_view))
            // The Library panel's resizer drag follows the pointer anywhere.
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, window, cx| {
                if this.shell.panel_drag.is_some() {
                    this.panel_drag_move(f32::from(ev.position.x), window, cx);
                }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.panel_drag_end(cx)))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.panel_drag_end(cx)))
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                if ev.keystroke.key == "escape" && this.panel_drag_cancel(cx) {
                    cx.stop_propagation();
                } else if ev.keystroke.key == "escape" && this.live_docs.preview.is_some() && !this.dialogs.open.is_open() && !this.shell.search_open {
                    this.close_live_preview(cx);
                    cx.stop_propagation();
                } else if (this.shell.row_menu.is_some() || this.shell.cloud_row_menu.is_some()) && this.row_menu_key(ev.keystroke.key.as_str(), window, cx) {
                    cx.stop_propagation();
                }
            }))
            .relative()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .map(|root| {
                // The History page is a mode of the document that covers the
                // whole window, its own title bar included, as Electron's.
                if self.history_page_open() {
                    return root.child(self.render_history_page(window, cx));
                }
                root.child(self.render_title_bar(cx)).child(
                    h_flex()
                        .flex_1()
                        .min_h_0()
                        .overflow_hidden()
                        .child(self.render_rail(cx))
                        .children(self.render_side_panel(cx))
                        .map(|el| {
                            if self.workspace_page_open() {
                                el.child(div().flex_1().min_w_0().h_full().child(self.render_workspace_page(window, cx)))
                            } else {
                                el.child(
                                    v_flex()
                                        .flex_1()
                                        .min_w_0()
                                        .h_full()
                                        .overflow_hidden()
                                        .children(banner)
                                        .children(self.render_untitled_office_offer(cx))
                                        .children(cloud_banner)
                                        .children(self.render_live_banner(cx))
                                        .child(
                                            div()
                                                .relative()
                                                .flex_1()
                                                .min_h_0()
                                                .overflow_hidden()
                                                .child(self.render_document(cx))
                                                .children(self.render_comments(window, cx)),
                                        ),
                                )
                                .children(history.map(|h| div().w(px(300.)).h_full().flex_none().child(h)))
                            }
                        }),
                )
            })
            .children((self.side == SidePanel::Stats).then(|| self.render_stats(window, cx)))
            .children(self.render_live_preview(cx))
            .children(self.render_row_menu(cx))
            .children(self.render_search(cx))
            .children(self.render_share(window, cx))
            .children(self.render_office_cloud(window, cx))
            .children(crate::perf::marker());
        self.dialog_actions(root, cx).children(dialogs)
    }
}

/// The device index's scan options. A scratch data folder
/// (`MARKIE_RS_DATA_DIR`) stands in for home, so a test run never walks the
/// real home folder. Everything that reads the index, the Skills view's tool
/// roots and its `~/` paths included, must use this same home, or no indexed
/// file sits under the roots it is matched against.
pub(crate) fn device_scan_options(roots: Vec<std::path::PathBuf>) -> ScanOptions {
    let scratch = std::env::var_os("MARKIE_RS_DATA_DIR").map(|_| paths::data_dir());
    scan_options_for(scratch, paths::home_dir(), roots)
}

pub(crate) fn scan_options_for(
    scratch_data: Option<std::path::PathBuf>,
    home: std::path::PathBuf,
    roots: Vec<std::path::PathBuf>,
) -> ScanOptions {
    match scratch_data {
        Some(data) => ScanOptions { roots, ..ScanOptions::for_home(data) },
        None => ScanOptions::from_env(home, roots),
    }
}
