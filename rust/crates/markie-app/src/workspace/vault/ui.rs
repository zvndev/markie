//! The vault page's look: a calm, Markie RS styled surface over the logic in
//! `vault.rs`. Buttons say what they do in one or two words, the one primary
//! action in each state is filled, and feedback sits next to what caused it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Editor, Input};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::formats::Newline;
use markie_vault::VaultEntry;
use markie_vault::dotenv::{self, LineKind};
use markie_vault::passphrase::{StrengthLevel, passphrase_strength};

use super::{Body, EnvValue, IDLE_LOCK, MASK, Pending, VaultPage, confirm, key_problem, parked_key};
use crate::themes::Palette;

// ── Pure rules, tested below ──

/// The search field shows once the list is longer than this.
pub const SEARCH_AFTER: usize = 5;

pub fn shows_search(count: usize) -> bool {
    count > SEARCH_AFTER
}

/// Items whose name contains `query`, ignoring case, in list order.
pub fn matching<'a>(entries: &'a [VaultEntry], query: &str) -> Vec<&'a VaultEntry> {
    let query = query.trim().to_lowercase();
    entries.iter().filter(|e| query.is_empty() || e.name.to_lowercase().contains(&query)).collect()
}

/// `1.2 KB`, `640 bytes`.
pub fn human_size(bytes: usize) -> String {
    match bytes {
        0..=999 => format!("{bytes} bytes"),
        1_000..=999_999 => format!("{:.1} KB", bytes as f64 / 1_000.0),
        _ => format!("{:.1} MB", bytes as f64 / 1_000_000.0),
    }
}

/// The word under an item's name.
pub fn kind_label(name: &str) -> &'static str {
    if dotenv::is_env_file_name(name) {
        return "Env keys";
    }
    match name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).as_deref() {
        Some("txt" | "md" | "markdown" | "text") => "Note",
        Some("docx") => "Word",
        Some("pdf") => "PDF",
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "heic") => "Image",
        _ => "File",
    }
}

/// What a copy left on the clipboard, for the line that confirms it.
#[derive(Clone, Debug, PartialEq)]
pub struct CopyFeedback {
    pub label: String,
    pub row: Option<usize>,
    pub at: Instant,
}

impl CopyFeedback {
    /// Whole seconds until Markie clears the clipboard; None once it has.
    pub fn remaining(&self, now: Instant, clear_after: Duration) -> Option<u64> {
        let left = clear_after.checked_sub(now.saturating_duration_since(self.at))?;
        (!left.is_zero()).then(|| left.as_secs_f64().ceil() as u64)
    }

    pub fn text(&self, remaining: u64) -> String {
        format!("Copied {}. Markie clears it from the clipboard in {remaining} s.", self.label)
    }
}

/// What Escape closes, innermost first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Escape {
    Gate,
    Restore,
    Enroll,
    Settings,
    Search,
    Error,
}

pub struct EscapeState {
    pub gate: bool,
    pub restore: bool,
    pub enrolling: bool,
    pub settings: bool,
    pub query: bool,
    pub error: bool,
}

pub fn escape_target(s: &EscapeState) -> Option<Escape> {
    if s.gate {
        Some(Escape::Gate)
    } else if s.restore {
        Some(Escape::Restore)
    } else if s.enrolling {
        Some(Escape::Enroll)
    } else if s.error {
        Some(Escape::Error)
    } else if s.settings {
        Some(Escape::Settings)
    } else if s.query {
        Some(Escape::Search)
    } else {
        None
    }
}

/// The page's own shortcuts. ⌘L stays Toggle Library, so Lock has none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    Save,
    Search,
    Escape,
}

pub fn shortcut(key: &str, platform: bool, shift: bool, alt: bool, control: bool) -> Option<Shortcut> {
    if shift || alt || control {
        return None;
    }
    match (platform, key) {
        (true, "s") => Some(Shortcut::Save),
        (true, "f") => Some(Shortcut::Search),
        (false, "escape") => Some(Shortcut::Escape),
        _ => None,
    }
}

// ── Pieces ──

// The buttons, chips and banners moved to `workspace/ui.rs`, so the Recent
// and Cloud pages wear the same ones.
pub use crate::workspace::ui::{Kind, Tone, banner, button, chip, field, hint, icon_button, label};

fn card(p: &Palette) -> Div {
    v_flex().w_full().rounded(px(10.)).border_1().border_color(p.border).bg(p.surface)
}

fn strength_color(level: StrengthLevel, p: &Palette) -> Hsla {
    match level {
        StrengthLevel::TooShort | StrengthLevel::Weak => p.red,
        StrengthLevel::Fair => p.yellow,
        StrengthLevel::Strong | StrengthLevel::VeryStrong => p.green,
    }
}

fn entry_icon(name: &str) -> IconName {
    match kind_label(name) {
        "Env keys" => IconName::KeyRound,
        "Note" => IconName::FileText,
        _ => IconName::File,
    }
}

// ── States ──

impl VaultPage {
    pub(super) fn palette(cx: &App) -> Palette {
        crate::themes::palette(cx)
    }

    pub(super) fn error_banner(&self, p: &Palette) -> Option<Div> {
        self.error.as_ref().map(|e| banner(Kind::Error, e.clone(), p))
    }

    /// Create, unlock, or restore the first vault: one card, one filled button.
    pub(super) fn render_locked(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let busy = self.busy;
        let creating = self.has_vault == Some(false);
        let touch_ready = self.has_vault == Some(true) && self.touch_id.available && self.touch_id.enrolled;
        let touch_first = touch_ready && !self.use_passphrase;
        let pass = self.passphrase.read(cx).value().to_string();
        let conf_empty = self.confirmation.read(cx).value().is_empty();
        let strength = (creating && !pass.is_empty()).then(|| passphrase_strength(&pass));
        let suggested_shown = creating && self.suggested.as_ref().is_some_and(|s| **s == pass);
        let restoring_first = creating && self.restore_file.is_some();

        let (title, sub) = if restoring_first {
            ("Restore your vault", "Enter the passphrase this backup was made with.")
        } else if creating {
            ("Create your vault", "Keys, notes and files you keep here are encrypted on this Mac. Only your passphrase opens them.")
        } else {
            ("Unlock your vault", "Your items are encrypted on this Mac.")
        };
        let mut body = v_flex()
            .gap(px(16.))
            .child(
                div()
                    .size(px(44.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .bg(p.fg(0.06))
                    .text_color(p.foreground)
                    .child(Icon::new(IconName::Lock)),
            )
            .child(
                v_flex()
                    .gap(px(4.))
                    .child(div().text_size(px(19.)).line_height(px(26.)).font_weight(FontWeight::SEMIBOLD).child(title))
                    .child(div().text_size(px(13.5)).line_height(px(20.)).text_color(p.muted).child(sub)),
            );
        if self.has_vault.is_none() {
            return self.locked_frame(body.child(hint("Checking encrypted storage…", &p)), &p);
        }
        if self.shielded {
            return self.locked_frame(body.child(hint("Saving your last edits and locking…", &p)), &p);
        }
        if let Some(b) = self.render_request_banner(&p) {
            body = body.child(b);
        } else if !self.notice.is_empty() {
            body = body.child(banner(Kind::Info, self.notice.clone(), &p));
        }
        if restoring_first {
            body = body.when_some(self.error_banner(&p), |el, b| el.child(b)).child(self.render_restore_form(cx));
            return self.locked_frame(body, &p);
        }

        if touch_first {
            body = body
                .when_some(self.error_banner(&p), |el, b| el.child(b))
                .child(
                    button("vault-touch-id", if busy { "Waiting for Touch ID…" } else { "Unlock with Touch ID" }, Some(IconName::FingerprintPattern), Tone::Primary, busy, &p)
                        .w_full()
                        .h(px(38.))
                        .when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.unlock_with_touch_id(window, cx)))),
                )
                .child(h_flex().justify_center().child(button("vault-use-passphrase", "Use passphrase instead", None, Tone::Quiet, busy, &p).when(!busy, |b| {
                    b.on_click(cx.listener(|this, _, _, cx| {
                        this.use_passphrase = true;
                        this.error = None;
                        this.focus_next = Some(this.passphrase.clone());
                        cx.notify();
                    }))
                })));
            return self.locked_frame(body, &p);
        }

        let pass_label = h_flex().justify_between().items_center().child(label("Passphrase", &p)).when(creating, |el| {
            el.child(button("vault-suggest", "Suggest one", None, Tone::Quiet, busy, &p).h(px(24.)).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.suggest(window, cx)))))
        });
        body = body.child(v_flex().gap(px(6.)).child(pass_label).child(field(&self.passphrase, busy, &p)));
        if let Some(s) = &strength {
            let pct = s.bits.clamp(6, 100) as f32 / 100.0;
            body = body.child(
                v_flex()
                    .gap(px(5.))
                    .mt(px(-8.))
                    .child(div().h(px(4.)).w_full().rounded_full().overflow_hidden().bg(p.fg(0.08)).child(div().h_full().w(relative(pct)).rounded_full().bg(strength_color(s.level, &p))))
                    .child(hint(format!("{}. About {} bits.", s.label, s.bits), &p)),
            );
        }
        if suggested_shown {
            let words = self.suggested.as_ref().map(|s| s.to_string()).unwrap_or_default();
            body = body.child(
                h_flex()
                    .gap(px(8.))
                    .items_center()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(p.border)
                    .bg(p.background)
                    .pl(px(12.))
                    .pr(px(4.))
                    .py(px(4.))
                    .child(div().flex_1().min_w_0().text_size(px(13.)).line_height(px(19.)).font_family("Menlo").child(words))
                    .child(button("vault-copy-suggestion", "Copy", Some(IconName::Copy), Tone::Quiet, false, &p).on_click(cx.listener(|this, _, _, cx| this.copy_suggestion(cx)))),
            );
        }
        if creating {
            body = body.child(v_flex().gap(px(6.)).child(label("Confirm passphrase", &p)).child(field(&self.confirmation, busy, &p)));
        }
        body = body.when_some(self.error_banner(&p), |el, b| el.child(b));
        let submit_label = match (busy, creating) {
            (true, true) => "Creating…",
            (true, false) => "Unlocking…",
            (false, true) => "Create vault",
            (false, false) => "Unlock",
        };
        let submit_disabled = busy || pass.is_empty() || (creating && conf_empty);
        body = body.child(
            button("vault-submit", submit_label, None, Tone::Primary, submit_disabled, &p)
                .w_full()
                .h(px(38.))
                .when(!submit_disabled, |b| b.on_click(cx.listener(|this, _, window, cx| this.authenticate(window, cx)))),
        );
        if touch_ready {
            body = body.child(h_flex().justify_center().child(button("vault-use-touch-id", "Use Touch ID instead", Some(IconName::FingerprintPattern), Tone::Quiet, busy, &p).when(!busy, |b| {
                b.on_click(cx.listener(|this, _, window, cx| {
                    this.use_passphrase = false;
                    this.unlock_with_touch_id(window, cx);
                }))
            })));
        }
        if creating {
            body = body.child(hint("There is no reset. Save the passphrase in your password manager.", &p)).child(
                h_flex()
                    .pt(px(12.))
                    .border_t_1()
                    .border_color(p.border)
                    .justify_between()
                    .items_center()
                    .child(hint("Moving from another Mac?", &p))
                    .child(button("vault-restore-first", "Restore a backup…", Some(IconName::ArchiveRestore), Tone::Quiet, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.choose_backup(window, cx))))),
            );
        }
        self.locked_frame(body, &p)
    }

    fn locked_frame(&self, body: Div, p: &Palette) -> AnyElement {
        div()
            .id("vault-locked")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p(px(28.))
            .child(h_flex().justify_center().pt(px(56.)).child(card(p).max_w(px(400.)).p(px(28.)).bg(p.background).shadow_sm().child(body)))
            .into_any_element()
    }

    pub(super) fn render_restore_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let name = self.restore_file.as_ref().map(|(_, n)| n.clone()).unwrap_or_default();
        let busy = self.busy;
        let empty = self.restore_passphrase.read(cx).value().is_empty();
        v_flex()
            .gap(px(12.))
            .child(
                h_flex()
                    .gap(px(8.))
                    .items_center()
                    .text_size(px(13.))
                    .child(div().text_color(p.muted).child(Icon::new(IconName::File).small()))
                    .child(div().flex_1().min_w_0().truncate().child(name)),
            )
            .child(v_flex().gap(px(6.)).child(label("Backup passphrase", &p)).child(field(&self.restore_passphrase, busy, &p)))
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(button("vault-restore", if busy { "Checking backup…" } else { "Restore" }, None, Tone::Primary, busy || empty, &p).when(!(busy || empty), |b| {
                        b.on_click(cx.listener(|this, _, window, cx| this.restore_backup(window, cx)))
                    }))
                    .child(button("vault-restore-cancel", "Cancel", None, Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.cancel_restore(window, cx))))),
            )
            .into_any_element()
    }

    /// The item list: new items, search once the list is long, then the items.
    pub(super) fn render_sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let busy = self.busy;
        let query = self.query.read(cx).value().to_string();
        let visible = matching(&self.entries, &query);
        let open_id = self.opened.as_ref().and_then(|d| d.id.clone());
        let mut nav = v_flex().flex_1().min_h_0().overflow_y_scrollbar().px(px(8.)).pb(px(8.));
        if visible.is_empty() && !self.entries.is_empty() {
            nav = nav.child(
                v_flex()
                    .items_start()
                    .gap(px(6.))
                    .px(px(8.))
                    .py(px(12.))
                    .child(hint(format!("Nothing matches “{}”.", query.trim()), &p))
                    .child(button("vault-clear-search", "Clear search", None, Tone::Quiet, false, &p).ml(px(-8.)).on_click(cx.listener(|this, _, window, cx| this.clear_search(window, cx)))),
            );
        }
        for (title, env) in [("Environment keys", true), ("Notes and files", false)] {
            let items: Vec<&&VaultEntry> = visible.iter().filter(|e| dotenv::is_env_file_name(&e.name) == env).collect();
            if items.is_empty() {
                continue;
            }
            let mut group = v_flex().gap(px(1.)).mb(px(10.)).child(
                div().px(px(8.)).pt(px(8.)).pb(px(4.)).text_size(px(11.5)).font_weight(FontWeight::MEDIUM).text_color(p.muted).child(title),
            );
            for entry in items {
                let entry = (*entry).clone();
                let selected = open_id.as_deref() == Some(entry.id.as_str());
                let hover = p.fg(0.05);
                let id = SharedString::from(format!("vault-entry-{}", entry.id));
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
                        .child(div().flex_none().text_color(if selected { p.foreground } else { p.muted }).child(Icon::new(entry_icon(&entry.name)).small()))
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .child(div().truncate().text_size(px(13.)).line_height(px(18.)).font_weight(if selected { FontWeight::MEDIUM } else { FontWeight::NORMAL }).child(entry.name.clone()))
                                .child(div().truncate().text_size(px(11.5)).line_height(px(16.)).text_color(p.muted).child(format!("{} · {}", kind_label(&entry.name), human_size(entry.bytes)))),
                        )
                        .when(entry.recovery, |el| el.child(chip("Unsaved", p.yellow, &p)))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if !this.busy {
                                this.choose(entry.clone(), window, cx);
                            }
                        })),
                );
            }
            nav = nav.child(group);
        }
        if let Some(private) = self.render_private_section(cx) {
            nav = nav.child(private);
        }
        let new_row = h_flex()
            .gap(px(6.))
            .child(button("vault-new-env", "Keys", Some(IconName::Plus), Tone::Secondary, busy, &p).flex_1().px(px(6.)).when(!busy, |b| {
                b.on_click(cx.listener(|this, _, window, cx| this.create_untitled("Untitled.env", window, cx)))
            }))
            .child(button("vault-new-note", "Note", Some(IconName::Plus), Tone::Secondary, busy, &p).flex_1().px(px(6.)).when(!busy, |b| {
                b.on_click(cx.listener(|this, _, window, cx| this.create_untitled("Untitled.txt", window, cx)))
            }))
            .child(button("vault-import", "Import", Some(IconName::FileUp), Tone::Secondary, busy, &p).flex_1().px(px(6.)).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.import_file(window, cx)))));
        let search = shows_search(self.entries.len()).then(|| {
            Styled::h(Input::new(&self.query).disabled(busy), px(32.))
                .prefix(div().text_color(p.muted).child(Icon::new(IconName::Search).small()))
                .suffix(div().text_size(px(11.)).text_color(p.muted).child("⌘F"))
                .px(px(9.))
                .text_size(px(13.))
                .rounded(px(7.))
                .bg(p.background)
                .border_1()
                .border_color(p.border)
        });
        v_flex()
            .w(px(264.))
            .flex_none()
            .h_full()
            .border_r_1()
            .border_color(p.border)
            .bg(p.surface)
            .child(v_flex().gap(px(8.)).p(px(12.)).child(new_row).children(search))
            .child(nav)
            .into_any_element()
    }

    pub(super) fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let busy = self.busy;
        if !self.entries.is_empty() || self.private_count > 0 {
            return v_flex()
                .items_center()
                .gap(px(6.))
                .pt(px(120.))
                .child(div().text_color(p.muted).child(Icon::new(IconName::Lock)))
                .child(div().text_size(px(14.)).text_color(p.muted).child("Choose an item to open it."))
                .when(shows_search(self.entries.len()), |el| el.child(hint("Press ⌘F to search.", &p)))
                .into_any_element();
        }
        v_flex()
            .items_center()
            .max_w(px(420.))
            .gap(px(14.))
            .pt(px(96.))
            .child(div().size(px(48.)).flex().items_center().justify_center().rounded_full().bg(p.fg(0.06)).child(Icon::new(IconName::ShieldCheck)))
            .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child("Your vault is empty"))
            .child(div().text_center().text_size(px(13.5)).line_height(px(20.)).text_color(p.muted).child("Add API keys from a .env file, a private note, or an encrypted copy of any file. Everything stays encrypted on this Mac."))
            .child(
                h_flex()
                    .pt(px(6.))
                    .gap(px(8.))
                    .child(button("vault-empty-env", "New env keys", Some(IconName::KeyRound), Tone::Primary, busy, &p).when(!busy, |b| {
                        b.on_click(cx.listener(|this, _, window, cx| this.create_untitled("Untitled.env", window, cx)))
                    }))
                    .child(button("vault-empty-note", "New note", Some(IconName::FileText), Tone::Secondary, busy, &p).when(!busy, |b| {
                        b.on_click(cx.listener(|this, _, window, cx| this.create_untitled("Untitled.txt", window, cx)))
                    }))
                    .child(button("vault-empty-import", "Import file…", Some(IconName::FileUp), Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.import_file(window, cx))))),
            )
            .into_any_element()
    }

    fn settings_row(icon: IconName, title: &'static str, state: Option<(&'static str, Hsla)>, text: &'static str, p: &Palette) -> Div {
        // min_w_0: beside a card's buttons the row gives way and its text
        // wraps, so the buttons stay inside the card.
        h_flex()
            .min_w_0()
            .gap(px(12.))
            .items_start()
            .child(div().mt(px(1.)).flex_none().text_color(p.muted).child(Icon::new(icon)))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(3.))
                    .child(h_flex().gap(px(8.)).items_center().child(label(title, p)).when_some(state, |el, (s, c)| el.child(chip(s, c, p))))
                    .child(div().text_size(px(13.)).line_height(px(19.)).text_color(p.muted).child(text)),
            )
    }

    pub(super) fn render_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let busy = self.busy;
        let mut page = v_flex()
            .w_full()
            .max_w(px(600.))
            .gap(px(14.))
            .child(
                h_flex()
                    .items_center()
                    .pb(px(4.))
                    .child(div().flex_1().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child("Vault settings"))
                    .child(button("vault-settings-done", "Done", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, window, cx| this.close_settings(window, cx)))),
            );
        if !self.notice.is_empty() {
            page = page.child(banner(Kind::Success, self.notice.clone(), &p));
        }
        page = page.when_some(self.error_banner(&p), |el, b| el.child(b));
        if self.touch_id.available {
            let on = self.touch_id.enrolled;
            let mut block = card(&p).p(px(16.)).gap(px(12.)).child(
                h_flex()
                    .gap(px(12.))
                    .items_start()
                    .child(Self::settings_row(
                        IconName::FingerprintPattern,
                        "Touch ID",
                        Some(if on { ("On", p.green) } else { ("Off", p.muted) }),
                        if on {
                            "Unlocks the vault on this Mac. It is asked again before an item is opened, shown or copied."
                        } else {
                            "Unlock with your fingerprint instead of typing the passphrase. Your passphrase still works."
                        },
                        &p,
                    ).flex_1())
                    .when(on, |el| {
                        el.child(button("vault-touch-off", "Turn off", None, Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.disable_touch_id(window, cx)))))
                    })
                    .when(!on && !self.enrolling, |el| {
                        el.child(button("vault-touch-start", "Turn on…", None, Tone::Secondary, busy, &p).when(!busy, |b| {
                            b.on_click(cx.listener(|this, _, _, cx| {
                                this.enrolling = true;
                                this.focus_next = Some(this.enroll_passphrase.clone());
                                cx.notify();
                            }))
                        }))
                    }),
            );
            if !on && self.enrolling {
                let empty = self.enroll_passphrase.read(cx).value().is_empty();
                block = block.child(
                    v_flex()
                        .pl(px(28.))
                        .gap(px(8.))
                        .child(label("Confirm with your passphrase", &p))
                        .child(field(&self.enroll_passphrase, busy, &p))
                        .child(
                            h_flex()
                                .gap(px(8.))
                                .child(button("vault-touch-on", "Turn on Touch ID", None, Tone::Primary, busy || empty, &p).when(!(busy || empty), |b| {
                                    b.on_click(cx.listener(|this, _, window, cx| this.enroll_touch_id(window, cx)))
                                }))
                                .child(button("vault-touch-cancel", "Cancel", None, Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.cancel_enroll(window, cx))))),
                        ),
                );
            }
            page = page.child(block);
        }
        let mut backup = card(&p).p(px(16.)).gap(px(12.)).child(
            h_flex()
                .gap(px(12.))
                .items_start()
                .child(Self::settings_row(IconName::HardDriveDownload, "Backup", None, "Saves the whole vault as one encrypted file. It opens only with your passphrase.", &p).flex_1())
                .when(self.restore_file.is_none(), |el| {
                    el.child(
                        h_flex()
                            .flex_none()
                            .gap(px(8.))
                            .child(button("vault-backup", "Back up…", None, Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.back_up(window, cx)))))
                            .child(button("vault-restore-choose", "Restore…", None, Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.choose_backup(window, cx))))),
                    )
                }),
        );
        if self.restore_file.is_some() {
            backup = backup.child(div().pl(px(28.)).child(self.render_restore_form(cx)));
        }
        page.child(backup)
            .child(card(&p).p(px(16.)).child(Self::settings_row(
                IconName::Timer,
                "Auto-lock",
                None,
                const_format_idle(),
                &p,
            )))
            .into_any_element()
    }

    /// The .env editor: one row per key, values masked until shown.
    pub(super) fn render_env(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let muted = p.muted;
        let busy = self.busy;
        let Some(doc) = self.opened.as_ref() else { return div().into_any_element() };
        let text = doc.text().unwrap_or("").to_string();
        let mixed = matches!(doc.body, Body::Text { newline: Newline::Mixed, .. });
        // Any outside change (the Raw view) re-parses and masks everything again.
        if self.env.text != text || self.env.parsed.is_none() {
            self.rebuild_env(window, cx);
        }
        let parsed = self.env.parsed.clone().unwrap_or_else(|| dotenv::parse_dotenv(""));
        let duplicates = dotenv::duplicate_dotenv_keys(&parsed);
        let parked: HashMap<usize, String> = parsed
            .lines
            .iter()
            .filter_map(|l| match &l.kind {
                LineKind::Comment { .. } => parked_key(&l.raw).map(|k| (l.id, k)),
                _ => None,
            })
            .collect();
        let maskable: Vec<usize> = parsed
            .lines
            .iter()
            .filter(|l| matches!(l.kind, LineKind::Entry(_) | LineKind::Malformed { .. }) || parked.contains_key(&l.id))
            .map(|l| l.id)
            .collect();
        let key_count = parsed.lines.iter().filter(|l| matches!(l.kind, LineKind::Entry(_))).count();
        let all_revealed = !maskable.is_empty() && maskable.iter().all(|id| self.env.revealed.contains(id));
        let raw = self.env.raw;
        let copied_row = self.copied.as_ref().and_then(|c| c.row);

        let segment = |id: &'static str, text: &'static str, on: bool, p: &Palette| {
            div()
                .id(id)
                .h(px(26.))
                .px(px(10.))
                .flex()
                .items_center()
                .rounded(px(5.))
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .when(on, |el| el.bg(p.background).text_color(p.foreground).shadow_sm())
                .when(!on, |el| el.text_color(p.muted))
                .child(text)
        };
        let toolbar = h_flex()
            .gap(px(8.))
            .items_center()
            .child(
                h_flex()
                    .rounded(px(7.))
                    .bg(p.fg(0.06))
                    .p(px(2.))
                    .child(segment("env-keys", "Keys", !raw, &p).on_click(cx.listener(|this, _, _, cx| {
                        this.env.raw = false;
                        cx.notify();
                    })))
                    .child(segment("env-raw", "Raw", raw, &p).on_click(cx.listener(move |this, _, window, cx| {
                        if !this.env.raw {
                            let label = this.opened.as_ref().map(|d| d.name.clone()).unwrap_or_default();
                            this.confirm_item("reveal", label, Pending::RevealRaw, window, cx);
                        }
                    }))),
            )
            .child(hint(if key_count == 1 { "1 key".to_string() } else { format!("{key_count} keys") }, &p))
            .child(div().flex_1())
            .when(!raw, |el| {
                let ids = maskable.clone();
                let none = maskable.is_empty();
                el.child(
                    button("env-reveal-all", if all_revealed { "Hide all" } else { "Show all" }, Some(if all_revealed { IconName::EyeOff } else { IconName::Eye }), Tone::Quiet, none, &p).when(!none, |b| {
                        b.on_click(cx.listener(move |this, _, window, cx| {
                            if all_revealed {
                                this.env.revealed.clear();
                                this.sync_env_masks(window, cx);
                                cx.notify();
                            } else {
                                let label = this.opened.as_ref().map(|d| d.name.clone()).unwrap_or_default();
                                this.confirm_item("reveal", label, Pending::Reveal(ids.clone()), window, cx);
                            }
                        }))
                    }),
                )
            })
            .child(button("env-copy-all", "Copy as .env", Some(IconName::Copy), Tone::Quiet, busy || text.is_empty(), &p).when(!(busy || text.is_empty()), |b| {
                b.on_click(cx.listener(move |this, _, window, cx| {
                    let Some(doc) = this.opened.as_ref() else { return };
                    let value = zeroize::Zeroizing::new(doc.text().unwrap_or("").to_string());
                    let label = doc.name.clone();
                    this.confirm_item("copy", label.clone(), Pending::Copy { value, label: format!("all of {label}"), row: None }, window, cx);
                }))
            }));

        let mut body = v_flex().gap(px(12.)).child(toolbar);
        if raw {
            body = body.child(div().h(px(360.)).rounded(px(8.)).border_1().border_color(p.border).child(Editor::new(&self.raw_editor).h_full()));
            if mixed {
                body = body.child(hint("Mixed line endings are kept, so Raw is read-only. Switch to Keys to edit values.", &p));
            }
            return body.into_any_element();
        }
        let mut table = v_flex().rounded(px(8.)).border_1().border_color(p.border).overflow_hidden();
        if parsed.lines.is_empty() {
            table = table.child(div().px(px(14.)).py(px(18.)).text_size(px(13.)).text_color(muted).child("No keys yet. Add one below, or paste a whole .env file into Raw."));
        } else {
            table = table.child(
                h_flex()
                    .h(px(30.))
                    .px(px(10.))
                    .gap(px(8.))
                    .bg(p.fg(0.03))
                    .border_b_1()
                    .border_color(p.border)
                    .text_size(px(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(muted)
                    .child(div().w(relative(0.34)).child("Key"))
                    .child(div().flex_1().child("Value"))
                    .child(div().w(px(98.))),
            );
        }
        let row_frame = |p: &Palette| h_flex().px(px(10.)).py(px(6.)).gap(px(8.)).items_start().border_t_1().border_color(p.fg(0.06));
        for (index, line) in parsed.lines.iter().enumerate() {
            let row = index + 1;
            let shown = self.env.revealed.contains(&line.id);
            let id = line.id;
            match &line.kind {
                LineKind::Blank => {}
                LineKind::Comment { .. } => {
                    let key = parked.get(&id).cloned();
                    let text = match &key {
                        Some(k) if !shown => format!("# {k}={MASK}"),
                        _ => line.raw.trim().to_string(),
                    };
                    table = table.child(
                        row_frame(&p)
                            .items_center()
                            .child(div().flex_1().min_h(px(30.)).flex().items_center().text_size(px(12.5)).italic().font_family("Menlo").text_color(muted).child(text))
                            .when_some(key, |el, k| {
                                el.child(h_flex().w(px(98.)).child(icon_button(SharedString::from(format!("env-park-{id}")), if shown { IconName::EyeOff } else { IconName::Eye }, shown, false, &p).on_click(
                                    cx.listener(move |this, _, window, cx| this.toggle_row(id, format!("commented {k}"), window, cx)),
                                )))
                            }),
                    );
                }
                LineKind::Malformed { reason } => {
                    let reason = *reason;
                    table = table.child(
                        row_frame(&p)
                            .child(
                                v_flex()
                                    .flex_1()
                                    .gap(px(4.))
                                    .child(div().rounded(px(7.)).border_1().border_dashed().border_color(p.border).px(px(10.)).py(px(7.)).font_family("Menlo").text_size(px(13.)).text_color(muted).child(if shown { line.raw.clone() } else { MASK.to_string() }))
                                    .child(hint(format!("{reason} Kept exactly as written. Edit it in Raw."), &p)),
                            )
                            .child(h_flex().w(px(98.)).child(icon_button(SharedString::from(format!("env-bad-{id}")), if shown { IconName::EyeOff } else { IconName::Eye }, shown, false, &p).on_click(
                                cx.listener(move |this, _, window, cx| this.toggle_row(id, format!("line {row}"), window, cx)),
                            ))),
                    );
                }
                LineKind::Entry(entry) => {
                    let Some(inputs) = self.env.rows.get(&id) else { continue };
                    let label = if entry.key.is_empty() { format!("row {row}") } else { entry.key.clone() };
                    let problem = key_problem(&entry.key, &duplicates);
                    let value_cell = match &inputs.value {
                        EnvValue::Single(input) => field(input, busy, &p).font_family("Menlo").into_any_element(),
                        EnvValue::Multi(editor) if shown => div().h(px(110.)).rounded(px(7.)).border_1().border_color(p.border).child(Editor::new(editor).h_full()).into_any_element(),
                        EnvValue::Multi(_) => div()
                            .h(px(36.))
                            .flex()
                            .items_center()
                            .rounded(px(7.))
                            .border_1()
                            .border_color(p.border)
                            .px(px(10.))
                            .font_family("Menlo")
                            .text_size(px(13.))
                            .text_color(muted)
                            .child(format!("{MASK}  {} lines", entry.value.lines().count()))
                            .into_any_element(),
                    };
                    let copy_label = label.clone();
                    let toggle_label = label.clone();
                    let value = entry.value.clone();
                    let just_copied = copied_row == Some(id);
                    table = table.child(
                        row_frame(&p)
                            .child(
                                v_flex()
                                    .w(relative(0.34))
                                    .gap(px(4.))
                                    .child(field(&inputs.key, busy, &p).font_family("Menlo"))
                                    .children(problem.map(|msg| div().text_size(px(12.)).line_height(px(17.)).text_color(p.red).child(msg))),
                            )
                            .child(div().flex_1().min_w_0().child(value_cell))
                            .child(
                                h_flex()
                                    .w(px(98.))
                                    .h(px(36.))
                                    .items_center()
                                    .gap(px(2.))
                                    .child(icon_button(SharedString::from(format!("env-show-{id}")), if shown { IconName::EyeOff } else { IconName::Eye }, shown, false, &p).on_click(cx.listener(move |this, _, window, cx| {
                                        this.toggle_row(id, toggle_label.clone(), window, cx)
                                    })))
                                    .child(icon_button(SharedString::from(format!("env-copy-{id}")), if just_copied { IconName::Check } else { IconName::Copy }, just_copied, busy, &p).when(!busy, |b| {
                                        b.on_click(cx.listener(move |this, _, window, cx| {
                                            let pending = Pending::Copy { value: zeroize::Zeroizing::new(value.clone()), label: copy_label.clone(), row: Some(id) };
                                            this.confirm_item("copy", copy_label.clone(), pending, window, cx);
                                        }))
                                    }))
                                    .child(icon_button(SharedString::from(format!("env-remove-{id}")), IconName::Trash, false, busy, &p).when(!busy, |b| {
                                        b.on_click(cx.listener(move |this, _, _, cx| this.commit_env(|doc| dotenv::remove_dotenv_line(doc, id), cx)))
                                    })),
                            ),
                    );
                }
            }
        }
        body.child(table)
            .child(h_flex().child(button("env-add", "Add key", Some(IconName::Plus), Tone::Quiet, busy, &p).ml(px(-8.)).when(!busy, |b| {
                b.on_click(cx.listener(|this, _, window, cx| {
                    this.commit_env(|doc| dotenv::add_dotenv_entry(doc, "", ""), cx);
                    if let Some(parsed) = this.env.parsed.clone() {
                        this.env_rows(&parsed, window, cx);
                    }
                }))
            })))
            .into_any_element()
    }

    fn toggle_row(&mut self, id: usize, label: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.env.revealed.remove(&id) {
            self.sync_env_masks(window, cx);
            cx.notify();
            return;
        }
        let file = self.opened.as_ref().map(|d| d.name.clone()).unwrap_or_default();
        self.confirm_item("reveal", format!("{label} in {file}"), Pending::Reveal(vec![id]), window, cx);
    }

    pub(super) fn render_opened(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let busy = self.busy;
        let Some(doc) = self.opened.as_ref() else { return div().into_any_element() };
        let dirty = doc.dirty;
        let has_id = doc.id.is_some();
        let is_env = doc.is_env();
        let is_text = matches!(doc.body, Body::Text { .. });
        let mixed = matches!(doc.body, Body::Text { newline: Newline::Mixed, .. });
        let icon = entry_icon(&doc.original_name);
        let head = h_flex()
            .gap(px(10.))
            .items_center()
            .child(div().flex_none().text_color(p.muted).child(Icon::new(icon)))
            .child(
                div().flex_1().min_w(px(180.)).child(
                    Styled::h(Input::new(&self.filename).disabled(busy), px(36.))
                        .px(px(8.))
                        .text_size(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .rounded(px(7.))
                        .bg(p.background)
                        .border_1()
                        .border_color(p.fg(0.0)),
                ),
            )
            .child(if dirty { chip("Unsaved changes", p.yellow, &p) } else { chip("Saved", p.green, &p) })
            .child(
                h_flex()
                    .gap(px(6.))
                    .child(button("vault-save", "Save", None, Tone::Primary, busy || !dirty, &p).when(!(busy || !dirty), |b| b.on_click(cx.listener(|this, _, window, cx| this.save(window, cx)))))
                    .child(button("vault-export", "Export…", Some(IconName::Download), Tone::Secondary, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.export_decrypted(window, cx)))))
                    .when(has_id, |el| {
                        el.child(button("vault-delete", "Delete", Some(IconName::Trash), Tone::Danger, busy, &p).when(!busy, |b| b.on_click(cx.listener(|this, _, window, cx| this.delete_opened(window, cx)))))
                    }),
            );
        let body = if is_env {
            self.render_env(window, cx)
        } else if is_text {
            v_flex()
                .gap(px(8.))
                .child(div().h(px(420.)).rounded(px(8.)).border_1().border_color(p.border).child(Editor::new(&self.text_editor).h_full()))
                .when(mixed, |el| el.child(hint("This note mixes line endings, so it opens read-only to keep them.", &p)))
                .into_any_element()
        } else if let Body::Docx(office) = &doc.body {
            v_flex()
                .gap(px(12.))
                .child(hint(
                    if office.can_edit { "Edit the text here. Page layout is not shown." } else { "This Word file has features Markie cannot edit, so it is read-only." },
                    &p,
                ))
                .children(self.private_runs.iter().map(|run| v_flex().gap(px(6.)).child(label(run.label.clone(), &p)).child(field(&run.input, busy || run.read_only, &p))))
                .into_any_element()
        } else {
            card(&p)
                .p(px(20.))
                .gap(px(6.))
                .child(h_flex().gap(px(8.)).items_center().child(Icon::new(IconName::ShieldCheck)).child(label("Stored encrypted", &p)))
                .child(div().text_size(px(13.)).line_height(px(19.)).text_color(p.muted).child("Markie cannot preview this kind of file. Export a copy to open it in another app. The copy keeps the original bytes."))
                .into_any_element()
        };
        let private_bar = self.render_private_bar(cx);
        v_flex().w_full().max_w(px(920.)).gap(px(16.)).child(head).children(private_bar).child(body).into_any_element()
    }

    /// The passphrase check that stands in when Touch ID cannot be used.
    fn render_gate(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (prompt, _) = self.gate.as_ref()?;
        let p = Self::palette(cx);
        let empty = self.gate_passphrase.read(cx).value().is_empty();
        let gate_busy = self.gate_busy;
        Some(
            card(&p)
                .p(px(14.))
                .gap(px(10.))
                .child(h_flex().gap(px(8.)).items_start().child(div().mt(px(1.)).text_color(p.muted).child(Icon::new(IconName::Lock).small())).child(div().flex_1().text_size(px(13.)).line_height(px(19.)).child(prompt.clone())))
                .child(
                    h_flex()
                        .gap(px(8.))
                        .child(div().flex_1().min_w(px(220.)).child(field(&self.gate_passphrase, gate_busy, &p)))
                        .child(button("vault-gate-ok", if gate_busy { "Checking…" } else { "Confirm" }, None, Tone::Primary, gate_busy || empty, &p).h(px(36.)).when(!(gate_busy || empty), |b| {
                            b.on_click(cx.listener(|this, _, window, cx| this.submit_gate(window, cx)))
                        }))
                        .child(button("vault-gate-cancel", "Cancel", None, Tone::Secondary, gate_busy, &p).h(px(36.)).when(!gate_busy, |b| {
                            b.on_click(cx.listener(|this, _, _, cx| {
                                this.gate = None;
                                cx.notify();
                            }))
                        })),
                )
                .into_any_element(),
        )
    }

    fn render_header(&self, unlocked: bool, cx: &mut Context<Self>) -> Div {
        let p = Self::palette(cx);
        let count = self.entries.len();
        h_flex()
            .flex_none()
            .h(px(56.))
            .items_center()
            .gap(px(10.))
            .border_b_1()
            .border_color(p.border)
            .px(px(20.))
            .child(div().flex_none().text_color(p.foreground).child(Icon::new(if unlocked { IconName::LockOpen } else { IconName::Lock })))
            .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child("Vault"))
            .child(if unlocked { chip("Unlocked", p.green, &p) } else { chip("Locked", p.muted, &p) })
            .when(unlocked, |el| el.child(hint(if count == 1 { "1 item".to_string() } else { format!("{count} items") }, &p)))
            .child(div().flex_1())
            .when(unlocked, |el| {
                el.child(button("vault-settings", "Settings", Some(IconName::Settings), Tone::Quiet, false, &p).when(self.settings_open, |b| b.bg(p.fg(0.08)).text_color(p.foreground)).on_click(cx.listener(
                    |this, _, window, cx| {
                        if this.settings_open {
                            this.close_settings(window, cx);
                        } else {
                            this.settings_open = true;
                            this.notice.clear();
                            cx.notify();
                        }
                    },
                )))
                .child(button("vault-lock", "Lock", Some(IconName::Lock), Tone::Secondary, false, &p).on_click(cx.listener(|this, _, window, cx| {
                    let dirty = this.opened.as_ref().is_some_and(|d| d.dirty);
                    cx.spawn_in(window, async move |this, cx| {
                        if dirty && !confirm(&this, cx, "Discard unsaved private edits? Save encrypted changes first to keep them.").await {
                            return;
                        }
                        this.update_in(cx, |this, window, cx| this.lock_now("", window, cx)).ok();
                    })
                    .detach();
                })))
            })
    }

    /// The whole page.
    pub(super) fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Self::palette(cx);
        let unlocked = !self.locked && !self.shielded;
        let page = v_flex()
            .id("vault-page")
            .size_full()
            .bg(p.background)
            .text_color(p.foreground)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, _| this.touched()))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.touched();
                let k = &event.keystroke;
                let m = &k.modifiers;
                if let Some(action) = shortcut(&k.key, m.platform, m.shift, m.alt, m.control)
                    && this.handle_shortcut(action, window, cx)
                {
                    cx.stop_propagation();
                }
            }))
            .child(self.render_header(unlocked, cx));
        if !unlocked {
            return page.child(self.render_locked(cx)).into_any_element();
        }
        let request = self.render_request(cx);
        let content = if let Some(sheet) = request {
            sheet
        } else if self.settings_open {
            self.render_settings(cx)
        } else if self.opened.is_some() {
            self.render_opened(window, cx)
        } else {
            self.render_empty(cx)
        };
        // Messages sit above the content they belong to, never in the header.
        let now = Instant::now();
        let copied = self.copied.as_ref().and_then(|c| c.remaining(now, markie_vault::clipboard::CLEAR_AFTER).map(|left| c.text(left)));
        let mut top = v_flex().w_full().max_w(px(920.)).gap(px(10.));
        let mut any = false;
        if let Some(gate) = self.render_gate(cx) {
            top = top.child(gate);
            any = true;
        }
        if !self.settings_open && self.request.is_none() {
            if let Some(e) = self.error_banner(&p) {
                top = top.child(e);
                any = true;
            }
            if let Some(text) = copied {
                top = top.child(banner(Kind::Success, text, &p));
                any = true;
            } else if !self.notice.is_empty() {
                top = top.child(banner(Kind::Info, self.notice.clone(), &p));
                any = true;
            }
        }
        if self.offer_touch_id && self.touch_id.available && !self.touch_id.enrolled && !self.settings_open && self.request.is_none() {
            let busy = self.busy;
            top = top.child(
                card(&p)
                    .p(px(12.))
                    .child(
                        h_flex()
                            .gap(px(10.))
                            .items_center()
                            .child(div().text_color(p.muted).child(Icon::new(IconName::FingerprintPattern)))
                            .child(div().flex_1().min_w_0().text_size(px(13.)).line_height(px(19.)).child("Unlock with Touch ID next time? Your passphrase still works."))
                            .child(button("vault-offer-yes", "Turn on…", None, Tone::Primary, busy, &p).when(!busy, |b| {
                                b.on_click(cx.listener(|this, _, _, cx| {
                                    this.offer_touch_id = false;
                                    this.settings_open = true;
                                    this.enrolling = true;
                                    this.focus_next = Some(this.enroll_passphrase.clone());
                                    cx.notify();
                                }))
                            }))
                            .child(button("vault-offer-no", "Not now", None, Tone::Quiet, false, &p).on_click(cx.listener(|this, _, _, cx| this.dismiss_touch_id_offer(cx)))),
                    ),
            );
            any = true;
        }
        page.child(
            h_flex().flex_1().min_h_0().child(self.render_sidebar(cx)).child(
                div()
                    .id("vault-content")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .overflow_y_scroll()
                    .px(px(28.))
                    .py(px(22.))
                    .child(v_flex().items_center().gap(px(16.)).when(any, |el| el.child(top)).child(content)),
            ),
        )
        .into_any_element()
    }
}

fn const_format_idle() -> &'static str {
    debug_assert_eq!(IDLE_LOCK.as_secs(), 300);
    "Locks after 5 minutes without use, and whenever the window is hidden. Copied secrets leave the clipboard after 30 seconds."
}


#[cfg(test)]
mod tests {
    use super::*;
    use ::core::prelude::v1::test;

    fn entry(name: &str) -> VaultEntry {
        VaultEntry { id: name.into(), name: name.into(), media_type: "text/plain".into(), bytes: 10, recovery: false }
    }

    #[test]
    fn search_shows_only_for_longer_lists() {
        assert!(!shows_search(0));
        assert!(!shows_search(SEARCH_AFTER));
        assert!(shows_search(SEARCH_AFTER + 1));
    }

    #[test]
    fn search_matches_names_ignoring_case_and_keeps_order() {
        let list = vec![entry("production.env"), entry("Server notes.txt"), entry("staging.ENV")];
        let names = |q: &str| matching(&list, q).into_iter().map(|e| e.name.clone()).collect::<Vec<_>>();
        assert_eq!(names("env"), ["production.env", "staging.ENV"]);
        assert_eq!(names("  NOTES "), ["Server notes.txt"]);
        assert_eq!(names("").len(), 3);
        assert!(names("missing").is_empty());
    }

    #[test]
    fn copy_feedback_counts_down_and_ends() {
        let at = Instant::now();
        let copied = CopyFeedback { label: "API_KEY".into(), row: Some(2), at };
        let clear = Duration::from_secs(30);
        assert_eq!(copied.remaining(at, clear), Some(30));
        assert_eq!(copied.remaining(at + Duration::from_millis(500), clear), Some(30));
        assert_eq!(copied.remaining(at + Duration::from_secs(29), clear), Some(1));
        assert_eq!(copied.remaining(at + clear, clear), None);
        assert_eq!(copied.remaining(at + Duration::from_secs(60), clear), None);
        assert_eq!(copied.text(12), "Copied API_KEY. Markie clears it from the clipboard in 12 s.");
    }

    #[test]
    fn keyboard_shortcuts() {
        assert_eq!(shortcut("s", true, false, false, false), Some(Shortcut::Save));
        assert_eq!(shortcut("f", true, false, false, false), Some(Shortcut::Search));
        assert_eq!(shortcut("escape", false, false, false, false), Some(Shortcut::Escape));
        // ⌘L belongs to Toggle Library; ⌘⇧F and plain letters are not the page's.
        assert_eq!(shortcut("l", true, false, false, false), None);
        assert_eq!(shortcut("f", true, true, false, false), None);
        assert_eq!(shortcut("f", false, false, false, false), None);
    }

    #[test]
    fn escape_closes_the_innermost_thing_first() {
        let none = EscapeState { gate: false, restore: false, enrolling: false, settings: false, query: false, error: false };
        assert_eq!(escape_target(&none), None);
        assert_eq!(escape_target(&EscapeState { query: true, ..none }), Some(Escape::Search));
        assert_eq!(escape_target(&EscapeState { settings: true, query: true, ..none }), Some(Escape::Settings));
        assert_eq!(escape_target(&EscapeState { settings: true, error: true, ..none }), Some(Escape::Error));
        assert_eq!(escape_target(&EscapeState { settings: true, enrolling: true, error: true, ..none }), Some(Escape::Enroll));
        assert_eq!(escape_target(&EscapeState { settings: true, restore: true, ..none }), Some(Escape::Restore));
        assert_eq!(escape_target(&EscapeState { gate: true, restore: true, settings: true, query: true, error: true, enrolling: true }), Some(Escape::Gate));
    }

    #[test]
    fn list_labels() {
        assert_eq!(human_size(640), "640 bytes");
        assert_eq!(human_size(1_234), "1.2 KB");
        assert_eq!(human_size(8_388_608), "8.4 MB");
        assert_eq!(kind_label(".env.local"), "Env keys");
        assert_eq!(kind_label("notes.md"), "Note");
        assert_eq!(kind_label("lease.PDF"), "PDF");
        assert_eq!(kind_label("contract.docx"), "Word");
        assert_eq!(kind_label("archive.zip"), "File");
    }

    #[test]
    fn user_visible_copy_has_no_em_dashes() {
        let source = include_str!("ui.rs");
        let em = char::from_u32(0x2014).unwrap();
        assert!(!source.contains(em));
    }
}
