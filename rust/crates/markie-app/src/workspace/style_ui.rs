//! Settings › Appearance › Markdown style, and the fonts beside it:
//! Electron's `markdown-style-settings.tsx`, `markdown-style-editor.tsx` and
//! `font-library.tsx`.
//!
//! - The section: six presets and the person's saved styles as cards, each a
//!   miniature document drawn by the real renderer in that style, then
//!   Delete, Rename, Duplicate and Customize.
//! - The editor: start from a style, change one element at a time, and watch
//!   a sample document redraw. Save as a new style, save to the open one,
//!   discard, or put one element back to its preset.
//! - The font menus: every face under its group, drawn in itself; the code
//!   font; fonts installed on this computer; and what ships with Markie.
//!
//! Every change goes through the pure transitions in
//! `markie_core::markdown_style`, then the theme store's one commit path, so
//! it is saved, painted and sent to the account the way a template change is.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::fonts;
use markie_core::markdown_style::{self as ms, MarkdownStyle, StyleStore};
use markie_core::theme::{HEADING_SAME_AS_BODY, TypographyPatch};
use markie_editor::RichView;

use super::Workspace;
use super::dialog_chrome::{self as chrome, Tokens, fade, section_label};
use crate::themes;

/// The card's miniature document (`StyleCard` in markdown-style-settings.tsx).
const CARD_SAMPLE: &str = "# Field notes\n\nRead the [tide table](#tide) before you set out.\n\n- Trim the lamp\n- Sign the log\n\n| Day | Wind | Sea |\n| --- | --- | --- |\n| Mon | NW 5 | Calm |\n| Tue | W 7 | Rough |\n";

/// `MARKDOWN_STYLE_SAMPLE` (src/lib/markdown-style-sample.ts): one document
/// that uses every element a style can change.
pub(crate) const STYLE_SAMPLE: &str = include_str!("../../../../scripts/screen/scene/fixtures/lighthouse.md");

/// Which face a menu chooses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum FaceSlot {
    /// Typography's own choices, which win over a style's.
    Body,
    Heading,
    /// This computer's code font.
    Code,
    /// A style's faces, in the editor.
    Style(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Naming {
    SaveAs,
    Rename,
}

pub(crate) struct StyleUi {
    /// The style editor is open (in place of the Settings panel).
    pub(crate) editing: bool,
    /// The element whose controls are open in the editor.
    group: Option<String>,
    /// The face menu that is open.
    pub(crate) face_open: Option<FaceSlot>,
    naming: Option<Naming>,
    name: Entity<InputState>,
    /// The renderer's own views, for the cards and the editor's sample.
    samples: HashMap<String, Entity<RichView>>,
    /// A number being dragged, and where each slider's track is.
    dragging: Option<&'static str>,
    tracks: HashMap<&'static str, Rc<Cell<Bounds<Pixels>>>>,
    /// Fonts on this computer: the listing once asked for, the search field,
    /// and what the last choice said.
    local: Option<Vec<(String, &'static str, Option<String>)>>,
    local_query: Entity<InputState>,
    local_note: Option<String>,
    bundled_open: bool,
}

impl StyleUi {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Workspace>) -> (Self, Vec<Subscription>) {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Style name"));
        let local_query = cx.new(|cx| InputState::new(window, cx).placeholder("Search fonts"));
        let subs = vec![
            cx.subscribe_in(&name, window, |this: &mut Workspace, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.style_name_submit(window, cx);
                }
            }),
            cx.subscribe(&local_query, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
        ];
        let ui = Self {
            editing: false,
            group: None,
            face_open: None,
            naming: None,
            name,
            samples: HashMap::new(),
            dragging: None,
            tracks: HashMap::new(),
            local: None,
            local_query,
            local_note: None,
            bundled_open: false,
        };
        (ui, subs)
    }
}

/// Typefaces as a menu lists them: (id, label, group).
type FaceOption = (String, String, String);

/// Electron's `GROUP_ORDER` in font-library.tsx.
const MENU_GROUPS: [&str; 8] = ["system", "sans", "readable", "rounded", "serif", "display", "mono", "local"];

fn face_options(slot: FaceSlot, current: &str) -> Vec<FaceOption> {
    let named = |f: fonts::Typeface| {
        let label = match fonts::parse_local_typeface_id(&f.id) {
            Some((family, _)) => family,
            None => f.label.clone(),
        };
        (f.id, label, f.group)
    };
    let mut out: Vec<FaceOption> = Vec::new();
    match slot {
        FaceSlot::Body => out.extend(fonts::typefaces().into_iter().map(named)),
        FaceSlot::Heading => {
            out.push((HEADING_SAME_AS_BODY.into(), "Same as body".into(), String::new()));
            out.extend(fonts::typefaces().into_iter().map(named));
        }
        FaceSlot::Code => {
            out.push((String::new(), "Default".into(), String::new()));
            out.extend(fonts::code_typefaces().into_iter().map(named));
        }
        FaceSlot::Style(key) => {
            for id in ms::choice_options(key) {
                let group = fonts::find_typeface(id).map(|f| f.group).unwrap_or_default();
                let group = if matches!(id.as_str(), "theme" | "body") { String::new() } else { group };
                out.push((id.clone(), ms::option_label(key, id), group));
            }
        }
    }
    // A font from this computer that is in use is listed, so it reads as chosen.
    if !matches!(slot, FaceSlot::Style(_))
        && !out.iter().any(|o| o.0 == current)
        && let Some(face) = fonts::find_typeface(current).filter(|f| f.local_only)
    {
        out.push(named(face));
    }
    out
}

/// The family a menu row is drawn in.
fn option_family(id: &str, body: &SharedString) -> SharedString {
    match id {
        "" => markie_editor::MONO.into(),
        "theme" | "body" => body.clone(),
        id => themes::face_family(id),
    }
}

fn now_ms() -> u64 {
    markie_core::clock::now_ms() as u64
}

impl Workspace {
    /// Save, paint and (unless a slider is still moving) send to the account.
    fn commit_styles(&mut self, styles: StyleStore, live: bool, cx: &mut Context<Self>) {
        let next = themes::store(cx).with_style_store(styles);
        themes::apply_store(next, None, cx);
        if live {
            // A slider fires on every tick; the account copy only needs the
            // value settled on, which is sent when the drag ends.
            if !self.doc_theme_pinned() {
                self.save_theme_store(cx);
            }
        } else {
            self.theme_changed(cx);
        }
        cx.notify();
    }

    fn styles(&self, cx: &App) -> StyleStore {
        themes::store(cx).style_store()
    }

    fn new_style_id(&self, cx: &App) -> String {
        let taken: Vec<String> = self.styles(cx).profiles.iter().map(|p| p.id.clone()).collect();
        ms::new_profile_id(&taken, now_ms())
    }

    fn style_start_naming(&mut self, naming: Naming, value: String, window: &mut Window, cx: &mut Context<Self>) {
        self.appearance.style.naming = Some(naming);
        self.appearance.style.name.update(cx, |s, cx| {
            s.set_value(value, window, cx);
            s.focus(window, cx);
        });
        cx.notify();
    }

    fn style_name_submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(naming) = self.appearance.style.naming else { return };
        let name = self.appearance.style.name.read(cx).value().trim().to_string();
        if name.is_empty() {
            return;
        }
        let styles = self.styles(cx);
        let next = match naming {
            Naming::SaveAs => styles.save_as(&name, &self.new_style_id(cx)),
            Naming::Rename => styles.rename(&styles.active_id, &name),
        };
        self.appearance.style.naming = None;
        self.commit_styles(next, false, cx);
    }

    /// Choose a face: Typography's own, this computer's code font, or a
    /// style's (which becomes an unsaved edit).
    pub(crate) fn pick_face(&mut self, slot: FaceSlot, id: &str, cx: &mut Context<Self>) {
        self.appearance.style.face_open = None;
        match slot {
            FaceSlot::Body | FaceSlot::Heading => {
                let mut patch = TypographyPatch::default();
                if slot == FaceSlot::Body {
                    patch.body_font = Some(id.into());
                } else {
                    patch.heading_font = Some(id.into());
                }
                let next = themes::store(cx).set_typography(&patch);
                themes::apply_store(next, None, cx);
                self.theme_changed(cx);
            }
            FaceSlot::Code => {
                let kept = themes::set_own_code_font(id, None, cx);
                if let Some(reg) = &self.registry {
                    // The shape Electron keeps in `markie.fonts.v1`.
                    let _ = reg.set_setting("fonts.v1", &serde_json::json!({ "codeFont": kept }).to_string());
                }
            }
            FaceSlot::Style(key) => {
                let next = self.styles(cx).edit(&[(key, id)], &[]);
                self.commit_styles(next, false, cx);
            }
        }
        cx.notify();
    }

    /// A view of the real renderer for a card or the editor's sample.
    fn style_sample(&mut self, key: &str, markdown: &str, padding: (f32, f32), cx: &mut Context<Self>) -> Entity<RichView> {
        if let Some(view) = self.appearance.style.samples.get(key) {
            return view.clone();
        }
        let view = cx.new(|cx| {
            let mut r = RichView::new(cx);
            r.read_only = true;
            r.sample = Some(padding);
            r.load(markdown, None, cx);
            r
        });
        self.appearance.style.samples.insert(key.to_string(), view.clone());
        view
    }

    /// The look a sample is drawn in: the page's own colours and sizes, in
    /// `style`. A card shows the style's own faces; the editor's sample shows
    /// what the document does, the person's own choices included.
    fn sample_style(&self, style: &MarkdownStyle, own_fonts: bool, cx: &App) -> markie_editor::style::DocStyle {
        let mut doc = super::rich::doc_style(cx);
        doc.md = ms::resolve(style);
        if !own_fonts {
            let template = themes::store(cx).active_template().typography.clone();
            let faces = ms::font_tokens(style);
            doc.body_font = faces.body_font.unwrap_or(template.body_font);
            doc.heading_font = faces.heading_font.unwrap_or(template.heading_font);
            doc.code_font = faces.code_font.map(|f| fonts::clean_code_font(&f)).unwrap_or_default();
        }
        doc
    }

    /// Scene mode: the editor, one of its elements and a font menu, opened
    /// the way their buttons open them.
    #[cfg(feature = "scene")]
    pub(super) fn scene_style(&mut self, editor: bool, group: &str, face: &str) {
        let s = &mut self.appearance.style;
        s.editing = editor;
        s.group = (!group.is_empty()).then(|| group.to_string());
        s.face_open = match face {
            "body" => Some(FaceSlot::Body),
            "heading" => Some(FaceSlot::Heading),
            "code" => Some(FaceSlot::Code),
            "style-body" => Some(FaceSlot::Style("bodyFont")),
            _ => None,
        };
    }

    // ── The section in Settings ─────────────────────────────────────────────

    pub(super) fn render_style_section(&mut self, t: &Tokens, card_w: f32, cx: &mut Context<Self>) -> AnyElement {
        let styles = self.styles(cx);
        let edited = styles.edited();
        let profile = styles.profiles.iter().find(|p| p.id == styles.active_id).cloned();
        // (id, name, description, the style drawn).
        let mut cards: Vec<(String, String, String, MarkdownStyle)> = ms::presets().iter().map(|p| (p.id.clone(), p.name.clone(), p.description.clone(), MarkdownStyle::preset(&p.id))).collect();
        for p in &styles.profiles {
            let base = ms::find_preset(&p.style.base).map(|b| b.name.as_str()).unwrap_or("Spacious");
            cards.push((p.id.clone(), p.name.clone(), format!("Your style, built on {base}"), p.style.clone()));
        }
        let mut grid = div().flex().flex_wrap().gap(px(8.)).mb(px(12.));
        for (id, name, description, style) in cards {
            let selected = styles.active_id == id;
            // The card of the style in use shows it as it is being drawn, edits included.
            let drawn = if selected && edited { styles.draft.clone().unwrap_or(style) } else { style };
            let view = self.style_sample(&format!("card:{id}"), CARD_SAMPLE, (18. * 0.4, 22. * 0.4), cx);
            let mut doc = self.sample_style(&drawn, false, cx);
            doc.font_size = 15.;
            view.update(cx, |r, cx| {
                r.set_appearance(0.4, 0., cx);
                r.set_style(doc, cx);
            });
            let pick = id.clone();
            let hover = fade(t.foreground, 0.04);
            let ring = if selected { themes::mix(t.blue, t.border, 0.78) } else { t.border };
            grid = grid.child(
                div()
                    .id(SharedString::from(format!("style-card-{id}")))
                    .w(px(card_w))
                    .flex()
                    .flex_col()
                    .gap(px(7.))
                    .rounded(px(10.))
                    .pt(px(6.))
                    .px(px(6.))
                    .pb(px(8.))
                    .cursor_pointer()
                    .hover(move |el| el.bg(hover))
                    .child(
                        div()
                            .relative()
                            .h(px(118.))
                            .overflow_hidden()
                            .rounded(px(7.))
                            .border_1()
                            .border_color(ring)
                            .when(selected, |el| el.shadow(vec![BoxShadow { color: ring, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(1.), inset: false }]))
                            .bg(t.background)
                            .child(div().absolute().top_0().left_0().w_full().h(px(400.)).child(view))
                            // The page fades out at the foot, and takes no clicks.
                            .child(div().absolute().left_0().right_0().bottom_0().h(px(22.)).bg(linear_gradient(180., linear_color_stop(fade(t.background, 0.), 0.), linear_color_stop(t.background, 1.))))
                            .child(div().absolute().top_0().left_0().size_full().occlude()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(6.))
                            .px(px(2.))
                            .child(div().min_w_0().truncate().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).child(name))
                            .when(selected, |el| {
                                el.child(div().size(px(16.)).flex_none().rounded_full().bg(t.blue).flex().items_center().justify_center().child(chrome::stroke_icon("M5 12.5 10 17 19 7", t.background, 10., 3.2)))
                            }),
                    )
                    .child(
                        div()
                            .px(px(2.))
                            .text_size(px(11.))
                            .line_height(px(15.))
                            .text_color(t.muted)
                            .when(selected && edited, |el| {
                                el.child(div().mb(px(2.)).child(div().rounded(px(4.)).px(px(5.)).bg(fade(t.foreground, 0.09)).text_size(px(9.5)).font_weight(FontWeight::SEMIBOLD).text_color(t.foreground).child("Edited")).flex())
                            })
                            .child(description),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let next = this.styles(cx).choose(&pick);
                        this.commit_styles(next, false, cx);
                    })),
            );
        }

        let naming = self.appearance.style.naming;
        let actions: AnyElement = if naming == Some(Naming::Rename) && profile.is_some() {
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().w(px(200.)).child(Input::new(&self.appearance.style.name).small().text_size(px(12.))))
                .child(style_button("style-rename-ok", "Rename", true, false, t).on_click(cx.listener(|this, _, window, cx| this.style_name_submit(window, cx))))
                .child(style_button("style-rename-cancel", "Cancel", false, false, t).on_click(cx.listener(|this, _, _, cx| {
                    this.appearance.style.naming = None;
                    cx.notify();
                })))
                .into_any_element()
        } else {
            let active = styles.active_id.clone();
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .when_some(profile.clone(), |el, p| {
                    let (id, name) = (p.id.clone(), p.name.clone());
                    el.child(style_button("style-delete", "Delete", false, false, t).on_click(cx.listener(move |this, _, _, cx| {
                        let next = this.styles(cx).delete(&id);
                        this.commit_styles(next, false, cx);
                    })))
                    .child(style_button("style-rename", "Rename", false, false, t).on_click(cx.listener(move |this, _, window, cx| this.style_start_naming(Naming::Rename, name.clone(), window, cx))))
                })
                .child(style_button("style-duplicate", "Duplicate", false, false, t).on_click(cx.listener(move |this, _, _, cx| {
                    let next = this.styles(cx).duplicate(&active, &this.new_style_id(cx));
                    this.commit_styles(next, false, cx);
                })))
                .child(style_button("style-customize", "Customize…", true, false, t).on_click(cx.listener(|this, _, _, cx| {
                    this.appearance.style.editing = true;
                    this.appearance.style.naming = None;
                    cx.notify();
                })))
                .into_any_element()
        };

        div()
            .mb(px(20.))
            .child(
                div().mb(px(12.)).child(section_label("Markdown style", t)).child(
                    div().text_size(px(11.)).line_height(px(16.5)).text_color(t.muted).mt(px(4.)).child(
                        "How headings, lists, tables and the rest are drawn, and in which typefaces. A style works with any template's colours. Every style but Spacious brings its own fonts; one you choose yourself under Typography is used instead.",
                    ),
                ),
            )
            .child(grid)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap_x(px(12.))
                    .gap_y(px(8.))
                    .child(div().min_w_0().truncate().text_size(px(11.)).text_color(t.muted).child(format!("In use: {}", styles.active_name())))
                    .child(actions),
            )
            .into_any_element()
    }

    // ── The editor ──────────────────────────────────────────────────────────

    pub(super) fn close_style_editor(&mut self, cx: &mut Context<Self>) {
        self.appearance.style.editing = false;
        self.appearance.style.naming = None;
        self.appearance.style.face_open = None;
        cx.notify();
    }

    pub(super) fn render_style_editor(&mut self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let styles = self.styles(cx);
        let style = styles.active();
        let resolved = ms::resolve(&style);
        let edited = styles.edited();
        let profile = styles.profiles.iter().find(|p| p.id == styles.active_id).cloned();
        let preset_name = ms::find_preset(&resolved.base).map(|p| p.name.clone()).unwrap_or_else(|| "Spacious".into());
        let viewport = window.viewport_size();
        let (width, height) = (f32::from(viewport.width * 0.96).min(1120.), f32::from(viewport.height * 0.9).min(780.));
        let naming = self.appearance.style.naming;

        // The head: what is open, and what can be done with it.
        let mut head = div()
            .flex()
            .flex_none()
            .flex_wrap()
            .items_center()
            .gap_x(px(10.))
            .gap_y(px(8.))
            .border_b_1()
            .border_color(t.border)
            .px(px(16.))
            .py(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Markdown style"))
                    .child(div().mt(px(2.)).truncate().text_size(px(11.)).text_color(t.muted).child(format!("{}{}", styles.active_name(), if edited { ". Not saved yet." } else { "" }))),
            );
        if naming == Some(Naming::SaveAs) {
            head = head
                .child(div().w(px(200.)).child(Input::new(&self.appearance.style.name).small().text_size(px(12.))))
                .child(style_button("style-save-ok", "Save", true, false, t).on_click(cx.listener(|this, _, window, cx| this.style_name_submit(window, cx))))
                .child(style_button("style-save-cancel", "Cancel", false, false, t).on_click(cx.listener(|this, _, _, cx| {
                    this.appearance.style.naming = None;
                    cx.notify();
                })));
        } else {
            if edited {
                head = head.child(style_button("style-discard", "Discard changes", false, false, t).on_click(cx.listener(|this, _, _, cx| {
                    let next = this.styles(cx).discard_draft();
                    this.commit_styles(next, false, cx);
                })));
            }
            if let (true, Some(p)) = (edited, &profile) {
                head = head.child(style_button("style-save-edits", &format!("Save to {}", p.name), true, false, t).on_click(cx.listener(|this, _, _, cx| {
                    let next = this.styles(cx).save_edits();
                    this.commit_styles(next, false, cx);
                })));
            }
            let suggestion = match &profile {
                Some(p) => format!("{} copy", p.name),
                None if edited => format!("My {preset_name}"),
                None => format!("{preset_name} copy"),
            };
            head = head.child(
                style_button("style-save-as", "Save as new style…", edited && profile.is_none(), false, t)
                    .on_click(cx.listener(move |this, _, window, cx| this.style_start_naming(Naming::SaveAs, suggestion.clone(), window, cx))),
            );
        }
        head = head.child(self.close_button("style-editor-close", t, cx).on_click(cx.listener(|this, _, _, cx| this.close_style_editor(cx))));

        // "Start from": every preset and saved style.
        let mut start = div().flex().flex_wrap().gap(px(5.)).mt(px(6.)).mb(px(14.));
        let starts: Vec<(String, String)> = ms::presets().iter().map(|p| (p.id.clone(), p.name.clone())).chain(styles.profiles.iter().map(|p| (p.id.clone(), p.name.clone()))).collect();
        for (id, name) in starts {
            let on = styles.active_id == id;
            let pick = id.clone();
            start = start.child(chip(SharedString::from(format!("style-start-{id}")), &name, on, t).on_click(cx.listener(move |this, _, _, cx| {
                let next = this.styles(cx).choose(&pick);
                this.commit_styles(next, false, cx);
            })));
        }

        let mut controls = div()
            .id("style-controls")
            .w(px(372.))
            .flex_none()
            .h_full()
            .overflow_y_scroll()
            .border_r_1()
            .border_color(t.border)
            .pt(px(12.))
            .px(px(12.))
            .pb(px(20.))
            .child(section_label("Start from", t))
            .child(start);
        let open_group = self.appearance.style.group.clone();
        let own_fonts = own_font_words(cx);
        let body_family = themes::face_family(&themes::painted(cx, t.dark).1.body_font);
        for group in ms::groups() {
            let changed = styles.group_changed(group);
            let expanded = open_group.as_deref() == Some(group.id.as_str());
            let gid = group.id.clone();
            let summary = if expanded { group.hint.clone() } else { group_summary(group, &resolved) };
            let hover = t.hover_soft();
            let mut section = div().border_t_1().border_color(fade(t.border, 0.7)).child(
                div()
                    .id(SharedString::from(format!("style-group-{}", group.id)))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(6.))
                    .px(px(6.))
                    .py(px(7.))
                    .cursor_pointer()
                    .hover(move |el| el.bg(hover))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(div().text_size(px(12.5)).child(group.label.clone()))
                            .child(div().truncate().text_size(px(11.)).text_color(t.muted).child(summary)),
                    )
                    .when(changed, |el| el.child(div().size(px(6.)).flex_none().rounded_full().bg(t.blue)))
                    .child(chrome::stroke_icon(chrome::PATH_CHEVRON_DOWN, t.muted, 14., 2.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let s = &mut this.appearance.style;
                        s.group = if s.group.as_deref() == Some(gid.as_str()) { None } else { Some(gid.clone()) };
                        s.face_open = None;
                        cx.notify();
                    })),
            );
            if expanded {
                let mut body = div().flex().flex_col().gap(px(10.)).px(px(6.)).pt(px(4.)).pb(px(12.));
                for key in &group.choices {
                    let key: &'static str = ms::choices().iter().find(|c| &c.key == key).map(|c| c.key.as_str()).unwrap_or("");
                    let value = resolved.choice(key).to_string();
                    if ms::FONT_KEYS.contains(&key) {
                        body = body.child(self.face_menu(FaceSlot::Style(key), ms::choice_label(key), &value, &body_family, t, cx));
                        continue;
                    }
                    let mut options = div().flex().flex_wrap().gap(px(5.));
                    for option in ms::choice_options(key) {
                        let on = *option == value;
                        let pick: &'static str = option.as_str();
                        options = options.child(chip(SharedString::from(format!("style-option-{key}-{option}")), &ms::option_label(key, option), on, t).on_click(cx.listener(
                            move |this, _, _, cx| {
                                let next = this.styles(cx).edit(&[(key, pick)], &[]);
                                this.commit_styles(next, false, cx);
                            },
                        )));
                    }
                    body = body.child(div().child(div().text_size(px(11.)).text_color(t.muted).mb(px(6.)).child(ms::choice_label(key))).child(options));
                }
                for key in &group.numbers {
                    if let Some(def) = ms::number_def(key) {
                        body = body.child(self.style_slider(def, resolved.number(key), t, cx));
                    }
                }
                if group.id == "typefaces" && !own_fonts.is_empty() {
                    body = body.child(
                        div().text_size(px(11.)).line_height(px(16.)).text_color(t.muted).child(format!("You chose {own_fonts} yourself in Typography, and that choice is used instead. Reset it there to see this style's.")),
                    );
                }
                if group.id == "images" {
                    body = body.child(div().text_size(px(11.)).text_color(t.muted).child("A caption is italic text on the line straight after a picture."));
                }
                let reset = group.id.clone();
                body = body.child(div().flex().child(style_button(SharedString::from(format!("style-reset-{}", group.id)), &format!("Reset to {preset_name}"), false, !changed, t).when(changed, |el| {
                    el.on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(group) = ms::groups().iter().find(|g| g.id == reset) {
                            let next = this.styles(cx).reset_group(group);
                            this.commit_styles(next, false, cx);
                        }
                    }))
                })));
                section = section.child(body);
            }
            controls = controls.child(section);
        }

        // The sample: the real renderer, in the style being drawn.
        let sample = self.style_sample("sample", STYLE_SAMPLE, (32., 36.), cx);
        let doc = self.sample_style(&style, true, cx);
        sample.update(cx, |r, cx| {
            r.set_appearance(1., 720., cx);
            r.set_style(doc, cx);
        });

        self.panel(t, 12.)
            .id("style-editor")
            .w(px(width))
            .h(px(height))
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(head)
            .child(div().flex().flex_1().min_h_0().child(controls).child(div().flex_1().min_w_0().h_full().bg(t.background).child(sample)))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| this.style_drag_end(cx)))
            .into_any_element()
    }

    fn style_drag_end(&mut self, cx: &mut Context<Self>) {
        if self.appearance.style.dragging.take().is_some() {
            // The value settled on goes to the account now.
            self.theme_changed(cx);
        }
    }

    fn style_slide(&mut self, key: &'static str, x: Pixels, cx: &mut Context<Self>) {
        let (Some(def), Some(track)) = (ms::number_def(key), self.appearance.style.tracks.get(key).map(|c| c.get())) else { return };
        if track.size.width <= px(0.) {
            return;
        }
        let frac = f64::from(((x - track.origin.x) / track.size.width).clamp(0., 1.));
        let steps = ((def.max - def.min) * frac / def.step).round();
        let value = ((def.min + steps * def.step) * 1000.).round() / 1000.;
        let styles = self.styles(cx);
        if ms::resolve(&styles.active()).number(key) != value {
            self.commit_styles(styles.edit(&[], &[(key, value)]), true, cx);
        }
    }

    fn style_slider(&mut self, def: &'static ms::NumberDef, value: f64, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let key: &'static str = def.key.as_str();
        let fill = (((value - def.min) / (def.max - def.min)) as f32).clamp(0., 1.);
        let cell = self.appearance.style.tracks.entry(key).or_insert_with(|| Rc::new(Cell::new(Bounds::default()))).clone();
        div()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .mb(px(4.))
                    .child(div().text_size(px(12.)).child(ms::number_label(key)))
                    .child(div().text_size(px(11.)).text_color(t.muted).child(ms::format_number(key, value))),
            )
            .child(
                div()
                    .id(SharedString::from(format!("style-number-{key}")))
                    .h(px(16.))
                    .relative()
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .child(canvas(move |b, _, _| cell.set(b), |_, _, _, _| {}).absolute().size_full())
                    .child(div().w_full().h(px(4.)).rounded_full().bg(fade(t.foreground, 0.14)).child(div().h_full().w(relative(fill)).rounded_full().bg(t.blue)))
                    .child(div().absolute().top(px(1.)).left(relative(fill)).ml(px(-7.)).size(px(14.)).rounded_full().bg(rgb(0xffffff)).border_1().border_color(fade(chrome::black(), 0.18)))
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                        this.appearance.style.dragging = Some(key);
                        this.style_slide(key, ev.position.x, cx);
                    }))
                    .on_mouse_move(cx.listener(move |this, ev: &MouseMoveEvent, _, cx| {
                        if ev.pressed_button == Some(MouseButton::Left) && this.appearance.style.dragging == Some(key) {
                            this.style_slide(key, ev.position.x, cx);
                        }
                    })),
            )
    }

    // ── Font menus ──────────────────────────────────────────────────────────

    /// `FontPicker`: a select-like menu of typefaces under group headings,
    /// each drawn in itself.
    pub(super) fn face_menu(&self, slot: FaceSlot, label: &str, selected: &str, body_family: &SharedString, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let open = self.appearance.style.face_open == Some(slot);
        let hover = t.hover_soft();
        let options = face_options(slot, selected);
        let current = options.iter().find(|o| o.0 == selected).or(options.first()).cloned().unwrap_or_default();
        let mut menu = div().id(SharedString::from(format!("face-menu-list-{slot:?}"))).mt(px(6.)).max_h(px(300.)).overflow_y_scroll().rounded(px(10.)).border_1().border_color(t.border).bg(t.panel_bg()).p(px(4.));
        let groups: Vec<&str> = std::iter::once("").chain(MENU_GROUPS).collect();
        for group in groups {
            let rows: Vec<&FaceOption> = options.iter().filter(|o| o.2 == group).collect();
            if rows.is_empty() {
                continue;
            }
            if !group.is_empty() {
                menu = menu.child(div().px(px(8.)).pt(px(8.)).pb(px(4.)).text_size(px(10.5)).text_color(t.muted).child(chrome::spaced_caps(fonts::group_label(group))));
            }
            for (id, name, _) in rows {
                let on = id == selected;
                let pick = id.clone();
                menu = menu.child(
                    div()
                        .id(SharedString::from(format!("face-{slot:?}-{id}")))
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .rounded(px(6.))
                        .px(px(8.))
                        .py(px(6.))
                        .cursor_pointer()
                        .hover(move |el| el.bg(hover))
                        .child(div().min_w_0().truncate().text_size(px(13.)).font_family(option_family(id, body_family)).child(name.clone()))
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(px(8.))
                                .text_size(px(11.))
                                .text_color(t.muted)
                                .when(group == "local", |el| el.child("Only on this computer"))
                                .child(div().size(px(14.)).when(on, |el| el.child(chrome::stroke_icon(chrome::PATH_CHECK, t.foreground, 12., 2.5)))),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| this.pick_face(slot, &pick, cx))),
                );
            }
        }
        div()
            .flex_1()
            .min_w_0()
            .child(div().text_size(px(11.)).text_color(t.muted).mb(px(4.)).child(label.to_string()))
            .child(
                div()
                    .id(SharedString::from(format!("face-menu-{slot:?}")))
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
                    .child(div().flex_1().min_w_0().truncate().text_size(px(12.5)).font_family(option_family(&current.0, body_family)).child(current.1.clone()))
                    .child(chrome::stroke_icon(chrome::PATH_CHEVRON_DOWN, t.muted, 14., 2.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let s = &mut this.appearance.style;
                        s.face_open = if s.face_open == Some(slot) { None } else { Some(slot) };
                        cx.notify();
                    })),
            )
            .when(open, |el| el.child(menu))
    }

    /// `FontLibraryControls`: the code font, the fonts on this computer, and
    /// what ships with Markie.
    pub(super) fn render_font_library(&mut self, body_family: &SharedString, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let code = themes::own_code_font(cx);
        let code_menu = self.face_menu(FaceSlot::Code, "Code font", &code, body_family, t, cx);
        let local: Div = match &self.appearance.style.local {
            None => div()
                .flex_1()
                .min_w_0()
                .child(div().text_size(px(11.)).text_color(t.muted).mb(px(4.)).child("Fonts on this computer"))
                .child(
                    div()
                        .id("local-fonts-show")
                        .h(px(32.))
                        .flex()
                        .items_center()
                        .rounded(px(7.))
                        .border_1()
                        .border_color(t.field_border())
                        .bg(t.select_bg())
                        .px(px(10.4))
                        .cursor_pointer()
                        .text_size(px(12.5))
                        .child("Show fonts on this computer")
                        .on_click(cx.listener(|this, _, _, cx| {
                            // Only family names are read. No font file is opened, copied or uploaded.
                            let names = cx.text_system().all_font_names();
                            fonts::set_installed_families(names.clone());
                            this.appearance.style.local = Some(fonts::local_families_from(names));
                            cx.notify();
                        })),
                )
                .child(div().mt(px(4.)).text_size(px(11.)).line_height(px(16.)).text_color(t.muted).child("A font from this computer shows only here. Shared links and other people see a bundled font instead.")),
            Some(all) => {
                let needle = self.appearance.style.local_query.read(cx).value().trim().to_lowercase();
                let hover = t.hover_soft();
                let fg = t.foreground;
                let shown: Vec<_> = all.iter().filter(|f| f.2.is_some() && (needle.is_empty() || f.0.to_lowercase().contains(&needle))).take(400).cloned().collect();
                let mut list = div().id("local-fonts-list").max_h(px(190.)).overflow_y_scroll().rounded(px(10.)).border_1().border_color(t.border).bg(t.panel_bg()).p(px(4.));
                if shown.is_empty() {
                    list = list.child(div().px(px(8.)).py(px(4.)).text_size(px(12.)).text_color(t.muted).child("No font matches."));
                }
                for (family, kind, id) in shown {
                    let Some(id) = id else { continue };
                    let slots: &[(FaceSlot, &str)] = if kind == "mono" { &[(FaceSlot::Code, "Code"), (FaceSlot::Body, "Body"), (FaceSlot::Heading, "Headings")] } else { &[(FaceSlot::Body, "Body"), (FaceSlot::Heading, "Headings")] };
                    let mut buttons = div().flex().flex_none().gap(px(4.));
                    for (slot, label) in slots {
                        let (slot, id, family) = (*slot, id.clone(), family.clone());
                        buttons = buttons.child(
                            div()
                                .id(SharedString::from(format!("local-{family}-{label}")))
                                .rounded(px(4.))
                                .px(px(6.))
                                .py(px(2.))
                                .text_size(px(11.))
                                .text_color(t.muted)
                                .cursor_pointer()
                                .hover(move |el| el.bg(hover).text_color(fg))
                                .child(*label)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let fallback = fonts::parse_local_typeface_id(&id).map(|(_, f)| f.family.clone()).unwrap_or_default();
                                    this.appearance.style.local_note = Some(format!("{family} is only on this computer. A shared link or another person sees {fallback} instead."));
                                    this.pick_face(slot, &id, cx);
                                })),
                        );
                    }
                    list = list.child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .rounded(px(6.))
                            .px(px(8.))
                            .py(px(4.))
                            .child(div().min_w_0().truncate().text_size(px(13.)).font_family(SharedString::from(family.clone())).child(family.clone()))
                            .child(buttons),
                    );
                }
                let note = self.appearance.style.local_note.clone().unwrap_or_else(|| "Only on this computer. Shared links and other people see a bundled font instead.".into());
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(11.)).text_color(t.muted).mb(px(4.)).child("Fonts on this computer"))
                    .child(div().mb(px(4.)).child(Input::new(&self.appearance.style.local_query).small().text_size(px(12.))))
                    .child(list)
                    .child(div().mt(px(4.)).text_size(px(11.)).line_height(px(16.)).text_color(t.muted).child(note))
            }
        };
        let open = self.appearance.style.bundled_open;
        let notice = div()
            .text_size(px(11.))
            .text_color(t.muted)
            .child(
                div()
                    .id("bundled-fonts-toggle")
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .cursor_pointer()
                    .child(if open { "▾" } else { "▸" })
                    .child("Fonts included with Markie")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.appearance.style.bundled_open = !this.appearance.style.bundled_open;
                        cx.notify();
                    })),
            )
            .when(open, |el| {
                el.child(div().mt(px(4.)).flex().flex_col().gap(px(2.)).children(fonts::bundled_families().iter().map(|f| {
                    let license = if f.license == "Apache-2.0" { "Apache License 2.0" } else { "SIL Open Font License 1.1" };
                    div().child(format!("{}, {license}, version {}", f.family, f.version))
                })))
            });
        div().flex().flex_col().gap(px(8.)).child(div().flex().gap(px(8.)).child(code_menu).child(local)).child(notice)
    }
}

/// `ownFontChoices`: which faces the person set themselves, in words.
fn own_font_words(cx: &App) -> String {
    let typography = themes::store(cx).typography.unwrap_or_default();
    let mut own = Vec::new();
    if typography.body_font.is_some() {
        own.push("the text font");
    }
    if typography.heading_font.is_some() {
        own.push("the heading font");
    }
    if !themes::own_code_font(cx).is_empty() {
        own.push("the code font");
    }
    match own.len() {
        0 => String::new(),
        1 => own[0].to_string(),
        n => format!("{} and {}", own[..n - 1].join(", "), own[n - 1]),
    }
}

/// `summary`: what a closed row says about itself.
fn group_summary(group: &ms::Group, resolved: &ms::Resolved) -> String {
    let mut parts: Vec<String> = group.choices.iter().take(3).map(|key| ms::option_label(key, resolved.choice(key))).collect();
    if parts.len() < 3 {
        let room = 3 - parts.len();
        parts.extend(group.numbers.iter().take(room).map(|key| ms::format_number(key, resolved.number(key))));
    }
    parts.join(", ")
}

/// `.markie-style-chip`: a pill, filled when it is the choice.
fn chip(id: SharedString, label: &str, on: bool, t: &Tokens) -> Stateful<Div> {
    let fg = t.foreground;
    div()
        .id(id)
        .rounded_full()
        .border_1()
        .border_color(if on { themes::mix(t.foreground, t.border, 0.55) } else { t.border })
        .when(on, |el| el.bg(fade(t.foreground, 0.09)))
        .px(px(10.))
        .py(px(3.))
        .text_size(px(11.5))
        .line_height(px(17.25))
        .text_color(if on { t.foreground } else { t.muted })
        .whitespace_nowrap()
        .cursor_pointer()
        .hover(move |el| el.text_color(fg))
        .child(label.to_string())
}

/// `.markie-style-button`: a small bordered button; the primary one is filled.
fn style_button(id: impl Into<ElementId>, label: &str, primary: bool, disabled: bool, t: &Tokens) -> Stateful<Div> {
    let hover = t.hover_soft();
    div()
        .id(id)
        .rounded(px(6.))
        .border_1()
        .border_color(if primary { t.foreground } else { t.border })
        .when(primary, |el| el.bg(t.foreground).text_color(t.background))
        .when(!primary, |el| el.text_color(t.foreground).hover(move |el| el.bg(hover)))
        .px(px(10.))
        .py(px(4.))
        .text_size(px(11.5))
        .whitespace_nowrap()
        .when(disabled, |el| el.opacity(0.4))
        .when(!disabled, |el| el.cursor_pointer())
        .child(label.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::core::prelude::v1::test;

    #[test]
    fn menus_list_every_face_under_its_group() {
        let body = face_options(FaceSlot::Body, "system");
        assert_eq!(body.len(), 29);
        assert_eq!(body[0], ("system".into(), "System".into(), "system".into()));
        assert!(body.iter().any(|o| o.0 == "lexend" && o.2 == "readable"));
        let heading = face_options(FaceSlot::Heading, "body");
        assert_eq!(heading[0].1, "Same as body");
        assert_eq!(heading.len(), 30);
        let code = face_options(FaceSlot::Code, "");
        assert_eq!(code.iter().map(|o| o.1.as_str()).collect::<Vec<_>>(), ["Default", "Monospace", "JetBrains Mono", "Fira Code", "Source Code Pro", "Atkinson Hyperlegible Mono"]);
        // A font from this computer that is in use is listed, plainly named.
        let local = face_options(FaceSlot::Body, "local:inter:Futura");
        assert_eq!(local.last().unwrap(), &("local:inter:Futura".to_string(), "Futura".to_string(), "local".to_string()));
        // A style's menus offer the schema's own lists.
        let style = face_options(FaceSlot::Style("headingFont"), "theme");
        assert_eq!((style[0].1.as_str(), style[1].1.as_str()), ("Template's font", "Same as text"));
        assert_eq!(face_options(FaceSlot::Style("codeFont"), "theme").len(), 6);
    }

    #[test]
    fn a_closed_row_says_its_choices_in_words() {
        let compact = ms::resolve(&MarkdownStyle::preset("compact"));
        let by = |id: &str| ms::groups().iter().find(|g| g.id == id).unwrap();
        assert_eq!(group_summary(by("tables"), &compact), "Zebra, Bold, Compact");
        assert_eq!(group_summary(by("spacing"), &compact), "Spaced, 0.65×, 0.86×");
        assert_eq!(group_summary(by("list-layout"), &compact), "Muted, 1.4 em, 0.05 em");
        assert_eq!(group_summary(by("typefaces"), &compact), "Source Sans 3, Same as text, Source Code Pro");
    }

    #[test]
    fn the_editors_sample_is_electrons() {
        assert!(STYLE_SAMPLE.starts_with("# The Lighthouse Keeper's Handbook"));
        assert!(STYLE_SAMPLE.contains("- [x] Lamp out and wick trimmed"));
    }
}
