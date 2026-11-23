//! App dispatch for the local bridge, and local/remote MCP setup.
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use super::Workspace;
use futures::StreamExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{
    ActiveTheme, Disableable as _, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::*;
use gpui_kit::prelude::FluentBuilder as _;
#[cfg(unix)]
use markie_agent::{
    Reply,
    bridge::{Bridge, Request},
    guarded_path, sanitize_agent,
};
use markie_agent::{cloud, permissions, tokens};
use markie_cloud::CloudClient;
use markie_cloud::sync::{SyncRecord, SyncState};
use markie_core::paths;
use serde_json::json;
use tokio::runtime::Runtime;

/// The agent bridge's state. Its Cloud requests use the window's own Cloud
/// workspace: the signed-in account (`account::shared_tokens`), the trusted
/// servers, and the sync records in Markie RS's registry, so a file an agent
/// syncs is the same synced file the Cloud page and the editor see.
pub(super) struct AgentState {
    data: PathBuf,
    runtime: Option<Arc<Runtime>>,
    #[cfg(unix)]
    bridge: Option<Bridge>,
    busy: bool,
}

/// Before the bridge used the window's sync records it kept its own, under
/// this settings prefix. One is moved into the registry the first time an
/// agent asks about that file again.
const LEGACY_AGENT_RECORD: &str = "agent-cloud:";

impl AgentState {
    pub(super) fn new(data: &Path) -> Self {
        Self {
            data: data.into(),
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .ok()
                .map(Arc::new),
            #[cfg(unix)]
            bridge: None,
            busy: false,
        }
    }
}

impl Workspace {
    pub(super) fn start_agent_bridge(&mut self, window: &Window, cx: &mut Context<Self>) {
        #[cfg(not(unix))]
        let _ = (window, cx);
        #[cfg(unix)]
        {
            let (send, mut receive) =
                futures::channel::mpsc::unbounded::<(Request, std::sync::mpsc::SyncSender<Reply>)>(
                );
            let Ok(bridge) = Bridge::start(&self.agents.data, move |request| {
                let (reply, wait) = std::sync::mpsc::sync_channel(1);
                send.unbounded_send((request, reply))
                    .map_err(|_| "Markie RS closed.")?;
                wait.recv_timeout(markie_agent::bridge::TIMEOUT)
                    .map_err(|_| "Markie RS did not answer.".to_string())?
            }) else {
                return;
            };
            self.agents.bridge = Some(bridge);
            cx.spawn_in(window, async move |workspace, cx| {
                while let Some((request, reply)) = receive.next().await {
                    let entity = workspace.clone();
                    let _ = cx.update(move |window, cx| {
                        let _ = entity
                            .update(cx, |ws, cx| ws.on_agent_request(request, reply, window, cx));
                    });
                }
            })
            .detach();
        }
    }

    #[cfg(unix)]
    fn on_agent_request(
        &mut self,
        req: Request,
        reply: std::sync::mpsc::SyncSender<Reply>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let path = req.params["path"].as_str().unwrap_or_default();
        let agent = req.params["agent"].as_str().unwrap_or_default();
        let result = match req.method.as_str() {
            "open_in_markie" => guarded_path(path, &paths::home_dir(), false).and_then(|path| {
                if markie_core::formats::classify(&path.to_string_lossy())
                    == markie_core::formats::FormatKind::Unsupported
                {
                    return Err("This file type cannot be opened in Markie.".into());
                }
                crate::open_urls::bring_to_front(window, cx);
                self.open_external(vec![path.clone()], window, cx);
                if self.doc.as_ref().is_none_or(|doc| doc.path != path) {
                    return Err("Markie RS could not open the file.".into());
                }
                Ok(json!(format!("Opening {} in Markie RS", path.display())))
            }),
            "history_note_write" => guarded_path(path, &paths::home_dir(), true).and_then(|path| {
                if std::fs::metadata(&path).is_ok_and(|m| m.len() > markie_agent::MAX_SYNC_BYTES) {
                    return Ok(json!({"noted": false}));
                }
                let hash = req.params["sha256"].as_str().unwrap_or_default();
                self.history
                    .note_agent_write(&path, hash, sanitize_agent(agent))
                    .map_err(|e| e.to_string())?;
                Ok(json!({"noted": true}))
            }),
            method if method.starts_with("comments_") => markie_agent::comments::handle(
                method,
                &req.params,
                &self.agents.data,
                &paths::home_dir(),
                super::comments::nightly(self.registry.as_deref()),
            ),
            method => {
                let prepared = (|| {
                    let doc = cloud::Document::resolve(path, &paths::home_dir())?;
                    let key = self.agent_binding_key(&doc.path);
                    let binding = self.cloud.bindings.get(&key).cloned();
                    let record = binding.as_ref().map(|b| b.record.clone()).unwrap_or_default();
                    if method == "cloud_status" {
                        return Ok((doc, key, record, None));
                    }
                    if matches!(method, "cloud_public_link" | "cloud_revoke_public_link") {
                        doc.linked(&record)?;
                    }
                    if self.agents.busy {
                        return Err("Another agent Cloud request is in progress. Try again.".into());
                    }
                    if method == "cloud_sync" {
                        if self.registry.is_none() {
                            return Err("Markie RS could not open its document registry.".into());
                        }
                        if self.cloud.busy.contains(&key) {
                            return Err(format!("{} is syncing in Markie RS right now. Try again.", doc.name));
                        }
                        doc.check_size()?;
                    }
                    let runtime = self
                        .agents
                        .runtime
                        .clone()
                        .ok_or("Markie Cloud is not available.")?;
                    // A file in the cloud keeps its own server and account; a
                    // new one goes to the primary server, as Electron's syncOn.
                    let linked = binding
                        .as_ref()
                        .filter(|b| b.record.cloud_doc_id.is_some() && b.record.state != SyncState::LocalOnly);
                    let scope = match linked {
                        Some(b) => self.cloud.scope(b.origin()).filter(|s| s.matches(b)),
                        None => self.cloud.primary_scope(),
                    }
                    .ok_or(cloud::SIGN_IN)?;
                    Ok((doc, key, record, Some((runtime, scope))))
                })();
                let (doc, key, record, context) = match prepared {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = reply.send(Err(e));
                        return;
                    }
                };
                let Some((runtime, scope)) = context else {
                    let _ = reply.send(Ok(doc.describe(&record)));
                    return;
                };
                let syncing = req.method == "cloud_sync";
                self.agents.busy = true;
                if syncing {
                    self.cloud.set_busy(&key, true);
                }
                let data = self.agents.data.clone();
                let client = scope.client.clone();
                cx.spawn_in(window, async move |ws, cx| {
                    let (next, response) =
                        cloud_request(req, data, runtime, client, doc, record, cx).await;
                    let result = cx
                        .update(|_, cx| {
                            ws.update(cx, |ws, cx| {
                                ws.agents.busy = false;
                                if syncing {
                                    ws.cloud.set_busy(&key, false);
                                }
                                let outcome = match next {
                                    Some(next) => ws.agent_synced(&key, &scope, next, cx).and(response),
                                    None => response,
                                };
                                if syncing && ws.cloud.take_queued(&key) {
                                    ws.cloud_after_save(&key, cx);
                                }
                                outcome
                            })
                        })
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or_else(|| Err("Markie RS closed.".into()));
                    let _ = reply.send(result);
                })
                .detach();
                return;
            }
        };
        let _ = reply.send(result);
    }

    /// The registry key for an agent's file: an existing binding's own path,
    /// else the file's. A record the bridge kept on its own before this
    /// integration moves into the registry here, once.
    fn agent_binding_key(&mut self, path: &Path) -> PathBuf {
        if let Some(key) = self.cloud.binding_key(path) {
            return key;
        }
        let legacy = format!("{LEGACY_AGENT_RECORD}{}", path.display());
        let record: Option<SyncRecord> = self
            .registry
            .as_ref()
            .and_then(|r| r.setting(&legacy).ok().flatten())
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(&s).ok());
        if let Some(record) = record.filter(|r| r.cloud_doc_id.is_some())
            && let Some(scope) = self.cloud.scope(cloud::record_origin(&record))
            && self.store_binding(path, super::cloud::Binding::new(&scope.user, record)).is_ok()
            && let Some(reg) = &self.registry
        {
            let _ = reg.set_setting(&legacy, "");
        }
        path.to_owned()
    }

    /// An agent's sync answered: keep the record in the registry the window
    /// uses, put the file in Recent, list the cloud again, and re-check the
    /// open document's access when this was its first cloud copy.
    fn agent_synced(
        &mut self,
        key: &Path,
        scope: &super::cloud::Scope,
        next: SyncRecord,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let current = self.cloud.scope(scope.origin());
        if current.is_none_or(|s| s.user != scope.user) {
            return Err("The Markie Cloud account changed. Nothing was saved in Markie RS.".into());
        }
        let mut binding = self
            .cloud
            .bindings
            .get(key)
            .cloned()
            .filter(|b| b.user == scope.user)
            .unwrap_or_else(|| super::cloud::Binding::new(&scope.user, next.clone()));
        let first = binding.record.cloud_doc_id.is_none() || binding.record.state == SyncState::LocalOnly;
        binding.record = next;
        self.store_binding(key, binding)
            .map_err(|_| "Markie RS could not save the Cloud link locally.".to_string())?;
        if let Some(reg) = &self.registry {
            let _ = reg.track_opened(key);
        }
        self.refresh_lists(cx);
        self.refresh_cloud(false, cx);
        if first {
            self.collab_after_sync_change(key, cx);
        }
        cx.notify();
        Ok(())
    }

    pub(crate) fn open_agents(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Name it after the agent, such as Claude on my phone")
        });
        let server = adapter_path();
        // Remote agent tokens belong to the primary server's account, the
        // same session the sign-in sheet keeps.
        let client = self
            .cloud
            .client(&self.cloud.primary_origin())
            .zip(self.agents.runtime.clone());
        let data = self.agents.data.clone();
        #[cfg(unix)]
        let available = self.agents.bridge.is_some();
        #[cfg(not(unix))]
        let available = false;
        let panel = cx.new(|_| AgentsPanel {
            input,
            server,
            data,
            client,
            available,
            remote: false,
            checking: false,
            signed_in: false,
            unavailable: false,
            load_error: None,
            create_error: None,
            revoke_error: None,
            creating: false,
            revoking: None,
            rows: None,
            fresh: None,
            error: None,
        });
        window.open_dialog(cx, move |dialog, _, cx| {
            // A stray click outside must not throw away a token that cannot
            // be shown again (remote-agents-panel.tsx closes on the scrim
            // only while no new token is on screen).
            let closable = !panel.read(cx).holds_secret();
            dialog.w(px(520.)).close_button(false).overlay_closable(closable).child(panel.clone())
        });
    }
}

#[cfg(unix)]
async fn cloud_request(
    request: Request,
    data: PathBuf,
    runtime: Arc<Runtime>,
    client: CloudClient,
    doc: cloud::Document,
    record: SyncRecord,
    cx: &mut AsyncWindowContext,
) -> (Option<SyncRecord>, Reply) {
    let failure = |message: &str| (None, Err(message.into()));
    let prompt = |cx: &mut AsyncWindowContext, public: bool| {
        let (message, detail, answers) = if public {
            (
                format!("An agent wants a public link for “{}”", doc.name),
                format!(
                    "{}\n\nAnyone with the link can read and download it, without a Markie account. You can revoke the link later.",
                    doc.path.display()
                ),
                vec![
                    PromptButton::cancel("Cancel"),
                    PromptButton::new("Make Public Link"),
                ],
            )
        } else {
            (
                format!("An agent wants to put “{}” in Markie Cloud", doc.name),
                format!(
                    "{}\n\nIt stays private: only you can open it until you share it.",
                    doc.path.display()
                ),
                vec![
                    PromptButton::ok("Put in Cloud"),
                    PromptButton::new("Always Allow"),
                    PromptButton::cancel("Don’t Allow"),
                ],
            )
        };
        cx.update(|window, cx| {
            crate::open_urls::bring_to_front(window, cx);
            // Electron asks with type "warning" for a public link and
            // "question" (an info sheet on macOS) for a sync.
            let level = if public { PromptLevel::Warning } else { PromptLevel::Info };
            window.prompt(level, &message, Some(&detail), &answers, cx)
        })
    };
    let stopped = |_| Err("Markie Cloud request stopped.".into());
    match request.method.as_str() {
        "cloud_sync" => {
            if !permissions::sync_always(&data) {
                // Electron's sheet: Put in Cloud, Don't Allow and an "always
                // allow" checkbox, which counts only with Put in Cloud.
                #[cfg(target_os = "macos")]
                let answer = {
                    let (message, detail) = (
                        format!("An agent wants to put “{}” in Markie Cloud", doc.name),
                        format!("{}\n\nIt stays private: only you can open it until you share it.", doc.path.display()),
                    );
                    let Ok(Some(sheet)) = cx.update(|window, cx| {
                        crate::open_urls::bring_to_front(window, cx);
                        consent_sheet(window, &message, &detail)
                    }) else {
                        return failure("Markie RS closed.");
                    };
                    sheet.await.ok()
                };
                #[cfg(not(target_os = "macos"))]
                let answer = {
                    let Ok(answer) = prompt(cx, false) else {
                        return failure("Markie RS closed.");
                    };
                    answer.await.ok().map(|n| (n != 2, n == 1))
                };
                match answer {
                    Some((true, always)) => {
                        if always && permissions::set_sync_always(&data, true).is_err() {
                            return failure("Markie RS could not save the permission.");
                        }
                    }
                    _ => return failure("The user declined to put this file in Markie Cloud."),
                }
            }
            match runtime
                .spawn(async move {
                    cloud::sync(
                        &client,
                        &doc,
                        &record,
                        request.params["agent"].as_str().unwrap_or_default(),
                    )
                    .await
                })
                .await
            {
                Ok((next, result)) => (Some(next), result),
                Err(_) => failure("Markie Cloud request stopped."),
            }
        }
        "cloud_public_link" => {
            let (c, d, r) = (client.clone(), doc.clone(), record.clone());
            match runtime
                .spawn(async move {
                    cloud::public_status(&c, &d, &r, request.params["create"] == true).await
                })
                .await
            {
                Ok(Ok(cloud::PublicStatus::Done(value))) => (None, Ok(value)),
                Ok(Ok(cloud::PublicStatus::Confirm)) => {
                    let Ok(answer) = prompt(cx, true) else {
                        return failure("Markie RS closed.");
                    };
                    if answer.await.ok() != Some(1) {
                        return failure("The user declined to make a public link.");
                    }
                    (
                        None,
                        runtime
                            .spawn(
                                async move { cloud::create_public(&client, &doc, &record).await },
                            )
                            .await
                            .unwrap_or_else(stopped),
                    )
                }
                Ok(Err(e)) => (None, Err(e)),
                Err(_) => failure("Markie Cloud request stopped."),
            }
        }
        "cloud_revoke_public_link" => (
            None,
            runtime
                .spawn(async move { cloud::revoke_public(&client, &doc, &record).await })
                .await
                .unwrap_or_else(stopped),
        ),
        _ => failure("Unknown Cloud request."),
    }
}

/// The sync consent sheet, as Electron's `dialog.showMessageBox` draws it on
/// macOS: an informational NSAlert with "Put in Cloud" (Return), "Don’t
/// Allow" (Escape) and the suppression checkbox as "Always allow agents to put
/// files in Markie Cloud". Answers (allowed, always).
#[cfg(target_os = "macos")]
fn consent_sheet(window: &Window, message: &str, detail: &str) -> Option<futures::channel::oneshot::Receiver<(bool, bool)>> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSControlStateValueOn, NSModalResponse, NSView};
    use objc2_foundation::NSString;
    use raw_window_handle::RawWindowHandle;

    let mtm = MainThreadMarker::new()?;
    let handle = raw_window_handle::HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else { return None };
    // SAFETY: GPUI hands out the live NSView of this window, read on the main thread.
    let view: &NSView = unsafe { appkit.ns_view.cast::<NSView>().as_ref() };
    let ns_window = view.window()?;
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Informational);
    alert.setMessageText(&NSString::from_str(message));
    alert.setInformativeText(&NSString::from_str(detail));
    alert.addButtonWithTitle(&NSString::from_str("Put in Cloud"));
    let cancel = alert.addButtonWithTitle(&NSString::from_str("Don\u{2019}t Allow"));
    cancel.setKeyEquivalent(&NSString::from_str("\u{1b}"));
    alert.setShowsSuppressionButton(true);
    let checkbox = alert.suppressionButton()?;
    checkbox.setTitle(&NSString::from_str("Always allow agents to put files in Markie Cloud"));
    let (tx, rx) = futures::channel::oneshot::channel();
    let tx = std::cell::Cell::new(Some(tx));
    let block = block2::RcBlock::new(move |response: NSModalResponse| {
        let allowed = response == NSAlertFirstButtonReturn;
        let always = allowed && checkbox.state() == NSControlStateValueOn;
        if let Some(tx) = tx.take() {
            let _ = tx.send((allowed, always));
        }
    });
    alert.beginSheetModalForWindow_completionHandler(&ns_window, Some(&block));
    Some(rx)
}

fn adapter_path() -> PathBuf {
    let installed = std::env::current_exe().ok().and_then(|p| {
        p.parent()?
            .parent()
            .map(|p| p.join("Resources/markie-rs-mcp.mjs"))
    });
    installed.filter(|p| p.is_file()).unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../markie-agent/mcp/markie-rs-mcp.mjs")
    })
}

/// agents-dialog.tsx and, over it, remote-agents-panel.tsx.
struct AgentsPanel {
    input: Entity<InputState>,
    server: PathBuf,
    data: PathBuf,
    client: Option<(CloudClient, Arc<Runtime>)>,
    available: bool,
    remote: bool,
    /// `auth.status === "checking"`.
    checking: bool,
    signed_in: bool,
    /// The server answered the list or create route with "no such route".
    unavailable: bool,
    load_error: Option<String>,
    create_error: Option<String>,
    revoke_error: Option<String>,
    creating: bool,
    revoking: Option<String>,
    rows: Option<Vec<tokens::Token>>,
    fresh: Option<tokens::Created>,
    /// Saving the Cloud permission failed.
    error: Option<String>,
}

/// agents-dialog.tsx `TOOLS`, which mirrors TOOLS in mcp/markie-mcp.mjs.
const TOOLS: &[(&str, &str)] = &[
    ("markie_find_documents", "find any document by name, path or type"),
    ("markie_search_documents", "search inside documents, Word and RTF too"),
    ("markie_read_document", "read any document, Word and RTF as plain text"),
    ("markie_write_document", "write markdown, text and data files, home folder only"),
    ("markie_open_in_markie", "open any document here in Markie"),
    ("markie_list_skills", "list your agent and skill files, grouped by tool"),
    ("markie_check_md", "say which pictures, clips and tags in a document will not show"),
    ("markie_check_wd", "compile a Darkmown document and say what will not work"),
    ("markie_cloud_sync", "put a file in your Markie Cloud and hand back its private link"),
    ("markie_cloud_public_link", "a public link, only when you ask for one, and you confirm it"),
    ("markie_guide", "what Markie renders and which types each tool handles"),
    ("markie_*_md", "markdown-only find, read and write, for older setups"),
];

/// The front matter an agent writes when it declares where a document belongs.
const FRONT_MATTER_EXAMPLE: &str = "---\nmarkie:\n  project: bevrly\n  block: checkout-redesign\n---";

/// remote-agents-panel.tsx `formatWhen`: seconds or milliseconds or a date
/// string, as `toLocaleDateString` with a short month ("Nov 22, 2026").
fn format_when(value: Option<&serde_json::Value>) -> Option<String> {
    use chrono::{DateTime, Local, TimeZone as _};
    let date: DateTime<Local> = match value? {
        serde_json::Value::Number(n) => {
            let n = n.as_f64()?;
            let ms = if n < 1e11 { n * 1000. } else { n };
            Local.timestamp_millis_opt(ms as i64).single()?
        }
        serde_json::Value::String(s) => DateTime::parse_from_rfc3339(s)
            .map(|d| d.with_timezone(&Local))
            .or_else(|_| {
                chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map(|d| {
                    Local
                        .from_local_datetime(&d.and_hms_opt(0, 0, 0).expect("midnight"))
                        .single()
                        .expect("local midnight")
                })
            })
            .ok()?,
        _ => return None,
    };
    Some(date.format("%b %-d, %Y").to_string())
}

impl AgentsPanel {
    fn holds_secret(&self) -> bool {
        self.fresh.is_some()
    }

    /// The effect that runs for each signed-in session of the panel.
    fn open_remote(&mut self, cx: &mut Context<Self>) {
        self.remote = true;
        self.fresh = None;
        self.rows = None;
        self.load_error = None;
        self.create_error = None;
        self.revoke_error = None;
        self.unavailable = false;
        self.creating = false;
        self.revoking = None;
        let Some((client, _)) = self.client.clone() else {
            self.signed_in = false;
            cx.notify();
            return;
        };
        self.signed_in = client.session().is_some();
        if self.signed_in {
            self.load(cx);
        }
        cx.notify();
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some((client, runtime)) = self.client.clone() else {
            return;
        };
        self.load_error = None;
        cx.spawn(async move |this, cx| {
            let result = runtime.spawn(async move { tokens::list(&client).await }).await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(Ok(rows)) => {
                        this.rows = Some(rows);
                        this.unavailable = false;
                    }
                    Ok(Err(e)) => {
                        this.rows = None;
                        this.unavailable = e.status.is_some_and(tokens::offers_no_agent_tokens);
                        this.load_error = Some(e.message);
                    }
                    Err(_) => this.load_error = Some("Markie Cloud request stopped.".into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((client, runtime)) = self.client.clone() else {
            return;
        };
        let name = self.input.read(cx).value().trim().to_string();
        if name.is_empty() || self.creating {
            return;
        }
        self.creating = true;
        self.create_error = None;
        let input = self.input.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = runtime.spawn(async move { tokens::create(&client, &name).await }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.creating = false;
                match result {
                    Ok(Ok(token)) if this.remote => {
                        input.update(cx, |s, cx| s.set_value("", window, cx));
                        let row = tokens::Token {
                            id: token.id.clone(),
                            name: token.name.clone(),
                            prefix: token.prefix.clone(),
                            created_at: token.created_at.clone(),
                            last_used_at: None,
                        };
                        this.rows.get_or_insert_default().insert(0, row);
                        this.fresh = Some(token);
                    }
                    // Answered after the panel closed: show it to nobody.
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => {
                        if e.status.is_some_and(tokens::offers_no_agent_tokens) {
                            this.unavailable = true;
                        }
                        this.create_error = Some(e.message);
                    }
                    Err(_) => this.create_error = Some("Markie Cloud request stopped.".into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn revoke(&mut self, id: String, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some((client, runtime)) = self.client.clone() else {
            return;
        };
        if self.revoking.is_some() {
            return;
        }
        let prompt = window.prompt(
            PromptLevel::Warning,
            &format!(
                "Revoke “{name}”? Any agent using it stops working right away. The documents it made stay in your Cloud. This cannot be undone."
            ),
            None,
            &[PromptButton::ok("OK"), PromptButton::cancel("Cancel")],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if prompt.await.ok() != Some(0) {
                return;
            }
            let _ = this.update(cx, |this, cx| {
                this.revoking = Some(id.clone());
                this.revoke_error = None;
                cx.notify();
            });
            let gone = id.clone();
            let result = runtime
                .spawn(async move { tokens::revoke(&client, &id).await })
                .await
                .unwrap_or_else(|_| Err("Markie Cloud request stopped.".into()));
            let _ = this.update(cx, |this, cx| {
                this.revoking = None;
                match result {
                    Ok(()) => {
                        if let Some(rows) = &mut this.rows {
                            rows.retain(|t| t.id != gone);
                        }
                        if this.fresh.as_ref().is_some_and(|t| t.id == gone) {
                            this.fresh = None;
                        }
                    }
                    Err(e) => this.revoke_error = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

fn paragraph(s: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_size(px(12.))
        .line_height(relative(1.625))
        .text_color(cx.theme().muted_foreground)
        .child(s.into())
}

fn red(s: impl Into<SharedString>) -> Div {
    div().text_size(px(12.)).line_height(relative(1.625)).text_color(rgb(0xdc2626)).child(s.into())
}

/// `.markie-overlay-section`: 10 px, semibold, muted, upper case with
/// 0.08 em tracking, 6 px above what it labels.
fn heading(s: &'static str, cx: &App) -> Div {
    div()
        .mt_2()
        .mb(px(-2.))
        .text_size(px(10.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(cx.theme().muted_foreground)
        .child(super::dialog_chrome::spaced_caps(s))
}

/// copy-block.tsx: an upper-case label, a hint, Copy, and the text in full.
fn copy_block(id: impl Into<SharedString>, label: impl Into<SharedString>, hint: &'static str, text: String, cx: &App) -> Div {
    let copied = text.clone();
    v_flex()
        .gap_1()
        .mb_3()
        .child(
            h_flex()
                .justify_between()
                .child(
                    h_flex()
                        .gap_1()
                        .text_size(px(11.))
                        .text_color(cx.theme().muted_foreground)
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(label.into().to_uppercase()))
                        .child(hint),
                )
                .child(Button::new(id.into()).small().label("Copy").on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(copied.clone()));
                })),
        )
        .child(
            div()
                .text_size(px(11.5))
                .line_height(relative(1.625))
                .font_family("Menlo")
                .p(px(10.))
                .border_1()
                .border_color(cx.theme().border)
                .rounded_md()
                .bg(cx.theme().background)
                .text_color(cx.theme().foreground.opacity(0.9))
                .child(text),
        )
}

impl Render for AgentsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let header = h_flex()
            .justify_between()
            .mb_1()
            .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child(if self.remote {
                "Remote agents"
            } else {
                "Connect an agent to Markie"
            }))
            .child(Button::new("close-agents").small().ghost().label("×").on_click(cx.listener(|this, _, window, cx| {
                if this.remote {
                    this.remote = false;
                    this.fresh = None;
                    cx.notify();
                } else {
                    window.close_dialog(cx);
                }
            })));
        let body = if self.remote { self.remote_body(cx) } else { self.local_body(cx) };
        v_flex().gap_2().child(header).child(
            div()
                .id("agents-body")
                // `max-h-[86vh]` is the whole panel's: less its 20 px
                // padding and the title row.
                .max_h(window.viewport_size().height * 0.86 - px(70.))
                .overflow_y_scroll()
                .child(body),
        )
    }
}

impl AgentsPanel {
    fn local_body(&self, cx: &mut Context<Self>) -> Div {
        let p = self.server.to_string_lossy();
        // Markie RS's own server name and adapter, so this never changes the
        // `markie` entry an agent keeps for Electron Markie. The path has a
        // space in it ("Markie RS.app"), so the shell needs it quoted.
        let quoted = format!("'{}'", p.replace('\'', "'\\''"));
        let claude = format!("claude mcp add markie-rs -- node {quoted}");
        let codex = format!(
            "[mcp_servers.markie-rs]\ncommand = \"node\"\nargs = [{}]",
            serde_json::to_string(&p).expect("path")
        );
        let always = permissions::sync_always(&self.data);
        v_flex()
            .gap_2()
            .child(paragraph("Hand your agent the documents on this computer. It can find a document by name, search inside it, read it, write a new one, and open it here in Markie: your notes and docs, Word, RTF and OpenDocument files, CSV, JSON and YAML, and your agent files too (CLAUDE.md, AGENTS.md, ~/.claude/skills, ~/.codex).", cx))
            .child(paragraph("Word, RTF, OpenDocument and HTML files stay read-only to agents. An agent reads their text and opens them here for you to edit, so their formatting is never overwritten.", cx))
            .child(div().text_size(px(12.)).line_height(relative(1.625)).mb_2().text_color(cx.theme().success).child("Runs on demand, on this computer. Nothing is uploaded unless you let an agent put a file in your Markie Cloud."))
            .child(heading("Tools it gives your agent", cx))
            .child(v_flex().gap_1().mb_2().children(TOOLS.iter().map(|(tool, desc)| {
                h_flex()
                    .gap_2()
                    .text_size(px(12.))
                    .child(div().flex_none().font_family("Menlo").text_color(cx.theme().foreground.opacity(0.9)).child(*tool))
                    .child(div().min_w_0().truncate().text_color(cx.theme().muted_foreground).child(*desc))
            })))
            .child(heading("Markie Cloud", cx))
            .child(paragraph("Ask an agent for a private Markie copy of something and it puts the file in your Cloud and hands you a private link. That link opens only for you, after you sign in, on any browser or phone. Markie asks you before the first upload. A public link is only made when you ask for one, and Markie confirms it with you every time.", cx))
            .child(
                gpui_kit::component::checkbox::Checkbox::new("agent-always")
                    .checked(always)
                    .label("Let agents put files in Markie Cloud without asking")
                    .text_size(px(12.))
                    .on_click(cx.listener(move |this, checked: &bool, _, cx| {
                        this.error = permissions::set_sync_always(&this.data, *checked)
                            .err()
                            .map(|_| "Markie RS could not save the permission.".into());
                        cx.notify();
                    })),
            )
            .child(heading("Remote agents", cx))
            .child(paragraph("An agent that is not on this computer, such as Claude on your phone, can make documents in your Cloud with a token. Create and revoke tokens here.", cx))
            .child(div().mb_2().child(Button::new("remote-agents").small().label("Remote agents…").on_click(cx.listener(|this, _, _, cx| this.open_remote(cx)))))
            .child(heading("It files what it writes", cx))
            .child(paragraph("Every connected agent is handed Markie’s organization conventions when it starts, so it declares which project and block a document belongs to as it writes:", cx))
            .child(
                div()
                    .text_size(px(11.5))
                    .line_height(relative(1.625))
                    .font_family("Menlo")
                    .p(px(10.))
                    .border_1()
                    .border_color(cx.theme().border)
                    .rounded_md()
                    .bg(cx.theme().background)
                    .text_color(cx.theme().foreground.opacity(0.9))
                    .child(FRONT_MATTER_EXAMPLE),
            )
            .child(paragraph("New documents arrive organized in Projects instead of loose on disk, and nothing moves on your disk to make it happen. Works with Claude Code, Codex, and any other MCP client.", cx))
            .child(copy_block("claude-rs", "Claude Code", "run this in your terminal", claude, cx))
            .child(copy_block("codex-rs", "Codex", "add to ~/.codex/config.toml", codex, cx))
            .child(
                div()
                    .text_size(px(11.))
                    .line_height(relative(1.625))
                    .text_color(cx.theme().muted_foreground)
                    .child(if self.available {
                        "Needs node 22.15 or newer on your PATH, and Markie RS open. After adding it, ask your agent to “list my Markie skills” or “search my documents for X.”"
                    } else {
                        "Needs node 22.15 or newer on your PATH, and Markie RS open. This Markie RS window could not start its local agent connection, so agents cannot reach it until Markie RS is opened again."
                    }),
            )
            .children(self.error.as_ref().map(|error| red(error.clone())))
    }

    fn remote_body(&self, cx: &mut Context<Self>) -> Div {
        let mut content = v_flex().gap_2().child(paragraph("For an agent that does not run on this computer, such as Claude on your phone or in the cloud. It connects to Markie Cloud with a token you make here. A token can create documents, and it can read and edit only the documents that same token created. It cannot reach your other documents, the ones another token made, or the ones an agent on this computer put in your Cloud. The documents a token makes stay private to you and open in the Markie app.", cx).mb_2());
        if self.checking {
            return content.child(paragraph("Checking your Markie Cloud sign-in…", cx));
        }
        if !self.signed_in {
            return content
                .child(heading("Sign in first", cx))
                .child(paragraph("Remote agents need a Markie Cloud sign-in, because the tokens belong to your account. Sign in to Markie Cloud from Settings, then open this panel again.", cx));
        }
        if self.unavailable {
            return content.child(red(self
                .load_error
                .clone()
                .or_else(|| self.create_error.clone())
                .unwrap_or_else(|| "This server does not offer agent tokens.".into())));
        }
        let url = tokens::url(self.client.as_ref().map_or(markie_cloud::DEFAULT_SERVER, |(client, _)| client.origin()));
        let secret = self.fresh.as_ref().map_or(tokens::TOKEN_PLACEHOLDER, |token| token.token.as_str());
        let can_create = !self.creating && !self.input.read(cx).value().trim().is_empty();
        content = content
            .child(copy_block("remote-url", "MCP URL", "the hosted Markie server", url.clone(), cx))
            .child(heading("Create a token", cx))
            .child(
                h_flex()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(Input::new(&self.input).small()))
                    .child(
                        Button::new("create-token")
                            .small()
                            .disabled(!can_create)
                            .label(if self.creating { "Creating…" } else { "Create token" })
                            .on_click(cx.listener(|this, _, window, cx| this.create(window, cx))),
                    ),
            );
        if let Some(error) = &self.create_error {
            content = content.child(red(error.clone()));
        }
        if let Some(fresh) = &self.fresh {
            content = content.child(
                v_flex()
                    .p(px(10.))
                    .mb_3()
                    .border_1()
                    .border_color(cx.theme().border)
                    .rounded_md()
                    .bg(cx.theme().background)
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(relative(1.625))
                            .mb_2()
                            .text_color(rgb(0xca8a04))
                            .child("Copy this token now. It will not be shown again, and Markie does not keep it. If you lose it, revoke it and make a new one."),
                    )
                    .child(copy_block("new-token", format!("Token: {}", fresh.name), "shown once", fresh.token.clone(), cx))
                    .child(div().child(Button::new("forget-token").xsmall().label("I have copied it").on_click(cx.listener(|this, _, _, cx| {
                        this.fresh = None;
                        cx.notify();
                    })))),
            );
        }
        content = content
            .child(heading("Set up your agent", cx))
            .child(paragraph(
                if self.fresh.is_some() {
                    "These include the token you just made.".to_string()
                } else {
                    format!("Replace {} with a token. A new token fills it in here.", tokens::TOKEN_PLACEHOLDER)
                },
                cx,
            ))
            .child(copy_block("remote-claude", "Claude Code", "run this in your terminal", tokens::claude(&url, secret), cx))
            .child(copy_block("remote-config", "Other MCP clients", "add to the client's MCP config", tokens::config(&url, secret), cx))
            .child(heading("Your tokens", cx));
        content = match (&self.load_error, &self.rows) {
            (Some(error), _) => content.child(
                h_flex().gap_1().child(red(error.clone())).child(
                    Button::new("retry-tokens").xsmall().ghost().label("Try again").on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                ),
            ),
            (None, None) => content.child(paragraph("Loading…", cx)),
            (None, Some(rows)) if rows.is_empty() => content.child(paragraph("No tokens yet.", cx)),
            (None, Some(rows)) => {
                let mut list = v_flex().border_1().border_color(cx.theme().border).rounded_md();
                for (i, row) in rows.iter().enumerate() {
                    let (id, name) = (row.id.clone(), row.name.clone());
                    let created = format_when(row.created_at.as_ref()).map_or_else(|| "Created".to_string(), |d| format!("Created {d}"));
                    let used = format_when(row.last_used_at.as_ref()).map_or_else(|| "Never used".to_string(), |d| format!("Last used {d}"));
                    let prefix = if row.prefix.is_empty() { String::new() } else { format!("{}… · ", row.prefix) };
                    let revoking = self.revoking.as_deref() == Some(row.id.as_str());
                    list = list.child(
                        h_flex()
                            .gap_3()
                            .px(px(10.))
                            .py_2()
                            .text_size(px(12.))
                            .when(i > 0, |d| d.border_t_1().border_color(cx.theme().border))
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .flex_1()
                                    .child(div().truncate().text_color(cx.theme().foreground).child(row.name.clone()))
                                    .child(div().truncate().text_size(px(11.)).text_color(cx.theme().muted_foreground).child(format!("{prefix}{created} · {used}"))),
                            )
                            .child(
                                Button::new(SharedString::from(format!("revoke-{id}")))
                                    .xsmall()
                                    .ghost()
                                    .disabled(revoking)
                                    .label(if revoking { "Revoking…" } else { "Revoke" })
                                    .on_click(cx.listener(move |this, _, window, cx| this.revoke(id.clone(), name.clone(), window, cx))),
                            ),
                    );
                }
                content.child(list)
            }
        };
        if let Some(error) = &self.revoke_error {
            content = content.child(red(error.clone()));
        }
        content.child(
            div()
                .mt_3()
                .text_size(px(11.))
                .line_height(relative(1.625))
                .text_color(cx.theme().muted_foreground)
                .child("You can have up to 20 active tokens. Each token can make 60 changes an hour."),
        )
    }
}
