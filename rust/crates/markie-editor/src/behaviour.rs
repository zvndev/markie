//! View mode behaviours from Electron that are not formatting: the rest of
//! TipTap's and Chromium's macOS keys, link clicks, right click, and files
//! dropped onto the document.
//!
//! * ⌘Enter runs `exitCode` in a code block and a hard break elsewhere
//!   (core keymap, then HardBreak).
//! * ⌃A and ⌃E go to the start and end of the textblock
//!   (`selectTextblockStart`/`End` in TipTap's macOS keymap).
//! * ⌃H, ⌃K, ⌃B, ⌃F, ⌃P, ⌃N and ⌘⌦ are Chromium's Cocoa text keys.
//! * A click on a web link opens it in the browser (`handleDocumentClick` in
//!   local-link.ts); a link to a file goes to the host to open.
//! * A right click selects the word under it, as Chromium does on macOS.
//!   Electron Markie installs no context menu, so none opens.
//! * A dropped file is linked where it lives (attach.rs); a dropped
//!   document is opened instead.

use std::path::PathBuf;

use gpui_kit::*;

use markie_rich::model::{Inline, Link, LinkStyle, Marks};

use super::attach::{self, AttachmentKind};
use super::{CONTEXT, RichEvent, RichView};
use markie_rich::editor::Pos;

actions!(
    rich_editor,
    [ModEnter, TextblockStart, TextblockEnd, SelectTextblockStart, SelectTextblockEnd, DeleteToLineEnd, DeleteToTextblockEnd]
);

pub(crate) fn bind_keys(cx: &mut App) {
    let c = Some(CONTEXT);
    cx.bind_keys([
        KeyBinding::new("cmd-enter", ModEnter, c),
        KeyBinding::new("ctrl-a", TextblockStart, c),
        KeyBinding::new("ctrl-e", TextblockEnd, c),
        KeyBinding::new("ctrl-shift-a", SelectTextblockStart, c),
        KeyBinding::new("ctrl-shift-e", SelectTextblockEnd, c),
        KeyBinding::new("ctrl-h", super::Backspace, c),
        KeyBinding::new("ctrl-k", DeleteToTextblockEnd, c),
        KeyBinding::new("cmd-delete", DeleteToLineEnd, c),
        KeyBinding::new("ctrl-b", super::MoveLeft, c),
        KeyBinding::new("ctrl-f", super::MoveRight, c),
        KeyBinding::new("ctrl-p", super::MoveUp, c),
        KeyBinding::new("ctrl-n", super::MoveDown, c),
    ]);
}

impl RichView {
    /// The handlers this module adds to the editor's root element.
    pub(crate) fn behaviour(d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        d.on_action(cx.listener(Self::on_mod_enter))
            .on_action(cx.listener(|this, _: &TextblockStart, _, cx| this.mv(cx, |e| e.move_leaf_edge(false, false))))
            .on_action(cx.listener(|this, _: &TextblockEnd, _, cx| this.mv(cx, |e| e.move_leaf_edge(true, false))))
            .on_action(cx.listener(|this, _: &SelectTextblockStart, _, cx| this.mv(cx, |e| e.move_leaf_edge(false, true))))
            .on_action(cx.listener(|this, _: &SelectTextblockEnd, _, cx| this.mv(cx, |e| e.move_leaf_edge(true, true))))
            .on_action(cx.listener(Self::on_delete_to_line_end))
            .on_action(cx.listener(Self::on_delete_to_textblock_end))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_right_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_link_up))
            .on_drop(cx.listener(Self::on_drop_paths))
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| {
                if ev.pressed_button.is_none() {
                    this.link_hover_move(ev.position, cx);
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _: &MouseDownEvent, _, cx| this.hide_link_card(cx)))
            .on_scroll(cx.listener(|this, _: &ScrollEvent, _, cx| this.hide_link_card(cx)))
    }

    fn on_mod_enter(&mut self, _: &ModEnter, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| {
            if !e.exit_code() {
                e.hard_break();
            }
        });
    }

    fn on_delete_to_line_end(&mut self, _: &DeleteToLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        let end = self.line_edge(true);
        self.delete_forward_to(end, cx);
    }

    fn on_delete_to_textblock_end(&mut self, _: &DeleteToTextblockEnd, _: &mut Window, cx: &mut Context<Self>) {
        let h = self.editor.head;
        let end = Pos { offset: self.editor.leaf_len(h.block, h.leaf), ..h };
        self.delete_forward_to(Some(end), cx);
    }

    fn delete_forward_to(&mut self, end: Option<Pos>, cx: &mut Context<Self>) {
        self.edit(cx, |e| {
            if e.has_selection() {
                e.delete_forward();
                return;
            }
            let h = e.head;
            match end {
                Some(end) if end > h => {
                    e.set_selection(h, end);
                    e.delete_forward();
                }
                // At the end already: join with what follows, like ⌦.
                _ => e.delete_forward(),
            }
        });
    }

    /// A right click on a word outside the selection selects that word.
    fn on_right_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus(window, cx);
        let Some(p) = self.hit(ev.position) else { return };
        let (a, b) = self.editor.range();
        if self.editor.has_selection() && a <= p && p <= b {
            return;
        }
        if self.editor.kind(p).is_some_and(|k| k.has_text()) {
            let units = self.editor.units(p.block, p.leaf);
            let (wa, wb) = markie_rich::editor::word_at(&units, p.offset);
            self.editor.set_selection(Pos { offset: wa, ..p }, Pos { offset: wb, ..p });
        } else {
            self.editor.set_caret(p, false);
        }
        cx.notify();
    }

    /// Remember a link under a plain click, to follow it on release.
    pub(crate) fn note_link_click(&mut self, p: Pos, clicks: usize, shift: bool) {
        self.link_click = None;
        if clicks != 1 || shift {
            return;
        }
        if let Some((_, _, l)) = self.editor.link_range(p) {
            self.link_click = Some(l.href.clone());
        }
    }

    fn on_link_up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(href) = self.link_click.take() else { return };
        // A drag that selected text is not a click.
        if self.editor.has_selection() {
            return;
        }
        match activation(&href, &self.cloud_links, self.base_dir.as_deref()) {
            Activation::Web(url) => cx.open_url(&url),
            Activation::Cloud(reference) => cx.emit(RichEvent::DocumentLink(reference)),
            // Preserve the existing local bound in restricted cloud copies.
            Activation::Local(markie_core::links::LinkClick::Refuse(why)) if self.restrict_local_media => self.show_notice(why, cx),
            Activation::Local(_) => cx.emit(RichEvent::OpenLocal(href)),
            Activation::Ignore => {}
        }
    }

    fn on_drop_paths(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let (docs, mut files): (Vec<PathBuf>, Vec<PathBuf>) = paths
            .paths()
            .iter()
            .cloned()
            .partition(|p| p.file_name().is_some_and(|n| attach::opens_as_document(&n.to_string_lossy())));
        if !docs.is_empty() {
            cx.emit(RichEvent::OpenPaths(docs));
        }
        files.retain(|f| f.exists());
        if files.is_empty() || self.read_only {
            return;
        }
        cx.emit(RichEvent::GrantAttachments(files.clone()));
        if let Some(p) = self.hit(window.mouse_position()) {
            self.editor.set_caret(p, false);
        }
        let dir = self.base_dir.clone();
        self.edit(cx, |e| {
            for f in &files {
                let a = attach::attachment_for(f, dir.as_deref());
                match a.kind {
                    AttachmentKind::Media => e.insert_image(&a.href, Some(&a.label)),
                    AttachmentKind::File => {
                        let link = Link { href: a.href.clone(), title: None, style: LinkStyle::Inline };
                        e.insert_inlines(vec![
                            Inline::marked(a.label.clone(), Marks { link: Some(link), ..Marks::default() }),
                            // A plain space, so what is typed next is not in the link.
                            Inline::text(" "),
                        ]);
                    }
                }
            }
        });
        self.focus(window, cx);
    }
}

/// What activating a link does. Every way of following a link in View mode
/// (a click, the preview card, an embed card) goes through here, so only a
/// plain web address ever reaches the system opener, and a local file goes
/// through `classify_click` (Electron's local-open-policy.js).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Activation {
    Web(String),
    /// A link to a Markie Cloud document (`DocumentLink`).
    Cloud(String),
    /// A file beside the document: open, reveal or refuse.
    Local(markie_core::links::LinkClick),
    Ignore,
}

pub fn activation(href: &str, cloud_links: &std::collections::HashSet<String>, doc_dir: Option<&std::path::Path>) -> Activation {
    use markie_core::links::{LinkClick, classify_click};
    // handleExternalLinkClick runs first, then the cloud and local rules.
    if let LinkClick::Web(url) = classify_click(href, None) {
        return Activation::Web(url);
    }
    let reference = super::media::reference_key(href);
    if cloud_links.contains(&reference) {
        return Activation::Cloud(reference);
    }
    match classify_click(href, doc_dir) {
        LinkClick::Ignore => Activation::Ignore,
        LinkClick::Web(url) => Activation::Web(url),
        other => Activation::Local(other),
    }
}

#[cfg(test)]
mod tests {
    use super::{Activation, activation};
    use markie_core::links::LinkClick;
    use std::collections::HashSet;

    fn never_opened(a: &Activation) -> bool {
        !matches!(a, Activation::Web(_) | Activation::Local(LinkClick::Open(_)))
    }

    #[test]
    fn scripts_bundles_and_other_schemes_never_reach_the_opener() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::create_dir(d.join("Tool.app")).unwrap();
        std::fs::write(d.join("setup.command"), b"echo").unwrap();
        let none = HashSet::new();
        for href in [
            "javascript:alert(1)",
            "JavaScript:void(0)",
            "file:///Applications/Calculator.app",
            "file://localhost/System/Applications/Utilities/Terminal.app",
            "x-apple.systempreferences:com.apple.preference.security",
            "vscode://file/etc/passwd",
            "my-custom-app:do-something",
            "data:text/html,<script>1</script>",
        ] {
            let a = activation(href, &none, Some(d));
            assert!(never_opened(&a), "{href} -> {a:?}");
        }
        // An app bundle or script beside the document is only shown in Finder.
        let real = d.canonicalize().unwrap();
        assert_eq!(activation("Tool.app", &none, Some(d)), Activation::Local(LinkClick::Reveal(real.join("Tool.app"))));
        assert_eq!(activation("./setup.command", &none, Some(d)), Activation::Local(LinkClick::Reveal(real.join("setup.command"))));
        assert!(matches!(activation("/Applications/Calculator.app", &none, Some(d)), Activation::Local(LinkClick::Refuse(_))));
        assert_eq!(activation("https://example.com/a", &none, Some(d)), Activation::Web("https://example.com/a".into()));
        assert_eq!(activation("mailto:a@b.c", &none, Some(d)), Activation::Ignore);
    }
}
