//! Settings: appearance for now (style template and light, dark or system).
//! Mirrors the Appearance section of `src/components/settings.tsx`.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme, Selectable as _, Sizable as _, Theme, ThemeMode, WindowExt as _, h_flex, v_flex};
use gpui_kit::*;

use super::Workspace;
use crate::actions::OpenSettings;
use crate::themes;

impl Workspace {
    fn setting_or(&self, key: &str, default: &str) -> String {
        self.registry
            .as_ref()
            .and_then(|r| r.setting(key).ok().flatten())
            .unwrap_or_else(|| default.to_string())
    }

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

    fn set_template(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting("style_template", id);
        }
        themes::apply(id, Some(window), cx);
        cx.notify();
    }

    pub(super) fn on_settings(&mut self, _: &OpenSettings, window: &mut Window, cx: &mut Context<Self>) {
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let Some(this) = owner.upgrade() else { return dialog };
            let (mode, template) = {
                let ws = this.read(cx);
                (ws.setting_or("color_mode", "system"), ws.setting_or("style_template", "markie"))
            };
            let muted = cx.theme().muted_foreground;
            let owner_modes = owner.clone();
            let owner_styles = owner.clone();
            dialog.title("Settings").w(px(560.)).child(
                v_flex()
                    .gap_4()
                    .child(
                        v_flex()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Appearance"))
                            .child(h_flex().gap_1().children(["system", "light", "dark"].into_iter().map(|m| {
                                let owner = owner_modes.clone();
                                let label = match m {
                                    "light" => "Light",
                                    "dark" => "Dark",
                                    _ => "Match the system",
                                };
                                Button::new(SharedString::from(format!("mode-{m}")))
                                    .small()
                                    .label(label)
                                    .selected(mode == m)
                                    .on_click(move |_, window, cx| {
                                        owner.update(cx, |this, cx| this.set_color_mode(m, window, cx)).ok();
                                    })
                            }))),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Style"))
                            .children(themes::templates().into_iter().map(|t| {
                                let owner = owner_styles.clone();
                                let id = t.id.clone();
                                let selected = template == t.id;
                                h_flex()
                                    .gap_3()
                                    .child(
                                        Button::new(SharedString::from(format!("style-{}", t.id)))
                                            .small()
                                            .w(px(110.))
                                            .label(t.name.clone())
                                            .selected(selected)
                                            .when_selected(selected)
                                            .on_click(move |_, window, cx| {
                                                owner.update(cx, |this, cx| this.set_template(&id, window, cx)).ok();
                                            }),
                                    )
                                    .child(div().text_xs().text_color(muted).child(t.description.clone()))
                            })),
                    ),
            )
        });
    }
}

trait WhenSelected {
    fn when_selected(self, selected: bool) -> Self;
}

impl WhenSelected for Button {
    fn when_selected(self, selected: bool) -> Self {
        if selected { self.primary() } else { self }
    }
}
