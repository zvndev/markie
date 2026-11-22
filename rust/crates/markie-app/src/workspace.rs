//! The main window: Library on the left, the open document on the right, a
//! status bar along the bottom. Mirrors the shape of `src/app/page.tsx`.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Editor, EditorState, Input, InputEvent, InputState};
use gpui_kit::component::resizable::{h_resizable, resizable_panel};
use gpui_kit::component::status_bar::StatusBar;
use gpui_kit::component::text::{TextView, TextViewState};
use gpui_kit::component::{
    ActiveTheme, IconName, Selectable as _, Sizable as _, Theme, ThemeMode, TitleBar, WindowExt as _, h_flex,
    v_flex,
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
use crate::library::{Library, LibraryTab};

mod file_ops;
mod office;
mod palette;
mod panels;
mod rich;
mod settings;

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
    pub focus_handle: FocusHandle,
    registry: Option<Rc<Registry>>,
    library: Library,
    search: Entity<InputState>,
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
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    pub fn new(initial: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let registry = Registry::open(&paths::data_dir().join("registry.db"))
            .map(Rc::new)
            .map_err(|e| eprintln!("markie-rs: registry unavailable: {e:#}"))
            .ok();

        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search documents"));
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language("markdown")
                .line_number(true)
                .soft_wrap(true)
                .searchable(true)
        });
        let preview = cx.new(|cx| TextViewState::markdown("", cx).selectable(true));
        let (rich, rich_sub) = Self::new_rich(cx);

        let subscriptions = vec![
            cx.subscribe(&search, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.library.set_text(&text);
                    cx.notify();
                }
            }),
            cx.subscribe(&editor, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.on_edit(cx);
                }
            }),
            rich_sub,
        ];

        let template = registry
            .as_ref()
            .and_then(|r| r.setting("style_template").ok().flatten())
            .unwrap_or_else(|| "markie".into());
        crate::themes::apply(&template, Some(window), cx);
        // The user's own light or dark choice outranks the system appearance.
        match registry.as_ref().and_then(|r| r.setting("color_mode").ok().flatten()).as_deref() {
            Some("dark") => Theme::change(ThemeMode::Dark, Some(window), cx),
            Some("light") => Theme::change(ThemeMode::Light, Some(window), cx),
            _ => {}
        }

        let mut library = Library::default();
        if let Some(snapshot) = registry.as_ref().and_then(|r| r.load_snapshot().ok().flatten()) {
            library.set_snapshot(snapshot);
        }

        let data_dir = paths::data_dir();
        let drafts = Drafts::new(&data_dir);
        let recovered = drafts.pending();
        let mut this = Self {
            focus_handle: cx.focus_handle(),
            registry,
            library,
            search,
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
            zoom: 1.0,
            page_width: 768.0,
            _subscriptions: subscriptions,
        };
        this.start_disk_poll(cx);
        if let Some(reg) = &this.registry {
            if let Some(z) = reg.setting("zoom").ok().flatten().and_then(|v| v.parse().ok()) {
                this.zoom = z;
            }
            if let Some(w) = reg.setting("page_width").ok().flatten().and_then(|v| v.parse().ok()) {
                this.page_width = w;
            }
        }
        this.refresh_lists();
        this.import_once(cx);

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
        self.library.set_lists(recent, starred);
    }

    /// The first launch copies recents, folders and stars from the Electron
    /// app, reading a copy of its registry. It never writes to Markie's data.
    fn import_once(&mut self, cx: &mut Context<Self>) {
        let Some(reg) = &self.registry else { return };
        if reg.setting("electron_import").ok().flatten().is_some() {
            return;
        }
        let _ = reg.set_setting("electron_import", "started");
        self.import_from_markie(cx);
    }

    fn import_from_markie(&mut self, cx: &mut Context<Self>) {
        let Some(source) = markie_core::import::electron_registry_path().filter(|p| p.exists()) else { return };
        let db_path = paths::data_dir().join("registry.db");
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let reg = Registry::open(&db_path)?;
                    markie_core::import::import_from_electron(&source, &reg)
                })
                .await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(summary) => {
                        if let Some(reg) = &this.registry {
                            let _ = reg.set_setting(
                                "electron_import",
                                &format!("{} recents, {} folders, {} stars", summary.recents, summary.roots, summary.stars),
                            );
                        }
                        this.refresh_lists();
                        if summary.roots > 0 {
                            this.rescan(cx);
                        }
                    }
                    Err(e) => eprintln!("markie-rs: import from Markie failed: {e:#}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
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

    fn on_import(&mut self, _: &ImportFromMarkie, _: &mut Window, cx: &mut Context<Self>) {
        self.import_from_markie(cx);
    }

    fn on_toggle_star(&mut self, _: &ToggleStar, _: &mut Window, cx: &mut Context<Self>) {
        let (Some(reg), Some(doc)) = (&self.registry, &self.doc) else { return };
        let _ = reg.toggle_star(&doc.path, "file");
        self.refresh_lists();
        cx.notify();
    }

    fn is_starred(&self) -> bool {
        match (&self.registry, &self.doc) {
            (Some(reg), Some(doc)) => reg.is_starred(&doc.path).unwrap_or(false),
            _ => false,
        }
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
        let opts = ScanOptions::from_env(paths::home_dir(), roots);
        cx.spawn(async move |this, cx| {
            let snapshot = cx.background_spawn(async move { scan(&opts) }).await;
            this.update(cx, |this, cx| {
                if let Some(reg) = &this.registry {
                    let _ = reg.save_snapshot(&snapshot);
                }
                this.library.scanning = false;
                this.library.set_snapshot(snapshot);
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
                        self.editor.update(cx, |state, cx| {
                            state.set_highlighter(language, cx);
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
                                window.push_notification(message, cx);
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
                let title = doc
                    .path
                    .file_name()
                    .map_or_else(|| paths::APP_NAME.to_string(), |n| n.to_string_lossy().into_owned());
                window.set_window_title(&title);
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
        if self.write_text(&text).is_ok() {
            let _ = self.drafts.discard(&Drafts::key_for(Some(&path)));
        }
        cx.notify();
    }

    /// Keep the previous text as a version, write the new text, and remember
    /// that this write was ours.
    fn write_text(&mut self, text: &str) -> anyhow::Result<()> {
        let Some(doc) = self.doc.as_mut() else { return Ok(()) };
        let DocKind::Text { encoding, bom, saved } = &mut doc.kind else { return Ok(()) };
        let _ = self.history.capture(&doc.path, text, Writer::User);
        document::save_text(&doc.path, text, *encoding, *bom)?;
        *saved = text.to_string();
        self.disk.remember(&doc.path, text, true);
        self.dirty = false;
        if self.side == SidePanel::History {
            self.refresh_versions();
        }
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
        if !matches!(doc.kind, DocKind::Text { .. }) || self.disk_conflict.is_some() {
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
            Some(DiskChange::Changed(theirs)) => {
                let path = doc.path.clone();
                if self.dirty {
                    self.disk_conflict = Some(theirs);
                    self.autosave.cancel();
                } else {
                    self.load_text(&path, theirs, cx);
                }
                cx.notify();
            }
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
        if let Err(err) = self.write_text(&text) {
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
        let handle = self.search.read(cx).focus_handle(cx);
        handle.focus(window, cx);
    }

    fn on_rescan(&mut self, _: &Rescan, _: &mut Window, cx: &mut Context<Self>) {
        self.rescan(cx);
    }

    fn on_toggle_theme(&mut self, _: &ToggleTheme, window: &mut Window, cx: &mut Context<Self>) {
        let next = if cx.theme().mode.is_dark() { ThemeMode::Light } else { ThemeMode::Dark };
        Theme::change(next, Some(window), cx);
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("color_mode", if next.is_dark() { "dark" } else { "light" });
        }
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

    fn on_show_history(&mut self, _: &ShowHistory, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_side(SidePanel::History, cx);
        if self.side == SidePanel::History {
            self.refresh_versions();
        }
        cx.notify();
    }

    fn view_version(&mut self, stamp: String, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        if let Some(text) = self.history.read(&doc.path, &stamp) {
            self.viewing_version = Some((stamp, text));
        }
        cx.notify();
    }

    /// Restoring is a save like any other, so the text it replaces becomes a
    /// version too and nothing is lost.
    fn restore_version(&mut self, cx: &mut Context<Self>) {
        let Some((_, text)) = self.viewing_version.take() else { return };
        if self.write_text(&text).is_ok() {
            if let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) {
                self.load_text(&path, text, cx);
            }
        }
        cx.notify();
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
        let text = self.editor.read(cx).value().to_string();
        // History keeps the outside version first, so overwriting loses nothing.
        let _ = self.write_text(&text);
        cx.notify();
    }

    fn restore_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.recovered.first().cloned() else { return };
        let Some(text) = self.drafts.read(&draft.key) else {
            self.recovered.remove(0);
            return;
        };
        if let Some(path) = draft.meta.path.as_deref().map(PathBuf::from) {
            self.open_path(&path, window, cx);
            self.mode = Mode::Source;
            self.pending_editor_text = Some(text);
        }
        self.recovered.remove(0);
        cx.notify();
    }

    fn discard_draft(&mut self, cx: &mut Context<Self>) {
        if !self.recovered.is_empty() {
            let draft = self.recovered.remove(0);
            let _ = self.drafts.discard(&draft.key);
        }
        cx.notify();
    }

    fn render_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.theme();
        let bar = |message: String| {
            h_flex()
                .w_full()
                .px_3()
                .py_1p5()
                .gap_2()
                .bg(theme.warning.opacity(0.15))
                .border_b_1()
                .border_color(theme.border)
                .child(div().flex_1().text_sm().child(message))
        };
        if self.disk_conflict.is_some() {
            return Some(
                bar("This file changed on disk while you were editing.".into())
                    .child(
                        Button::new("take-theirs")
                            .small()
                            .label("Load the disk version")
                            .on_click(cx.listener(|this, _, _, cx| this.take_theirs(cx))),
                    )
                    .child(
                        Button::new("keep-mine")
                            .small()
                            .primary()
                            .label("Keep mine")
                            .on_click(cx.listener(|this, _, _, cx| this.keep_mine(cx))),
                    )
                    .into_any_element(),
            );
        }
        if self.disk_missing {
            return Some(
                bar("This file was moved or deleted. Saving will create it again.".into()).into_any_element(),
            );
        }
        if let Some(draft) = self.recovered.first() {
            let name = draft.meta.name.clone().unwrap_or_else(|| "an untitled document".into());
            return Some(
                bar(format!("Markie kept unsaved text from {name}."))
                    .child(
                        Button::new("draft-restore")
                            .small()
                            .primary()
                            .label("Restore")
                            .on_click(cx.listener(|this, _, window, cx| this.restore_draft(window, cx))),
                    )
                    .child(
                        Button::new("draft-discard")
                            .small()
                            .label("Discard")
                            .on_click(cx.listener(|this, _, _, cx| this.discard_draft(cx))),
                    )
                    .into_any_element(),
            );
        }
        None
    }

    fn render_history(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let viewing = self.viewing_version.as_ref().map(|(s, _)| s.clone());
        v_flex()
            .size_full()
            .bg(theme.sidebar)
            .border_l_1()
            .border_color(theme.sidebar_border)
            .child(
                h_flex()
                    .p_2()
                    .justify_between()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Version history"))
                    .child(
                        Button::new("history-close")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowHistory), cx)),
                    ),
            )
            .when(self.versions.is_empty(), |el| {
                el.child(
                    div()
                        .px_3()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("No versions yet. Markie keeps one every time this file is saved."),
                )
            })
            .child(
                v_flex()
                    .id("versions")
                    .flex_1()
                    .overflow_y_scroll()
                    .children(self.versions.iter().map(|v| {
                        let stamp = v.stamp.clone();
                        let when = v
                            .ms
                            .and_then(chrono::DateTime::from_timestamp_millis)
                            .map(|d| d.with_timezone(&chrono::Local).format("%b %-d, %-I:%M %p").to_string())
                            .unwrap_or_else(|| v.stamp.clone());
                        let who = match (v.meta.author.as_str(), v.meta.agent.as_deref()) {
                            ("agent", Some(agent)) if !agent.is_empty() => agent.to_string(),
                            ("external", _) => "Outside edit".into(),
                            ("user", _) => "You".into(),
                            _ => "Unknown".into(),
                        };
                        let active = viewing.as_deref() == Some(v.stamp.as_str());
                        div()
                            .id(SharedString::from(format!("v-{}", v.stamp)))
                            .px_3()
                            .py_1()
                            .cursor_pointer()
                            .when(active, |el| el.bg(theme.list_active))
                            .hover(|el| el.bg(theme.list_hover))
                            .on_click(cx.listener(move |this, _, _, cx| this.view_version(stamp.clone(), cx)))
                            .child(div().text_sm().child(v.meta.name.clone().unwrap_or(when)))
                            .child(div().text_xs().text_color(theme.muted_foreground).child(who))
                    })),
            )
            .when(viewing.is_some(), |el| {
                el.child(
                    h_flex().p_2().gap_2().child(
                        Button::new("restore-version")
                            .small()
                            .primary()
                            .label("Restore this version")
                            .on_click(cx.listener(|this, _, _, cx| this.restore_version(cx))),
                    ),
                )
            })
    }

    // ---------------------------------------------------------------- render

    fn render_title_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let name = self
            .doc
            .as_ref()
            .and_then(|d| d.path.file_name())
            .map_or_else(|| "No document".to_string(), |n| n.to_string_lossy().into_owned());
        let is_md = self
            .doc
            .as_ref()
            .is_some_and(|d| matches!(d.format, FormatKind::Markdown | FormatKind::Csv) && !d.large);
        TitleBar::new().child(
            h_flex()
                .w_full()
                .pr_2()
                .justify_between()
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Markie RS"))
                        .child(div().text_sm().text_color(cx.theme().muted_foreground).child(name))
                        .when(self.dirty, |el| {
                            el.child(div().size(px(7.)).rounded_full().bg(cx.theme().warning))
                        }),
                )
                .child(
                    h_flex()
                        .gap_1()
                        .when(is_md, |el| {
                            el.child(
                                Button::new("mode-view")
                                    .ghost()
                                    .small()
                                    .label("View")
                                    .selected(self.mode == Mode::View)
                                    .on_click(cx.listener(|this, _, window, cx| this.set_mode(Mode::View, window, cx))),
                            )
                            .child(
                                Button::new("mode-source")
                                    .ghost()
                                    .small()
                                    .label("Source")
                                    .selected(self.mode == Mode::Source)
                                    .on_click(cx.listener(|this, _, window, cx| this.set_mode(Mode::Source, window, cx))),
                            )
                        })
                        .when(self.doc.is_some(), |el| {
                            el.child(
                                Button::new("star")
                                    .ghost()
                                    .small()
                                    .icon(if self.is_starred() { IconName::StarFill } else { IconName::Star })
                                    .tooltip("Star")
                                    .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleStar), cx)),
                            )
                        })
                        .child(
                            Button::new("theme")
                                .ghost()
                                .small()
                                .icon(if cx.theme().mode.is_dark() { IconName::Sun } else { IconName::Moon })
                                .tooltip("Toggle dark mode")
                                .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleTheme), cx)),
                        ),
                ),
        )
    }

    fn render_library(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let counts = self.library.format_counts();
        let shown = self.library.hits().len();
        let summary = if self.library.scanning && self.library.total() == 0 {
            "Finding documents…".to_string()
        } else {
            let mut s = format!("{shown} of {} documents", self.library.total());
            if self.library.scanning {
                s.push_str(" · scanning");
            } else if self.library.truncated {
                s.push_str(" · partial scan");
            }
            s
        };
        let current = self.doc.as_ref().map(|d| d.path.clone());

        v_flex()
            .size_full()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(theme.sidebar_border)
            .child(
                v_flex()
                    .p_2()
                    .gap_2()
                    .child(h_flex().gap_1().children([
                        (LibraryTab::All, "All documents"),
                        (LibraryTab::Recent, "Recent"),
                        (LibraryTab::Starred, "Starred"),
                    ]
                    .into_iter()
                    .map(|(tab, label)| {
                        Button::new(SharedString::from(format!("tab-{label}")))
                            .small()
                            .ghost()
                            .label(label)
                            .selected(self.library.tab == tab)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.library.set_tab(tab);
                                cx.notify();
                            }))
                    })))
                    .child(Input::new(&self.search).small().cleanable(true).prefix(IconName::Search))
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_1()
                            .child(
                                Button::new("fmt-all")
                                    .xsmall()
                                    .ghost()
                                    .label("All")
                                    .selected(!self.library.has_filters())
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.library.clear_formats();
                                        cx.notify();
                                    })),
                            )
                            .children(counts.into_iter().map(|(kind, n)| {
                                Button::new(SharedString::from(format!("fmt-{kind:?}")))
                                    .xsmall()
                                    .ghost()
                                    .label(format!("{} {n}", kind.label()))
                                    .selected(self.library.is_filtered(kind))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.library.toggle_format(kind);
                                        cx.notify();
                                    }))
                            })),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(summary)),
            )
            .child(
                uniform_list(
                    "library-list",
                    shown,
                    cx.processor(move |this, range: std::ops::Range<usize>, _window, cx| {
                        let theme = cx.theme().clone();
                        range
                            .map(|ix| {
                                let hit = this.library.hits()[ix].clone();
                                let doc = this.library.doc(&hit).clone();
                                let active = current.as_ref() == Some(&doc.path);
                                let detail: SharedString = hit
                                    .excerpt
                                    .clone()
                                    .unwrap_or_else(|| short_dir(&doc.dir))
                                    .into();
                                let path = doc.path.clone();
                                div()
                                    .id(SharedString::from(doc.path.to_string_lossy().into_owned()))
                                    .w_full()
                                    .px_3()
                                    .py_1()
                                    .cursor_pointer()
                                    .when(active, |el| el.bg(theme.list_active))
                                    .hover(|el| el.bg(theme.list_hover))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_path(&path, window, cx);
                                    }))
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .overflow_hidden()
                                                    .text_ellipsis()
                                                    .whitespace_nowrap()
                                                    .text_sm()
                                                    .child(doc.name.clone()),
                                            )
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(theme.muted_foreground)
                                                    .child(doc.format.label()),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .overflow_hidden()
                                            .text_ellipsis()
                                            .whitespace_nowrap()
                                            .text_color(theme.muted_foreground)
                                            .child(detail),
                                    )
                            })
                            .collect::<Vec<_>>()
                    }),
                )
                .flex_1(),
            )
    }

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
                let path = doc.path.clone();
                v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .bg(theme.background)
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(format!("{} document", doc.format.label())),
                    )
                    .child(
                        div()
                            .max_w(px(420.))
                            .text_sm()
                            .text_center()
                            .text_color(theme.muted_foreground)
                            .child(
                                "The native Office engine is Phase 4 of the Rust port. \
                                 Until then this build opens the file in its own app.",
                            ),
                    )
                    .child(
                        Button::new("open-system")
                            .label("Open in default app")
                            .on_click(move |_, _, cx| cx.open_with_system(&path)),
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
            _ => div()
                .size_full()
                .bg(theme.background)
                .child(
                    Editor::new(&self.editor)
                        .bordered(false)
                        .h(relative(1.))
                        .font_family(theme.mono_font_family.clone())
                        .text_size(theme.mono_font_size * self.zoom),
                )
                .into_any_element(),
        }
    }

    fn render_status(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (left, right) = match &self.doc {
            None => (String::new(), String::new()),
            Some(doc) => {
                let state = match &doc.kind {
                    DocKind::Text { .. } if self.dirty => "Edited",
                    DocKind::Text { .. } => "Saved",
                    DocKind::Office(office) => office.status(cx),
                    _ => "Read only",
                };
                let mut right = String::new();
                if let (FormatKind::Csv, Some(rows)) = (doc.format, &self.csv_rows) {
                    right = format!("{} · ", plural(rows.len().saturating_sub(1), "row"));
                } else if matches!(doc.kind, DocKind::Text { .. }) {
                    right = format!("{} · {} min read · ", plural(self.words, "word"), self.reading_minutes);
                    if !self.sections.is_empty() {
                        right = format!("{} · {right}", plural(self.sections.len(), "section"));
                    }
                }
                if doc.large {
                    right.push_str("Large file, Source only · ");
                }
                if (self.zoom - 1.0).abs() > 0.01 {
                    right.push_str(&format!("{}% · ", (self.zoom * 100.0).round()));
                }
                right.push_str(state);
                (format!("{} · {}", doc.format.label(), short_dir(&doc.path)), right)
            }
        };
        StatusBar::new()
            .left(div().text_xs().text_color(theme.muted_foreground).child(left))
            .right(div().text_xs().text_color(theme.muted_foreground).child(right))
    }
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 { format!("1 {word}") } else { format!("{n} {word}s") }
}

/// `~/Notes/plan.md` instead of the full home path.
fn short_dir(path: &Path) -> String {
    let home = paths::home_dir();
    match path.strip_prefix(&home) {
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => path.display().to_string(),
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(text) = self.pending_editor_text.take() {
            self.editor.update(cx, |state, cx| state.set_value(text, window, cx));
        }
        let banner = self.render_banner(cx);
        let history = match self.side {
            SidePanel::History => Some(self.render_history(cx).into_any_element()),
            SidePanel::Outline => Some(self.render_outline(cx).into_any_element()),
            SidePanel::Stats => Some(self.render_stats(cx).into_any_element()),
            SidePanel::None => None,
        };
        v_flex()
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
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.render_title_bar(cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(
                        div().flex_1().h_full().overflow_hidden().child(
                            h_resizable("main")
                                .child(
                                    resizable_panel()
                                        .size(px(300.))
                                        .size_range(px(220.)..px(520.))
                                        .child(self.render_library(cx)),
                                )
                                .child(resizable_panel().child(
                                    v_flex()
                                        .size_full()
                                        .children(banner)
                                        .child(div().flex_1().min_h_0().overflow_hidden().child(self.render_document(cx))),
                                )),
                        ),
                    )
                    .children(history.map(|h| div().w(px(300.)).h_full().flex_none().child(h))),
            )
            .child(self.render_status(cx))
    }
}
