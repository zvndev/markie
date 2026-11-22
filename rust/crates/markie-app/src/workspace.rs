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
mod chrome;
mod collab;
mod comments;
mod share;
mod dialog_chrome;
mod file_ops;
mod history_dialog;
mod cloud;
mod cloud_office;
mod cloud_resources;
mod cloud_ui;
mod office;
mod overlay;
mod palette;
mod panels;
mod rail;
mod rich;
mod text_view;
mod settings;
mod shortcuts;
mod strips;
mod skills;
pub(crate) mod vault;

/// The panel on the right of the document.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SidePanel {
    None,
    History,
    Outline,
    Stats,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    View,
    Source,
}

/// The document in the pane, and how to write it back.
struct OpenDoc {
    path: PathBuf,
    format: FormatKind,
    /// Over 1 MB: Source only, like the Electron app.
    large: bool,
    kind: DocKind,
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
    editor: Entity<EditorState>,
    preview: Entity<TextViewState>,
    /// View mode for Markdown: the native rich editor.
    rich: Entity<markie_editor::RichView>,
    doc: Option<OpenDoc>,
    mode: Mode,
    dirty: bool,
    words: usize,
    reading_minutes: usize,
    sections: Vec<outline::Section>,
    history: History,
    drafts: Drafts,
    disk: DiskMemory,
    autosave: Autosave,
    _autosave_task: Task<()>,
    _poll_task: Task<()>,
    /// What the file says on disk when it changed under unsaved edits.
    disk_conflict: Option<String>,
    disk_missing: bool,
    /// Unsaved text recovered from a crash, offered once at launch.
    recovered: Vec<Draft>,
    /// The version history panel, and the version being looked at.
    side: SidePanel,
    /// Parsed rows when a CSV document is shown as a table.
    csv_rows: Option<Rc<Vec<Vec<String>>>>,
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
        let cloud_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search cloud documents"));
        let (rich, rich_sub) = Self::new_rich(cx);

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

        let template = registry
            .as_ref()
            .and_then(|r| r.setting("style_template").ok().flatten())
            .unwrap_or_else(|| "markie".into());
        crate::themes::apply(&template, Some(window), cx);
        // The user's own light or dark choice outranks the system appearance;
        // System follows macOS, also when it changes while the app runs.
        let color_mode =
            chrome::ColorMode::parse(registry.as_ref().and_then(|r| r.setting("color_mode").ok().flatten()).as_deref());
        chrome::apply_color_mode(color_mode, window, cx);
        subscriptions.push(cx.observe_window_appearance(window, |this, window, cx| this.on_appearance_changed(window, cx)));
        let (shell, shell_subs) = rail::Shell::new(color_mode, template, window, cx);
        subscriptions.extend(shell_subs);

        let mut library = Library::default();
        if let Some(snapshot) = registry.as_ref().and_then(|r| r.load_snapshot().ok().flatten()) {
            library.set_snapshot(snapshot);
        }

        let data_dir = paths::data_dir();
        let drafts = Drafts::new(&data_dir);
        let recovered = drafts.pending();
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
            editor,
            preview,
            rich,
            doc: None,
            mode: Mode::View,
            dirty: false,
            words: 0,
            reading_minutes: 0,
            sections: Vec::new(),
            history: History::new(&data_dir),
            drafts,
            disk: DiskMemory::default(),
            autosave: Autosave::default(),
            _autosave_task: Task::ready(()),
            _poll_task: Task::ready(()),
            disk_conflict: None,
            disk_missing: false,
            recovered,
            side: SidePanel::None,
            csv_rows: None,
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
        this.refresh_lists();

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
        if let Some(path) = first_file.or_else(|| this.most_recent()) {
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
        if self.dirty || matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(o)) if o.is_dirty(cx)) {
            self.save(window, cx);
        }
        match document::open(path) {
            Ok(doc) => {
                let large = doc.is_large();
                let kind = match doc.content {
                    Content::Text { text, encoding, bom } => {
                        let language = doc.format.editor_language();
                        // Electron shows literal text formats in a plain field:
                        // no syntax colors and no line numbers.
                        let literal = !matches!(doc.format, FormatKind::Markdown | FormatKind::Darkmown) && !large;
                        self.editor.update(cx, |state, cx| {
                            state.set_highlighter(if literal { "text" } else { language }, cx);
                            state.set_line_number(!literal, window, cx);
                            state.set_value(text.clone(), window, cx);
                        });
                        self.set_preview(&text, doc.format, cx);
                        self.update_stats(&text);
                        self.disk.remember(&doc.path, &text, false);
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
                self.csv_rows = None;
                if large || (!matches!(doc.format, FormatKind::Markdown | FormatKind::Html | FormatKind::Csv)
                    && matches!(kind, DocKind::Text { .. }))
                {
                    self.mode = Mode::Source;
                } else if matches!(doc.format, FormatKind::Markdown | FormatKind::Csv) && self.doc.is_none() {
                    self.mode = Mode::View;
                }
                if let DocKind::Text { saved, .. } = &kind {
                    if doc.format == FormatKind::Csv && !large {
                        self.csv_rows = Some(Rc::new(markie_core::csv::parse(saved)));
                    }
                }
                if let Some(old) = &self.doc {
                    self.disk.forget(&old.path);
                }
                self.doc = Some(OpenDoc { path: doc.path.clone(), format: doc.format, large, kind });
                if self.shell.view == rail::LeftView::Cloud {
                    self.shell.panel_open = false;
                }
                self.dirty = false;
                self.autosave.cancel();
                self.disk_conflict = None;
                self.disk_missing = false;
                self.viewing_version = None;
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
        if format == FormatKind::Csv {
            self.csv_rows = Some(Rc::new(markie_core::csv::parse(text)));
            return;
        }
        if format != FormatKind::Markdown {
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
        self.live_source_edit(cx);
        let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = &self.doc else { return };
        let text = self.editor.read(cx).value().to_string();
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

    /// Autosave never opens a dialog: a failure leaves a crash draft and the
    /// edited marker, and the next save tries again.
    fn autosave_now(&mut self, cx: &mut Context<Self>) {
        let text = self.current_text(cx);
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
        let DocKind::Text { encoding, bom, saved } = &mut doc.kind else { return Ok(()) };
        let _ = self.history.capture(&doc.path, text, Writer::User);
        document::save_text(&doc.path, text, *encoding, *bom)?;
        *saved = text.to_string();
        self.disk.remember(&doc.path, text, true);
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
        if !matches!(doc.kind, DocKind::Text { .. }) {
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
    fn load_text(&mut self, path: &Path, text: String, cx: &mut Context<Self>) {
        self.disk.remember(path, &text, false);
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
        if let Some(OpenDoc { path, kind: DocKind::Office(office), .. }) = &self.doc {
            office::save(office, path, window, cx);
            cx.notify();
            return;
        }
        let text = self.current_text(cx);
        self.autosave.cancel();
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

    fn toggle_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        if !matches!(doc.format, FormatKind::Markdown | FormatKind::Csv) || doc.large {
            return;
        }
        let format = doc.format;
        self.mode = match self.mode {
            Mode::View => {
                if self.rich_active() {
                    self.rich_to_source(window, cx);
                }
                self.focus_editor(window, cx);
                Mode::Source
            }
            Mode::Source => {
                let text = self.editor.read(cx).value().to_string();
                self.set_preview(&text, format, cx);
                self.mode = Mode::View;
                if self.rich_active() {
                    self.focus_rich(window, cx);
                }
                Mode::View
            }
        };
        cx.notify();
    }

    fn set_mode(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        if self.mode != mode {
            self.toggle_mode(window, cx);
        }
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

    fn render_document(&self, cx: &mut Context<Self>) -> AnyElement {
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
            (DocKind::Text { .. }, Mode::View) if doc.format == FormatKind::Csv => self.render_csv(cx),
            (DocKind::Text { .. }, Mode::View) if doc.format == FormatKind::Markdown && !doc.large => {
                self.sync_rich_appearance(cx);
                div().size_full().child(self.rich.clone()).into_any_element()
            }
            (DocKind::Html, _) | (DocKind::Text { .. }, Mode::View) if doc.format == FormatKind::Markdown || matches!(doc.kind, DocKind::Html) => {
                div()
                    .size_full()
                    .bg(theme.background)
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
                .child(
                    Editor::new(&self.editor)
                        .bordered(false)
                        .h(relative(1.))
                        .font_family(markie_editor::MONO)
                        .text_size(px(14. * self.zoom)),
                )
                .into_any_element(),
        }
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
            .on_action(cx.listener(Self::on_open))
            .on_action(cx.listener(Self::on_open_folder))
            .on_action(cx.listener(Self::on_new))
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
            .children(self.render_search(cx))
            .children(self.render_share(window, cx));
        self.dialog_actions(root, cx).children(dialogs)
    }
}
