//! The element that draws one leaf with `layout.rs`, and records where it
//! landed so clicks, the caret and the input method can find it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use gpui_kit::*;

use super::layout::{Laid, LeafSpec, layout};

/// (block, leaf) to where the leaf was drawn last frame.
pub type LeafKey = (usize, usize);

#[derive(Clone)]
pub struct Placement {
    pub bounds: Bounds<Pixels>,
    pub laid: Rc<Laid>,
}

#[derive(Default)]
pub struct Store {
    pub leaves: HashMap<LeafKey, Placement>,
    /// Atoms (pictures, rules, embeds) by key, for clicks and scrolling.
    pub atoms: HashMap<LeafKey, Bounds<Pixels>>,
    /// The frame these were drawn in; older entries are stale.
    pub frame: u64,
}

pub type SharedStore = Rc<RefCell<Store>>;

/// What to draw over the text.
#[derive(Clone, Default)]
pub struct Deco {
    pub selection: Option<Range<usize>>,
    pub caret: Option<(usize, bool)>,
    pub finds: Vec<(Range<usize>, bool)>,
    pub marked: Option<Range<usize>>,
    pub selection_color: Hsla,
    pub caret_color: Hsla,
    pub find_color: Hsla,
    pub find_current_color: Hsla,
}

pub struct LeafElement {
    key: LeafKey,
    spec: Rc<LeafSpec>,
    deco: Deco,
    store: SharedStore,
    cache: Rc<RefCell<Option<(Pixels, Rc<Laid>)>>>,
}

impl LeafElement {
    pub fn new(key: LeafKey, spec: LeafSpec, deco: Deco, store: SharedStore) -> Self {
        LeafElement { key, spec: Rc::new(spec), deco, store, cache: Rc::new(RefCell::new(None)) }
    }
}

impl IntoElement for LeafElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for LeafElement {
    type RequestLayoutState = ();
    type PrepaintState = Option<Rc<Laid>>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let spec = self.spec.clone();
        let cache = self.cache.clone();
        let id = window.request_measured_layout(style, move |known, available, window, _cx| {
            let width = known.width.unwrap_or(match available.width {
                AvailableSpace::Definite(w) => w,
                _ => px(600.),
            });
            if let Some((w, laid)) = cache.borrow().as_ref() {
                if (*w - width).abs() < px(0.5) {
                    return size(width, laid.height);
                }
            }
            let laid = Rc::new(layout(&spec, width, window));
            let h = laid.height;
            *cache.borrow_mut() = Some((width, laid));
            size(width, h)
        });
        let _ = cx;
        (id, ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        let cached = self.cache.borrow().as_ref().filter(|(w, _)| (*w - bounds.size.width).abs() < px(0.5)).map(|(_, l)| l.clone());
        let laid = cached.unwrap_or_else(|| Rc::new(layout(&self.spec, bounds.size.width, window)));
        self.store.borrow_mut().leaves.insert(self.key, Placement { bounds, laid: laid.clone() });
        Some(laid)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        laid: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(laid) = laid.take() else { return };
        let o = bounds.origin;
        let at = |b: Bounds<Pixels>| Bounds::new(point(o.x + b.origin.x, o.y + b.origin.y), b.size);
        for (r, current) in &self.deco.finds {
            let color = if *current { self.deco.find_current_color } else { self.deco.find_color };
            for b in laid.selection_rects(r.clone()) {
                window.paint_quad(fill(at(b), color));
            }
        }
        if let Some(sel) = &self.deco.selection {
            for b in laid.selection_rects(sel.clone()) {
                window.paint_quad(fill(at(b), self.deco.selection_color));
            }
        }
        laid.paint(o, window, cx);
        if let Some(m) = &self.deco.marked {
            for b in laid.selection_rects(m.clone()) {
                let line = Bounds::new(point(b.origin.x, b.origin.y + b.size.height - px(2.)), size(b.size.width, px(1.)));
                window.paint_quad(fill(at(line), self.deco.caret_color));
            }
        }
        if let Some((u, upstream)) = self.deco.caret {
            let c = laid.caret(u.min(laid.len), upstream);
            // A little shorter than the line, centred, like a text caret.
            let inset = (c.size.height * 0.12).min(px(4.));
            let b = Bounds::new(point(c.origin.x, c.origin.y + inset), size(px(1.5), c.size.height - inset * 2.));
            window.paint_quad(fill(at(b), self.deco.caret_color));
        }
    }
}
