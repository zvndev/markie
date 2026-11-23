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

/// What the list depends on, as Electron's `commands` memo reads it.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct PaletteContext {
    /// A plain-text document is open (`plainText`): text export formats.
    pub plain_text: bool,
    /// A Word, RTF or ODT document is open (`documentsOpen`).
    pub office_open: bool,
    /// The open text document can be edited (`docEditable`).
    pub editable: bool,
    /// A CSV is open: no Make interactive.
    pub csv: bool,
    /// The super-nightly switch.
    pub nightly: bool,
}

/// Every command, in Electron's order (`commands` in `src/app/page.tsx`),
/// with the commands Markie RS adds at the end. The shortcuts sheet reads
/// the same list, so a shortcut shown anywhere is one that works.
pub(super) fn commands() -> Vec<PaletteCommand> {
    commands_for(PaletteContext { editable: true, ..PaletteContext::default() })
}

pub(super) fn commands_for(ctx: PaletteContext) -> Vec<PaletteCommand> {
    let mut list = vec![
        cmd("Open File…", "File", Some("⌘O"), "", action(Open)),
        cmd("New Markdown document", "File", None, "md markdown", Rc::new(|ws, w, cx| ws.create_document("md", w, cx))),
        cmd("New Word document", "File", None, "docx office", Rc::new(|ws, w, cx| ws.create_document("docx", w, cx))),
        cmd("New text document", "File", None, "txt plain", Rc::new(|ws, w, cx| ws.create_document("txt", w, cx))),
        cmd("New Darkmown document", "File", None, "wd interactive state", Rc::new(|ws, w, cx| ws.create_document("wd", w, cx))),
    ];
    // Super-nightly in Electron (`makeInteractiveAvailable`), and only for a
    // Markdown document.
    if ctx.nightly && !ctx.office_open && !ctx.plain_text && !ctx.csv {
        list.push(cmd("Make interactive", "File", None, "darkmown wd live doc interactive convert copy checklist calculator", action(MakeInteractive)));
    }
    list.extend([
        cmd("Open Vault", "File", None, "locked private secure passphrase env keys secrets environment", Rc::new(|ws, w, cx| ws.open_vault(w, cx))),
        cmd("Save", "File", Some("⌘S"), "", action(Save)),
        cmd("Save As…", "File", Some("⇧⌘S"), "", action(SaveAs)),
        cmd("Duplicate (Fork)", "File", Some("⇧⌘D"), "copy fork duplicate", action(DuplicateDocument)),
        cmd(crate::menus::reveal_label(), "File", Some("⌥⌘R"), "finder explorer folder show reveal drag locate", action(RevealDocument)),
        // Electron lists ⇧⌘E beside Export PDF (Dark) but binds no key to it;
        // in a rich pane ⇧⌘E centres text, here as there.
        cmd("Export PDF (Dark)", "File", Some("⇧⌘E"), "print", action(ExportPdfDark)),
        cmd("Export PDF (Light)", "File", None, "print", action(ExportPdfLight)),
        cmd("Export HTML", "File", None, "", action(ExportHtml)),
        // The "Export as" rows follow here (palette_results, export_as_commands).
    ]);
    list.extend([
        cmd("Rich Mode", "View", Some("⌘1"), "preview rich wysiwyg formatted view", Rc::new(|ws, w, cx| ws.set_mode(Mode::View, w, cx))),
        cmd("Source Mode", "View", Some("⌘2"), "source raw markdown edit", Rc::new(|ws, w, cx| ws.set_mode(Mode::Source, w, cx))),
        cmd("Split Mode", "View", Some("⌘3"), "both side by side", Rc::new(|ws, w, cx| ws.set_mode(Mode::Split, w, cx))),
        cmd("Statistics", "View", Some("⇧⌘I"), "words count reading", action(ToggleStats)),
        cmd("Command Palette", "View", Some("⌘K"), "", Rc::new(|_, _, _| {})),
        cmd("Find…", "View", Some("⌘F"), "search find text", action(super::source::EditFind)),
        cmd("Find and Replace…", "View", Some("⌥⌘F"), "search find replace all substitute", action(super::source::FindReplace)),
        cmd("Copy File Path", "File", None, "link location terminal clipboard", action(CopyPath)),
        cmd("Copy Document Contents", "File", None, "clipboard markdown text", Rc::new(|ws, _, cx| ws.copy_all(cx))),
        cmd("Format Tables", "Format", Some("⌥⌘T"), "align prettify pipes", action(super::source::FormatTables)),
    ]);
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
        cmd("Connect an Agent (MCP)…", "File", None, "mcp claude codex ai agent tools search documents", Rc::new(|ws, w, cx| ws.open_agents(w, cx))),
        cmd(
            "Default Apps for File Types…",
            "File",
            None,
            "open with finder double click default handler txt json yaml csv xml markdown associate",
            Rc::new(|ws, w, cx| ws.open_settings(SettingsSection::Files, w, cx)),
        ),
        cmd("Search All Documents…", "File", Some("⇧⌘F"), "find files everywhere full text docx rtf word grep content global", action(FocusSearch)),
        cmd("Library…", "File", Some("⌘L"), "documents cloud sync files recent projects organize workspace group", action(ToggleLibrary)),
        cmd("Browse all documents…", "File", None, "all files device skills index find", Rc::new(|ws, _, cx| ws.select_view(super::rail::LeftView::Browse, cx))),
        cmd("Cloud…", "File", None, "synced shared sharing people cloud sync backup invited", action(ShowCloud)),
        cmd("Skills & agent files…", "File", None, "claude agents codex gemini cursor instructions", Rc::new(|ws, w, cx| {
            // As the rail button does: the panel is built on first show.
            ws.prepare_skills(w, cx);
            ws.select_view(super::rail::LeftView::Skills, cx);
        })),
        cmd("New file", "File", Some("⌘N"), "blank create empty document", action(NewDocument)),
        cmd("Share…", "File", None, "collaborate invite live people sync cloud link", Rc::new(|ws, w, cx| ws.open_share(w, cx))),
        cmd("History…", "File", None, "versions restore snapshot revert previous", action(ShowHistory)),
        cmd("Keyboard Shortcuts", "Help", Some("⌘/"), "help keys", action(ShowShortcuts)),
    ]);
    if ctx.nightly {
        list.push(cmd("Live Docs…", "File", None, "darkmown projects site wd skin api edit folder", Rc::new(|ws, _, cx| ws.select_view(super::rail::LeftView::LiveDocs, cx))));
        list.push(cmd("Open Darkmown project preview…", "File", None, "darkmown live docs site project dev server localhost wd run", Rc::new(|ws, w, cx| ws.open_live_preview(w, cx))));
    }
    // Markie RS has these as commands of their own; Electron has them in
    // the Library row menu and the title bar.
    list.extend([
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
    // The filter at the end of Electron's memo.
    const HIDDEN_FOR_DOCUMENTS: [&str; 10] =
        ["Export PDF (Dark)", "Export PDF (Light)", "Export HTML", "Rich Mode", "Source Mode", "Split Mode", "Statistics", "Copy File Path", "Copy Document Contents", "Format Tables"];
    list.retain(|c| {
        if c.title.as_ref() == "Format Tables" && !ctx.editable {
            return false;
        }
        !(ctx.office_open && (HIDDEN_FOR_DOCUMENTS.contains(&c.title.as_ref()) || c.title.as_ref() == crate::menus::reveal_label()))
    });
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

    fn palette_context(&self) -> PaletteContext {
        let doc = self.doc.as_ref();
        let text = doc.filter(|d| matches!(d.kind, super::DocKind::Text { .. }));
        PaletteContext {
            plain_text: text.is_some_and(|d| d.format == markie_core::formats::FormatKind::Text),
            office_open: doc.is_some_and(|d| matches!(d.kind, super::DocKind::Office(_))),
            editable: text.is_some_and(|d| !d.large),
            csv: doc.is_some_and(|d| d.format == markie_core::formats::FormatKind::Csv),
            nightly: super::comments::nightly(self.registry.as_deref()),
        }
    }

    fn palette_results(&self, cx: &App) -> Vec<PaletteCommand> {
        let Overlay::Palette(p) = &self.dialogs.open else { return Vec::new() };
        let ctx = self.palette_context();
        let mut list = commands_for(ctx);
        if let Some(super::OpenDoc { kind: super::DocKind::Office(office), .. }) = &self.doc
            && !self.workspace_page_open()
        {
            // The Word document brings its own Find and Replace… (⌘F).
            list.retain(|c| !matches!(c.title.as_ref(), "Find…" | "Find and Replace…"));
            let view = office.view.clone();
            for id in view.read(cx).palette_commands() {
                let found = markie_office_view::commands::COMMANDS.iter().find(|(_, key, _)| *key == id);
                let Some((group, label)) = found.map(|(group, _, label)| (*group, *label))
                    .or_else(|| (id == "find").then_some(("View", "Find and Replace…"))) else { continue };
                let view = view.clone();
                list.push(cmd(label, group, (id == "find").then_some("⌘F"), id, Rc::new(move |_, window, cx| {
                    view.update(cx, |view, cx| view.command(id, window, cx));
                })));
            }
        }
        // Electron puts the open document's enabled commands just before Save.
        let at = list.iter().position(|c| c.title.as_ref() == "Save").unwrap_or(0);
        let darkmown = self.darkmown_palette().into_iter().map(|(title, mode)| {
            cmd(title, "View", None, "", Rc::new(move |ws, _, cx| ws.darkmown_command(mode, cx)))
        });
        list.splice(at..at, darkmown);
        if let Some(at) = list.iter().position(|c| c.title.as_ref() == "Export HTML") {
            list.splice(at + 1..at + 1, self.export_as_commands());
        }
        filter(list, &p.input.read(cx).value())
    }

    /// page.tsx's `exportFormatsFor(plainText ? "text" : "markdown")` rows, for
    /// a document that is not a Word, RTF or ODT one.
    fn export_as_commands(&self) -> Vec<PaletteCommand> {
        use super::export::ExportKind;
        use markie_export::convert::{ExportFormat, SourceKind};
        let Some(doc) = &self.doc else { return Vec::new() };
        if matches!(doc.kind, super::DocKind::Office(_)) {
            return Vec::new();
        }
        let source = if doc.format == markie_core::formats::FormatKind::Markdown { SourceKind::Markdown } else { SourceKind::Text };
        [
            (ExportFormat::Docx, ExportKind::Docx),
            (ExportFormat::Rtf, ExportKind::Rtf),
            (ExportFormat::Odt, ExportKind::Odt),
            (ExportFormat::Txt, ExportKind::Txt),
            (ExportFormat::Md, ExportKind::Md),
        ]
        .into_iter()
        .filter(|(format, _)| match source {
            SourceKind::Markdown => *format != ExportFormat::Md,
            SourceKind::Text => *format != ExportFormat::Txt,
        })
        .map(|(format, kind)| {
            let info = format.info();
            cmd(
                format!("Export as {}", info.label),
                "File",
                None,
                format!("export convert {}", info.extension),
                Rc::new(move |ws, w, cx| ws.export_document(kind, w, cx)),
            )
        })
        .collect()
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
    use super::{PaletteContext, commands, commands_for, filter, score_match};

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

    /// Electron's titles, in Electron's order, for a Markdown document.
    #[test]
    fn commands_follow_electrons_list() {
        let titles: Vec<String> = commands_for(PaletteContext { editable: true, ..Default::default() }).iter().map(|c| c.title.to_string()).collect();
        let electron = [
            "Open File…", "New Markdown document", "New Word document", "New text document", "New Darkmown document", "Open Vault",
            "Save", "Save As…", "Duplicate (Fork)", "Reveal in Finder", "Export PDF (Dark)", "Export PDF (Light)", "Export HTML",
            // The "Export as" rows go here at run time (export_as_commands).
            "Rich Mode", "Source Mode", "Split Mode", "Statistics", "Command Palette", "Find…", "Find and Replace…",
            "Copy File Path", "Copy Document Contents", "Format Tables",
        ];
        assert_eq!(titles[..electron.len()], electron);
        let tail = [
            "Theme Settings…", "Settings…", "Connect an Agent (MCP)…", "Default Apps for File Types…", "Search All Documents…",
            "Library…", "Browse all documents…", "Cloud…", "Skills & agent files…", "New file", "Share…", "History…", "Keyboard Shortcuts",
        ];
        let start = titles.iter().position(|t| t == "Theme Settings…").unwrap();
        assert_eq!(titles[start..start + tail.len()], tail);
    }

    #[test]
    fn context_filters_like_electron() {
        let titles = |ctx| commands_for(ctx).iter().map(|c| c.title.to_string()).collect::<Vec<_>>();
        let office = titles(PaletteContext { office_open: true, ..Default::default() });
        for gone in ["Rich Mode", "Export HTML", "Copy File Path", "Format Tables", "Reveal in Finder"] {
            assert!(!office.contains(&gone.to_string()), "{gone} is hidden for a Word document");
        }
        assert!(!titles(PaletteContext::default()).contains(&"Format Tables".to_string()), "read-only documents have no Format Tables");
        let nightly = titles(PaletteContext { nightly: true, editable: true, ..Default::default() });
        assert!(nightly.contains(&"Make interactive".to_string()) && nightly.contains(&"Live Docs…".to_string()));
        assert!(!titles(PaletteContext { nightly: true, csv: true, ..Default::default() }).contains(&"Make interactive".to_string()));
    }

    /// Electron's `filterCommands`, run by
    /// rust/scripts/parity/library-settings-parity.mjs on the same commands.
    #[test]
    fn ranking_matches_electrons_filter_commands() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/library-settings-parity.json")).unwrap();
        let groups = ["File", "View", "Format", "Theme", "Help"];
        let list: Vec<super::PaletteCommand> = fixture["palette"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let group = groups.into_iter().find(|g| *g == c["group"].as_str().unwrap()).unwrap();
                super::cmd(c["title"].as_str().unwrap().to_string(), group, None, c["keywords"].as_str().unwrap().to_string(), std::rc::Rc::new(|_, _, _| {}))
            })
            .collect();
        let results = fixture["palette"]["results"].as_object().unwrap();
        assert_eq!(results.len(), 16);
        for (query, want) in results {
            let got: Vec<String> = filter(list.clone(), query).iter().map(|c| c.title.to_string()).collect();
            let want: Vec<String> = want.as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
            assert_eq!(got, want, "query {query:?}");
        }
    }

    #[test]
    fn every_template_has_a_command() {
        assert_eq!(commands().iter().filter(|c| c.group == "Theme").count(), 9);
    }

    #[test]
    fn export_commands_follow_electrons_list() {
        let all = commands();
        let titles: Vec<&str> = all.iter().map(|c| c.title.as_ref()).collect();
        let at = titles.iter().position(|t| *t == "Reveal in Finder").unwrap();
        assert_eq!(&titles[at + 1..at + 4], ["Export PDF (Dark)", "Export PDF (Light)", "Export HTML"]);
        assert_eq!(all[at + 1].shortcut, Some("⇧⌘E"));
    }
}
