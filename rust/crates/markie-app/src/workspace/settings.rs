//! Settings, laid out like `src/components/settings.tsx`: Account,
//! Appearance, Files and Advanced tabs in a 680pt overlay panel. Controls
//! for features Markie RS does not have yet are drawn the same way, greyed,
//! with a "Not in Markie RS yet" tag, so the layout matches Electron's.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::dialog_chrome::{self as chrome, Tokens, fade, mix, ring, section_label, shadow};
use super::overlay::{Overlay, SettingsSection};
use crate::actions::OpenSettings;
use crate::themes;

pub(crate) const NOT_YET: &str = "Not in Markie RS yet";

const SECTIONS: [(SettingsSection, &str); 4] = [
    (SettingsSection::Account, "Account"),
    (SettingsSection::Appearance, "Appearance"),
    (SettingsSection::Files, "Files"),
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
        "newyork" => ("New York", "New York"),
        "georgia" => ("Georgia", "Georgia"),
        "mono" => ("Monospace", "Menlo"),
        _ => ("System", ".SystemUIFont"),
    }
}

/// Settings > Files: the formats Electron offers as Finder defaults.
const DEFAULT_APP_FORMATS: [(&str, &str, &str, Option<&str>); 6] = [
    ("markdown", "Markdown", ".md  .markdown  .mdx", None),
    ("text", "Plain text", ".txt  .text", None),
    ("darkmown", "Darkmown", ".wd", None),
    ("docx", "Word", ".docx", Some("Files using features Markie can't save yet open read-only.")),
    ("rtf", "Rich Text", ".rtf", Some("Files with tables or images open read-only.")),
    ("odt", "OpenDocument", ".odt", Some("Files using features Markie can't save yet open read-only.")),
];

impl Workspace {
    fn set_color_mode(&mut self, mode: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("color_mode", mode);
        }
        match mode {
            "light" => Theme::change(ThemeMode::Light, Some(window), cx),
            "dark" => Theme::change(ThemeMode::Dark, Some(window), cx),
            _ => Theme::sync_system_appearance(Some(window), cx),
        }
        cx.notify();
    }

    pub(super) fn set_template(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("style_template", id);
        }
        themes::apply(id, Some(window), cx);
        cx.notify();
    }

    pub(super) fn on_settings(&mut self, _: &OpenSettings, window: &mut Window, cx: &mut Context<Self>) {
        // Electron opens on Account; the toolbar's theme button opens Appearance.
        self.open_settings(SettingsSection::Account, window, cx);
    }

    pub(super) fn open_settings(&mut self, section: SettingsSection, window: &mut Window, cx: &mut Context<Self>) {
        self.show_dialog(Overlay::Settings { section, colors_open: false }, window, cx);
    }

    fn settings_tab(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
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
        let max_h = window.viewport_size().height * 0.86;
        let body = match section {
            SettingsSection::Account => self.render_account_section(t, cx),
            SettingsSection::Appearance => self.render_appearance(colors_open, t, cx),
            SettingsSection::Files => render_files(t),
            SettingsSection::Advanced => self.render_advanced(t, cx),
        };
        self.panel(t, 12.)
            .id("settings-panel")
            .w(px(680.))
            .max_w(relative(0.94))
            .max_h(max_h)
            .overflow_y_scroll()
            .p(px(20.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .mb(px(16.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Settings"))
                    .child(self.close_button("settings-close", t, cx)),
            )
            .child(
                div()
                    .flex()
                    .gap(px(4.))
                    .mb(px(20.))
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

    // ------------------------------------------------------------ appearance

    fn render_appearance(&mut self, _colors_open: bool, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let mode = self.setting_or("color_mode", "system");
        let template_id = self.setting_or("style_template", "markie");
        let all = chrome::templates();
        let current = all.iter().find(|x| x.id == template_id).or_else(|| all.first()).expect("templates").clone();
        let variant = if t.dark { &current.dark } else { &current.light };
        let tone = if t.dark { "dark" } else { "light" };
        // 680 panel - 2x20 padding - 2 border, four columns with 8pt gaps.
        let card_w = (638. - 3. * 8.) / 4.;

        div()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .mb(px(12.))
                    .child(
                        div().child(section_label("Templates", t)).child(
                            div()
                                .text_size(px(11.))
                                .text_color(t.muted)
                                .mt(px(4.))
                                .child("Each template has a light and a dark version. The mode picks which one you see."),
                        ),
                    )
                    .child(segmented(
                        [("light", "Light"), ("dark", "Dark"), ("system", "System")],
                        &mode,
                        t,
                        cx,
                        |this, m, window, cx| this.set_color_mode(m, window, cx),
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .mb(px(20.))
                    .children(all.iter().map(|tpl| {
                        let id = tpl.id.clone();
                        template_card(tpl, tpl.id == template_id, t, card_w).on_click(cx.listener(
                            move |this, _, window, cx| this.set_template(&id, window, cx),
                        ))
                    })),
            )
            .child(self.render_typography(&current.name, variant, t))
            .child(
                group(t)
                    .mb(px(16.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .opacity(0.55)
                            .child(
                                div()
                                    .child(div().flex().items_center().gap(px(8.)).child(section_label("Customize colors", t)).child(badge(t)))
                                    .child(div().text_size(px(11.)).text_color(t.muted).mt(px(4.)).child(format!(
                                        "Changes save a copy of {} that stands in for {tone} mode.",
                                        current.name
                                    ))),
                            )
                            .child(chrome::stroke_icon(chrome::PATH_CHEVRON_DOWN, t.muted, 14., 2.)),
                    )
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .border_t_1()
                    .border_color(t.border)
                    .pt(px(12.))
                    .child(div().text_size(px(11.)).text_color(t.muted).child(current.name.clone()))
                    .child(
                        // Disabled because nothing is customized, as in Electron.
                        div()
                            .rounded(px(6.))
                            .border_1()
                            .border_color(t.border)
                            .px(px(10.))
                            .py(px(4.))
                            .text_size(px(11.))
                            .text_color(t.muted)
                            .opacity(0.4)
                            .child("Reset to template"),
                    ),
            )
            .into_any_element()
    }

    fn render_typography(&self, template_name: &str, v: &chrome::Variant, t: &Tokens) -> Div {
        let body = v.body_font.clone().unwrap_or_else(|| "system".into());
        let heading = v.heading_font.clone().unwrap_or_else(|| "body".into());
        let (body_label, body_family) = typeface(&body);
        let (heading_label, heading_family) = if heading == "body" { ("Same as body", body_family) } else { typeface(&heading) };
        let size = v.font_size.unwrap_or(16.);
        let lh = v.line_height.unwrap_or(1.75);
        let gap = v.paragraph_gap.unwrap_or(0.8);
        let width = v.content_width.unwrap_or(768.);
        group(t).mb(px(16.)).child(
            div()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .mb(px(12.))
                        .child(div().flex().items_center().gap(px(8.)).child(section_label("Typography", t)).child(badge(t)))
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(t.muted)
                                .child(format!("Applies to both versions of {template_name}")),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(16.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(12.))
                                .child(
                                    div()
                                        .flex()
                                        .gap(px(8.))
                                        .child(font_menu("Body font", body_label, body_family, t))
                                        .child(font_menu("Heading font", heading_label, heading_family, t)),
                                )
                                .child(range_row("Text size", format!("{size} px"), (size - 13.) / (22. - 13.), t))
                                .child(range_row("Line height", format!("{lh:.2}"), (lh - 1.3) / (2.2 - 1.3), t))
                                .child(range_row("Paragraph spacing", format!("{gap:.1} em"), (gap - 0.3) / (1.6 - 0.3), t))
                                .child(range_row("Content width", format!("{width} px"), (width - 560.) / (1200. - 560.), t)),
                        )
                        .child(specimen(body_family, heading_family, size, lh, t)),
                ),
        )
    }

    // ---------------------------------------------------------------- account

    // The account tab is the cloud sign-in work's: see account_slot.rs.

    // --------------------------------------------------------------- advanced

    fn render_advanced(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        div()
            .child(setting_block(
                "Updates",
                "Get new versions early",
                "New versions reach you first, and everyone else a few days later. Turning this off moves you back to the current stable build.",
                false,
                t,
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(t.muted)
                    .mt(px(4.))
                    .child(format!("You are running Markie RS {}.", env!("CARGO_PKG_VERSION"))),
            ))
            .child(setting_block(
                "Links",
                "Preview links on hover",
                "Rest the pointer on a link and Markie fetches the page\u{2019}s title, summary and picture. Nothing is fetched when you open a document, only when you point at a link, and the site you point at can tell that somebody looked.",
                true,
                t,
            ))
            .child(setting_block(
                "Error reporting",
                "Send crash reports",
                "Off by default. When on, Markie sends the error and where in the code it happened, so crashes get fixed. Never your documents, their contents, or their file paths.",
                false,
                t,
            ))
            .child(
                div()
                    .mb(px(20.))
                    .child(section_label("Servers", t).mb(px(8.)))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(t.muted)
                            .mb(px(8.))
                            .child("To work on someone\u{2019}s document, sign in to the server it lives on."),
                    )
                    .child(
                        div()
                            .rounded(px(6.))
                            .border_1()
                            .border_color(t.border)
                            .px(px(12.))
                            .py(px(8.))
                            .child(div().text_size(px(13.)).child("Markie Cloud"))
                            .child(div().text_size(px(11.)).text_color(t.muted).child("api.markiedocs.com"))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.))
                                    .mt(px(6.))
                                    .child(div().text_size(px(11.)).text_color(t.muted).child("Not signed in"))
                                    .child(
                                        overlay_button("server-sign-in", "Sign in", t).on_click(cx.listener(
                                            |this, _, window, cx| this.settings_tab_account(window, cx),
                                        )),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn settings_tab_account(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.settings_tab(SettingsSection::Account, cx);
    }
}

// ------------------------------------------------------------------ files

fn render_files(t: &Tokens) -> AnyElement {
    div()
        .child(
            div()
                .flex()
                .items_start()
                .justify_between()
                .gap(px(16.))
                .child(
                    div()
                        .child(div().flex().items_center().gap(px(8.)).mb(px(4.)).child(section_label("Open with Markie", t)).child(badge(t)))
                        .child(
                            div()
                                .max_w(px(330.))
                                .text_size(px(11.5))
                                .line_height(px(18.))
                                .text_color(t.muted)
                                .child("Choose the file types a double-click in Finder opens here. You can change any of these back in Finder\u{2019}s Get Info."),
                        ),
                )
                .child(disabled_button("Use Markie for all", t)),
        )
        .child(
            div()
                .mt(px(12.))
                .rounded(px(8.))
                .border_1()
                .border_color(fade(t.border, 0.7))
                .children(DEFAULT_APP_FORMATS.iter().enumerate().map(|(i, (id, label, exts, note))| {
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
                                .child(div().text_size(px(10.5)).font_family("Menlo").text_color(t.muted).child(*exts))
                                .when_some(*note, |el, note| el.child(div().text_size(px(11.)).text_color(t.muted).child(note))),
                        )
                        .child(disabled_button("Use Markie", t))
                })),
        )
        .child(
            div()
                .mt(px(8.))
                .text_size(px(11.5))
                .text_color(t.muted)
                .child("Markie RS is a side build: it never takes over what double-clicking a file does."),
        )
        .into_any_element()
}

// ---------------------------------------------------------------- widgets

/// `.markie-settings-group`.
fn group(t: &Tokens) -> Div {
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
                div()
                    .flex_1()
                    .text_size(px(12.))
                    .text_color(t.muted)
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
fn template_card(tpl: &chrome::TemplateInfo, selected: bool, t: &Tokens, w: f32) -> Stateful<Div> {
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

/// FontMenu's closed state: the label and a select-shaped button.
fn font_menu(label: &str, value: &str, family: &'static str, t: &Tokens) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .child(div().text_size(px(11.)).text_color(t.muted).mb(px(4.)).child(label.to_string()))
        .child(
            div()
                .h(px(32.))
                .flex()
                .items_center()
                .gap(px(7.))
                .rounded(px(7.))
                .border_1()
                .border_color(t.field_border())
                .bg(t.select_bg())
                .pl(px(10.4))
                .pr(px(8.8))
                .opacity(0.42)
                .child(div().flex_1().text_size(px(12.5)).font_family(family).child(value.to_string()))
                .child(chrome::stroke_icon(chrome::PATH_CHEVRON_DOWN, t.muted, 14., 2.)),
        )
}

/// RangeRow: label, value and Markie's slider track.
fn range_row(label: &str, display: String, fill: f32, t: &Tokens) -> Div {
    let fill = fill.clamp(0., 1.);
    div()
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .mb(px(4.))
                .child(div().text_size(px(12.)).child(label.to_string()))
                .child(div().text_size(px(11.)).text_color(t.muted).child(display)),
        )
        .child(
            div().h(px(16.)).relative().flex().items_center().opacity(0.55).child(
                div()
                    .w_full()
                    .h(px(4.))
                    .rounded_full()
                    .bg(fade(t.foreground, 0.14))
                    .child(div().h_full().w(relative(fill)).rounded_full().bg(t.blue)),
            )
            .child(
                div()
                    .absolute()
                    .top(px(1.))
                    .left(relative(fill))
                    .ml(px(-7.))
                    .size(px(14.))
                    .rounded_full()
                    .bg(rgb(0xffffff))
                    .border_1()
                    .border_color(fade(chrome::black(), 0.18))
                    .shadow(vec![shadow(fade(chrome::black(), 0.3), 0., 1., 3.)]),
            ),
        )
}

/// The typography specimen: a short page in the template's faces.
fn specimen(body: &'static str, heading: &'static str, size: f32, lh: f32, t: &Tokens) -> Div {
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
