//! The window chrome: the 40px title bar of `src/components/toolbar.tsx`,
//! its Export and theme menus, the System/Light/Dark switch, and the small
//! drawing helpers the activity rail and side panels share.
//!
//! Sizes and colours come from the Electron source: `toolbar.tsx` for the
//! layout and `src/app/globals.css` (`.markie-toolbar`, `.markie-toolbar-action`,
//! `.markie-segmented-*`, `.markie-menu-*`) for the surfaces.

use std::time::{Duration, Instant};

use gpui_kit::component::{Theme, ThemeMode, TitleBar, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::formats::FormatKind;

use super::{DocKind, Workspace};
use crate::actions::*;
use crate::themes::{self, Palette, mix};

pub(super) const TITLE_BAR_HEIGHT: f32 = 40.;

/// Electron's `ColorMode` (`src/lib/color-mode.ts`), stored in `color_mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ColorMode {
    System,
    Light,
    Dark,
}

impl ColorMode {
    pub(super) fn parse(value: Option<&str>) -> Self {
        match value {
            Some("light") => ColorMode::Light,
            Some("dark") => ColorMode::Dark,
            _ => ColorMode::System,
        }
    }

    fn key(self) -> &'static str {
        match self {
            ColorMode::System => "system",
            ColorMode::Light => "light",
            ColorMode::Dark => "dark",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ChromeMenu {
    Export,
    Theme,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CopyState {
    Idle,
    Copied,
}

/// The Export menu's targets are `export.rs`'s kinds.
use super::export::ExportKind as ExportTarget;

// ------------------------------------------------------------------ helpers

/// A one-colour icon from `crate::icons` (or a Lucide name), `size` px square.
pub(super) fn icon(path: &'static str, size: f32, color: Hsla) -> Svg {
    svg().path(path).size(px(size)).flex_none().text_color(color)
}

/// The press never reaches the title bar, so a click on a control does not
/// start a window drag.
pub(super) fn no_drag<E: InteractiveElement>(el: E) -> E {
    el.on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
}

/// `.markie-toolbar-action:hover` and `.markie-rail-button:hover` fills.
pub(super) fn hover_fill(p: &Palette) -> Hsla {
    if p.dark { p.accent.opacity(0.52) } else { p.fg(0.06) }
}

/// The menu row hover (`.markie-menu-item:hover`).
fn menu_hover(p: &Palette) -> Hsla {
    if p.dark { p.accent.opacity(0.72) } else { p.fg(0.06) }
}

/// `.markie-menu-panel`: the popover surface.
pub(super) fn menu_panel(p: &Palette) -> Div {
    let bg = if p.dark { p.surface2 } else { mix(p.background, p.surface2, 0.58) };
    let border = if p.dark { p.border } else { p.border.opacity(0.6) };
    div()
        .bg(bg)
        .border_1()
        .border_color(border)
        .rounded(px(8.))
        .shadow(vec![BoxShadow {
            color: hsla(0., 0., 0., if p.dark { 0.22 } else { 0.11 }),
            offset: point(px(0.), px(if p.dark { 10. } else { 8. })),
            blur_radius: px(if p.dark { 24. } else { 22. }),
            spread_radius: px(0.),
            inset: false,
        }])
}

/// `.markie-segmented-control` and its options.
pub(super) fn segmented(p: &Palette) -> Div {
    let (bg, border) = if p.dark {
        (mix(p.background, p.surface, 0.78), p.border.opacity(0.88))
    } else {
        (mix(p.foreground, p.surface, 0.09), transparent_black())
    };
    h_flex().gap(px(2.)).p(px(2.)).rounded(px(9.)).border_1().border_color(border).bg(bg)
}

pub(super) fn segment_on(p: &Palette) -> Hsla {
    if p.dark { p.accent } else { p.background }
}

/// A thin vertical rule, `w-px h-4 bg-border`.
pub(super) fn vrule(p: &Palette) -> Div {
    div().w(px(1.)).h(px(16.)).flex_none().bg(p.border)
}

// ---------------------------------------------------------------- workspace

/// The room between the traffic lights' 82pt and the 16pt right margin.
fn title_bar_content_width(viewport: f32) -> f32 {
    (viewport - 82. - 16.).max(0.)
}

/// Below this the title bar drops the wordmark.
fn title_bar_narrow(viewport: f32) -> bool {
    viewport < 900.
}

#[cfg(test)]
mod title_bar_tests {
    #[test]
    fn the_title_bar_fits_the_window_and_drops_the_wordmark_when_narrow() {
        assert_eq!(super::title_bar_content_width(1280.), 1280. - 98.);
        assert_eq!(super::title_bar_content_width(40.), 0.);
        assert!(super::title_bar_narrow(760.));
        assert!(!super::title_bar_narrow(1280.));
    }
}

impl Workspace {
    /// Apply and remember a colour mode. System follows macOS from here on,
    /// including changes while Markie RS runs (see `on_appearance_changed`).
    pub(super) fn pick_color_mode(&mut self, mode: ColorMode, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.color_mode = mode;
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("color_mode", mode.key());
        }
        apply_color_mode(mode, window, cx);
        cx.notify();
    }

    /// macOS switched light or dark. Read the stored mode again, so a choice
    /// made in Settings is honoured too.
    pub(super) fn on_appearance_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let stored = self.registry.as_ref().and_then(|r| r.setting("color_mode").ok().flatten());
        self.shell.color_mode = ColorMode::parse(stored.as_deref());
        if self.shell.color_mode == ColorMode::System {
            Theme::sync_system_appearance(Some(window), cx);
        }
        cx.notify();
    }

    pub(super) fn on_toggle_theme(&mut self, _: &ToggleTheme, window: &mut Window, cx: &mut Context<Self>) {
        let next = if Theme::global(cx).mode.is_dark() { ColorMode::Light } else { ColorMode::Dark };
        self.pick_color_mode(next, window, cx);
    }

    fn pick_template(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("style_template", id);
        }
        themes::apply(id, Some(window), cx);
        self.theme_changed(cx);
        self.shell.template = id.to_string();
        self.shell.menu = None;
        cx.notify();
    }

    fn toggle_menu(&mut self, menu: ChromeMenu, cx: &mut Context<Self>) {
        // The press that closed this menu (outside its panel) was on its own
        // trigger: leave it closed.
        if let Some((closed, at)) = self.shell.menu_closed.take() {
            if closed == menu && at.elapsed() < Duration::from_millis(250) {
                return;
            }
        }
        self.shell.menu = if self.shell.menu == Some(menu) { None } else { Some(menu) };
        cx.notify();
    }

    fn close_menu(&mut self, cx: &mut Context<Self>) {
        if let Some(menu) = self.shell.menu.take() {
            self.shell.menu_closed = Some((menu, Instant::now()));
            cx.notify();
        }
    }

    // The Share button opens `open_share` (share.rs): the share sheet for a
    // document with a cloud copy, else the sync opt-in or an Office snapshot.

    pub(super) fn copy_all(&mut self, cx: &mut Context<Self>) {
        let text = self.current_text(cx);
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.shell.copied = CopyState::Copied;
        self.shell._copy_task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            this.update(cx, |this, cx| {
                this.shell.copied = CopyState::Idle;
                cx.notify();
            })
            .ok();
        });
        cx.notify();
    }

    /// "Save a Copy…": the document as it stands, written somewhere else.
    pub(super) fn save_a_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.menu = None;
        let Some(doc) = &self.doc else { return };
        let dir = self.default_dir();
        let name = doc.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let source = doc.path.clone();
        let text = matches!(doc.kind, DocKind::Text { .. }).then(|| self.current_text(cx));
        let from_csv = self.is_csv_doc();
        let rx = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn_in(window, async move |_, cx| {
            if let Ok(Ok(Some(target))) = rx.await {
                let as_csv = target.extension().is_some_and(|e| e.eq_ignore_ascii_case("csv") || e.eq_ignore_ascii_case("tsv"));
                let result = match text {
                    // A copy saved as .csv holds the first table as CSV; a
                    // CSV saved under another name, the same rows as Markdown.
                    Some(text) => std::fs::write(&target, super::csv_doc::save_as_text(&text, from_csv, as_csv)),
                    None => std::fs::copy(&source, &target).map(|_| ()),
                };
                if let Err(e) = result {
                    cx.update(|window, cx| window.push_notification(format!("Markie could not save the copy: {e}"), cx)).ok();
                }
            }
        })
        .detach();
    }

    fn export(&mut self, target: ExportTarget, window: &mut Window, cx: &mut Context<Self>) {
        self.export_document(target, window, cx);
    }

    // ------------------------------------------------------------ render

    pub(super) fn render_title_bar(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = themes::palette(cx);
        // An untitled buffer shows no name, as Electron's null fileName.
        // document-workspace.tsx: the vault page names the window "Protected
        // documents", with no document of its own to rename, mark or copy.
        let vault_page = self.workspace_page_open() && self.shell.view == super::rail::LeftView::Vault;
        let name = if vault_page {
            Some("Protected documents".to_string())
        } else {
            self.doc.as_ref().filter(|d| !d.untitled).and_then(|d| d.path.file_name()).map(|n| n.to_string_lossy().into_owned())
        };
        let dirty = !vault_page
            && (self.dirty || matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(o)) if o.is_dirty(cx)));
        let has_text = !vault_page && matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. }));
        let document_mode = !vault_page && self.document_mode();

        let bg = if p.dark {
            Background::from(linear_gradient(
                90.,
                linear_color_stop(p.surface, 0.),
                linear_color_stop(mix(p.surface2, p.surface, 0.72), 1.),
            ))
        } else {
            p.surface.into()
        };

        // The left group gives way first on a narrow window: the file name
        // truncates, then the group clips, and Share always stays on screen.
        let left = h_flex()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .gap(px(10.))
            // Narrow: the wordmark steps aside so the file name stays legible.
            .when(!title_bar_narrow(f32::from(window.viewport_size().width)), |el| el.child(self.render_wordmark(&p)).child(vrule(&p)))
            .child(self.render_nav_buttons(&p, cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(10.))
                    .child(self.action_button(
                        "tb-open",
                        "markie/open.svg",
                        if name.is_some() { "Open" } else { "Open file…" },
                        false,
                        &p,
                        cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(Open), cx)),
                    ))
                    .when_some(name, |el, name| {
                        el.child(no_drag(
                            div()
                                .id("tb-name")
                                .min_w(px(64.))
                                .max_w(px(288.))
                                .flex()
                                .items_center()
                                .text_size(px(12.))
                                .text_color(p.fg(0.8))
                                .when(!vault_page, |el| {
                                    el.hover(|s| s.text_color(p.foreground))
                                        .cursor_pointer()
                                        .on_click(|_, window, cx| window.dispatch_action(Box::new(RenameDocument), cx))
                                })
                                .child(div().truncate().child(name))
                                .when(dirty, |el| el.child(div().ml(px(6.)).text_color(p.muted).child("•"))),
                        ))
                    })
                    .child(vrule(&p))
                    // toolbar.tsx in document mode: "Save file" before Export,
                    // and no Copy all (page.tsx passes no `copyText`).
                    .when(document_mode, |el| el.child(self.render_save_file(&p, cx)))
                    .child(self.render_export(&p, cx))
                    .when(has_text && !document_mode, |el| el.child(self.render_copy_all(&p, cx))),
            );

        let right = h_flex()
            .flex_none()
            .gap(px(8.))
            .child(self.icon_button(
                "tb-commands",
                "markie/commands.svg",
                15.,
                &p,
                cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(CommandPalette), cx)),
            ))
            // toolbar.tsx `themeLocked`: the owner's pinned theme shows.
            .when(self.doc_theme_pinned(), |el| {
                el.child(
                    div()
                        .id("tb-owner-theme")
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_color(p.muted)
                        .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("The owner pinned their theme to this doc").build(window, cx))
                        .child(super::dialog_chrome::stroke_icon("M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4", p.muted, 10., 2.))
                        .child(div().text_size(px(10.)).child("OWNER THEME")),
                )
            })
            // The live dot and peers' avatars (collab.rs), as toolbar.tsx.
            .children(self.render_presence(&p))
            .child(self.render_mode_switch(&p, cx))
            .child(self.render_theme_button(&p, cx))
            .child(vrule(&p))
            // toolbar.tsx: Share reads in full ink once the document has a
            // cloud copy and a session (`canShare`), muted while it would
            // first walk you through syncing.
            .child(self.action_button_toned(
                "tb-share",
                "markie/share.svg",
                "Share",
                false,
                self.has_cloud_copy(),
                &p,
                cx.listener(|this, _, window, cx| this.open_share(window, cx)),
            ));

        TitleBar::new()
            .h(px(TITLE_BAR_HEIGHT))
            .pl(px(82.))
            .pr(px(16.))
            .bg(bg)
            .border_color(if p.dark { p.border } else { p.border })
            .child(
                // A definite width: the kit's bar never shrinks below its
                // content, so without one a narrow window pushed Share off.
                h_flex()
                    .w(px(title_bar_content_width(f32::from(window.viewport_size().width))))
                    .h_full()
                    .justify_between()
                    .gap(px(12.))
                    .child(left)
                    .child(right),
            )
    }

    /// The lockup at 64px: lettering in the text colour at 90%, the underline
    /// brand red (`MarkieLogo width={64} className="mt-1"`).
    fn render_wordmark(&self, p: &Palette) -> impl IntoElement {
        let (w, h) = (px(64.), px(28.));
        div()
            .flex_none()
            .pr(px(2.))
            .mt(px(4.))
            .relative()
            .w(w + px(2.))
            .h(h)
            .child(svg().path("markie/logo-lettering.svg").absolute().top_0().left_0().w(w).h(h).text_color(p.fg(0.9)))
            .child(
                svg()
                    .path("markie/logo-underline.svg")
                    .absolute()
                    .top_0()
                    .left_0()
                    .w(w)
                    .h(h)
                    .text_color(rgb(crate::icons::BRAND_RED)),
            )
    }

    /// `.markie-toolbar-action`: 28px tall, 13px icon, 12px label.
    fn action_button(
        &self,
        id: &'static str,
        glyph: &'static str,
        label: &'static str,
        open: bool,
        p: &Palette,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        self.action_button_toned(id, glyph, label, open, false, p, on_click)
    }

    /// `bright`: the label and glyph in full ink without the open fill.
    #[allow(clippy::too_many_arguments)]
    fn action_button_toned(
        &self,
        id: &'static str,
        glyph: &'static str,
        label: &'static str,
        open: bool,
        bright: bool,
        p: &Palette,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let (fg, fill) = (p.foreground, hover_fill(p));
        let muted = if bright { fg } else { p.muted };
        no_drag(
            div()
                .id(id)
                .group(id)
                .flex()
                .flex_none()
                .items_center()
                .gap(px(6.))
                .h(px(28.))
                .px(px(8.))
                .rounded(px(6.))
                .border_1()
                .border_color(transparent_black())
                .text_size(px(12.))
                .text_color(if open { fg } else { muted })
                .when(open, |el| el.bg(fill))
                .hover(|s| s.bg(fill).text_color(fg).border_color(p.fg(0.07)))
                .child(icon(glyph, 13., if open { fg } else { muted }).group_hover(id, |s| s.text_color(fg)))
                .child(label)
                .on_click(on_click),
        )
    }

    /// `.markie-toolbar-icon`: a 28px square around one icon.
    fn icon_button(
        &self,
        id: &'static str,
        glyph: &'static str,
        size: f32,
        p: &Palette,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<Div> {
        let (fg, fill) = (p.foreground, hover_fill(p));
        no_drag(
            div()
                .id(id)
                .group(id)
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded(px(6.))
                .border_1()
                .border_color(transparent_black())
                .hover(|s| s.bg(fill).border_color(p.fg(0.07)))
                .child(icon(glyph, size, p.muted).group_hover(id, |s| s.text_color(fg)))
                .on_click(on_click),
        )
    }

    /// Whether Electron shows this file, opened from disk, in its document
    /// workspace (`documentMode`): Word, RTF and ODT, and a `.wd`. Markdown,
    /// CSV and plain text open in the main viewer, with every export and
    /// Copy all.
    pub(super) fn document_mode(&self) -> bool {
        self.doc.as_ref().is_some_and(|d| {
            let office = matches!(d.kind, DocKind::Office(_) | DocKind::Engine);
            document_mode_for(office, matches!(d.kind, DocKind::Text { .. }), d.format, d.large)
        })
    }

    /// `markie-toolbar-action ... h-7 px-2 text-[12px] text-muted`.
    fn render_save_file(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let (fg, fill) = (p.foreground, hover_fill(p));
        no_drag(
            div()
                .id("tb-save")
                .flex()
                .flex_none()
                .items_center()
                .h(px(28.))
                .px(px(8.))
                .rounded(px(6.))
                .border_1()
                .border_color(transparent_black())
                .text_size(px(12.))
                .text_color(p.muted)
                .hover(|s| s.bg(fill).text_color(fg).border_color(p.fg(0.07)))
                .child("Save file")
                .on_click(cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(Save), cx))),
        )
    }

    fn render_copy_all(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let copied = self.shell.copied == CopyState::Copied;
        let (fg, fill) = (p.foreground, hover_fill(p));
        let color = if copied { p.green } else { p.muted };
        no_drag(
            div()
                .id("tb-copy")
                .group("tb-copy")
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded(px(6.))
                .border_1()
                .border_color(transparent_black())
                .hover(|s| s.bg(fill).border_color(p.fg(0.07)))
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(if copied { "Copied" } else { "Copy all" }).build(window, cx)
                })
                .child(
                    icon(if copied { "markie/copied.svg" } else { "markie/copy.svg" }, 14., color)
                        .when(!copied, |s| s.group_hover("tb-copy", |s| s.text_color(fg))),
                )
                .on_click(cx.listener(|this, _, _, cx| this.copy_all(cx))),
        )
    }

    fn render_export(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.shell.menu == Some(ChromeMenu::Export);
        let (fg, fill) = (p.foreground, hover_fill(p));
        let color = if open { fg } else { p.muted };
        div()
            .relative()
            .flex_none()
            .child(no_drag(
                div()
                    .id("tb-export")
                    .group("tb-export")
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(28.))
                    .px(px(8.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(transparent_black())
                    .text_size(px(12.))
                    .text_color(color)
                    .when(open, |el| el.bg(fill))
                    .hover(|s| s.bg(fill).text_color(fg).border_color(p.fg(0.07)))
                    .child(icon("markie/export.svg", 13., color).group_hover("tb-export", |s| s.text_color(fg)))
                    .child("Export")
                    .child(icon("markie/chevron-down-bold.svg", 8., color).group_hover("tb-export", |s| s.text_color(fg)))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_menu(ChromeMenu::Export, cx))),
            ))
            .when(open, |el| el.child(self.render_export_menu(p, cx)))
    }

    fn render_export_menu(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let doc = self.doc.as_ref();
        let has_doc = doc.is_some();
        let format = doc.map(|d| d.format);
        let is_text = matches!(doc.map(|d| &d.kind), Some(DocKind::Text { .. }));
        let document_mode = self.document_mode();
        let markdown = format == Some(FormatKind::Markdown);
        let p = *p;

        let item = move |id: &'static str, glyph: &'static str, label: &'static str, enabled: bool| {
            let hover = menu_hover(&p);
            div()
                .id(id)
                .group(id)
                .w_full()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .py(px(8.))
                .text_size(px(12.))
                .text_color(p.muted)
                .child(icon(glyph, 13., p.muted).when(enabled, |s| s.group_hover(id, |s| s.text_color(p.foreground))))
                .child(label)
                .when(!enabled, |el| el.opacity(0.4))
                .when(enabled, |el| el.cursor_pointer().hover(|s| s.bg(hover).text_color(p.foreground)))
        };
        let note = |text: &'static str, max: f32| {
            div()
                .max_w(px(max))
                .mt(px(4.))
                .pt(px(8.))
                .px(px(12.))
                .border_t_1()
                .border_color(p.border)
                .text_size(px(11.))
                .line_height(px(17.875))
                .text_color(p.muted)
                .child(text)
        };

        let mut panel = menu_panel(&p).py(px(6.)).min_w(px(188.)).child(
            item("ex-copy", "markie/save-copy.svg", "Save a Copy…", has_doc)
                .when(has_doc, |el| el.on_click(cx.listener(|this, _, window, cx| this.save_a_copy(window, cx)))),
        );
        // toolbar.tsx offers the document PDF only while `document-export-pdf`
        // is enabled, which is `canPrintDocx` for a Word, RTF or ODT document.
        let printable = self.office_output_for(cx).is_some_and(|o| o.printable);
        if document_mode {
            if printable {
            panel = panel
                .child(
                    item("ex-docpdf", "markie/download.svg", "Export PDF…", true)
                        .on_click(cx.listener(|this, _, w, cx| this.export(ExportTarget::OfficePdf, w, cx))),
                )
                .child(note(
                    "PDF uses document typography and page setup. Review comments are not included. Page breaks can vary with installed fonts and printer settings.",
                    240.,
                ));
            }
        } else {
            // Markdown offers everything but itself; plain text everything but .txt.
            let formats: Vec<(&'static str, &'static str, Option<ExportTarget>)> = if markdown {
                vec![
                    ("ex-docx", "Word (.docx)", Some(ExportTarget::Docx)),
                    ("ex-rtf", "RTF (.rtf)", Some(ExportTarget::Rtf)),
                    ("ex-odt", "OpenDocument (.odt)", Some(ExportTarget::Odt)),
                    ("ex-txt", "Plain text (.txt)", Some(ExportTarget::Txt)),
                ]
            } else {
                vec![
                    ("ex-docx", "Word (.docx)", Some(ExportTarget::Docx)),
                    ("ex-rtf", "RTF (.rtf)", Some(ExportTarget::Rtf)),
                    ("ex-odt", "OpenDocument (.odt)", Some(ExportTarget::Odt)),
                    ("ex-md", "Markdown (.md)", Some(ExportTarget::Md)),
                ]
            };
            panel = panel
                .child(div().h(px(1.)).my(px(4.)).bg(p.border))
                .child(
                    div()
                        .px(px(12.))
                        .pt(px(6.))
                        .pb(px(4.))
                        .text_size(px(10.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(p.muted.opacity(0.8))
                        .child("EXPORT AS"),
                )
                .child(
                    item("ex-pdf-dark", "markie/download.svg", "PDF (Dark)", is_text)
                        .when(is_text, |el| el.on_click(cx.listener(|this, _, w, cx| this.export(ExportTarget::PdfDark, w, cx)))),
                )
                .child(
                    item("ex-pdf-light", "markie/download.svg", "PDF (Light)", is_text)
                        .when(is_text, |el| el.on_click(cx.listener(|this, _, w, cx| this.export(ExportTarget::PdfLight, w, cx)))),
                )
                .child(
                    item("ex-html", "markie/code.svg", "HTML (.html)", is_text)
                        .when(is_text, |el| el.on_click(cx.listener(|this, _, w, cx| this.export(ExportTarget::Html, w, cx)))),
                );
            if is_text {
                for (id, label, target) in formats {
                    let enabled = target.is_some();
                    panel = panel.child(item(id, "markie/file-lines.svg", label, enabled).when_some(target, |el, t| {
                        el.on_click(cx.listener(move |this, _, w, cx| this.export(t, w, cx)))
                    }));
                }
                panel = panel.child(note("RTF and ODT keep text and formatting. Tables there become tab-separated rows.", 220.));
            }
        }

        div().absolute().top(px(34.)).left_0().child(deferred(
            anchored().snap_to_window_with_margin(px(8.)).child(
                panel
                    .id("export-menu")
                    .occlude()
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| this.close_menu(cx))),
            ),
        ))
    }

    fn render_mode_switch(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self.shell.color_mode;
        let p = *p;
        segmented(&p).children(
            [
                (ColorMode::System, "markie/system.svg", "System theme"),
                (ColorMode::Light, "markie/sun.svg", "Light theme"),
                (ColorMode::Dark, "markie/moon.svg", "Dark theme"),
            ]
            .into_iter()
            .map(move |(mode, glyph, label)| {
                let on = mode == current;
                let id = SharedString::from(format!("mode-{}", mode.key()));
                let group = id.clone();
                no_drag(
                    div()
                        .id(id)
                        .group(group.clone())
                        .flex()
                        .items_center()
                        .justify_center()
                        .h(px(28.))
                        .px(px(10.4))
                        .rounded(px(7.))
                        .when(on, |el| {
                            el.bg(segment_on(&p)).shadow(vec![BoxShadow {
                                color: hsla(0., 0., 0., if p.dark { 0.13 } else { 0.12 }),
                                offset: point(px(0.), px(if p.dark { 2. } else { 1. })),
                                blur_radius: px(if p.dark { 7. } else { 2. }),
                                spread_radius: px(0.),
                                inset: false,
                            }])
                        })
                        .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx))
                        .child(
                            icon(glyph, 13., if on { p.foreground } else { p.muted })
                                .group_hover(group, |s| s.text_color(p.foreground)),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| this.pick_color_mode(mode, window, cx))),
                )
            }),
        )
    }

    fn render_theme_button(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.shell.menu == Some(ChromeMenu::Theme);
        let button = self
            .icon_button(
                "tb-theme",
                "markie/palette.svg",
                15.,
                p,
                cx.listener(|this, _, _, cx| this.toggle_menu(ChromeMenu::Theme, cx)),
            )
            .when(open, |el| el.bg(hover_fill(p)))
            .when(!open, |el| {
                el.tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Theme presets").build(window, cx))
            });
        div().relative().flex_none().child(button).when(open, |el| el.child(self.render_theme_menu(p, cx)))
    }

    /// The eight style templates, each with its light and dark swatch.
    fn render_theme_menu(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let current = self.shell.template.clone();
        let rows = themes::templates().into_iter().map(|t| {
            let on = t.id == current;
            let id = t.id.clone();
            let hover = menu_hover(&p);
            let sw = |c: &str| div().size(px(10.)).rounded_full().bg(themes::hex(c)).border_1().border_color(p.border);
            div()
                .id(SharedString::from(format!("tpl-{}", t.id)))
                .flex()
                .items_start()
                .gap(px(10.))
                .px(px(12.))
                .py(px(7.))
                .rounded(px(6.))
                .cursor_pointer()
                .when(on, |el| el.bg(hover))
                .hover(|s| s.bg(hover))
                .child(
                    h_flex()
                        .mt(px(2.))
                        .gap(px(3.))
                        .child(sw(&t.light.background))
                        .child(sw(&t.dark.background))
                        .child(sw(&t.dark.link)),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(div().text_size(px(12.)).text_color(p.foreground).child(t.name.clone()))
                        .child(div().text_size(px(10.5)).text_color(p.muted).child(t.description.clone())),
                )
                .child(div().w(px(14.)).text_size(px(11.)).text_color(p.foreground).child(if on { "✓" } else { "" }))
                .on_click(cx.listener(move |this, _, window, cx| this.pick_template(&id, window, cx)))
        });
        let panel = menu_panel(&p)
            .p(px(4.))
            .w(px(300.))
            .child(
                div()
                    .px(px(12.))
                    .pt(px(6.))
                    .pb(px(4.))
                    .text_size(px(10.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.muted.opacity(0.8))
                    .child("THEME PRESETS"),
            )
            .children(rows);
        div().absolute().top(px(34.)).right_0().child(deferred(
            anchored().anchor(Anchor::TopRight).snap_to_window_with_margin(px(8.)).child(
                panel.id("theme-menu").occlude().on_mouse_down_out(cx.listener(|this, _, _, cx| this.close_menu(cx))),
            ),
        ))
    }
}

/// Light, dark, or whatever macOS shows now.
pub(super) fn apply_color_mode(mode: ColorMode, window: &mut Window, cx: &mut App) {
    match mode {
        ColorMode::Light => Theme::change(ThemeMode::Light, Some(window), cx),
        ColorMode::Dark => Theme::change(ThemeMode::Dark, Some(window), cx),
        ColorMode::System => Theme::sync_system_appearance(Some(window), cx),
    }
}

/// A standalone HTML page. Markdown is rendered; plain text is escaped into
/// a preformatted block.
// Kept for the shell's own tests; exports now come from workspace/export.rs.
#[cfg_attr(not(test), allow(dead_code))]
fn export_html(title: &str, text: &str, markdown: bool) -> String {
    let body = if markdown {
        let body = &text[markie_core::outline::front_matter_len(text)..];
        let mut out = String::new();
        let opts = pulldown_cmark::Options::ENABLE_TABLES
            | pulldown_cmark::Options::ENABLE_STRIKETHROUGH
            | pulldown_cmark::Options::ENABLE_TASKLISTS;
        pulldown_cmark::html::push_html(&mut out, pulldown_cmark::Parser::new_ext(body, opts));
        out
    } else {
        format!("<pre>{}</pre>", escape(text))
    };
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{}</title>\n<style>body{{max-width:768px;margin:48px auto;padding:0 24px;font:16px/1.75 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#18181b}}pre,code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}pre{{white-space:pre-wrap}}table{{border-collapse:collapse}}td,th{{border:1px solid #c7d0dc;padding:4px 8px}}</style>\n</head>\n<body>\n{}\n</body>\n</html>\n",
        escape(title),
        body
    )
}

// Kept for the shell's own tests; exports now come from workspace/export.rs.
#[cfg_attr(not(test), allow(dead_code))]
fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Markdown as plain text: the words, list markers and link addresses.
// Kept for the shell's own tests; exports now come from workspace/export.rs.
#[cfg_attr(not(test), allow(dead_code))]
fn markdown_to_plain(text: &str) -> String {
    use pulldown_cmark::{Event, Tag, TagEnd};
    let body = &text[markie_core::outline::front_matter_len(text)..];
    let mut out = String::new();
    let mut links: Vec<String> = Vec::new();
    for event in pulldown_cmark::Parser::new_ext(body, pulldown_cmark::Options::ENABLE_TABLES) {
        match event {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak => out.push(' '),
            Event::HardBreak => out.push('\n'),
            Event::Start(Tag::Item) => out.push_str("- "),
            Event::Start(Tag::Link { dest_url, .. }) => links.push(dest_url.to_string()),
            Event::End(TagEnd::Link) => {
                if let Some(url) = links.pop() {
                    out.push_str(&format!(" ({url})"));
                }
            }
            Event::End(TagEnd::TableCell) => out.push('\t'),
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock | TagEnd::TableRow | TagEnd::TableHead) => {
                out.push_str("\n\n")
            }
            Event::End(TagEnd::Item) => out.push('\n'),
            _ => {}
        }
    }
    let mut cleaned = out.trim_end().replace("\n\n\n", "\n\n");
    cleaned.push('\n');
    cleaned
}

/// `documentMode` for a document opened from disk: an Office document (or
/// one the engine refused), or a `.wd` small enough for the document
/// workspace. In it the title bar shows "Save file" before Export
/// (`toolbar.tsx`: `(documentMode || projectMode) && onSave`).
pub(super) fn document_mode_for(office: bool, text: bool, format: FormatKind, large: bool) -> bool {
    office || (text && !large && format == FormatKind::Darkmown)
}

#[cfg(test)]
mod tests {
    use super::{ColorMode, document_mode_for, export_html, markdown_to_plain};
    use markie_core::formats::FormatKind;

    #[test]
    fn save_file_shows_where_electrons_document_mode_does() {
        assert!(document_mode_for(true, false, FormatKind::Docx, false));
        assert!(document_mode_for(true, false, FormatKind::Rtf, false));
        assert!(document_mode_for(false, true, FormatKind::Darkmown, false));
        assert!(!document_mode_for(false, true, FormatKind::Darkmown, true));
        assert!(!document_mode_for(false, true, FormatKind::Markdown, false));
        assert!(!document_mode_for(false, true, FormatKind::Text, false));
        assert!(!document_mode_for(false, false, FormatKind::Html, false));
    }

    #[test]
    fn exports_html_and_plain_text() {
        let md = "---\ntitle: x\n---\n# Hi\n\nSome **bold** and a [link](https://e.com).\n\n- one\n- two\n";
        let html = export_html("Notes <1>", md, true);
        assert!(html.contains("<h1>Hi</h1>") && html.contains("<strong>bold</strong>"));
        assert!(html.contains("<title>Notes &lt;1&gt;</title>"));
        assert!(!html.contains("title: x"));
        let plain = markdown_to_plain(md);
        assert!(plain.starts_with("Hi\n\nSome bold and a link (https://e.com)."), "{plain}");
        assert!(plain.contains("- one\n- two"));
        assert!(export_html("t", "a < b", false).contains("<pre>a &lt; b</pre>"));
    }

    #[test]
    fn color_mode_round_trips() {
        for m in [ColorMode::System, ColorMode::Light, ColorMode::Dark] {
            assert_eq!(ColorMode::parse(Some(m.key())), m);
        }
        assert_eq!(ColorMode::parse(None), ColorMode::System);
    }
}
