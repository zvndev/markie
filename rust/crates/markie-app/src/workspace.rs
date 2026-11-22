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
use markie_core::disk::{DiskChange, DiskMemory};
use markie_core::document::{self, Content};
use markie_core::drafts::{Draft, Drafts};
use markie_core::history::{History, Version, Writer};
use markie_core::formats::{FormatKind, TextEncoding};
use markie_core::index::{ScanOptions, scan};
use markie_core::registry::Registry;
use markie_core::{outline, paths, stats};

use crate::actions::*;
use crate::library::Library;

pub(crate) mod account;
mod account_slot;
mod agents;
mod appearance;
mod chrome;
mod csv_doc;
mod collab;
mod comments;
mod share;
mod dialog_chrome;
mod document_failure;
mod file_ops;
mod first_run;
mod folder_tree;
mod history_dialog;
mod library_rows;
mod live_docs;
mod import_copy;
mod cloud;
mod cloud_drive;
mod cloud_office;
mod cloud_page;
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
mod rich;
mod text_view;
mod untitled;
mod settings;
mod shortcuts;
mod strips;
mod skills;
pub mod source;
pub(crate) mod vault;

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
    sections: Vec<outline::Section>,
    history: History,
    drafts: Drafts,
    disk: DiskMemory,
    autosave: Autosave,
    _autosave_task: Task<()>,
    /// Office documents' recovery history (Electron's document library).
    recovery: markie_core::office_recovery::RecoveryStore,
    pending_office: Option<(PathBuf, u64)>,
    _recovery_task: Task<()>,
    _poll_task: Task<()>,
    /// What the file says on disk when it changed under unsaved edits.
    disk_conflict: Option<String>,
    disk_missing: bool,
    /// Unsaved text recovered from a crash, offered once at launch.
    recovered: Vec<Draft>,
    /// The version history panel, and the version being looked at.
    side: SidePanel,
    versions: Vec<Version>,
    viewing_version: Option<(String, String)>,
    /// Document zoom (1.0 = 100%) and reading column width, shared by every
    /// document like the Electron app's `markie.documents.zoom.v1`.
    zoom: f32,
    page_width: f32,
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
}

impl Workspace {
    pub fn new(initial: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let registry = Registry::open(&paths::data_dir().join("registry.db"))
            .map(Rc::new)
            .map_err(|e| eprintln!("markie-rs: registry unavailable: {e:#}"))
            .ok();

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

        let mut subscriptions = vec![
            cx.subscribe(&editor, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.on_edit(cx);
                }
            }),
            rich_sub,
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
        crate::themes::apply_store(store, Some(window), cx);
        // The user's own light or dark choice outranks the system appearance;
        // System follows macOS, also when it changes while the app runs.
        let color_mode =
            chrome::ColorMode::parse(registry.as_ref().and_then(|r| r.setting("color_mode").ok().flatten()).as_deref());
        chrome::apply_color_mode(color_mode, window, cx);
        subscriptions.push(cx.observe_window_appearance(window, |this, window, cx| this.on_appearance_changed(window, cx)));
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

        let mut library = Library::default();
        if let Some(snapshot) = registry.as_ref().and_then(|r| r.load_snapshot().ok().flatten()) {
            library.set_snapshot(snapshot);
        }

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
            sections: Vec::new(),
            history: History::new(&data_dir),
            drafts,
            disk: DiskMemory::default(),
            autosave: Autosave::default(),
            _autosave_task: Task::ready(()),
            recovery,
            pending_office,
            _recovery_task: Task::ready(()),
            _poll_task: Task::ready(()),
            disk_conflict: None,
            disk_missing: false,
            recovered,
            side: SidePanel::None,
            versions: Vec::new(),
            viewing_version: None,
            pending_editor_text: None,
            collab: collab::Collab::default(),
            cloud_panel: cx.new(|cx| account::CloudPanel::new(window, cx)),
            zoom: 1.0,
            page_width: 768.0,
            vault: None,
            dialogs: overlay::Dialogs::new(cx),
            _subscriptions: subscriptions,
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
        this.refresh_lists();
        this.restore_browse_open();
        this.restore_panel_width(window);
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
        let seen = this.registry.as_ref().and_then(|r| r.setting(first_run::SEEN_KEY).ok().flatten()).is_some();
        let show_welcome = first_run::should_show_welcome(first_file.is_some(), seen);
        if let Some(path) = first_file {
            this.open_path(&path, window, cx);
        } else if this.untitled_draft_pending() {
            // Electron offers the untitled journal entry when the launch opens
            // no document: an empty untitled buffer shows the recovery strip.
            this.open_untitled(untitled::untitled_name("md"), String::new(), window, cx);
        } else if show_welcome {
            this.open_welcome(window, cx);
            if let Some(registry) = &this.registry {
                let _ = registry.set_setting(first_run::SEEN_KEY, "1");
            }
        } else if let Some(path) = this.most_recent() {
            this.open_path(&path, window, cx);
        }
        this.rescan(cx);
        this
    }

    fn refresh_lists(&mut self) {
        let Some(reg) = &self.registry else { return };
        let recent = reg.recent(200).unwrap_or_default().into_iter().map(|r| r.path).collect();
        let starred = reg.stars().unwrap_or_default();
        self.library.set_lists(Vec::new(), starred.clone());
        self.shell.stars = starred.iter().cloned().collect();
        self.shell.recent.set_lists(recent, starred);
        self.shell.invalidate_browse();
    }


    fn set_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        // Hundredths: Electron's zoom presets include 0.75 and 1.25.
        self.zoom = (zoom * 100.0).round().clamp(50.0, 300.0) / 100.0;
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("zoom", &self.zoom.to_string());
        }
        cx.notify();
    }

    fn set_page_width(&mut self, width: f32, cx: &mut Context<Self>) {
        self.page_width = width.clamp(480.0, 1600.0);
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("page_width", &self.page_width.to_string());
        }
        cx.notify();
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

    fn on_import(&mut self, _: &ImportFromMarkie, window: &mut Window, cx: &mut Context<Self>) {
        window.push_notification("Markie RS does not read the installed Markie profile.", cx);
    }

    fn on_toggle_star(&mut self, _: &ToggleStar, _: &mut Window, cx: &mut Context<Self>) {
        let (Some(reg), Some(doc)) = (&self.registry, &self.doc) else { return };
        if doc.untitled {
            return;
        }
        let _ = reg.toggle_star(&doc.path, "file");
        self.refresh_lists();
        cx.notify();
    }

    fn most_recent(&self) -> Option<PathBuf> {
        self.registry
            .as_ref()?
            .recent(5)
            .ok()?
            .into_iter()
            .map(|r| r.path)
            .find(|p| p.exists())
    }

    fn rescan(&mut self, cx: &mut Context<Self>) {
        if self.library.scanning {
            return;
        }
        self.library.scanning = true;
        let roots = self
            .registry
            .as_ref()
            .and_then(|r| r.roots().ok())
            .unwrap_or_default();
        let opts = if std::env::var_os("MARKIE_RS_DATA_DIR").is_some() {
            ScanOptions { roots, ..ScanOptions::for_home(paths::data_dir()) }
        } else {
            ScanOptions::from_env(paths::home_dir(), roots)
        };
        cx.spawn(async move |this, cx| {
            let snapshot = cx.background_spawn(async move { scan(&opts) }).await;
            this.update(cx, |this, cx| {
                if let Some(reg) = &this.registry {
                    let _ = reg.save_snapshot(&snapshot);
                }
                this.library.scanning = false;
                this.library.set_snapshot(snapshot);
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
            self.refresh_lists();
            self.rescan(cx);
        }
        if let Some(path) = first_file {
            self.open_path(&path, window, cx);
        }
        cx.notify();
    }

    fn open_path(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        self.invalidate_import();
        if self.intercept_import(path, window, cx) {
            return;
        }
        self.settle(window, cx);
        self.doc_notes.clear();
        match document::open(path) {
            Ok(doc) => {
                self.document_failure = None;
                self.file_grants.grant_document(&doc.path);
                let large = doc.is_large();
                let kind = match doc.content {
                    Content::Text { text: raw, encoding, bom } => {
                        // A CSV is edited as its Markdown table (fromDisk).
                        let text = csv_doc::from_disk(doc.format, &raw);
                        let language = if doc.format == FormatKind::Csv { "markdown" } else { doc.format.editor_language() };
                        // Electron shows literal text formats in a plain field:
                        // no syntax colors and no line numbers.
                        let literal = !matches!(doc.format, FormatKind::Markdown | FormatKind::Darkmown | FormatKind::Csv) && !large;
                        self.editor.update(cx, |state, cx| {
                            state.set_highlighter(if literal { "text" } else { language }, cx);
                            state.set_line_number(!literal, window, cx);
                            state.set_value(text.clone(), window, cx);
                        });
                        self.set_preview(&text, doc.format, cx);
                        self.update_stats(&text);
                        self.disk.remember(&doc.path, &raw, false);
                        DocKind::Text { encoding, bom, saved: text }
                    }
                    Content::Html(html) => {
                        self.preview.update(cx, |state, cx| {
                            *state = TextViewState::html(&html, cx).selectable(true);
                        });
                        self.words = 0;
                        self.sections.clear();
                        DocKind::Html
                    }
                    Content::Engine => {
                        self.words = 0;
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
                if large || (!matches!(doc.format, FormatKind::Markdown | FormatKind::Html | FormatKind::Csv)
                    && matches!(kind, DocKind::Text { .. }))
                {
                    self.mode = Mode::Source;
                } else if matches!(doc.format, FormatKind::Markdown | FormatKind::Csv) && self.doc.is_none() {
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
                if self.shell.view == rail::LeftView::Cloud {
                    self.shell.panel_open = false;
                }
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
                if self.mode == Mode::Source && matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. })) {
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
                self.refresh_lists();
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
        if !matches!(format, FormatKind::Markdown | FormatKind::Csv) {
            return;
        }
        // Front matter is held aside in the rich view, never shown.
        let body = &text[outline::front_matter_len(text)..];
        self.preview.update(cx, |state, cx| state.set_text(body, cx));
        // (open_path loads the rich editor itself, once the document is set.)
        if self.doc.as_ref().is_some_and(|d| !d.large) && text.len() <= 1_000_000 {
            self.load_rich(text, cx);
        }
    }

    fn update_stats(&mut self, text: &str) {
        let s = stats::compute(text);
        self.words = s.words;
        self.reading_minutes = s.reading_minutes;
        self.sections = outline::sections(text);
    }

    fn on_edit(&mut self, cx: &mut Context<Self>) {
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
        if self.dirty && self.disk_conflict.is_none() {
            self.autosave.note_change(Instant::now());
            self.schedule_autosave(cx);
        }
        cx.notify();
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
        if self.autosave.is_pending() || self.dirty {
            self.autosave.cancel();
            self.autosave_now(cx);
        }
    }

    /// Autosave never opens a dialog: a failure leaves a crash draft and the
    /// edited marker, and the next save tries again.
    fn autosave_now(&mut self, cx: &mut Context<Self>) {
        if matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(_))) {
            // Office files are never written on a timer.
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
        // A CSV writes its first table back as CSV (toDisk).
        let disk_text = csv_doc::to_disk(doc.format, text);
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
            Some(DiskChange::Changed(theirs)) => self.note_disk_change(theirs, cx),
        }
    }

    /// Replace the editor's text with what is on disk, as the saved state.
    fn load_text(&mut self, path: &Path, raw: String, cx: &mut Context<Self>) {
        self.disk.remember(path, &raw, false);
        let text = match &self.doc {
            Some(d) => csv_doc::from_disk(d.format, &raw),
            None => raw,
        };
        if let Some(OpenDoc { kind: DocKind::Text { saved, .. }, format, .. }) = self.doc.as_mut() {
            *saved = text.clone();
            let format = *format;
            self.pending_editor_text = Some(text.clone());
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
        if let Err(err) = self.write_text(&text, cx) {
            window.push_notification(format!("Markie could not save: {err:#}"), cx);
        } else if let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) {
            let _ = self.drafts.discard(&Drafts::key_for(Some(&path)));
            // ⌘S on a .csv keeps the first table only, and says so.
            if self.doc.as_ref().is_some_and(|d| d.format == FormatKind::Csv) {
                if let Some(note) = csv_doc::csv_save_note(&text) {
                    window.push_notification(note, cx);
                }
            }
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
            Editor::new(&self.editor)
                .bordered(false)
                .h(relative(1.))
                .font_family(markie_editor::MONO)
                .text_size(px(14. * self.zoom)),
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
                .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child("Markie RS"))
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
            (DocKind::Office(office), _) => office::render(office, self.zoom, cx),
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
            (DocKind::Text { .. }, Mode::Split) if matches!(doc.format, FormatKind::Markdown | FormatKind::Csv) && !doc.large => self.render_split(cx),
            (DocKind::Text { .. }, Mode::View) if matches!(doc.format, FormatKind::Markdown | FormatKind::Csv) && !doc.large => {
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
            (DocKind::Text { .. }, _) if doc.format == FormatKind::Darkmown && !doc.large => self.render_darkmown(cx),
            (DocKind::Text { .. }, _) if !matches!(doc.format, FormatKind::Markdown | FormatKind::Darkmown) && !doc.large => self.render_text(cx),
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
                    Editor::new(&self.editor)
                        .bordered(false)
                        .h(relative(1.))
                        .font_family(markie_editor::MONO)
                        .text_size(px(14. * self.zoom)),
                    cx,
                ))
                .into_any_element(),
        }
    }

}

/// May `format` show in `mode`? Electron's `requestMode`: large and literal
/// text documents only edit as source; Markdown and CSV also split.
fn mode_allowed(format: FormatKind, large: bool, mode: Mode) -> bool {
    match mode {
        Mode::Source => true,
        Mode::View => !large && matches!(format, FormatKind::Markdown | FormatKind::Csv),
        Mode::Split => !large && matches!(format, FormatKind::Markdown | FormatKind::Csv),
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
        for format in [FormatKind::Markdown, FormatKind::Csv] {
            assert!(!mode_allowed(format, true, Mode::View));
            assert!(!mode_allowed(format, true, Mode::Split));
            assert!(mode_allowed(format, true, Mode::Source));
        }
        assert!(!mode_allowed(FormatKind::Text, false, Mode::View));
        assert!(!mode_allowed(FormatKind::Json, false, Mode::Split));
    }

    #[test]
    fn csv_views_and_splits_like_markdown() {
        // Electron edits a CSV as its Markdown table, so it is not plain text.
        assert!(mode_allowed(FormatKind::Csv, false, Mode::View));
        assert!(mode_allowed(FormatKind::Csv, false, Mode::Split));
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(path) = self.cloud.pending_link.take() {
            self.open_path(&path, window, cx);
        }
        if let Some(text) = self.pending_editor_text.take() {
            self.editor.update(cx, |state, cx| state.set_value(text, window, cx));
        }
        self.ensure_browse_rows();
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
            SidePanel::Stats => Some(self.render_stats(cx).into_any_element()),
            SidePanel::None => None,
        };
        let dialogs = self.render_dialogs(window, cx);
        let root = v_flex()
            .id("workspace")
            .track_focus(&self.focus_handle)
            .key_context("Workspace")
            .map(|d| Self::source_actions(d, cx))
            .on_action(cx.listener(Self::on_open))
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
            // The Library panel's resizer drag follows the pointer anywhere.
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, window, cx| {
                if this.shell.panel_drag.is_some() {
                    this.panel_drag_move(f32::from(ev.position.x), window, cx);
                }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.panel_drag_end(cx)))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.panel_drag_end(cx)))
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" && this.panel_drag_cancel(cx) {
                    cx.stop_propagation();
                } else if ev.keystroke.key == "escape" && this.live_docs.preview.is_some() && !this.dialogs.open.is_open() && !this.shell.search_open {
                    this.close_live_preview(cx);
                    cx.stop_propagation();
                } else if ev.keystroke.key == "escape" && this.shell.row_menu.take().is_some() {
                    cx.notify();
                    cx.stop_propagation();
                }
            }))
            .relative()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.render_title_bar(cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(self.render_rail(cx))
                    .children(self.render_side_panel(cx))
                    .map(|el| {
                        if self.workspace_page_open() {
                            el.child(div().flex_1().min_w_0().h_full().child(self.render_workspace_page(cx)))
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
            .children(self.render_live_preview(cx))
            .children(self.render_row_menu(cx))
            .children(self.render_search(cx))
            .children(self.render_share(window, cx));
        self.dialog_actions(root, cx).children(dialogs)
    }
}
