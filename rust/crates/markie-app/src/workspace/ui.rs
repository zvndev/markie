//! The pieces every Markie RS page shares: one filled primary button per
//! state, outlined secondary buttons, quiet tertiary ones, small status
//! chips and tinted banners, all on the current template's tokens. First
//! drawn for the vault (`vault/ui.rs`), now also the Recent and Cloud pages.

use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Icon, Sizable as _, h_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::themes::Palette;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Primary,
    Secondary,
    Quiet,
    Danger,
}

pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>, icon: Option<IconName>, tone: Tone, disabled: bool, p: &Palette) -> Stateful<Div> {
    let hover = p.fg(0.06);
    let base = h_flex()
        .id(id)
        .flex_none()
        .gap(px(6.))
        .items_center()
        .justify_center()
        .h(px(32.))
        .px(px(if tone == Tone::Quiet { 8. } else { 12. }))
        .rounded(px(7.))
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .whitespace_nowrap()
        .border_1()
        .border_color(transparent_black());
    let base = match tone {
        Tone::Primary => base.bg(p.foreground).text_color(p.background).when(!disabled, |el| el.hover(|s| s.opacity(0.86))),
        Tone::Secondary => base.bg(p.background).border_color(p.border).text_color(p.foreground).when(!disabled, |el| el.hover(move |s| s.bg(hover))),
        Tone::Quiet => base.text_color(p.muted).when(!disabled, |el| {
            let fg = p.foreground;
            el.hover(move |s| s.bg(hover).text_color(fg))
        }),
        Tone::Danger => {
            let red = p.red;
            base.text_color(red).when(!disabled, |el| el.hover(move |s| s.bg(red.opacity(0.08))))
        }
    };
    base.when(disabled, |el| el.opacity(0.45))
        .when(!disabled, |el| el.cursor_pointer())
        .when_some(icon, |el, icon| el.child(Icon::new(icon).small()))
        .child(label.into())
}

/// A square icon button for a table row.
pub fn icon_button(id: impl Into<ElementId>, icon: IconName, active: bool, disabled: bool, p: &Palette) -> Stateful<Div> {
    let hover = p.fg(0.07);
    let fg = p.foreground;
    div()
        .id(id)
        .flex_none()
        .size(px(30.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .text_color(if active { p.foreground } else { p.muted })
        .when(active, |el| el.bg(p.fg(0.08)))
        .when(disabled, |el| el.opacity(0.45))
        .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.bg(hover).text_color(fg)))
        .child(Icon::new(icon).small())
}

pub fn field(input: &Entity<InputState>, disabled: bool, p: &Palette) -> Input {
    Styled::h(Input::new(input).disabled(disabled), px(36.)).px(px(10.)).text_size(px(14.)).rounded(px(7.)).bg(p.background).border_1().border_color(p.border)
}

pub fn label(text: impl Into<SharedString>, p: &Palette) -> Div {
    div().text_size(px(13.)).line_height(px(18.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(text.into())
}

pub fn hint(text: impl Into<SharedString>, p: &Palette) -> Div {
    div().text_size(px(12.)).line_height(px(17.)).text_color(p.muted).child(text.into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Error,
    Info,
    Success,
}

/// A one-line message in a tinted box, with an icon.
pub fn banner(kind: Kind, text: impl Into<SharedString>, p: &Palette) -> Div {
    let (color, icon) = match kind {
        Kind::Error => (p.red, IconName::CircleAlert),
        Kind::Info => (p.muted, IconName::Info),
        Kind::Success => (p.green, IconName::CircleCheck),
    };
    h_flex()
        .w_full()
        .items_start()
        .gap(px(8.))
        .rounded(px(8.))
        .px(px(12.))
        .py(px(9.))
        .bg(if kind == Kind::Info { p.fg(0.04) } else { color.opacity(0.08) })
        .border_1()
        .border_color(if kind == Kind::Info { p.border } else { color.opacity(0.3) })
        .text_size(px(13.))
        .line_height(px(19.))
        .text_color(p.foreground)
        .child(div().mt(px(1.5)).flex_none().text_color(color).child(Icon::new(icon).small()))
        .child(div().flex_1().min_w_0().child(text.into()))
}

/// A small dot and a word: Unlocked, Saved, On.
pub fn chip(text: impl Into<SharedString>, color: Hsla, p: &Palette) -> Div {
    h_flex()
        .flex_none()
        .gap(px(5.))
        .items_center()
        .h(px(20.))
        .px(px(7.))
        .rounded_full()
        .bg(p.fg(0.05))
        .text_size(px(11.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(p.muted)
        .child(div().size(px(6.)).rounded_full().bg(color))
        .child(text.into())
}

// ── Page furniture: header, toolbar controls, empty states ──

/// A page's header row: icon, title, then whatever the page adds (a chip, a
/// count, a spacer and its buttons). 56 points tall, as the vault's.
pub fn page_header(glyph: &'static str, title: &'static str, p: &Palette) -> Div {
    h_flex()
        .flex_none()
        .h(px(56.))
        .items_center()
        .gap(px(10.))
        .border_b_1()
        .border_color(p.border)
        .px(px(24.))
        .child(svg().path(glyph).size(px(18.)).flex_none().text_color(p.foreground))
        .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(p.foreground).child(title))
}

/// A toolbar's menu button: the current choice and a chevron.
pub fn select(id: impl Into<ElementId>, label: impl Into<SharedString>, open: bool, p: &Palette) -> Stateful<Div> {
    let (fg, hover) = (p.foreground, p.fg(0.05));
    h_flex()
        .id(id)
        .flex_none()
        .h(px(32.))
        .gap(px(6.))
        .pl(px(11.))
        .pr(px(8.))
        .items_center()
        .rounded(px(7.))
        .border_1()
        .border_color(if open { p.fg(0.3) } else { p.border })
        .bg(p.background)
        .text_size(px(12.5))
        .text_color(if open { p.foreground } else { p.fg(0.78) })
        .whitespace_nowrap()
        .cursor_pointer()
        .hover(move |s| s.bg(hover).text_color(fg))
        .child(label.into())
        .child(svg().path("markie/select-chevron.svg").size(px(13.)).flex_none().text_color(p.muted))
}

/// One row of a menu under a [`select`], ticked when it is the choice.
pub fn menu_row(id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool, p: &Palette) -> Stateful<Div> {
    let hover = p.fg(0.06);
    h_flex()
        .id(id)
        .justify_between()
        .gap(px(14.))
        .px(px(8.))
        .py(px(6.))
        .rounded(px(6.))
        .text_size(px(12.5))
        .text_color(p.foreground)
        .whitespace_nowrap()
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .child(label.into())
        .child(div().w(px(14.)).flex_none().when(on, |el| el.child(svg().path("markie/check.svg").size(px(13.)).text_color(p.foreground))))
}

/// The track of a segmented control; fill it with [`segment`]s.
pub fn segments(p: &Palette) -> Div {
    h_flex().flex_none().h(px(32.)).p(px(2.)).gap(px(2.)).rounded(px(7.)).border_1().border_color(p.border).bg(p.fg(0.03))
}

/// One choice of a segmented control, with an optional count after it.
pub fn segment(id: impl Into<ElementId>, label: impl Into<SharedString>, count: Option<usize>, on: bool, p: &Palette) -> Stateful<Div> {
    let fg = p.foreground;
    h_flex()
        .id(id)
        .h_full()
        .gap(px(5.))
        .px(px(9.))
        .items_center()
        .rounded(px(5.))
        .text_size(px(12.5))
        .whitespace_nowrap()
        .cursor_pointer()
        .text_color(if on { p.foreground } else { p.muted })
        .when(on, |el| {
            el.bg(if p.dark { p.fg(0.12) } else { p.background })
                .font_weight(FontWeight::MEDIUM)
                .shadow(vec![BoxShadow { color: hsla(0., 0., 0., if p.dark { 0.3 } else { 0.10 }), offset: point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: false }])
        })
        .hover(move |s| s.text_color(fg))
        .child(label.into())
        .children(count.map(|n| div().text_size(px(11.)).text_color(p.muted).child(n.to_string())))
}

/// The middle of an empty page: an icon, one line that says what is (not)
/// here, one that says what to do, and the buttons the page hands in.
pub fn empty_state(glyph: &'static str, title: impl Into<SharedString>, body: impl Into<SharedString>, p: &Palette) -> Div {
    let body: SharedString = body.into();
    gpui_kit::component::v_flex()
        .w_full()
        .items_center()
        .py(px(56.))
        .px(px(24.))
        .child(
            div()
                .size(px(44.))
                .mb(px(14.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(12.))
                .bg(p.fg(0.05))
                .child(svg().path(glyph).size(px(20.)).text_color(p.muted)),
        )
        .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(p.foreground).text_center().child(title.into()))
        .when(!body.is_empty(), |el| el.child(div().mt(px(4.)).max_w(px(480.)).text_size(px(13.)).line_height(px(19.)).text_color(p.muted).text_center().child(body)))
}
