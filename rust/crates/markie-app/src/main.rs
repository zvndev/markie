//! Markie RS: the native Rust build of the Markie desktop app.
//!
//! A side build. It has its own name, bundle id and data folder, no updater,
//! and nothing in the Electron release pipeline knows it exists.

mod actions;
mod library;
mod open_urls;
mod themes;
mod workspace;

use futures::StreamExt as _;
use gpui_kit::component::{Theme, TitleBar};
use gpui_kit::*;

use crate::actions::*;
use crate::workspace::Workspace;

fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-o", Open, None),
        KeyBinding::new("cmd-shift-o", OpenFolder, None),
        KeyBinding::new("cmd-n", NewDocument, None),
        KeyBinding::new("cmd-s", Save, None),
        KeyBinding::new("cmd-e", ToggleMode, None),
        KeyBinding::new("cmd-p", FocusSearch, None),
        KeyBinding::new("cmd-shift-f", FocusSearch, None),
        KeyBinding::new("cmd-k", CommandPalette, None),
        KeyBinding::new("cmd-shift-d", DuplicateDocument, None),
        KeyBinding::new("cmd-alt-r", RevealDocument, None),
        KeyBinding::new("cmd-r", Rescan, None),
        KeyBinding::new("cmd-shift-l", ToggleTheme, None),
        KeyBinding::new("cmd-alt-y", ShowHistory, None),
        KeyBinding::new("cmd-shift-i", ToggleStats, None),
        KeyBinding::new("cmd-alt-o", ToggleOutline, None),
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-=", ZoomIn, None),
        KeyBinding::new("cmd-+", ZoomIn, None),
        KeyBinding::new("cmd--", ZoomOut, None),
        KeyBinding::new("cmd-0", ZoomReset, None),
        KeyBinding::new("cmd-alt-]", PageWider, None),
        KeyBinding::new("cmd-alt-[", PageNarrower, None),
    ]);
    markie_office_view::actions::bind_keys(cx);
}

fn set_menus(cx: &mut App) {
    let mut menus = vec![
        Menu {
            name: "Markie RS".into(),
            items: vec![
                MenuItem::action("Settings…", OpenSettings),
                MenuItem::separator(),
                MenuItem::action("Quit Markie RS", Quit),
            ],
            disabled: false,
        },
        Menu {
            name: "File".into(),
            items: vec![
                MenuItem::action("New Document", NewDocument),
                MenuItem::action("Open…", Open),
                MenuItem::action("Open Folder…", OpenFolder),
                MenuItem::separator(),
                MenuItem::action("Save", Save),
                MenuItem::action("Version History", ShowHistory),
                MenuItem::separator(),
                MenuItem::action("Rename…", RenameDocument),
                MenuItem::action("Duplicate", DuplicateDocument),
                MenuItem::action("Reveal in Finder", RevealDocument),
                MenuItem::action("Copy Path", CopyPath),
                MenuItem::action("Move to Trash", TrashDocument),
            ],
            disabled: false,
        },
        Menu {
            name: "View".into(),
            items: vec![
                MenuItem::action("Command Palette", CommandPalette),
                MenuItem::action("Toggle View and Source", ToggleMode),
                MenuItem::action("Outline", ToggleOutline),
                MenuItem::action("Statistics", ToggleStats),
                MenuItem::action("Search Documents", FocusSearch),
                MenuItem::action("Rescan Documents", Rescan),
                MenuItem::separator(),
                MenuItem::action("Zoom In", ZoomIn),
                MenuItem::action("Zoom Out", ZoomOut),
                MenuItem::action("Actual Size", ZoomReset),
                MenuItem::action("Wider Page", PageWider),
                MenuItem::action("Narrower Page", PageNarrower),
                MenuItem::separator(),
                MenuItem::action("Toggle Dark Mode", ToggleTheme),
                MenuItem::separator(),
                MenuItem::submenu(Menu { name: "Word Layout".into(), items: markie_office_view::actions::view_menu_items(), disabled: false }),
            ],
            disabled: false,
        },
    ];
    // Format, Insert, Layout and Review act on the Word page view; they show
    // disabled when another document has focus.
    menus.extend(markie_office_view::actions::menus());
    cx.set_menus(menus);
}

fn main() {
    let initial: Vec<std::path::PathBuf> = std::env::args_os()
        .skip(1)
        .map(std::path::PathBuf::from)
        .collect();

    // macOS hands files to a running app (Finder, `open -a`) and, on a cold
    // launch through Launch Services, often hands the first file the same way
    // instead of in argv. The callback has no App, so it only queues.
    let (open_tx, mut open_rx) = futures::channel::mpsc::unbounded::<Vec<String>>();
    let app = gpui_kit::application().with_assets(gpui_kit::assets::AllAssets);
    app.on_open_urls(move |urls| {
        let _ = open_tx.unbounded_send(urls);
    });
    app.run(move |cx| {
            gpui_kit::init(cx);
            bind_keys(cx);
            markie_editor::bind_keys(cx);
            set_menus(cx);
            cx.on_action(|_: &Quit, cx| cx.quit());
            cx.activate(true);

            let bounds = Bounds::centered(None, size(px(1280.), px(820.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(640.), px(420.))),
                ..TitleBar::window_options()
            };
            let (window_handle, workspace) = gpui_kit::open_window(options, cx, move |window, cx| {
                Theme::sync_system_appearance(Some(window), cx);
                window.set_window_title(markie_core::paths::APP_NAME);
                let view = cx.new(|cx| Workspace::new(initial, window, cx));
                let focus = view.read(cx).startup_focus(cx);
                window.defer(cx, move |window, cx| focus.focus(window, cx));
                view
            })
            .expect("failed to open the Markie RS window");

            cx.spawn(async move |cx| {
                while let Some(urls) = open_rx.next().await {
                    let paths = open_urls::file_paths(&urls);
                    if paths.is_empty() {
                        continue;
                    }
                    let workspace = workspace.clone();
                    let _ = window_handle.update(cx, move |_, window, cx| {
                        // Opened while minimized: un-minimize and come to the
                        // front, so the file never opens out of sight.
                        open_urls::bring_to_front(window, cx);
                        workspace.update(cx, |ws, cx| ws.open_external(paths, window, cx));
                    });
                }
            })
            .detach();
        });
}
