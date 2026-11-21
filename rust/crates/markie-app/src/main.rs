//! Markie RS: the native Rust build of the Markie desktop app.
//!
//! A side build. It has its own name, bundle id and data folder, no updater,
//! and nothing in the Electron release pipeline knows it exists.

mod actions;
mod library;
mod workspace;

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
        KeyBinding::new("cmd-k", FocusSearch, None),
        KeyBinding::new("cmd-r", Rescan, None),
        KeyBinding::new("cmd-shift-l", ToggleTheme, None),
        KeyBinding::new("cmd-q", Quit, None),
    ]);
}

fn set_menus(cx: &mut App) {
    cx.set_menus([
        Menu {
            name: "Markie RS".into(),
            items: vec![MenuItem::action("Quit Markie RS", Quit)],
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
            ],
            disabled: false,
        },
        Menu {
            name: "View".into(),
            items: vec![
                MenuItem::action("Toggle View and Source", ToggleMode),
                MenuItem::action("Search Documents", FocusSearch),
                MenuItem::action("Rescan Documents", Rescan),
                MenuItem::separator(),
                MenuItem::action("Toggle Dark Mode", ToggleTheme),
            ],
            disabled: false,
        },
    ]);
}

fn main() {
    let initial: Vec<std::path::PathBuf> = std::env::args_os()
        .skip(1)
        .map(std::path::PathBuf::from)
        .collect();

    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            bind_keys(cx);
            set_menus(cx);
            cx.on_action(|_: &Quit, cx| cx.quit());
            cx.activate(true);

            let bounds = Bounds::centered(None, size(px(1280.), px(820.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(640.), px(420.))),
                ..TitleBar::window_options()
            };
            gpui_kit::open_window(options, cx, move |window, cx| {
                Theme::sync_system_appearance(Some(window), cx);
                window.set_window_title(markie_core::paths::APP_NAME);
                let view = cx.new(|cx| Workspace::new(initial, window, cx));
                let focus = view.read(cx).focus_handle.clone();
                window.defer(cx, move |window, cx| focus.focus(window, cx));
                view
            })
            .expect("failed to open the Markie RS window");
        });
}
