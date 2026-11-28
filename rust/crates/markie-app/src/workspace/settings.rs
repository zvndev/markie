//! Settings, laid out like `src/components/settings.tsx`: Account,
//! Appearance, Files, Agents (Markie RS's own) and Advanced tabs in a 680pt overlay panel. Controls
//! for features Markie RS does not have yet are drawn the same way, greyed,
//! with a "Not in Markie RS yet" tag, so the layout matches Electron's.

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_kit::component::WindowExt as _;

use super::Workspace;
use super::dialog_chrome::{self as chrome, Tokens, fade, mix, ring, section_label, shadow};
use super::overlay::{Overlay, SettingsSection};
use crate::actions::OpenSettings;
use crate::themes;

/// Electron's words for its early-access switch (`settings.tsx`).
const EARLY_ACCESS_LABEL: &str = "Get new versions early";
const EARLY_ACCESS_DETAIL: &str = "New versions reach you first, and everyone else a few days later. Turning this off moves you back to the current stable build.";

/// The Mac app (the `nightly` or `public` feature) is named Markie, so
/// "Markie RS" there would name an app the person does not have. The control
/// is still not built.
pub(crate) const NOT_YET: &str = if markie_core::paths::MAC_APP { "Not built yet" } else { "Not in Markie RS yet" };

const SECTIONS: [(SettingsSection, &str); 5] = [
    (SettingsSection::Account, "Account"),
    (SettingsSection::Appearance, "Appearance"),
    (SettingsSection::Files, "Files"),
    (SettingsSection::Agents, "Agents"),
    (SettingsSection::Advanced, "Advanced"),
];

/// Electron's TYPEFACES, as the family GPUI asks the system for.
fn typeface(id: &str) -> (&'static str, &'static str) {
    match id {
        "humanist" => ("Avenir", "Avenir Next"),
        "helvetica" => ("Helvetica", "Helvetica Neue"),
        "optima" => ("Optima", "Optima"),
        "charter" => ("Charter", "Charter"),
        "iowan" => ("Iowan", "Iowan Old Style"),
        "newyork" => ("New York", markie_editor::style::SYSTEM_SERIF),
        "georgia" => ("Georgia", "Georgia"),
        "mono" => ("Monospace", markie_editor::MONO),
        _ => ("System", ".SystemUIFont"),
    }
}

/// Settings > Files: the formats Electron offers as Finder defaults.

impl Workspace {
    /// Keep the store across launches (`markie.themes.v1`'s JSON), and the
    /// template id older code reads.
    pub(super) fn save_theme_store(&self, cx: &App) {
        let store = themes::store(cx);
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("themes.v1", &store.to_json());
            let _ = reg.set_setting("style_template", &store.active_template().id);
        }
    }

    /// A theme change the person made: kept here and sent to the account
    /// (`pushCloudThemes`, a no-op when signed out).
    pub(super) fn theme_changed(&self, cx: &App) {
        // Locked while an owner's pinned theme shows (`themeLocked`).
        if self.doc_theme_pinned() {
            return;
        }
        self.save_theme_store(cx);
        super::theme_sync::push_cloud_themes(cx);
    }

    /// Same path as the title bar's switch, so the two never disagree.
    fn set_color_mode(&mut self, mode: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.pick_color_mode(super::chrome::ColorMode::parse(Some(mode)), window, cx);
    }

    pub(super) fn set_template(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("style_template", id);
        }
        themes::apply(id, Some(window), cx);
        self.theme_changed(cx);
        self.shell.template = id.to_string();
        cx.notify();
    }

    pub(super) fn on_settings(&mut self, _: &OpenSettings, window: &mut Window, cx: &mut Context<Self>) {
        // Electron opens on Account; the toolbar's theme button opens Appearance.
        self.open_settings(SettingsSection::Account, window, cx);
    }

    pub(super) fn open_settings(&mut self, section: SettingsSection, window: &mut Window, cx: &mut Context<Self>) {
        self.show_dialog(Overlay::Settings { section, colors_open: false }, window, cx);
    }

    pub(super) fn settings_tab(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
        if let Overlay::Settings { section: s, .. } = &mut self.dialogs.open {
            *s = section;
        }
        cx.notify();
    }

    pub(super) fn render_settings(
        &mut self,
        section: SettingsSection,
        colors_open: bool,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // The style editor stands in for the Settings panel while it is open.
        if section == SettingsSection::Appearance && self.appearance.style.editing {
            return self.render_style_editor(t, window, cx);
        }
        let max_h = window.viewport_size().height * 0.86;
        let body = match section {
            SettingsSection::Account => self.render_account_section(t, cx),
            SettingsSection::Appearance => self.render_appearance_live(colors_open, t, window, cx),
            // A scene can show the Google section alone, to fit one frame.
            SettingsSection::Files if cx.try_global::<super::google_docs::GoogleDocs>().is_some_and(|g| g.scene_only) => self.render_google_docs_setting(t, cx),
            SettingsSection::Files => div()
                .child(self.render_bring_docs_setting(t, cx))
                .child(self.render_google_docs_setting(t, cx))
                .child(self.render_files(t, cx))
                .into_any_element(),
            SettingsSection::Agents => self.render_agents_section(t, cx),
            SettingsSection::Advanced => self.render_advanced(t, window, cx),
        };
        // The title and the tab bar stay put; only the tab's body scrolls, so a
        // tall tab (Files) never runs past the window and its bottom padding
        // shows once scrolled to the end. Each tab keeps its own scroll.
        let tab_label = SECTIONS.iter().find(|(id, _)| *id == section).map_or("Account", |(_, l)| *l);
        let body = div()
            .id(SharedString::from(format!("settings-body-{tab_label}")))
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(20.))
            .pt(px(20.))
            .pb(px(20.))
            .child(body);
        self.panel(t, 12.)
            .id("settings-panel")
            .w(px(680.))
            .max_w(relative(0.94))
            .max_h(max_h)
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(20.))
                    .pt(px(20.))
                    .mb(px(16.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Settings"))
                    .child(self.close_button("settings-close", t, cx)),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .gap(px(4.))
                    .mx(px(20.))
                    .border_b_1()
                    .border_color(t.border)
                    .children(SECTIONS.iter().map(|(id, label)| {
                        let id = *id;
                        let on = id == section;
                        let fg = t.foreground;
                        div()
                            .id(SharedString::from(format!("settings-tab-{label}")))
                            .px(px(12.))
                            .py(px(8.))
                            .mb(px(-1.))
                            .border_b_2()
                            .text_size(px(12.))
                            .cursor_pointer()
                            .when_else(
                                on,
                                |el| el.border_color(t.foreground).text_color(t.foreground),
                                |el| el.border_color(transparent_black()).text_color(t.muted).hover(move |el| el.text_color(fg)),
                            )
                            .child(*label)
                            .on_click(cx.listener(move |this, _, _, cx| this.settings_tab(id, cx)))
                    })),
            )
            .child(body)
            .into_any_element()
    }

    // ---------------------------------------------------------------- account

    // The account tab is the cloud sign-in work's: see account_slot.rs.

    // --------------------------------------------------------------- advanced

    fn render_advanced(&mut self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let running = div()
            .text_size(px(11.))
            .text_color(t.muted)
            .mt(px(4.))
            .child(format!("You are running {} {}.", markie_core::paths::APP_NAME, markie_core::paths::APP_VERSION));
        // The public app reads the early-access feed when this is on
        // (updates.rs); the nightly has one feed and the dev build none.
        let updates = if markie_core::paths::PUBLIC {
            self.early_access_setting(t, cx).child(running)
        } else {
            setting_block("Updates", EARLY_ACCESS_LABEL, EARLY_ACCESS_DETAIL, false, t).child(running)
        };
        div()
            .child(updates)
            .child(self.link_preview_setting(t, cx))
            // The working switch from logs.rs; absent, as in Electron, when no
            // report address is configured.
            .children(crate::logs::render_crash_setting(cx).map(|el| div().mb(px(20.)).child(el)))
            // Markie Cloud and the servers added here (servers_setting.rs).
            .child(self.render_servers_setting(t, window, cx))
            .into_any_element()
    }
}

// ------------------------------------------------------------------ files

impl Workspace {
    /// "Open with Markie": who opens each format on a double-click, and on
    /// the Mac app a button that makes it Markie (default_apps.rs). The dev
    /// build shows the same list with the buttons disabled.
    fn render_files(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let claim = crate::default_apps::can_claim();
        let statuses = crate::default_apps::status();
        let all_markie = statuses.iter().all(|s| s.markie);
        let header_button = if claim && !all_markie {
            claim_button("default-apps-all", "Use Markie for all", t)
                .on_click(cx.listener(|this, _, window, cx| {
                    let ids: Vec<&str> = crate::default_apps::FORMATS.iter().map(|f| f.id).collect();
                    this.claim_default_apps(&ids, window, cx);
                }))
                .into_any_element()
        } else if claim {
            div().flex_none().text_size(px(11.5)).text_color(t.muted).child("Markie opens all of these").into_any_element()
        } else {
            disabled_button("Use Markie for all", t).into_any_element()
        };
        div()
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(16.))
                    .child(
                        div()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .mb(px(4.))
                                    .child(section_label("Open with Markie", t))
                                    .when(!claim, |el| el.child(badge(t))),
                            )
                            .child(
                                div()
                                    .max_w(px(330.))
                                    .text_size(px(11.5))
                                    .line_height(px(18.))
                                    .text_color(t.muted)
                                    .child("Choose the file types a double-click in Finder opens here. You can change any of these back in Finder\u{2019}s Get Info."),
                            ),
                    )
                    .child(header_button),
            )
            .child(
                div()
                    .mt(px(12.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(fade(t.border, 0.7))
                    .children(crate::default_apps::FORMATS.iter().zip(statuses).enumerate().map(|(i, (f, status))| {
                        let (id, label, note) = (f.id, &f.label, &f.note);
                        let exts = f.extensions.join("  ");
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .px(px(12.))
                            .py(px(8.))
                            .when(i > 0, |el| el.border_t_1().border_color(fade(t.border, 0.6)))
                            .child(chrome::format_mark(id, "sm", t))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(div().text_size(px(12.5)).child(*label))
                                    .child(div().text_size(px(10.5)).font_family("Menlo").text_color(t.muted).child(exts))
                                    .when_some(*note, |el, note| el.child(div().text_size(px(11.)).text_color(t.muted).child(note))),
                            )
                            // Who opens it on a double-click today, or the button that makes it Markie.
                            .child(if status.markie {
                                div().text_size(px(11.5)).text_color(t.muted).child("Markie").into_any_element()
                            } else if claim {
                                claim_button(SharedString::from(format!("default-app-{id}")), "Use Markie", t)
                                    .on_click(cx.listener(move |this, _, window, cx| this.claim_default_apps(&[id], window, cx)))
                                    .into_any_element()
                            } else {
                                disabled_button(&format!("Use {}", markie_core::paths::APP_NAME), t).into_any_element()
                            })
                    })),
            )
            .child(div().mt(px(8.)).text_size(px(11.5)).text_color(t.muted).child(crate::default_apps::note()))
            .into_any_element()
    }

    /// Make Markie the default for `ids`, then draw the list again from what
    /// LaunchServices now says. A refusal is said, never hidden.
    fn claim_default_apps(&mut self, ids: &[&str], window: &mut Window, cx: &mut Context<Self>) {
        if let Err(problem) = crate::default_apps::claim(ids) {
            window.push_notification(problem, cx);
        }
        cx.notify();
    }
}

/// The small bordered button of the Files list, live.
fn claim_button(id: impl Into<ElementId>, label: &str, t: &Tokens) -> Stateful<Div> {
    let (fg, hover) = (t.foreground, t.hover_soft());
    div()
        .id(id)
        .flex_none()
        .rounded(px(6.))
        .border_1()
        .border_color(t.border)
        .px(px(10.))
        .py(px(4.))
        .text_size(px(11.5))
        .text_color(t.muted)
        .cursor_pointer()
        .hover(move |el| el.text_color(fg).bg(hover))
        .child(label.to_string())
}

// ---------------------------------------------------------------- widgets

/// `.markie-settings-group`.
pub(super) fn group(t: &Tokens) -> Div {
    div()
        .rounded(px(10.))
        .border_1()
        .border_color(fade(t.border, 0.85))
        .px(px(14.))
        .py(px(12.))
        .bg(fade(t.background, 0.32))
}

/// The tag on a control Markie RS cannot honour yet.
pub(crate) fn badge(t: &Tokens) -> Div {
    div()
        .flex_none()
        .rounded(px(4.))
        .px(px(5.))
        .bg(fade(t.blue, 0.16))
        .text_size(px(9.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(t.foreground)
        .child(NOT_YET)
}

/// `markie.linkPreviews.v1`: absent or anything but "0" means on, so a
/// half-written value never turns the feature off (`link-previews.ts`).
pub(crate) const LINK_PREVIEWS_SETTING: &str = "markie.linkPreviews.v1";

pub(crate) fn link_previews_enabled(stored: Option<&str>) -> bool {
    stored != Some("0")
}

impl Workspace {
    /// The stored switch, given to the editor at start.
    pub(super) fn load_link_previews(&mut self, cx: &mut Context<Self>) {
        let stored = self.registry.as_ref().and_then(|r| r.setting(LINK_PREVIEWS_SETTING).ok().flatten());
        let on = link_previews_enabled(stored.as_deref());
        self.rich.update(cx, |r, _| r.link_previews = on);
    }

    fn set_link_previews(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting(LINK_PREVIEWS_SETTING, if on { "1" } else { "0" });
        }
        self.rich.update(cx, |r, cx| r.set_link_previews(on, cx));
        cx.notify();
    }

    /// `LinkPreviewSetting`: the working switch under Links.
    /// "Get new versions early", working: `update-channel.json` in this app's
    /// data folder, read by every update check.
    fn early_access_setting(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let on = crate::updates::early_access::read(&markie_core::paths::data_dir());
        div().mb(px(20.)).child(section_label("Updates", t).mb(px(8.))).child(
            div()
                .id("early-access")
                .flex()
                .items_start()
                .justify_between()
                .gap(px(12.))
                .py(px(4.))
                .cursor_pointer()
                .child(
                    setting_text(t).child(EARLY_ACCESS_LABEL).child(
                        div().mt(px(2.)).text_size(px(11.)).line_height(px(18.)).text_color(t.muted_soft()).child(EARLY_ACCESS_DETAIL),
                    ),
                )
                .child(checkbox(on, false, t))
                .on_click(cx.listener(move |_, _, window, cx| {
                    if !crate::updates::early_access::write(&markie_core::paths::data_dir(), !on) {
                        window.push_notification("Markie couldn\u{2019}t save that choice.", cx);
                    }
                    cx.notify();
                })),
        )
    }

    fn link_preview_setting(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let on = self.rich.read(cx).link_previews;
        div().mb(px(20.)).child(section_label("Links", t).mb(px(8.))).child(
            div()
                .id("link-previews")
                .flex()
                .items_start()
                .justify_between()
                .gap(px(12.))
                .py(px(4.))
                .cursor_pointer()
                .child(
                    setting_text(t)
                        .child("Preview links on hover")
                        .child(
                            div()
                                .mt(px(2.))
                                .text_size(px(11.))
                                .line_height(px(18.))
                                .text_color(t.muted_soft())
                                .child("Rest the pointer on a link and Markie fetches the page\u{2019}s title, summary and picture. Nothing is fetched when you open a document, only when you point at a link, and the site you point at can tell that somebody looked."),
                        ),
                )
                .child(checkbox(on, false, t))
                .on_click(cx.listener(move |this, _, _, cx| this.set_link_previews(!on, cx))),
        )
    }
}

/// The words beside a checkbox in Advanced: the span in Electron's
/// `label.flex.justify-between`. It may shrink below its text's width, so
/// the description wraps inside the panel and the checkbox stays on it.
fn setting_text(t: &Tokens) -> Div {
    div().flex_1().min_w_0().text_size(px(12.)).text_color(t.muted)
}

/// A labelled checkbox row in Advanced (`label.flex.items-start`), greyed
/// with the tag because Markie RS has no switch behind it yet.
fn setting_block(section: &str, label: &str, detail: &str, checked: bool, t: &Tokens) -> Div {
    div().mb(px(20.)).child(section_label(section, t).mb(px(8.))).child(
        div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(12.))
            .py(px(4.))
            .child(
                setting_text(t)
                    .child(div().flex().items_center().gap(px(8.)).child(label.to_string()).child(badge(t)))
                    .child(
                        div()
                            .mt(px(2.))
                            .text_size(px(11.))
                            .line_height(px(18.))
                            .text_color(t.muted_soft())
                            .child(detail.to_string()),
                    ),
            )
            .child(checkbox(checked, true, t)),
    )
}

/// Chromium's checkbox, 13pt, in the theme's colours.
pub(crate) fn checkbox(checked: bool, disabled: bool, t: &Tokens) -> Div {
    div()
        .size(px(14.))
        .flex_none()
        .mt(px(2.))
        .rounded(px(3.))
        .flex()
        .items_center()
        .justify_center()
        .when_else(
            checked,
            |el| el.bg(t.blue).child(chrome::stroke_icon(chrome::PATH_CHECK, t.background, 11., 3.2)),
            |el| el.border_1().border_color(mix(t.foreground, 0.3, t.border)).bg(t.field_bg()),
        )
        .when(disabled, |el| el.opacity(0.5))
}

/// `.markie-overlay-button` with a border: the small secondary button.
pub(crate) fn overlay_button(id: &'static str, label: &str, t: &Tokens) -> Stateful<Div> {
    let (fg, hover) = (t.foreground, t.hover_soft());
    div()
        .id(id)
        .flex_none()
        .rounded(px(6.))
        .border_1()
        .border_color(t.border)
        .px(px(12.))
        .py(px(6.))
        .text_size(px(12.))
        .text_color(t.muted)
        .cursor_pointer()
        .hover(move |el| el.text_color(fg).bg(hover))
        .child(label.to_string())
}

fn disabled_button(label: &str, t: &Tokens) -> Div {
    div()
        .flex_none()
        .rounded(px(6.))
        .border_1()
        .border_color(t.border)
        .px(px(10.))
        .py(px(4.))
        .text_size(px(11.5))
        .text_color(t.muted)
        .opacity(0.5)
        .child(label.to_string())
}

/// Appearance's Light / Dark / System switch.
pub(super) fn color_mode_control(mode: &str, t: &Tokens, cx: &mut Context<Workspace>) -> Div {
    segmented([("light", "Light"), ("dark", "Dark"), ("system", "System")], mode, t, cx, |this, m, window, cx| {
        this.set_color_mode(m, window, cx)
    })
}

/// `.markie-segmented-control` with `.markie-segmented-option`s.
fn segmented<const N: usize>(
    options: [(&'static str, &'static str); N],
    current: &str,
    t: &Tokens,
    cx: &mut Context<Workspace>,
    pick: fn(&mut Workspace, &'static str, &mut Window, &mut Context<Workspace>),
) -> Div {
    let track = if t.dark {
        mix(t.background, 0.78, t.surface)
    } else {
        mix(t.foreground, 0.09, t.surface)
    };
    div()
        .flex()
        .gap(px(2.))
        .p(px(2.))
        .rounded(px(9.))
        .bg(track)
        .when(t.dark, |el| el.border_1().border_color(fade(t.border, 0.88)).shadow(vec![chrome::inset_blur(fade(chrome::black(), 0.12), 1., 3.)]))
        .children(options.into_iter().map(|(id, label)| {
            let on = id == current;
            let fg = t.foreground;
            div()
                .id(SharedString::from(format!("seg-{id}")))
                .min_h(px(28.))
                .flex()
                .items_center()
                .rounded(px(7.))
                .px(px(10.4))
                .text_size(px(11.5))
                .cursor_pointer()
                .when_else(
                    on,
                    |el| {
                        if t.dark {
                            el.bg(t.accent)
                                .text_color(t.foreground)
                                .shadow(vec![chrome::inset(fade(t.foreground, 0.09), 1.), shadow(fade(chrome::black(), 0.13), 0., 2., 7.)])
                        } else {
                            el.bg(t.background).text_color(t.foreground).shadow(vec![shadow(fade(chrome::black(), 0.12), 0., 1., 2.)])
                        }
                    },
                    |el| el.text_color(t.muted).hover(move |el| el.text_color(fg)),
                )
                .child(label)
                .on_click(cx.listener(move |this, _, window, cx| pick(this, id, window, cx)))
        }))
}

/// Electron's TemplateCard: a miniature page painted in the template's own
/// colours and faces.
pub(super) fn template_card(tpl: &chrome::TemplateInfo, selected: bool, t: &Tokens, w: f32) -> Stateful<Div> {
    let v = if t.dark { &tpl.dark } else { &tpl.light };
    let p = Tokens::from_variant(v, t.dark);
    let body = typeface(v.body_font.as_deref().unwrap_or("system")).1;
    let heading = match v.heading_font.as_deref() {
        None | Some("body") => body,
        Some(h) => typeface(h).1,
    };
    let hover = fade(t.foreground, 0.04);
    let mut preview_shadow = vec![shadow(fade(chrome::black(), 0.16), 0., 1., 2.)];
    if selected {
        preview_shadow = vec![ring(t.blue, 3.5), ring(t.panel_bg(), 2.)];
    }
    div()
        .id(SharedString::from(format!("template-{}", tpl.id)))
        .w(px(w))
        .flex()
        .flex_col()
        .gap(px(7.))
        .rounded(px(10.))
        .pt(px(6.))
        .px(px(6.))
        .pb(px(8.))
        .cursor_pointer()
        .when(selected, |el| el.bg(fade(t.foreground, 0.035)))
        .hover(move |el| el.bg(hover))
        .child(
            div()
                .relative()
                .flex()
                .h(px(78.))
                .overflow_hidden()
                .rounded(px(8.))
                .border_1()
                .border_color(p.border)
                .bg(p.background)
                .text_color(p.foreground)
                .shadow(preview_shadow)
                .child(
                    div()
                        .w(relative(0.24))
                        .h_full()
                        .flex()
                        .flex_col()
                        .gap(px(5.))
                        .border_r_1()
                        .border_color(p.border)
                        .bg(p.surface)
                        .px(px(6.))
                        .py(px(10.))
                        .children([1.0f32, 0.72, 0.52].map(|f| {
                            div().w(relative(f)).h(px(3.)).rounded(px(2.)).bg(p.muted).opacity(0.5)
                        })),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .justify_center()
                        .gap(px(4.))
                        .px(px(10.))
                        .py(px(6.))
                        .child(
                            div()
                                .font_family(heading)
                                .text_size(px(23.))
                                .line_height(px(23.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Aa"),
                        )
                        .child(
                            div()
                                .font_family(body)
                                .text_size(px(10.5))
                                .line_height(px(13.))
                                .text_color(p.muted)
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .child("The quiet page"),
                        )
                        .child(div().w(relative(0.42)).h(px(2.)).mt(px(3.)).rounded(px(2.)).bg(p.blue)),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(7.))
                        .right(px(7.))
                        .size(px(7.))
                        .rounded_full()
                        .bg(p.blue)
                        .shadow(vec![ring(p.background, 2.)]),
                ),
        )
        .child(
            div()
                .flex()
                .min_h(px(16.))
                .items_center()
                .justify_between()
                .gap(px(6.))
                .px(px(2.))
                .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).child(tpl.name.clone()))
                .when(selected, |el| {
                    el.child(
                        div()
                            .size(px(16.))
                            .rounded_full()
                            .bg(t.blue)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(chrome::stroke_icon("M5 12.5 10 17 19 7", t.background, 10., 3.2)),
                    )
                }),
        )
        .child(
            div()
                .px(px(2.))
                .text_size(px(10.5))
                .line_height(px(14.7))
                .text_color(t.muted)
                .child(tpl.description.clone()),
        )
}

/// The typography specimen: a short page in the template's faces.
pub(super) fn specimen(body: SharedString, heading: SharedString, size: f32, lh: f32, t: &Tokens) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .relative()
        .min_h(px(210.))
        .overflow_hidden()
        .rounded(px(8.))
        .border_1()
        .border_color(fade(t.border, 0.85))
        .bg(t.background)
        .child(
            div()
                .absolute()
                .top(px(12.))
                .left(px(16.))
                .right(px(16.))
                .bottom_0()
                .overflow_hidden()
                .font_family(body)
                .text_size(px(size))
                .line_height(px(size * lh))
                .child(
                    div()
                        .font_family(heading)
                        .text_size(px(size * 1.25))
                        .line_height(px(size * 1.25 * 1.25))
                        .font_weight(FontWeight::SEMIBOLD)
                        .mb(px(size * 0.5))
                        .child("On reading slowly"),
                )
                .child(div().mb(px(size * 0.8)).child(
                    "A good page gets out of the way. The measure is comfortable, the lines have room to breathe, and links are easy to find without shouting.",
                ))
                .child("Every paragraph is given the same calm space before the next one begins."),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .h(px(40.))
                .bg(linear_gradient(
                    180.,
                    linear_color_stop(fade(t.background, 0.), 0.),
                    linear_color_stop(t.background, 1.),
                )),
        )
}

#[cfg(test)]
mod link_preview_tests {
    use super::link_previews_enabled;

    /// Without a zero minimum width the description kept its one-line width,
    /// ran past the panel and pushed the checkbox out of sight.
    #[test]
    fn setting_text_may_shrink_so_its_checkbox_stays_on_the_panel() {
        use gpui_kit::Styled as _;
        let c = gpui_kit::black();
        let t = super::super::dialog_chrome::Tokens { dark: true, background: c, surface: c, surface2: c, foreground: c, muted: c, border: c, accent: c, blue: c, red: c };
        let mut text = super::setting_text(&t);
        let style = text.style();
        assert_eq!(style.flex_grow, Some(1.));
        assert_eq!(style.min_size.width, Some(gpui_kit::px(0.).into()));
    }

    #[test]
    fn the_not_yet_tag_names_this_build() {
        // The dev build is Markie RS beside the shipping Markie; the Mac app is Markie.
        assert_eq!(super::NOT_YET.contains("Markie RS"), !markie_core::paths::MAC_APP);
        assert_eq!(crate::default_apps::note().contains("side build"), !markie_core::paths::MAC_APP);
    }

    #[test]
    fn only_an_explicit_zero_turns_previews_off() {
        assert!(link_previews_enabled(None));
        assert!(link_previews_enabled(Some("1")));
        assert!(link_previews_enabled(Some("")));
        assert!(link_previews_enabled(Some("garbage")));
        assert!(!link_previews_enabled(Some("0")));
    }
}
