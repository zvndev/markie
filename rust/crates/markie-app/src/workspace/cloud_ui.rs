//! Cloud document rows, per-file sync controls, and conflict choices.
use super::cloud::{Scope, TextAction, name, network};
use super::{DocKind, Workspace};
use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::{
    ActiveTheme, Selectable as _, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use markie_cloud::docs::{DocMeta, Role};
use markie_cloud::sync::{SyncEngine, SyncState};

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum Source {
    #[default]
    All,
    Yours,
    WithMe,
    ByMe,
}

impl Source {
    fn of(row: &DocMeta) -> Self {
        if row.shared {
            Self::WithMe
        } else if row.shared_out == Some(true) {
            Self::ByMe
        } else {
            Self::Yours
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Yours => "Only you",
            Self::WithMe => "Shared with me",
            Self::ByMe => "Shared by me",
        }
    }
}

impl Workspace {
    pub(super) fn render_cloud_toggle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Button::new("cloud-library-toggle")
            .ghost()
            .small()
            .label("Cloud")
            .selected(self.cloud.visible)
            .on_click(cx.listener(|this, _, _, cx| {
                this.cloud.visible = !this.cloud.visible;
                if this.cloud.visible {
                    this.refresh_cloud(false, cx);
                }
                cx.notify();
            }))
    }

    pub(super) fn render_cloud_library(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let scopes = self.cloud.scopes();
        let scope = self.cloud.selected_scope();
        let listing = scope.as_ref().and_then(|scope| self.cloud.listing(scope));
        let query = self.search.read(cx).value().trim().to_lowercase();
        let mut rows: Vec<_> = listing
            .and_then(|l| l.docs.as_ref())
            .into_iter()
            .flatten()
            .filter(|r| {
                (query.is_empty() || r.name.to_lowercase().contains(&query))
                    && self
                        .cloud
                        .area
                        .as_ref()
                        .is_none_or(|area| r.area_id.as_ref() == Some(area))
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        let sources = [Source::All, Source::Yours, Source::ByMe, Source::WithMe];
        let chips = sources
            .into_iter()
            .map(|source| {
                let count = rows
                    .iter()
                    .filter(|r| source == Source::All || Source::of(r) == source)
                    .count();
                Button::new(source.label())
                    .ghost()
                    .xsmall()
                    .label(format!("{} {count}", source.label()))
                    .selected(self.cloud.source == source)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.cloud.source = source;
                        cx.notify();
                    }))
            })
            .collect::<Vec<_>>();
        let snapshot_rows: Vec<_> = listing
            .into_iter()
            .flat_map(|l| l.snapshots.iter())
            .filter(|r| {
                (query.is_empty() || r.name.to_lowercase().contains(&query))
                    && self
                        .cloud
                        .area
                        .as_ref()
                        .is_none_or(|area| r.area_id.as_ref() == Some(area))
            })
            .cloned()
            .collect();
        let local: Vec<_> = scope
            .as_ref()
            .into_iter()
            .flat_map(|s| {
                self.cloud.bindings.iter().filter(move |(_, b)| {
                    b.user == s.user
                        && b.record
                            .cloud_origin
                            .as_deref()
                            .unwrap_or(markie_cloud::DEFAULT_SERVER)
                            == s.origin()
                })
            })
            .filter(|(path, b)| {
                self.cloud.remote(path).is_none()
                    && matches!(
                        b.record.state,
                        SyncState::Unpushed | SyncState::Paused | SyncState::Conflict
                    )
                    && (query.is_empty() || name(path).to_lowercase().contains(&query))
            })
            .map(|(p, _)| p.clone())
            .collect();
        let shown: Vec<_> = rows
            .into_iter()
            .filter(|r| self.cloud.source == Source::All || Source::of(r) == self.cloud.source)
            .collect();
        let empty = if self.cloud.checking {
            Some("Checking your cloud…")
        } else if scope.is_none() {
            Some("Sign in to see your cloud documents.")
        } else if listing.and_then(|l| l.error.as_ref()).is_some() {
            Some("Some of your cloud didn't load")
        } else if shown.is_empty() && snapshot_rows.is_empty() && local.is_empty() {
            Some(if query.is_empty() {
                "Nothing in the cloud yet"
            } else {
                "No documents match this search"
            })
        } else {
            None
        };
        let server_buttons = scopes
            .into_iter()
            .map(|server| {
                let origin = server.origin().to_owned();
                let label = self
                    .cloud
                    .servers
                    .get(&origin)
                    .map(|s| s.name)
                    .unwrap_or_else(|| origin.clone());
                let selected = scope.as_ref().is_some_and(|s| s.origin() == origin);
                Button::new(SharedString::from(origin.clone()))
                    .xsmall()
                    .label(label)
                    .selected(selected)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.cloud.selection = Some(origin.clone());
                        this.cloud.area = None;
                        this.refresh_cloud(false, cx);
                    }))
            })
            .collect::<Vec<_>>();
        let area_buttons = self.cloud_area_buttons(scope.as_ref(), false, cx);
        let repairs = local
            .into_iter()
            .map(|path| {
                let detail = self.cloud.badge(&path).unwrap_or_default();
                Button::new(SharedString::from(format!(
                    "cloud-repair-{}",
                    path.display()
                )))
                .ghost()
                .label(format!("{} · {detail}", name(&path)))
                .on_click(cx.listener(move |this, _, window, cx| this.open_path(&path, window, cx)))
            })
            .collect::<Vec<_>>();
        let doc_rows = shown
            .into_iter()
            .filter_map(|row| {
                let scope = scope.clone()?;
                let local = self.cloud.find(&scope, &row.id);
                let badge = local.as_deref().and_then(|p| self.cloud.badge(p));
                let detail = match Source::of(&row) {
                    Source::WithMe => match row.role {
                        Some(Role::Editor) => "Shared with you · Can edit",
                        _ => "Shared with you · Can view",
                    },
                    Source::ByMe => "Shared",
                    _ if row.shared_out == Some(false) => "Only you",
                    _ => "Yours",
                };
                let label = row.name.clone();
                let id = row.id.clone();
                let media = local.as_ref().and_then(|path| self.cloud.media_note(path));
                Some(
                    v_flex()
                        .id(SharedString::from(format!("cloud-doc-{}", row.id)))
                        .px_3()
                        .py_1()
                        .cursor_pointer()
                        .hover(|el| el.bg(theme.list_hover))
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    div()
                                        .flex_1()
                                        .text_sm()
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(label),
                                )
                                .children(badge.map(|b| div().text_xs().child(b))),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(detail)
                                .children(media.map(|m| div().child(m))),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_cloud_text(
                                scope.clone(),
                                id.clone(),
                                row.name.clone(),
                                window,
                                cx,
                            )
                        })),
                )
            })
            .collect::<Vec<_>>();
        let snapshots: Vec<_> =
            snapshot_rows
                .into_iter()
                .filter_map(|row| {
                    let scope = scope.clone()?;
                    Some(
                        v_flex()
                            .id(SharedString::from(format!("cloud-snapshot-{}", row.id)))
                            .px_3()
                            .py_1()
                            .cursor_pointer()
                            .hover(|el| el.bg(theme.list_hover))
                            .child(div().text_sm().child(row.name.clone()))
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                format!("{} · version {}", role_name(row.role), row.version),
                            ))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.show_snapshot(scope.clone(), row.clone(), window, cx)
                            })),
                    )
                })
                .collect();

        v_flex()
            .size_full()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(theme.sidebar_border)
            .child(
                v_flex()
                    .gap_2()
                    .p_2()
                    .child(
                        h_flex()
                            .justify_between()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Cloud"),
                            )
                            .child(
                                Button::new("cloud-refresh")
                                    .ghost()
                                    .small()
                                    .label("Check for updates")
                                    .disabled(self.cloud.checking)
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.refresh_cloud(true, cx)),
                                    ),
                            ),
                    )
                    .child(Input::new(&self.search).small().cleanable(true))
                    .when(server_buttons.len() > 1, |el| {
                        el.child(h_flex().gap_1().flex_wrap().children(server_buttons))
                    })
                    .when(!area_buttons.is_empty(), |el| {
                        el.child(h_flex().gap_1().flex_wrap().children(area_buttons))
                    })
                    .when(scope.is_some(), |el| {
                        el.child(h_flex().gap_1().flex_wrap().children(chips))
                    }),
            )
            .child(
                v_flex()
                    .id("cloud-documents")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(empty.map(|text| {
                        div()
                            .px_3()
                            .py_2()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(text)
                    }))
                    .children(doc_rows)
                    .children(repairs)
                    .when(!snapshots.is_empty(), |el| {
                        el.child(
                            div()
                                .px_3()
                                .pt_3()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("Cloud snapshots"),
                        )
                        .children(snapshots)
                    }),
            )
            .into_any_element()
    }

    pub(super) fn cloud_area_buttons(
        &self,
        scope: Option<&Scope>,
        destination: bool,
        cx: &mut Context<Self>,
    ) -> Vec<Button> {
        let Some(areas) = scope
            .and_then(|s| self.cloud.listing(s))
            .map(|l| &l.areas)
            .filter(|s| !s.is_empty())
        else {
            return vec![];
        };
        std::iter::once((
            None,
            if destination {
                "Default cloud".into()
            } else {
                "All areas".into()
            },
        ))
        .chain(
            areas
                .iter()
                .map(|row| (Some(row.id.clone()), row.label.clone())),
        )
        .map(|(id, name)| {
            Button::new(SharedString::from(format!(
                "cloud-area-{}-{}",
                destination,
                id.as_deref().unwrap_or_default()
            )))
            .xsmall()
            .label(name)
            .selected(id == self.cloud.area)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.cloud.area = id.clone();
                cx.notify();
            }))
        })
        .collect()
    }

    pub(super) fn render_cloud_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let doc = self.doc.as_ref()?;
        if !matches!(doc.kind, DocKind::Text { .. })
            && markie_cloud::platform::supported_name(&name(&doc.path)).is_none()
        {
            return None;
        }
        if !self.cloud.visible
            && !self.cloud.bindings.contains_key(&doc.path)
            && !self.cloud_office.targets.contains_key(&doc.path)
        {
            return None;
        }
        let path = doc.path.clone();
        let caption = self.cloud.badge(&path);
        let busy = self.cloud.busy.contains(&path);
        let viewer = self
            .cloud
            .remote(&path)
            .is_some_and(|r| r.shared && r.role != Some(Role::Editor));
        let status = if busy {
            Some("Syncing…")
        } else if viewer {
            Some("View-only cloud access")
        } else {
            caption
        };
        let open = matches!(caption, Some("Conflict" | "Update available"));
        let office = !matches!(doc.kind, DocKind::Text { .. })
            || self.cloud_office.targets.contains_key(&path);
        let theme = cx.theme().clone();
        Some(
            h_flex()
                .py_1()
                .px_3()
                .gap_2()
                .flex_wrap()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    Button::new("document-cloud-control")
                        .small()
                        .ghost()
                        .label(if office {
                            "Cloud document"
                        } else if open {
                            "Review cloud copy"
                        } else {
                            "Cloud sync"
                        })
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if office {
                                this.show_office_upload(window, cx);
                            } else {
                                this.show_text_sync(window, cx);
                            }
                        })),
                )
                .children(
                    status.map(|s| div().text_xs().text_color(theme.muted_foreground).child(s)),
                )
                .children(
                    self.cloud
                        .notice
                        .clone()
                        .map(|s| div().text_xs().text_color(theme.muted_foreground).child(s)),
                )
                .into_any_element(),
        )
    }

    fn show_text_sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else {
            return;
        };
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let Some(entity) = owner.upgrade() else {
                return dialog;
            };
            let workspace = entity.read(cx);
            let record = workspace.cloud.bindings.get(&path).map(|b| &b.record);
            let state = record.map(|r| r.state).unwrap_or_default();
            let linked = record.is_some_and(|r| r.cloud_doc_id.is_some());
            let remote = workspace.cloud.remote(&path);
            let behind = workspace.cloud.badge(&path) == Some("Update available");
            let viewer = remote.is_some_and(|r| r.shared && r.role != Some(Role::Editor))
                || record.is_some_and(|r| r.share_role == Some(Role::Viewer));
            let compare = behind || state == SyncState::Conflict;
            let user = workspace.cloud.selected_scope();
            let origin = record
                .and_then(|r| r.cloud_origin.clone())
                .or_else(|| user.as_ref().map(|s| s.origin().to_owned()));
            let busy = workspace.cloud.busy.contains(&path);
            let actions: &[(&str, TextAction)] = if compare {
                &[
                    ("Keep both", TextAction::KeepBoth),
                    ("Take cloud copy", TextAction::Pull),
                    ("Overwrite cloud", TextAction::Overwrite),
                ]
            } else if linked {
                &[
                    ("Back up now", TextAction::Push),
                    ("Turn sync on", TextAction::Enable),
                    ("Pause sync", TextAction::Pause),
                    ("Remove cloud copy", TextAction::Delete),
                ]
            } else {
                &[("Turn sync on", TextAction::Enable)]
            };
            let buttons: Vec<_> = actions
                .iter()
                .copied()
                .filter(|(_, a)| {
                    !(viewer
                        && matches!(
                            a,
                            TextAction::Enable
                                | TextAction::Push
                                | TextAction::Overwrite
                                | TextAction::Delete
                        ))
                        && (*a != TextAction::Enable || !linked || state == SyncState::Paused)
                        && (*a != TextAction::Push || state != SyncState::Paused)
                        && (*a != TextAction::Pause || state != SyncState::Paused)
                })
                .map(|(label, action)| {
                    let owner = owner.clone();
                    let origin = origin.clone();
                    let path = path.clone();
                    Button::new(SharedString::from(format!("cloud-sync-{action:?}")))
                        .small()
                        .label(label)
                        .disabled(
                            busy || (action == TextAction::Pull && state == SyncState::Unpushed),
                        )
                        .on_click(move |_, window, cx| {
                            window.close_dialog(cx);
                            let origin = origin.clone();
                            let path = path.clone();
                            let _ = owner.update(cx, |this, cx| {
                                if matches!(action, TextAction::Delete | TextAction::Overwrite) {
                                    this.confirm_cloud_action(
                                        path, origin, label, action, window, cx,
                                    );
                                    return;
                                }
                                if matches!(
                                    action,
                                    TextAction::Enable | TextAction::Push | TextAction::KeepBoth
                                ) && !this.persist_cloud_choice(&path, window, cx)
                                {
                                    return;
                                }
                                this.cloud_text(path, action, origin, cx);
                            });
                        })
                })
                .collect();
            let compare_button = if compare {
                let owner = owner.clone();
                let path = path.clone();
                Some(
                    Button::new("cloud-compare")
                        .ghost()
                        .small()
                        .label("Compare copies")
                        .on_click(move |_, window, cx| {
                            let path = path.clone();
                            let _ =
                                owner.update(cx, |this, cx| this.compare_cloud(path, window, cx));
                        }),
                )
            } else {
                None
            };
            dialog
                .title(if compare {
                    "Cloud version conflict".to_owned()
                } else {
                    format!("Cloud sync: {}", name(&path))
                })
                .w(px(540.))
                .child(
                    v_flex()
                        .gap_3()
                        .child(if compare {
                            "A newer cloud version is available. Choose which copy to keep."
                        } else {
                            "Sync keeps a versioned backup. Your local file remains yours."
                        })
                        .children(origin.map(|o| div().text_xs().child(format!("Server: {o}"))))
                        .children(
                            workspace
                                .cloud
                                .notice
                                .clone()
                                .map(|s| div().text_sm().child(s)),
                        )
                        .child(
                            h_flex()
                                .flex_wrap()
                                .gap_2()
                                .children(buttons)
                                .children(compare_button),
                        ),
                )
        });
    }

    fn confirm_cloud_action(
        &mut self,
        path: std::path::PathBuf,
        origin: Option<String>,
        label: &'static str,
        action: TextAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone();
            let origin = origin.clone();
            let path = path.clone();
            dialog
                .title(format!("{label}?"))
                .w(px(440.))
                .child(if action == TextAction::Delete {
                    "This removes the cloud copy and its access links. Your local file is kept."
                } else {
                    "The current contents of your local file will replace the cloud copy."
                })
                .footer(
                    Button::new("confirm-cloud-change")
                        .danger()
                        .small()
                        .label(label)
                        .on_click(move |_, window, cx| {
                            window.close_dialog(cx);
                            let _ = owner.update(cx, |this, cx| {
                                if action == TextAction::Overwrite
                                    && !this.persist_cloud_choice(&path, window, cx)
                                {
                                    return;
                                }
                                this.cloud_text(path.clone(), action, origin.clone(), cx);
                            });
                        }),
                )
        });
    }

    fn compare_cloud(
        &mut self,
        path: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(b) = self.cloud.bindings.get(&path).cloned() else {
            return;
        };
        let Some(scope) = self
            .cloud
            .scope(
                b.record
                    .cloud_origin
                    .as_deref()
                    .unwrap_or(markie_cloud::DEFAULT_SERVER),
            )
            .filter(|s| s.user == b.user)
        else {
            return;
        };
        let local = self.current_text(cx);
        let target = name(&path);
        let primary = scope.origin() == markie_cloud::DEFAULT_SERVER;
        let request = scope.clone();
        cx.spawn_in(window, async move |this, cx| {
            let cloud = network(async move {
                SyncEngine::new(&request.client, primary)
                    .remote_content(&b.record, &target)
                    .await
            })
            .await
            .and_then(|r| r);
            let _ = this.update_in(cx, |this, window, cx| {
                if !scope.active() || this.doc.as_ref().is_none_or(|d| d.path != path) {
                    return;
                }
                match cloud {
                    Ok(cloud) => window.open_dialog(cx, move |dialog, _, _| {
                        dialog
                            .title("Compare local and cloud copies")
                            .w(px(820.))
                            .child(
                                h_flex()
                                    .items_start()
                                    .gap_3()
                                    .child(copy_excerpt("Your copy", &local))
                                    .child(copy_excerpt("Cloud copy", &cloud.content)),
                            )
                    }),
                    Err(error) => window.push_notification(error, cx),
                }
            });
        })
        .detach();
    }
}

fn copy_excerpt(label: &'static str, text: &str) -> impl IntoElement {
    let excerpt: String = text.chars().take(12_000).collect();
    v_flex()
        .flex_1()
        .min_w_0()
        .gap_2()
        .child(div().font_weight(FontWeight::SEMIBOLD).child(label))
        .child(
            div()
                .id(label)
                .max_h(px(390.))
                .overflow_y_scroll()
                .text_sm()
                .child(if excerpt.len() < text.len() {
                    format!("{excerpt}\n\nPreview truncated.")
                } else {
                    excerpt
                }),
        )
}

pub(super) fn role_name(role: Role) -> &'static str {
    match role {
        Role::Owner => "Owner",
        Role::Editor => "Can save versions",
        Role::Viewer => "Can view",
    }
}
