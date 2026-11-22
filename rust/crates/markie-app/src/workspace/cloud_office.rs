//! Explicit byte-snapshot actions. Local Save never publishes a snapshot.
use super::Workspace;
use super::cloud::{Scope, land, name, network};
use super::cloud_ui::role_name;
use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{ActiveTheme, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use markie_cloud::CloudError;
use markie_cloud::docs::Role;
use markie_cloud::platform::{DownloadLink, MAX_FILE_BYTES, Member, PlatformClient, SnapshotMeta};
use std::collections::HashMap;
use std::future::Future;
use std::io::Read as _;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(super) struct Target {
    scope: Scope,
    meta: SnapshotMeta,
}

#[derive(Default)]
pub(super) struct OfficeCloud {
    pub targets: HashMap<PathBuf, Target>,
    busy: bool,
    members: Vec<Member>,
    link: Option<DownloadLink>,
    notice: Option<String>,
    inspector: Option<Target>,
}

#[derive(Clone)]
enum Manage {
    Members,
    Invite(String, Role),
    Revoke(String),
    CreateLink,
    RevokeLink(String),
    Place(String),
}

enum ManageResult {
    Members(Vec<Member>),
    Link(Option<DownloadLink>),
    Placed,
}

impl Workspace {
    pub(super) fn show_office_upload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else {
            return;
        };
        if let Some(target) = self.cloud_office.targets.get(&path).cloned() {
            self.snapshot_dialog(target, Some(path), window, cx);
            return;
        }
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let Some(workspace) = owner.upgrade() else {
                return dialog;
            };
            let this = workspace.read(cx);
            let scope = this.cloud.selected_scope();
            let owner = owner.clone();
            let file_name = name(&path);
            let path = path.clone();
            let area = this.cloud.area.clone();
            let upload = scope.clone().map(|scope| {
                let owner = owner.clone();
                Button::new("cloud-create-snapshot")
                    .small()
                    .primary()
                    .label("Create a cloud copy")
                    .disabled(this.cloud_office.busy)
                    .on_click(move |_, window, cx| {
                        let _ = owner.update(cx, |this, cx| {
                            this.upload_snapshot(
                                scope.clone(),
                                path.clone(),
                                None,
                                area.clone(),
                                window,
                                cx,
                            )
                        });
                    })
            });
            dialog
                .title(format!("Share {file_name}"))
                .w(px(520.))
                .child(
                    v_flex()
                        .gap_3()
                        .child("Nothing is uploaded until you choose to create a cloud copy.")
                        .child(if let Some(s) = &scope {
                            format!("Server: {}", s.origin())
                        } else {
                            "Sign in to create a cloud copy.".into()
                        })
                        .children(
                            this.cloud_office
                                .notice
                                .clone()
                                .map(|s| div().text_sm().child(s)),
                        )
                        .child(
                            h_flex().gap_2().children(upload).child(
                                Button::new("cloud-browse-snapshots")
                                    .small()
                                    .label("Browse cloud documents")
                                    .on_click(move |_, window, cx| {
                                        window.close_dialog(cx);
                                        let _ = owner.update(cx, |this, cx| {
                                            this.shell.view = super::rail::LeftView::Cloud;
                                            this.shell.panel_open = true;
                                            this.refresh_cloud(false, cx);
                                        });
                                    }),
                            ),
                        ),
                )
        });
    }

    pub(super) fn show_snapshot(
        &mut self,
        scope: Scope,
        meta: SnapshotMeta,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.snapshot_dialog(Target { scope, meta }, None, window, cx);
    }

    fn snapshot_dialog(
        &mut self,
        target: Target,
        path: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !target.scope.active() {
            return;
        }
        self.cloud_office.members.clear();
        self.cloud_office.link = None;
        self.cloud_office.notice = None;
        self.cloud_office.inspector = Some(target.clone());
        let email = cx.new(|cx| InputState::new(window, cx).placeholder("Email"));
        let owner = cx.weak_entity();
        let inspector = target.clone();
        window.open_dialog(cx, move |dialog, _, cx| {
            let Some(entity) = owner.upgrade() else {
                return dialog;
            };
            let ws = entity.read(cx);
            let Some(current) = ws
                .cloud_office
                .inspector
                .as_ref()
                .filter(|t| same_target(t, &inspector) && t.scope.active())
            else {
                return dialog
                    .title("Cloud document")
                    .child("The account changed. Close this panel before sharing again.");
            };
            let target = current.clone();
            let scope = target.scope.clone();
            let busy = ws.cloud_office.busy;
            let can_manage = target.meta.role == Role::Owner;
            let mut actions = Vec::new();
            if let Some(path) = path.clone().filter(|_| target.meta.role != Role::Viewer) {
                let owner = owner.clone();
                let target = target.clone();
                actions.push(
                    Button::new("cloud-save-version")
                        .primary()
                        .small()
                        .label("Save this snapshot to cloud")
                        .disabled(busy)
                        .on_click(move |_, window, cx| {
                            let _ = owner.update(cx, |this, cx| {
                                this.upload_snapshot(
                                    target.scope.clone(),
                                    path.clone(),
                                    Some(target.meta.clone()),
                                    None,
                                    window,
                                    cx,
                                )
                            });
                        }),
                );
            }
            {
                let owner = owner.clone();
                let target = target.clone();
                actions.push(
                    Button::new("cloud-download-snapshot")
                        .small()
                        .label("Download a local copy")
                        .disabled(busy)
                        .on_click(move |_, window, cx| {
                            let _ = owner.update(cx, |this, cx| {
                                this.download_snapshot(target.clone(), window, cx)
                            });
                        }),
                );
            }
            let members: Vec<_> = ws
                .cloud_office
                .members
                .iter()
                .map(|m| {
                    let detail = format!(
                        "{} · {}",
                        m.email.as_deref().unwrap_or(&m.user_id),
                        if m.waiting {
                            "Waiting for them to accept"
                        } else {
                            role_name(m.role)
                        }
                    );
                    let owner = owner.clone();
                    let target = target.clone();
                    let user = m.user_id.clone();
                    h_flex()
                        .justify_between()
                        .child(div().text_sm().child(detail))
                        .when(can_manage, |row| {
                            row.child(
                                Button::new(SharedString::from(format!("cloud-member-{user}")))
                                    .ghost()
                                    .xsmall()
                                    .label("Revoke access")
                                    .disabled(busy)
                                    .on_click(move |_, window, cx| {
                                        let _ = owner.update(cx, |this, cx| {
                                            this.manage_snapshot(
                                                target.clone(),
                                                Manage::Revoke(user.clone()),
                                                window,
                                                cx,
                                            )
                                        });
                                    }),
                            )
                        })
                })
                .collect();
            let invite = [Role::Viewer, Role::Editor].map(|role| {
                let owner = owner.clone();
                let target = target.clone();
                let email = email.clone();
                Button::new(role_name(role))
                    .small()
                    .label(format!("Add access: {}", role_name(role)))
                    .disabled(busy)
                    .on_click(move |_, window, cx| {
                        let address = email.read(cx).value().trim().to_owned();
                        if address.is_empty() {
                            return;
                        }
                        let _ = owner.update(cx, |this, cx| {
                            this.manage_snapshot(
                                target.clone(),
                                Manage::Invite(address, role),
                                window,
                                cx,
                            )
                        });
                    })
            });
            let link = ws.cloud_office.link.as_ref().and_then(|link| {
                PlatformClient(&scope.client)
                    .download_url(link)
                    .ok()
                    .map(|url| (link.id.clone(), url))
            });
            let link_controls = if let Some((id, url)) = link {
                let revoke =
                    manage_button(&owner, &target, Manage::RevokeLink(id), "Revoke link", busy);
                Some(
                    h_flex().gap_2().child(revoke).child(
                        Button::new("cloud-copy-link")
                            .small()
                            .label("Copy link")
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(url.clone()))
                            }),
                    ),
                )
            } else {
                None
            };
            let areas: Vec<_> = ws
                .cloud
                .listing(&scope)
                .into_iter()
                .flat_map(|l| &l.areas)
                .filter(|area| target.meta.area_id.as_ref() != Some(&area.id))
                .map(|area| {
                    manage_button(
                        &owner,
                        &target,
                        Manage::Place(area.id.clone()),
                        format!("Move to {}", area.label),
                        busy,
                    )
                })
                .collect();
            dialog.title("Cloud document").w(px(580.)).child(
                v_flex()
                    .gap_3()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(target.meta.name.clone()),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!(
                                "Cloud version {} · {}",
                                target.meta.version,
                                role_name(target.meta.role)
                            )),
                    )
                    .child(
                        "This is not live Word co-editing. Local Save does not publish a version.",
                    )
                    .child(h_flex().gap_2().flex_wrap().children(actions))
                    .when(!areas.is_empty(), |el| {
                        el.child(h_flex().gap_2().flex_wrap().children(areas))
                    })
                    .when(can_manage, |el| {
                        el.child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Verified account access"),
                        )
                        .child(Input::new(&email).small())
                        .child(h_flex().gap_2().flex_wrap().children(invite))
                    })
                    .child(
                        v_flex()
                            .id("snapshot-members")
                            .gap_1()
                            .max_h(px(130.))
                            .overflow_y_scroll()
                            .children(members),
                    )
                    .when(
                        can_manage
                            && link_controls.is_none()
                            && target.meta.format != markie_core::formats::FormatKind::Darkmown,
                        |el| {
                            el.child(manage_button(
                                &owner,
                                &target,
                                Manage::CreateLink,
                                "Create 24-hour read-only link",
                                busy,
                            ))
                        },
                    )
                    .children(link_controls)
                    .children(
                        ws.cloud_office
                            .notice
                            .clone()
                            .map(|text| div().text_sm().child(text)),
                    ),
            )
        });
        if target.meta.role == Role::Owner {
            self.manage_snapshot(target, Manage::Members, window, cx);
        }
    }

    fn snapshot_job<T: Send + 'static>(
        &mut self,
        scope: Scope,
        work: impl Future<Output = Result<T, CloudError>> + Send + 'static,
        finish: impl FnOnce(&mut Workspace, T, &mut Window, &mut Context<Workspace>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.cloud_office.busy || !scope.active() {
            return;
        }
        self.cloud_office.busy = true;
        self.cloud_office.notice = Some("Updating cloud access…".into());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result =
                network(work).await.and_then(|out| {
                    out.map_err(|e| {
                if e.status() == Some(409) {
                    "Another editor saved a newer cloud version. Your local edits were kept.".into()
                } else { e.to_string() }
            })
                });
            let _ = this.update_in(cx, |this, window, cx| {
                this.cloud_office.busy = false;
                if scope.active()
                    && this
                        .cloud
                        .scope(scope.origin())
                        .is_some_and(|s| s.user == scope.user)
                {
                    match result {
                        Ok(value) => {
                            this.cloud_office.notice = None;
                            finish(this, value, window, cx);
                        }
                        Err(error) => this.cloud_office.notice = Some(error),
                    }
                } else {
                    this.cloud_office.notice =
                        Some("The account changed. Nothing was applied to this workspace.".into());
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn upload_snapshot(
        &mut self,
        scope: Scope,
        path: PathBuf,
        existing: Option<SnapshotMeta>,
        area: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.persist_cloud_choice(&path, window, cx) {
            return;
        }
        let source = path.clone();
        let request = scope.clone();
        let start = existing.is_none();
        self.snapshot_job(
            scope.clone(),
            async move {
                let bytes = read_bytes(&source)?;
                let target = existing.as_ref().map(|m| (m.id.as_str(), m.version));
                PlatformClient(&request.client)
                    .upload(&name(&source), &bytes, target, area.as_deref())
                    .await
            },
            move |this, saved, window, cx| {
                let target = Target {
                    scope,
                    meta: saved.meta,
                };
                this.cloud_office
                    .targets
                    .insert(path.clone(), target.clone());
                if start {
                    window.close_dialog(cx);
                    this.snapshot_dialog(target, Some(path), window, cx);
                } else {
                    this.cloud_office.inspector = Some(target);
                    this.cloud_office.notice = Some("Cloud version saved.".into());
                }
                this.refresh_cloud(false, cx);
            },
            window,
            cx,
        );
    }

    fn download_snapshot(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        let request = target.clone();
        self.snapshot_job(
            target.scope.clone(),
            async move {
                PlatformClient(&request.scope.client)
                    .snapshot(&request.meta.id, None)
                    .await
            },
            move |this, snapshot, window, cx| match land(&snapshot.meta.name, &snapshot.bytes) {
                Ok(path) => {
                    this.cloud_office.targets.insert(
                        path.clone(),
                        Target {
                            scope: target.scope,
                            meta: snapshot.meta,
                        },
                    );
                    window.close_dialog(cx);
                    this.open_path(&path, window, cx);
                }
                Err(err) => this.cloud_office.notice = Some(err),
            },
            window,
            cx,
        );
    }

    fn manage_snapshot(
        &mut self,
        target: Target,
        action: Manage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let request = target.clone();
        self.snapshot_job(
            target.scope.clone(),
            async move {
                let client = PlatformClient(&request.scope.client);
                let id = &request.meta.id;
                let update = match action {
                    Manage::Members => ManageResult::Members(client.members(id).await?),
                    Manage::Invite(address, role) => {
                        client.add_member(id, &address, role).await?;
                        ManageResult::Members(client.members(id).await?)
                    }
                    Manage::Revoke(user) => {
                        client.revoke_member(id, &user).await?;
                        ManageResult::Members(client.members(id).await?)
                    }
                    Manage::CreateLink => ManageResult::Link(Some(client.create_link(id).await?)),
                    Manage::RevokeLink(link) => {
                        client.revoke_link(id, &link).await?;
                        ManageResult::Link(None)
                    }
                    Manage::Place(area) => {
                        client.place(id, &area).await?;
                        ManageResult::Placed
                    }
                };
                Ok(update)
            },
            move |this, result, _, cx| {
                if this
                    .cloud_office
                    .inspector
                    .as_ref()
                    .is_none_or(|s| !same_target(s, &target))
                {
                    return;
                }
                match result {
                    ManageResult::Members(m) => this.cloud_office.members = m,
                    ManageResult::Link(l) => {
                        this.cloud_office.notice = Some(
                            if l.is_some() {
                                "Anyone with this link can download a copy for 24 hours."
                            } else {
                                "Link revoked for future downloads."
                            }
                            .into(),
                        );
                        this.cloud_office.link = l;
                    }
                    ManageResult::Placed => {
                        this.cloud_office.notice =
                            Some("Snapshot moved. Access is unchanged.".into());
                        this.refresh_cloud(false, cx);
                    }
                }
            },
            window,
            cx,
        );
    }
}

fn same_target(a: &Target, b: &Target) -> bool {
    a.meta.id == b.meta.id && a.scope.origin() == b.scope.origin() && a.scope.user == b.scope.user
}

fn manage_button(
    owner: &WeakEntity<Workspace>,
    target: &Target,
    action: Manage,
    label: impl Into<SharedString>,
    busy: bool,
) -> Button {
    let label = label.into();
    let owner = owner.clone();
    let target = target.clone();
    Button::new(label.clone())
        .small()
        .label(label)
        .disabled(busy)
        .on_click(move |_, window, cx| {
            let _ = owner.update(cx, |this, cx| {
                this.manage_snapshot(target.clone(), action.clone(), window, cx)
            });
        })
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, CloudError> {
    if !markie_cloud::platform::supported_name(&name(path)).is_some()
        || !std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES as u64)
    {
        return Err(CloudError::Invalid(
            "This document format or size cannot be shared yet.".into(),
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| CloudError::Invalid("The local document could not be read.".into()))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(CloudError::TooLarge);
    }
    Ok(bytes)
}
