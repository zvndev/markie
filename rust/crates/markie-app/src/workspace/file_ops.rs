//! New documents by type, rename, duplicate, trash, reveal and copy path.
//! Mirrors the Library row menu and File menu of the Electron app.

use std::path::{Path, PathBuf};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{ActiveTheme, Sizable as _, WindowExt as _, v_flex};
use gpui_kit::*;

use markie_core::document;
use markie_core::formats::FormatKind;

use super::{Mode, Workspace};
use crate::actions::*;
use markie_core::paths;

/// The types a new document can start as in this build. Word, Darkmown and
/// the vault arrive with phases 4, 5 and 6.
const NEW_TYPES: [(FormatKind, &str, &str); 5] = [
    (FormatKind::Markdown, "md", "Markdown"),
    (FormatKind::Text, "txt", "Plain text"),
    (FormatKind::Csv, "csv", "CSV table"),
    (FormatKind::Json, "json", "JSON"),
    (FormatKind::Yaml, "yaml", "YAML"),
];

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

impl Workspace {
    fn default_dir(&self) -> PathBuf {
        if let Some(doc) = &self.doc {
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
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let theme = cx.theme().clone();
            dialog.title("New document").w(px(360.)).child(
                v_flex().gap_2().children(NEW_TYPES.iter().map(|(kind, ext, label)| {
                    let owner = owner.clone();
                    let ext = *ext;
                    let _ = kind;
                    Button::new(SharedString::from(format!("new-{ext}")))
                        .w_full()
                        .label(format!("{label}  .{ext}"))
                        .on_click(move |_, window, cx| {
                            window.close_dialog(cx);
                            owner.update(cx, |this, cx| this.create_document(ext, window, cx)).ok();
                        })
                }))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("Word, Darkmown and vault documents arrive in later phases."),
                ),
            )
        });
    }

    fn create_document(&mut self, ext: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let dir = self.default_dir();
        let suggested = document::untitled_path(&dir, ext);
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

    pub(super) fn on_rename(&mut self, _: &RenameDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
        let current = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(current));
        let owner = cx.weak_entity();
        let focus = input.clone();
        window.defer(cx, move |window, cx| focus.read(cx).focus_handle(cx).focus(window, cx));
        window.open_dialog(cx, move |dialog, _, _| {
            let input = input.clone();
            let owner = owner.clone();
            let path = path.clone();
            dialog
                .title("Rename")
                .w(px(420.))
                .child(Input::new(&input))
                .footer(
                    Button::new("rename-ok").primary().small().label("Rename").on_click(move |_, window, cx| {
                        let raw = input.read(cx).value().to_string();
                        window.close_dialog(cx);
                        owner.update(cx, |this, cx| this.rename_to(&path, &raw, window, cx)).ok();
                    }),
                )
        });
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
                self.open_path(&new, window, cx);
                self.rescan(cx);
            }
            Err(e) => window.push_notification(format!("Markie could not rename it: {e}"), cx),
        }
    }

    pub(super) fn on_duplicate(&mut self, _: &DuplicateDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
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

    pub(super) fn on_trash(&mut self, _: &TrashDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone();
            let path = path.clone();
            dialog
                .title(format!("Move {name} to the Trash?"))
                .w(px(420.))
                .child("You can put it back from the Trash. Its version history stays in Markie RS.")
                .footer(
                    Button::new("trash-ok").danger().small().label("Move to Trash").on_click(move |_, window, cx| {
                        window.close_dialog(cx);
                        owner.update(cx, |this, cx| this.trash(&path, window, cx)).ok();
                    }),
                )
        });
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

    pub(super) fn on_reveal(&mut self, _: &RevealDocument, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(doc) = &self.doc {
            cx.reveal_path(&doc.path);
        }
    }

    pub(super) fn on_copy_path(&mut self, _: &CopyPath, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(doc) = &self.doc {
            cx.write_to_clipboard(ClipboardItem::new_string(doc.path.to_string_lossy().into_owned()));
            window.push_notification("Path copied.", cx);
        }
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob export brings its own `test` attribute.
    use super::{copy_path, renamed_path};

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
}
