//! Private files on the vault page: the Make Private sheet, the private list,
//! opening and saving a private file, Make Not Private and Delete.
//!
//! The file work is `private_files.rs`; this is the page's half. Private files
//! open only after the vault passphrase has opened the private store in this
//! session. Touch ID opens the vault, not the private store (see
//! `markie_vault::private` and docs/rust-port/PRIVATE-FILES.md).

use std::path::{Path, PathBuf};

use gpui_kit::assets::IconName;
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_vault::private::{PrivateEntry, PrivateMetadata};

use super::private_files;
use super::ui::{Kind, Tone, banner, button, chip, field, hint, human_size, kind_label, label};
use super::{EnvView, Pending, PrivateRequest, SecureDoc, VaultEvent, VaultPage, failure_copy, is_auth_failure};
use crate::themes::Palette;

/// The four facts the Make Private sheet states, in order.
pub const SHEET_FACTS: [&str; 4] = [
    "It moves into your vault, encrypted. Only Markie can open it, after your vault passphrase.",
    "The original is deleted from its folder.",
    "Other apps can no longer open it.",
    "Copies made before now by Time Machine or a cloud sync are not removed.",
];

/// The extra line for a file with a Markie Cloud copy or a share.
pub const CLOUD_FACT: &str =
    "This file is also in Markie Cloud. The cloud copy stays as it is, and anyone it is shared with keeps access. Only the copy on this Mac becomes private.";

/// What Touch ID does not open, said once where it matters.
pub const TOUCH_ID_NOTE: &str = "Touch ID opens your vault, but private files also need your passphrase on this Mac.";

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// A folder as the sheet shows it: the home folder as `~`.
pub fn folder_label(folder: &str) -> String {
    let home = markie_core::paths::home_dir();
    let home = home.to_string_lossy();
    match folder.strip_prefix(home.as_ref()) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => folder.to_string(),
    }
}

fn card(p: &Palette) -> Div {
    v_flex().w_full().rounded(px(10.)).border_1().border_color(p.border).bg(p.surface)
}

/// A native sheet with a message that names the file.
async fn ask(this: &WeakEntity<VaultPage>, cx: &mut AsyncWindowContext, message: String, detail: Option<String>, answers: &'static [&'static str]) -> Option<usize> {
    let rx = this
        .update_in(cx, |_, window, cx| window.prompt(PromptLevel::Warning, &message, detail.as_deref(), answers, cx))
        .ok()?;
    rx.await.ok()
}

impl VaultPage {
    /// Make Private from the menu or a row: shown on the page, which walks
    /// through creating or unlocking the vault first when it needs to.
    pub fn request_make_private(&mut self, request: PrivateRequest, window: &mut Window, cx: &mut Context<Self>) {
        self.request = Some(request);
        self.error = None;
        self.settings_open = false;
        if self.locked {
            self.focus_next = Some(self.passphrase.clone());
        } else if !self.private_unlocked {
            self.clear_input(&self.private_passphrase.clone(), window, cx);
            self.focus_next = Some(self.private_passphrase.clone());
        }
        cx.notify();
    }

    pub(super) fn cancel_request(&mut self, cx: &mut Context<Self>) {
        self.request = None;
        self.error = None;
        cx.notify();
    }

    /// The passphrase that opens private files after a Touch ID unlock. It is
    /// checked against the vault first, so a typo never makes a new key.
    pub(super) fn submit_private_passphrase(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let secret = Self::input_text(&self.private_passphrase, cx);
        if secret.is_empty() || self.busy || self.locked {
            return;
        }
        self.clear_input(&self.private_passphrase.clone(), window, cx);
        self.run_all(
            window,
            cx,
            move |repo, private, _| {
                repo.verify_passphrase(&secret)?;
                private.unlock_or_create(&secret)
            },
            |this, result, _, cx| {
                match result {
                    Ok(()) => this.notice = if this.request.is_some() { String::new() } else { "Private files are open.".into() },
                    Err(VaultError::Vault(markie_vault::VaultErrorCode::AuthenticationFailed)) if this.private_count > 0 => {
                        this.error = Some(
                            "That passphrase opens the vault but not these private files. They were made private with an earlier passphrase.".into(),
                        )
                    }
                    Err(e) if is_auth_failure(&e) => this.error = Some("That passphrase is not correct. Private files stay locked.".into()),
                    Err(e) => this.error = Some(failure_copy(&e).into()),
                }
                this.refresh_private();
                cx.notify();
            },
        );
    }

    /// The sheet's button: encrypt, verify, delete the original, then tell the window.
    pub(super) fn confirm_make_private(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(request) = self.request.clone() else { return };
        if self.busy || self.locked || !self.private_unlocked {
            return;
        }
        let path = request.path.clone();
        self.run_all(
            window,
            cx,
            move |_, private, _| Ok(private_files::make_private(private, &path, markie_core::clock::now_ms()).map_err(|r| r.copy())),
            move |this, result, _, cx| {
                match result {
                    Ok(Ok(_id)) => {
                        this.request = None;
                        this.refresh_private();
                        let folder = request.path.parent().map(|d| folder_label(&d.to_string_lossy())).unwrap_or_default();
                        this.notice = format!(
                            "“{}” is private. It is encrypted in your vault and no longer in {folder}.",
                            file_name(&request.path)
                        );
                        cx.emit(VaultEvent::MadePrivate(request.path.clone()));
                    }
                    Ok(Err(copy)) => this.error = Some(copy),
                    Err(e) => this.error = Some(failure_copy(&e).into()),
                }
                cx.notify();
            },
        );
    }

    pub(super) fn choose_private(&mut self, entry: PrivateEntry, window: &mut Window, cx: &mut Context<Self>) {
        let dirty = self.opened.as_ref().is_some_and(|d| d.dirty);
        cx.spawn_in(window, async move |this, cx| {
            if dirty
                && ask(&this, cx, "Discard unsaved private edits? Save encrypted changes first to keep them.".into(), None, &["OK", "Cancel"]).await
                    != Some(0)
            {
                return;
            }
            this.update_in(cx, move |this, window, cx| {
                this.request = None;
                let label = entry.metadata.name.clone();
                this.confirm_item("open", label, Pending::OpenPrivate(entry), window, cx);
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn read_private(&mut self, entry: PrivateEntry, window: &mut Window, cx: &mut Context<Self>) {
        let id = entry.id.clone();
        self.run_all(
            window,
            cx,
            move |_, private, _| private.read(&id).map(|doc| SecureDoc::from_private(id, doc)),
            |this, result, window, cx| match result {
                Ok(doc) => {
                    this.show_doc(doc, window, cx);
                    this.settings_open = false;
                    this.notice.clear();
                }
                Err(e) => this.error = Some(failure_copy(&e).into()),
            },
        );
    }

    pub(super) fn save_private(
        &mut self,
        id: String,
        bytes: zeroize::Zeroizing<Vec<u8>>,
        meta: PrivateMetadata,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_all(
            window,
            cx,
            move |_, private, _| private.replace(&id, &bytes, &meta).map(|()| (bytes, meta)),
            |this, result, _, _| match result {
                Ok((bytes, meta)) => {
                    if let Some(doc) = this.opened.as_mut() {
                        doc.original_name = doc.name.clone();
                        doc.bytes = bytes;
                        doc.dirty = false;
                        doc.private = Some(meta);
                    }
                    this.refresh_private();
                    this.notice = "Encrypted changes saved.".into();
                }
                // The old encrypted copy stays; the edits stay here.
                Err(e) => this.error = Some(failure_copy(&e).into()),
            },
        );
    }

    /// Make Not Private: back to the original folder, or one the user picks.
    pub(super) fn make_not_private(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.opened.as_ref() else { return };
        let (Some(id), Some(meta)) = (doc.id.clone(), doc.private.clone()) else { return };
        if doc.dirty {
            self.error = Some("Save your changes first, so the restored file has them.".into());
            cx.notify();
            return;
        }
        let name = meta.name.clone();
        let folder = folder_label(&meta.folder);
        cx.spawn_in(window, async move |this, cx| {
            let message = format!("Make “{name}” not private?");
            let detail = format!(
                "It leaves the vault and becomes a normal file again, unencrypted. Other apps can open it. Restore it to {folder}, or choose another folder."
            );
            let dir: Option<PathBuf> = match ask(&this, cx, message, Some(detail), &["Restore", "Choose Folder…", "Cancel"]).await {
                Some(0) => None,
                Some(1) => {
                    let Ok(rx) = this.update(cx, |_, cx| {
                        cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Restore Here".into()) })
                    }) else {
                        return;
                    };
                    let Ok(Ok(Some(dirs))) = rx.await else { return };
                    let Some(dir) = dirs.into_iter().next() else { return };
                    Some(dir)
                }
                _ => return,
            };
            this.update_in(cx, move |this, window, cx| {
                this.run_all(
                    window,
                    cx,
                    move |_, private, _| Ok(private_files::make_not_private(private, &id, dir.as_deref())),
                    |this, result, _, cx| {
                        match result {
                            Ok(Ok(path)) => {
                                this.opened = None;
                                this.private_runs.clear();
                                this.env = EnvView::default();
                                this.refresh_private();
                                this.notice = format!(
                                    "“{}” is a normal file again, in {}. Other apps can open it.",
                                    file_name(&path),
                                    path.parent().map(|d| folder_label(&d.to_string_lossy())).unwrap_or_default()
                                );
                                cx.emit(VaultEvent::Restored(path));
                            }
                            Ok(Err(copy)) => this.error = Some(copy),
                            Err(e) => this.error = Some(failure_copy(&e).into()),
                        }
                        cx.notify();
                    },
                );
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn delete_private(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.opened.as_ref() else { return };
        let Some(id) = doc.id.clone() else { return };
        let name = doc.original_name.clone();
        cx.spawn_in(window, async move |this, cx| {
            let message = format!("Delete “{name}” for good?");
            let detail = "This is the only copy Markie has. It cannot be recovered from the vault afterwards.".to_string();
            if ask(&this, cx, message, Some(detail), &["Delete", "Cancel"]).await != Some(0) {
                return;
            }
            this.update_in(cx, move |this, window, cx| {
                this.run_all(window, cx, move |_, private, _| private.remove(&id), |this, result, _, _| match result {
                    Ok(()) => {
                        this.opened = None;
                        this.private_runs.clear();
                        this.env = EnvView::default();
                        this.refresh_private();
                        this.notice = "The private file was deleted. Copies outside Markie, such as backups, are not erased.".into();
                    }
                    Err(e) => this.error = Some(failure_copy(&e).into()),
                });
            })
            .ok();
        })
        .detach();
    }

    // ── Look ──

    /// The banner over the create or unlock card while a request waits.
    pub(super) fn render_request_banner(&self, p: &Palette) -> Option<Div> {
        let request = self.request.as_ref()?;
        let name = file_name(&request.path);
        let text = if self.has_vault == Some(false) {
            format!("To make “{name}” private, first create your vault. Private files are encrypted with its passphrase.")
        } else {
            format!("Unlock your vault to make “{name}” private.")
        };
        Some(banner(Kind::Info, text, p))
    }

    /// The passphrase row that opens private files.
    fn private_unlock_row(&self, id: &'static str, button_label: &'static str, cx: &mut Context<Self>) -> Div {
        let p = Self::palette(cx);
        let busy = self.busy;
        let empty = self.private_passphrase.read(cx).value().is_empty();
        h_flex()
            .gap(px(8.))
            .child(div().flex_1().min_w(px(200.)).child(field(&self.private_passphrase, busy, &p)))
            .child(button(id, if busy { "Checking…" } else { button_label }, None, Tone::Primary, busy || empty, &p).h(px(36.)).when(!(busy || empty), |b| {
                b.on_click(cx.listener(|this, _, window, cx| this.submit_private_passphrase(window, cx)))
            }))
    }

    /// The Make Private sheet: what happens, said plainly, then one button.
    pub(super) fn render_request(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let request = self.request.as_ref()?;
        let p = Self::palette(cx);
        let busy = self.busy;
        let name = file_name(&request.path);
        let folder = request.path.parent().map(|d| folder_label(&d.to_string_lossy())).unwrap_or_default();
        let fact = |text: &str, p: &Palette| {
            h_flex()
                .gap(px(10.))
                .items_start()
                .child(div().mt(px(7.)).size(px(5.)).flex_none().rounded_full().bg(p.muted))
                .child(div().flex_1().text_size(px(13.5)).line_height(px(20.)).child(text.to_string()))
        };
        let mut body = v_flex()
            .gap(px(14.))
            .child(
                h_flex()
                    .gap(px(12.))
                    .items_center()
                    .child(div().size(px(40.)).flex_none().flex().items_center().justify_center().rounded_full().bg(p.fg(0.06)).child(Icon::new(IconName::Lock)))
                    .child(
                        v_flex()
                            .min_w_0()
                            .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).truncate().child(format!("Make “{name}” private?")))
                            .child(div().text_size(px(12.5)).text_color(p.muted).truncate().child(format!("In {folder}"))),
                    ),
            )
            .child(v_flex().gap(px(8.)).children(SHEET_FACTS.iter().map(|t| fact(t, &p))));
        if request.cloud {
            body = body.child(
                h_flex()
                    .gap(px(10.))
                    .items_start()
                    .rounded(px(8.))
                    .p(px(12.))
                    .bg(p.yellow.opacity(0.12))
                    .child(div().mt(px(1.)).text_color(p.yellow).child(Icon::new(IconName::Cloud).small()))
                    .child(div().flex_1().text_size(px(13.)).line_height(px(19.)).child(CLOUD_FACT)),
            );
        }
        body = body.when_some(self.error_banner(&p), |el, b| el.child(b));
        if self.private_unlocked {
            body = body.child(
                h_flex()
                    .gap(px(8.))
                    .justify_end()
                    .child(button("private-cancel", "Cancel", None, Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, _, cx| this.cancel_request(cx)))))
                    .child(button("private-confirm", if busy { "Encrypting…" } else { "Make Private" }, Some(IconName::Lock), Tone::Primary, busy, &p).when(!busy, |b| {
                        b.on_click(cx.listener(|this, _, window, cx| this.confirm_make_private(window, cx)))
                    })),
            );
        } else {
            body = body
                .child(v_flex().gap(px(6.)).child(label("Vault passphrase", &p)).child(self.private_unlock_row("private-unlock", "Continue", cx)))
                .child(hint(TOUCH_ID_NOTE, &p))
                .child(h_flex().justify_end().child(button("private-cancel", "Cancel", None, Tone::Quiet, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, _, cx| this.cancel_request(cx))))));
        }
        Some(card(&p).max_w(px(520.)).p(px(24.)).bg(p.background).shadow_sm().child(body).into_any_element())
    }

    /// The sidebar's Private files group, or the row that unlocks it.
    pub(super) fn render_private_section(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.private_count == 0 && self.private_entries.is_empty() {
            return None;
        }
        let p = Self::palette(cx);
        let busy = self.busy;
        let mut group = v_flex().gap(px(1.)).mb(px(10.)).child(
            h_flex()
                .gap(px(6.))
                .items_center()
                .px(px(8.))
                .pt(px(8.))
                .pb(px(4.))
                .child(div().text_size(px(11.5)).font_weight(FontWeight::MEDIUM).text_color(p.muted).child("Private files"))
                .child(div().text_color(p.muted).child(Icon::new(IconName::Lock).xsmall())),
        );
        if !self.private_unlocked {
            let count = self.private_count;
            group = group.child(
                v_flex()
                    .gap(px(8.))
                    .mx(px(4.))
                    .p(px(10.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(p.border)
                    .bg(p.background)
                    .child(div().text_size(px(12.5)).line_height(px(18.)).child(if count == 1 {
                        "1 private file. Enter your passphrase to open it.".to_string()
                    } else {
                        format!("{count} private files. Enter your passphrase to open them.")
                    }))
                    .when(self.request.is_none(), |el| el.child(self.private_unlock_row("private-list-unlock", "Open", cx))),
            );
            return Some(group.into_any_element());
        }
        let open_id = self.opened.as_ref().filter(|d| d.private.is_some()).and_then(|d| d.id.clone());
        for entry in &self.private_entries {
            let entry = entry.clone();
            let selected = open_id.as_deref() == Some(entry.id.as_str());
            let hover = p.fg(0.05);
            let id = SharedString::from(format!("private-entry-{}", entry.id));
            let sub = format!("{} · {} · from {}", kind_label(&entry.metadata.name), human_size(entry.bytes), folder_label(&entry.metadata.folder));
            group = group.child(
                h_flex()
                    .id(id)
                    .gap(px(9.))
                    .items_center()
                    .h(px(44.))
                    .px(px(8.))
                    .rounded(px(7.))
                    .when(selected, |el| el.bg(p.fg(0.08)))
                    .when(!selected && !busy, |el| el.hover(move |s| s.bg(hover)))
                    .when(!busy, |el| el.cursor_pointer())
                    .child(div().flex_none().text_color(if selected { p.foreground } else { p.muted }).child(Icon::new(IconName::Lock).small()))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(div().truncate().text_size(px(13.)).line_height(px(18.)).font_weight(if selected { FontWeight::MEDIUM } else { FontWeight::NORMAL }).child(entry.metadata.name.clone()))
                            .child(div().truncate().text_size(px(11.5)).line_height(px(16.)).text_color(p.muted).child(sub)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if !this.busy {
                            this.choose_private(entry.clone(), window, cx);
                        }
                    })),
            );
        }
        Some(group.into_any_element())
    }

    /// The opened private file's line under its name, and its own buttons.
    pub(super) fn render_private_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let meta = self.opened.as_ref()?.private.as_ref()?;
        let p = Self::palette(cx);
        let busy = self.busy;
        Some(
            h_flex()
                .gap(px(10.))
                .items_center()
                .child(chip("Private", p.green, &p))
                .child(div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(p.muted).child(format!("Encrypted in your vault. From {}.", folder_label(&meta.folder))))
                .child(button("private-restore", "Make Not Private…", Some(IconName::LockOpen), Tone::Secondary, busy, &p).when(!busy, |b| {
                    b.on_click(cx.listener(|this, _, window, cx| this.make_not_private(window, cx)))
                }))
                .into_any_element(),
        )
    }
}

use markie_vault::VaultError;

#[cfg(test)]
mod tests {
    use super::*;
    use super::private_files::Refusal;
    // `gpui_kit::*` brings GPUI's own `test` attribute; tests here are plain.
    use ::core::prelude::v1::test;

    #[test]
    fn sheet_copy_says_each_fact_plainly() {
        let all = SHEET_FACTS.join(" ");
        for needle in ["encrypted", "deleted", "Other apps", "Time Machine"] {
            assert!(all.contains(needle), "{needle}");
        }
        for text in SHEET_FACTS.iter().chain([&CLOUD_FACT, &TOUCH_ID_NOTE]) {
            assert!(!text.contains('\u{2014}'), "no em dashes in UI copy");
        }
        assert!(CLOUD_FACT.contains("cloud copy stays"));
    }

    #[test]
    fn folders_show_home_as_a_tilde() {
        let home = markie_core::paths::home_dir();
        assert_eq!(folder_label(&home.join("Notes").to_string_lossy()), "~/Notes");
        assert_eq!(folder_label("/Volumes/Fixture"), "/Volumes/Fixture");
        let lookalike = format!("{}-other/x", home.to_string_lossy());
        assert_eq!(folder_label(&lookalike), lookalike);
    }

    #[test]
    fn refusal_copy_is_ready_for_the_sheet() {
        assert!(Refusal::Changed.copy().contains("Nothing was deleted"));
    }
}
