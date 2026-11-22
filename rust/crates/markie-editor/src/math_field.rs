//! Editing an inline formula in place, as `mathNodeView` in rich-math.ts
//! does: a click on the formula swaps it for a one-line field holding its
//! whole source, `$…$` included. Enter or leaving the field commits, Escape
//! cancels, and an empty field removes the formula.

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Sizable as _};
use gpui_kit::*;

use super::RichView;
use markie_rich::edit::Unit;
use markie_rich::editor::Pos;
use markie_rich::model::Inline;

pub(crate) struct MathField {
    /// The formula's leaf and unit index.
    pub at: (Pos, usize),
    pub input: Entity<InputState>,
    /// The source when the field opened, so an unchanged commit is no edit.
    pub opened: String,
    _sub: Subscription,
}

impl RichView {
    /// The source of the inline formula at `at`, if it is one.
    fn inline_math_source(&self, at: (Pos, usize)) -> Option<String> {
        match self.editor.units(at.0.block, at.0.leaf).get(at.1) {
            Some(Unit::Atom(Inline::Math { source })) => Some(source.clone()),
            _ => None,
        }
    }

    pub(crate) fn open_math_field(&mut self, p: Pos, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        self.commit_math_field(window, cx);
        let at = (Pos { offset: 0, ..p }, index);
        let Some(source) = self.inline_math_source(at) else { return };
        let input = cx.new(|cx| InputState::new(window, cx));
        input.update(cx, |s, cx| s.set_value(source.clone(), window, cx));
        let sub = cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| match ev {
            InputEvent::PressEnter { .. } | InputEvent::Blur => this.commit_math_field(window, cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        });
        let h = input.read(cx).focus_handle(cx);
        self.math_field = Some(MathField { at, input, opened: source, _sub: sub });
        h.focus(window, cx);
        cx.notify();
    }

    /// Write the field back into its formula (or drop it unchanged).
    pub(crate) fn commit_math_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(f) = self.math_field.take() else { return };
        let value = f.input.read(cx).value().to_string();
        let still_there = self.inline_math_source(f.at).is_some_and(|s| s == f.opened);
        if value != f.opened && still_there {
            let (p, i) = f.at;
            let src = if value.trim().is_empty() { String::new() } else { value };
            self.edit(cx, |e| e.set_inline_math(p, i, &src));
        }
        self.focus(window, cx);
        cx.notify();
    }

    pub(crate) fn cancel_math_field(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.math_field.take().is_none() {
            return false;
        }
        self.focus(window, cx);
        cx.notify();
        true
    }

    /// Is the point on the formula's own box (unit `i` of the leaf at `p`)?
    pub(crate) fn hit_is_atom(&self, at: Point<Pixels>, p: Pos, i: usize) -> bool {
        let store = self.store.borrow();
        let Some(pl) = store.leaves.get(&(p.block, p.leaf)) else { return false };
        let a = pl.laid.caret(i.min(pl.laid.len), false);
        let b = pl.laid.caret((i + 1).min(pl.laid.len), true);
        let o = pl.bounds.origin;
        let (x, y) = (at.x - o.x, at.y - o.y);
        a.origin.y == b.origin.y && x >= a.origin.x && x <= b.origin.x && y >= a.origin.y && y <= a.origin.y + a.size.height
    }

    /// The field, drawn over the formula where it was laid out.
    pub(crate) fn render_math_field(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let f = self.math_field.as_ref()?;
        let (p, i) = f.at;
        let pl = self.store.borrow().leaves.get(&(p.block, p.leaf)).cloned()?;
        let c = pl.laid.caret(i.min(pl.laid.len), false);
        let origin = point(pl.bounds.origin.x + c.origin.x, pl.bounds.origin.y + c.origin.y);
        let chars = f.input.read(cx).value().chars().count().max(3) + 1;
        let width = px(16. + chars as f32 * 8.4 * self.zoom);
        let theme = cx.theme();
        Some(
            deferred(
                anchored().position(origin).child(
                    div()
                        .id("rich-math-field")
                        .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                            if ev.keystroke.key == "escape" {
                                cx.stop_propagation();
                                this.cancel_math_field(window, cx);
                            }
                        }))
                        .w(width)
                        .bg(theme.background)
                        .child(Input::new(&f.input).small()),
                ),
            )
            .into_any_element(),
        )
    }
}
