//! Darkmown `.wd` documents (PARITY.md section 18): the port of
//! `darkmown-document-editor.tsx`.
//!
//! The source is the document; runtime state exists only in the disposable
//! frame. Split is the default view. The preview compiles on every edit in a
//! disposable compiler web view, and shows controls inactive until the person
//! trusts this exact text; any edit revokes trust. Reset state rebuilds the
//! frame from authored defaults. Errors keep the source editable and offer a
//! retry. The frame itself is a wry island (`markie_web::island`).

use std::cell::Cell;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::input::Editor;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use markie_web::darkmown::preview::{ColorScheme, Compiled, PreviewOptions, build_preview, frame_sandbox};
use markie_web::island::{Bounds as IslandBounds, Compiler, DarkmownFrame, PictureScopes};

use super::Workspace;
use crate::themes;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Source,
    Preview,
    Split,
}

const TIME_BUDGET: &str = "Interactive preview exceeded its time budget. The local compiler was stopped; your source remains available to edit and save.";

/// Desktop super-nightly in Electron: pictures beside the file and links to
/// the browser. Off unless `MARKIE_RS_NIGHTLY=1`, as in a stable build.
fn nightly() -> bool {
    std::env::var("MARKIE_RS_NIGHTLY").is_ok_and(|v| v == "1")
}

pub(super) struct DarkmownState {
    pub mode: Mode,
    /// The text hash the person trusted.
    grant: Option<u64>,
    reset: u64,
    frame: Option<Rc<DarkmownFrame>>,
    compiler: Option<(Compiler, Instant, u64)>,
    compiled: Option<(u64, Result<Compiled, String>)>,
    /// What the frame shows: (text, trusted, reset, scheme, picture base).
    shown: Option<(u64, bool, u64, bool, Option<String>)>,
    warnings: Vec<String>,
    error: Option<String>,
    scopes: PictureScopes,
    projected_dark: Option<bool>,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    polling: bool,
    active: bool,
}

impl Default for DarkmownState {
    fn default() -> Self {
        Self {
            mode: Mode::Split,
            grant: None,
            reset: 0,
            frame: None,
            compiler: None,
            compiled: None,
            shown: None,
            warnings: vec![],
            error: None,
            scopes: PictureScopes::default(),
            projected_dark: None,
            bounds: Rc::new(Cell::new(None)),
            polling: false,
            active: false,
        }
    }
}

/// `MARKIE_RS_DEBUG_WD=1` traces compiles and frame updates to stderr.
fn trace(message: impl FnOnce() -> String) {
    if std::env::var("MARKIE_RS_DEBUG_WD").is_ok_and(|v| v == "1") {
        eprintln!("markie-rs wd: {}", message());
    }
}

fn hash(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

fn island_bounds(b: Bounds<Pixels>) -> IslandBounds {
    IslandBounds { x: f32::from(b.origin.x) as f64, y: f32::from(b.origin.y) as f64, width: f32::from(b.size.width) as f64, height: f32::from(b.size.height) as f64 }
}

impl Workspace {
    fn is_darkmown_doc(&self) -> bool {
        self.doc.as_ref().is_some_and(|d| d.format == markie_core::formats::FormatKind::Darkmown && !d.large && matches!(d.kind, super::DocKind::Text { .. }))
    }

    /// Before each render: compile what changed, put the right document in
    /// the frame, and keep the frame hidden whenever it must not be seen
    /// (another document, Source mode, or a GPUI menu that would sit under it).
    pub(super) fn sync_darkmown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted = self.is_darkmown_doc() && self.darkmown.mode != Mode::Source;
        let overlay = self.shell.menu.is_some();
        if !wanted {
            if let Some(frame) = &self.darkmown.frame {
                let _ = frame.set_visible(false);
            }
            if !self.is_darkmown_doc() && self.darkmown.active {
                // Leaving the document drops its runtime state and its trust.
                self.darkmown = DarkmownState::default();
            }
            return;
        }
        self.darkmown.active = true;
        let text = self.current_text(cx);
        let h = hash(&text);
        if self.darkmown.grant.is_some_and(|g| g != h) {
            self.darkmown.grant = None;
        }
        let trusted = self.darkmown.grant == Some(h);
        let dark = themes::palette(cx).dark;

        // Compile the current text, once per text.
        let have = self.darkmown.compiled.as_ref().is_some_and(|(k, _)| *k == h);
        let running = self.darkmown.compiler.as_ref().is_some_and(|(_, _, k)| *k == h);
        if !have && !running {
            match Compiler::start(window, &text) {
                Ok(c) => {
                    trace(|| format!("compile started for {h:x}"));
                    self.darkmown.compiler = Some((c, Instant::now(), h))
                }
                Err(e) => self.darkmown.compiled = Some((h, Err(e))),
            }
        }
        self.poll_compiler(window, cx);

        // The frame, made once per window.
        if self.darkmown.frame.is_none() {
            let start = self.darkmown.bounds.get().map(island_bounds).unwrap_or(IslandBounds { x: 0.0, y: 0.0, width: 1.0, height: 1.0 });
            match DarkmownFrame::new(window, start, self.darkmown.scopes.clone(), |_| {}) {
                Ok(f) => {
                    trace(|| "preview frame created".into());
                    self.darkmown.frame = Some(Rc::new(f))
                }
                Err(e) => self.darkmown.error = Some(format!("The preview could not start: {e}")),
            }
        }
        let Some(frame) = self.darkmown.frame.clone() else { return };
        let _ = frame.set_visible(!overlay && self.darkmown.bounds.get().is_some());

        let links = nightly();
        let picture_base = if nightly() { self.doc.as_ref().and_then(|d| d.path.parent()).and_then(|dir| self.darkmown.scopes.scope_for(dir)) } else { None };
        match self.darkmown.compiled.as_ref().filter(|(k, _)| *k == h).map(|(_, r)| r.clone()) {
            Some(Ok(compiled)) => {
                let key = (h, trusted, self.darkmown.reset, if trusted { false } else { dark }, picture_base.clone());
                if self.darkmown.shown.as_ref() != Some(&key) {
                    let options = PreviewOptions { color_scheme: Some(if dark { ColorScheme::Dark } else { ColorScheme::Light }), links, picture_base };
                    match build_preview(&compiled, trusted, &options) {
                        Ok(preview) => {
                            self.darkmown.warnings = preview.warnings;
                            self.darkmown.error = None;
                            let shown = frame.set_preview(&preview.src_doc, frame_sandbox(trusted, links), dark);
                            trace(|| format!("frame shows {h:x} trusted={trusted} sandbox={:?} warnings={} {:?}", frame_sandbox(trusted, links), self.darkmown.warnings.len(), shown.is_ok()));
                            self.darkmown.projected_dark = Some(dark);
                        }
                        Err(e) => {
                            self.darkmown.error = Some(e);
                            let _ = frame.clear();
                        }
                    }
                    self.darkmown.shown = Some(key);
                }
                // A running trusted frame follows the app's tone by message.
                if trusted && self.darkmown.projected_dark != Some(dark) {
                    let _ = frame.project_theme(dark);
                    self.darkmown.projected_dark = Some(dark);
                }
            }
            Some(Err(e)) => {
                self.darkmown.error = Some(e);
                self.darkmown.warnings.clear();
                if self.darkmown.shown.as_ref().is_some_and(|s| s.0 != h) || self.darkmown.shown.is_some() {
                    let _ = frame.clear();
                    self.darkmown.shown = None;
                }
            }
            None => {}
        }
    }

    /// Takes a finished compile, or times it out. True when nothing is pending.
    fn take_compile(&mut self) -> bool {
        if let Some((compiler, started, h)) = &self.darkmown.compiler {
            if let Some(result) = compiler.take() {
                trace(|| format!("compiled {h:x} in {:?}: {}", started.elapsed(), match &result { Ok(c) => format!("ok, title {:?}, {} bytes", c.title, c.body_html.len()), Err(e) => format!("error {e}") }));
                self.darkmown.compiled = Some((*h, result));
                self.darkmown.compiler = None;
            } else if started.elapsed() > Duration::from_secs(10) {
                trace(|| format!("compile {h:x} timed out"));
                self.darkmown.compiled = Some((*h, Err(TIME_BUDGET.into())));
                self.darkmown.compiler = None;
            }
        }
        self.darkmown.compiler.is_none()
    }

    /// Polls the compiler on its own schedule, not on renders: a window that
    /// is not drawing still finishes its compile.
    fn poll_compiler(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.take_compile() || self.darkmown.polling {
            return;
        }
        self.darkmown.polling = true;
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(30)).await;
                let done = this
                    .update(cx, |this, cx| {
                        let done = this.take_compile();
                        if done {
                            this.darkmown.polling = false;
                            cx.notify();
                        }
                        done
                    })
                    .unwrap_or(true);
                if done {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn darkmown_command(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.darkmown.mode = mode;
        cx.notify();
    }

    fn darkmown_trust(&mut self, cx: &mut Context<Self>) {
        self.darkmown.grant = Some(hash(&self.current_text(cx)));
        cx.notify();
    }

    fn darkmown_revoke(&mut self, cx: &mut Context<Self>) {
        self.darkmown.grant = None;
        cx.notify();
    }

    fn darkmown_reset(&mut self, cx: &mut Context<Self>) {
        self.darkmown.reset += 1;
        // A retry recompiles too.
        if self.darkmown.compiled.as_ref().is_some_and(|(_, r)| r.is_err()) {
            self.darkmown.compiled = None;
        }
        cx.notify();
    }

    /// The panes: the source editor and the preview, side by side in Split.
    pub(super) fn render_darkmown(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
        let state = &self.darkmown;
        let text_hash = hash(&self.current_text(cx));
        let trusted = state.grant == Some(text_hash);
        let source = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(p.background)
            .child(Editor::new(&self.editor).bordered(false).h(relative(1.)).font_family(markie_editor::MONO).text_size(px(14. * self.zoom)));

        let button = |id: &'static str, label: &'static str, primary: bool| {
            div()
                .id(id)
                .px(px(7.))
                .py(px(5.))
                .rounded(px(6.))
                .border_1()
                .border_color(p.border)
                .text_size(px(11.))
                .whitespace_nowrap()
                .cursor_pointer()
                .when(primary, |d| d.bg(p.foreground).text_color(p.background).hover(|s| s.bg(p.muted)))
                .when(!primary, |d| d.bg(p.surface2).text_color(p.foreground).hover(|s| s.bg(p.accent)))
                .child(label)
        };
        let mode_button = |id: &'static str, label: &'static str, mode: Mode| {
            let on = state.mode == mode;
            div()
                .id(id)
                .px(px(7.))
                .py(px(3.))
                .rounded(px(5.))
                .text_size(px(10.))
                .cursor_pointer()
                .text_color(if on { p.foreground } else { p.muted })
                .when(on, |d| d.bg(p.surface2))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| this.darkmown_command(mode, cx)))
        };
        let actions = if trusted {
            h_flex()
                .gap(px(4.))
                .child(button("wd-reset", "Reset state", false).on_click(cx.listener(|this, _, _, cx| this.darkmown_reset(cx))))
                .child(button("wd-revoke", "Revoke trust", false).on_click(cx.listener(|this, _, _, cx| this.darkmown_revoke(cx))))
        } else {
            h_flex().gap(px(4.)).child(button("wd-trust", "Trust this document", true).on_click(cx.listener(|this, _, _, cx| this.darkmown_trust(cx))))
        };
        let header = h_flex()
            .justify_between()
            .gap(px(8.))
            .px(px(14.))
            .pt(px(10.))
            .pb(px(8.))
            .bg(p.surface)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(11.)).line_height(px(17.6)).font_weight(FontWeight::BOLD).text_color(p.foreground).child("Document preview"))
                    .child(div().text_size(px(10.)).line_height(px(16.)).text_color(p.muted).child(if trusted { "Trusted · Edits revoke trust" } else { "Controls inactive" })),
            )
            .child(
                h_flex()
                    .gap(px(2.))
                    .child(mode_button("wd-mode-source", "Source", Mode::Source))
                    .child(mode_button("wd-mode-split", "Split", Mode::Split))
                    .child(mode_button("wd-mode-preview", "Preview", Mode::Preview)),
            )
            .child(actions);
        let security = div()
            .px(px(14.))
            .pb(px(9.))
            .text_size(px(10.))
            .line_height(px(17.))
            .text_color(p.muted)
            .bg(p.surface)
            .border_b_1()
            .border_color(p.border)
            .child(if nightly() {
                "Local state only. Pictures come from this document\u{2019}s folder and links open in your browser. No network, accounts or persistent storage."
            } else {
                "Local state only. No network, files, accounts or persistent storage."
            });
        let bounds = state.bounds.clone();
        let frame = state.frame.clone();
        let waiting = state.compiled.as_ref().is_none_or(|(k, _)| *k != text_hash) && state.error.is_none();
        let body: AnyElement = if let Some(error) = &state.error {
            h_flex()
                .gap(px(12.))
                .px(px(20.))
                .py(px(10.))
                .text_size(px(12.))
                .line_height(px(19.2))
                .text_color(p.red)
                .bg(p.surface)
                .border_b_1()
                .border_color(p.border)
                .child(div().flex_1().child(error.clone()))
                .child(button("wd-retry", "Retry preview", false).on_click(cx.listener(|this, _, _, cx| this.darkmown_reset(cx))))
                .into_any_element()
        } else if waiting {
            div().p(px(30.)).text_color(p.muted).text_size(px(13.)).child("Building document preview…").into_any_element()
        } else {
            canvas(
                move |b, _, _| {
                    bounds.set(Some(b));
                    if let Some(frame) = &frame {
                        let _ = frame.set_bounds(island_bounds(b));
                    }
                },
                |_, _, _, _| {},
            )
            .flex_1()
            .w_full()
            .into_any_element()
        };
        if state.error.is_some() || waiting {
            state.bounds.set(None);
        }
        let preview = v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .border_l_1()
            .border_color(p.border)
            .bg(p.background)
            .child(header)
            .child(security)
            .when(!state.warnings.is_empty(), |d| {
                d.child(
                    div().px(px(14.)).pt(px(10.)).pb(px(9.)).text_size(px(10.)).line_height(px(17.)).text_color(p.foreground).bg(p.surface).border_b_1().border_color(p.border).child(state.warnings.join(" ")),
                )
            })
            .child(body);
        match state.mode {
            Mode::Source => h_flex().size_full().child(source).child(
                // The way back to the preview while the source fills the window.
                div().absolute().top(px(8.)).right(px(12.)).child(
                    h_flex()
                        .gap(px(2.))
                        .p(px(2.))
                        .rounded(px(6.))
                        .bg(p.surface)
                        .border_1()
                        .border_color(p.border)
                        .child(mode_button("wd-mode-source", "Source", Mode::Source))
                        .child(mode_button("wd-mode-split", "Split", Mode::Split))
                        .child(mode_button("wd-mode-preview", "Preview", Mode::Preview)),
                ),
            ),
            Mode::Preview => h_flex().size_full().child(preview),
            Mode::Split => h_flex().size_full().child(source).child(preview),
        }
        .relative()
        .into_any_element()
    }
}

