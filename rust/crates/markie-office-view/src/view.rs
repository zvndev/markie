//! The GPUI Word page view. Paragraphs are `FlowText` runs; their
//! `FlowLayout`s from the last frame answer every caret, click and IME
//! question. The document is one sheet, as in Electron.
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
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_office::model::{Block, Format, ImageType, Paragraph, TextPosition};
use markie_office::rich_document::rich_image_bytes;

use crate::actions::{self, CONTEXT, WordCopy, WordCut, WordFind, WordPaste, WordRedo, WordSelectAll, WordUndo};
use crate::colors::{RunColor, display_run_color};
use crate::commands::{available_commands, menu_commands, run_command};
use crate::editor::{Common, Outcome, Tool, WordEditor};
use crate::icons;
use markie_office::model::RunFormat;
use crate::flow::{FlowAlign, FlowLayout, FlowRun, FlowText};
use crate::layout::{self, Alignment, BreakHint, DEFAULT_FONT, PX_PER_POINT};
use crate::text;

/// Page layout or one continuous sheet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewMode {
    Page,
    Continuous,
}

/// Paper in the theme's colors (the default, as in Electron), or white paper whatever the theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaperTone {
    Light,
    Theme,
}

#[derive(Clone, Debug)]
pub enum WordViewEvent {
    RenderFailed(String),
    /// The document, selection or view changed; the host refreshes its status.
    Changed,
    /// View > Actual Size: the host owns the shared document zoom.
    ZoomReset,
    /// The toolbar's zoom buttons stepped to this zoom.
    Zoom(f32),
}

/// An open toolbar list.
#[derive(Clone, Debug)]
enum Picker {
    Style(Vec<(String, String)>),
    Font(Vec<String>),
    Colour,
}

/// Electron's toolbar text colours: label and hex, `None` for the document color.
const TEXT_COLOURS: [(&str, Option<&str>); 7] = [
    ("Default", None),
    ("Grey", Some("6b7280")),
    ("Red", Some("dc2626")),
    ("Orange", Some("ea580c")),
    ("Green", Some("16a34a")),
    ("Blue", Some("2563eb")),
    ("Purple", Some("7c3aed")),
];

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
    layout: FlowLayout,
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
    pub find: Entity<InputState>,
    pub replace: Entity<InputState>,
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

/// `.docs-word-outline`'s width.
const OUTLINE_WIDTH: f32 = 165.;
/// The outline's buttons take `font: inherit`, so their line height is
/// Tailwind preflight's `line-height: 1.5` on `html`, as is the label's.
const OUTLINE_LINE_HEIGHT: f32 = 1.5;

pub struct WordView {
    pub editor: WordEditor,
    pub(crate) focus: FocusHandle,
    scroll: ScrollHandle,
    pub mode: ViewMode,
    pub outline: bool,
    pub zoom: f32,
    pub paper: PaperTone,
    pub(crate) tool: Option<Tool>,
    menu_suspended: bool,
    pub(crate) inputs: Inputs,
    pub(crate) find_index: usize,
    pub(crate) find_receipt: Option<String>,
    _find_subscriptions: [Subscription; 2],
    /// The toolbar's font-size field (Electron's `<input type=number>`).
    size_field: Entity<InputState>,
    _size_sub: Subscription,
    /// Layouts being built by this render, and the ones the last frame painted.
    building: RefCell<HashMap<String, Painted>>,
    painted: Rc<RefCell<HashMap<String, Painted>>>,
    composition: Option<Composition>,
    dragging: bool,
    goal_x: Option<Pixels>,
    reveal: Rc<Cell<bool>>,
    images: HashMap<String, Arc<Image>>,
    /// The toolbar's width last frame, for moving groups into More.
    toolbar_width: Rc<Cell<f32>>,
    overflow_open: bool,
    picker: Option<(Picker, Point<Pixels>)>,
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

fn flow_align(alignment: Alignment) -> FlowAlign {
    match alignment {
        Alignment::Center => FlowAlign::Center,
        Alignment::Right => FlowAlign::Right,
        Alignment::Justify => FlowAlign::Justify,
        Alignment::Left => FlowAlign::Left,
    }
}

/// Where the caret before byte `index` is drawn, in window coordinates.
fn caret_point(painted: &Painted, index: usize) -> Point<Pixels> {
    painted.layout.caret(index).0
}

/// The byte index nearest a window point.
fn index_at(painted: &Painted, position: Point<Pixels>) -> usize {
    painted.layout.index_at(position)
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
            find: input("Case-sensitive text"),
            replace: input("Replacement text"),
        };
        let find = cx.subscribe(&inputs.find, |this: &mut WordView, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.find_index = 0;
                this.find_receipt = None;
                cx.notify();
            }
        });
        let replace = cx.subscribe(&inputs.replace, |this: &mut WordView, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.find_receipt = None;
                cx.notify();
            }
        });
        let mode = if editor.is_docx() { ViewMode::Page } else { ViewMode::Continuous };
        let size_field = cx.new(|cx| InputState::new(window, cx).placeholder("Auto"));
        // As Electron's onChange: a valid size applies as it is typed.
        let size_sub = cx.subscribe_in(&size_field, window, |this: &mut WordView, field, ev: &InputEvent, window, cx| {
            if !matches!(ev, InputEvent::Change) || !field.read(cx).focus_handle(cx).is_focused(window) {
                return;
            }
            if let Some(points) = parse_size(field.read(cx).value().as_ref()) {
                if this.editor.selection_format().font_size_points.value() != Some(&Some(points)) {
                    this.set_size(points, window, cx);
                }
            }
        });
        WordView {
            editor,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            mode,
            outline: false,
            zoom: 1.0,
            paper: PaperTone::Theme,
            tool: None,
            menu_suspended: false,
            inputs,
            find_index: 0,
            find_receipt: None,
            _find_subscriptions: [find, replace],
            size_field,
            _size_sub: size_sub,
            building: RefCell::new(HashMap::new()),
            painted: Rc::new(RefCell::new(HashMap::new())),
            composition: None,
            dragging: false,
            goal_x: None,
            reveal: Rc::new(Cell::new(false)),
            images: HashMap::new(),
            toolbar_width: Rc::new(Cell::new(0.0)),
            overflow_open: false,
            picker: None,
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
            "find" => self.open_tool(Tool::Find, window, cx),
            "view-page" => self.mode = ViewMode::Page,
            "view-continuous" => self.mode = ViewMode::Continuous,
            "view-outline" => self.outline = !self.outline,
            // Kirby's choice: paper follows the theme, as in Electron, with
            // white paper one menu item away.
            "view-light-paper" => self.paper = if self.paper == PaperTone::Light { PaperTone::Theme } else { PaperTone::Light },
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

    pub fn set_menu_suspended(&mut self, suspended: bool, cx: &mut Context<Self>) {
        if self.menu_suspended != suspended {
            self.menu_suspended = suspended;
            cx.notify();
        }
    }

    pub fn palette_commands(&self) -> Vec<&'static str> {
        if self.tool.is_some() {
            return Vec::new();
        }
        let mut commands = available_commands(&self.editor);
        commands.push("find");
        commands
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
        Some(painted.layout.caret(self.display_caret()))
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
        let offset = painted.layout.line_edge(self.editor.focus.offset, end);
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
    fn text_runs(&self, paragraph: &Paragraph, display: &str, colors: &PageColors) -> Vec<FlowRun> {
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
                let points = look.as_ref().map_or(layout::DEFAULT_SIZE_POINTS, |l| l.size_points);
                out.push(FlowRun { run: self.text_run(to - from, look.as_ref(), marked, selected, colors), size: px(points as f32 * PX_PER_POINT * self.zoom) });
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
    /// `collapse` is the space the previous sibling already left below
    /// itself: CSS collapses adjacent vertical margins, so only the excess of
    /// this paragraph's space before is added.
    pub(crate) fn paragraph_element(&self, paragraph: &Paragraph, colors: &PageColors, collapse: Pixels) -> AnyElement {
        self.paragraph_with_break(paragraph, colors, collapse, BreakHint::default())
    }

    /// A paragraph with Electron's page-break marker inside it: the marker
    /// is a block inside the run, so a break at the end of the text leaves
    /// the marker and then an empty line before the paragraph's space after.
    fn paragraph_with_break(&self, paragraph: &Paragraph, colors: &PageColors, collapse: Pixels, hint: BreakHint) -> AnyElement {
        let zoom = self.zoom;
        let look = layout::paragraph_look(paragraph);
        let display = self.display_text(paragraph);
        let runs = self.text_runs(paragraph, &display, colors);
        // Electron's paragraph box is Georgia 12 pt; runs set their own size
        // and the box's line height is the strut every line keeps.
        let size = px(layout::DEFAULT_SIZE_POINTS as f32 * PX_PER_POINT * zoom);
        let multiple = look.line_multiple as f32;
        let line_height = size * multiple;
        let strut = TextRun { len: 1, font: font(DEFAULT_FONT), color: colors.text, background_color: None, underline: None, strikethrough: None };
        let flow = FlowText::new(display, runs, flow_align(look.alignment), multiple, strut, size);
        self.building.borrow_mut().insert(paragraph.id.clone(), Painted { layout: flow.layout().clone() });
        let before = (px(look.before_points as f32 * PX_PER_POINT * zoom) - collapse).max(px(0.));
        let after = px(look.after_points as f32 * PX_PER_POINT * zoom);
        let indent = px(look.indent_px * zoom);
        let marker_left = if look.marker.as_deref() == Some("•") { px(19.) } else { px(24.) } * zoom;
        div()
            .w_full()
            .relative()
            .pt(before)
            .pb(after)
            .pl(indent)
            .when_some(look.marker, |d, marker| {
                d.child(
                    div()
                        .absolute()
                        .top(before)
                        .left(indent - marker_left)
                        .text_size(size)
                        .line_height(line_height)
                        .font_family(DEFAULT_FONT)
                        .text_color(colors.text)
                        .child(marker),
                )
            })
            .when(hint.before, |d| d.child(self.break_marker(colors)))
            .child(div().w_full().min_h(size * 1.4).child(flow))
            .when(hint.after, |d| d.child(self.break_marker(colors)).child(div().h(line_height)))
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

    /// The space a paragraph leaves below itself, for margin collapsing.
    fn after_px(&self, paragraph: &Paragraph) -> Pixels {
        px(layout::paragraph_look(paragraph).after_points as f32 * PX_PER_POINT * self.zoom)
    }

    /// Electron's `.docs-page-break-marker`: a dashed rule labelled "Page break".
    fn break_marker(&self, colors: &PageColors) -> AnyElement {
        div()
            .w_full()
            .h(px(20. * self.zoom))
            .my(px(10. * self.zoom))
            .border_t_1()
            .border_dashed()
            .border_color(colors.muted)
            .text_size(px(9.))
            .line_height(px(12.))
            .text_center()
            .text_color(colors.muted)
            .child("Page break")
            .into_any_element()
    }

    /// A block: a paragraph with its pictures and break marker, or a table.
    /// Returns the element and the space it leaves below itself.
    fn block_element(&self, block: &Block, hint: BreakHint, collapse: Pixels, colors: &PageColors, cx: &mut Context<Self>) -> (AnyElement, Pixels) {
        let zoom = self.zoom;
        let doc = self.editor.rich();
        match block {
            Block::Paragraph(id) => {
                let Some(paragraph) = doc.paragraph(id) else { return (div().into_any_element(), collapse) };
                let pictures: Vec<(String, f64, f64)> = if doc.format == Format::Docx {
                    doc.images.iter().filter(|i| &i.paragraph_id == id).map(|i| (i.id.clone(), i.width_points, i.height_points)).collect()
                } else {
                    Vec::new()
                };
                let show_text = pictures.is_empty() || !paragraph.text.is_empty() || !paragraph.runs.iter().all(|r| r.page_breaks.is_empty());
                let collapse = if pictures.is_empty() { collapse } else { px(0.) };
                let element = v_flex()
                    .w_full()
                    .children(pictures.iter().map(|(pid, w, h)| self.picture_element(pid, *w, *h, colors, cx)))
                    .when(show_text, |d| d.child(self.paragraph_with_break(paragraph, colors, collapse, hint)))
                    .when(!show_text && (hint.before || hint.after), |d| d.child(self.break_marker(colors)))
                    .into_any_element();
                let after = if show_text { self.after_px(paragraph) } else { px(0.) };
                (element, after)
            }
            Block::Table(id) => {
                let Some(table) = doc.tables.iter().find(|t| &t.id == id) else { return (div().into_any_element(), collapse) };
                let cell_pad = px(7. * zoom);
                let element = v_flex()
                    .w_full()
                    .border_l_1()
                    .border_t_1()
                    .border_color(colors.rule)
                    .children(table.rows.iter().map(|row| {
                        h_flex().w_full().items_stretch().children(row.cells.iter().map(|cell| {
                            let mut previous = px(0.);
                            v_flex()
                                .flex_1()
                                .min_w(px(60. * zoom))
                                .border_r_1()
                                .border_b_1()
                                .border_color(colors.rule)
                                .p(cell_pad)
                                .children(cell.paragraph_ids.iter().filter_map(|pid| doc.paragraph(pid)).map(|p| {
                                    let element = self.paragraph_element(p, colors, previous);
                                    previous = self.after_px(p);
                                    element
                                }))
                        }))
                    }))
                    .into_any_element();
                (element, px(0.))
            }
        }
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

    /// The document on one sheet, as Electron draws it: the paper size,
    /// margins and shadow in Page view, a 960 px column in Continuous view.
    /// Explicit page breaks show as markers; the sheet is never split.
    fn render_sheet(&self, colors: &PageColors, cx: &mut Context<Self>) -> AnyElement {
        let doc = self.editor.rich().clone();
        let zoom = self.zoom;
        let scale = PX_PER_POINT * zoom;
        let theme = cx.theme().clone();
        let mut collapse = px(0.);
        let blocks: Vec<AnyElement> = doc
            .blocks
            .iter()
            .map(|block| {
                let (element, after) = self.block_element(block, layout::break_hint(&doc, block), collapse, colors, cx);
                collapse = after;
                element
            })
            .collect();
        let content = v_flex().w_full().children(blocks);
        let l = doc.page_layout;
        match self.mode {
            ViewMode::Page => div()
                .flex_none()
                .mx_auto()
                .bg(colors.paper)
                .border_1()
                .border_color(theme.border)
                .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.133), offset: point(px(0.), px(1.)), blur_radius: px(7.), spread_radius: px(0.), inset: false }])
                .w(px(l.width_points as f32 * scale))
                .min_h(px(l.height_points as f32 * scale))
                .pt(px(l.margin_top_points as f32 * scale))
                .pr(px(l.margin_right_points as f32 * scale))
                .pb(px(l.margin_bottom_points as f32 * scale))
                .pl(px(l.margin_left_points as f32 * scale))
                .child(content)
                .into_any_element(),
            ViewMode::Continuous => {
                div().w_full().max_w(px(960. * zoom)).flex_1().mx_auto().bg(colors.paper).p(px(32. * zoom)).child(content).into_any_element()
            }
        }
    }

    /// Electron's `.docs-word-outline` (`document-workspace.css`): 165 px
    /// on the surface colour, padding 18 by 10, a 10 px muted label with
    /// 10 below it, then one 11 px button per heading at full width with
    /// the workspace buttons' 6 by 9 padding, 1 px transparent border and
    /// 6 px corners. Every level sits at the same indent, and no headings
    /// shows only the label.
    fn render_outline(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let headings: Vec<(String, String)> = self
            .editor
            .rich()
            .paragraphs
            .iter()
            .filter(|p| layout::is_heading(p))
            .map(|p| (p.id.clone(), if p.text.is_empty() { "Empty heading".into() } else { p.text.clone() }))
            .collect();
        v_flex()
            .id("word-outline")
            .w(px(OUTLINE_WIDTH))
            .h_full()
            .flex_none()
            .overflow_y_scroll()
            .border_r_1()
            .border_color(theme.border)
            .bg(theme.muted)
            .px(px(10.))
            .py(px(18.))
            .child(
                div()
                    .text_size(px(10.))
                    .line_height(px(10. * OUTLINE_LINE_HEIGHT))
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme.muted_foreground)
                    .mb(px(10.))
                    .child("Outline"),
            )
            .children(headings.into_iter().enumerate().map(|(i, (id, label))| {
                div()
                    .id(("outline", i))
                    .w_full()
                    .px(px(9.))
                    .py(px(6.))
                    .border_1()
                    .border_color(transparent_black())
                    .rounded(px(6.))
                    .text_size(px(11.))
                    .line_height(px(11. * OUTLINE_LINE_HEIGHT))
                    .text_color(theme.foreground)
                    .cursor_pointer()
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

    /// Electron's banners in its order: `.docs-tracking-banner` notes in the
    /// status blue, then `.docs-warning` in yellow and `.docs-error` in red,
    /// both on the surface color.
    fn banners(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = cx.theme().clone();
        let note = |text: String| {
            div().px(px(16.)).py(px(7.)).text_size(px(11.)).border_b_1().border_color(theme.border).text_color(theme.info).child(text).into_any_element()
        };
        let strip = |color: Hsla| div().px(px(20.)).py(px(10.)).text_size(px(12.)).line_height(px(19.2)).border_b_1().border_color(theme.border).bg(theme.muted).text_color(color);
        let editor = &self.editor;
        let doc = editor.rich();
        let mut out = Vec::new();
        if editor.tracking {
            let author = if editor.review_author.trim().is_empty() { "an author is required".to_string() } else { editor.review_author.clone() };
            out.push(note(format!("Tracking paragraph text as {author}. Formatting, layout and inserted content are not tracked.")));
        }
        if editor.original_view {
            out.push(note("Original text view. Switch to Final text to edit.".into()));
        }
        if !editor.tracking && !doc.revisions.is_empty() {
            out.push(note("Paragraphs with pending revisions are read-only until you accept/reject them or enable same-author paragraph tracking.".into()));
        }
        if !doc.can_edit && !editor.host_read_only {
            let name = if doc.format == Format::Docx { "Word".to_string() } else { format!("{:?}", doc.format).to_uppercase() };
            // Electron offers Export here; Markie RS has no export yet, and
            // Save never writes a read-only document.
            out.push(strip(theme.warning).child(format!("Read-only to protect unsupported {name} features. Saving keeps the unchanged original.")).into_any_element());
        }
        if let Some(error) = &editor.error {
            out.push(
                strip(theme.danger)
                    .flex()
                    .items_center()
                    .gap(px(12.))
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

    /// Electron's zoom presets: one step at a time from the nearest preset.
    fn step_zoom(&mut self, direction: i32, cx: &mut Context<Self>) {
        const STEPS: [f32; 8] = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];
        let nearest = (0..STEPS.len()).min_by(|a, b| (STEPS[*a] - self.zoom).abs().total_cmp(&(STEPS[*b] - self.zoom).abs())).unwrap_or(3);
        let next = STEPS[(nearest as i32 + direction).clamp(0, STEPS.len() as i32 - 1) as usize];
        self.zoom = next;
        cx.emit(WordViewEvent::Zoom(next));
        cx.notify();
    }

    /// The field shows the selection's size, or empty under its Auto or
    /// Mixed placeholder, unless the person is typing in it.
    fn sync_size_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.size_field.read(cx).focus_handle(cx).is_focused(window) {
            return;
        }
        let format = self.editor.selection_format();
        let (value, placeholder) = match &format.font_size_points {
            Common::Value(Some(points)) => (trim_size(*points), "Auto"),
            Common::Mixed => (String::new(), "Mixed"),
            _ => (String::new(), "Auto"),
        };
        self.size_field.update(cx, |field, cx| {
            if field.value().as_ref() as &str != value.as_str() {
                field.set_value(value, window, cx);
            }
            field.set_placeholder(placeholder, window, cx);
        });
    }

    fn set_size(&mut self, points: f64, window: &mut Window, cx: &mut Context<Self>) {
        if (1.0..=400.0).contains(&points) {
            self.editor.format_selection(RunFormat { font_size_points: Some(Some(points)), ..Default::default() });
        }
        self.edited(window, cx);
    }

    fn open_picker(&mut self, picker: Picker, position: Point<Pixels>, _: &mut Window, cx: &mut Context<Self>) {
        self.picker = Some((picker, position));
        cx.notify();
    }

    fn pick(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some((picker, _)) = self.picker.take() else { return };
        match picker {
            Picker::Style(styles) => {
                if let Some((id, _)) = styles.get(index) {
                    self.editor.set_paragraph_style((!id.is_empty()).then_some(id.as_str()));
                }
            }
            Picker::Font(fonts) => {
                let family = if index == 0 { None } else { fonts.get(index - 1).cloned() };
                self.editor.format_selection(RunFormat { font_family: Some(family), ..Default::default() });
            }
            Picker::Colour => {
                if let Some((_, color)) = TEXT_COLOURS.get(index) {
                    self.editor.format_selection(RunFormat { color: Some(color.map(str::to_string)), ..Default::default() });
                }
            }
        }
        self.focus.focus(window, cx);
        self.edited(window, cx);
    }

    /// The open style, font or color list, under the pointer like a native select.
    fn render_picker(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (picker, position) = self.picker.as_ref()?;
        let theme = cx.theme().clone();
        let format = self.editor.selection_format();
        let items: Vec<(String, bool)> = match picker {
            Picker::Style(styles) => {
                let current = self.editor.paragraph(&self.editor.focus.paragraph_id).and_then(|p| p.style_id.clone()).unwrap_or_default();
                styles.iter().map(|(id, label)| (label.clone(), *id == current)).collect()
            }
            Picker::Font(fonts) => {
                let current = format.font_family.value().cloned().flatten();
                let placeholder = if format.font_family == Common::Mixed { "Mixed fonts" } else { "Inherited font" };
                std::iter::once((placeholder.to_string(), current.is_none())).chain(fonts.iter().map(|f| (f.clone(), current.as_deref() == Some(f)))).collect()
            }
            Picker::Colour => TEXT_COLOURS.iter().map(|(label, _)| (label.to_string(), false)).collect(),
        };
        Some(
            deferred(
                anchored().position(*position).snap_to_window_with_margin(px(8.)).child(
                    v_flex()
                        .id("word-picker")
                        .occlude()
                        .min_w(px(160.))
                        .max_h(px(360.))
                        .overflow_y_scroll()
                        .p(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .shadow_lg()
                        .text_size(px(12.))
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.picker = None;
                            cx.notify();
                        }))
                        .children(items.into_iter().enumerate().map(|(index, (label, checked))| {
                            h_flex()
                                .id(("word-pick", index))
                                .gap(px(6.))
                                .px(px(8.))
                                .py(px(3.))
                                .rounded(px(4.))
                                .hover(|s| s.bg(theme.accent))
                                .child(div().w(px(12.)).child(if checked { "✓" } else { "" }))
                                .child(label)
                                .on_click(cx.listener(move |this, _, window, cx| this.pick(index, window, cx)))
                        })),
                ),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }

    /// Electron's `FormattingToolbar` as the Word editor configures it: the
    /// page setup and spacing buttons, history, zoom, style and font
    /// pickers, size, marks, color, insert, lists, alignment and clear. Groups
    /// that do not fit move into the More menu in Electron's order.
    fn toolbar(&self, available: &[&'static str], cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let format = self.editor.selection_format();
        let caps = self.editor.capabilities();
        let docx = self.editor.is_docx();
        let editable = self.editor.can_mutate();
        let can_format = self.editor.can_format_runs() && self.tool.is_none();
        let paragraph = self.editor.paragraph(&self.editor.focus.paragraph_id).cloned();
        let list = paragraph.as_ref().and_then(|p| p.list_kind);
        let align = paragraph.as_ref().and_then(|p| p.alignment.clone()).unwrap_or_else(|| "left".into());
        let can_paragraph = available.contains(&"format-align-left");
        let width = self.toolbar_width.get();

        // Group widths and the fitting rule from formatting-toolbar.tsx.
        let start_width = if caps.page_layout || caps.paragraph_formatting { 60.0 + 2.0 } else { 0.0 };
        let groups: [(&str, f32); 9] = [
            ("selectors", if docx { 114.0 } else { 0.0 } + 106.0),
            ("colour", 40.0),
            ("lists", if docx { 60.0 } else { 0.0 }),
            ("alignment", 90.0),
            ("history", 60.0),
            ("insert", if docx { 60.0 } else { 0.0 }),
            ("clear", 30.0),
            ("size", 60.0),
            ("view", 100.0),
        ];
        let primary = 40.0 + 90.0;
        let full = 16.0 + start_width + primary + groups.iter().map(|g| g.1).sum::<f32>() + if docx { 64.0 } else { 36.0 } + 60.0;
        let compact = width > 0.0 && width < full;
        let primary_over = compact && width - 16.0 - start_width - 30.0 < primary;
        let mut room = width - 16.0 - start_width - if primary_over { 0.0 } else { primary } - 30.0;
        let mut over: Vec<&str> = Vec::new();
        if compact {
            for (name, size) in groups {
                if size <= room {
                    room -= size;
                } else {
                    over.push(name);
                }
            }
        }
        let over = |name: &str| over.contains(&name);
        let in_menu = |name: &str| if name == "primary" { primary_over } else { over(name) };

        let fg = theme.foreground;
        let muted = theme.muted_foreground;
        let hover = theme.accent.opacity(0.4);
        let active_bg = theme.accent;
        let button = |id: &'static str, icon: Option<&'static [u8]>, glyph: Option<AnyElement>, label: &'static str, active: bool, enabled: bool, menu: bool| {
            div()
                .id(id)
                .h(px(28.))
                .min_w(px(28.))
                .px(px(6.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .rounded(px(4.))
                .text_size(px(11.))
                .text_color(if active { fg } else { muted })
                .when(active, |d| d.bg(active_bg))
                .when(enabled && !active, |d| d.hover(move |s| s.bg(hover).text_color(fg)))
                .when(!enabled, |d| d.opacity(0.35))
                .when_some(icon, |d, bytes| d.child(svg().data(bytes).size(px(15.)).flex_none().text_color(if active { fg } else { muted })))
                .children(glyph)
                .when(menu, |d| d.child(label))
                .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
        };
        let command = |this: &mut Self, id: &'static str, window: &mut Window, cx: &mut Context<Self>| {
            this.overflow_open = false;
            this.command(id, window, cx);
            this.focus.focus(window, cx);
        };
        let action = |id: &'static str, icon: &'static [u8], label: &'static str, active: bool, menu: bool, cx: &mut Context<Self>| {
            let enabled = available.contains(&id);
            button(id, Some(icon), None, label, active, enabled, menu).when(enabled, |d| d.on_click(cx.listener(move |this, _, window, cx| command(this, id, window, cx))))
        };
        let divider = || div().w(px(1.)).h(px(20.)).mx(px(4.)).flex_none().bg(theme.border);
        let mark = |text: &'static str, weight: FontWeight, italic: bool, underline: bool| {
            div()
                .text_size(px(13.))
                .font_weight(weight)
                .when(italic, |d| d.italic().font_family("Georgia"))
                .when(underline, |d| d.underline())
                .child(text)
                .into_any_element()
        };
        // Electron dims a disabled style picker, but not the font picker or
        // the size field: their classes have no disabled opacity.
        let field = |id: &'static str, width: f32, label: String, placeholder: bool, dim: bool| {
            div()
                .id(id)
                .w(px(width))
                .h(px(28.))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(4.))
                .pl(px(6.))
                .pr(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(theme.border)
                .bg(theme.background)
                .text_size(px(11.))
                .text_color(if placeholder { muted } else { fg })
                .when(dim, |d| d.opacity(0.35))
                .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(label))
                .child(svg().data(icons::CHEVRON).size(px(12.)).flex_none().text_color(fg))
        };

        // Each group as a list of elements, in render order.
        let mut row: Vec<(&str, AnyElement)> = Vec::new();
        let weak = cx.entity().downgrade();
        if caps.page_layout {
            let enabled = self.tool.map_or(available.contains(&"layout-page-setup"), |t| t == Tool::Page);
            row.push((
                "start",
                button("word-page-setup", Some(icons::PAGE_SETUP), None, "Page setup", self.tool == Some(Tool::Page), enabled, false)
                    .when(enabled, |d| {
                        d.on_click(cx.listener(|this, _, window, cx| {
                            if this.tool == Some(Tool::Page) { this.tool = None; this.changed(window, cx) } else { this.command("layout-page-setup", window, cx) }
                        }))
                    })
                    .into_any_element(),
            ));
        }
        if caps.paragraph_formatting {
            let enabled = self.tool.map_or(available.contains(&"layout-paragraph-spacing"), |t| t == Tool::Spacing);
            row.push((
                "start",
                button("word-spacing", Some(icons::SPACING), None, "Paragraph spacing", self.tool == Some(Tool::Spacing), enabled, false)
                    .when(enabled, |d| {
                        d.on_click(cx.listener(|this, _, window, cx| {
                            if this.tool == Some(Tool::Spacing) { this.tool = None; this.changed(window, cx) } else { this.command("layout-paragraph-spacing", window, cx) }
                        }))
                    })
                    .into_any_element(),
            ));
        }
        let menu = in_menu("history");
        let undo = editable && self.editor.can_undo();
        let redo = editable && self.editor.can_redo();
        row.push(("history", button("word-undo", Some(icons::UNDO), None, "Undo", false, undo, menu).when(undo, |d| d.on_click(cx.listener(|this, _, window, cx| this.on_undo(&WordUndo, window, cx)))).into_any_element()));
        row.push(("history", button("word-redo", Some(icons::REDO), None, "Redo", false, redo, menu).when(redo, |d| d.on_click(cx.listener(|this, _, window, cx| this.on_redo(&WordRedo, window, cx)))).into_any_element()));
        if !compact {
            row.push(("history", divider().into_any_element()));
        }
        let menu = in_menu("view");
        row.push(("view", button("word-zoom-out", Some(icons::ZOOM_OUT), None, "Zoom out", false, true, menu).on_click(cx.listener(|this, _, _, cx| this.step_zoom(-1, cx))).into_any_element()));
        row.push(("view", div().w(px(38.)).flex_none().text_center().text_size(px(11.)).text_color(muted).child(format!("{}%", (self.zoom * 100.0).round())).into_any_element()));
        row.push(("view", button("word-zoom-in", Some(icons::ZOOM_IN), None, "Zoom in", false, true, menu).on_click(cx.listener(|this, _, _, cx| this.step_zoom(1, cx))).into_any_element()));
        if !compact {
            row.push(("view", divider().into_any_element()));
        }
        let selector_width = if compact { 112.0 } else { 140.0 };
        if docx {
            let style_id = paragraph.as_ref().and_then(|p| p.style_id.clone()).unwrap_or_default();
            let mut styles: Vec<(String, String)> = vec![
                (String::new(), "Default paragraph".into()),
                ("Normal".into(), "Normal".into()),
                ("Heading1".into(), "Heading 1".into()),
                ("Heading2".into(), "Heading 2".into()),
                ("Heading3".into(), "Heading 3".into()),
            ];
            for style in &self.editor.rich().styles {
                let label = if style.name.is_empty() { style.id.clone() } else { style.name.clone() };
                match styles.iter_mut().find(|(id, _)| *id == style.id) {
                    Some(entry) => entry.1 = label,
                    None => styles.push((style.id.clone(), label)),
                }
            }
            if !styles.iter().any(|(id, _)| *id == style_id) {
                styles.push((style_id.clone(), style_id.clone()));
            }
            let label = styles.iter().find(|(id, _)| *id == style_id).map(|s| s.1.clone()).unwrap_or_default();
            let enabled = can_paragraph && caps.named_styles && self.tool.is_none();
            let weak = weak.clone();
            row.push((
                "selectors",
                field("word-style", if compact { 112.0 } else { 140.0 }, label, false, !enabled)
                    .when(enabled, |d| {
                        d.on_click(move |event, window, cx| {
                            let styles = styles.clone();
                            let weak = weak.clone();
                            let position = event.position();
                            window.defer(cx, move |window, cx| {
                                if let Some(view) = weak.upgrade() {
                                    view.update(cx, |this, cx| this.open_picker(Picker::Style(styles), position, window, cx));
                                }
                            });
                        })
                    })
                    .into_any_element(),
            ));
        }
        let fonts: Vec<String> = {
            let mut fonts: Vec<String> = ["Arial", "Calibri", "Georgia", "Times New Roman", "Helvetica"].map(String::from).to_vec();
            for paragraph in &self.editor.rich().paragraphs {
                for run in &paragraph.runs {
                    if let Some(family) = run.resolved_style.as_ref().unwrap_or(&run.style).font_family.clone()
                        && !fonts.contains(&family)
                    {
                        fonts.push(family);
                    }
                }
            }
            fonts
        };
        let (font_label, font_placeholder) = match &format.font_family {
            Common::Mixed => ("Mixed fonts".to_string(), true),
            Common::Value(Some(family)) => (family.clone(), false),
            _ => ("Inherited font".to_string(), true),
        };
        {
            let weak = weak.clone();
            row.push((
                "selectors",
                field("word-font", selector_width, font_label, font_placeholder, false)
                    .when(can_format, |d| {
                        d.on_click(move |event, window, cx| {
                            let fonts = fonts.clone();
                            let weak = weak.clone();
                            let position = event.position();
                            window.defer(cx, move |window, cx| {
                                if let Some(view) = weak.upgrade() {
                                    view.update(cx, |this, cx| this.open_picker(Picker::Font(fonts), position, window, cx));
                                }
                            });
                        })
                    })
                    .into_any_element(),
            ));
        }
        let size = match &format.font_size_points {
            Common::Value(Some(points)) => Some(*points),
            _ => None,
        };
        let size_tip = "Size of the selected text";
        let menu = in_menu("size");
        let smaller = can_format && size.is_some_and(|s| s > 1.0);
        let larger = can_format && size.is_some_and(|s| s < 400.0);
        row.push((
            "size",
            button("word-size-down", Some(icons::MINUS), None, "Decrease font size", false, smaller, menu)
                .when(smaller, |d| d.on_click(cx.listener(move |this, _, window, cx| this.set_size(size.unwrap_or(12.0) - 1.0, window, cx))))
                .into_any_element(),
        ));
        row.push((
            "primary",
            // `markie-overlay-field text-[11px] h-7 w-[38px] text-center`.
            div()
                .id("word-size-field")
                .w(px(38.))
                .h(px(28.))
                .flex_none()
                .rounded(px(6.))
                .border_1()
                .border_color(theme.border)
                .bg(theme.background)
                .text_size(px(11.))
                .text_color(if size.is_some() { fg } else { muted })
                .when(!can_format, |d| d.opacity(0.5))
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(size_tip).build(window, cx))
                .child(Input::new(&self.size_field).appearance(false).xsmall().text_center().disabled(!can_format))
                .into_any_element(),
        ));
        row.push((
            "size",
            button("word-size-up", Some(icons::PLUS), None, "Increase font size", false, larger, menu)
                .when(larger, |d| d.on_click(cx.listener(move |this, _, window, cx| this.set_size(size.unwrap_or(12.0) + 1.0, window, cx))))
                .into_any_element(),
        ));
        if !compact {
            row.push(("size", divider().into_any_element()));
        }
        let menu = in_menu("primary");
        for (id, glyph, label, active) in [
            ("format-bold", mark("B", FontWeight::BOLD, false, false), "Bold", format.bold.value() == Some(&true)),
            ("format-italic", mark("I", FontWeight::NORMAL, true, false), "Italic", format.italic.value() == Some(&true)),
            ("format-underline", mark("U", FontWeight::NORMAL, false, true), "Underline", format.underline.value() == Some(&true)),
        ] {
            let enabled = can_format;
            row.push(("primary", button(id, None, Some(glyph), label, active, enabled, menu).when(enabled, |d| d.on_click(cx.listener(move |this, _, window, cx| command(this, id, window, cx)))).into_any_element()));
        }
        {
            let weak = weak.clone();
            row.push((
                "colour",
                button("word-colour", None, Some(h_flex().gap(px(2.)).child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child("A")).child(div().text_size(px(10.)).child("▾")).into_any_element()), "Text colour", false, can_format, in_menu("colour"))
                    .when(can_format, |d| {
                        d.on_click(move |event, window, cx| {
                            let weak = weak.clone();
                            let position = event.position();
                            window.defer(cx, move |window, cx| {
                                if let Some(view) = weak.upgrade() {
                                    view.update(cx, |this, cx| this.open_picker(Picker::Colour, position, window, cx));
                                }
                            });
                        })
                    })
                    .into_any_element(),
            ));
        }
        if docx {
            if !compact {
                row.push(("insert", divider().into_any_element()));
            }
            let menu = in_menu("insert");
            row.push(("insert", action("insert-link", icons::LINK, "Insert link", false, menu, cx).into_any_element()));
            row.push(("insert", action("insert-picture", icons::IMAGE, "Insert image", false, menu, cx).into_any_element()));
        }
        if !compact {
            row.push(("lists", divider().into_any_element()));
        }
        if docx {
            let menu = in_menu("lists");
            row.push(("lists", action("format-bullets", icons::BULLETS, "Bullet list", list == Some(markie_office::model::ListKind::Bullet), menu, cx).into_any_element()));
            row.push(("lists", action("format-numbering", icons::NUMBERED, "Numbered list", list == Some(markie_office::model::ListKind::Numbered), menu, cx).into_any_element()));
        }
        let menu = in_menu("alignment");
        row.push(("alignment", action("format-align-left", icons::ALIGN_LEFT, "Align left", align == "left", menu, cx).into_any_element()));
        row.push(("alignment", action("format-align-center", icons::ALIGN_CENTER, "Align centre", align == "center", menu, cx).into_any_element()));
        row.push(("alignment", action("format-align-right", icons::ALIGN_RIGHT, "Align right", align == "right", menu, cx).into_any_element()));
        if !compact {
            row.push(("clear", divider().into_any_element()));
        }
        row.push(("clear", action("format-clear", icons::CLEAR, "Clear formatting", false, in_menu("clear"), cx).into_any_element()));

        let mut shown = Vec::new();
        let mut hidden: Vec<(&str, Vec<AnyElement>)> = Vec::new();
        for (group, element) in row {
            if group != "start" && in_menu(group) {
                match hidden.iter_mut().find(|(g, _)| *g == group) {
                    Some((_, items)) => items.push(element),
                    None => hidden.push((group, vec![element])),
                }
            } else {
                shown.push(element);
            }
        }
        let measure = self.toolbar_width.clone();
        h_flex()
            .id("word-toolbar")
            .relative()
            .w_full()
            .min_w_0()
            .flex_none()
            .gap(px(2.))
            .px(px(8.))
            .py(px(4.))
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.muted)
            .child(
                canvas(
                    move |bounds, window, _| {
                        let width = f32::from(bounds.size.width);
                        if (measure.get() - width).abs() > 0.5 {
                            measure.set(width);
                            window.refresh();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .children(shown)
            .when(compact, |d| {
                d.child(button("word-more", Some(icons::MORE), None, "More formatting", self.overflow_open, true, false).on_click(cx.listener(|this, _, _, cx| {
                    this.overflow_open = !this.overflow_open;
                    cx.notify();
                })))
            })
            .when(compact && self.overflow_open, |d| {
                d.child(
                    deferred(
                        v_flex()
                            .id("word-more-menu")
                            .occlude()
                            .absolute()
                            .right(px(8.))
                            .top(px(40.))
                            .w(px(320.))
                            .p(px(4.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.secondary)
                            .shadow_lg()
                            .children(hidden.into_iter().map(|(_, items)| {
                                h_flex().flex_wrap().gap(px(4.)).p(px(4.)).border_b_1().border_color(theme.border).children(items)
                            })),
                    )
                    .with_priority(1),
                )
            })
    }

}

impl Render for WordView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        markie_core::render_boundary::project(|| self.project_document(window, cx).into_any_element())
            .unwrap_or_else(|detail| {
                cx.emit(WordViewEvent::RenderFailed(detail));
                div().into_any_element()
            })
    }
}

impl WordView {
    fn project_document(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.refresh_images();
        self.sync_size_field(window, cx);
        self.building.borrow_mut().clear();
        let theme = cx.theme().clone();
        let colors = self.page_colors(cx);
        let available = available_commands(&self.editor);
        let sheet = self.render_sheet(&colors, cx);
        let content_width = {
            let doc = self.editor.rich();
            let page = if self.mode == ViewMode::Page { doc.page_layout.width_points as f32 * PX_PER_POINT * self.zoom } else { 0.0 };
            px(page + 60.0)
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
        // A read-only page has no caret, as Electron's non-editable paragraphs have none.
        let show_caret = focused && self.editor.can_mutate() && (self.editor.is_collapsed() || self.composition.is_some());
        let caret_color = colors.text;
        let overlay = canvas(
            move |_, window, _| {
                let ready = std::mem::take(&mut *built.borrow_mut());
                *painted.borrow_mut() = ready;
                let caret = painted.borrow().get(&caret_paragraph).map(|p| p.layout.caret(caret_index));
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
            .bg(theme.secondary)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, _| this.dragging = false))
            // The sheet centers with auto margins, which never push a page
            // wider than the window past the left edge; the scroll area grows instead.
            .child(v_flex().min_w_full().min_h_full().w(content_width).p(px(30.)).child(sheet));

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
        let editing = editing.on_action(cx.listener(|this, _: &WordFind, window, cx| {
            if this.tool.is_none() || this.tool == Some(Tool::Find) {
                this.open_tool(Tool::Find, window, cx);
                cx.notify();
            }
        }));
        let menu = if self.menu_suspended { Vec::new() } else { menu_commands(&self.editor, self.tool) };
        let editing = actions::register_commands(editing, &menu, cx)
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
            .children(self.render_picker(cx))
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
        let (start, line_height) = painted.layout.caret(bytes.start);
        let end = caret_point(&painted, bytes.end);
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

/// A size Electron's field accepts: 1 to 400 points in half-point steps.
pub(crate) fn parse_size(text: &str) -> Option<f64> {
    let value: f64 = text.trim().parse().ok()?;
    (value.is_finite() && (1.0..=400.0).contains(&value) && (value * 2.0).fract() == 0.0).then_some(value)
}

fn trim_size(points: f64) -> String {
    let p = (points * 2.0).round() / 2.0;
    if p.fract() == 0.0 { format!("{}", p as i64) } else { format!("{p}") }
}

#[cfg(test)]
mod size_field_tests {
    use super::{parse_size, trim_size};

    #[test]
    fn takes_what_electrons_number_field_takes() {
        assert_eq!(parse_size("12"), Some(12.0));
        assert_eq!(parse_size(" 10.5 "), Some(10.5));
        assert_eq!(parse_size("400"), Some(400.0));
        assert_eq!(parse_size("0.5"), None);
        assert_eq!(parse_size("401"), None);
        assert_eq!(parse_size("10.25"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("abc"), None);
        assert_eq!(parse_size("NaN"), None);
    }

    #[test]
    fn shows_sizes_without_trailing_zeros() {
        assert_eq!(trim_size(12.0), "12");
        assert_eq!(trim_size(10.5), "10.5");
    }
}
