//! Device skills and agent instructions, with recoverable removal of installs.
use super::Workspace;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::*;
use markie_agent::skills::{self, Kind, Row, Tool};
use markie_core::{
    index::{self, ScanOptions},
    paths,
};
use std::{collections::BTreeSet, path::PathBuf};

impl Workspace {
    pub(crate) fn open_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Filter skills and agent files"));
        let home = paths::home_dir();
        let config = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|v| PathBuf::from(v.trim()))
        };
        let roots = skills::roots(&home, config("CLAUDE_CONFIG_DIR"), config("CODEX_HOME"));
        let directories = self
            .registry
            .as_ref()
            .and_then(|r| r.roots().ok())
            .unwrap_or_default();
        let snapshot = self
            .registry
            .as_ref()
            .and_then(|r| r.load_snapshot().ok().flatten());
        let workspace = cx.weak_entity();
        let panel = cx.new(|cx: &mut Context<SkillsPanel>| {
            let sub = cx.subscribe(&input, |_, _, _: &InputEvent, cx| cx.notify());
            let mut panel = SkillsPanel {
                input,
                roots,
                opts: ScanOptions::from_env(home, directories),
                rows: Vec::new(),
                expanded: BTreeSet::new(),
                full_path: false,
                busy: false,
                notice: None,
                workspace,
                _sub: sub,
            };
            panel.load(snapshot, cx);
            panel
        });
        window.open_dialog(cx, move |dialog, _, _| {
            dialog.title("Skills").w(px(600.)).child(panel.clone())
        });
    }
}

struct SkillsPanel {
    input: Entity<InputState>,
    roots: Vec<(Tool, PathBuf)>,
    opts: ScanOptions,
    rows: Vec<Row>,
    expanded: BTreeSet<(Tool, Kind)>,
    full_path: bool,
    busy: bool,
    notice: Option<String>,
    workspace: WeakEntity<Workspace>,
    _sub: Subscription,
}

impl SkillsPanel {
    fn load(&mut self, snapshot: Option<index::IndexSnapshot>, cx: &mut Context<Self>) {
        self.busy = true;
        let (opts, roots) = (self.opts.clone(), self.roots.clone());
        cx.spawn(async move |this, cx| {
            let rows = cx
                .background_spawn(async move {
                    let index = snapshot.unwrap_or_else(|| index::scan(&opts));
                    skills::from_index(&index.files, &roots, &opts.home)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                this.rows = rows;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn trash(&mut self, folder: PathBuf, label: &str, window: &mut Window, cx: &mut Context<Self>) {
        let prompt = window.prompt(
            PromptLevel::Warning,
            &format!("Move “{label}” to the Trash?"),
            None,
            &[
                PromptButton::ok("Move to Trash"),
                PromptButton::cancel("Cancel"),
            ],
            cx,
        );
        let roots = self.roots.clone();
        cx.spawn(async move |this, cx| {
            if prompt.await.ok() != Some(0) {
                return;
            }
            let result = cx
                .background_spawn(async move {
                    let target = skills::trash_target(&folder, &roots).map_err(str::to_owned)?;
                    trash::delete(target)
                        .map_err(|_| "Could not move this skill to the Trash.".to_string())
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(()) => {
                        this.notice = Some("Moved to the Trash.".into());
                        this.load(None, cx);
                    }
                    Err(e) => this.notice = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for SkillsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let q = self.input.read(cx).value().trim().to_lowercase();
        let mut content = v_flex().gap_2();
        let mut found = 0;
        for tool in Tool::ALL {
            let rows: Vec<_> = self
                .rows
                .iter()
                .filter(|r| {
                    r.tool == tool
                        && (q.is_empty()
                            || r.label.to_lowercase().contains(&q)
                            || r.path.to_string_lossy().to_lowercase().contains(&q)
                            || r.description
                                .as_ref()
                                .is_some_and(|d| d.to_lowercase().contains(&q)))
                })
                .collect();
            if rows.is_empty() {
                continue;
            }
            found += rows.len();
            content = content.child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("{}  {}", tool.label(), rows.len())),
            );
            for kind in [
                Kind::Skill,
                Kind::Instructions,
                Kind::Command,
                Kind::Agent,
                Kind::Memory,
                Kind::Other,
            ] {
                let matches: Vec<_> = rows
                    .iter()
                    .copied()
                    .filter(|row| row.kind == kind)
                    .collect();
                if matches.is_empty() {
                    continue;
                }
                let open = (kind == Kind::Skill) ^ self.expanded.contains(&(tool, kind));
                let open = open || !q.is_empty();
                content = content.child(
                    Button::new(SharedString::from(format!("{tool:?}-{kind:?}")))
                        .small()
                        .ghost()
                        .label(format!(
                            "{}  {}  {}",
                            if open { "▾" } else { "▸" },
                            kind.label(),
                            matches.len()
                        ))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.expanded.remove(&(tool, kind)) {
                                this.expanded.insert((tool, kind));
                            }
                            cx.notify();
                        })),
                );
                if open {
                    for row in matches {
                        content = content.child(self.row(row, cx));
                    }
                }
            }
        }
        if found == 0 {
            content = content.child(div().text_xs().child(if self.busy {
                "Looking for agent files…"
            } else {
                "No matching agent files."
            }));
        }
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .gap_2()
                    .child(Input::new(&self.input).small())
                    .child(
                        Button::new("refresh-skills")
                            .small()
                            .ghost()
                            .label("Rescan")
                            .on_click(cx.listener(|this, _, _, cx| {
                                if !this.busy {
                                    this.load(None, cx);
                                }
                            })),
                    )
                    .child(
                        Button::new("skills-full-path")
                            .small()
                            .ghost()
                            .label(if self.full_path {
                                "Short paths"
                            } else {
                                "Full paths"
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.full_path = !this.full_path;
                                cx.notify();
                            })),
                    ),
            )
            .children(
                self.notice
                    .as_ref()
                    .map(|s| div().text_xs().child(s.clone())),
            )
            .child(
                div()
                    .id("skills-scroll")
                    .max_h(window.viewport_size().height * 0.68)
                    .overflow_y_scroll()
                    .child(content),
            )
    }
}

impl SkillsPanel {
    fn row(&self, row: &Row, cx: &mut Context<Self>) -> Div {
        let path = row.path.clone();
        let path_text = if self.full_path {
            path.display().to_string()
        } else if let Ok(p) = path.strip_prefix(&self.opts.home) {
            format!("~/{}", p.display())
        } else {
            path.display().to_string()
        };
        let path_id = path_text.clone();
        let folder = row.folder.clone();
        let label = row.label.clone();
        let muted = cx.theme().muted_foreground;
        let mut details = v_flex().min_w_0().flex_1().child(
            Button::new(SharedString::from(format!("open-{path_id}")))
                .small()
                .ghost()
                .label(row.label.clone())
                .on_click(cx.listener(move |this, _, window, cx| {
                    let _ = this.workspace.update(cx, |ws, cx| {
                        ws.open_external(vec![path.clone()], window, cx)
                    });
                    window.close_dialog(cx);
                })),
        );
        if let Some(s) = &row.description {
            details = details.child(div().text_size(px(10.)).text_color(muted).child(s.clone()));
        }
        details = details.child(div().text_size(px(10.)).text_color(muted).child(path_text));
        let mut line = h_flex()
            .gap_2()
            .p_1()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(details);
        if row.removable
            && let Some(folder) = folder
        {
            line = line.child(
                Button::new(SharedString::from(format!("trash-{path_id}")))
                    .small()
                    .ghost()
                    .label("Trash")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.trash(folder.clone(), &label, window, cx)
                    })),
            );
        }
        line
    }
}
