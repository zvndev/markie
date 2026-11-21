//! The main window: Library on the left, the open document on the right, a
//! status bar along the bottom. Mirrors the shape of `src/app/page.tsx`.

use std::path::{Path, PathBuf};
use std::rc::Rc;

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

use markie_core::document::{self, Content};
use markie_core::formats::{FormatKind, TextEncoding};
use markie_core::index::{ScanOptions, scan};
use markie_core::registry::Registry;
use markie_core::{outline, paths, stats};

use crate::actions::*;
use crate::library::Library;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    View,
    Source,
}

/// The document in the pane, and how to write it back.
struct OpenDoc {
    path: PathBuf,
    format: FormatKind,
    kind: DocKind,
}

enum DocKind {
    Text { encoding: TextEncoding, bom: bool, saved: String },
    /// Office formats: shown with a placeholder until the engine port lands.
    Engine,
    Html,
}

pub struct Workspace {
    pub focus_handle: FocusHandle,
    registry: Option<Rc<Registry>>,
    library: Library,
    search: Entity<InputState>,
    editor: Entity<EditorState>,
    preview: Entity<TextViewState>,
    doc: Option<OpenDoc>,
    mode: Mode,
    dirty: bool,
    words: usize,
    reading_minutes: usize,
    sections: Vec<outline::Section>,
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
        ];

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

        let mut this = Self {
            focus_handle: cx.focus_handle(),
            registry,
            library,
            search,
            editor,
            preview,
            doc: None,
            mode: Mode::View,
            dirty: false,
            words: 0,
            reading_minutes: 0,
            sections: Vec::new(),
            _subscriptions: subscriptions,
        };

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

    fn open_path(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        if self.dirty {
            self.save(window, cx);
        }
        match document::open(path) {
            Ok(doc) => {
                let kind = match doc.content {
                    Content::Text { text, encoding, bom } => {
                        let language = doc.format.editor_language();
                        self.editor.update(cx, |state, cx| {
                            state.set_highlighter(language, cx);
                            state.set_value(text.clone(), window, cx);
                        });
                        self.set_preview(&text, doc.format, cx);
                        self.update_stats(&text);
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
                        DocKind::Engine
                    }
                };
                if !matches!(doc.format, FormatKind::Markdown | FormatKind::Html)
                    && matches!(kind, DocKind::Text { .. })
                {
                    self.mode = Mode::Source;
                } else if doc.format == FormatKind::Markdown && self.doc.is_none() {
                    self.mode = Mode::View;
                }
                self.doc = Some(OpenDoc { path: doc.path.clone(), format: doc.format, kind });
                self.dirty = false;
                if self.mode == Mode::Source && matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. })) {
                    self.focus_editor(window, cx);
                }
                if let Some(reg) = &self.registry {
                    let _ = reg.track_opened(&doc.path);
                }
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
        if format != FormatKind::Markdown {
            return;
        }
        // Front matter is held aside in the rich view, never shown.
        let body = &text[outline::front_matter_len(text)..];
        self.preview.update(cx, |state, cx| state.set_text(body, cx));
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
        cx.notify();
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        let Some(doc) = self.doc.as_mut() else { return };
        let DocKind::Text { encoding, bom, saved } = &mut doc.kind else { return };
        match document::save_text(&doc.path, &text, *encoding, *bom) {
            Ok(()) => {
                *saved = text;
                self.dirty = false;
            }
            Err(err) => window.push_notification(format!("Markie could not save: {err:#}"), cx),
        }
        cx.notify();
    }

    fn focus_editor(&self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = self.editor.read(cx).focus_handle(cx);
        handle.focus(window, cx);
    }

    fn toggle_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        if doc.format != FormatKind::Markdown {
            return;
        }
        self.mode = match self.mode {
            Mode::View => {
                self.focus_editor(window, cx);
                Mode::Source
            }
            Mode::Source => {
                let text = self.editor.read(cx).value().to_string();
                self.set_preview(&text, FormatKind::Markdown, cx);
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

    fn on_new(&mut self, _: &NewDocument, window: &mut Window, cx: &mut Context<Self>) {
        let dir = self
            .registry
            .as_ref()
            .and_then(|r| r.roots().ok())
            .and_then(|r| r.into_iter().next())
            .unwrap_or_else(|| paths::home_dir().join("Documents"));
        let suggested = document::untitled_path(&dir, "md");
        let name = suggested.file_name().map(|n| n.to_string_lossy().into_owned());
        let rx = cx.prompt_for_new_path(&dir, name.as_deref());
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(path))) = rx.await {
                if std::fs::write(&path, "").is_ok() {
                    this.update_in(cx, |this, window, cx| {
                        this.mode = Mode::Source;
                        this.open_path(&path, window, cx);
                        this.rescan(cx);
                    })
                    .ok();
                }
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

    // ---------------------------------------------------------------- render

    fn render_title_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let name = self
            .doc
            .as_ref()
            .and_then(|d| d.path.file_name())
            .map_or_else(|| "No document".to_string(), |n| n.to_string_lossy().into_owned());
        let is_md = self.doc.as_ref().is_some_and(|d| d.format == FormatKind::Markdown);
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

        match (&doc.kind, self.mode) {
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
            (DocKind::Html, _) | (DocKind::Text { .. }, Mode::View) if doc.format == FormatKind::Markdown || matches!(doc.kind, DocKind::Html) => {
                div()
                    .size_full()
                    .bg(theme.background)
                    .child(
                        TextView::new(&self.preview)
                            .scrollable(true)
                            .selectable(true)
                            .size_full()
                            .px(px(56.))
                            .py(px(32.)),
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
                        .text_size(theme.mono_font_size),
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
                    _ => "Read only",
                };
                let mut right = String::new();
                if matches!(doc.kind, DocKind::Text { .. }) {
                    right = format!("{} words · {} min read · ", self.words, self.reading_minutes);
                    if !self.sections.is_empty() {
                        right = format!("{} sections · {right}", self.sections.len());
                    }
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.render_title_bar(cx))
            .child(
                div().flex_1().overflow_hidden().child(
                    h_resizable("main")
                        .child(
                            resizable_panel()
                                .size(px(300.))
                                .size_range(px(220.)..px(520.))
                                .child(self.render_library(cx)),
                        )
                        .child(resizable_panel().child(self.render_document(cx))),
                ),
            )
            .child(self.render_status(cx))
    }
}
