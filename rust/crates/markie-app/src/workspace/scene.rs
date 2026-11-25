//! Scene mode, for comparing screens in the background (docs/rust-port/SCREEN.md).
//!
//! Built only with `--features scene`. `MARKIE_RS_SCENE=<name>` opens the
//! window hidden, as an accessory app that never activates or takes key, puts
//! it in a named state from code (no clicks, no keys), and writes the frame
//! GPUI draws to `MARKIE_RS_SCENE_OUT` with `Window::render_to_image`. The
//! window server is never asked for pixels, so the window never has to be on
//! screen and nothing on Kirby's display moves. Then the app quits.
//!
//! - `MARKIE_RS_SCENE`: `doc`, `csv`, `share`, `office-cloud`, `servers`, `vault`, `browse`, `settings`, `palette`, `shortcuts`, `welcome`,
//!   `recent`, `launch`, `library`, `cloud`, `skills`, `history`, `nav`, `source` or `google`.
//! - `MARKIE_RS_SCENE_ARGS`: a JSON object for the scene (see each one below).
//! - `MARKIE_RS_SCENE_OUT`: the PNG to write.
//! - `MARKIE_RS_SCENE_THEME`: `light` (default) or `dark`.
//!
//! A scratch `MARKIE_RS_DATA_DIR` is required, so sessions stay in memory
//! and the Keychain is never read. Servers must be on localhost.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::*;
use serde_json::Value;

use super::Workspace;
use super::chrome::ColorMode;

pub struct Spec {
    pub name: String,
    args: Value,
    out: PathBuf,
    dark: bool,
}

/// The scene named in the environment, when this launch is one.
pub fn from_env() -> Option<Spec> {
    let name = std::env::var("MARKIE_RS_SCENE").ok().filter(|n| !n.is_empty())?;
    if std::env::var_os("MARKIE_RS_DATA_DIR").is_none() {
        eprintln!("markie-rs scene: refusing without a scratch MARKIE_RS_DATA_DIR");
        std::process::exit(2);
    }
    let args = std::env::var("MARKIE_RS_SCENE_ARGS").ok().and_then(|a| serde_json::from_str(&a).ok()).unwrap_or(Value::Null);
    let out = std::env::var_os("MARKIE_RS_SCENE_OUT").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(format!("{name}.png")));
    let dark = std::env::var("MARKIE_RS_SCENE_THEME").is_ok_and(|t| t == "dark");
    for key in ["origin", "second_origin"] {
        if let Some(origin) = args.get(key).and_then(Value::as_str)
            && !is_local(origin)
        {
            eprintln!("markie-rs scene: {key} must be a localhost address");
            std::process::exit(2);
        }
    }
    Some(Spec { name, args, out, dark })
}

fn is_local(origin: &str) -> bool {
    url::Url::parse(origin).ok().is_some_and(|u| matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")))
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Run the scene: set it up, wait until it is ready and settled, draw, save, quit.
pub fn start(spec: Spec, handle: AnyWindowHandle, workspace: Entity<Workspace>, cx: &mut App) {
    let started = Instant::now();
    cx.spawn(async move |cx| {
        let executor = cx.background_executor().clone();
        let timer = |ms: u64| executor.timer(Duration::from_millis(ms));
        // Let the first frames lay out and the document load.
        timer(400).await;
        let _ = cx.update_window(handle, |_, window, cx| {
            workspace.update(cx, |ws, cx| {
                ws.pick_color_mode(if spec.dark { ColorMode::Dark } else { ColorMode::Light }, window, cx);
            });
        });
        // Any scene: `style` (a Markdown style preset id, or a whole style
        // store as JSON), `template` (a colour template id) and `code_font`
        // (this computer's code font), applied the way Settings applies them.
        let _ = cx.update_window(handle, |_, window, cx| {
            if let Some(id) = spec.args.get("template").and_then(Value::as_str) {
                crate::themes::apply(id, Some(window), cx);
            }
            if let Some(style) = spec.args.get("style") {
                let store = crate::themes::store(cx);
                let styles = match style {
                    Value::String(id) => store.style_store().choose(id),
                    other => markie_core::markdown_style::sanitize_store(other).unwrap_or_default(),
                };
                crate::themes::apply_store(store.with_style_store(styles), Some(window), cx);
            }
            if let Some(font) = spec.args.get("code_font").and_then(Value::as_str) {
                crate::themes::set_own_code_font(font, Some(window), cx);
            }
            workspace.update(cx, |_, cx| cx.notify());
        });
        if let Some(token) = spec.args.get("token").and_then(Value::as_str) {
            let token = token.to_string();
            let _ = cx.update(|cx| {
                if let Some(store) = super::account::AccountStore::global(cx) {
                    store.update(cx, |s, cx| s.scene_sign_in(&token, cx));
                }
            });
        }
        let mut step = 0usize;
        let deadline = Duration::from_secs(spec.args.get("timeout").and_then(Value::as_u64).unwrap_or(30));
        loop {
            timer(150).await;
            let done = cx
                .update_window(handle, |_, window, cx| {
                    let done = workspace.update(cx, |ws, cx| ws.scene_step(&spec, &mut step, window, cx));
                    // A hidden window gets no frames of its own: draw here so
                    // images and other loads a frame starts can finish.
                    window.draw(cx).clear(cx);
                    done
                })
                .unwrap_or(true);
            if done {
                break;
            }
            if started.elapsed() > deadline {
                eprintln!("markie-rs scene: {} not ready after {:?} (step {step}); drawing what is there", spec.name, deadline);
                break;
            }
        }
        if spec.name == "csv" && spec.args.get("bench").and_then(Value::as_bool).unwrap_or(false) {
            csv_bench(handle, &workspace, cx);
        }
        // Settle: text inputs, images and async answers.
        for _ in 0..4 {
            timer(spec.args.get("settle").and_then(Value::as_u64).unwrap_or(700) / 4).await;
            let _ = cx.update_window(handle, |_, window, cx| window.draw(cx).clear(cx));
        }
        let image = cx.update_window(handle, |_, window, cx| {
            window.refresh();
            let clear = window.draw(cx);
            clear.clear(cx);
            window.render_to_image()
        });
        // `report: true` on a document: each table's geometry and anything
        // that disagrees (markie-editor `table_report`).
        if spec.name == "doc" && spec.args.get("report").and_then(Value::as_bool).unwrap_or(false) {
            let _ = cx.update(|cx| {
                for line in workspace.read(cx).rich.read(cx).table_report() {
                    eprintln!("markie-rs scene: {line}");
                }
            });
        }
        let code = match image {
            Ok(Ok(img)) => match img.save(&spec.out) {
                Ok(()) => {
                    eprintln!("markie-rs scene: wrote {} ({}x{})", spec.out.display(), img.width(), img.height());
                    0
                }
                Err(e) => {
                    eprintln!("markie-rs scene: could not write {}: {e}", spec.out.display());
                    1
                }
            },
            Ok(Err(e)) => {
                eprintln!("markie-rs scene: render failed: {e}");
                1
            }
            Err(e) => {
                eprintln!("markie-rs scene: window gone: {e}");
                1
            }
        };
        let _ = cx.update(|cx| {
            crate::instance::release(&markie_core::paths::data_dir());
            cx.quit();
        });
        std::process::exit(code);
    })
    .detach();
}

impl Workspace {
    /// One step of the scene; true once it is ready to draw. `step` counts
    /// stages that must happen once, in order.
    fn scene_step(&mut self, spec: &Spec, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let args = &spec.args;
        let user = super::account::signed_in_user(cx);
        let wants_session = args.get("token").is_some();
        match spec.name.as_str() {
            // The file on the command line. Optional: `zoom` (1.25), `width` (a
            // page width step: 768, 900, 1040, 1200 or 1600), `font` (a toolbar
            // font id, "system" is Theme font), `size` (the document's size)
            // and `panel: "skills"` (the left panel open, so the page is
            // narrower), set through the functions the toolbar and rail call.
            "doc" => {
                if self.doc.is_none() {
                    return false;
                }
                if *step == 0 {
                    *step = 1;
                    if let Some(z) = args.get("zoom").and_then(Value::as_f64) {
                        self.set_zoom(z as f32, cx);
                    }
                    if let Some(w) = args.get("width").and_then(Value::as_f64) {
                        self.set_width_step(w as f32, cx);
                    }
                    if arg(args, "panel") == "skills" {
                        self.shell.skills_enabled = true;
                        self.select_view(super::rail::LeftView::Skills, cx);
                    }
                    let font = arg(args, "font").to_string();
                    let size = args.get("size").and_then(Value::as_f64).map(|s| s as f32);
                    self.sync_rich_appearance(cx);
                    self.rich.update(cx, |r, cx| r.scene_doc_font(&font, size, cx));
                    return false;
                }
                true
            }
            // The file passed on the command line, live: MARKIE_RS_TEST_SESSION
            // binds it to a shared document on the scratch server. Ready once
            // the room is claimed and a few frames have settled the banner.
            "live" => {
                if !self.live_active() {
                    return false;
                }
                *step += 1;
                *step > 6
            }
            // Settings › Appearance, with the Markdown style section. `editor: true`
            // opens the style editor, `group` one of its elements ("tables"),
            // `edit` changes choices first ({"tableStyle": "zebra"}), and
            // `face` opens a font menu ("body", "heading", "code").
            "style-settings" => {
                if *step == 0 {
                    self.open_settings(super::overlay::SettingsSection::Appearance, window, cx);
                    if let Some(edit) = args.get("edit").and_then(Value::as_object) {
                        let choices: Vec<(&str, &str)> = edit.iter().filter_map(|(k, v)| Some((k.as_str(), v.as_str()?))).collect();
                        let store = crate::themes::store(cx);
                        crate::themes::apply_store(store.with_style_store(store.style_store().edit(&choices, &[])), Some(window), cx);
                    }
                    self.scene_style(args.get("editor").and_then(Value::as_bool).unwrap_or(false), arg(args, "group"), arg(args, "face"));
                    cx.notify();
                    *step = 1;
                    return false;
                }
                *step += 1;
                // A few frames, so every sample view has measured itself.
                *step > 6
            }
            // {text?: true, …}: the CSV or TSV passed on the command line as its
            // table, in the state `CsvTable::scene` reads from the other args,
            // or as its text. `bench: true` then times a large file (below).
            "csv" => {
                if !self.is_csv_doc() {
                    return false;
                }
                if *step == 0 {
                    self.csv.update(cx, |table, cx| table.scene(args, window, cx));
                    if args.get("text").and_then(Value::as_bool).unwrap_or(false) {
                        self.set_mode(super::Mode::Source, window, cx);
                    }
                    *step = 1;
                    return false;
                }
                true
            }
            // {origin, token, doc_id, file_name?, pending?: [..], query?, role?: "editor", menu?: "role" | "general"}
            "share" => {
                if *step == 0 {
                    let Some(user) = user else { return false };
                    let Some(store) = super::account::AccountStore::global(cx) else { return false };
                    let Some((_, client)) = store.read(cx).backend() else { return false };
                    let name = args.get("file_name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
                        self.doc.as_ref().and_then(|d| d.path.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into())
                    });
                    let account = Arc::new(super::collab::CloudAccount { client: Arc::new(client), user });
                    let doc = super::collab::CloudDoc { account, doc_id: arg(args, "doc_id").to_string(), name: name.clone() };
                    let body = self.current_text(cx);
                    self.share_open_ready(doc, name, body, window, cx);
                    *step = 1;
                    return false;
                }
                if *step == 1 {
                    if !self.scene_share_loaded() {
                        return false;
                    }
                    let pending: Vec<String> = args.get("pending").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                    self.scene_share_fill(&pending, arg(args, "query"), arg(args, "role") == "editor", arg(args, "menu"), window, cx);
                    // `look: "on"`: turn on "Readers see my look", as its button does.
                    if arg(args, "look") == "on" {
                        self.share_set_look(true, cx);
                    }
                    *step = 2;
                    return false;
                }
                if arg(args, "look") == "on" && !self.scene_share_look_pinned() {
                    return false;
                }
                true
            }
            // {origin, token}: the open office file's cloud dialog.
            "office-cloud" => {
                if wants_session && user.is_none() {
                    return false;
                }
                if *step == 0 {
                    if self.doc.is_none() {
                        return false;
                    }
                    self.show_office_upload(window, cx);
                    *step = 1;
                    return false;
                }
                let upload = args.get("upload").and_then(Value::as_bool).unwrap_or(false);
                let mut uploaded = *step >= 2;
                let done = self.scene_office_settled(upload, &mut uploaded, window, cx);
                if uploaded {
                    *step = 2;
                }
                done
            }
            // {origin?, token?, second_origin, email, password}: Settings ›
            // Advanced with the second server added and signed in, by the
            // same calls the Add and Sign in buttons make.
            "servers" => {
                if wants_session && user.is_none() {
                    return false;
                }
                self.scene_servers(args, step, window, cx)
            }
            // Settings › Files › Google Docs (workspace/google_docs.rs).
            "google" => self.scene_google(args, step, window, cx),
            // {recents}: the Library panel's Recent list over the open file.
            "library" => {
                if *step == 0 {
                    self.scene_seed_recents(args, cx);
                    if !(self.shell.panel_open && self.shell.view == super::rail::LeftView::Library) {
                        self.select_view(super::rail::LeftView::Library, cx);
                    }
                    *step = 1;
                    return false;
                }
                self.shell.recent.total() >= args.get("recents").and_then(Value::as_array).map_or(0, Vec::len)
            }
            // {recents, …}: what a launch with no file shows, after the first
            // one: the Recent page. See `scene_recent` for the other args.
            "launch" | "recent" => {
                if *step == 0 {
                    self.scene_seed_recents(args, cx);
                }
                self.scene_recent(args, step, spec.name == "launch", window, cx)
            }
            // {token?, recents?, sync?: [paths], snapshots?: [paths], min_docs?,
            //  second_origin?, email?, password?}: the Cloud page. `sync` turns
            // sync on for local files first; `second_origin` adds and signs in
            // to a second server through Settings, then closes Settings.
            "cloud" => {
                if wants_session && user.is_none() {
                    return false;
                }
                self.scene_cloud(args, step, window, cx)
            }
            // {state, touch_id?}: the vault page, see `VaultPage::scene_step`.
            "vault" => self.scene_vault(args, step, window, cx),
            // {state?, filter?, type?, open?: [..], ...}: Browse, see `scene_browse`.
            "browse" => self.scene_browse(args, step, window, cx),
            // {state, roots?, tap?}: "Bring your documents", see `scene_bring`.
            "bring" => self.scene_bring(args, step, window, cx),
            // {folders, recents?, select?, drop?, menu?, confirm?, moveto?,
            //  rename?, auto?, filter?}: the Projects tab, see `scene_projects`.
            "projects" => {
                if *step == 0 {
                    self.scene_seed_recents(args, cx);
                }
                self.scene_projects(args, step, window, cx)
            }
            // {width?, filter?, ...}: the Skills panel, see `scene_skills`.
            "skills" => {
                if *step == 0 {
                    if let Some(width) = args.get("width").and_then(Value::as_f64) {
                        self.shell.panel_width = width as f32;
                    }
                    // The panel is off by default (Settings › Agents).
                    self.shell.skills_enabled = true;
                    if !(self.shell.panel_open && self.shell.view == super::rail::LeftView::Skills) {
                        self.select_view(super::rail::LeftView::Skills, cx);
                    }
                    self.prepare_skills(window, cx);
                    *step = 1;
                    return false;
                }
                self.scene_skills(args, step, window, cx)
            }
            // {versions: [{iso, text, author?, agent?, name?}], select?, expand?,
            //  highlight?, named?, menu?}: the History page for the file passed
            //  on the command line, see `scene_history`.
            "history" => self.scene_history(args, step, window, cx),
            // {open: [paths], back?: n, page?: "recent"}: places visited in
            // order after the file on the command line, then Back n times;
            // see `scene_nav`.
            "nav" => self.scene_nav(args, step, window, cx),
            // {ops: [...]}: Source mode on the file passed on the command
            // line, the CodeMirror keys run in order; see `scene_source`.
            "source" => self.scene_source(args, step, window, cx),
            // {section: "account" | "appearance" | "files" | "agents" | "advanced",
            //  skills?: true}: a Settings tab as its tab opens it. `skills`
            //  turns on the Skills panel first, as the Agents switch does.
            "settings" => {
                if *step == 0 {
                    use super::overlay::SettingsSection as S;
                    if args.get("skills").and_then(Value::as_bool).unwrap_or(false) {
                        self.set_skills_enabled(true, cx);
                    }
                    let section = match arg(args, "section") {
                        "appearance" => S::Appearance,
                        "files" => S::Files,
                        "agents" => S::Agents,
                        "advanced" => S::Advanced,
                        _ => S::Account,
                    };
                    self.open_settings(section, window, cx);
                    *step = 1;
                    return false;
                }
                *step += 1;
                *step > 6
            }
            // {query?}: the command palette, with words typed in its field.
            "palette" => {
                if *step == 0 {
                    window.dispatch_action(Box::new(crate::actions::CommandPalette), cx);
                    *step = 1;
                    return false;
                }
                if *step == 1 {
                    let query = arg(args, "query").to_string();
                    if !query.is_empty() {
                        self.scene_palette_type(&query, window, cx);
                    }
                }
                *step += 1;
                *step > 6
            }
            // The keyboard shortcuts sheet, as ⌘/ opens it.
            "shortcuts" => {
                if *step == 0 {
                    window.dispatch_action(Box::new(crate::actions::ShowShortcuts), cx);
                    *step = 1;
                    return false;
                }
                *step += 1;
                *step > 6
            }
            // A first launch with no file: the welcome document. Needs an
            // empty scratch data folder.
            "welcome" => {
                if self.doc.is_none() {
                    return false;
                }
                *step += 1;
                *step > 6
            }
            other => {
                eprintln!("markie-rs scene: unknown scene {other}");
                true
            }
        }
    }

    /// `recents: [{path, hours_ago, star?}]` into the scratch registry, as if
    /// each had been opened then. A path with no file is a missing row.
    fn scene_seed_recents(&mut self, args: &Value, cx: &mut Context<Self>) {
        let Some(reg) = self.registry.clone() else { return };
        let now = markie_core::clock::now_ms();
        for row in args.get("recents").and_then(Value::as_array).into_iter().flatten() {
            let path = PathBuf::from(arg(row, "path"));
            let hours = row.get("hours_ago").and_then(Value::as_f64).unwrap_or(0.);
            let _ = reg.track_opened_at(&path, &markie_core::clock::iso(now - (hours * 3_600_000.) as i64));
            if row.get("star").and_then(Value::as_bool).unwrap_or(false) {
                let _ = reg.set_star(&path, "file");
            }
        }
        self.refresh_lists(cx);
    }

    fn scene_cloud(&mut self, args: &Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use super::rail::LeftView;
        let paths = |key: &str| -> Vec<PathBuf> { args.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(PathBuf::from)).collect()).unwrap_or_default() };
        // 0..=9: the second server, through the Servers setting's own steps.
        if *step < 10 {
            if args.get("second_origin").is_none() {
                *step = 10;
            } else if self.scene_servers(args, step, window, cx) {
                self.close_dialog(window, cx);
                *step = 10;
            }
            return false;
        }
        match *step {
            10 => {
                self.scene_seed_recents(args, cx);
                for path in paths("sync") {
                    self.cloud_text(path, super::cloud::TextAction::Enable, None, cx);
                }
                *step = 11;
                false
            }
            11 => {
                if !paths("sync").iter().all(|p| self.cloud.badge(p) == Some("Synced")) {
                    return false;
                }
                let Some(scope) = self.cloud.selected_scope() else {
                    *step = 13;
                    return false;
                };
                let files: Vec<(String, Vec<u8>)> = paths("snapshots")
                    .iter()
                    .filter_map(|p| Some((p.file_name()?.to_string_lossy().into_owned(), std::fs::read(p).ok()?)))
                    .collect();
                *step = 12;
                cx.spawn(async move |this, cx| {
                    let _ = super::cloud::network(async move {
                        let platform = markie_cloud::platform::PlatformClient(&scope.client);
                        for (name, bytes) in &files {
                            let _ = platform.upload(name, bytes, None, None).await;
                        }
                    })
                    .await;
                    let _ = this.update(cx, |this, cx| {
                        this.scene_cloud_uploaded = true;
                        cx.notify();
                    });
                })
                .detach();
                false
            }
            12 => {
                if self.scene_cloud_uploaded {
                    *step = 13;
                }
                false
            }
            13 => {
                if !(self.shell.panel_open && self.shell.view == LeftView::Cloud) {
                    self.select_view(LeftView::Cloud, cx);
                }
                self.refresh_cloud(false, cx);
                *step = 14;
                false
            }
            _ => {
                let Some(scope) = self.cloud.selected_scope() else { return true };
                if self.cloud.checking {
                    return false;
                }
                let want = args.get("min_docs").and_then(Value::as_u64).unwrap_or(0) as usize;
                let ready = self.cloud.listing(&scope).is_some_and(|l| {
                    l.docs.as_ref().is_some_and(|d| d.len() >= want) && (l.shared_by_me.is_some() || l.shared_by_me_error)
                });
                if !ready {
                    // A listing taken before the sync finished: ask again.
                    self.refresh_cloud(false, cx);
                    return false;
                }
                let requests = args.get("min_requests").and_then(Value::as_u64).unwrap_or(0) as usize;
                if !self.collab.people.as_ref().is_some_and(|p| p.requests.len() >= requests) {
                    return false;
                }
                // Thumbnails: the saved ones read, the rest fetched.
                if !self.shell.cloud_previews_loaded || self.shell.previews.busy() {
                    return false;
                }
                if *step == 14 {
                    // {requests_open?, view?: "list", sources?: ["with-me"], menu?: "area" | "type" | "sort" | "row", cursor?: n}
                    if args.get("requests_open").and_then(Value::as_bool).unwrap_or(false)
                        && let Some(people) = self.collab.people.as_mut()
                    {
                        people.open = true;
                    }
                    self.shell.cloud_grid.view = if arg(args, "view") == "list" { super::doc_grid::GridView::List } else { super::doc_grid::GridView::Grid };
                    let sources: Vec<String> = args.get("sources").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                    self.cloud.sources = super::cloud_page::sources_from_setting(serde_json::to_string(&sources).ok().as_deref());
                    self.scene_cloud_menu(arg(args, "menu"), window, cx);
                    // `select: [n, …]`: cards picked, as on the Recent page.
                    let picks: Vec<u64> = args.get("select").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
                    self.scene_cloud_select(&picks, window, cx);
                    *step = 15;
                    cx.notify();
                    return false;
                }
                true
            }
        }
    }
}

/// The 100,000-row measurement (docs/rust-port/PERF.md), on the open CSV.
/// Each figure is main-thread time from the action to the end of the frame
/// it causes: the model's work, render, layout and paint. The window is
/// hidden, so presenting the frame on the GPU is not in it.
fn csv_bench(handle: AnyWindowHandle, workspace: &Entity<Workspace>, cx: &mut AsyncApp) {
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.;
    let _ = cx.update_window(handle, |_, window, cx| {
        let (table, path) = {
            let ws = workspace.read(cx);
            (ws.csv.clone(), ws.doc.as_ref().map(|d| d.path.clone()))
        };
        let Some(path) = path else { return };
        let frame = |window: &mut Window, cx: &mut App| window.draw(cx).clear(cx);
        let median = |mut samples: Vec<f64>| {
            samples.sort_by(f64::total_cmp);
            samples[samples.len() / 2]
        };
        // Open: the file read, decoded, parsed and laid out, to the first frame with its cells.
        let mut opens = Vec::new();
        for _ in 0..7 {
            let t = Instant::now();
            workspace.update(cx, |ws, cx| ws.open_path(&path, window, cx));
            frame(window, cx);
            opens.push(ms(t));
        }
        let rows = table.read(cx).shown_rows();
        eprintln!("markie-csv-bench rows {rows}");
        eprintln!("markie-csv-bench open_to_first_cells_ms median {:.2} min {:.2} max {:.2}", median(opens.clone()), opens.iter().copied().fold(f64::MAX, f64::min), opens.iter().copied().fold(0., f64::max));
        let timed = |steps: &[&str], window: &mut Window, cx: &mut App| {
            let mut samples = Vec::new();
            for _ in 0..7 {
                for step in steps {
                    let t = Instant::now();
                    table.update(cx, |table, cx| table.bench_step(step, cx));
                    frame(window, cx);
                    samples.push(ms(t));
                }
            }
            samples
        };
        for (label, steps) in [
            ("sort_number_ms", &["sort-number-asc", "sort-number-desc"][..]),
            ("sort_text_ms", &["sort-text-asc", "sort-text-desc"][..]),
        ] {
            let samples = timed(steps, window, cx);
            eprintln!("markie-csv-bench {label} median {:.2} min {:.2} max {:.2}", median(samples.clone()), samples.iter().copied().fold(f64::MAX, f64::min), samples.iter().copied().fold(0., f64::max));
        }
        table.update(cx, |table, cx| table.bench_step("sort-off", cx));
        frame(window, cx);
        let mut filters = Vec::new();
        for _ in 0..7 {
            let t = Instant::now();
            table.update(cx, |table, cx| table.bench_step("filter", cx));
            frame(window, cx);
            filters.push(ms(t));
            table.update(cx, |table, cx| table.bench_step("filter-off", cx));
            frame(window, cx);
        }
        eprintln!("markie-csv-bench filter_ms median {:.2} min {:.2} max {:.2}", median(filters.clone()), filters.iter().copied().fold(f64::MAX, f64::min), filters.iter().copied().fold(0., f64::max));
        // Scroll: 600 frames, 240 points apart, through the whole file.
        let mut frames = Vec::new();
        for _ in 0..600 {
            let t = Instant::now();
            table.update(cx, |table, cx| table.bench_step("scroll", cx));
            frame(window, cx);
            frames.push(ms(t));
        }
        let mut sorted = frames.clone();
        sorted.sort_by(f64::total_cmp);
        let mean = frames.iter().sum::<f64>() / frames.len() as f64;
        let over = frames.iter().filter(|f| **f > 1000. / 60.).count();
        eprintln!(
            "markie-csv-bench scroll_frame_ms mean {mean:.3} median {:.3} p95 {:.3} max {:.3} frames_over_16.7ms {over} of {}",
            sorted[sorted.len() / 2],
            sorted[sorted.len() * 95 / 100],
            sorted[sorted.len() - 1],
            frames.len()
        );
        table.update(cx, |table, cx| table.bench_step("top", cx));
    });
}
