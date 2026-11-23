//! The Skills view: src/components/skills-view.tsx's InstalledSkills, over the
//! device index. Rows come from `markie_agent::skills::from_index`, which ports
//! the view's grouping; this file is its look and its actions.
use super::Workspace;
use crate::themes::Palette;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::*;
use gpui_kit::prelude::FluentBuilder as _;
use markie_agent::skills::{self, Kind, Row, Tool};
use markie_core::{
    index::{self, IndexedDoc, ScanOptions},
    registry::Registry,
};
use std::{collections::BTreeSet, path::PathBuf, rc::Rc};

/// skills-view.tsx `FULL_KEY`, kept in Markie RS's own settings.
const FULL_KEY: &str = "markie.skills.fullpath.v1";

impl Workspace {
    pub(super) fn prepare_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.skills.is_some() {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter skills & agent files…"));
        let directories = self.registry.as_ref().and_then(|r| r.roots().ok()).unwrap_or_default();
        // The index's own home: the scratch data folder in a test run.
        let opts = super::device_scan_options(directories);
        let home = opts.home.clone();
        let config = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|v| PathBuf::from(v.trim()))
        };
        // A scratch run indexes no configured agent folders, so it names none.
        let scratch = std::env::var_os("MARKIE_RS_DATA_DIR").is_some();
        let (claude, codex) = if scratch { (None, None) } else { (config("CLAUDE_CONFIG_DIR"), config("CODEX_HOME")) };
        let snapshot = self.registry.as_ref().and_then(|r| r.load_snapshot().ok().flatten());
        let registry = self.registry.clone();
        let full_path = registry
            .as_ref()
            .and_then(|r| r.setting(FULL_KEY).ok().flatten())
            .is_some_and(|v| v == "1");
        let workspace = cx.weak_entity();
        let panel = cx.new(|cx: &mut Context<SkillsPanel>| {
            let sub = cx.subscribe(&input, |_, _, _: &InputEvent, cx| cx.notify());
            let mut panel = SkillsPanel {
                input,
                trash_roots: skills::roots(&home, claude.clone(), codex.clone()),
                tool_roots: skills::tool_roots(&home, claude, codex),
                opts,
                rows: Vec::new(),
                closed: BTreeSet::new(),
                full_path,
                loading: true,
                notice: None,
                stars: BTreeSet::new(),
                confirming: None,
                busy: None,
                registry,
                workspace,
                _sub: sub,
            };
            panel.load_stars();
            panel.load(snapshot, cx);
            panel
        });
        self.skills = Some(panel);
    }

    pub(super) fn render_skills_panel(&self) -> AnyElement {
        self.skills.clone().map(IntoElement::into_any_element).unwrap_or_else(|| {
            div().p_3().text_xs().child("Looking for agent files…").into_any_element()
        })
    }

    /// `onMdIndexUpdated`: a fresh device index replaces the panel's rows.
    pub(super) fn skills_index_updated(&self, files: &[IndexedDoc], cx: &mut Context<Self>) {
        if let Some(panel) = &self.skills {
            let files = files.to_vec();
            panel.update(cx, |panel, cx| panel.set_rows(files, cx));
        }
    }
}

pub(super) struct SkillsPanel {
    input: Entity<InputState>,
    trash_roots: Vec<(Tool, PathBuf)>,
    tool_roots: Vec<(Tool, PathBuf)>,
    opts: ScanOptions,
    rows: Vec<Row>,
    /// Kinds toggled from their default (Skills open, the rest closed).
    closed: BTreeSet<(Tool, Kind)>,
    full_path: bool,
    loading: bool,
    notice: Option<String>,
    stars: BTreeSet<PathBuf>,
    /// The skill folder whose Remove is asking "Move … to the Trash?".
    confirming: Option<PathBuf>,
    busy: Option<PathBuf>,
    registry: Option<Rc<Registry>>,
    workspace: WeakEntity<Workspace>,
    _sub: Subscription,
}

/// `revealWord`: what the platform's file manager is called.
fn reveal_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Show in Finder"
    } else if cfg!(windows) {
        "Show in Explorer"
    } else {
        "Show in your file manager"
    }
}

/// path-display.ts `inferHomePath` and `compactHomePath(dir, home, full)`.
fn compact_home_path(input: &std::path::Path, home: &std::path::Path, full: bool) -> String {
    let Ok(rest) = input.strip_prefix(home) else {
        return input.display().to_string();
    };
    let rest = rest.to_string_lossy();
    match (rest.is_empty(), full) {
        (true, true) => "~".into(),
        (true, false) => String::new(),
        (false, false) => rest.into_owned(),
        (false, true) => format!("~{}{rest}", std::path::MAIN_SEPARATOR),
    }
}

impl SkillsPanel {
    fn set_rows(&mut self, files: Vec<IndexedDoc>, cx: &mut Context<Self>) {
        let roots = self.tool_roots.clone();
        cx.spawn(async move |this, cx| {
            let rows = cx.background_spawn(async move { skills::from_index(&files, &roots) }).await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                this.rows = rows;
                cx.notify();
            });
        })
        .detach();
    }

    fn load(&mut self, snapshot: Option<index::IndexSnapshot>, cx: &mut Context<Self>) {
        let (opts, roots) = (self.opts.clone(), self.tool_roots.clone());
        cx.spawn(async move |this, cx| {
            let rows = cx
                .background_spawn(async move {
                    let index = snapshot.unwrap_or_else(|| index::scan(&opts));
                    skills::from_index(&index.files, &roots)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                this.rows = rows;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_stars(&mut self) {
        self.stars = self
            .registry
            .as_ref()
            .and_then(|r| r.stars().ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
    }

    fn toggle_star(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        match self.registry.as_ref().map(|r| r.toggle_star(&path, "file")) {
            Some(Ok(_)) => {
                self.notice = None;
                self.load_stars();
            }
            _ => self.notice = Some("Couldn't save that star.".into()),
        }
        cx.notify();
    }

    fn toggle_full_path(&mut self, cx: &mut Context<Self>) {
        self.full_path = !self.full_path;
        if let Some(reg) = &self.registry {
            // A preference that will not save is not worth a broken panel.
            let _ = reg.set_setting(FULL_KEY, if self.full_path { "1" } else { "0" });
        }
        cx.notify();
    }

    fn trash(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        self.confirming = None;
        self.busy = Some(folder.clone());
        self.notice = None;
        let roots = self.trash_roots.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let target = skills::trash_target(&folder, &roots).map_err(str::to_owned)?;
                    trash::delete(target).map_err(|_| "Couldn't move that skill to the Trash.".to_string())
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                match result {
                    // onReindex: read the device again.
                    Ok(()) => this.load(None, cx),
                    Err(e) => this.notice = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open(&self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let _ = self.workspace.update(cx, |ws, cx| ws.open_external(vec![path], window, cx));
    }
}

fn link(id: SharedString, label: impl Into<SharedString>, color: Hsla, hover: Hsla) -> Stateful<Div> {
    div()
        .id(id)
        .rounded(px(3.))
        .text_size(px(10.5))
        .text_color(color)
        .cursor_pointer()
        .hover(move |s| s.text_color(hover))
        .child(label.into())
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

fn star(id: SharedString, on: bool, p: &Palette) -> Stateful<Div> {
    let fg = p.foreground;
    div()
        .id(id)
        .flex_none()
        .px_1()
        .text_size(px(12.))
        .cursor_pointer()
        .text_color(if on { p.yellow } else { p.muted })
        .when(!on, |d| d.hover(move |s| s.text_color(fg)))
        .child(if on { "★" } else { "☆" })
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

impl Render for SkillsPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = crate::themes::palette(cx);
        let filter = self.input.read(cx).value().to_string();
        let q = filter.trim().to_lowercase();
        let active = self
            .workspace
            .upgrade()
            .and_then(|ws| ws.read(cx).doc.as_ref().map(|d| d.path.clone()));
        let home = self.opts.home.clone();
        // Skills match their label, folder or description; other files their path.
        let shown = |row: &&Row| {
            q.is_empty()
                || if row.kind == Kind::Skill {
                    row.label.to_lowercase().contains(&q)
                        || row
                            .folder
                            .as_ref()
                            .is_some_and(|f| f.to_string_lossy().to_lowercase().contains(&q))
                        || row.description.as_ref().is_some_and(|d| d.to_lowercase().contains(&q))
                } else {
                    row.path.to_string_lossy().to_lowercase().contains(&q)
                }
        };
        let mut list = v_flex();
        let mut total = 0;
        for tool in Tool::ALL {
            let rows: Vec<&Row> = self.rows.iter().filter(|r| r.tool == tool).filter(shown).collect();
            if rows.is_empty() {
                continue;
            }
            total += rows.len();
            list = list.child(
                h_flex()
                    .px_2()
                    .pt_3()
                    .pb_1()
                    .border_b_1()
                    .border_color(p.border.opacity(0.6))
                    .bg(p.surface)
                    .text_size(px(9.))
                    .text_color(p.muted)
                    .child(tool.label().to_uppercase())
                    .child(div().ml_1().child(rows.len().to_string())),
            );
            for kind in [Kind::Skill, Kind::Instructions, Kind::Command, Kind::Agent, Kind::Memory, Kind::Other] {
                let matches: Vec<&Row> = rows.iter().copied().filter(|r| r.kind == kind).collect();
                if matches.is_empty() {
                    continue;
                }
                let open = !q.is_empty() || ((kind == Kind::Skill) ^ self.closed.contains(&(tool, kind)));
                let muted = p.muted.opacity(0.8);
                let fg = p.foreground;
                list = list.child(
                    h_flex()
                        .id(SharedString::from(format!("skills-kind-{tool:?}-{kind:?}")))
                        .w_full()
                        .px_2()
                        .pt_2()
                        .pb(px(2.))
                        .gap_1()
                        .text_size(px(10.))
                        .text_color(muted)
                        .cursor_pointer()
                        .hover(move |s| s.text_color(fg))
                        .child(div().w(px(10.)).child(if open { "▾" } else { "▸" }))
                        .child(kind.label())
                        .child(div().ml_1().child(matches.len().to_string()))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.closed.remove(&(tool, kind)) {
                                this.closed.insert((tool, kind));
                            }
                            cx.notify();
                        })),
                );
                if open {
                    for row in matches {
                        let is_active = active.as_ref() == Some(&row.path);
                        list = list.child(if kind == Kind::Skill {
                            self.skill_row(row, is_active, &p, cx).into_any_element()
                        } else {
                            self.plain_row(row, is_active, &home, &p, cx).into_any_element()
                        });
                    }
                }
            }
        }
        let body = if self.loading {
            div().px_2().py_4().text_size(px(12.)).text_color(p.muted).child("Looking for agent files…")
        } else if total == 0 {
            div().px_2().py_4().text_size(px(12.)).text_color(p.muted).child(format!(
                "No agent files found{}. Markie looks for CLAUDE.md, AGENTS.md, GEMINI.md, and the skills folders of Claude Code, Codex, Cursor, Gemini and ~/.agents.",
                if filter.is_empty() { "" } else { " for this filter" }
            ))
        } else {
            list
        };
        let full = self.full_path;
        let fg = p.foreground;
        v_flex()
            .size_full()
            .min_h_0()
            .child(
                h_flex()
                    .flex_none()
                    .px_2()
                    .py(px(6.))
                    .gap(px(6.))
                    .border_b_1()
                    .border_color(p.border)
                    .child(div().flex_1().min_w_0().child(super::rail::filter_field(&self.input, 12., &p)))
                    .child(
                        div()
                            .id("skills-full-path")
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .text_size(px(11.))
                            .cursor_pointer()
                            .when(full, |d| d.bg(p.accent).text_color(p.foreground))
                            .when(!full, |d| d.text_color(p.muted).hover(move |s| s.text_color(fg)))
                            .tooltip(|window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new("Show full ~ paths").build(window, cx)
                            })
                            .child("~/")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_full_path(cx))),
                    ),
            )
            .children(self.notice.as_ref().map(|notice| {
                div()
                    .flex_none()
                    .px_2()
                    .py(px(6.))
                    .text_size(px(11.))
                    .text_color(p.red)
                    .border_b_1()
                    .border_color(p.border)
                    .child(notice.clone())
            }))
            .child(div().id("skills-scroll").flex_1().min_h_0().overflow_y_scroll().child(body))
    }
}

impl SkillsPanel {
    /// `InstalledSkillRow`.
    fn skill_row(&self, row: &Row, active: bool, p: &Palette, cx: &mut Context<Self>) -> Stateful<Div> {
        let path = row.path.clone();
        let folder = row.folder.clone().unwrap_or_else(|| row.path.clone());
        let id = folder.display().to_string();
        let label = row.label.clone();
        let starred = self.stars.contains(&row.path);
        let confirming = self.confirming.as_ref() == Some(&folder);
        let busy = self.busy.as_ref() == Some(&folder);
        let (red, muted, fg) = (p.red, p.muted, p.foreground);
        let (star_path, reveal_path, open_path) = (path.clone(), path.clone(), path);
        let mut actions = h_flex().gap_2().pt(px(2.)).child(
            link(SharedString::from(format!("skill-reveal-{id}")), reveal_label(), muted, fg)
                .on_click(move |_, _, _| crate::logs::reveal_in_file_manager(&reveal_path)),
        );
        if row.removable {
            let mut remove = h_flex().ml_auto().gap_2().border_l_1().border_color(p.border.opacity(0.7)).pl_2();
            remove = if confirming {
                let target = folder.clone();
                remove
                    .child(div().text_size(px(10.5)).text_color(muted).child(format!("Move {label} to the Trash?")))
                    .child(
                        link(SharedString::from(format!("skill-trash-{id}")), "Move to Trash", red, red)
                            .on_click(cx.listener(move |this, _, _, cx| this.trash(target.clone(), cx))),
                    )
                    .child(link(SharedString::from(format!("skill-cancel-{id}")), "Cancel", muted, fg).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.confirming = None;
                            cx.notify();
                        }),
                    ))
            } else {
                let target = folder.clone();
                remove.child(
                    link(
                        SharedString::from(format!("skill-remove-{id}")),
                        if busy { "Removing…" } else { "Remove" },
                        red,
                        red,
                    )
                    .when(busy, |d| d.opacity(0.5))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.busy.is_none() {
                            this.confirming = Some(target.clone());
                            cx.notify();
                        }
                    })),
                )
            };
            actions = actions.child(remove);
        }
        let hover = p.accent.opacity(0.3);
        div()
            .id(SharedString::from(format!("skill-row-{id}")))
            .pl_4()
            .pr_2()
            .py_1()
            .cursor_pointer()
            .when(active, |d| d.bg(p.accent.opacity(0.4)))
            .hover(move |s| s.bg(hover))
            .child(
                h_flex()
                    .gap_1()
                    .child(div().min_w_0().flex_1().truncate().text_size(px(12.)).text_color(p.foreground.opacity(0.9)).child(row.label.clone()))
                    .child(star(SharedString::from(format!("skill-star-{id}")), starred, p).on_click(cx.listener(
                        move |this, _, _, cx| this.toggle_star(star_path.clone(), cx),
                    ))),
            )
            .children(row.description.as_ref().map(|d| {
                div().truncate().text_size(px(10.)).text_color(p.muted).child(d.clone())
            }))
            .child(actions)
            .on_click(cx.listener(move |this, _, window, cx| this.open(open_path.clone(), window, cx)))
    }

    /// A row for any agent file that is not a skill.
    fn plain_row(&self, row: &Row, active: bool, home: &std::path::Path, p: &Palette, cx: &mut Context<Self>) -> Stateful<Div> {
        let id = row.path.display().to_string();
        let (star_path, open_path) = (row.path.clone(), row.path.clone());
        let dir = row.path.parent().map(|d| compact_home_path(d, home, self.full_path)).unwrap_or_default();
        let hover = p.accent.opacity(0.3);
        h_flex()
            .id(SharedString::from(format!("agent-row-{id}")))
            .gap_1()
            .pl_4()
            .pr_2()
            .py_1()
            .cursor_pointer()
            .when(active, |d| d.bg(p.accent.opacity(0.4)))
            .hover(move |s| s.bg(hover))
            .child(
                v_flex()
                    .min_w_0()
                    .flex_1()
                    .child(div().truncate().text_size(px(12.)).text_color(p.foreground.opacity(0.9)).child(row.label.clone()))
                    .child(div().truncate().text_size(px(10.)).text_color(p.muted).child(dir)),
            )
            .child(
                star(SharedString::from(format!("agent-star-{id}")), self.stars.contains(&row.path), p)
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_star(star_path.clone(), cx))),
            )
            .on_click(cx.listener(move |this, _, window, cx| this.open(open_path.clone(), window, cx)))
    }
}

#[cfg(test)]
mod tests {
    use super::compact_home_path;
    use std::path::Path;

    #[test]
    fn home_paths_compact_as_path_display_does() {
        let home = Path::new("/Users/k");
        assert_eq!(compact_home_path(Path::new("/Users/k/work/app"), home, false), "work/app");
        assert_eq!(compact_home_path(Path::new("/Users/k/work/app"), home, true), "~/work/app");
        assert_eq!(compact_home_path(home, home, false), "");
        assert_eq!(compact_home_path(home, home, true), "~");
        assert_eq!(compact_home_path(Path::new("/opt/x"), home, true), "/opt/x");
    }

    /// A scratch run indexes its data folder as home; the Skills view must
    /// match tool roots against that same folder, or it finds nothing.
    #[test]
    fn a_scratch_index_and_its_tool_roots_share_one_home() {
        let data = tempfile::tempdir().unwrap();
        let data = data.path().canonicalize().unwrap();
        for (rel, text) in [
            (".claude/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: First\n---\n# Alpha\n"),
            (".claude/CLAUDE.md", "# Claude\n"),
        ] {
            let path = data.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let opts = crate::workspace::scan_options_for(Some(data.clone()), "/nonexistent-home".into(), Vec::new());
        assert_eq!(opts.home, data);
        let index = markie_core::index::scan(&opts);
        let rows = markie_agent::skills::from_index(&index.files, &markie_agent::skills::tool_roots(&opts.home, None, None));
        let labels: Vec<&str> = rows.iter().map(|r| r.label.as_str()).collect();
        assert!(rows.iter().any(|r| r.label == "alpha" && r.tool == markie_agent::skills::Tool::Claude), "{labels:?}");
        assert!(rows.iter().any(|r| r.path.ends_with(".claude/CLAUDE.md")), "{labels:?}");
    }
}
