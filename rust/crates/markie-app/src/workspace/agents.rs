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
#[cfg(unix)]
use markie_agent::{
    Reply,
    bridge::{Bridge, Request},
    guarded_path, sanitize_agent,
};
use markie_agent::{cloud, permissions, tokens};
use markie_cloud::sync::SyncRecord;
use markie_cloud::tokens::{KeyringTokenStore, MemoryTokenStore, TokenStore};
use markie_cloud::{CloudClient, DEFAULT_SERVER, http::Transport, registry::ServerStore};
use markie_core::paths;
use serde_json::json;
use tokio::runtime::Runtime;

pub(super) struct AgentState {
    data: PathBuf,
    runtime: Option<Arc<Runtime>>,
    tokens: Arc<dyn TokenStore>,
    #[cfg(unix)]
    bridge: Option<Bridge>,
    busy: bool,
}

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
            tokens: if std::env::var_os("MARKIE_RS_DATA_DIR").is_some() {
                Arc::new(MemoryTokenStore::new())
            } else {
                Arc::new(KeyringTokenStore::new(paths::APP_NAME))
            },
            #[cfg(unix)]
            bridge: None,
            busy: false,
        }
    }

    fn client(&self, origin: &str) -> Result<CloudClient, String> {
        let servers = ServerStore::open(Some(self.data.join("servers.json")), false);
        CloudClient::new(
            origin,
            servers.trust_handle(),
            self.tokens.clone(),
            Transport::new(),
        )
        .map_err(|e| e.to_string())
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
            method if method.starts_with("comments_") => {
                Err(markie_agent::COMMENTS_UNAVAILABLE.into())
            }
            method => {
                let prepared = (|| {
                    let doc = cloud::Document::resolve(path, &paths::home_dir())?;
                    let key = format!("agent-cloud:{}", doc.path.display());
                    let record: SyncRecord = self
                        .registry
                        .as_ref()
                        .and_then(|r| r.setting(&key).ok().flatten())
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or_default();
                    if method == "cloud_status" {
                        return Ok((doc, key, record, None));
                    }
                    if self.agents.busy {
                        return Err("Another agent Cloud request is in progress. Try again.".into());
                    }
                    if method == "cloud_sync" {
                        if self.registry.is_none() {
                            return Err("Markie RS could not open its document registry.".into());
                        }
                        doc.check_size()?;
                    }
                    let runtime = self
                        .agents
                        .runtime
                        .clone()
                        .ok_or("Markie Cloud is not available.")?;
                    let client = self.agents.client(cloud::record_origin(&record))?;
                    Ok((doc, key, record, Some((runtime, client))))
                })();
                let (doc, key, record, context) = match prepared {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = reply.send(Err(e));
                        return;
                    }
                };
                let Some((runtime, client)) = context else {
                    let _ = reply.send(Ok(doc.describe(&record)));
                    return;
                };
                self.agents.busy = true;
                let data = self.agents.data.clone();
                cx.spawn_in(window, async move |ws, cx| {
                    let (next, response) =
                        cloud_request(req, data, runtime, client, doc, record, cx).await;
                    let result = cx
                        .update(|_, cx| {
                            ws.update(cx, |ws, _| {
                                ws.agents.busy = false;
                                if let Some(next) = next {
                                    let saved = ws.registry.as_ref().is_some_and(|r| {
                                        r.set_setting(
                                            &key,
                                            &serde_json::to_string(&next).expect("sync record"),
                                        )
                                        .is_ok()
                                    });
                                    if !saved {
                                        return Err(
                                            "Markie RS could not save the Cloud link locally."
                                                .into(),
                                        );
                                    }
                                }
                                response
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

    pub(crate) fn open_agents(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Name it after the agent, such as Claude on my phone")
        });
        let server = adapter_path();
        let client = self
            .agents
            .client(DEFAULT_SERVER)
            .ok()
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
            busy: false,
            error: None,
            rows: None,
            fresh: None,
            signed_in: false,
        });
        window.open_dialog(cx, move |dialog, _, _| {
            dialog.w(px(520.)).close_button(false).child(panel.clone())
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
                    "{}\n\nAnyone with the link can read and download it without a Markie account.",
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
            window.prompt(PromptLevel::Warning, &message, Some(&detail), &answers, cx)
        })
    };
    let stopped = |_| Err("Markie Cloud request stopped.".into());
    match request.method.as_str() {
        "cloud_sync" => {
            if !permissions::sync_always(&data) {
                let Ok(answer) = prompt(cx, false) else {
                    return failure("Markie RS closed.");
                };
                match answer.await.ok() {
                    Some(0) => {}
                    Some(1) => {
                        if permissions::set_sync_always(&data, true).is_err() {
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

struct AgentsPanel {
    input: Entity<InputState>,
    server: PathBuf,
    data: PathBuf,
    client: Option<(CloudClient, Arc<Runtime>)>,
    available: bool,
    remote: bool,
    busy: bool,
    error: Option<String>,
    rows: Option<Vec<tokens::Token>>,
    fresh: Option<tokens::Created>,
    signed_in: bool,
}

impl AgentsPanel {
    fn load(&mut self, cx: &mut Context<Self>) {
        let Some((client, runtime)) = self.client.clone() else {
            cx.notify();
            return;
        };
        self.busy = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = runtime
                .spawn(async move {
                    if client.session().is_none() {
                        Ok(None)
                    } else {
                        tokens::list(&client).await.map(Some)
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                this.signed_in = !matches!(&result, Ok(Ok(None)));
                match result {
                    Ok(Ok(rows)) => this.rows = rows,
                    Ok(Err(e)) => this.error = Some(e),
                    Err(_) => this.error = Some("Markie Cloud request stopped.".into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let Some((client, runtime)) = self.client.clone() else {
            return;
        };
        if self.busy || self.fresh.is_some() {
            return;
        }
        let name = self.input.read(cx).value().to_string();
        self.busy = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = runtime
                .spawn(async move { tokens::create(&client, &name).await })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(Ok(token)) if this.remote => {
                        this.fresh = Some(token);
                        this.load(cx);
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => this.error = Some(e),
                    Err(_) => this.error = Some("Markie Cloud request stopped.".into()),
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
        if self.busy {
            return;
        }
        let prompt = window.prompt(
            PromptLevel::Warning,
            &format!("Revoke “{name}”?"),
            Some("The agent will no longer be able to use this token."),
            &[PromptButton::ok("Revoke"), PromptButton::cancel("Cancel")],
            cx,
        );
        self.busy = true;
        cx.spawn(async move |this, cx| {
            let confirmed = prompt.await.ok() == Some(0);
            let result = if confirmed {
                runtime
                    .spawn(async move { tokens::revoke(&client, &id).await })
                    .await
                    .unwrap_or_else(|_| Err("Markie Cloud request stopped.".into()))
            } else {
                Ok(())
            };
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(()) if confirmed && this.remote => this.load(cx),
                    Err(e) => this.error = Some(e),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

fn paragraph(s: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_size(px(12.))
        .text_color(cx.theme().muted_foreground)
        .child(s.into())
}

fn heading(s: &'static str) -> Div {
    div().text_xs().font_weight(FontWeight::SEMIBOLD).child(s)
}

fn copy_block(id: &'static str, name: &'static str, text: String, hide: bool, cx: &App) -> Div {
    let visible = if hide {
        "Hidden · copy to clipboard".into()
    } else {
        text.clone()
    };
    v_flex()
        .gap_1()
        .child(
            h_flex().justify_between().child(heading(name)).child(
                Button::new(id)
                    .small()
                    .ghost()
                    .label("Copy")
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                    }),
            ),
        )
        .child(
            div()
                .text_size(px(11.5))
                .p_2()
                .border_1()
                .border_color(cx.theme().border)
                .rounded_md()
                .bg(cx.theme().background)
                .child(visible),
        )
}

impl Render for AgentsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let header = h_flex()
            .justify_between()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(if self.remote {
                        "Remote agents"
                    } else {
                        "Connect an agent to Markie"
                    }),
            )
            .child(
                Button::new("close-agents")
                    .small()
                    .ghost()
                    .label("×")
                    .on_click(cx.listener(|this, _, window, cx| {
                        if this.remote {
                            this.remote = false;
                            this.fresh = None;
                            this.error = None;
                            cx.notify();
                        } else {
                            window.close_dialog(cx);
                        }
                    })),
            );
        let body = if self.remote {
            self.remote_body(cx)
        } else {
            self.local_body(cx)
        };
        v_flex().gap_2().child(header).child(
            div()
                .id("agents-body")
                .max_h(window.viewport_size().height * 0.68)
                .overflow_y_scroll()
                .child(body),
        )
    }
}

impl AgentsPanel {
    fn local_body(&self, cx: &mut Context<Self>) -> Div {
        let p = self.server.to_string_lossy();
        let quoted = format!("'{}'", p.replace('\'', "'\\''"));
        let claude = format!("claude mcp add markie-rs -- node {quoted}");
        let codex = format!(
            "[mcp_servers.markie-rs]\ncommand = \"node\"\nargs = [{}]",
            serde_json::to_string(&p).expect("path")
        );
        let always = permissions::sync_always(&self.data);
        v_flex().gap_2()
            .child(paragraph("Find, search, read and write documents on this computer, and open them here in Markie. Word, RTF, OpenDocument and HTML stay read-only to agents.", cx))
            .child(div().text_xs().text_color(cx.theme().success).child("Runs on demand, on this computer. Nothing is uploaded unless you let an agent put a file in your Markie Cloud."))
            .child(heading("Tools it gives your agent"))
            .children([
                ("markie_find_documents", "find any document by name, path or type"),
                ("markie_search_documents", "search inside documents, Word and RTF too"),
                ("markie_read_document", "read any document, Word and RTF as plain text"),
                ("markie_write_document", "write markdown, text and data files, home folder only"),
                ("markie_open_in_markie", "open any document here in Markie RS"),
                ("markie_list_skills", "list your agent and skill files, grouped by tool"),
                ("markie_check_md", "check which media and tags will show"),
                ("markie_check_wd", "compile a Darkmown document and report problems"),
                ("markie_cloud_sync", "put a file in Markie Cloud and get a private link"),
                ("markie_cloud_public_link", "make a public link after you confirm"),
                ("markie_guide", "what Markie renders and which types each tool handles"),
                ("markie_*_md", "older Markdown-only tools"),
            ].into_iter().map(|(tool, desc)| h_flex().gap_2().child(div().text_xs().child(tool)).child(paragraph(desc, cx))))
            .child(heading("Markie Cloud"))
            .child(paragraph("Markie asks you before the first upload. A public link is only made when you ask for one, and Markie confirms it with you every time.", cx))
            .child(Button::new("agent-always").small().ghost().label(if always {
                "☑  Let agents put files in Markie Cloud without asking"
            } else { "☐  Let agents put files in Markie Cloud without asking" }).on_click(cx.listener(move |this, _, _, cx| {
                this.error = permissions::set_sync_always(&this.data, !always).err().map(|_| "Markie RS could not save the permission.".into());
                cx.notify();
            })))
            .child(heading("Remote agents"))
            .child(paragraph("An agent that is not on this computer can make documents in your Cloud with a token. Create and revoke tokens here.", cx))
            .child(Button::new("remote-agents").small().primary().label("Remote agents…").on_click(cx.listener(|this, _, _, cx| {
                if !this.busy { this.remote = true; this.load(cx); }
            })))
            .child(heading("It files what it writes"))
            .child(paragraph("Agents can declare a project and block without moving files on disk.", cx))
            .child(paragraph("---\nmarkie:\n  project: bevrly\n  block: checkout-redesign\n---", cx))
            .child(if self.available {
                v_flex().gap_2().child(copy_block("claude-rs", "Claude Code", claude, false, cx))
                    .child(copy_block("codex-rs", "Codex", codex, false, cx))
                    .child(paragraph("Needs Node 22.15 or newer on your PATH. Keep Markie RS open. Add this setup manually.", cx))
            } else { v_flex().child(paragraph("The local Markie RS bridge is unavailable in this instance.", cx)) })
            .children(self.error.as_ref().map(|error| paragraph(error.clone(), cx)))
    }

    fn remote_body(&self, cx: &mut Context<Self>) -> Div {
        let mut content = v_flex().gap_2().child(paragraph("For an agent that does not run on this computer. A token can create documents and can read and edit only the documents it created. Those documents stay private to you.", cx));
        if self.busy && !self.signed_in {
            return content.child(paragraph("Checking your Markie Cloud sign-in…", cx));
        }
        if !self.signed_in {
            return content.child(heading("Sign in first")).child(paragraph("Remote agents need a Markie Cloud sign-in. Sign in from Settings, then open this panel again.", cx));
        }
        if self.error.as_deref() == Some("This server does not offer agent tokens.") {
            return content.child(paragraph("This server does not offer agent tokens.", cx));
        }
        let url = tokens::url(
            self.client
                .as_ref()
                .map_or(DEFAULT_SERVER, |(client, _)| client.origin()),
        );
        let secret = self
            .fresh
            .as_ref()
            .map_or(tokens::TOKEN_PLACEHOLDER, |token| token.token.as_str());
        content = content
            .child(copy_block("remote-url", "MCP URL", url.clone(), false, cx))
            .child(heading("Create a token"))
            .child(
                h_flex()
                    .gap_2()
                    .child(Input::new(&self.input).small())
                    .child(
                        Button::new("create-token")
                            .small()
                            .primary()
                            .disabled(self.busy || self.fresh.is_some())
                            .label("Create token")
                            .on_click(cx.listener(|this, _, _, cx| this.create(cx))),
                    ),
            );
        if let Some(fresh) = &self.fresh {
            content = content
                .child(paragraph(
                    "Copy this token now. It will not be shown again, and Markie does not keep it.",
                    cx,
                ))
                .child(copy_block(
                    "new-token",
                    "New token · shown once",
                    fresh.token.clone(),
                    true,
                    cx,
                ))
                .child(
                    Button::new("forget-token")
                        .small()
                        .label("I have copied it")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.fresh = None;
                            cx.notify();
                        })),
                );
        }
        content = content
            .child(heading("Set up your agent"))
            .child(copy_block(
                "remote-claude",
                "Claude Code",
                tokens::claude(&url, secret),
                self.fresh.is_some(),
                cx,
            ))
            .child(copy_block(
                "remote-config",
                "Other MCP clients",
                tokens::config(&url, secret),
                self.fresh.is_some(),
                cx,
            ))
            .child(heading("Your tokens"));
        if let Some(rows) = &self.rows {
            if rows.is_empty() {
                content = content.child(paragraph("No tokens yet.", cx));
            }
            for row in rows {
                let id = row.id.clone();
                let name = row.name.clone();
                let dates = format!(
                    "{}… · {} · {}",
                    row.prefix,
                    row.created_at
                        .as_ref()
                        .map(|v| format!("Created {v}"))
                        .unwrap_or_else(|| "Created".into()),
                    row.last_used_at
                        .as_ref()
                        .map(|v| format!("Last used {v}"))
                        .unwrap_or_else(|| "Never used".into())
                );
                content = content.child(
                    h_flex()
                        .gap_2()
                        .justify_between()
                        .child(
                            v_flex()
                                .child(paragraph(name.clone(), cx))
                                .child(paragraph(dates, cx)),
                        )
                        .child(
                            Button::new(SharedString::from(format!("revoke-{id}")))
                                .small()
                                .ghost()
                                .disabled(self.busy)
                                .label("Revoke")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.revoke(id.clone(), name.clone(), window, cx)
                                })),
                        ),
                );
            }
        }
        if let Some(error) = &self.error {
            content = content.child(paragraph(error.clone(), cx)).child(
                Button::new("retry-tokens")
                    .small()
                    .label("Try again")
                    .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
            );
        }
        content.child(paragraph(
            "You can have up to 20 active tokens. Each token can make 60 changes an hour.",
            cx,
        ))
    }
}
