//! Scene mode, for comparing screens in the background (docs/rust-port/SCREEN.md).
//!
//! Built only with `--features scene`. `MARKIE_RS_SCENE=<name>` opens the
//! window hidden, as an accessory app that never activates or takes key, puts
//! it in a named state from code (no clicks, no keys), and writes the frame
//! GPUI draws to `MARKIE_RS_SCENE_OUT` with `Window::render_to_image`. The
//! window server is never asked for pixels, so the window never has to be on
//! screen and nothing on Kirby's display moves. Then the app quits.
//!
//! - `MARKIE_RS_SCENE`: `doc`, `share`, `office-cloud`, `servers`, `vault` or `browse`.
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
            "doc" => self.doc.is_some(),
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
                    *step = 2;
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
            // {state, touch_id?}: the vault page, see `VaultPage::scene_step`.
            "vault" => self.scene_vault(args, step, window, cx),
            // {state?, filter?, type?, open?: [..], ...}: Browse, see `scene_browse`.
            "browse" => self.scene_browse(args, step, window, cx),
            other => {
                eprintln!("markie-rs scene: unknown scene {other}");
                true
            }
        }
    }
}
