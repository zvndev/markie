//! The menu bar, built like Electron's template (`electron/main.js` around
//! line 3700) after `document-menu.js` `install` has merged the document
//! commands into it: the app menu, File, Edit, the Word menus (Format,
//! Insert, Layout, Review), View, Window and Help, in that order, with
//! Electron's labels, separators and shortcuts.
//!
//! Left out on purpose: the developer tools item, and Check for Updates… in
//! every build but the installed nightly (updates.rs), the only one
//! with an updater. Commands Markie RS has that Electron keeps
//! elsewhere (Rename, Move, Trash, Copy Path, Cloud, Vault, Rescan) stay in
//! the command palette and their shortcuts, not in the menu bar.

use gpui_kit::*;

use crate::actions::*;

/// What the menus depend on, the way `refreshRevertMenuItem` and the
/// super-nightly gate decide them in Electron.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MenuState {
    /// The open document has versions: History… is enabled.
    pub has_history: bool,
    /// Make Interactive is shown only in a super-nightly build.
    pub nightly: bool,
    /// A Word, RTF or ODT document is open: document-menu.js labels the
    /// Export submenu's light PDF "Export PDF…" for it.
    pub word: bool,
    /// This build updates itself (the nightly, installed): the app menu
    /// has Check for Updates…. `install` sets it; callers leave it alone.
    pub updates: bool,
    /// Go › Back and Go › Forward have somewhere to go.
    pub back: bool,
    pub forward: bool,
}

fn item(label: &str, action: impl Action) -> MenuItem {
    MenuItem::action(label.to_string(), action)
}

pub fn build(state: MenuState) -> Vec<Menu> {
    // Electron's app menu has Check for Updates… right under About.
    let mut about = vec![item(&format!("About {}", markie_core::paths::APP_NAME), ShowAbout)];
    if state.updates {
        about.push(item("Check for Updates…", crate::updates::CheckForUpdates));
    }
    let app = Menu {
        name: markie_core::paths::APP_NAME.into(),
        items: about.into_iter().chain([
            MenuItem::separator(),
            item("Settings…", OpenSettings),
            item("Default Apps for File Types…", DefaultApps),
            MenuItem::separator(),
            item(&format!("Hide {}", markie_core::paths::APP_NAME), HideApp),
            item("Hide Others", HideOthers),
            item("Show All", ShowAll),
            MenuItem::separator(),
            item(&format!("Quit {}", markie_core::paths::APP_NAME), Quit),
        ]).collect(),
        disabled: false,
    };

    let mut file = vec![
        item("New File", NewDocument),
        item("Open…", Open),
        MenuItem::separator(),
        item("Library…", ToggleLibrary),
        item("Search All Documents…", FocusSearch),
        MenuItem::separator(),
        item("Save", Save),
        item("Save As…", SaveAs),
        item("History…", ShowHistory).disabled(!state.has_history),
        item("Duplicate (Fork)", DuplicateDocument),
        item(reveal_label(), RevealDocument),
        item("Make Private…", MakePrivate),
        MenuItem::separator(),
        item("Print…", Print),
        MenuItem::submenu(Menu {
            name: "Export".into(),
            items: vec![
                item("PDF (Dark)…", ExportPdfDark),
                item(if state.word { "Export PDF…" } else { "PDF (Light)…" }, ExportPdfLight),
                item("HTML…", ExportHtml),
            ],
            disabled: false,
        }),
        // document-menu.js puts the document File commands before the
        // last separator.
        MenuItem::separator(),
        item("New Markdown Document", NewMarkdownDocument),
        item("New Word Document", NewWordDocument),
        item("New Text Document", NewTextDocument),
        item("New Darkmown Document", NewDarkmownDocument),
    ];
    // Under Open…, only when this build carries a Google Desktop OAuth client.
    file.splice(2..2, crate::workspace::google_docs::menu_items());
    if state.nightly {
        file.push(item("Make Interactive", MakeInteractive));
    }
    file.extend([item("Document Details…", DocumentDetails), MenuItem::separator(), item("Close Window", CloseWindow)]);

    // One Edit menu: the editors' `source::edit_menu`, Electron's items,
    // each sent to the editor with focus.
    let edit = crate::workspace::source::edit_menu();

    let mut view = vec![
        item("Rich Text", RichMode),
        item("Markdown Source", SourceMode),
        item("Split", SplitMode),
        MenuItem::separator(),
        item("Zoom In", ZoomIn),
        item("Zoom Out", ZoomOut),
        item("Actual Size", ZoomReset),
        item("Wider Page", PageWider),
        item("Narrower Page", PageNarrower),
        MenuItem::separator(),
        item("Command Palette…", CommandPalette),
        item("Theme…", ShowTheme),
        item("Keyboard Shortcuts", ShowShortcuts),
        item("Statistics", ToggleStats),
        MenuItem::separator(),
        item("Toggle Full Screen", ToggleFullScreen),
    ];
    // document-menu.js appends the document View commands after a
    // separator, straight into View: the Word layouts, then Darkmown's
    // three views (document-menu-commands.json order).
    view.push(MenuItem::separator());
    view.extend(markie_office_view::actions::view_menu_items());
    view.extend([
        item("Darkmown Source", DarkmownSourceView),
        item("Darkmown Preview", DarkmownPreviewView),
        item("Darkmown Source and Preview", DarkmownSplitView),
    ]);
    // Markie RS's Vault page, which Electron opens from the rail and the
    // palette; kept here for the menu-bar route.
    view.extend([MenuItem::separator(), item("Vault", crate::workspace::vault::ToggleVault)]);

    let mut menus = vec![app, Menu { name: "File".into(), items: file, disabled: false }, edit];
    // The Word menus sit between Edit and View, as `install` splices them.
    menus.extend(markie_office_view::actions::menus());
    menus.push(Menu { name: "View".into(), items: view, disabled: false });
    // Finder's and Preview's Go menu: Back and Forward between places, with
    // ⌘[ and ⌘]. Electron has none; Markie RS adds it (workspace/nav.rs).
    menus.push(Menu {
        name: "Go".into(),
        items: vec![item("Back", NavigateBack).disabled(!state.back), item("Forward", NavigateForward).disabled(!state.forward)],
        disabled: false,
    });
    menus.push(Menu {
        name: "Window".into(),
        items: vec![item("Minimize", MinimizeWindow), item("Zoom", ZoomWindow), MenuItem::separator(), item("Bring All to Front", BringAllToFront)],
        disabled: false,
    });
    let mut help = vec![item(crate::logs::reveal_menu_label(), crate::logs::RevealCrashLog)];
    if cfg!(target_os = "macos") {
        help.push(item("Reveal Native Crash Report", crate::logs::RevealNativeCrashReport));
    }
    menus.push(Menu { name: "Help".into(), items: help, disabled: false });
    menus
}

/// Electron's reveal label per platform.
pub fn reveal_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Reveal in Finder"
    } else if cfg!(target_os = "windows") {
        "Show in Explorer"
    } else {
        "Show in File Manager"
    }
}

thread_local! {
    static INSTALLED: std::cell::Cell<Option<MenuState>> = const { std::cell::Cell::new(None) };
}

/// Whether any menu bar has been set yet.
pub fn is_installed() -> bool {
    INSTALLED.with(|s| s.get()).is_some()
}

/// Sets the menu bar, only when what it depends on changed.
pub fn install(state: MenuState, cx: &mut App) {
    let state = MenuState { updates: crate::updates::active(), ..state };
    if INSTALLED.with(|s| s.get()) == Some(state) {
        return;
    }
    INSTALLED.with(|s| s.set(Some(state)));
    cx.set_menus(build(state));
}

/// The window and app items Electron leaves to menu roles.
pub fn bind_app_actions(cx: &mut App) {
    cx.on_action(|_: &HideApp, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &BringAllToFront, cx| cx.activate(true));
}

/// Shortcuts the menu shows that no other module binds. Electron's
/// accelerators; an editor's own binding for the same keys wins inside it.
/// The Edit menu's keys are `source::bind_keys`.
pub fn key_bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("cmd-shift-s", SaveAs, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", MinimizeWindow, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
        KeyBinding::new("cmd-h", HideApp, None),
        KeyBinding::new("cmd-alt-h", HideOthers, None),
    ]
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob export brings its own `test` attribute.
    use super::{MenuState, build, key_bindings};
    use gpui_kit::{Keystroke, Menu, MenuItem};

    fn labels(items: &[MenuItem]) -> Vec<String> {
        items
            .iter()
            .map(|i| match i {
                MenuItem::Separator => "-".to_string(),
                MenuItem::Action { name, .. } => name.to_string(),
                MenuItem::Submenu(m) => format!("{} >", m.name),
                MenuItem::SystemMenu(m) => format!("{} >", m.name),
            })
            .collect()
    }

    fn menu<'a>(menus: &'a [Menu], name: &str) -> &'a Menu {
        menus.iter().find(|m| m.name.as_ref() == name).unwrap_or_else(|| panic!("no {name} menu"))
    }

    #[test]
    fn check_for_updates_sits_under_about_only_in_a_build_that_updates() {
        let without = build(MenuState::default());
        assert!(!labels(&without[0].items).contains(&"Check for Updates…".to_string()));
        let with = build(MenuState { updates: true, ..Default::default() });
        assert_eq!(labels(&with[0].items)[..3], ["About Markie RS", "Check for Updates…", "-"]);
        assert_eq!(labels(&with[0].items).len(), labels(&without[0].items).len() + 1);
    }

    #[test]
    fn menus_come_in_electrons_order() {
        let menus = build(MenuState::default());
        let names: Vec<&str> = menus.iter().map(|m| m.name.as_ref()).collect();
        assert_eq!(names, ["Markie RS", "File", "Edit", "Format", "Insert", "Layout", "Review", "View", "Go", "Window", "Help"]);
    }

    #[test]
    fn file_menu_matches_electron() {
        let menus = build(MenuState { has_history: true, ..Default::default() });
        assert_eq!(
            labels(&menu(&menus, "File").items),
            [
                "New File", "Open…", "-", "Library…", "Search All Documents…", "-", "Save", "Save As…", "History…",
                // Make Private… is Markie RS's own (docs/rust-port/PRIVATE-FILES.md).
                "Duplicate (Fork)", "Reveal in Finder", "Make Private…", "-", "Print…", "Export >", "-", "New Markdown Document",
                "New Word Document", "New Text Document", "New Darkmown Document", "Document Details…", "-", "Close Window",
            ]
        );
        let MenuItem::Submenu(export) = &menu(&menus, "File").items[14] else { panic!() };
        assert_eq!(labels(&export.items), ["PDF (Dark)…", "PDF (Light)…", "HTML…"]);
        let nightly = build(MenuState { has_history: true, nightly: true, ..Default::default() });
        let word = build(MenuState { word: true, ..Default::default() });
        let MenuItem::Submenu(export) = &menu(&word, "File").items[14] else { panic!() };
        assert_eq!(labels(&export.items), ["PDF (Dark)…", "Export PDF…", "HTML…"]);
        assert!(labels(&menu(&nightly, "File").items).contains(&"Make Interactive".to_string()));
    }

    #[test]
    fn history_is_greyed_until_the_document_has_versions() {
        let find = |state| {
            let menus = build(state);
            menu(&menus, "File").items.iter().find_map(|i| match i {
                MenuItem::Action { name, disabled, .. } if name.as_ref() == "History…" => Some(*disabled),
                _ => None,
            })
        };
        assert_eq!(find(MenuState { has_history: false, ..Default::default() }), Some(true));
        assert_eq!(find(MenuState { has_history: true, ..Default::default() }), Some(false));
    }

    #[test]
    fn go_has_back_and_forward_greyed_with_nowhere_to_go() {
        let state = |menus: &[Menu]| -> Vec<(String, bool)> {
            menu(menus, "Go")
                .items
                .iter()
                .filter_map(|i| match i {
                    MenuItem::Action { name, disabled, .. } => Some((name.to_string(), *disabled)),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(state(&build(MenuState::default())), [("Back".to_string(), true), ("Forward".to_string(), true)]);
        assert_eq!(state(&build(MenuState { back: true, ..Default::default() })), [("Back".to_string(), false), ("Forward".to_string(), true)]);
        assert_eq!(state(&build(MenuState { forward: true, ..Default::default() })), [("Back".to_string(), true), ("Forward".to_string(), false)]);
    }

    #[test]
    fn edit_view_window_and_help_match_electron() {
        let menus = build(MenuState::default());
        assert_eq!(
            labels(&menu(&menus, "Edit").items),
            ["Undo", "Redo", "-", "Cut", "Copy", "Paste", "Select All", "-", "Find…", "Find and Replace…", "-", "Format Tables"]
        );
        let view = labels(&menu(&menus, "View").items);
        assert_eq!(
            view[..16],
            [
                "Rich Text", "Markdown Source", "Split", "-", "Zoom In", "Zoom Out", "Actual Size", "Wider Page",
                "Narrower Page", "-", "Command Palette…", "Theme…", "Keyboard Shortcuts", "Statistics", "-",
                "Toggle Full Screen",
            ]
        );
        assert_eq!(labels(&menu(&menus, "Window").items), ["Minimize", "Zoom", "-", "Bring All to Front"]);
        assert_eq!(labels(&menu(&menus, "Help").items), ["Reveal Crash Log in Finder", "Reveal Native Crash Report"]);
        let tail = &view[16..];
        assert_eq!(tail.first().map(String::as_str), Some("-"), "the document View commands follow a separator");
        for name in ["Darkmown Source", "Darkmown Preview", "Darkmown Source and Preview", "Vault"] {
            assert_eq!(view.iter().filter(|l| l.as_str() == name).count(), 1, "{name}");
        }
        assert_eq!(menus.iter().filter(|m| m.name.as_ref() == "Edit").count(), 1, "exactly one Edit menu");
        assert_eq!(
            labels(&menus[0].items),
            ["About Markie RS", "-", "Settings…", "Default Apps for File Types…", "-", "Hide Markie RS", "Hide Others", "Show All", "-", "Quit Markie RS"]
        );
    }

    /// Every accelerator in Electron's template has the same keys here,
    /// bound to the item it sits on.
    #[test]
    fn electron_accelerators_reach_their_items() {
        let mut all = crate::key_bindings();
        all.extend(key_bindings());
        let has = |keys: &'static str, action: &str| {
            let typed = [Keystroke::parse(keys).unwrap()];
            all.iter().any(|b| b.match_keystrokes(&typed) == Some(false) && b.action().name().ends_with(action))
        };
        for (keys, action) in [
            ("cmd-,", "OpenSettings"),
            ("cmd-n", "NewDocument"),
            ("cmd-o", "Open"),
            ("cmd-l", "ToggleLibrary"),
            ("cmd-shift-f", "FocusSearch"),
            ("cmd-s", "Save"),
            ("cmd-shift-s", "SaveAs"),
            ("cmd-shift-d", "DuplicateDocument"),
            ("cmd-alt-r", "RevealDocument"),
            ("cmd-p", "Print"),
            ("cmd-1", "RichMode"),
            ("cmd-2", "SourceMode"),
            ("cmd-3", "SplitMode"),
            ("cmd-=", "ZoomIn"),
            ("cmd--", "ZoomOut"),
            ("cmd-0", "ZoomReset"),
            ("cmd-alt-]", "PageWider"),
            ("cmd-alt-[", "PageNarrower"),
            ("cmd-k", "CommandPalette"),
            ("cmd-/", "ShowShortcuts"),
            ("cmd-shift-i", "ToggleStats"),
            ("cmd-q", "Quit"),
            ("cmd-w", "CloseWindow"),
            ("cmd-m", "MinimizeWindow"),
            ("cmd-[", "NavigateBack"),
            ("cmd-]", "NavigateForward"),
        ] {
            assert!(has(keys, action), "{keys} should run {action}");
        }
    }
}
