//! Settings › Appearance, live: Electron's `AppearanceSection` over the theme
//! store (`markie_core::theme`). Templates, "Your presets", typography (two
//! font menus and four sliders), "Customize colors" (seven colour fields that
//! fork a built-in into a custom preset for this tone), "Delete preset" and
//! "Reset to template".
//!
//! One difference by necessity: Chromium's colour well opens the system
//! colour panel; here each colour is a hex field with a swatch.

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::theme::{
    CONTENT_WIDTH_LIMITS, FONT_SIZE_LIMITS, HEADING_SAME_AS_BODY, LINE_HEIGHT_LIMITS, PARAGRAPH_GAP_LIMITS, TYPEFACES,
    ThemeStore, ThemeTokens, Tone, TypographyPatch, find_template, preset_tone, typeface,
};

use super::Workspace;
use super::dialog_chrome::{self as chrome, Tokens, fade, section_label};
use super::overlay::Overlay;
use crate::themes;

/// `COLOR_FIELDS` in settings.tsx.
pub(crate) const COLOR_FIELDS: [(&str, &str); 7] = [
    ("background", "Background"),
    ("surface", "Surface"),
    ("foreground", "Text"),
    ("muted", "Muted text"),
    ("border", "Borders"),
    ("accent", "Accent"),
    ("link", "Links"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Slider {
    Size,
    LineHeight,
    Gap,
    Width,
}

impl Slider {
    fn limits(self) -> (f64, f64, f64) {
        match self {
            Slider::Size => FONT_SIZE_LIMITS,
            Slider::LineHeight => LINE_HEIGHT_LIMITS,
            Slider::Gap => PARAGRAPH_GAP_LIMITS,
            Slider::Width => CONTENT_WIDTH_LIMITS,
        }
    }

    /// The value at `frac` of the track, on the slider's step, rounded the
    /// way settings.tsx rounds it.
    pub(crate) fn value_at(self, frac: f32) -> f64 {
        let (min, max, step) = self.limits();
        let raw = min + (max - min) * frac.clamp(0., 1.) as f64;
        let v = (((raw - min) / step).round() * step + min).clamp(min, max);
        match self {
            Slider::LineHeight => (v * 100.).round() / 100.,
            Slider::Gap => (v * 10.).round() / 10.,
            _ => v.round(),
        }
    }

    fn patch(self, v: f64) -> TypographyPatch {
        let mut p = TypographyPatch::default();
        match self {
            Slider::Size => p.font_size = Some(v),
            Slider::LineHeight => p.line_height = Some(v),
            Slider::Gap => p.paragraph_gap = Some(v),
            Slider::Width => p.content_width = Some(v),
        }
        p
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FontSlot {
    Body,
    Heading,
}

pub(crate) struct AppearanceUi {
    font_open: Option<FontSlot>,
    dragging: Option<Slider>,
    tracks: [Rc<Cell<Bounds<Pixels>>>; 4],
    colors: Vec<Entity<InputState>>,
    /// The preset id and tokens the colour fields were last filled from.
    synced: Option<String>,
}

fn token(t: &ThemeTokens, key: &str) -> String {
    match key {
        "background" => t.background.clone(),
        "surface" => t.surface.clone(),
        "foreground" => t.foreground.clone(),
        "muted" => t.muted.clone(),
        "border" => t.border.clone(),
        "accent" => t.accent.clone(),
        _ => t.link.clone(),
    }
}

fn set_token(t: &mut ThemeTokens, key: &str, value: String) {
    match key {
        "background" => t.background = value,
        "surface" => t.surface = value,
        "foreground" => t.foreground = value,
        "muted" => t.muted = value,
        "border" => t.border = value,
        "accent" => t.accent = value,
        _ => t.link = value,
    }
}

/// `#rgb` or `#rrggbb`, lowercased as a colour well reports it.
pub(crate) fn clean_hex(raw: &str) -> Option<String> {
    let h = raw.trim().trim_start_matches('#').to_ascii_lowercase();
    let full = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 => h,
        _ => return None,
    };
    full.chars().all(|c| c.is_ascii_hexdigit()).then(|| format!("#{full}"))
}

fn new_preset_id() -> String {
    format!("custom-{}", markie_core::clock::now_ms())
}

impl AppearanceUi {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Workspace>) -> (Self, Vec<Subscription>) {
        let mut colors = Vec::new();
        let mut subs = Vec::new();
        for (i, (key, _)) in COLOR_FIELDS.iter().enumerate() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("#000000"));
            let key: &'static str = key;
            subs.push(cx.subscribe(&input, move |this: &mut Workspace, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let value = state.read(cx).value().to_string();
                    this.edit_color(i, key, &value, cx);
                }
            }));
            colors.push(input);
        }
        let ui = Self {
            font_open: None,
            dragging: None,
            tracks: std::array::from_fn(|_| Rc::new(Cell::new(Bounds::default()))),
            colors,
            synced: None,
        };
        (ui, subs)
    }
}

fn tone_of(t: &Tokens) -> Tone {
    if t.dark { Tone::Dark } else { Tone::Light }
}

fn tone_label(tone: Tone) -> &'static str {
    if tone == Tone::Light { "Light" } else { "Dark" }
}

impl Workspace {
    fn commit_store(&mut self, store: ThemeStore, cx: &mut Context<Self>) {
        let id = store.normalized().active_template().id.clone();
        themes::apply_store(store, None, cx);
        self.save_theme_store(cx);
        self.shell.template = id;
        cx.notify();
    }

    fn edit_color(&mut self, _index: usize, key: &'static str, raw: &str, cx: &mut Context<Self>) {
        let Some(hex) = clean_hex(raw) else { return };
        let dark = cx.theme_dark();
        let store = themes::store(cx);
        let tone = if dark { Tone::Dark } else { Tone::Light };
        let (current, _) = store.painted(tone);
        if token(&current.tokens, key).eq_ignore_ascii_case(&hex) {
            return;
        }
        let next = store.edit_colors(tone, |t| set_token(t, key, hex), &new_preset_id());
        self.appearance.synced = Some(next.preset_for_tone(tone).id);
        self.commit_store(next, cx);
    }

    fn slide(&mut self, slider: Slider, x: Pixels, cx: &mut Context<Self>) {
        let b = self.appearance.tracks[slider as usize].get();
        if b.size.width <= px(0.) {
            return;
        }
        let frac = ((x - b.origin.x) / b.size.width).clamp(0., 1.);
        let v = slider.value_at(frac);
        let store = themes::store(cx);
        let (_, t) = store.painted(if cx.theme_dark() { Tone::Dark } else { Tone::Light });
        let same = match slider {
            Slider::Size => t.font_size == v,
            Slider::LineHeight => t.line_height == v,
            Slider::Gap => t.paragraph_gap == v,
            Slider::Width => t.content_width == v,
        };
        if !same {
            self.commit_store(store.set_typography(&slider.patch(v)), cx);
        }
    }

    fn pick_font(&mut self, slot: FontSlot, id: &str, cx: &mut Context<Self>) {
        let mut patch = TypographyPatch::default();
        match slot {
            FontSlot::Body => patch.body_font = Some(id.into()),
            FontSlot::Heading => patch.heading_font = Some(id.into()),
        }
        self.appearance.font_open = None;
        let next = themes::store(cx).set_typography(&patch);
        self.commit_store(next, cx);
    }

    fn toggle_colors(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Overlay::Settings { colors_open, .. } = &mut self.dialogs.open {
            *colors_open = !*colors_open;
        }
        self.appearance.synced = None;
        self.sync_color_fields(window, cx);
        cx.notify();
    }

    /// Fill the colour fields from the preset on screen when it changed.
    fn sync_color_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (preset, _) = themes::painted(cx, cx.theme_dark());
        let stamp = format!("{}:{:?}", preset.id, preset.tokens);
        if self.appearance.synced.as_deref() == Some(stamp.as_str()) {
            return;
        }
        for (input, (key, _)) in self.appearance.colors.clone().iter().zip(COLOR_FIELDS) {
            let v = token(&preset.tokens, key).to_uppercase();
            input.update(cx, |s, cx| s.set_value(v, window, cx));
        }
        self.appearance.synced = Some(stamp);
    }

    pub(super) fn render_appearance_live(&mut self, colors_open: bool, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if colors_open {
            self.sync_color_fields(window, cx);
        }
        let mode = self.setting_or("color_mode", "system");
        let tone = tone_of(t);
        let store = themes::store(cx).normalized();
        let template = store.active_template();
        let current = store.preset_for_tone(tone);
        let (painted, typo) = store.painted(tone);
        let customized = store.overrides.as_ref().is_some_and(|o| o.light.is_some() || o.dark.is_some())
            || store.typography.as_ref().is_some_and(|p| *p != TypographyPatch::default());
        let overridden = store.overrides.as_ref().is_some_and(|o| if tone == Tone::Light { o.light.is_some() } else { o.dark.is_some() });
        let all = chrome::templates();
        let card_w = (638. - 3. * 8.) / 4.;

        let templates = div().flex().flex_wrap().gap(px(8.)).mb(px(20.)).children(all.iter().map(|tpl| {
            let id = tpl.id.clone();
            let selected = tpl.id == template.id;
            super::settings::template_card(tpl, selected, t, card_w)
                .when(selected && overridden, |el| el.child(customized_tag(t)))
                .on_click(cx.listener(move |this, _, window, cx| this.set_template(&id, window, cx)))
        }));

        let presets = (!store.custom.is_empty()).then(|| {
            div().mb(px(20.)).child(section_label("Your presets", t).mb(px(8.))).child(
                div().flex().flex_wrap().gap(px(8.)).children(store.custom.iter().map(|p| {
                    let tpl_name = find_template(p.template_id.as_deref()).map(|x| format!("{}, ", x.name)).unwrap_or_default();
                    let variant = serde_json::to_value(&p.tokens).ok().and_then(|v| serde_json::from_value::<chrome::Variant>(v).ok());
                    let info = variant.map(|v| chrome::TemplateInfo {
                        id: p.id.clone(),
                        name: p.name.clone(),
                        description: format!("{tpl_name}{} only", tone_label(preset_tone(p)).to_lowercase()),
                        light: v.clone(),
                        dark: v,
                    });
                    let id = p.id.clone();
                    let selected = p.id == current.id;
                    match info {
                        Some(info) => super::settings::template_card(&info, selected, t, card_w)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let next = themes::store(cx).choose_custom_preset(&id);
                                this.commit_store(next, cx);
                            }))
                            .into_any_element(),
                        None => div().into_any_element(),
                    }
                })),
            )
        });

        let body_label = typeface(&typo.body_font).label;
        let heading_label =
            if typo.heading_font == HEADING_SAME_AS_BODY { "Same as body" } else { typeface(&typo.heading_font).label };
        let body_family = typo.body_families()[0];
        let heading_family = typo.heading_families().map_or(body_family, |f| f[0]);
        let typography = super::settings::group(t).mb(px(16.)).child(
            div()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .mb(px(12.))
                        .child(section_label("Typography", t))
                        .child(div().text_size(px(11.)).text_color(t.muted).child(format!("Applies to both versions of {}", template.name))),
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
                                        .child(self.font_menu(FontSlot::Body, "Body font", body_label, body_family, &typo.body_font, t, cx))
                                        .child(self.font_menu(FontSlot::Heading, "Heading font", heading_label, heading_family, &typo.heading_font, t, cx)),
                                )
                                .child(self.slider(Slider::Size, "Text size", format!("{} px", typo.font_size), typo.font_size, t, cx))
                                .child(self.slider(Slider::LineHeight, "Line height", format!("{:.2}", typo.line_height), typo.line_height, t, cx))
                                .child(self.slider(Slider::Gap, "Paragraph spacing", format!("{:.1} em", typo.paragraph_gap), typo.paragraph_gap, t, cx))
                                .child(self.slider(Slider::Width, "Content width", format!("{} px", typo.content_width), typo.content_width, t, cx)),
                        )
                        .child(super::settings::specimen(body_family, heading_family, typo.font_size as f32, typo.line_height as f32, t)),
                ),
        );

        let colors_hint = if current.built_in == Some(true) {
            format!("Changes save a copy of {} that stands in for {} mode.", current.name, tone_label(tone).to_lowercase())
        } else {
            format!("Editing {}, used in {} mode.", current.name, tone_label(tone).to_lowercase())
        };
        let colors = super::settings::group(t)
            .mb(px(16.))
            .child(
                div()
                    .id("customize-colors")
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .cursor_pointer()
                    .child(
                        div()
                            .child(section_label("Customize colors", t))
                            .child(div().text_size(px(11.)).text_color(t.muted).mt(px(4.)).child(colors_hint)),
                    )
                    .child(chrome::stroke_icon(chrome::PATH_CHEVRON_DOWN, t.muted, 14., 2.))
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_colors(window, cx))),
            )
            .when(colors_open, |el| {
                el.child(div().mt(px(12.)).flex().flex_wrap().gap_y(px(10.)).children(
                    self.appearance.colors.iter().zip(COLOR_FIELDS).map(|(input, (key, label))| {
                        let swatch = themes::hex(&token(&painted.tokens, key));
                        div()
                            .w(relative(0.5))
                            .pr(px(20.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(div().size(px(20.)).flex_none().rounded(px(5.)).border_1().border_color(t.border).bg(swatch))
                            .child(div().flex_1().text_size(px(12.)).child(label))
                            .child(div().w(px(84.)).child(Input::new(input).small().text_size(px(11.))))
                    }),
                ))
            });

        let status = if current.built_in == Some(true) {
            format!("{}{}", current.name, if customized { ", with your typography" } else { "" })
        } else {
            format!("Custom preset: {}", current.name)
        };
        let current_id = current.id.clone();
        let footer = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .border_t_1()
            .border_color(t.border)
            .pt(px(12.))
            .child(div().min_w_0().text_size(px(11.)).text_color(t.muted).child(status))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .when(current.built_in != Some(true), |el| {
                        el.child(
                            small_button("delete-preset", "Delete preset", false, t).on_click(cx.listener(move |this, _, _, cx| {
                                let next = themes::store(cx).delete_custom_preset(&current_id, tone);
                                this.commit_store(next, cx);
                            })),
                        )
                    })
                    .child(
                        small_button("reset-template", "Reset to template", true, t)
                            .when(!customized, |el| el.opacity(0.4))
                            .when(customized, |el| {
                                el.on_click(cx.listener(move |this, _, _, cx| {
                                    let next = themes::store(cx).reset_to_template(tone);
                                    this.commit_store(next, cx);
                                }))
                            }),
                    ),
            );

        div()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .mb(px(12.))
                    .child(div().child(section_label("Templates", t)).child(
                        div()
                            .text_size(px(11.))
                            .text_color(t.muted)
                            .mt(px(4.))
                            .child("Each template has a light and a dark version. The mode picks which one you see."),
                    ))
                    .child(super::settings::color_mode_control(&mode, t, cx)),
            )
            .child(templates)
            .children(presets)
            .child(typography)
            .child(colors)
            .child(footer)
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn font_menu(&self, slot: FontSlot, label: &str, value: &str, family: &'static str, selected: &str, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let open = self.appearance.font_open == Some(slot);
        let hover = t.hover_soft();
        let mut options: Vec<(&'static str, &'static str, &'static str)> = Vec::new();
        if slot == FontSlot::Heading {
            options.push((HEADING_SAME_AS_BODY, "Same as body", family));
        }
        options.extend(TYPEFACES.iter().map(|f| (f.id, f.label, f.families[0])));
        let selected = selected.to_string();
        div()
            .flex_1()
            .min_w_0()
            .child(div().text_size(px(11.)).text_color(t.muted).mb(px(4.)).child(label.to_string()))
            .child(
                div()
                    .id(SharedString::from(format!("font-menu-{slot:?}")))
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
                    .cursor_pointer()
                    .child(div().flex_1().text_size(px(12.5)).font_family(family).child(value.to_string()))
                    .child(chrome::stroke_icon(chrome::PATH_CHEVRON_DOWN, t.muted, 14., 2.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.appearance.font_open = if this.appearance.font_open == Some(slot) { None } else { Some(slot) };
                        cx.notify();
                    })),
            )
            .when(open, |el| {
                el.child(
                    div()
                        .mt(px(4.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(t.border)
                        .bg(t.panel_bg())
                        .p(px(4.))
                        .children(options.into_iter().map(|(id, label, family)| {
                            let on = id == selected;
                            div()
                                .id(SharedString::from(format!("font-{slot:?}-{id}")))
                                .flex()
                                .items_center()
                                .justify_between()
                                .rounded(px(5.))
                                .px(px(8.))
                                .py(px(5.))
                                .cursor_pointer()
                                .hover(move |el| el.bg(hover))
                                .child(div().text_size(px(12.5)).font_family(family).child(label))
                                .when(on, |el| el.child(chrome::stroke_icon(chrome::PATH_CHECK, t.blue, 12., 2.5)))
                                .on_click(cx.listener(move |this, _, _, cx| this.pick_font(slot, id, cx)))
                        })),
                )
            })
    }

    fn slider(&self, slider: Slider, label: &str, display: String, value: f64, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let (min, max, _) = slider.limits();
        let fill = (((value - min) / (max - min)) as f32).clamp(0., 1.);
        let cell = self.appearance.tracks[slider as usize].clone();
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
                div()
                    .id(SharedString::from(format!("slider-{slider:?}")))
                    .h(px(16.))
                    .relative()
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .child(canvas(move |b, _, _| cell.set(b), |_, _, _, _| {}).absolute().size_full())
                    .child(
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
                            .border_color(fade(chrome::black(), 0.18)),
                    )
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                        this.appearance.dragging = Some(slider);
                        this.slide(slider, ev.position.x, cx);
                    }))
                    .on_mouse_move(cx.listener(move |this, ev: &MouseMoveEvent, _, cx| {
                        if ev.pressed_button == Some(MouseButton::Left) && this.appearance.dragging == Some(slider) {
                            this.slide(slider, ev.position.x, cx);
                        }
                    }))
                    .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, _| this.appearance.dragging = None)),
            )
    }
}

fn customized_tag(t: &Tokens) -> Div {
    div()
        .absolute()
        .top(px(12.))
        .left(px(12.))
        .rounded(px(4.))
        .px(px(5.))
        .bg(fade(t.background, 0.85))
        .text_size(px(9.5))
        .font_weight(FontWeight::SEMIBOLD)
        .child("Customized")
}

fn small_button(id: &'static str, label: &str, bordered: bool, t: &Tokens) -> Stateful<Div> {
    let fg = t.foreground;
    div()
        .id(id)
        .rounded(px(6.))
        .when(bordered, |el| el.border_1().border_color(t.border))
        .px(px(10.))
        .py(px(4.))
        .text_size(px(11.))
        .text_color(t.muted)
        .cursor_pointer()
        .hover(move |el| el.text_color(fg))
        .child(label.to_string())
}

trait DarkExt {
    fn theme_dark(&self) -> bool;
}

impl DarkExt for App {
    fn theme_dark(&self) -> bool {
        gpui_kit::component::Theme::global(self).mode.is_dark()
    }
}

#[cfg(test)]
mod tests {
    use super::{Slider, clean_hex};

    #[test]
    fn sliders_snap_to_electrons_steps() {
        assert_eq!(Slider::Size.value_at(0.0), 13.0);
        assert_eq!(Slider::Size.value_at(1.0), 22.0);
        assert_eq!(Slider::Size.value_at(0.34), 16.0);
        assert_eq!(Slider::LineHeight.value_at(0.5), 1.75);
        assert_eq!(Slider::Gap.value_at(0.38), 0.8);
        assert_eq!(Slider::Width.value_at(0.325), 768.0);
        assert_eq!(Slider::Width.value_at(2.0), 1200.0);
    }

    #[test]
    fn colour_fields_accept_hex_only() {
        assert_eq!(clean_hex("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(clean_hex(" 1d4ed8 ").as_deref(), Some("#1d4ed8"));
        assert_eq!(clean_hex("#12345"), None);
        assert_eq!(clean_hex("#zzzzzz"), None);
    }
}
