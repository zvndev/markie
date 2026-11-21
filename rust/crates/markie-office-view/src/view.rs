//! The GPUI Word page view. Paragraphs are `StyledText` runs; their
//! `TextLayout`s from the last frame answer every caret, click and IME
//! question. Pages are laid out from measured block heights.
//!
//! The engine is the only place a document changes: every edit goes through
//! `WordEditor`. This file owns pixels, focus, the platform input handler and
//! the composition (IME marked text), which is shown on screen and committed
//! to the engine once, when the input method finishes.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::InputState;
use gpui_kit::component::{ActiveTheme, Disableable as _, Selectable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_office::model::{Block, Format, ImageType, Paragraph, TextPosition};
use markie_office::rich_document::rich_image_bytes;

use crate::actions::{self, CONTEXT, WordCopy, WordCut, WordPaste, WordRedo, WordSelectAll, WordUndo};
use crate::colors::{RunColor, display_run_color};
use crate::commands::{available_commands, run_command};
use crate::editor::{Outcome, Tool, WordEditor};
use crate::layout::{self, Alignment, BreakHint, DEFAULT_FONT, PX_PER_POINT};
use crate::text;

/// Page layout or one continuous sheet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewMode {
    Page,
    Continuous,
}

/// White paper whatever the theme (the default), or paper in the theme's colors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaperTone {
    Light,
    Theme,
}

#[derive(Clone, Debug)]
pub enum WordViewEvent {
    /// The document, selection or view changed; the host refreshes its status.
    Changed,
    /// View > Actual Size: the host owns the shared document zoom.
    ZoomReset,
}

/// IME marked text: shown in place of `start..end` until the input method
/// commits it, then applied to the engine as one edit.
#[derive(Clone, Debug)]
struct Composition {
    paragraph_id: String,
    start: usize,
    end: usize,
    text: String,
    /// The input method's caret or selection inside `text`, UTF-8.
    selected: Option<Range<usize>>,
}

/// A paragraph's text layout from the last frame and how its rows align.
#[derive(Clone)]
struct Painted {
    layout: TextLayout,
    align: TextAlign,
}

/// The text-field inputs of the tool panel.
pub(crate) struct Inputs {
    pub font_family: Entity<InputState>,
    pub font_size: Entity<InputState>,
    pub color: Entity<InputState>,
    pub rows: Entity<InputState>,
    pub columns: Entity<InputState>,
    pub link: Entity<InputState>,
    pub margins: [Entity<InputState>; 4],
    pub before: Entity<InputState>,
    pub after: Entity<InputState>,
    pub author: Entity<InputState>,
    pub comment_author: Entity<InputState>,
    pub comment_text: Entity<InputState>,
}

pub(crate) struct PageColors {
    pub paper: Hsla,
    pub text: Hsla,
    pub muted: Hsla,
    pub link: Hsla,
    pub selection: Hsla,
    pub rule: Hsla,
    pub rgb: [u8; 3],
}

pub struct WordView {
    pub editor: WordEditor,
    pub(crate) focus: FocusHandle,
    scroll: ScrollHandle,
    pub mode: ViewMode,
    pub outline: bool,
    pub zoom: f32,
    pub paper: PaperTone,
    pub(crate) tool: Option<Tool>,
    pub(crate) inputs: Inputs,
    /// Layouts being built by this render, and the ones the last frame painted.
    building: RefCell<HashMap<String, Painted>>,
    painted: Rc<RefCell<HashMap<String, Painted>>>,
    heights: Rc<RefCell<Vec<f32>>>,
    composition: Option<Composition>,
    dragging: bool,
    goal_x: Option<Pixels>,
    reveal: Rc<Cell<bool>>,
    images: HashMap<String, Arc<Image>>,
}

impl EventEmitter<WordViewEvent> for WordView {}

impl Focusable for WordView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn hsla_rgb(color: Hsla) -> [u8; 3] {
    let rgba = color.to_rgb();
    [(rgba.r * 255.0).round() as u8, (rgba.g * 255.0).round() as u8, (rgba.b * 255.0).round() as u8]
}

fn rgb_hsla([r, g, b]: [u8; 3]) -> Hsla {
    rgb(((r as u32) << 16) | ((g as u32) << 8) | b as u32).into()
}

fn text_align(alignment: Alignment) -> TextAlign {
    match alignment {
        Alignment::Center => TextAlign::Center,
        Alignment::Right => TextAlign::Right,
        // GPUI has no justified text; justified paragraphs show left aligned.
        Alignment::Left | Alignment::Justify => TextAlign::Left,
    }
}

/// Per visual row, how far alignment moves the row right. GPUI paints rows
/// aligned but measures carets unaligned, so the view corrects for it.
fn row_shifts(painted: &Painted) -> Vec<Pixels> {
    let layout = &painted.layout;
    let width = layout.bounds().size.width;
    let mut shifts = Vec::new();
    for line in layout.line_layouts() {
        let unwrapped = &line.unwrapped_layout;
        let glyph_x = |b: &WrapBoundary| unwrapped.runs.get(b.run_ix).and_then(|r| r.glyphs.get(b.glyph_ix)).map_or(px(0.), |g| g.position.x);
        let boundaries = &line.wrap_boundaries;
        for row in 0..=boundaries.len() {
            let start = if row == 0 { px(0.) } else { glyph_x(&boundaries[row - 1]) };
            let end = boundaries.get(row).map_or(unwrapped.width, glyph_x);
            let line_width = end - start;
            shifts.push(match painted.align {
                TextAlign::Left => px(0.),
                TextAlign::Center => ((width - line_width) / 2.0).max(px(0.)),
                TextAlign::Right => (width - line_width).max(px(0.)),
            });
        }
    }
    shifts
}

fn row_of(painted: &Painted, y: Pixels) -> usize {
    let top = painted.layout.bounds().top();
    let line_height = painted.layout.line_height();
    if line_height <= px(0.) {
        return 0;
    }
    ((y - top) / line_height).floor().max(0.0) as usize
}

/// Where the caret before byte `index` is drawn, in window coordinates.
fn caret_point(painted: &Painted, index: usize) -> Point<Pixels> {
    let layout = &painted.layout;
    let mut point = layout.position_for_index(index).unwrap_or_else(|| {
        let bounds = layout.bounds();
        if index == 0 { bounds.origin } else { point(bounds.right(), bounds.bottom() - layout.line_height()) }
    });
    if painted.align != TextAlign::Left {
        let shifts = row_shifts(painted);
        point.x += shifts.get(row_of(painted, point.y)).copied().unwrap_or(px(0.));
    }
    point
}

/// The byte index nearest a window point.
fn index_at(painted: &Painted, mut position: Point<Pixels>) -> usize {
    if painted.align != TextAlign::Left {
        let shifts = row_shifts(painted);
        position.x -= shifts.get(row_of(painted, position.y)).copied().unwrap_or(px(0.));
    }
    match painted.layout.index_for_position(position) {
        Ok(index) | Err(index) => index,
    }
}

impl WordView {
    pub fn new(editor: WordEditor, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut input = |placeholder: &str| {
            let placeholder = placeholder.to_string();
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder))
        };
        let inputs = Inputs {
            font_family: input("Inherited font"),
            font_size: input("Auto"),
            color: input("Hex, for example C00000"),
            rows: input("2"),
            columns: input("2"),
            link: input("https://example.com"),
            margins: [input("Top"), input("Bottom"), input("Left"), input("Right")],
            before: input("0"),
            after: input("8"),
            author: input("Revision author"),
            comment_author: input("Comment author"),
            comment_text: input("Comment on the selected paragraph"),
        };
        let mode = if editor.is_docx() { ViewMode::Page } else { ViewMode::Continuous };
        WordView {
            editor,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            mode,
            outline: false,
            zoom: 1.0,
            paper: PaperTone::Light,
            tool: None,
            inputs,
            building: RefCell::new(HashMap::new()),
            painted: Rc::new(RefCell::new(HashMap::new())),
            heights: Rc::new(RefCell::new(Vec::new())),
            composition: None,
            dragging: false,
            goal_x: None,
            reveal: Rc::new(Cell::new(false)),
            images: HashMap::new(),
        }
    }

    pub fn set_zoom(&mut self, zoom: f32) {
        self.zoom = zoom.clamp(0.5, 2.0);
    }

    /// Something changed: repaint, tell the host, and refresh IME geometry.
    pub(crate) fn changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.invalidate_character_coordinates();
        cx.emit(WordViewEvent::Changed);
        cx.notify();
    }

    pub(crate) fn edited(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.reveal.set(true);
        self.changed(window, cx);
    }

    // ----- commands -------------------------------------------------------

    pub fn command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.commit_composition();
        match id {
            "view-page" => self.mode = ViewMode::Page,
            "view-continuous" => self.mode = ViewMode::Continuous,
            "view-outline" => self.outline = !self.outline,
            "view-zoom-reset" => {
                self.zoom = 1.0;
                cx.emit(WordViewEvent::ZoomReset);
            }
            _ => match run_command(&mut self.editor, id) {
                Outcome::Open(tool) => self.open_tool(tool, window, cx),
                Outcome::Done | Outcome::Ignored => {}
            },
        }
        self.edited(window, cx);
    }

    // ----- composition and display text ----------------------------------

    fn commit_composition(&mut self) {
        if let Some(composition) = self.composition.take() {
            self.commit(composition, None);
        }
    }

    fn commit(&mut self, composition: Composition, text: Option<&str>) {
        let text = text.unwrap_or(&composition.text).to_string();
        let start = TextPosition { paragraph_id: composition.paragraph_id.clone(), offset: composition.start };
        let end = TextPosition { paragraph_id: composition.paragraph_id, offset: composition.end };
        if text.is_empty() && composition.start == composition.end {
            self.editor.select(start.clone(), start);
            return;
        }
        self.editor.replace_range(start, end, &text);
    }

    /// The text shown for a paragraph: the engine's, the original's in the
    /// Original view, with any marked text spliced in.
    fn display_text(&self, paragraph: &Paragraph) -> String {
        let shown = self.editor.shown(paragraph).0;
        match &self.composition {
            Some(c) if c.paragraph_id == paragraph.id && c.end <= shown.len() => format!("{}{}{}", &shown[..c.start], c.text, &shown[c.end..]),
            _ => shown,
        }
    }

    fn focus_display(&self) -> String {
        self.editor.paragraph(&self.editor.focus.paragraph_id).map(|p| self.display_text(p)).unwrap_or_default()
    }

    /// The caret or selection inside the focus paragraph, in display bytes.
    fn display_selection(&self) -> Range<usize> {
        if let Some(c) = &self.composition {
            let selected = c.selected.clone().unwrap_or(c.text.len()..c.text.len());
            return c.start + selected.start..c.start + selected.end;
        }
        let editor = &self.editor;
        if editor.is_cross() || editor.is_collapsed() {
            return editor.focus.offset..editor.focus.offset;
        }
        let (start, end) = editor.ordered();
        start.offset..end.offset
    }

    fn display_caret(&self) -> usize {
        match &self.composition {
            Some(c) => c.start + c.selected.as_ref().map_or(c.text.len(), |r| r.end),
            None => self.editor.focus.offset,
        }
    }

    // ----- hit testing ----------------------------------------------------

    /// The text position under a window point, from the last painted frame.
    fn hit(&self, position: Point<Pixels>) -> Option<TextPosition> {
        let painted = self.painted.borrow();
        let mut best: Option<(Pixels, Pixels, &String, &Painted)> = None;
        for (id, item) in painted.iter() {
            let bounds = item.layout.bounds();
            let dy = if position.y < bounds.top() { bounds.top() - position.y } else if position.y > bounds.bottom() { position.y - bounds.bottom() } else { px(0.) };
            let dx = if position.x < bounds.left() { bounds.left() - position.x } else if position.x > bounds.right() { position.x - bounds.right() } else { px(0.) };
            if best.as_ref().is_none_or(|(by, bx, _, _)| (dy, dx) < (*by, *bx)) {
                best = Some((dy, dx, id, item));
            }
        }
        let (_, _, id, item) = best?;
        let bounds = item.layout.bounds();
        let clamped = point(position.x.clamp(bounds.left(), bounds.right().max(bounds.left())), position.y.clamp(bounds.top(), (bounds.bottom() - px(1.)).max(bounds.top())));
        let offset = index_at(item, clamped);
        Some(TextPosition { paragraph_id: id.clone(), offset })
    }

    fn focus_painted(&self) -> Option<Painted> {
        self.painted.borrow().get(&self.editor.focus.paragraph_id).cloned()
    }

    fn caret_window_point(&self) -> Option<(Point<Pixels>, Pixels)> {
        let painted = self.focus_painted()?;
        Some((caret_point(&painted, self.display_caret()), painted.layout.line_height()))
    }

    // ----- mouse ----------------------------------------------------------

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
        self.commit_composition();
        let Some(position) = self.hit(event.position) else { return };
        self.goal_x = None;
        let text = self.editor.paragraph(&position.paragraph_id).map(|p| self.editor.shown(p).0).unwrap_or_default();
        match event.click_count {
            2 => {
                let word = text::word_at(&text, position.offset);
                self.editor.select(
                    TextPosition { paragraph_id: position.paragraph_id.clone(), offset: word.start },
                    TextPosition { paragraph_id: position.paragraph_id, offset: word.end },
                );
            }
            n if n >= 3 => {
                self.editor.select(
                    TextPosition { paragraph_id: position.paragraph_id.clone(), offset: 0 },
                    TextPosition { paragraph_id: position.paragraph_id, offset: text.len() },
                );
            }
            _ => {
                // Links open with Cmd-click, or a plain click when nothing can be edited.
                if (event.modifiers.platform || !self.editor.can_mutate())
                    && let Some(target) = self.link_at(&position)
                {
                    cx.open_url(&target);
                    return;
                }
                self.editor.set_caret(position, event.modifiers.shift);
                self.dragging = true;
            }
        }
        self.changed(window, cx);
    }

    fn link_at(&self, position: &TextPosition) -> Option<String> {
        let paragraph = self.editor.paragraph(&position.paragraph_id)?;
        let mut offset = 0;
        paragraph.runs.iter().find_map(|run| {
            let from = offset;
            offset += run.text.len();
            (position.offset >= from && position.offset < offset).then(|| run.target.clone()).flatten()
        })
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.dragging {
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            self.dragging = false;
            return;
        }
        if let Some(position) = self.hit(event.position)
            && position != self.editor.focus
        {
            self.editor.set_caret(position, true);
            self.changed(window, cx);
        }
    }

    // ----- keyboard -------------------------------------------------------

    fn move_vertical(&mut self, down: bool, extend: bool) {
        let Some((caret, line_height)) = self.caret_window_point() else { return };
        let x = *self.goal_x.get_or_insert(caret.x);
        let y = if down { caret.y + line_height * 1.5 } else { caret.y - line_height * 0.5 };
        let target = self.hit(point(x, y));
        match target {
            Some(target) if target != self.editor.focus => self.editor.set_caret(target, extend),
            _ => self.editor.move_to_document_edge(down, extend),
        }
    }

    fn move_line_edge(&mut self, end: bool, extend: bool) {
        let Some(painted) = self.focus_painted() else { return };
        let Some((caret, line_height)) = self.caret_window_point() else { return };
        let bounds = painted.layout.bounds();
        let x = if end { bounds.right() + px(10_000.) } else { bounds.left() - px(10_000.) };
        let y = caret.y + line_height / 2.0;
        let mut offset = match painted.layout.index_for_position(point(x, y)) {
            Ok(i) | Err(i) => i,
        };
        if !end {
            // Unaligned measure at the far left is the row start in every alignment.
            offset = offset.min(self.editor.focus.offset);
        }
        let paragraph_id = self.editor.focus.paragraph_id.clone();
        self.editor.set_caret(TextPosition { paragraph_id, offset }, extend);
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) || self.composition.is_some() {
            return;
        }
        let keystroke = &event.keystroke;
        let m = keystroke.modifiers;
        if m.control {
            return;
        }
        let extend = m.shift;
        let vertical = matches!(keystroke.key.as_str(), "up" | "down");
        match keystroke.key.as_str() {
            "left" | "right" => {
                let forward = keystroke.key == "right";
                if m.platform {
                    self.move_line_edge(forward, extend);
                } else if m.alt {
                    self.editor.move_word(forward, extend);
                } else {
                    self.editor.move_horizontal(forward, extend);
                }
            }
            "up" | "down" => {
                let down = keystroke.key == "down";
                if m.platform {
                    self.editor.move_to_document_edge(down, extend);
                } else {
                    self.move_vertical(down, extend);
                }
            }
            "home" | "end" => self.move_line_edge(keystroke.key == "end", extend),
            "pageup" | "pagedown" => self.editor.move_to_document_edge(keystroke.key == "pagedown", extend),
            "backspace" => {
                if m.alt && self.editor.is_collapsed() {
                    self.editor.move_word(false, true);
                }
                self.editor.backspace();
            }
            "delete" => {
                if m.alt && self.editor.is_collapsed() {
                    self.editor.move_word(true, true);
                }
                self.editor.delete_forward();
            }
            "enter" => {
                if m.platform || m.alt {
                    return;
                }
                if m.shift {
                    self.editor.error = Some("Soft line breaks need source-safe inline editing and were not applied.".into());
                } else {
                    self.editor.split();
                }
            }
            "escape" if self.tool.is_some() => self.tool = None,
            _ => return,
        }
        cx.stop_propagation();
        let goal = self.goal_x;
        self.edited(window, cx);
        if vertical {
            self.goal_x = goal;
        }
    }

    fn on_copy(&mut self, _: &WordCopy, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = self.editor.copy_text() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn on_cut(&mut self, _: &WordCut, window: &mut Window, cx: &mut Context<Self>) {
        self.commit_composition();
        if let Some(text) = self.editor.cut() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
        self.edited(window, cx);
    }

    fn on_paste(&mut self, _: &WordPaste, window: &mut Window, cx: &mut Context<Self>) {
        self.commit_composition();
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.editor.paste(&text);
        }
        self.edited(window, cx);
    }

    fn on_select_all(&mut self, _: &WordSelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.commit_composition();
        self.editor.select_all();
        self.changed(window, cx);
    }

    fn on_undo(&mut self, _: &WordUndo, window: &mut Window, cx: &mut Context<Self>) {
        self.composition = None;
        self.editor.undo();
        self.edited(window, cx);
    }

    fn on_redo(&mut self, _: &WordRedo, window: &mut Window, cx: &mut Context<Self>) {
        self.composition = None;
        self.editor.redo();
        self.edited(window, cx);
    }

    // ----- painting helpers -----------------------------------------------

    pub(crate) fn page_colors(&self, cx: &App) -> PageColors {
        let theme = cx.theme();
        match self.paper {
            PaperTone::Light => PageColors {
                paper: rgb(0xffffff).into(),
                text: rgb(0x1f2328).into(),
                muted: rgb(0x6b7280).into(),
                link: rgb(0x1a5fb4).into(),
                selection: hsla(0.58, 0.9, 0.55, 0.28),
                rule: rgb(0xd0d4da).into(),
                rgb: [255, 255, 255],
            },
            PaperTone::Theme => PageColors {
                paper: theme.background,
                text: theme.foreground,
                muted: theme.muted_foreground,
                link: theme.link,
                selection: theme.selection,
                rule: theme.border,
                rgb: hsla_rgb(theme.background),
            },
        }
    }

    /// The text runs of a paragraph, split where the selection and the marked
    /// text start and end.
    fn text_runs(&self, paragraph: &Paragraph, display: &str, colors: &PageColors) -> Vec<TextRun> {
        let (shown, runs) = self.editor.shown(paragraph);
        let joined: String = runs.iter().map(|r| r.text.as_str()).collect();
        // (length, run index) over the shown text.
        let base: Vec<(usize, Option<usize>)> = if joined == shown {
            runs.iter().enumerate().map(|(i, r)| (r.text.len(), Some(i))).collect()
        } else {
            vec![(shown.len(), None)]
        };
        let composition = self.composition.as_ref().filter(|c| c.paragraph_id == paragraph.id && c.end <= shown.len());
        let mut segments = match composition {
            Some(c) => crate::text::splice_segments(&base, c.start, c.end, c.text.len()),
            None => base.into_iter().map(|(len, run)| (len, run, false)).collect(),
        };
        segments.retain(|s| s.0 > 0);
        if segments.iter().map(|s| s.0).sum::<usize>() != display.len() {
            segments = vec![(display.len(), None, false)];
        }
        // Split at the selection.
        let selection = if self.composition.is_some() { None } else { self.editor.selection_in(&paragraph.id) };
        let mut out = Vec::new();
        let mut at = 0;
        for (len, run, marked) in segments {
            let look = run.and_then(|i| runs.get(i)).map(|r| layout::run_look(r, paragraph));
            let mut cuts = vec![at, at + len];
            if let Some((a, b)) = selection {
                cuts.extend([a, b].into_iter().filter(|cut| *cut > at && *cut < at + len));
            }
            cuts.sort_unstable();
            for pair in cuts.windows(2) {
                let (from, to) = (pair[0], pair[1]);
                if to <= from {
                    continue;
                }
                let selected = selection.is_some_and(|(a, b)| from >= a && to <= b && a < b);
                out.push(self.text_run(to - from, look.as_ref(), marked, selected, colors));
            }
            at += len;
        }
        out
    }

    fn text_run(&self, len: usize, look: Option<&layout::RunLook>, marked: bool, selected: bool, colors: &PageColors) -> TextRun {
        let color = match look.and_then(|l| l.color.as_deref()) {
            Some(hex) => match display_run_color(hex, colors.rgb) {
                Some(RunColor::Rgb(c)) => rgb_hsla(c),
                _ => colors.text,
            },
            None if look.is_some_and(|l| l.link) => colors.link,
            None => colors.text,
        };
        let family: SharedString = look.and_then(|l| l.font_family.clone()).unwrap_or_else(|| DEFAULT_FONT.to_string()).into();
        let mut font = font(family);
        if look.is_some_and(|l| l.bold) {
            font.weight = FontWeight::BOLD;
        }
        if look.is_some_and(|l| l.italic) {
            font.style = FontStyle::Italic;
        }
        let underline = marked || look.is_some_and(|l| l.underline);
        TextRun {
            len,
            font,
            color,
            background_color: selected.then_some(colors.selection),
            underline: underline.then_some(UnderlineStyle { thickness: px(1.), color: Some(color), wavy: false }),
            strikethrough: None,
        }
    }

    /// One paragraph as styled text, with its list marker and change bar.
    pub(crate) fn paragraph_element(&self, paragraph: &Paragraph, colors: &PageColors) -> AnyElement {
        let zoom = self.zoom;
        let look = layout::paragraph_look(paragraph);
        let display = self.display_text(paragraph);
        let runs = self.text_runs(paragraph, &display, colors);
        let size = px(layout::paragraph_size_points(paragraph) as f32 * PX_PER_POINT * zoom);
        let line_height = size * look.line_multiple as f32;
        let align = text_align(look.alignment);
        let styled = StyledText::new(display).with_runs(runs);
        self.building.borrow_mut().insert(paragraph.id.clone(), Painted { layout: styled.layout().clone(), align });
        let before = px(look.before_points as f32 * PX_PER_POINT * zoom);
        let after = px(look.after_points as f32 * PX_PER_POINT * zoom);
        let indent = px(look.indent_px * zoom);
        let revised = !paragraph.revision_ids.is_empty();
        let marker_width = px(22. * zoom);
        div()
            .w_full()
            .relative()
            .pt(before)
            .pb(after)
            .pl(indent)
            .when(revised, |d| d.border_l_2().border_color(rgb(0xd19a00)).pl(indent + px(6.)))
            .when_some(look.marker, |d, marker| {
                d.child(
                    div()
                        .absolute()
                        .top(before)
                        .left(indent - marker_width - px(2.))
                        .w(marker_width)
                        .text_right()
                        .text_size(size)
                        .line_height(line_height)
                        .font_family(DEFAULT_FONT)
                        .text_color(colors.text)
                        .child(marker),
                )
            })
            .child(
                div()
                    .w_full()
                    .min_h(line_height)
                    .text_size(size)
                    .line_height(line_height)
                    .font_family(DEFAULT_FONT)
                    .text_color(colors.text)
                    .map(|d| match align {
                        TextAlign::Center => d.text_center(),
                        TextAlign::Right => d.text_right(),
                        TextAlign::Left => d.text_left(),
                    })
                    .child(styled),
            )
            .into_any_element()
    }

    fn picture_element(&self, id: &str, width_points: f64, height_points: f64, colors: &PageColors, cx: &mut Context<Self>) -> AnyElement {
        let zoom = self.zoom;
        let paragraph = self.editor.rich().images.iter().find(|i| i.id == id).map(|i| i.paragraph_id.clone()).unwrap_or_default();
        let selected = self.editor.focus.paragraph_id == paragraph;
        let picture = self.images.get(id).cloned();
        div()
            .id(SharedString::from(format!("picture-{id}")))
            .py(px(4. * zoom))
            .child(
                div()
                    .w(px(width_points as f32 * PX_PER_POINT * zoom))
                    .h(px(height_points as f32 * PX_PER_POINT * zoom))
                    .max_w_full()
                    .when(selected, |d| d.border_2().border_color(colors.link))
                    .map(|d| match picture {
                        Some(image) => d.child(img(ImageSource::Image(image)).size_full().object_fit(ObjectFit::Contain)),
                        None => d.bg(colors.rule).child("Picture"),
                    }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                    this.focus.focus(window, cx);
                    this.commit_composition();
                    this.editor.set_caret(TextPosition { paragraph_id: paragraph.clone(), offset: 0 }, false);
                    cx.stop_propagation();
                    this.changed(window, cx);
                }),
            )
            .into_any_element()
    }

    /// A block: a paragraph with its pictures and break marker, or a table.
    fn block_element(&self, block: &Block, hint: BreakHint, colors: &PageColors, cx: &mut Context<Self>) -> AnyElement {
        let zoom = self.zoom;
        let doc = self.editor.rich();
        match block {
            Block::Paragraph(id) => {
                let Some(paragraph) = doc.paragraph(id) else { return div().into_any_element() };
                let pictures: Vec<(String, f64, f64)> = if doc.format == Format::Docx {
                    doc.images.iter().filter(|i| &i.paragraph_id == id).map(|i| (i.id.clone(), i.width_points, i.height_points)).collect()
                } else {
                    Vec::new()
                };
                let show_text = pictures.is_empty() || !paragraph.text.is_empty() || !paragraph.runs.iter().all(|r| r.page_breaks.is_empty());
                let marker = self.mode == ViewMode::Continuous && hint.after;
                v_flex()
                    .w_full()
                    .children(pictures.iter().map(|(pid, w, h)| self.picture_element(pid, *w, *h, colors, cx)))
                    .when(show_text, |d| d.child(self.paragraph_element(paragraph, colors)))
                    .when(marker || (self.mode == ViewMode::Continuous && hint.before), |d| {
                        let rule = div()
                            .w_full()
                            .my(px(8. * zoom))
                            .border_t_1()
                            .border_dashed()
                            .border_color(colors.muted)
                            .pt(px(2.))
                            .text_size(px(9.))
                            .text_center()
                            .text_color(colors.muted)
                            .child("Page break");
                        if hint.before { d.flex_col_reverse().child(rule) } else { d.child(rule) }
                    })
                    .into_any_element()
            }
            Block::Table(id) => {
                let Some(table) = doc.tables.iter().find(|t| &t.id == id) else { return div().into_any_element() };
                v_flex()
                    .w_full()
                    .my(px(4. * zoom))
                    .border_l_1()
                    .border_t_1()
                    .border_color(colors.rule)
                    .children(table.rows.iter().map(|row| {
                        h_flex().w_full().items_stretch().children(row.cells.iter().map(|cell| {
                            v_flex()
                                .flex_1()
                                .min_w(px(60. * zoom))
                                .border_r_1()
                                .border_b_1()
                                .border_color(colors.rule)
                                .px(px(7. * zoom))
                                .pt(px(7. * zoom))
                                .children(cell.paragraph_ids.iter().filter_map(|pid| doc.paragraph(pid)).map(|p| self.paragraph_element(p, colors)))
                        }))
                    }))
                    .into_any_element()
            }
        }
    }

    fn block_paragraph_ids(&self, block: &Block) -> Vec<String> {
        let doc = self.editor.rich();
        match block {
            Block::Paragraph(id) => vec![id.clone()],
            Block::Table(id) => doc
                .tables
                .iter()
                .filter(|t| &t.id == id)
                .flat_map(|t| t.rows.iter().flat_map(|r| r.cells.iter().flat_map(|c| c.paragraph_ids.clone())))
                .collect(),
        }
    }

    /// Comments and tracked changes for these paragraphs, in the margin.
    fn margin(&self, paragraph_ids: &[String], colors: &PageColors, cx: &mut Context<Self>) -> AnyElement {
        let doc = self.editor.rich();
        let theme = cx.theme().clone();
        let can_review = self.editor.can_mutate();
        let mut cards: Vec<AnyElement> = Vec::new();
        for comment in doc.comments.iter().filter(|c| paragraph_ids.contains(&c.paragraph_id)) {
            let paragraph = comment.paragraph_id.clone();
            cards.push(
                v_flex()
                    .id(SharedString::from(format!("comment-{}", comment.id)))
                    .p_2()
                    .gap_1()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.background)
                    .text_xs()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(comment.author.clone()))
                    .child(div().text_color(theme.foreground).child(comment.text.clone()))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.editor.set_caret(TextPosition { paragraph_id: paragraph.clone(), offset: 0 }, false);
                        this.reveal.set(true);
                        this.changed(window, cx);
                    }))
                    .into_any_element(),
            );
        }
        for revision in doc.revisions.iter().filter(|r| paragraph_ids.contains(&r.paragraph_id)) {
            let (accept, reject) = (revision.id.clone(), revision.id.clone());
            let inserted = revision.kind == markie_office::model::RevisionKind::Insertion;
            let shown = if revision.text.is_empty() { "Empty text".to_string() } else { revision.text.clone() };
            cards.push(
                v_flex()
                    .p_2()
                    .gap_1()
                    .rounded_md()
                    .border_1()
                    .border_color(rgb(0xd19a00))
                    .bg(theme.background)
                    .text_xs()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(format!("{} · {}", if inserted { "Inserted" } else { "Deleted" }, revision.author)))
                    .child(
                        div()
                            .text_color(if inserted { theme.green } else { theme.red })
                            .when(inserted, |d| d.underline())
                            .when(!inserted, |d| d.line_through())
                            .child(shown),
                    )
                    .when(can_review, |d| {
                        d.child(
                            h_flex()
                                .gap_1()
                                .child(Button::new(SharedString::from(format!("accept-{accept}"))).xsmall().label("Accept").on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.editor.accept_revision(&accept);
                                        this.edited(window, cx);
                                    },
                                )))
                                .child(Button::new(SharedString::from(format!("reject-{reject}"))).xsmall().label("Reject").on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.editor.reject_revision(&reject);
                                        this.edited(window, cx);
                                    },
                                ))),
                        )
                    })
                    .into_any_element(),
            );
        }
        let _ = colors;
        v_flex().w(px(220.)).flex_none().gap_2().children(cards).into_any_element()
    }

    fn refresh_images(&mut self) {
        let doc = self.editor.doc().clone();
        self.images.retain(|id, _| doc.images.iter().any(|i| &i.id == id));
        for picture in &doc.images {
            if self.images.contains_key(&picture.id) {
                continue;
            }
            if let Ok(bytes) = rich_image_bytes(&doc, &picture.id) {
                let format = match picture.content_type {
                    ImageType::Png => ImageFormat::Png,
                    ImageType::Jpeg => ImageFormat::Jpeg,
                };
                self.images.insert(picture.id.clone(), Arc::new(Image::from_bytes(format, bytes)));
            }
        }
    }

    fn render_pages(&self, colors: &PageColors, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let doc = self.editor.rich().clone();
        let zoom = self.zoom;
        let scale = PX_PER_POINT * zoom;
        let hints: Vec<BreakHint> = doc.blocks.iter().map(|b| layout::break_hint(&doc, b)).collect();
        let with_margin = !doc.comments.is_empty() || !doc.revisions.is_empty();
        let theme = cx.theme().clone();
        let sheet = |content: AnyElement, page: bool| {
            let l = doc.page_layout;
            div()
                .flex_none()
                .bg(colors.paper)
                .border_1()
                .border_color(theme.border)
                .shadow_md()
                .when(page, |d| {
                    d.w(px(l.width_points as f32 * scale))
                        .min_h(px(l.height_points as f32 * scale))
                        .pt(px(l.margin_top_points as f32 * scale))
                        .pr(px(l.margin_right_points as f32 * scale))
                        .pb(px(l.margin_bottom_points as f32 * scale))
                        .pl(px(l.margin_left_points as f32 * scale))
                })
                .when(!page, |d| d.w_full().max_w(px(960. * zoom)).p(px(32. * zoom)))
                .child(content)
        };
        let record = |indices: Vec<usize>, heights: Rc<RefCell<Vec<f32>>>| {
            move |bounds: Vec<Bounds<Pixels>>, window: &mut Window, _: &mut App| {
                if bounds.len() != indices.len() {
                    return;
                }
                let mut heights = heights.borrow_mut();
                let mut changed = false;
                for (index, bound) in indices.iter().zip(bounds) {
                    let height = f32::from(bound.size.height);
                    if let Some(slot) = heights.get_mut(*index)
                        && (*slot - height).abs() > 0.5
                    {
                        *slot = height;
                        changed = true;
                    }
                }
                if changed {
                    window.request_animation_frame();
                }
            }
        };
        {
            let mut heights = self.heights.borrow_mut();
            if heights.len() != doc.blocks.len() {
                heights.resize(doc.blocks.len(), 0.0);
                // Unmeasured blocks get an estimate; the next frame corrects it.
                for h in heights.iter_mut().filter(|h| **h == 0.0) {
                    *h = 28.0 * zoom;
                }
            }
        }
        let mut rows = Vec::new();
        if self.mode == ViewMode::Continuous {
            let indices: Vec<usize> = (0..doc.blocks.len()).collect();
            let content = v_flex()
                .w_full()
                .on_children_prepainted(record(indices, self.heights.clone()))
                .children(doc.blocks.iter().zip(&hints).map(|(b, h)| self.block_element(b, *h, colors, cx)))
                .into_any_element();
            let ids: Vec<String> = doc.blocks.iter().flat_map(|b| self.block_paragraph_ids(b)).collect();
            rows.push(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_center()
                    .gap_4()
                    .child(sheet(content, false))
                    .when(with_margin, |d| d.child(self.margin(&ids, colors, cx)))
                    .into_any_element(),
            );
            return rows;
        }
        let l = doc.page_layout;
        let content_height = ((l.height_points - l.margin_top_points - l.margin_bottom_points) as f32 * scale).max(40.);
        let pages = layout::paginate(&self.heights.borrow(), &hints, content_height);
        let count = pages.len();
        for (number, indices) in pages.into_iter().enumerate() {
            let content = v_flex()
                .w_full()
                .on_children_prepainted(record(indices.clone(), self.heights.clone()))
                .children(indices.iter().map(|&i| self.block_element(&doc.blocks[i], hints[i], colors, cx)))
                .into_any_element();
            let ids: Vec<String> = indices.iter().flat_map(|&i| self.block_paragraph_ids(&doc.blocks[i])).collect();
            rows.push(
                v_flex()
                    .items_center()
                    .gap_1()
                    .child(
                        h_flex()
                            .items_start()
                            .gap_4()
                            .child(sheet(content, true))
                            .when(with_margin, |d| d.child(self.margin(&ids, colors, cx))),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(format!("Page {} of {count}", number + 1)))
                    .into_any_element(),
            );
        }
        rows
    }

    fn render_outline(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let headings: Vec<(String, String, usize)> = self
            .editor
            .rich()
            .paragraphs
            .iter()
            .filter(|p| layout::is_heading(p))
            .map(|p| (p.id.clone(), if p.text.is_empty() { "Empty heading".into() } else { p.text.clone() }, layout::heading_level(p)))
            .collect();
        v_flex()
            .id("word-outline")
            .w(px(180.))
            .h_full()
            .flex_none()
            .overflow_y_scroll()
            .border_r_1()
            .border_color(theme.border)
            .bg(theme.sidebar)
            .p_3()
            .gap_1()
            .child(div().text_xs().text_color(theme.muted_foreground).child("Outline"))
            .when(headings.is_empty(), |d| d.child(div().text_xs().text_color(theme.muted_foreground).child("No headings.")))
            .children(headings.into_iter().enumerate().map(|(i, (id, label, level))| {
                div()
                    .id(("outline", i))
                    .pl(px(level.saturating_sub(1) as f32 * 10.))
                    .text_sm()
                    .rounded_sm()
                    .px_1()
                    .hover(|d| d.bg(theme.accent))
                    .child(label)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.editor.set_caret(TextPosition { paragraph_id: id.clone(), offset: 0 }, false);
                        this.reveal.set(true);
                        this.focus.focus(window, cx);
                        this.changed(window, cx);
                    }))
            }))
    }

    fn banners(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = cx.theme().clone();
        let banner = |text: String, color: Hsla| {
            div().px_4().py_1p5().text_xs().border_b_1().border_color(theme.border).bg(color.opacity(0.12)).text_color(theme.foreground).child(text).into_any_element()
        };
        let editor = &self.editor;
        let doc = editor.rich();
        let mut out = Vec::new();
        if !doc.can_edit && !editor.host_read_only {
            let name = if doc.format == Format::Docx { "Word".to_string() } else { format!("{:?}", doc.format).to_uppercase() };
            let reason = doc.diagnostics.iter().find(|d| d.severity == markie_office::model::Severity::Warning).map(|d| format!(" {}", d.message)).unwrap_or_default();
            out.push(banner(format!("Read-only to protect unsupported {name} features. Saving keeps the unchanged original.{reason}"), theme.warning));
        }
        if editor.tracking {
            let author = if editor.review_author.trim().is_empty() { "an author is required".to_string() } else { editor.review_author.clone() };
            out.push(banner(format!("Tracking paragraph text as {author}. Formatting, layout and inserted content are not tracked."), theme.info));
        }
        if editor.original_view {
            out.push(banner("Original text view. Switch to Final text to edit.".into(), theme.info));
        }
        if !editor.tracking && !doc.revisions.is_empty() {
            out.push(banner("Paragraphs with pending revisions are read-only until you accept or reject them, or turn on paragraph text tracking.".into(), theme.info));
        }
        if let Some(error) = &editor.error {
            out.push(
                h_flex()
                    .px_4()
                    .py_1p5()
                    .gap_2()
                    .text_xs()
                    .border_b_1()
                    .border_color(theme.border)
                    .bg(theme.danger.opacity(0.12))
                    .child(div().flex_1().child(error.clone()))
                    .child(Button::new("dismiss-error").xsmall().ghost().label("Dismiss").on_click(cx.listener(|this, _, window, cx| {
                        this.editor.error = None;
                        this.changed(window, cx);
                    })))
                    .into_any_element(),
            );
        }
        out
    }

    fn toolbar(&self, available: &[&'static str], cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let format = self.editor.selection_format();
        let paragraph = self.editor.paragraph(&self.editor.focus.paragraph_id).cloned();
        let button = |id: &'static str, label: &'static str, selected: bool, cx: &mut Context<Self>| {
            Button::new(id).xsmall().ghost().label(label).selected(selected).disabled(!available.contains(&id)).on_click(cx.listener(move |this, _, window, cx| {
                this.command(id, window, cx);
                this.focus.focus(window, cx);
            }))
        };
        let style = paragraph.as_ref().and_then(|p| p.style_id.clone()).unwrap_or_default();
        let list = paragraph.as_ref().and_then(|p| p.list_kind);
        let align = paragraph.as_ref().and_then(|p| p.alignment.clone()).unwrap_or_else(|| "left".into());
        let separator = || div().w(px(1.)).h(px(16.)).mx_1().bg(theme.border);
        h_flex()
            .id("word-toolbar")
            .w_full()
            .flex_wrap()
            .gap_0p5()
            .px_2()
            .py_1()
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.background)
            .child(
                Button::new("word-undo").xsmall().ghost().label("Undo").disabled(!self.editor.can_undo()).on_click(cx.listener(|this, _, window, cx| {
                    this.on_undo(&WordUndo, window, cx);
                })),
            )
            .child(
                Button::new("word-redo").xsmall().ghost().label("Redo").disabled(!self.editor.can_redo()).on_click(cx.listener(|this, _, window, cx| {
                    this.on_redo(&WordRedo, window, cx);
                })),
            )
            .child(separator())
            .child(button("format-bold", "B", format.bold.value() == Some(&true), cx))
            .child(button("format-italic", "I", format.italic.value() == Some(&true), cx))
            .child(button("format-underline", "U", format.underline.value() == Some(&true), cx))
            .child(button("format-clear", "Clear", false, cx))
            .child(button("format-font", "Font…", self.tool == Some(Tool::Font), cx))
            .child(separator())
            .child(button("format-normal", "Normal", style == "Normal", cx))
            .child(button("format-heading-1", "H1", style == "Heading1", cx))
            .child(button("format-heading-2", "H2", style == "Heading2", cx))
            .child(button("format-heading-3", "H3", style == "Heading3", cx))
            .child(separator())
            .child(button("format-bullets", "• List", list == Some(markie_office::model::ListKind::Bullet), cx))
            .child(button("format-numbering", "1. List", list == Some(markie_office::model::ListKind::Numbered), cx))
            .child(separator())
            .child(button("format-align-left", "Left", align == "left", cx))
            .child(button("format-align-center", "Center", align == "center", cx))
            .child(button("format-align-right", "Right", align == "right", cx))
            .child(button("format-align-justify", "Justify", align == "both", cx))
            .child(separator())
            .child(button("insert-picture", "Picture…", self.tool == Some(Tool::Picture), cx))
            .child(button("insert-table", "Table…", self.tool == Some(Tool::Table), cx))
            .child(button("insert-link", "Link…", self.tool == Some(Tool::Link), cx))
            .child(button("insert-page-break", "Break", false, cx))
            .child(button("layout-page-setup", "Page…", self.tool == Some(Tool::Page), cx))
            .child(button("layout-paragraph-spacing", "Spacing…", self.tool == Some(Tool::Spacing), cx))
            .child(button("review-changes", "Review…", self.tool == Some(Tool::Review), cx))
            .child(separator())
            .child(button("view-page", "Page", self.mode == ViewMode::Page, cx))
            .child(button("view-continuous", "Continuous", self.mode == ViewMode::Continuous, cx))
            .child(button("view-outline", "Outline", self.outline, cx))
            .child(
                Button::new("word-paper")
                    .xsmall()
                    .ghost()
                    .label(if self.paper == PaperTone::Light { "Light paper" } else { "Theme paper" })
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.paper = if this.paper == PaperTone::Light { PaperTone::Theme } else { PaperTone::Light };
                        this.changed(window, cx);
                    })),
            )
    }
}

impl Render for WordView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.refresh_images();
        self.building.borrow_mut().clear();
        let theme = cx.theme().clone();
        let colors = self.page_colors(cx);
        let available = available_commands(&self.editor);
        let pages = self.render_pages(&colors, cx);
        let content_width = {
            let doc = self.editor.rich();
            let page = if self.mode == ViewMode::Page { doc.page_layout.width_points as f32 * PX_PER_POINT * self.zoom } else { 0.0 };
            let margin = if doc.comments.is_empty() && doc.revisions.is_empty() { 0.0 } else { 236.0 };
            px(page + margin + 60.0)
        };
        let built = Rc::new(RefCell::new(std::mem::take(&mut *self.building.borrow_mut())));

        // Caret and IME, painted after every paragraph has been prepainted.
        let painted = self.painted.clone();
        let reveal = self.reveal.clone();
        let scroll = self.scroll.clone();
        let viewport = self.scroll.clone();
        let entity = cx.entity();
        let focus = self.focus.clone();
        let focused = self.focus.is_focused(window);
        let caret_paragraph = self.editor.focus.paragraph_id.clone();
        let caret_index = self.display_caret();
        let show_caret = focused && (self.editor.is_collapsed() || self.composition.is_some());
        let caret_color = colors.text;
        let overlay = canvas(
            move |_, window, _| {
                let ready = std::mem::take(&mut *built.borrow_mut());
                *painted.borrow_mut() = ready;
                let caret = painted.borrow().get(&caret_paragraph).map(|p| (caret_point(p, caret_index), p.layout.line_height()));
                if reveal.replace(false)
                    && let Some((point, line_height)) = caret
                {
                    let view = scroll.bounds();
                    let mut offset = scroll.offset();
                    let margin = line_height * 2.0;
                    if point.y < view.top() + margin {
                        offset.y += view.top() + margin - point.y;
                    } else if point.y + line_height > view.bottom() - margin {
                        offset.y -= point.y + line_height - (view.bottom() - margin);
                    }
                    let max = scroll.max_offset();
                    offset.y = offset.y.min(px(0.)).max(-max.y.max(px(0.)));
                    if offset != scroll.offset() {
                        scroll.set_offset(offset);
                        window.request_animation_frame();
                    }
                }
                caret
            },
            move |bounds, caret, window, cx| {
                window.handle_input(&focus, ElementInputHandler::new(bounds, entity), cx);
                if let Some((point, line_height)) = caret
                    && show_caret
                {
                    let view = viewport.bounds();
                    if point.y + line_height >= view.top() && point.y <= view.bottom() {
                        window.paint_quad(fill(Bounds::new(point, size(px(1.5), line_height)), caret_color));
                    }
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let surface = div()
            .id("word-scroll")
            .flex_1()
            .h_full()
            .overflow_scroll()
            .track_scroll(&self.scroll)
            .bg(theme.muted)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, _| this.dragging = false))
            // Rows center with auto margins, which never push a page wider
            // than the window past the left edge; the scroll area grows instead.
            .child(v_flex().min_w_full().w(content_width).gap_6().p(px(30.)).children(pages));

        let editing = div()
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_action(cx.listener(Self::on_copy))
            .on_action(cx.listener(Self::on_cut))
            .on_action(cx.listener(Self::on_paste))
            .on_action(cx.listener(Self::on_select_all))
            .on_action(cx.listener(Self::on_undo))
            .on_action(cx.listener(Self::on_redo));
        let editing = actions::register_commands(editing, &available, cx)
            .relative()
            .flex_1()
            .h_full()
            .min_w_0()
            .flex()
            .flex_col()
            .child(self.toolbar(&available, cx))
            .children(self.banners(cx))
            .child(h_flex().flex_1().min_h_0().when(self.outline, |d| d.child(self.render_outline(cx))).child(surface))
            .child(overlay);

        h_flex()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(editing)
            .when_some(self.tool, |d, tool| d.child(self.render_tool(tool, cx)))
    }
}

impl EntityInputHandler for WordView {
    fn text_for_range(&mut self, range: Range<usize>, adjusted: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let display = self.focus_display();
        let bytes = text::utf16_range_to_utf8(&display, range);
        adjusted.replace(text::utf8_range_to_utf16(&display, bytes.clone()));
        Some(display[bytes].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let display = self.focus_display();
        let selection = self.display_selection();
        let reversed = self.composition.is_none() && !self.editor.is_cross() && self.editor.focus.offset < self.editor.anchor.offset;
        Some(UTF16Selection { range: text::utf8_range_to_utf16(&display, selection), reversed })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        let c = self.composition.as_ref()?;
        let display = self.focus_display();
        Some(text::utf8_range_to_utf16(&display, c.start..c.start + c.text.len()))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            self.commit_composition();
            self.edited(window, cx);
        }
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, new_text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if new_text.chars().all(|c| c.is_control()) && !new_text.is_empty() {
            return;
        }
        if let Some(composition) = self.composition.take() {
            self.commit(composition, Some(new_text));
        } else if !self.editor.can_mutate() {
            return;
        } else if let Some(range) = range {
            let shown = self.focus_display();
            let bytes = text::utf16_range_to_utf8(&shown, range);
            let id = self.editor.focus.paragraph_id.clone();
            self.editor.replace_range(
                TextPosition { paragraph_id: id.clone(), offset: bytes.start },
                TextPosition { paragraph_id: id, offset: bytes.end },
                new_text,
            );
        } else {
            self.editor.replace_selection(new_text);
        }
        self.edited(window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        new_text: &str,
        new_selected: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.editor.can_mutate() {
            return;
        }
        let composition = match self.composition.take() {
            Some(mut c) => {
                c.text = new_text.to_string();
                c
            }
            None => {
                if self.editor.is_cross() {
                    self.editor.error = Some("Composition across paragraphs is not supported. The source and selection were preserved.".into());
                    self.changed(window, cx);
                    return;
                }
                let shown = self.focus_display();
                let bytes = match range {
                    Some(range) => text::utf16_range_to_utf8(&shown, range),
                    None => self.display_selection(),
                };
                Composition { paragraph_id: self.editor.focus.paragraph_id.clone(), start: bytes.start, end: bytes.end, text: new_text.to_string(), selected: None }
            }
        };
        if composition.text.is_empty() {
            // A cancelled composition leaves the document as it was.
            let caret = TextPosition { paragraph_id: composition.paragraph_id, offset: composition.start };
            self.editor.select(caret.clone(), caret);
            self.changed(window, cx);
            return;
        }
        let selected = new_selected.map(|r| text::utf16_range_to_utf8(&composition.text, r));
        self.composition = Some(Composition { selected, ..composition });
        self.changed(window, cx);
    }

    fn bounds_for_range(&mut self, range: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let painted = self.focus_painted()?;
        let display = self.focus_display();
        let bytes = text::utf16_range_to_utf8(&display, range);
        let start = caret_point(&painted, bytes.start);
        let end = caret_point(&painted, bytes.end);
        let line_height = painted.layout.line_height();
        let right = if end.y == start.y && end.x > start.x { end.x } else { start.x + px(1.) };
        Some(Bounds::from_corners(start, point(right, start.y + line_height)))
    }

    fn character_index_for_point(&mut self, position: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let painted = self.focus_painted()?;
        let display = self.focus_display();
        Some(text::utf8_to_utf16(&display, index_at(&painted, position)))
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(text::utf16_len(&self.focus_display()))
    }

    fn accepts_text_input(&self, _: &mut Window, _: &mut Context<Self>) -> bool {
        self.editor.can_mutate()
    }
}
