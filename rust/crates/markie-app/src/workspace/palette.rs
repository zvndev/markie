//! The command palette (⌘K), drawn like `src/components/command-palette.tsx`:
//! a 480pt panel 96pt from the top, a borderless field, and rows with the
//! group in small caps and the shortcut on the right. The commands, their
//! titles, groups and shortcuts follow Electron's list in `src/app/page.tsx`,
//! leaving out the ones Markie RS cannot run yet and adding its own few.
//! The ranking is Electron's `filterCommands`.

use std::rc::Rc;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::dialog_chrome::{self as chrome, Tokens};
use super::overlay::{Overlay, SettingsSection};
use super::{Mode, Workspace};
use crate::actions::*;

type Run = Rc<dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)>;

#[derive(Clone)]
pub(super) struct PaletteCommand {
    pub title: SharedString,
    pub group: &'static str,
    pub shortcut: Option<&'static str>,
    pub keywords: SharedString,
    pub run: Run,
}

fn action(a: impl Action + Clone) -> Run {
    Rc::new(move |_, window, cx| window.dispatch_action(Box::new(a.clone()), cx))
}

fn cmd(title: impl Into<SharedString>, group: &'static str, shortcut: Option<&'static str>, keywords: impl Into<SharedString>, run: Run) -> PaletteCommand {
    PaletteCommand { title: title.into(), group, shortcut, keywords: keywords.into(), run }
}

/// Every command, in Electron's order. The shortcuts sheet reads the same
/// list, so a shortcut shown anywhere is one that works.
pub(super) fn commands() -> Vec<PaletteCommand> {
    let mut list = vec![
        cmd("Open File…", "File", Some("⌘O"), "", action(Open)),
        cmd("New Markdown document", "File", None, "md markdown", Rc::new(|ws, w, cx| ws.create_document("md", w, cx))),
        cmd("New text document", "File", None, "txt plain", Rc::new(|ws, w, cx| ws.create_document("txt", w, cx))),
        cmd("Save", "File", Some("⌘S"), "", action(Save)),
        cmd("Duplicate (Fork)", "File", Some("⇧⌘D"), "copy fork duplicate", action(DuplicateDocument)),
        cmd("Reveal in Finder", "File", Some("⌥⌘R"), "finder explorer folder show reveal drag locate", action(RevealDocument)),
        cmd("Rich Mode", "View", Some("⌘1"), "preview rich wysiwyg formatted view", Rc::new(|ws, w, cx| ws.set_mode(Mode::View, w, cx))),
        cmd("Source Mode", "View", Some("⌘2"), "source raw markdown edit", Rc::new(|ws, w, cx| ws.set_mode(Mode::Source, w, cx))),
        cmd("Split Mode", "View", Some("⌘3"), "both side by side", Rc::new(|ws, w, cx| ws.set_mode(Mode::Split, w, cx))),
        cmd("Statistics", "View", Some("⇧⌘I"), "words count reading", action(ToggleStats)),
        cmd("Command Palette", "View", Some("⌘K"), "", Rc::new(|_, _, _| {})),
        cmd("Copy File Path", "File", None, "link location terminal clipboard", action(CopyPath)),
    ];
    for t in crate::themes::templates() {
        let id = t.id.clone();
        list.push(cmd(
            format!("Theme: {}", t.name),
            "Theme",
            None,
            format!("template style color font typography {}", t.description),
            Rc::new(move |ws, w, cx| ws.set_template(&id, w, cx)),
        ));
    }
    list.extend([
        cmd("Theme Settings…", "Theme", None, "color font preset style", Rc::new(|ws, w, cx| ws.open_settings(SettingsSection::Appearance, w, cx))),
        cmd("Settings…", "File", Some("⌘,"), "account sign in sync login", Rc::new(|ws, w, cx| ws.open_settings(SettingsSection::Account, w, cx))),
        cmd(
            "Default Apps for File Types…",
            "File",
            None,
            "open with finder double click default handler txt json yaml csv xml markdown associate",
            Rc::new(|ws, w, cx| ws.open_settings(SettingsSection::Files, w, cx)),
        ),
        cmd("Cloud…", "File", None, "synced shared sharing people cloud sync backup invited", action(ShowCloud)),
        cmd("Search All Documents…", "File", Some("⇧⌘F"), "find files everywhere full text global", action(FocusSearch)),
        cmd("New file", "File", Some("⌘N"), "blank create empty document", action(NewDocument)),
        cmd("History…", "File", None, "versions restore snapshot revert previous", action(ShowHistory)),
        cmd("Keyboard Shortcuts", "Help", Some("⌘/"), "help keys", action(ShowShortcuts)),
        // Markie RS has these as commands of their own; Electron has them in
        // the Library row menu and the title bar.
        cmd("Rename…", "File", None, "name file", action(RenameDocument)),
        cmd("Move to…", "File", None, "folder relocate", action(MoveDocument)),
        cmd("Move to Trash", "File", None, "delete remove", action(TrashDocument)),
        cmd("Star or Unstar", "File", None, "favorite pin", action(ToggleStar)),
        cmd("Outline", "View", Some("⌥⌘O"), "sections headings rail toc", action(ToggleOutline)),
        cmd("Add Folder to Library…", "File", Some("⇧⌘O"), "workspace root", action(OpenFolder)),
        cmd("Rescan Documents", "File", Some("⌘R"), "index refresh", action(Rescan)),
        cmd("Import Recents and Stars from Markie", "File", None, "electron migrate", action(ImportFromMarkie)),
        cmd("Sign In…", "File", None, "account sign in login", action(OpenAccount)),
        cmd("About Markie RS", "Help", None, "version", action(ShowAbout)),
    ]);
    list
}

/// Electron's `scoreMatch`: exact prefix > word prefix > substring >
/// subsequence.
pub(super) fn score_match(haystack: &str, query: &str) -> f32 {
    let h = haystack.to_lowercase();
    let q = query.to_lowercase();
    if q.is_empty() {
        return 1.;
    }
    let len = h.chars().count() as f32;
    if h.starts_with(&q) {
        return 100. - len * 0.01;
    }
    if h.split(|c: char| c.is_whitespace() || c == '/').any(|w| w.starts_with(&q)) {
        return 80. - len * 0.01;
    }
    if let Some(i) = h.find(&q) {
        return 60. - h[..i].chars().count() as f32 * 0.1;
    }
    let mut want = q.chars().peekable();
    for ch in h.chars() {
        if want.peek() == Some(&ch) {
            want.next();
        }
        if want.peek().is_none() {
            return 30. - len * 0.01;
        }
    }
    0.
}

/// Electron's `filterCommands`.
pub(super) fn filter(commands: Vec<PaletteCommand>, query: &str) -> Vec<PaletteCommand> {
    if query.trim().is_empty() {
        return commands;
    }
    let mut ranked: Vec<(f32, usize, PaletteCommand)> = commands
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let score = score_match(&c.title, query)
                .max(score_match(&c.keywords, query) * 0.9)
                .max(score_match(c.group, query) * 0.5);
            (score, i, c)
        })
        .filter(|(s, ..)| *s > 0.)
        .collect();
    // Stable, like Array.prototype.sort.
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    ranked.into_iter().map(|(.., c)| c).collect()
}

pub(super) struct PaletteState {
    pub input: Entity<InputState>,
    selected: usize,
    scroll: ScrollHandle,
    _sub: Subscription,
}

impl Workspace {
    pub(super) fn on_palette(&mut self, _: &CommandPalette, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.dialogs.open, Overlay::Palette(_)) {
            self.close_dialog(window, cx);
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Type a command…"));
        let sub = cx.subscribe(&input, |this, _, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                if let Overlay::Palette(p) = &mut this.dialogs.open {
                    p.selected = 0;
                    p.scroll.scroll_to_item(0);
                }
                cx.notify();
            }
        });
        self.show_dialog(
            Overlay::Palette(PaletteState { input, selected: 0, scroll: ScrollHandle::new(), _sub: sub }),
            window,
            cx,
        );
    }

    fn palette_results(&self, cx: &App) -> Vec<PaletteCommand> {
        let Overlay::Palette(p) = &self.dialogs.open else { return Vec::new() };
        filter(commands(), &p.input.read(cx).value())
    }

    /// Arrow keys move the selection; Return runs it.
    pub(super) fn palette_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let results = self.palette_results(cx);
        let Overlay::Palette(p) = &mut self.dialogs.open else { return false };
        let last = results.len().saturating_sub(1);
        match key {
            "down" => p.selected = (p.selected + 1).min(last),
            "up" => p.selected = p.selected.saturating_sub(1),
            "enter" => {
                let pick = results.get(p.selected.min(last)).cloned();
                if let Some(c) = pick {
                    self.run_palette(c, window, cx);
                }
                return true;
            }
            _ => return false,
        }
        p.scroll.scroll_to_item(p.selected);
        cx.notify();
        true
    }

    fn run_palette(&mut self, command: PaletteCommand, window: &mut Window, cx: &mut Context<Self>) {
        // Close first so focus is back on the document when it runs.
        self.close_dialog(window, cx);
        (command.run)(self, window, cx);
    }

    pub(super) fn render_palette(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let results = self.palette_results(cx);
        let Overlay::Palette(p) = &self.dialogs.open else { return div().into_any_element() };
        let selected = p.selected.min(results.len().saturating_sub(1));
        let input = p.input.clone();
        let scroll = p.scroll.clone();
        let hover = t.hover();
        self.panel(t, 12.)
            .w(px(480.))
            .max_w(relative(0.9))
            .overflow_hidden()
            .child(
                div()
                    .bg(t.field_bg())
                    .border_b_1()
                    .border_color(t.field_border())
                    .px(px(10.))
                    .py(px(5.))
                    .child(Input::new(&input).appearance(false).text_size(px(14.))),
            )
            .child(
                div()
                    .id("palette-list")
                    .max_h(px(288.))
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .py(px(6.))
                    .when(results.is_empty(), |el| {
                        el.child(div().px(px(16.)).py(px(12.)).text_size(px(12.)).text_color(t.muted).child("No commands match"))
                    })
                    .children(results.into_iter().enumerate().map(|(i, c)| {
                        let on = i == selected;
                        let shortcut = c.shortcut;
                        let (group, title) = (c.group, c.title.clone());
                        div()
                            .id(("palette-row", i))
                            .w_full()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(16.))
                            .px(px(16.))
                            .py(px(10.))
                            .text_size(px(13.))
                            .cursor_pointer()
                            .when_else(on, |el| el.bg(hover).text_color(t.foreground), |el| el.text_color(t.muted))
                            .on_mouse_move(cx.listener(move |this, _, _, cx| {
                                if let Overlay::Palette(p) = &mut this.dialogs.open {
                                    if p.selected != i {
                                        p.selected = i;
                                        cx.notify();
                                    }
                                }
                            }))
                            .on_click(cx.listener(move |this, _, window, cx| this.run_palette(c.clone(), window, cx)))
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .child(
                                        div()
                                            .text_size(px(10.))
                                            .opacity(0.5)
                                            .mr(px(8.))
                                            .child(chrome::spaced_caps(group)),
                                    )
                                    .child(title),
                            )
                            .when_some(shortcut, |el, s| el.child(div().text_size(px(11.)).opacity(0.6).child(s)))
                    })),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{commands, filter, score_match};

    #[test]
    fn ranks_like_electron() {
        assert!(score_match("Save", "sa") > score_match("Save As…", "sa"));
        assert!(score_match("Open File…", "file") > 70.);
        assert!(score_match("Statistics", "stcs") > 0.);
        assert_eq!(score_match("Save", "zz"), 0.);
        let hits = filter(commands(), "sav");
        assert_eq!(hits[0].title.as_ref(), "Save");
        assert_eq!(filter(commands(), "").len(), commands().len());
    }

    #[test]
    fn every_template_has_a_command() {
        assert_eq!(commands().iter().filter(|c| c.group == "Theme").count(), 9);
    }
}
