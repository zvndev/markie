//! The rich ("View" mode) editor as a GPUI view over `editor::Editor`.
//!
//! * `layout.rs`: our own inline layout (per-run sizes, inline formulas).
//! * `element.rs`: the element that draws a leaf and records where.
//! * `render.rs`: blocks, lists, quotes, tables, pictures and math.
//! * `chrome.rs`: the formatting toolbar, find bar and prompt bar.
//! * `media.rs`: pictures, formulas and CSS colours.
//!
//! This file holds the entity, its keyboard actions and bindings (the
//! TipTap set from `rich-keymap.ts` and `toolbar-shortcuts.ts`), mouse
//! selection, and the input handler that brings IME text in.

pub mod layout;
pub mod element;
pub mod media;
/// Live-room binding (no rendering): see `collab/mod.rs`.
pub mod collab;
mod render;
pub use render::MONO;
mod chrome;
pub mod attach;
mod behaviour;
mod table_bar;
mod math_field;
pub mod a11y;
pub mod spell;
pub mod link_preview;
mod link_card;
mod rail;
pub mod style;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;

use markie_rich::edit::Unit;
use markie_rich::editor::{BlockStyle, Editor, FindMatch, LeafKind, ListKind, MarkKind, Pos};
use element::SharedStore;

pub const CONTEXT: &str = "RichEditor";

actions!(
    rich_editor,
    [
        Backspace,
        Delete,
        DeleteWordLeft,
        DeleteWordRight,
        DeleteToLineStart,
        Enter,
        HardBreak,
        Tab,
        ShiftTab,
        MoveLeft,
        MoveRight,
        MoveUp,
        MoveDown,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        WordLeft,
        WordRight,
        SelectWordLeft,
        SelectWordRight,
        LineStart,
        LineEnd,
        SelectLineStart,
        SelectLineEnd,
        DocStart,
        DocEnd,
        SelectDocStart,
        SelectDocEnd,
        PageUp,
        PageDown,
        SelectAll,
        Copy,
        CopyPlain,
        Cut,
        Paste,
        Undo,
        Redo,
        Bold,
        Italic,
        Underline,
        Strike,
        InlineCode,
        Highlight,
        BulletList,
        OrderedList,
        TaskList,
        AlignLeft,
        AlignCenter,
        AlignRight,
        Link,
        ClearFormat,
        Paragraph,
        Heading1,
        Heading2,
        Heading3,
        Heading4,
        Heading5,
        Heading6,
        CodeBlock,
        Blockquote,
        Find,
        FindNext,
        FindPrev,
        Escape,
    ]
);

/// The editor's key bindings. Mod is ⌘ on macOS; the chords follow
/// TipTap's defaults and Markie's own rebindings (strike ⌘⇧X, link ⌘⇧K,
/// clear ⌘\), so the toolbar's tooltips tell the truth here too.
pub fn bind_keys(cx: &mut App) {
    let c = Some(CONTEXT);
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("shift-backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("ctrl-d", Delete, c),
        KeyBinding::new("alt-backspace", DeleteWordLeft, c),
        KeyBinding::new("alt-delete", DeleteWordRight, c),
        KeyBinding::new("cmd-backspace", DeleteToLineStart, c),
        KeyBinding::new("enter", Enter, c),
        KeyBinding::new("shift-enter", HardBreak, c),
        KeyBinding::new("tab", Tab, c),
        KeyBinding::new("shift-tab", ShiftTab, c),
        KeyBinding::new("left", MoveLeft, c),
        KeyBinding::new("right", MoveRight, c),
        KeyBinding::new("up", MoveUp, c),
        KeyBinding::new("down", MoveDown, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("shift-up", SelectUp, c),
        KeyBinding::new("shift-down", SelectDown, c),
        KeyBinding::new("alt-left", WordLeft, c),
        KeyBinding::new("alt-right", WordRight, c),
        KeyBinding::new("alt-shift-left", SelectWordLeft, c),
        KeyBinding::new("alt-shift-right", SelectWordRight, c),
        KeyBinding::new("cmd-left", LineStart, c),
        KeyBinding::new("cmd-right", LineEnd, c),
        KeyBinding::new("home", LineStart, c),
        KeyBinding::new("end", LineEnd, c),
        KeyBinding::new("cmd-shift-left", SelectLineStart, c),
        KeyBinding::new("cmd-shift-right", SelectLineEnd, c),
        KeyBinding::new("shift-home", SelectLineStart, c),
        KeyBinding::new("shift-end", SelectLineEnd, c),
        KeyBinding::new("cmd-up", DocStart, c),
        KeyBinding::new("cmd-down", DocEnd, c),
        KeyBinding::new("cmd-shift-up", SelectDocStart, c),
        KeyBinding::new("cmd-shift-down", SelectDocEnd, c),
        KeyBinding::new("pageup", PageUp, c),
        KeyBinding::new("pagedown", PageDown, c),
        KeyBinding::new("cmd-a", SelectAll, c),
        KeyBinding::new("cmd-c", Copy, c),
        KeyBinding::new("cmd-shift-c", CopyPlain, c),
        KeyBinding::new("cmd-x", Cut, c),
        KeyBinding::new("cmd-v", Paste, c),
        KeyBinding::new("cmd-z", Undo, c),
        KeyBinding::new("cmd-shift-z", Redo, c),
        KeyBinding::new("cmd-y", Redo, c),
        KeyBinding::new("cmd-b", Bold, c),
        KeyBinding::new("cmd-i", Italic, c),
        KeyBinding::new("cmd-u", Underline, c),
        KeyBinding::new("cmd-shift-x", Strike, c),
        KeyBinding::new("cmd-e", InlineCode, c),
        KeyBinding::new("cmd-shift-h", Highlight, c),
        KeyBinding::new("cmd-shift-8", BulletList, c),
        KeyBinding::new("cmd-shift-7", OrderedList, c),
        KeyBinding::new("cmd-shift-9", TaskList, c),
        KeyBinding::new("cmd-shift-l", AlignLeft, c),
        KeyBinding::new("cmd-shift-e", AlignCenter, c),
        KeyBinding::new("cmd-shift-r", AlignRight, c),
        KeyBinding::new("cmd-shift-k", Link, c),
        KeyBinding::new("cmd-\\", ClearFormat, c),
        KeyBinding::new("cmd-alt-0", Paragraph, c),
        KeyBinding::new("cmd-alt-1", Heading1, c),
        KeyBinding::new("cmd-alt-2", Heading2, c),
        KeyBinding::new("cmd-alt-3", Heading3, c),
        KeyBinding::new("cmd-alt-4", Heading4, c),
        KeyBinding::new("cmd-alt-5", Heading5, c),
        KeyBinding::new("cmd-alt-6", Heading6, c),
        KeyBinding::new("cmd-alt-c", CodeBlock, c),
        KeyBinding::new("cmd-shift-b", Blockquote, c),
        KeyBinding::new("cmd-f", Find, c),
        KeyBinding::new("cmd-g", FindNext, c),
        KeyBinding::new("cmd-shift-g", FindPrev, c),
        KeyBinding::new("escape", Escape, c),
    ]);
    behaviour::bind_keys(cx);
}

/// Emitted when the document changes, so the host can autosave. In a live
/// room (`collab_undo`), ⌘Z and ⌘⇧Z go to the host, whose shared undo
/// takes back only this person's edits.
#[derive(Debug, Clone)]
pub enum RichEvent {
    Changed,
    Undo,
    Redo,
    DocumentLink(String),
    /// Documents dropped on the editor, to open (attach.ts leaves them to
    /// the window's open path).
    OpenPaths(Vec<PathBuf>),
    /// A click on a link to a file, as `classify_click` decided it: the
    /// host opens, reveals or refuses it.
    OpenLocal(markie_core::links::LinkClick),
    /// The toolbar asked for a zoom (a `ZOOM_STEPS` value) or a page width
    /// (a `WIDTH_STEPS` value); the host stores both.
    Zoom(f32),
    PageWidth(f32),
    Print,
    History,
}

/// Someone else's caret and selection in a live room, already resolved to
/// editor positions by the collab binding. Drawn like TipTap's
/// CollaborationCaret: a 2px bar in their colour, a name tag that shows for a
/// moment after they move, and their selection in their colour at 44%.
#[derive(Debug, Clone)]
pub struct RemoteCursor {
    pub client: u64,
    pub name: SharedString,
    pub color: Hsla,
    pub anchor: Pos,
    pub head: Pos,
    pub moved_at: std::time::Instant,
}

/// How long a remote caret's name tag shows after a move (globals.css
/// `markie-caret-label`: full for 62% of 2.4 s, then fading).
pub const CARET_LABEL_MS: u128 = 2400;

impl EventEmitter<RichEvent> for RichView {}

/// What a drag extends by.
#[derive(Clone, Copy)]
enum Granularity {
    Char,
    Word,
    Leaf,
}

/// The small one-line prompt above the document (TipTap uses
/// `window.prompt` for the link address).
#[derive(Clone)]
pub enum PromptKind {
    Link,
    Image,
    InlineMath { at: Option<(Pos, usize)> },
    CodeLanguage(Pos),
    ImageWidth(Pos),
}

pub(crate) struct Prompt {
    kind: PromptKind,
    input: Entity<InputState>,
    label: SharedString,
    _sub: Subscription,
}

pub(crate) struct FindBar {
    query: Entity<InputState>,
    replace: Entity<InputState>,
    matches: Vec<FindMatch>,
    current: usize,
    /// `Aa` and `ab`, and whether the replace row shows (`find-bar.tsx`).
    pub(crate) case_sensitive: bool,
    pub(crate) whole_word: bool,
    pub(crate) show_replace: bool,
    /// What `matches` was computed from: the query, the document version
    /// and the two toggles. A frame with the same key searches nothing.
    searched: Option<(String, u64, bool, bool)>,
    _subs: Vec<Subscription>,
}

pub struct RichView {
    pub editor: Editor,
    focus: FocusHandle,
    scroll: ScrollHandle,
    store: SharedStore,
    base_dir: Option<PathBuf>,
    cloud_media: HashMap<String, PathBuf>,
    cloud_links: HashSet<String>,
    restrict_local_media: bool,
    pub zoom: f32,
    pub page_width: f32,
    pub read_only: bool,
    drag: Option<(Granularity, Pos, Pos)>,
    /// A press inside the selection: where it started, and once the pointer
    /// has moved, where the selection would land (ProseMirror's drag).
    pub(crate) text_drag: Option<(Point<Pixels>, Option<Pos>)>,
    /// The IME's marked (composing) text: its start and length in units.
    marked: Option<(Pos, usize)>,
    pub(crate) find: Option<FindBar>,
    pub(crate) prompt: Option<Prompt>,
    pub(crate) media: media::Media,
    autoscroll: bool,
    autoscroll_retries: u32,
    /// Block heights as last drawn, and the width they were drawn at:
    /// blocks far from the viewport are drawn as empty space this tall.
    heights: Vec<Option<Pixels>>,
    heights_width: Pixels,
    scroll_to_top: Option<(usize, usize)>,
    /// A picture being resized: its leaf, the x the drag started at and the
    /// width it started from; `live` is the width while dragging.
    pub(crate) resize: Option<(Pos, f32, f32)>,
    pub(crate) live_width: Option<(Pos, f32)>,
    emitted: u64,
    /// A link under a plain click, followed on release (behaviour.rs).
    pub(crate) link_click: Option<String>,
    /// An inline formula open for editing in place (math_field.rs).
    pub(crate) math_field: Option<math_field::MathField>,
    /// The macOS spell checker's answers (spell.rs).
    pub(crate) spell: spell::SpellCache,
    /// The link preview card (link_card.rs).
    pub(crate) link_hover: link_card::LinkHover,
    /// Settings: fetch a card for a link the pointer rests on.
    pub link_previews: bool,
    /// Peers' carets in a live room (set by the host's collab binding).
    pub remote: Vec<RemoteCursor>,
    /// Commented passages to tint (local comments), with their colour.
    pub comment_marks: Vec<(Pos, Pos, Hsla)>,
    /// Undo and redo belong to the live room's shared history.
    pub collab_undo: bool,
    /// The template's typography and doc rule (`style.rs`).
    pub style: style::DocStyle,
    /// The toolbar's font and size for the whole document, when nothing is
    /// selected: a `DOC_FONTS` id, and px (16 means "the template's").
    pub doc_font: &'static str,
    pub doc_size: f32,
    /// Where each block starts and how tall the page is, as last drawn
    /// (for the section rail).
    pub(crate) block_tops: Vec<Pixels>,
    pub(crate) content_height: Pixels,
    pub(crate) outline: (u64, Vec<markie_rich::editor::OutlineEntry>),
    /// The toolbar's width last frame, to fit its groups.
    pub(crate) toolbar_width: Pixels,
    /// The typed font size box (`chrome.rs`), made on the first frame.
    pub(crate) size_field: Option<chrome::SizeField>,
    /// The pointer on the section rail, and its card (`rail.rs`).
    pub(crate) rail_hover: rail::RailHover,
    /// The toolbar's "more" popover is open.
    pub(crate) more_open: bool,
    /// The toolbar is drawn above Source (by `SourceToolbar`): formatting
    /// does nothing there, as in Electron, where the rich editor is gone.
    pub(crate) source_mode: bool,
    source_toolbar: Option<Entity<SourceToolbar>>,
}

/// The formatting row above the Source pane. Electron keeps its toolbar
/// when Source shows: zoom, page width and history still work, the
/// formatting buttons have no editor to act on.
pub struct SourceToolbar {
    rich: WeakEntity<RichView>,
    _observe: Subscription,
}

impl Render for SourceToolbar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(rich) = self.rich.upgrade() else { return div().into_any_element() };
        rich.update(cx, |r, cx| {
            r.source_mode = true;
            r.render_toolbar(window, cx)
        })
    }
}

impl RichView {
    pub fn new(cx: &mut Context<Self>) -> RichView {
        RichView {
            editor: Editor::parse(""),
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            store: Rc::new(RefCell::new(element::Store::default())),
            base_dir: None,
            cloud_media: HashMap::new(),
            cloud_links: HashSet::new(),
            restrict_local_media: false,
            zoom: 1.0,
            page_width: 0.0,
            read_only: false,
            drag: None,
            text_drag: None,
            marked: None,
            find: None,
            prompt: None,
            media: media::Media::default(),
            autoscroll: false,
            autoscroll_retries: 0,
            heights: Vec::new(),
            heights_width: px(0.),
            scroll_to_top: None,
            resize: None,
            live_width: None,
            emitted: 0,
            link_click: None,
            math_field: None,
            spell: spell::SpellCache::default(),
            link_hover: Default::default(),
            link_previews: true,
            remote: Vec::new(),
            comment_marks: Vec::new(),
            collab_undo: false,
            style: style::DocStyle::default(),
            doc_font: "system",
            doc_size: 16.0,
            block_tops: Vec::new(),
            content_height: px(0.),
            outline: (u64::MAX, Vec::new()),
            toolbar_width: px(0.),
            size_field: None,
            more_open: false,
            rail_hover: Default::default(),
            source_mode: false,
            source_toolbar: None,
        }
    }

    /// Open Markdown text (a file's whole contents, front matter included:
    /// it is held aside and never shown). `base_dir` resolves relative
    /// pictures.
    pub fn load(&mut self, markdown: &str, base_dir: Option<PathBuf>, cx: &mut Context<Self>) {
        self.editor = Editor::parse(markdown);
        self.heights.clear();
        self.emitted = self.editor.version;
        self.base_dir = base_dir;
        self.marked = None;
        self.drag = None;
        if let Some(f) = &mut self.find {
            f.matches.clear();
        }
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }

    /// After the live room changed the document under the editor (the host's
    /// collab binding replaced `editor`): redraw without reporting a local
    /// edit, so the change is not sent back.
    pub fn remote_changed(&mut self, cx: &mut Context<Self>) {
        if self.heights.len() != self.editor.block_count() {
            self.heights.clear();
        }
        self.emitted = self.editor.version;
        self.marked = None;
        self.drag = None;
        self.refresh_find();
        cx.notify();
    }

    /// Where a position's caret was last drawn, in window coordinates. None
    /// for a leaf not on screen.
    pub fn caret_rect(&self, p: Pos) -> Option<Bounds<Pixels>> {
        let pl = self.placement(p)?;
        let c = pl.laid.caret(p.offset.min(pl.laid.len), false);
        Some(Bounds::new(point(pl.bounds.origin.x + c.origin.x, pl.bounds.origin.y + c.origin.y), c.size))
    }

    /// The scrolling document area as last drawn, in window coordinates.
    pub fn viewport(&self) -> Bounds<Pixels> {
        self.scroll.bounds()
    }

    /// The document as it would be saved.
    pub fn markdown(&self) -> String {
        self.editor.to_markdown()
    }

    /// Install per-document resources without modifying its Markdown.
    pub fn set_cloud_resources(&mut self, media: HashMap<String, PathBuf>, links: HashSet<String>,
        restrict_local: bool, cx: &mut Context<Self>) {
        self.cloud_media = media;
        self.cloud_links = links;
        self.restrict_local_media = restrict_local;
        cx.notify();
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }

    pub fn set_appearance(&mut self, zoom: f32, page_width: f32, cx: &mut Context<Self>) {
        self.zoom = zoom;
        self.page_width = page_width;
        cx.notify();
    }

    /// The toolbar to draw above the Source pane.
    pub fn source_toolbar(&mut self, cx: &mut Context<Self>) -> Entity<SourceToolbar> {
        if let Some(t) = &self.source_toolbar {
            return t.clone();
        }
        let rich = cx.entity();
        let t = cx.new(|cx| SourceToolbar { rich: rich.downgrade(), _observe: cx.observe(&rich, |_, _, cx| cx.notify()) });
        self.source_toolbar = Some(t.clone());
        t
    }

    /// The style template's typography and doc rule.
    pub fn set_style(&mut self, style: style::DocStyle, cx: &mut Context<Self>) {
        if self.style != style {
            self.style = style;
            self.heights.iter_mut().for_each(|h| *h = None);
            cx.notify();
        }
    }

    /// Put the caret on a heading and scroll it to the top (the outline).
    pub fn reveal_heading(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(e) = self.editor.outline().get(index) {
            self.editor.set_caret(Pos::new(e.block, e.leaf, 0), false);
            self.scroll_to_top = Some((e.block, e.leaf));
            self.focus(window, cx);
            cx.notify();
        }
    }

    /// After a change: tell the host, scroll to the caret, redraw.
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.hide_link_card(cx);
        if self.editor.version != self.emitted {
            self.emitted = self.editor.version;
            cx.emit(RichEvent::Changed);
            self.refresh_find();
        }
        self.autoscroll = true;
        cx.notify();
    }

    fn edit(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Editor)) {
        if self.read_only {
            return;
        }
        self.marked = None;
        f(&mut self.editor);
        self.changed(cx);
    }

    fn mv(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Editor)) {
        self.marked = None;
        f(&mut self.editor);
        self.autoscroll = true;
        cx.notify();
    }

    // ---- keyboard ----

    fn on_backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.backspace());
    }
    fn on_delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.delete_forward());
    }
    fn on_delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.delete_word_backward());
    }
    fn on_delete_word_right(&mut self, _: &DeleteWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.delete_word_forward());
    }
    fn on_delete_to_line_start(&mut self, _: &DeleteToLineStart, _: &mut Window, cx: &mut Context<Self>) {
        let start = self.line_edge(false).unwrap_or(Pos { offset: 0, ..self.editor.head });
        self.edit(cx, |e| {
            if e.has_selection() {
                e.backspace();
            } else {
                e.delete_to(start);
            }
        });
    }
    fn on_enter(&mut self, _: &Enter, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.enter());
    }
    fn on_hard_break(&mut self, _: &HardBreak, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.hard_break());
    }
    fn on_tab(&mut self, _: &Tab, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.indent());
    }
    fn on_shift_tab(&mut self, _: &ShiftTab, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.outdent());
    }
    fn on_left(&mut self, _: &MoveLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_left(false, false));
    }
    fn on_right(&mut self, _: &MoveRight, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_right(false, false));
    }
    fn on_select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_left(true, false));
    }
    fn on_select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_right(true, false));
    }
    fn on_word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_left(false, true));
    }
    fn on_word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_right(false, true));
    }
    fn on_select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_left(true, true));
    }
    fn on_select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_right(true, true));
    }
    fn on_up(&mut self, _: &MoveUp, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(false, false, cx);
    }
    fn on_down(&mut self, _: &MoveDown, _: &mut Window, cx: &mut Context<Self>) {
        // CodeBlock's exitOnArrowDown, at the very end of a code block.
        if !self.read_only && self.editor.kind(self.editor.head) == Some(LeafKind::Code) && !self.editor.has_selection() {
            let h = self.editor.head;
            if h.offset == self.editor.leaf_len(h.block, h.leaf) {
                self.edit(cx, |e| {
                    e.code_arrow_down();
                });
                return;
            }
        }
        self.vertical(true, false, cx);
    }
    fn on_select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(false, true, cx);
    }
    fn on_select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(true, true, cx);
    }
    fn on_line_start(&mut self, _: &LineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.line_move(false, false, cx);
    }
    fn on_line_end(&mut self, _: &LineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.line_move(true, false, cx);
    }
    fn on_select_line_start(&mut self, _: &SelectLineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.line_move(false, true, cx);
    }
    fn on_select_line_end(&mut self, _: &SelectLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.line_move(true, true, cx);
    }
    fn on_doc_start(&mut self, _: &DocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_doc_edge(false, false));
    }
    fn on_doc_end(&mut self, _: &DocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_doc_edge(true, false));
    }
    fn on_select_doc_start(&mut self, _: &SelectDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_doc_edge(false, true));
    }
    fn on_select_doc_end(&mut self, _: &SelectDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.move_doc_edge(true, true));
    }
    fn on_page_up(&mut self, _: &PageUp, _: &mut Window, cx: &mut Context<Self>) {
        self.page(false, cx);
    }
    fn on_page_down(&mut self, _: &PageDown, _: &mut Window, cx: &mut Context<Self>) {
        self.page(true, cx);
    }
    fn on_select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.mv(cx, |e| e.select_all());
        self.autoscroll = false;
    }
    fn on_copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let md = self.editor.selection_markdown();
        if !md.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(md));
        }
    }
    fn on_copy_plain(&mut self, _: &CopyPlain, _: &mut Window, cx: &mut Context<Self>) {
        let t = self.editor.selection_text();
        if !t.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(t));
        }
    }
    fn on_cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if self.read_only || !self.editor.has_selection() {
            return;
        }
        let md = self.editor.selection_markdown();
        cx.write_to_clipboard(ClipboardItem::new_string(md));
        self.edit(cx, |e| e.delete_forward());
    }
    fn on_paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|i| i.text()) else { return };
        self.edit(cx, |e| e.paste_markdown(&text));
    }
    fn on_undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        if self.collab_undo {
            if !self.read_only {
                cx.emit(RichEvent::Undo);
            }
            return;
        }
        self.edit(cx, |e| {
            e.undo();
        });
    }
    fn on_redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        if self.collab_undo {
            if !self.read_only {
                cx.emit(RichEvent::Redo);
            }
            return;
        }
        self.edit(cx, |e| {
            e.redo();
        });
    }
    fn on_bold(&mut self, _: &Bold, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_mark(MarkKind::Bold));
    }
    fn on_italic(&mut self, _: &Italic, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_mark(MarkKind::Italic));
    }
    fn on_underline(&mut self, _: &Underline, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_mark(MarkKind::Underline));
    }
    fn on_strike(&mut self, _: &Strike, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_mark(MarkKind::Strike));
    }
    fn on_code(&mut self, _: &InlineCode, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_mark(MarkKind::Code));
    }
    fn on_highlight(&mut self, _: &Highlight, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_highlight());
    }
    fn on_bullet(&mut self, _: &BulletList, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_list(ListKind::Bullet));
    }
    fn on_ordered(&mut self, _: &OrderedList, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_list(ListKind::Ordered));
    }
    fn on_task(&mut self, _: &TaskList, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_list(ListKind::Task));
    }
    fn on_align_left(&mut self, _: &AlignLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_align(Some("left")));
    }
    fn on_align_center(&mut self, _: &AlignCenter, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_align(Some("center")));
    }
    fn on_align_right(&mut self, _: &AlignRight, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_align(Some("right")));
    }
    fn on_link(&mut self, _: &Link, window: &mut Window, cx: &mut Context<Self>) {
        self.open_prompt(PromptKind::Link, window, cx);
    }
    fn on_clear(&mut self, _: &ClearFormat, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.clear_formatting());
    }
    fn on_paragraph(&mut self, _: &Paragraph, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Paragraph));
    }
    fn on_h1(&mut self, _: &Heading1, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Heading(1)));
    }
    fn on_h2(&mut self, _: &Heading2, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Heading(2)));
    }
    fn on_h3(&mut self, _: &Heading3, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Heading(3)));
    }
    fn on_h4(&mut self, _: &Heading4, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Heading(4)));
    }
    fn on_h5(&mut self, _: &Heading5, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Heading(5)));
    }
    fn on_h6(&mut self, _: &Heading6, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Heading(6)));
    }
    fn on_code_block(&mut self, _: &CodeBlock, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.set_block_style(BlockStyle::Code));
    }
    fn on_quote(&mut self, _: &Blockquote, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |e| e.toggle_quote());
    }
    fn on_find(&mut self, _: &Find, window: &mut Window, cx: &mut Context<Self>) {
        self.open_find(window, cx);
    }
    fn on_find_next(&mut self, _: &FindNext, _: &mut Window, cx: &mut Context<Self>) {
        self.find_step(true, cx);
    }
    fn on_find_prev(&mut self, _: &FindPrev, _: &mut Window, cx: &mut Context<Self>) {
        self.find_step(false, cx);
    }
    fn on_escape(&mut self, _: &Escape, window: &mut Window, cx: &mut Context<Self>) {
        if self.cancel_math_field(window, cx) {
            return;
        }
        if self.link_hover_visible() {
            self.hide_link_card(cx);
            return;
        }
        if std::mem::take(&mut self.more_open) {
            cx.notify();
            return;
        }
        if self.prompt.take().is_some() || self.find.take().is_some() {
            self.focus(window, cx);
        } else if self.editor.has_selection() {
            let h = self.editor.head;
            self.editor.set_caret(h, false);
        } else {
            cx.propagate();
            return;
        }
        cx.notify();
    }

    // ---- lines, from what was drawn ----

    fn placement(&self, p: Pos) -> Option<element::Placement> {
        self.store.borrow().leaves.get(&(p.block, p.leaf)).cloned()
    }

    /// The start or end of the visual line the caret is on.
    fn line_edge(&self, end: bool) -> Option<Pos> {
        let p = self.editor.head;
        let pl = self.placement(p)?;
        let line = pl.laid.line_of(p.offset, false);
        let l = &pl.laid.lines[line];
        let o = if end {
            let soft = line + 1 < pl.laid.line_count();
            let e = l.units.end;
            // A wrapped line ends before its trailing space; a line with a
            // hard break before the break.
            if soft { pl.laid.unit_at_line_x(line, px(1.0e6)) } else { e }
        } else {
            l.units.start
        };
        Some(Pos { offset: o, ..p })
    }

    fn line_move(&mut self, end: bool, extend: bool, cx: &mut Context<Self>) {
        match self.line_edge(end) {
            Some(p) => self.mv(cx, |e| e.set_caret(p, extend)),
            None => self.mv(cx, |e| e.move_leaf_edge(end, extend)),
        }
    }

    /// Up and down by visual line, keeping the column.
    fn vertical(&mut self, down: bool, extend: bool, cx: &mut Context<Self>) {
        let p = self.editor.head;
        let Some(pl) = self.placement(p) else {
            self.mv(cx, |e| {
                e.move_leaf_vertical(down, extend);
            });
            return;
        };
        let line = pl.laid.line_of(p.offset, false);
        let x = self.editor.goal_x.map(px).unwrap_or_else(|| pl.bounds.origin.x + pl.laid.x_of(p.offset, line));
        let target = if down && line + 1 < pl.laid.line_count() {
            Some(Pos { offset: pl.laid.unit_at_line_x(line + 1, x - pl.bounds.origin.x), ..p })
        } else if !down && line > 0 {
            Some(Pos { offset: pl.laid.unit_at_line_x(line - 1, x - pl.bounds.origin.x), ..p })
        } else {
            // The next leaf in reading order, at the same x.
            let n = if down { self.editor.next_leaf(p) } else { self.editor.prev_leaf(p) };
            match n {
                Some(n) => match self.placement(n) {
                    Some(npl) => {
                        let l = if down { 0 } else { npl.laid.line_count() - 1 };
                        Some(Pos { offset: npl.laid.unit_at_line_x(l, x - npl.bounds.origin.x), ..n })
                    }
                    None => Some(n),
                },
                None => None,
            }
        };
        let goal = f32::from(x);
        match target {
            Some(t) => self.mv(cx, |e| {
                e.set_caret(t, extend);
                e.goal_x = Some(goal);
            }),
            None => {
                let was = self.editor.version;
                self.mv(cx, |e| {
                    e.move_leaf_vertical(down, extend);
                });
                if self.editor.version != was {
                    self.changed(cx);
                }
            }
        }
    }

    fn page(&mut self, down: bool, cx: &mut Context<Self>) {
        let viewport = self.scroll.bounds();
        let h = viewport.size.height * 0.9;
        let mut off = self.scroll.offset();
        off.y = if down { off.y - h } else { off.y + h };
        off.y = off.y.min(px(0.)).max(-self.scroll.max_offset().y);
        self.scroll.set_offset(off);
        // Keep the caret where the eye was: same place on the screen.
        if let Some(pl) = self.placement(self.editor.head) {
            let c = pl.laid.caret(self.editor.head.offset, false);
            let y = pl.bounds.origin.y + c.origin.y + c.size.height / 2. + if down { h } else { -h };
            let x = pl.bounds.origin.x + c.origin.x;
            if let Some(t) = self.hit(point(x, y)) {
                self.editor.set_caret(t, false);
            }
        }
        cx.notify();
    }

    // ---- mouse ----

    /// The document position under a window point: an atom whose box holds
    /// it, else the nearest leaf.
    pub(crate) fn hit(&self, p: Point<Pixels>) -> Option<Pos> {
        let store = self.store.borrow();
        for (k, b) in &store.atoms {
            if b.contains(&p) {
                return Some(Pos::new(k.0, k.1, 0));
            }
        }
        let mut best: Option<(f32, (usize, usize), &element::Placement)> = None;
        for (k, pl) in &store.leaves {
            let b = pl.bounds;
            let dx = if p.x < b.left() { f32::from(b.left() - p.x) } else if p.x > b.right() { f32::from(p.x - b.right()) } else { 0. };
            let dy = if p.y < b.top() { f32::from(b.top() - p.y) } else if p.y > b.bottom() { f32::from(p.y - b.bottom()) } else { 0. };
            // Vertical distance matters most: a click beside a line is on it.
            let d = dy * 4. + dx;
            if best.as_ref().is_none_or(|(bd, bk, _)| d < *bd || (d == *bd && *k < *bk)) {
                best = Some((d, *k, pl));
            }
        }
        let (_, k, pl) = best?;
        let local = point(p.x - pl.bounds.origin.x, p.y - pl.bounds.origin.y);
        Some(Pos::new(k.0, k.1, pl.laid.unit_at(local)))
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if std::env::var("MARKIE_RICH_DEBUG").is_ok() {
            eprintln!("mouse down at {:?} ({} clicks)", ev.position, ev.click_count);
        }
        self.focus(window, cx);
        self.marked = None;
        let Some(p) = self.hit(ev.position) else { return };
        if std::env::var("MARKIE_RICH_DEBUG").is_ok() {
            eprintln!("mouse down {:?} clicks {} -> {:?}", ev.position, ev.click_count, p);
        }
        // A click on a link follows it on release (behaviour.rs); a link
        // to a cloud document goes to the host.
        self.note_link_click(p, ev.click_count, ev.modifiers.shift);
        let units = self.editor.units(p.block, p.leaf);
        match ev.click_count {
            2 if self.editor.kind(p).is_some_and(|k| k.has_text()) => {
                let (a, b) = markie_rich::editor::word_at(&units, p.offset);
                self.editor.set_selection(Pos { offset: a, ..p }, Pos { offset: b, ..p });
                self.drag = Some((Granularity::Word, Pos { offset: a, ..p }, Pos { offset: b, ..p }));
            }
            n if n >= 3 => {
                let len = self.editor.leaf_len(p.block, p.leaf);
                self.editor.set_selection(Pos { offset: 0, ..p }, Pos { offset: len, ..p });
                self.drag = Some((Granularity::Leaf, Pos { offset: 0, ..p }, Pos { offset: len, ..p }));
            }
            1 if self.starts_text_drag(p, ev.modifiers.shift) => {
                // A press inside the selection may be a drag of it; the
                // caret moves only if it turns out to be a click.
                self.link_click = None;
                self.drag = None;
                self.text_drag = Some((ev.position, None));
            }
            _ => {
                if self.editor.kind(p) == Some(LeafKind::Atom) {
                    self.editor.set_caret(p, false);
                    self.drag = None;
                } else {
                    self.editor.set_caret(p, ev.modifiers.shift);
                    let a = self.editor.anchor;
                    self.drag = Some((Granularity::Char, a, a));
                }
            }
        }
        cx.notify();
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some((start, x0, w0)) = self.resize {
            let w = (w0 + (f32::from(ev.position.x) - x0) / self.zoom).max(48.);
            self.live_width = Some((start, w));
            cx.notify();
            return;
        }
        if let Some((origin, drop)) = self.text_drag {
            if ev.pressed_button != Some(MouseButton::Left) {
                self.text_drag = None;
                cx.notify();
                return;
            }
            let moved = (ev.position.x - origin.x).abs() > px(4.) || (ev.position.y - origin.y).abs() > px(4.);
            if moved || drop.is_some() {
                let next = self.hit(ev.position);
                if next != drop {
                    self.text_drag = Some((origin, next));
                    cx.notify();
                }
            }
            return;
        }
        let Some((g, a0, a1)) = self.drag else { return };
        if ev.pressed_button != Some(MouseButton::Left) {
            self.drag = None;
            return;
        }
        let Some(p) = self.hit(ev.position) else { return };
        let (anchor, head) = match g {
            Granularity::Char => (a0, p),
            Granularity::Word | Granularity::Leaf => {
                let units = self.editor.units(p.block, p.leaf);
                let (wa, wb) = match g {
                    Granularity::Word => markie_rich::editor::word_at(&units, p.offset),
                    _ => (0, self.editor.leaf_len(p.block, p.leaf)),
                };
                if p < a0 { (a1, Pos { offset: wa, ..p }) } else { (a0, Pos { offset: wb, ..p }) }
            }
        };
        if (anchor, head) != (self.editor.anchor, self.editor.head) {
            self.editor.set_selection(anchor, head);
            self.autoscroll = true;
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, ev: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.drag = None;
        if let Some((origin, drop)) = self.text_drag.take() {
            match drop {
                // ⌥ copies, as ProseMirror's `dragCopyModifier` on macOS.
                Some(at) => self.edit(cx, |e| {
                    e.move_selection_to(at, ev.modifiers.alt);
                }),
                // No drag: a click inside the selection puts the caret there.
                None => {
                    if let Some(p) = self.hit(origin) {
                        self.editor.set_caret(p, false);
                    }
                    cx.notify();
                }
            }
            return;
        }
        if let Some((p, w)) = self.live_width.take() {
            self.resize = None;
            self.edit(cx, |e| e.set_image_width(p, Some(w.round() as u32)));
        }
        self.resize = None;
    }

    /// A plain press inside a text selection, in an editable document.
    fn starts_text_drag(&self, p: Pos, shift: bool) -> bool {
        if shift || self.read_only || !self.editor.has_selection() || self.editor.selected_atom().is_some() {
            return false;
        }
        let (from, to) = self.editor.range();
        from <= p && p <= to
    }

    // ---- find ----

    fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.is_none() {
            let query = cx.new(|cx| InputState::new(window, cx).placeholder("Find"));
            let replace = cx.new(|cx| InputState::new(window, cx).placeholder("Replace"));
            let subs = vec![
                cx.subscribe(&query, |this, _, ev: &InputEvent, cx| match ev {
                    InputEvent::Change => {
                        this.recompute_find(cx);
                        if let Some(f) = &this.find {
                            if let Some(m) = f.matches.get(f.current) {
                                let m = *m;
                                this.editor.set_selection(m.start, m.end);
                                this.autoscroll = true;
                            }
                        }
                        cx.notify();
                    }
                    InputEvent::PressEnter { shift, .. } => this.find_step(!*shift, cx),
                    _ => {}
                }),
                cx.subscribe(&replace, |this, _, ev: &InputEvent, cx| {
                    if let InputEvent::PressEnter { secondary, .. } = ev {
                        if *secondary { this.replace_all(cx) } else { this.replace_one(cx) }
                    }
                }),
            ];
            self.find = Some(FindBar {
                query,
                replace,
                matches: vec![],
                current: 0,
                case_sensitive: false,
                whole_word: false,
                show_replace: false,
                searched: None,
                _subs: subs,
            });
        }
        if let Some(f) = &self.find {
            if self.editor.has_selection() {
                let t = self.editor.selection_text();
                if !t.contains('\n') && t.len() < 200 {
                    f.query.update(cx, |s, cx| s.set_value(t, window, cx));
                }
            }
            let h = f.query.read(cx).focus_handle(cx);
            h.focus(window, cx);
        }
        self.refresh_find();
        cx.notify();
    }

    pub(crate) fn find_query(&self, cx: &App) -> String {
        self.find.as_ref().map(|f| f.query.read(cx).value().to_string()).unwrap_or_default()
    }

    fn refresh_find(&mut self) {
        // The query is read at render time from the input (see chrome.rs),
        // and kept here so matches follow edits.
    }

    pub(crate) fn recompute_find(&mut self, cx: &App) {
        let q = self.find_query(cx);
        let Some(f) = &self.find else { return };
        let key = (q.clone(), self.editor.version, f.case_sensitive, f.whole_word);
        if f.searched.as_ref() == Some(&key) {
            return;
        }
        let (case, whole) = (f.case_sensitive, f.whole_word);
        let mut matches = if q.is_empty() { vec![] } else { self.editor.find(&q, case) };
        if whole {
            let word = |u: Option<&Unit>| matches!(u, Some(Unit::Char(c, _)) if c.is_alphanumeric() || *c == '_');
            matches.retain(|m| {
                let units = self.editor.units(m.start.block, m.start.leaf);
                let before = m.start.offset.checked_sub(1).and_then(|i| units.get(i));
                let after = if (m.end.block, m.end.leaf) == (m.start.block, m.start.leaf) { units.get(m.end.offset) } else { None };
                !word(before) && !word(after)
            });
        }
        let head = self.editor.range().0;
        if let Some(f) = &mut self.find {
            f.current = matches.iter().position(|m| m.start >= head).unwrap_or(0);
            f.matches = matches;
            f.searched = Some(key);
        }
    }

    fn find_step(&mut self, forward: bool, cx: &mut Context<Self>) {
        self.recompute_find(cx);
        let Some(f) = &mut self.find else { return };
        if f.matches.is_empty() {
            return;
        }
        let (from, to) = self.editor.range();
        let i = if forward {
            f.matches.iter().position(|m| m.start >= to && m.start != from).unwrap_or(0)
        } else {
            f.matches.iter().rposition(|m| m.end <= from && m.start != from).unwrap_or(f.matches.len() - 1)
        };
        f.current = i;
        let m = f.matches[i];
        self.editor.set_selection(m.start, m.end);
        self.autoscroll = true;
        cx.notify();
    }

    fn replace_one(&mut self, cx: &mut Context<Self>) {
        let Some(f) = &self.find else { return };
        let with = f.replace.read(cx).value().to_string();
        let q = self.find_query(cx);
        let (a, b) = self.editor.range();
        let case = self.find.as_ref().is_some_and(|f| f.case_sensitive);
        let hit = self.editor.find(&q, case).into_iter().find(|m| m.start == a && m.end == b);
        if let Some(m) = hit {
            self.edit(cx, |e| e.replace_match(m, &with));
        }
        self.find_step(true, cx);
    }

    fn replace_all(&mut self, cx: &mut Context<Self>) {
        let Some(f) = &self.find else { return };
        let with = f.replace.read(cx).value().to_string();
        let q = self.find_query(cx);
        if q.is_empty() {
            return;
        }
        self.edit(cx, |e| {
            e.replace_all(&q, &with, false);
        });
    }

    // ---- prompt ----

    pub(crate) fn open_prompt(&mut self, kind: PromptKind, window: &mut Window, cx: &mut Context<Self>) {
        if self.read_only || self.source_mode {
            return;
        }
        let (label, value) = match &kind {
            PromptKind::Link => ("Link URL", self.editor.toolbar().link.unwrap_or_default()),
            PromptKind::Image => ("Image URL or path", String::new()),
            PromptKind::InlineMath { at } => (
                "Formula (TeX)",
                at.and_then(|(p, i)| match self.editor.units(p.block, p.leaf).get(i) {
                    Some(Unit::Atom(markie_rich::model::Inline::Math { source })) => {
                        Some(markie_math::strip_delimiters(source).map(|(t, _)| t.to_string()).unwrap_or_else(|| source.clone()))
                    }
                    _ => None,
                })
                .unwrap_or_default(),
            ),
            PromptKind::CodeLanguage(p) => (
                "Code language",
                match self.editor.leaf_node(*p) {
                    Some(markie_rich::model::Node::CodeBlock { language, .. }) => language.clone().unwrap_or_default(),
                    _ => String::new(),
                },
            ),
            PromptKind::ImageWidth(p) => (
                "Picture width in pixels (empty for its own size)",
                match self.editor.leaf_node(*p) {
                    Some(markie_rich::model::Node::Image { width, .. }) => width.map(|w| w.to_string()).unwrap_or_default(),
                    _ => String::new(),
                },
            ),
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(label));
        input.update(cx, |s, cx| s.set_value(value, window, cx));
        let sub = cx.subscribe_in(&input, window, |this, state, ev: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = ev {
                let v = state.read(cx).value().to_string();
                this.apply_prompt(v, window, cx);
            }
        });
        let h = input.read(cx).focus_handle(cx);
        self.prompt = Some(Prompt { kind, input, label: label.into(), _sub: sub });
        h.focus(window, cx);
        cx.notify();
    }

    pub(crate) fn apply_prompt(&mut self, value: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.prompt.take() else { return };
        let v = value.trim().to_string();
        match p.kind {
            PromptKind::Link => self.edit(cx, |e| e.set_link(&v)),
            PromptKind::Image => {
                if !v.is_empty() {
                    self.edit(cx, |e| e.insert_image(&v, None));
                }
            }
            PromptKind::InlineMath { at } => match at {
                Some((pos, i)) => {
                    let src = if v.is_empty() { String::new() } else { format!("${v}$") };
                    self.edit(cx, |e| e.set_inline_math(pos, i, &src));
                }
                None => {
                    if v.contains('\n') {
                        self.edit(cx, |e| e.insert_math_block(&v));
                    } else {
                        self.edit(cx, |e| e.insert_inline_math(&v));
                    }
                }
            },
            PromptKind::CodeLanguage(pos) => self.edit(cx, |e| e.set_code_language(pos, Some(v))),
            PromptKind::ImageWidth(pos) => {
                let w = markie_rich::html::normalize_width(&v);
                self.edit(cx, |e| e.set_image_width(pos, w));
            }
        }
        self.focus(window, cx);
        cx.notify();
    }

    // ---- input method ----

    /// The head leaf's text as the input method sees it: atoms are U+FFFC.
    fn ime_text(&self) -> (Pos, String) {
        let p = self.editor.head;
        let s: String = self
            .editor
            .units(p.block, p.leaf)
            .iter()
            .map(|u| match u {
                Unit::Char(c, _) => *c,
                Unit::Atom(_) => '\u{fffc}',
            })
            .collect();
        (p, s)
    }

    fn utf16_to_unit(s: &str, u16: usize) -> usize {
        let mut n = 0;
        for (i, c) in s.chars().enumerate() {
            if n >= u16 {
                return i;
            }
            n += c.len_utf16();
        }
        s.chars().count()
    }

    fn unit_to_utf16(s: &str, unit: usize) -> usize {
        s.chars().take(unit).map(char::len_utf16).sum()
    }

    /// Select the units an IME range names in the head leaf.
    fn select_utf16(&mut self, range: Option<Range<usize>>) {
        let (p, s) = self.ime_text();
        let r = match range {
            Some(r) => Self::utf16_to_unit(&s, r.start)..Self::utf16_to_unit(&s, r.end),
            None => match self.marked {
                Some((m, len)) if (m.block, m.leaf) == (p.block, p.leaf) => m.offset..m.offset + len,
                _ => return,
            },
        };
        self.editor.set_selection(Pos { offset: r.start, ..p }, Pos { offset: r.end, ..p });
    }
}

impl EntityInputHandler for RichView {
    fn text_for_range(&mut self, range: Range<usize>, adjusted: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let (_, s) = self.ime_text();
        let a = Self::utf16_to_unit(&s, range.start);
        let b = Self::utf16_to_unit(&s, range.end);
        *adjusted = Some(Self::unit_to_utf16(&s, a)..Self::unit_to_utf16(&s, b));
        Some(s.chars().skip(a).take(b.saturating_sub(a)).collect())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let (p, s) = self.ime_text();
        let (a, b) = self.editor.range();
        let same = |x: Pos| (x.block, x.leaf) == (p.block, p.leaf);
        let (ua, ub) = if same(a) && same(b) { (a.offset, b.offset) } else { (p.offset, p.offset) };
        Some(UTF16Selection {
            range: Self::unit_to_utf16(&s, ua)..Self::unit_to_utf16(&s, ub),
            reversed: self.editor.head < self.editor.anchor,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        let (m, len) = self.marked?;
        let (p, s) = self.ime_text();
        if (m.block, m.leaf) != (p.block, p.leaf) {
            return None;
        }
        Some(Self::unit_to_utf16(&s, m.offset)..Self::unit_to_utf16(&s, m.offset + len))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        if std::env::var("MARKIE_RICH_DEBUG").is_ok() {
            eprintln!("insert {text:?} at {range:?}");
        }
        if self.read_only {
            return;
        }
        self.select_utf16(range);
        self.marked = None;
        let t = text.to_string();
        if t == "\n" || t == "\r" {
            self.edit(cx, |e| e.enter());
            return;
        }
        self.editor.typing = self.editor.typing.take();
        let typing = self.editor.typing.clone();
        self.edit(cx, |e| {
            e.typing = typing;
            e.insert_text(&t)
        });
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        new_selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.read_only {
            return;
        }
        self.select_utf16(range);
        let start = self.editor.range().0;
        let t = text.to_string();
        if t.is_empty() {
            if self.editor.has_selection() {
                self.edit(cx, |e| e.backspace());
            }
            self.marked = None;
            return;
        }
        // Composing text goes into the document as typed, marked, so the
        // next update replaces it.
        let typing = self.editor.typing.clone();
        f_insert(&mut self.editor, &t, typing);
        let n = t.chars().count();
        self.marked = Some((start, n));
        if let Some(sel) = new_selected {
            let (_, s) = self.ime_text();
            let base16 = Self::unit_to_utf16(&s, start.offset);
            let a = Self::utf16_to_unit(&s, base16 + sel.start);
            let b = Self::utf16_to_unit(&s, base16 + sel.end);
            let p = self.editor.head;
            self.editor.set_selection(Pos { offset: a, ..p }, Pos { offset: b, ..p });
        }
        self.marked = Some((start, n));
        self.changed(cx);
    }

    fn bounds_for_range(&mut self, range: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let (p, s) = self.ime_text();
        let u = Self::utf16_to_unit(&s, range.start);
        let pl = self.placement(p)?;
        let c = pl.laid.caret(u, false);
        Some(Bounds::new(point(pl.bounds.origin.x + c.origin.x, pl.bounds.origin.y + c.origin.y), size(px(2.), c.size.height)))
    }

    fn character_index_for_point(&mut self, point: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let p = self.hit(point)?;
        let head = self.editor.head;
        if (p.block, p.leaf) != (head.block, head.leaf) {
            return None;
        }
        let (_, s) = self.ime_text();
        Some(Self::unit_to_utf16(&s, p.offset))
    }

    fn accepts_text_input(&self, _: &mut Window, _: &mut Context<Self>) -> bool {
        !self.read_only
    }
}

/// Insert composing text without breaking the undo run.
fn f_insert(e: &mut Editor, t: &str, typing: Option<markie_rich::model::Marks>) {
    e.typing = typing;
    e.insert_text(t);
}

impl Focusable for RichView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl RichView {
    /// Misspelled ranges for a leaf's units, sparing the word at the caret;
    /// unknown text is checked shortly after, off the keystroke.
    pub(crate) fn misspelled(&mut self, key: element::LeafKey, units: &[Unit], cx: &mut Context<Self>) -> Vec<Range<usize>> {
        let text: String = units.iter().map(|u| match u { Unit::Char(c, _) => *c, Unit::Atom(_) => '\u{fffc}' }).collect();
        let h = self.editor.head;
        let caret = (!self.editor.has_selection() && (h.block, h.leaf) == key).then_some(h.offset);
        match self.spell.ranges(&text, caret) {
            Some(r) => r,
            None => {
                if !self.spell.scheduled {
                    self.spell.scheduled = true;
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(std::time::Duration::from_millis(250)).await;
                        this.update(cx, |this, cx| {
                            this.spell.scheduled = false;
                            if this.spell.drain() {
                                cx.notify();
                            }
                        })
                        .ok();
                    })
                    .detach();
                }
                vec![]
            }
        }
    }
}
