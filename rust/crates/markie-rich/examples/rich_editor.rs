//! Phase 2a UI proof: a block editor of styled text runs over the
//! `markie-rich` model (approach a in docs/rust-port/SPIKE-2A.md).
//!
//!   cargo run -p markie-rich --features gui --example rich_editor -- <file.md>
//!
//! Paragraphs and headings are edited as styled runs; every other block is
//! shown as its source and kept byte for byte. Keys: type, Backspace, Enter,
//! arrows (Shift to select), Cmd-B bold, Cmd-I italic, Cmd-1..3 heading,
//! Cmd-0 paragraph, Cmd-S save. The status line counts the blocks rewritten
//! and the blocks written back from their own bytes.
//!
//! Spike limits, on purpose: no IME (keys arrive as characters), no mouse
//! caret placement inside a block (a click activates the block), no undo.

use std::path::PathBuf;

use gpui_kit::component::{ActiveTheme, Theme, TitleBar, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_rich::Document;
use markie_rich::edit::{MarkKind, RichEditor, TextKind, Unit, text_block};

const SAMPLE: &str = "# Markie RS rich editor\n\nThis paragraph was wrapped\nby hand, and stays that way until you type in it.\n\nType here. Select with **Shift** and arrows, then press *Cmd-B* or *Cmd-I*.\n\n<!-- an HTML comment is kept as source -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## A heading\n\nMath stays one unit: $e^{i\\pi} + 1 = 0$.\n";

struct RichView {
    ed: RichEditor,
    path: Option<PathBuf>,
    focus: FocusHandle,
    status: String,
}

impl RichView {
    fn new(path: Option<PathBuf>, cx: &mut Context<Self>) -> RichView {
        let text = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_else(|| SAMPLE.into());
        RichView { ed: RichEditor::new(Document::parse(&text)), path, focus: cx.focus_handle(), status: String::new() }
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        let m = k.modifiers;
        let cmd = m.platform || m.control;
        match (cmd, k.key.as_str()) {
            (true, "b") => self.ed.toggle_mark(MarkKind::Bold),
            (true, "i") => self.ed.toggle_mark(MarkKind::Italic),
            (true, "0") => self.ed.set_heading(0),
            (true, "1") => self.ed.set_heading(1),
            (true, "2") => self.ed.set_heading(2),
            (true, "3") => self.ed.set_heading(3),
            (true, "s") => self.save(),
            (true, _) => return,
            (false, "left") => self.ed.move_horizontal(-1, m.shift),
            (false, "right") => self.ed.move_horizontal(1, m.shift),
            (false, "up") => {
                self.ed.move_vertical(-1);
            }
            (false, "down") => {
                self.ed.move_vertical(1);
            }
            (false, "backspace") => self.ed.backspace(),
            (false, "enter") => self.ed.split(),
            (false, _) => match &k.key_char {
                Some(ch) if !ch.chars().any(char::is_control) => self.ed.insert_text(ch),
                _ => return,
            },
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn save(&mut self) {
        let out = self.ed.to_markdown();
        let target = self.path.clone().unwrap_or_else(|| std::env::temp_dir().join("markie-rich-sample.md"));
        self.status = match std::fs::write(&target, out) {
            Ok(()) => format!("Saved {}", target.display()),
            Err(e) => format!("Save failed: {e}"),
        };
    }

    /// The block as styled runs, with the caret and selection when active.
    fn styled_block(&self, block: usize, units: &[Unit], window: &Window, cx: &App) -> StyledText {
        let theme = cx.theme();
        let base = window.text_style().font();
        let active = block == self.ed.active;
        let sel = if active { self.ed.selection() } else { None };
        let mut text = String::new();
        let mut runs: Vec<TextRun> = Vec::new();
        let mut push = |s: &str, font: Font, color: Hsla, bg: Option<Hsla>, strike: bool, runs: &mut Vec<TextRun>| {
            if s.is_empty() {
                return;
            }
            text.push_str(s);
            runs.push(TextRun {
                len: s.len(),
                font,
                color,
                background_color: bg,
                underline: None,
                strikethrough: strike.then(|| StrikethroughStyle { thickness: px(1.), color: Some(color) }),
            });
        };
        let caret = |runs: &mut Vec<TextRun>, push: &mut dyn FnMut(&str, Font, Hsla, Option<Hsla>, bool, &mut Vec<TextRun>)| {
            push("▏", base.clone(), theme.primary, None, false, runs);
        };
        for (i, u) in units.iter().enumerate() {
            if active && i == self.ed.caret && sel.is_none() {
                caret(&mut runs, &mut push);
            }
            let mut font = base.clone();
            let mut color = theme.foreground;
            let mut strike = false;
            match u {
                Unit::Char(_, marks) => {
                    if marks.bold {
                        font.weight = FontWeight::BOLD;
                    }
                    if marks.italic {
                        font.style = FontStyle::Italic;
                    }
                    if marks.code {
                        font.family = theme.mono_font_family.clone();
                    }
                    if marks.link.is_some() {
                        color = theme.primary;
                    }
                    strike = marks.strike;
                }
                Unit::Atom(_) => {
                    font.family = theme.mono_font_family.clone();
                    color = theme.muted_foreground;
                }
            }
            let bg = sel.as_ref().filter(|r| r.contains(&i)).map(|_| theme.selection);
            push(&u.display(), font, color, bg, strike, &mut runs);
        }
        if active && self.ed.caret >= units.len() && sel.is_none() {
            caret(&mut runs, &mut push);
        }
        // An empty block still needs a line to click.
        if units.is_empty() && !active {
            push(" ", base.clone(), theme.foreground, None, false, &mut runs);
        }
        drop(push);
        StyledText::new(text).with_runs(runs)
    }
}

impl Focusable for RichView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for RichView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let mut blocks = Vec::new();
        for (i, b) in self.ed.doc.blocks.iter().enumerate() {
            let el = match text_block(b.nodes()) {
                Some((kind, _)) => {
                    let units = self.ed.units_of(i);
                    let styled = self.styled_block(i, &units, window, cx);
                    let size = match kind {
                        TextKind::Heading(1) => px(28.),
                        TextKind::Heading(2) => px(22.),
                        TextKind::Heading(_) => px(18.),
                        TextKind::Paragraph => px(15.),
                    };
                    div()
                        .id(("block", i))
                        .px_3()
                        .py_1()
                        .rounded_md()
                        .text_size(size)
                        .when(matches!(kind, TextKind::Heading(_)), |d| d.font_weight(FontWeight::SEMIBOLD))
                        .when(i == self.ed.active, |d| d.bg(theme.muted))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                                this.ed.activate(i, None);
                                cx.notify();
                            }),
                        )
                        .child(styled)
                        .into_any_element()
                }
                None => div()
                    .px_3()
                    .py_1()
                    .text_size(px(12.))
                    .font_family(theme.mono_font_family.clone())
                    .text_color(theme.muted_foreground)
                    .border_l_2()
                    .border_color(theme.border)
                    .child(self.ed.doc.block_markdown(i))
                    .into_any_element(),
            };
            blocks.push(el);
        }
        let (edited, kept) = self.ed.edit_counts();
        let active_md = self.ed.doc.block_markdown(self.ed.active);
        v_flex()
            .id("rich-editor")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(TitleBar::new().child(div().text_sm().child("Markie RS · rich editor spike")))
            .child(
                div()
                    .id("blocks")
                    .flex_1()
                    .overflow_y_scroll()
                    .px_8()
                    .py_6()
                    .child(v_flex().gap_2().max_w(px(760.)).children(blocks)),
            )
            .child(
                v_flex()
                    .px_4()
                    .py_2()
                    .gap_1()
                    .border_t_1()
                    .border_color(theme.border)
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(
                        h_flex()
                            .gap_4()
                            .child(format!("{edited} blocks rewritten, {kept} written from their own bytes"))
                            .child(self.status.clone()),
                    )
                    .child(
                        div()
                            .font_family(theme.mono_font_family.clone())
                            .child(format!("this block saves as: {}", active_md.replace('\n', "⏎"))),
                    ),
            )
    }
}

fn main() {
    let path = std::env::args_os().nth(1).map(PathBuf::from);
    gpui_kit::application().with_assets(gpui_kit::assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        cx.activate(true);
        let bounds = Bounds::centered(None, size(px(980.), px(760.)), cx);
        let options = WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..TitleBar::window_options() };
        gpui_kit::open_window(options, cx, move |window, cx| {
            Theme::sync_system_appearance(Some(window), cx);
            let view = cx.new(|cx| RichView::new(path, cx));
            let focus = view.read(cx).focus.clone();
            window.defer(cx, move |window, cx| focus.focus(window, cx));
            view
        })
        .expect("failed to open the rich editor window");
    });
}
