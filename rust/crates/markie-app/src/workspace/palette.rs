//! The command palette (⌘K): every menu command, searchable, with its
//! shortcut. Mirrors `src/components/command-palette.tsx`.

use gpui_kit::component::WindowExt as _;
use gpui_kit::component::command::{Command, CommandItem, CommandState};
use gpui_kit::*;

use super::Workspace;
use crate::actions::*;

fn commands() -> Vec<(&'static str, Box<dyn Action>, &'static [&'static str])> {
    vec![
        ("New document", Box::new(NewDocument), &["create", "file"]),
        ("Open…", Box::new(Open), &["file"]),
        ("Add folder to Library", Box::new(OpenFolder), &["workspace", "root"]),
        ("Save", Box::new(Save), &[]),
        ("Search documents", Box::new(FocusSearch), &["find", "library"]),
        ("Toggle View and Source", Box::new(ToggleMode), &["mode", "edit", "preview"]),
        ("Outline", Box::new(ToggleOutline), &["sections", "headings", "rail", "toc"]),
        ("Statistics", Box::new(ToggleStats), &["words", "count", "stats"]),
        ("Version history", Box::new(ShowHistory), &["versions", "restore", "snapshots"]),
        ("Rename document", Box::new(RenameDocument), &["file"]),
        ("Duplicate document", Box::new(DuplicateDocument), &["copy", "fork"]),
        ("Reveal in Finder", Box::new(RevealDocument), &["show", "folder"]),
        ("Copy path", Box::new(CopyPath), &["clipboard"]),
        ("Move to Trash", Box::new(TrashDocument), &["delete", "remove"]),
        ("Star or unstar document", Box::new(ToggleStar), &["favorite", "pin"]),
        ("Import recents and stars from Markie", Box::new(ImportFromMarkie), &["electron", "migrate"]),
        ("Rescan documents", Box::new(Rescan), &["index", "refresh"]),
        ("Toggle dark mode", Box::new(ToggleTheme), &["theme", "light", "appearance"]),
    ]
}

impl Workspace {
    pub(super) fn on_palette(&mut self, _: &CommandPalette, window: &mut Window, cx: &mut Context<Self>) {
        let state = cx.new(|cx| CommandState::new(window, cx));
        let focus = state.clone();
        window.defer(cx, move |window, cx| {
            let handle = focus.read(cx).focus_handle(cx);
            handle.focus(window, cx);
        });
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let state = state.clone();
            let owner = owner.clone();
            dialog.close_button(false).p_0().w(px(520.)).content(move |content, _, _| {
                let owner = owner.clone();
                content.child(
                    Command::new(&state)
                        .bordered(false)
                        .placeholder("Type a command")
                        .max_h(px(420.))
                        .items(commands().into_iter().map(|(label, action, keywords)| {
                            CommandItem::new().label(label).action(action).keywords(keywords.iter().copied())
                        }))
                        .on_confirm(move |index, window, cx| {
                            window.close_dialog(cx);
                            let Some((_, action, _)) = commands().into_iter().nth(index.row) else { return };
                            owner
                                .update(cx, |this, cx| {
                                    // The palette lives in the overlay layer, outside the
                                    // workspace, so run the action from the workspace.
                                    this.focus_handle.focus(window, cx);
                                    window.dispatch_action(action, cx);
                                })
                                .ok();
                        }),
                )
            })
        });
    }
}
