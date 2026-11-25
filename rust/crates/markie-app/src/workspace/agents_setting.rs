//! Settings › Agents: the features only people who work with coding agents
//! need, kept off the rail until they ask for them.
//!
//! - "Show Skills & agent files in the sidebar" (off by default, for new and
//!   existing installs alike, since the key is new).
//! - "Organizing rules for Projects": opens `Projects.md`.
//! - "Connect an agent (MCP)": the rail's robot button.

use gpui_kit::*;

use super::Workspace;
use super::dialog_chrome::{Tokens, section_label};
use super::rail::LeftView;
use super::settings::{checkbox, overlay_button};

/// The registry key. Absent means off: the panel used to be on the rail for
/// everyone, and Kirby wants it gone until it is asked for.
pub(crate) const SKILLS_PANEL_SETTING: &str = "markie.agents.skillsPanel.v1";

/// Only an explicit "1" shows the panel.
pub(crate) fn skills_enabled(stored: Option<&str>) -> bool {
    stored == Some("1")
}

/// The view a window shows once the Skills panel is off: Skills becomes the
/// Recent page, anything else stays.
pub(crate) fn without_skills(view: LeftView) -> LeftView {
    if view == LeftView::Skills { LeftView::Recent } else { view }
}

impl Workspace {
    /// The stored switch, read at start.
    pub(super) fn load_skills_setting(&mut self) {
        let stored = self.registry.as_ref().and_then(|r| r.setting(SKILLS_PANEL_SETTING).ok().flatten());
        self.shell.skills_enabled = skills_enabled(stored.as_deref());
        self.shell.drop_skills_view_if_off();
    }

    pub(super) fn set_skills_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting(SKILLS_PANEL_SETTING, if on { "1" } else { "0" });
        }
        self.shell.skills_enabled = on;
        self.shell.drop_skills_view_if_off();
        cx.notify();
    }

    /// The rail button and the palette entry: build the panel on first show,
    /// then open it. Does nothing while the panel is off.
    pub(super) fn show_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.shell.skills_enabled {
            return;
        }
        self.prepare_skills(window, cx);
        self.select_view(LeftView::Skills, cx);
    }

    pub(super) fn render_agents_section(&self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let on = self.shell.skills_enabled;
        div()
            .child(
                div().mb(px(20.)).child(section_label("Skills & agent files", t).mb(px(8.))).child(
                    div()
                        .id("agents-skills-toggle")
                        .flex()
                        .items_start()
                        .justify_between()
                        .gap(px(12.))
                        .py(px(4.))
                        .cursor_pointer()
                        .child(
                            text(t)
                                .child("Show Skills & agent files in the sidebar")
                                .child(detail(t).child(
                                    "Adds a button to the left rail that lists the skills, instructions and agent files on this Mac, from Claude, Codex, Gemini and Cursor.",
                                )),
                        )
                        .child(checkbox(on, false, t))
                        .on_click(cx.listener(move |this, _, _, cx| this.set_skills_enabled(!on, cx))),
                ),
            )
            .child(action_row(
                "Organizing rules for Projects",
                "Projects.md tells Markie how to group your documents into projects. Edit it in plain words and the Library follows.",
                overlay_button("agents-projects-rules", "Edit rules", t)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.close_dialog(window, cx);
                        this.open_projects_config(window, cx);
                    })),
                t,
            ))
            .child(action_row(
                "Connect an agent (MCP)",
                "Let Claude, Codex or another agent read and edit your documents in Markie, through its MCP server.",
                overlay_button("agents-connect", "Connect\u{2026}", t)
                    .on_click(cx.listener(|this, _, window, cx| this.open_agents(window, cx))),
                t,
            ))
            .into_any_element()
    }
}

impl super::rail::Shell {
    /// With the panel off, a window on Skills falls back to Recent, and so
    /// does the pencil's way back.
    pub(super) fn drop_skills_view_if_off(&mut self) {
        if self.skills_enabled {
            return;
        }
        self.view = without_skills(self.view);
        self.previous_panel = without_skills(self.previous_panel);
    }
}

fn text(t: &Tokens) -> Div {
    div().flex_1().min_w_0().text_size(px(12.)).text_color(t.muted)
}

fn detail(t: &Tokens) -> Div {
    div().mt(px(2.)).text_size(px(11.)).line_height(px(18.)).text_color(t.muted_soft())
}

/// A section label, a line of explanation and a button on the right.
fn action_row(label: &str, about: &str, button: Stateful<Div>, t: &Tokens) -> Div {
    div().mb(px(20.)).child(section_label(label, t).mb(px(8.))).child(
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(text(t).child(detail(t).mt(px(0.)).child(about.to_string())))
            .child(button),
    )
}

#[cfg(test)]
mod tests {
    use super::{LeftView, SKILLS_PANEL_SETTING, skills_enabled, without_skills};

    #[test]
    fn the_skills_panel_is_off_unless_turned_on() {
        // New installs have no value; existing installs never stored one.
        assert!(!skills_enabled(None));
        assert!(!skills_enabled(Some("0")));
        assert!(!skills_enabled(Some("")));
        assert!(!skills_enabled(Some("true")));
        assert!(skills_enabled(Some("1")));
    }

    #[test]
    fn a_window_on_skills_falls_back_to_recent() {
        assert_eq!(without_skills(LeftView::Skills), LeftView::Recent);
        for v in [LeftView::Recent, LeftView::Library, LeftView::Browse, LeftView::Cloud, LeftView::Vault, LeftView::Edit] {
            assert_eq!(without_skills(v), v);
        }
    }

    #[test]
    fn the_switch_round_trips_through_the_registry() {
        let reg = markie_core::registry::Registry::in_memory().unwrap();
        assert!(!skills_enabled(reg.setting(SKILLS_PANEL_SETTING).unwrap().as_deref()));
        reg.set_setting(SKILLS_PANEL_SETTING, "1").unwrap();
        assert!(skills_enabled(reg.setting(SKILLS_PANEL_SETTING).unwrap().as_deref()));
        reg.set_setting(SKILLS_PANEL_SETTING, "0").unwrap();
        assert!(!skills_enabled(reg.setting(SKILLS_PANEL_SETTING).unwrap().as_deref()));
    }
}
