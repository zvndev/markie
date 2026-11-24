//! Markie RS: the native Rust build of the Markie desktop app.
//!
//! A side build. It has its own name, bundle id and data folder, no updater,
//! and nothing in the Electron release pipeline knows it exists.

mod actions;
mod deeplinks;
mod doc_worker;
mod default_apps;
mod icons;
mod instance;
mod library;
mod logs;
mod menus;
mod open_urls;
mod perf;
mod themes;
mod watchdog;
mod workspace;

use futures::StreamExt as _;
use gpui_kit::component::{Theme, TitleBar};
use gpui_kit::*;

use crate::actions::*;
use crate::workspace::Workspace;

fn bind_keys(cx: &mut App) {
    cx.bind_keys(key_bindings());
    cx.bind_keys(menus::key_bindings());
    markie_office_view::actions::bind_keys(cx);
}

fn key_bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("cmd-o", Open, None),
        KeyBinding::new("cmd-shift-o", OpenFolder, None),
        KeyBinding::new("cmd-n", NewDocument, None),
        KeyBinding::new("cmd-s", Save, None),
        KeyBinding::new("cmd-e", ToggleMode, None),
        // Electron: ⌘P prints (File menu); search is ⇧⌘F.
        KeyBinding::new("cmd-p", Print, None),
        KeyBinding::new("cmd-shift-f", FocusSearch, None),
        // GPUI Kit's code editor binds ⌘⇧F to its replace bar. Electron's
        // ⌘⇧F searches all documents from anywhere; replace is ⌥⌘F. Bound
        // after gpui_kit::init, so this one wins in the editor's context.
        KeyBinding::new("cmd-shift-f", FocusSearch, Some("Input")),
        KeyBinding::new("cmd-k", CommandPalette, None),
        KeyBinding::new("cmd-shift-d", DuplicateDocument, None),
        KeyBinding::new("cmd-alt-r", RevealDocument, None),
        KeyBinding::new("cmd-r", Rescan, None),
        KeyBinding::new("cmd-shift-l", ToggleTheme, None),
        KeyBinding::new("cmd-l", ToggleLibrary, None),
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
        // Electron's mode and help shortcuts (src/app/page.tsx).
        KeyBinding::new("cmd-1", RichMode, None),
        KeyBinding::new("cmd-2", SourceMode, None),
        KeyBinding::new("cmd-3", SplitMode, None),
        KeyBinding::new("cmd-/", ShowShortcuts, None),
    ]
}

#[cfg(test)]
mod key_tests {
    use super::key_bindings;
    use gpui_kit::Keystroke;

    fn bound(keys: &'static str) -> Vec<(String, Option<String>)> {
        let typed = [Keystroke::parse(keys).unwrap()];
        key_bindings()
            .iter()
            .filter(|b| b.match_keystrokes(&typed) == Some(false))
            .map(|b| (b.action().name().to_string(), b.predicate().map(|p| p.to_string())))
            .collect()
    }

    #[test]
    fn view_modes_are_cmd_1_2_3() {
        assert!(bound("cmd-1").iter().any(|(a, _)| a.ends_with("RichMode")));
        assert!(bound("cmd-2").iter().any(|(a, _)| a.ends_with("SourceMode")));
        assert!(bound("cmd-3").iter().any(|(a, _)| a.ends_with("SplitMode")));
    }

    #[test]
    fn cmd_shift_f_searches_all_documents_inside_the_source_editor() {
        let found = bound("cmd-shift-f");
        assert!(found.iter().any(|(a, ctx)| a.ends_with("FocusSearch") && ctx.as_deref() == Some("Input")), "{found:?}");
    }

    #[test]
    fn cmd_p_prints() {
        assert!(bound("cmd-p").iter().any(|(a, _)| a.ends_with("Print")));
    }

    #[test]
    fn office_commands_are_directly_in_the_reference_file_and_view_groups() {
        use gpui_kit::MenuItem;
        // A Word document on screen: document-menu.js swaps "PDF (Light)…"
        // in the Export submenu for "Export PDF…".
        let menus = super::menus::build(super::menus::MenuState { word: true, ..Default::default() });
        fn names(items: &[MenuItem], out: &mut Vec<String>) {
            for item in items {
                match item {
                    MenuItem::Action { name, .. } => out.push(name.to_string()),
                    MenuItem::Submenu(menu) => names(&menu.items, out),
                    _ => {}
                }
            }
        }
        let group = |group: &str| {
            let mut out = Vec::new();
            names(&menus.iter().find(|menu| menu.name.as_ref() == group).unwrap().items, &mut out);
            out
        };
        let file = group("File");
        for name in ["New Markdown Document", "New Word Document", "New Text Document",
            "New Darkmown Document", "Document Details…", "History…", "Print…", "Export PDF…"] {
            assert!(file.iter().any(|label| label == name), "{name}");
        }
        let view = group("View");
        for name in ["Page Layout", "Continuous Layout", "Document Outline", "Actual Size"] {
            assert_eq!(view.iter().filter(|label| label.as_str() == name).count(), 1, "{name}");
        }
    }
}

/// The first menu bar, after the first frame. The workspace may already have
/// installed one for the open document; that one stands.
fn set_menus(cx: &mut App) {
    if menus::is_installed() {
        return;
    }
    let nightly = std::env::var("MARKIE_RS_NIGHTLY").is_ok_and(|v| v == "1");
    menus::install(menus::MenuState { has_history: false, nightly, ..Default::default() }, cx);
}


fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(doc_worker::ARG)) {
        std::process::exit(if doc_worker::serve() { 0 } else { 1 });
    }
    logs::install_panic_hook();
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();

    // One Markie RS per data folder. A second launch hands its files and
    // links to the running one and exits.
    let data_dir = markie_core::paths::data_dir();
    let second_launches = match instance::claim(&data_dir, &args) {
        instance::Claim::Handed => return,
        instance::Claim::Primary(rx) => rx,
    };
    // A markie-rs:// link in argv (Windows and Linux hand links over this
    // way) waits for the window; everything else is a file to open.
    let mut launch_links: Vec<String> = args.iter().filter(|a| a.starts_with(deeplinks::SCHEME)).cloned().collect();
    let mut initial = open_urls::launch_file_paths(&args);

    // macOS hands files to a running app (Finder, `open -a`) and, on a cold
    // launch through Launch Services, often hands the first file the same way
    // instead of in argv. The callback has no App, so it only queues.
    let (open_tx, mut open_rx) = futures::channel::mpsc::unbounded::<Vec<String>>();
    // Scene mode (`--features scene`): a hidden, never-activating window put
    // in a state from code and drawn to a PNG. docs/rust-port/SCREEN.md.
    #[cfg(feature = "scene")]
    let mut scene = workspace::scene::from_env();
    #[cfg(feature = "scene")]
    let in_scene = scene.is_some();
    #[cfg(not(feature = "scene"))]
    let in_scene = false;
    let app = gpui_kit::application().with_assets(icons::MarkieAssets);
    let instance_tx = open_tx.clone();
    app.on_open_urls(move |urls| {
        let _ = open_tx.unbounded_send(urls);
    });
    // Second launches arrive on their own thread; an empty list only raises.
    std::thread::spawn(move || {
        while let Ok(args) = second_launches.recv() {
            let urls = instance::as_urls(&args);
            if instance_tx.unbounded_send(urls).is_err() {
                break;
            }
        }
    });
    app.run(move |cx| {
            gpui_kit::init(cx);
            // The bundled font library, for this process only: the same 26
            // families Electron ships. Before any window lays out text, so a
            // style's faces are there on the first frame.
            markie_core::fonts::native::register_bundled(&markie_core::paths::data_dir().join("fonts"));
            // Which families this computer has, for fonts chosen as "only on
            // this computer": listing them is slow, so it runs off the main
            // thread and the windows repaint when it lands.
            {
                let text_system = cx.text_system().clone();
                cx.spawn(async move |cx| {
                    let names = cx.background_executor().spawn(async move { text_system.all_font_names() }).await;
                    markie_core::fonts::set_installed_families(names);
                    cx.update(|cx| cx.refresh_windows());
                })
                .detach();
            }
            perf::init(cx);
            bind_keys(cx);
            markie_editor::bind_keys(cx);
            workspace::source::bind_keys(cx);
            workspace::bind_csv_keys(cx);
            menus::bind_app_actions(cx);
            cx.on_action(|_: &Quit, cx| {
                instance::release(&markie_core::paths::data_dir());
                cx.quit()
            });
            if in_scene {
                // No Dock icon, no menu bar, never the active app.
                cx.set_activation_policy(ActivationPolicy::Accessory);
            } else {
                cx.activate(true);
            }
            // The Markie Cloud session, restored from the Keychain, and this
            // copy registered as the one markie-rs:// sign-ins come back to.
            workspace::account::AccountStore::init(cx);
            if !in_scene {
                std::thread::spawn(open_urls::register_url_scheme);
            }

            // Include Finder's already delivered launch documents before the
            // workspace chooses its first document or marks the welcome seen.
            while let Ok(urls) = open_rx.try_recv() {
                initial.extend(open_urls::file_paths(&urls));
                launch_links.extend(urls.into_iter().filter(|u| u.starts_with(deeplinks::SCHEME)));
            }
            // A scene may ask for its own window size (`MARKIE_RS_SCENE_SIZE=1100x4000`),
            // to draw a whole document in one frame.
            let scene_size = in_scene
                .then(|| std::env::var("MARKIE_RS_SCENE_SIZE").ok())
                .flatten()
                .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))));
            let (win_w, win_h) = scene_size.unwrap_or((1280., 820.));
            let bounds = Bounds::centered(None, size(px(win_w), px(win_h)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                // Electron's minWidth 600, minHeight 400.
                window_min_size: Some(size(px(600.), px(400.))),
                // Electron's `hiddenInset` traffic lights sit at x 14, y 14 in its
                // 40px title bar (electron/main.js).
                titlebar: Some(TitlebarOptions {
                    traffic_light_position: Some(point(px(14.), px(14.))),
                    ..TitleBar::title_bar_options()
                }),
                // A scene's window is never shown and never key.
                show: !in_scene,
                focus: !in_scene,
                ..TitleBar::window_options()
            };
            let (window_handle, workspace) = gpui_kit::open_window(options, cx, move |window, cx| {
                Theme::sync_system_appearance(Some(window), cx);
                window.set_window_title(markie_core::paths::APP_NAME);
                let view = cx.new(|cx| Workspace::new(initial, window, cx));
                let focus = view.read(cx).startup_focus(cx);
                window.defer(cx, move |window, cx| focus.focus(window, cx));
                // The menu bar after the first frame: building it took 50 to
                // 80 ms of the launch. Shortcuts are bound above and work
                // from the start.
                if !in_scene {
                    window.on_next_frame(|_, cx| set_menus(cx));
                }
                view
            })
            .expect("failed to open the Markie RS window");

            // View › Page, Continuous, Outline and the rest reach the open
            // Word document whether or not the page has keyboard focus.
            {
                let workspace = workspace.clone();
                markie_office_view::actions::route_view_commands(cx, move |id, cx| {
                    let workspace = workspace.clone();
                    // The action arrives while the window is lent out to its
                    // own dispatch, so updating it here would fail; go after.
                    cx.defer(move |cx| {
                        let _ = window_handle.update(cx, move |_, window, cx| {
                            workspace.update(cx, |ws, cx| ws.route_word_view_command(id, window, cx));
                        });
                    });
                });
            }
            #[cfg(feature = "scene")]
            if let Some(spec) = scene.take() {
                workspace::scene::start(spec, window_handle, workspace.clone(), cx);
            }
            watchdog::start(cx);
            watchdog::trace_appkit_input();
            cx.on_action(move |_: &logs::RevealCrashLog, cx| {
                let _ = window_handle.update(cx, |_, window, cx| logs::reveal_crash_log(window, cx));
            });
            #[cfg(target_os = "macos")]
            cx.on_action(move |_: &logs::RevealNativeCrashReport, cx| {
                let _ = window_handle.update(cx, |_, window, cx| logs::reveal_native_crash_report(window, cx));
            });
            workspace::account::handle_open_urls(open_urls::hand_back_links(&launch_links), cx);
            for link in open_urls::deep_links(&launch_links) {
                deeplinks::deliver(link, window_handle, workspace.clone(), cx);
            }

            cx.spawn(async move |cx| {
                while let Some(urls) = open_rx.next().await {
                    // A Google or Apple sign-in coming back on markie-rs://.
                    let hand_backs = open_urls::hand_back_links(&urls);
                    if !hand_backs.is_empty() {
                        let _ = window_handle.update(cx, move |_, window, cx| {
                            open_urls::bring_to_front(window, cx);
                            workspace::account::handle_open_urls(hand_backs, cx);
                        });
                    }
                    // Shared documents and public links on markie-rs://.
                    let links = open_urls::deep_links(&urls);
                    if !links.is_empty() {
                        let workspace = workspace.clone();
                        let _ = cx.update(|cx| {
                            for link in links {
                                deeplinks::deliver(link, window_handle, workspace.clone(), cx);
                            }
                        });
                    }
                    let paths = open_urls::file_paths(&urls);
                    if paths.is_empty() {
                        // A second launch with nothing to open raises the window.
                        if urls.is_empty() {
                            let _ = window_handle.update(cx, |_, window, cx| open_urls::bring_to_front(window, cx));
                        }
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
