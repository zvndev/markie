//! New documents by type, rename, move, duplicate, trash, reveal and copy
//! path. The new-document modal is `src/components/new-document-modal.tsx`;
//! the trash confirmation is the Library's DeleteFileDialog, and rename and
//! move use the same small dialog shape.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_office::model::Format;
use markie_office::rich_document::{create_rich_document, export_rich_document};

use super::dialog_chrome::{self as chrome, Tokens, fade, shadow};
use super::overlay::Overlay;
use super::Workspace;
use crate::actions::*;
use markie_core::paths;

/// Every type a person can start from blank, as Electron lists them.
/// (format mark, label, extension, description, featured)
pub(super) const WRITING_TYPES: [(&str, &str, &str, &str, bool); 6] = [
    ("markdown", "Markdown", "md", "Notes and docs with rich and source views", true),
    ("docx", "Word", "docx", "Native Word formatting and page layout", false),
    ("rtf", "Rich Text", "rtf", "Portable formatting for Word and TextEdit", false),
    ("odt", "OpenDocument", "odt", "The open format for LibreOffice", false),
    ("text", "Plain Text", "txt", "Exactly the characters you type", false),
    ("darkmown", "Darkmown", "wd", "Notes with live values and interactive controls", true),
];

pub(super) const DATA_TYPES: [(&str, &str, &str, &str); 4] = [
    ("csv", "CSV", "csv", "Rows and columns with a table preview"),
    ("json", "JSON", "json", "Structured data as literal source"),
    ("yaml", "YAML", "yaml", "Config and data as literal source"),
    ("xml", "XML", "xml", "Tagged data as literal source"),
];

fn all_extensions() -> Vec<&'static str> {
    WRITING_TYPES.iter().map(|t| t.2).chain(DATA_TYPES.iter().map(|t| t.2)).collect()
}

/// The bytes a blank document of this type starts as.
fn blank_bytes(ext: &str) -> Result<Vec<u8>, String> {
    let format = match ext {
        "docx" => Format::Docx,
        "rtf" => Format::Rtf,
        "odt" => Format::Odt,
        _ => return Ok(Vec::new()),
    };
    create_rich_document(format, "")
        .and_then(|doc| export_rich_document(&doc))
        .map_err(|e| e.message)
}

/// `notes copy.md`, then `notes copy 2.md`, never overwriting.
pub(crate) fn copy_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map_or_else(|| "document".into(), |s| s.to_string_lossy().into_owned());
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = path.parent().unwrap_or(Path::new("."));
    let first = dir.join(format!("{stem} copy{ext}"));
    if !first.exists() {
        return first;
    }
    (2..).map(|n| dir.join(format!("{stem} copy {n}{ext}"))).find(|p| !p.exists()).expect("a free name")
}

/// A new name keeps the old extension when the user leaves it off, and may
/// not leave the folder.
pub(crate) fn renamed_path(old: &Path, raw: &str) -> Option<PathBuf> {
    let name = raw.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return None;
    }
    let mut file = name.to_string();
    if Path::new(name).extension().is_none() {
        if let Some(ext) = old.extension() {
            file.push('.');
            file.push_str(&ext.to_string_lossy());
        }
    }
    Some(old.with_file_name(file))
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

impl Workspace {
    /// The open document's file; none for an untitled buffer.
    pub(super) fn file_path(&self) -> Option<PathBuf> {
        self.doc.as_ref().filter(|d| !d.untitled).map(|d| d.path.clone())
    }

    pub(super) fn default_dir(&self) -> PathBuf {
        if let Some(doc) = self.doc.as_ref().filter(|d| !d.untitled) {
            if let Some(dir) = doc.path.parent() {
                return dir.to_path_buf();
            }
        }
        self.registry
            .as_ref()
            .and_then(|r| r.roots().ok())
            .and_then(|r| r.into_iter().next())
            .unwrap_or_else(|| paths::home_dir().join("Documents"))
    }

    pub(super) fn on_new(&mut self, _: &NewDocument, window: &mut Window, cx: &mut Context<Self>) {
        self.show_dialog(Overlay::NewDocument { focused: 0 }, window, cx);
    }

    pub(super) fn create_document(&mut self, ext: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let name = super::untitled::untitled_name(ext);
        let format = markie_core::formats::kind_for_extension(ext);
        match blank_bytes(ext) {
            Ok(bytes) if bytes.is_empty() => self.open_untitled(name, String::new(), window, cx),
            Ok(bytes) => self.open_untitled_office(name, format, &bytes, window, cx),
            Err(e) => window.push_notification(format!("Markie could not create it: {e}"), cx),
        }
    }

    fn create_from_modal(&mut self, ext: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        self.close_dialog(window, cx);
        self.create_document(ext, window, cx);
    }

    /// Arrow keys, Home and End move between the format buttons; Return
    /// picks the focused one, as in Electron.
    pub(super) fn new_document_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Overlay::NewDocument { focused } = &mut self.dialogs.open else { return false };
        let n = all_extensions().len();
        *focused = match key {
            "right" | "down" => (*focused + 1) % n,
            "left" | "up" => (*focused + n - 1) % n,
            "home" => 0,
            "end" => n - 1,
            "enter" | "space" => {
                let ext = all_extensions()[*focused];
                self.create_from_modal(ext, window, cx);
                return true;
            }
            _ => return false,
        };
        cx.notify();
        true
    }

    pub(super) fn render_new_document(&mut self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::NewDocument { focused } = self.dialogs.open else { return div().into_any_element() };
        let viewport = window.viewport_size();
        let width = (viewport.width - px(32.)).min(px(920.));
        // Panel padding 24 each side and a 1pt border; four columns, 10pt gaps.
        let col = (f32::from(width) - 50. - 30.) / 4.;
        let data_w = (f32::from(width) - 50. - 8.) / 2.;
        let card_bg = if t.dark { fade(t.surface2, 0.6) } else { t.background };
        let card_border = if t.dark { fade(t.border, 0.8) } else { fade(t.border, 0.6) };
        let hover_border = if t.dark { fade(t.foreground, 0.25) } else { chrome::mix(t.foreground, 0.22, t.border) };
        let hover_bg = if t.dark { fade(t.accent, 0.45) } else { t.background };
        let ring = t.blue;

        let writing = WRITING_TYPES.iter().enumerate().map(|(i, (mark, label, ext, desc, featured))| {
            let ext: &'static str = ext;
            let is_focused = focused == i;
            let w = if *featured { col * 2. + 10. } else { col };
            div()
                .id(SharedString::from(format!("new-{ext}")))
                .group(SharedString::from(format!("new-{ext}")))
                .relative()
                .w(px(w))
                .min_h(px(138.))
                .flex()
                .items_start()
                .gap(px(14.))
                .overflow_hidden()
                .rounded(px(14.))
                .border_1()
                .border_color(card_border)
                .bg(card_bg)
                .p(px(16.))
                .cursor_pointer()
                .when(t.dark, |el| {
                    el.shadow(vec![chrome::inset(fade(rgb(0xffffff).into(), 0.05), 1.), shadow(fade(chrome::black(), 0.08), 0., 3., 12.)])
                })
                .when(is_focused, |el| el.shadow(vec![chrome::ring(ring, 4.), chrome::ring(t.panel_bg(), 2.)]))
                .hover(move |el| el.border_color(hover_border).bg(hover_bg))
                .on_click(cx.listener(move |this, _, window, cx| this.create_from_modal(ext, window, cx)))
                .child(chrome::format_mark(mark, if *featured { "lg" } else { "md" }, t))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .pt(px(2.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .items_start()
                                .gap(px(6.))
                                .child(div().text_size(px(15.)).line_height(px(15.)).font_weight(FontWeight::SEMIBOLD).whitespace_nowrap().child(*label))
                                .child(
                                    div()
                                        .rounded_full()
                                        .border_1()
                                        .border_color(card_border)
                                        .bg(fade(t.background, 0.45))
                                        .px(px(6.))
                                        .py(px(2.))
                                        .font_family("Menlo")
                                        .text_size(px(10.))
                                        .line_height(px(10.))
                                        .text_color(t.muted)
                                        .child(format!(".{ext}")),
                                ),
                        )
                        .child(
                            div()
                                .mt(px(8.))
                                .max_w(px(250.))
                                .text_size(px(12.5))
                                .line_height(px(17.))
                                .text_color(t.muted)
                                .child(*desc),
                        ),
                )
                .child(
                    div()
                        .absolute()
                        .bottom(px(12.))
                        .right(px(12.))
                        .size(px(24.))
                        .rounded_full()
                        .border_1()
                        .border_color(fade(t.border, 0.7))
                        .flex()
                        .items_center()
                        .justify_center()
                        .invisible()
                        .when(is_focused, |el| el.visible())
                        .group_hover(SharedString::from(format!("new-{ext}")), |el| el.visible())
                        .child(chrome::stroke_icon(chrome::PATH_ARROW_RIGHT, t.muted, 13., 2.)),
                )
        }).collect::<Vec<_>>();

        let data = DATA_TYPES.iter().enumerate().map(|(j, (mark, label, ext, desc))| {
            let ext: &'static str = ext;
            let is_focused = focused == WRITING_TYPES.len() + j;
            let data_border = if t.dark { fade(t.border, 0.75) } else { fade(t.border, 0.6) };
            let data_bg = if t.dark { fade(t.background, 0.35) } else { t.background };
            let hover_bg = if t.dark { fade(t.accent, 0.4) } else { t.background };
            let hover_border = if t.dark { fade(t.foreground, 0.22) } else { chrome::mix(t.foreground, 0.22, t.border) };
            div()
                .id(SharedString::from(format!("new-{ext}")))
                .group(SharedString::from(format!("new-{ext}")))
                .w(px(data_w))
                .min_h(px(76.))
                .flex()
                .items_center()
                .gap(px(12.))
                .rounded(px(12.))
                .border_1()
                .border_color(data_border)
                .bg(data_bg)
                .px(px(12.))
                .py(px(10.))
                .cursor_pointer()
                .when(t.dark, |el| el.shadow(vec![chrome::inset(fade(rgb(0xffffff).into(), 0.04), 1.)]))
                .when(is_focused, |el| el.shadow(vec![chrome::ring(ring, 4.), chrome::ring(t.panel_bg(), 2.)]))
                .hover(move |el| el.border_color(hover_border).bg(hover_bg))
                .on_click(cx.listener(move |this, _, window, cx| this.create_from_modal(ext, window, cx)))
                .child(chrome::format_mark(mark, "md", t))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(div().text_size(px(13.5)).line_height(px(13.5)).font_weight(FontWeight::SEMIBOLD).child(*label))
                                .child(div().font_family("Menlo").text_size(px(10.)).text_color(t.muted).child(format!(".{ext}"))),
                        )
                        .child(
                            div()
                                .mt(px(6.))
                                .text_size(px(11.5))
                                .text_color(t.muted)
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .text_ellipsis()
                                .child(*desc),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .invisible()
                        .when(is_focused, |el| el.visible())
                        .group_hover(SharedString::from(format!("new-{ext}")), |el| el.visible())
                        .child(chrome::stroke_icon(chrome::PATH_ARROW_RIGHT, t.muted, 14., 2.)),
                )
        }).collect::<Vec<_>>();

        let heading = |text: &'static str| {
            div().mt(px(24.)).mb(px(10.)).text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(text)
        };

        self.panel(t, 18.)
            .id("new-document")
            .w(width)
            .max_h(viewport.height * 0.88)
            .overflow_y_scroll()
            .p(px(24.))
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(16.))
                    .child(
                        div()
                            .child(div().text_size(px(20.)).line_height(px(25.)).font_weight(FontWeight::SEMIBOLD).child("New document"))
                            .child(
                                div()
                                    .mt(px(4.))
                                    .text_size(px(12.5))
                                    .text_color(t.muted)
                                    .child("Choose a format. Files stay in that format."),
                            ),
                    )
                    .child(self.close_button("new-document-close", t, cx)),
            )
            .child(heading("Writing"))
            .child(div().flex().flex_wrap().gap(px(10.)).children(writing))
            .child(heading("Data and source"))
            .child(div().flex().flex_wrap().gap(px(8.)).children(data))
            .into_any_element()
    }

    // ------------------------------------------------------------- rename

    pub(super) fn on_rename(&mut self, _: &RenameDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.file_path() else { return };
        let current = file_name(&path);
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).default_value(current.clone());
            // Select the name, ready to type over.
            state.select_all(window, cx);
            state
        });
        self.show_dialog(Overlay::Rename { path, input }, window, cx);
    }

    pub(super) fn confirm_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Overlay::Rename { path, input } = &self.dialogs.open else { return };
        let (path, raw) = (path.clone(), input.read(cx).value().to_string());
        self.close_dialog(window, cx);
        self.rename_to(&path, &raw, window, cx);
    }

    fn rename_to(&mut self, old: &Path, raw: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(new) = renamed_path(old, raw) else {
            window.push_notification("That name can't be used.", cx);
            return;
        };
        if new == old {
            return;
        }
        if new.exists() {
            window.push_notification("A file with that name is already there.", cx);
            return;
        }
        if self.dirty {
            self.save(window, cx);
        }
        match std::fs::rename(old, &new) {
            Ok(()) => {
                self.file_grants.move_document(old, &new);
                self.follow_move(old, &new, cx);
                self.open_path(&new, window, cx);
                self.rescan(cx);
            }
            Err(e) => window.push_notification(format!("Markie could not rename it: {e}"), cx),
        }
    }

    pub(super) fn render_rename(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::Rename { path, input } = &self.dialogs.open else { return div().into_any_element() };
        let name = file_name(path);
        let input = input.clone();
        small_dialog(self, t)
            .child(title_line(format!("Rename \u{201C}{name}\u{201D}")))
            .child(
                div()
                    .mb(px(12.))
                    .rounded(px(7.))
                    .border_1()
                    .border_color(chrome::mix(t.blue, 0.72, t.border))
                    .bg(t.field_bg())
                    .shadow(vec![chrome::ring(fade(t.blue, 0.52), 2.)])
                    .px(px(4.))
                    .child(Input::new(&input).appearance(false).text_size(px(13.))),
            )
            .child(buttons(
                t,
                cancel_button(t, cx),
                plain_button("rename-confirm", "Rename", t).on_click(cx.listener(|this, _, window, cx| this.confirm_rename(window, cx))),
            ))
            .into_any_element()
    }

    // ----------------------------------------------------------- duplicate

    pub(super) fn on_duplicate(&mut self, _: &DuplicateDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.file_path() else { return };
        if self.dirty {
            self.save(window, cx);
        }
        let target = copy_path(&path);
        match std::fs::copy(&path, &target) {
            Ok(_) => {
                self.open_path(&target, window, cx);
                self.rescan(cx);
            }
            Err(e) => window.push_notification(format!("Markie could not duplicate it: {e}"), cx),
        }
    }

    // --------------------------------------------------------------- trash

    pub(super) fn on_trash(&mut self, _: &TrashDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.file_path() else { return };
        self.show_dialog(Overlay::Trash { path }, window, cx);
    }

    pub(super) fn render_trash(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::Trash { path } = &self.dialogs.open else { return div().into_any_element() };
        let name = file_name(path);
        small_dialog(self, t)
            .child(title_line(format!("Delete \u{201C}{name}\u{201D}?")))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(t.muted)
                    .mb(px(12.))
                    .child("The file moves to the Trash, so you can still restore it from there. It also leaves your Library."),
            )
            .child(buttons(
                t,
                cancel_button(t, cx),
                danger_button("trash-confirm", "Move to Trash", t)
                    .on_click(cx.listener(|this, _, window, cx| this.confirm_file_dialog(window, cx))),
            ))
            .into_any_element()
    }

    /// Return in the trash or move dialog: the button on the right.
    pub(super) fn confirm_file_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match std::mem::replace(&mut self.dialogs.open, Overlay::None) {
            Overlay::Trash { path } => {
                self.dialogs.open = Overlay::Trash { path: path.clone() };
                self.close_dialog(window, cx);
                self.trash(&path, window, cx);
            }
            Overlay::Move { from, to } => {
                self.dialogs.open = Overlay::Move { from: from.clone(), to: to.clone() };
                self.close_dialog(window, cx);
                self.move_to(&from, &copy_path(&to), window, cx);
            }
            other => self.dialogs.open = other,
        }
    }

    fn trash(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        match trash::delete(path) {
            Ok(()) => {
                self.disk.forget(path);
                self.doc = None;
                self.dirty = false;
                self.autosave.cancel();
                window.set_window_title(paths::APP_NAME);
                self.rescan(cx);
            }
            Err(e) => window.push_notification(format!("Markie could not move it to the Trash: {e}"), cx),
        }
        cx.notify();
    }

    // ---------------------------------------------------------------- move

    /// Move the open document to another folder. A name already taken there
    /// asks before anything moves, and keeping both never overwrites.
    pub(super) fn on_move(&mut self, _: &MoveDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some(from) = self.file_path() else { return };
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Move Here".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(dirs))) = rx.await else { return };
            let Some(dir) = dirs.into_iter().next() else { return };
            this.update_in(cx, |this, window, cx| {
                let to = dir.join(from.file_name().unwrap_or_default());
                if to == from {
                    return;
                }
                if to.exists() {
                    this.show_dialog(Overlay::Move { from, to }, window, cx);
                } else {
                    this.move_to(&from, &to, window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn move_to(&mut self, from: &Path, to: &Path, window: &mut Window, cx: &mut Context<Self>) {
        if self.dirty {
            self.save(window, cx);
        }
        // A rename within one volume; across volumes, copy then trash, so
        // the original is recoverable if anything goes wrong.
        let moved = std::fs::rename(from, to).or_else(|_| std::fs::copy(from, to).and_then(|_| trash::delete(from).map_err(std::io::Error::other)));
        match moved {
            Ok(()) => {
                self.file_grants.move_document(from, to);
                self.disk.forget(from);
                self.follow_move(from, to, cx);
                self.open_path(to, window, cx);
                self.rescan(cx);
            }
            Err(e) => window.push_notification(format!("Markie could not move it: {e}"), cx),
        }
    }

    pub(super) fn render_move(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::Move { to, .. } = &self.dialogs.open else { return div().into_any_element() };
        let name = file_name(to);
        let folder = to.parent().map(|d| file_name(d)).unwrap_or_default();
        let keep = file_name(&copy_path(to));
        small_dialog(self, t)
            .child(title_line(format!("\u{201C}{folder}\u{201D} already has a file named \u{201C}{name}\u{201D}")))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(t.muted)
                    .mb(px(12.))
                    .child(format!("Keep both moves yours in as \u{201C}{keep}\u{201D}. Nothing is overwritten.")),
            )
            .child(buttons(
                t,
                cancel_button(t, cx),
                plain_button("move-confirm", "Keep both", t).on_click(cx.listener(|this, _, window, cx| this.confirm_file_dialog(window, cx))),
            ))
            .into_any_element()
    }

    // --------------------------------------------------------- reveal, copy

    pub(super) fn on_reveal(&mut self, _: &RevealDocument, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(path) = self.file_path() {
            cx.reveal_path(&path);
        }
    }

    pub(super) fn on_copy_path(&mut self, _: &CopyPath, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(path) = self.file_path() {
            cx.write_to_clipboard(ClipboardItem::new_string(path.to_string_lossy().into_owned()));
            window.push_notification("Path copied.", cx);
        }
    }
}

// ----------------------------------------------- the Library dialog shape

/// DeleteFileDialog's panel: 380pt, 16pt padding, surface-2, a deep shadow.
fn small_dialog(ws: &Workspace, t: &Tokens) -> Div {
    ws.panel(t, 12.)
        .w(px(380.))
        .p(px(16.))
        .shadow(vec![shadow(fade(chrome::black(), 0.25), 0., 25., 50.)])
}

fn title_line(text: String) -> Div {
    div().text_size(px(13.)).mb(px(4.)).child(text)
}

fn buttons(_t: &Tokens, left: impl IntoElement, right: impl IntoElement) -> Div {
    div().flex().justify_end().gap(px(8.)).child(left).child(right)
}

fn cancel_button(t: &Tokens, cx: &mut Context<Workspace>) -> Stateful<Div> {
    let (fg, hover) = (t.foreground, t.hover_soft());
    div()
        .id("dialog-cancel")
        .text_size(px(12.))
        .px(px(12.))
        .py(px(6.))
        .rounded(px(6.))
        .text_color(t.muted)
        .cursor_pointer()
        .hover(move |el| el.text_color(fg).bg(hover))
        .child("Cancel")
        .on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx)))
}

fn plain_button(id: &'static str, label: &'static str, t: &Tokens) -> Stateful<Div> {
    let hover = t.hover_soft();
    div()
        .id(id)
        .text_size(px(12.))
        .px(px(12.))
        .py(px(6.))
        .rounded(px(6.))
        .bg(t.accent)
        .text_color(t.foreground)
        .cursor_pointer()
        .hover(move |el| el.bg(hover))
        .child(label)
}

fn danger_button(id: &'static str, label: &'static str, t: &Tokens) -> Stateful<Div> {
    let hover = t.hover_soft();
    div()
        .id(id)
        .text_size(px(12.))
        .px(px(12.))
        .py(px(6.))
        .rounded(px(6.))
        .border_1()
        .border_color(t.red)
        .text_color(t.red)
        .cursor_pointer()
        .hover(move |el| el.bg(hover))
        .child(label)
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob export brings its own `test` attribute.
    use super::{DATA_TYPES, WRITING_TYPES, blank_bytes, copy_path, renamed_path};

    #[test]
    fn copies_and_renames() {
        let dir = std::env::temp_dir().join(format!("markie-rs-fileops-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let note = dir.join("note.md");
        std::fs::write(&note, "x").unwrap();
        assert_eq!(copy_path(&note).file_name().unwrap(), "note copy.md");
        std::fs::write(dir.join("note copy.md"), "x").unwrap();
        assert_eq!(copy_path(&note).file_name().unwrap(), "note copy 2.md");
        assert_eq!(renamed_path(&note, "plan").unwrap().file_name().unwrap(), "plan.md");
        assert_eq!(renamed_path(&note, "plan.txt").unwrap().file_name().unwrap(), "plan.txt");
        assert!(renamed_path(&note, "../escape").is_none());
        assert!(renamed_path(&note, "  ").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn offers_every_electron_type() {
        let exts: Vec<&str> = WRITING_TYPES.iter().map(|t| t.2).chain(DATA_TYPES.iter().map(|t| t.2)).collect();
        assert_eq!(exts, ["md", "docx", "rtf", "odt", "txt", "wd", "csv", "json", "yaml", "xml"]);
    }

    #[test]
    fn blank_office_documents_are_real_files() {
        let docx = blank_bytes("docx").unwrap();
        assert_eq!(&docx[..2], b"PK");
        let odt = blank_bytes("odt").unwrap();
        assert_eq!(&odt[..2], b"PK");
        assert!(blank_bytes("rtf").unwrap().starts_with(b"{\\rtf"));
        assert!(blank_bytes("md").unwrap().is_empty());
    }
}
