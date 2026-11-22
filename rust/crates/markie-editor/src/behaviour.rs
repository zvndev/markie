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
        let lower = href.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            if let Some(url) = attach::external_web_target(&href) {
                cx.open_url(&url);
            }
            return;
        }
        if lower.starts_with('#') || lower.contains("://") || lower.starts_with("mailto:") {
            return;
        }
        cx.emit(RichEvent::OpenLocal(href));
    }

    fn on_drop_paths(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let (docs, files): (Vec<PathBuf>, Vec<PathBuf>) = paths
            .paths()
            .iter()
            .cloned()
            .partition(|p| p.file_name().is_some_and(|n| attach::opens_as_document(&n.to_string_lossy())));
        if !docs.is_empty() {
            cx.emit(RichEvent::OpenPaths(docs));
        }
        if files.is_empty() || self.read_only {
            return;
        }
        if let Some(p) = self.hit(window.mouse_position()) {
            self.editor.set_caret(p, false);
        }
        let dir = self.base_dir.clone();
        self.edit(cx, |e| {
            for f in files.iter().filter(|f| f.exists()) {
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
