//! The side panel the "…" commands open: Font, Picture, Table, Link and Page
//! Breaks, Page Setup, Paragraph Spacing and Document Review. Ported from
//! `word-toolbar.tsx`, `word-links-and-breaks.tsx` and `word-review-tools.tsx`.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{ActiveTheme, Disableable as _, Selectable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_office::model::{Orientation, PageLayoutChange, Paper, ParagraphFormat, RunFormat};

use crate::commands::paper_of;
use crate::editor::{Common, MAX_PICTURE_BYTES, Tool};
use crate::view::WordView;

fn number(input: &Entity<InputState>, cx: &App) -> Option<f64> {
    input.read(cx).value().trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

fn trim(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded == rounded.trunc() { format!("{}", rounded as i64) } else { format!("{rounded}") }
}

impl WordView {
    pub(crate) fn open_tool(&mut self, tool: Tool, window: &mut Window, cx: &mut Context<Self>) {
        self.tool = Some(tool);
        let set = |input: &Entity<InputState>, value: String, window: &mut Window, cx: &mut Context<Self>| {
            input.update(cx, |state, cx| state.set_value(value, window, cx));
        };
        let format = self.editor.selection_format();
        let paragraph = self.editor.paragraph(&self.editor.focus.paragraph_id).cloned();
        let layout = self.editor.rich().page_layout;
        match tool {
            Tool::Font => {
                let family = match &format.font_family {
                    Common::Value(Some(f)) => f.clone(),
                    _ => String::new(),
                };
                let size = format.font_size_points.value().copied().flatten().map(trim).unwrap_or_default();
                let color = format.color.value().cloned().flatten().unwrap_or_default().to_uppercase();
                set(&self.inputs.font_family.clone(), family, window, cx);
                set(&self.inputs.font_size.clone(), size, window, cx);
                set(&self.inputs.color.clone(), color, window, cx);
            }
            Tool::Table => {
                set(&self.inputs.rows.clone(), "2".into(), window, cx);
                set(&self.inputs.columns.clone(), "2".into(), window, cx);
            }
            Tool::Link => {
                let target = self.editor.caret_link().map_or_else(|| "https://".to_string(), |l| l.target.clone());
                set(&self.inputs.link.clone(), target, window, cx);
            }
            Tool::Page => {
                let values = [layout.margin_top_points, layout.margin_bottom_points, layout.margin_left_points, layout.margin_right_points];
                for (input, value) in self.inputs.margins.clone().iter().zip(values) {
                    set(input, trim(value / 72.0), window, cx);
                }
            }
            Tool::Spacing => {
                let before = paragraph.as_ref().and_then(|p| p.spacing_before_points).unwrap_or(0.0);
                let after = paragraph.as_ref().and_then(|p| p.spacing_after_points).unwrap_or(0.0);
                set(&self.inputs.before.clone(), trim(before), window, cx);
                set(&self.inputs.after.clone(), trim(after), window, cx);
            }
            Tool::Review => {
                set(&self.inputs.author.clone(), self.editor.review_author.clone(), window, cx);
                if self.inputs.comment_author.read(cx).value().trim().is_empty() {
                    set(&self.inputs.comment_author.clone(), "You".into(), window, cx);
                }
            }
            Tool::Picture => {}
        }
    }

    fn choose_picture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Insert".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let too_big = std::fs::metadata(&path).map(|m| m.len() as usize > MAX_PICTURE_BYTES).unwrap_or(false);
            let bytes = if too_big { Err("Choose a PNG or JPEG smaller than 8 MB.".to_string()) } else { std::fs::read(&path).map_err(|e| e.to_string()) };
            this.update_in(cx, |this, window, cx| {
                match bytes {
                    Ok(bytes) => {
                        this.editor.insert_picture(bytes, &name);
                    }
                    Err(reason) => this.editor.error = Some(format!("{reason} The change was not applied.")),
                }
                this.edited(window, cx);
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn render_tool(&self, tool: Tool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let editor = &self.editor;
        let docx = editor.is_docx();
        let supported = docx || matches!(tool, Tool::Font | Tool::Spacing | Tool::Page);
        let read_only = !editor.can_mutate() || !supported;
        let label = |text: &str| div().text_xs().text_color(theme.muted_foreground).child(text.to_string());
        let note = |text: &str| div().text_xs().text_color(theme.muted_foreground).child(text.to_string());
        let field = |caption: &str, input: &Entity<InputState>| v_flex().gap_0p5().child(label(caption)).child(Input::new(input).small());
        let mut body = v_flex().gap_3();
        if !supported {
            body = body.child(note(&format!(
                "This tool is not supported for {} documents. The original file format is preserved.",
                format!("{:?}", editor.rich().format).to_uppercase()
            )));
        } else {
            body = match tool {
                Tool::Font => self.font_tool(read_only, &field, cx),
                Tool::Picture => self.picture_tool(read_only, cx),
                Tool::Table => self.table_tool(read_only, &field, cx),
                Tool::Link => self.link_tool(read_only, &field, cx),
                Tool::Page => self.page_tool(read_only, &field, cx),
                Tool::Spacing => self.spacing_tool(read_only, &field, cx),
                Tool::Review => self.review_tool(read_only, &field, cx),
            };
        }
        v_flex()
            .id("word-tool")
            .w(px(300.))
            .h_full()
            .flex_none()
            .overflow_y_scroll()
            .border_l_1()
            .border_color(theme.border)
            .bg(theme.background)
            .p_3()
            .gap_3()
            .child(
                h_flex()
                    .justify_between()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(tool.title()))
                    .child(Button::new("close-tool").xsmall().ghost().label("Close").on_click(cx.listener(|this, _, window, cx| {
                        this.tool = None;
                        this.focus.focus(window, cx);
                        this.changed(window, cx);
                    }))),
            )
            .child(body)
            .into_any_element()
    }

    fn font_tool(&self, read_only: bool, field: &dyn Fn(&str, &Entity<InputState>) -> Div, cx: &mut Context<Self>) -> Div {
        let inputs = &self.inputs;
        let (family, size, color) = (inputs.font_family.clone(), inputs.font_size.clone(), inputs.color.clone());
        let disabled = read_only || !self.editor.can_format_runs();
        let quick = ["Arial", "Calibri", "Georgia", "Times New Roman", "Helvetica"];
        v_flex()
            .gap_2()
            .child(field("Font", &inputs.font_family))
            .child(h_flex().flex_wrap().gap_1().children(quick.iter().map(|name| {
                let name = name.to_string();
                Button::new(SharedString::from(format!("font-{name}"))).xsmall().label(name.clone()).disabled(disabled).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.format_selection(RunFormat { font_family: Some(Some(name.clone())), ..Default::default() });
                    this.edited(window, cx);
                }))
            })))
            .child(field("Size (pt), 1 to 400", &inputs.font_size))
            .child(field("Text color (six hex digits; empty keeps the document color)", &inputs.color))
            .child(Button::new("apply-font").small().primary().label("Apply").disabled(disabled).on_click(cx.listener(move |this, _, window, cx| {
                let mut format = RunFormat::default();
                let name = family.read(cx).value().trim().to_string();
                format.font_family = Some((!name.is_empty()).then_some(name));
                match number(&size, cx) {
                    Some(v) if (1.0..=400.0).contains(&v) && (v * 2.0).fract() == 0.0 => format.font_size_points = Some(Some(v)),
                    Some(_) => {
                        this.editor.error = Some("Font sizes are 1 to 400 points in half-point steps. The change was not applied.".into());
                        this.changed(window, cx);
                        return;
                    }
                    None => {}
                }
                let hex = color.read(cx).value().trim().trim_start_matches('#').to_string();
                if !hex.is_empty() {
                    if crate::colors::parse_hex(&hex).is_none() {
                        this.editor.error = Some("Colors are six hex digits, for example C00000. The change was not applied.".into());
                        this.changed(window, cx);
                        return;
                    }
                    format.color = Some(Some(hex.to_uppercase()));
                }
                this.editor.format_selection(format);
                this.edited(window, cx);
            })))
            .child(Button::new("clear-color").small().label("Use document color").disabled(disabled).on_click(cx.listener(|this, _, window, cx| {
                this.editor.format_selection(RunFormat { color: Some(None), ..Default::default() });
                this.edited(window, cx);
            })))
    }

    fn picture_tool(&self, read_only: bool, cx: &mut Context<Self>) -> Div {
        let pictures: Vec<String> = self.editor.rich().images.iter().filter(|i| i.paragraph_id == self.editor.focus.paragraph_id).map(|i| i.id.clone()).collect();
        let in_table = self.editor.caret_table().is_some();
        let theme = cx.theme().clone();
        v_flex()
            .gap_2()
            .child(Button::new("choose-picture").small().primary().label("Choose picture…").disabled(read_only || in_table).on_click(cx.listener(|this, _, window, cx| this.choose_picture(window, cx))))
            .children(pictures.into_iter().map(|id| {
                Button::new(SharedString::from(format!("remove-picture-{id}"))).small().label("Remove picture").disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.delete_picture(&id);
                    this.edited(window, cx);
                }))
            }))
            .child(div().text_xs().text_color(theme.muted_foreground).child("Local PNG and JPEG pictures only, up to 8 MB. Select a body paragraph to insert a picture after it."))
    }

    fn table_tool(&self, read_only: bool, field: &dyn Fn(&str, &Entity<InputState>) -> Div, cx: &mut Context<Self>) -> Div {
        let table = self.editor.caret_table().map(|t| t.id.clone());
        let (rows, columns) = (self.inputs.rows.clone(), self.inputs.columns.clone());
        let theme = cx.theme().clone();
        v_flex()
            .gap_2()
            .child(h_flex().gap_2().child(field("Rows (1 to 20)", &self.inputs.rows)).child(field("Columns (1 to 10)", &self.inputs.columns)))
            .child(Button::new("insert-table").small().primary().label("Insert table").disabled(read_only || table.is_some()).on_click(cx.listener(move |this, _, window, cx| {
                let r = number(&rows, cx).unwrap_or(0.0);
                let c = number(&columns, cx).unwrap_or(0.0);
                if r.fract() != 0.0 || c.fract() != 0.0 || r < 1.0 || c < 1.0 {
                    this.editor.error = Some("Tables take 1 to 20 rows and 1 to 10 columns. The change was not applied.".into());
                } else {
                    this.editor.insert_table(r as usize, c as usize);
                }
                this.edited(window, cx);
            })))
            .when_some(table, |d, table| {
                d.child(Button::new("remove-table").small().label("Remove table").disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.delete_table(&table);
                    this.edited(window, cx);
                })))
            })
            .child(div().text_xs().text_color(theme.muted_foreground).child("Select a body paragraph to insert a table after it."))
    }

    fn link_tool(&self, read_only: bool, field: &dyn Fn(&str, &Entity<InputState>) -> Div, cx: &mut Context<Self>) -> Div {
        let editor = &self.editor;
        let read_only = read_only || editor.tracking || editor.paragraph(&editor.focus.paragraph_id).is_some_and(|p| !p.revision_ids.is_empty());
        let link = editor.caret_link().cloned();
        let target = self.inputs.link.clone();
        let breaks: Vec<String> = editor.rich().page_breaks.iter().filter(|b| b.paragraph_id == editor.focus.paragraph_id).map(|b| b.id.clone()).collect();
        let selected_text = !editor.is_collapsed() && !editor.is_cross();
        v_flex()
            .gap_2()
            .child(field("Link address", &self.inputs.link))
            .child(
                Button::new("set-link")
                    .small()
                    .primary()
                    .label(if link.is_some() && !selected_text { "Update link" } else { "Link selected text" })
                    .disabled(read_only || (link.is_none() && !selected_text))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let value = target.read(cx).value().trim().to_string();
                        this.editor.set_link(&value);
                        this.edited(window, cx);
                    })),
            )
            .when_some(link, |d, link| {
                let (id, url) = (link.id.clone(), link.target.clone());
                d.child(Button::new("remove-link").small().label("Remove link").disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.remove_link(&id);
                    this.edited(window, cx);
                })))
                .child(Button::new("open-link").small().label("Open link").on_click(move |_, _, cx| cx.open_url(&url)))
            })
            .child(Button::new("page-break-here").small().label("Page break at cursor").disabled(read_only || !editor.is_collapsed()).on_click(cx.listener(|this, _, window, cx| {
                this.editor.insert_page_break();
                this.edited(window, cx);
            })))
            .children(breaks.into_iter().enumerate().map(|(i, id)| {
                Button::new(SharedString::from(format!("remove-break-{id}"))).small().label(format!("Remove page break {}", i + 1)).disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.remove_page_break(&id);
                    this.edited(window, cx);
                }))
            }))
    }

    fn page_tool(&self, read_only: bool, field: &dyn Fn(&str, &Entity<InputState>) -> Div, cx: &mut Context<Self>) -> Div {
        let layout = self.editor.rich().page_layout;
        let current = paper_of(layout.width_points, layout.height_points);
        let theme = cx.theme().clone();
        let papers = [(Paper::Letter, "Letter"), (Paper::A4, "A4"), (Paper::Legal, "Legal")];
        let margins = self.inputs.margins.clone();
        v_flex()
            .gap_2()
            .child(div().text_xs().text_color(theme.muted_foreground).child("Paper"))
            .child(h_flex().gap_1().children(papers.into_iter().map(|(paper, name)| {
                Button::new(SharedString::from(format!("paper-{name}"))).small().label(name).selected(current == Some(paper)).disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.set_page_layout(PageLayoutChange { paper: Some(paper), ..Default::default() });
                    this.edited(window, cx);
                }))
            })))
            .child(div().text_xs().text_color(theme.muted_foreground).child(format!("{} × {} in", trim(layout.width_points / 72.0), trim(layout.height_points / 72.0))))
            .child(div().text_xs().text_color(theme.muted_foreground).child("Orientation"))
            .child(h_flex().gap_1().children([(Orientation::Portrait, "Portrait"), (Orientation::Landscape, "Landscape")].into_iter().map(|(o, name)| {
                Button::new(SharedString::from(format!("orientation-{name}"))).small().label(name).selected(layout.orientation == o).disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.set_page_layout(PageLayoutChange { orientation: Some(o), ..Default::default() });
                    this.edited(window, cx);
                }))
            })))
            .child(div().text_xs().text_color(theme.muted_foreground).child("Margins (inches, 0 to 4)"))
            .child(
                h_flex()
                    .gap_1()
                    .child(field("Top", &self.inputs.margins[0]))
                    .child(field("Bottom", &self.inputs.margins[1]))
                    .child(field("Left", &self.inputs.margins[2]))
                    .child(field("Right", &self.inputs.margins[3])),
            )
            .child(Button::new("apply-margins").small().primary().label("Apply margins").disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                let values: Vec<Option<f64>> = margins.iter().map(|m| number(m, cx)).collect();
                if values.iter().any(|v| v.is_none_or(|v| !(0.0..=4.0).contains(&v))) {
                    this.editor.error = Some("Margins are 0 to 4 inches. The change was not applied.".into());
                } else {
                    let points: Vec<f64> = values.into_iter().map(|v| v.unwrap() * 72.0).collect();
                    this.editor.set_page_layout(PageLayoutChange {
                        margin_top_points: Some(points[0]),
                        margin_bottom_points: Some(points[1]),
                        margin_left_points: Some(points[2]),
                        margin_right_points: Some(points[3]),
                        ..Default::default()
                    });
                }
                this.edited(window, cx);
            })))
    }

    fn spacing_tool(&self, read_only: bool, field: &dyn Fn(&str, &Entity<InputState>) -> Div, cx: &mut Context<Self>) -> Div {
        let read_only = read_only || !self.editor.can_format_paragraph();
        let current = self.editor.paragraph(&self.editor.focus.paragraph_id).and_then(|p| p.line_spacing_multiple);
        let (before, after) = (self.inputs.before.clone(), self.inputs.after.clone());
        v_flex()
            .gap_2()
            .child(h_flex().gap_2().child(field("Space before (pt)", &self.inputs.before)).child(field("Space after (pt)", &self.inputs.after)))
            .child(Button::new("apply-spacing").small().primary().label("Apply spacing").disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                let (b, a) = (number(&before, cx), number(&after, cx));
                if [b, a].iter().any(|v| v.is_none_or(|v| !(0.0..=500.0).contains(&v))) {
                    this.editor.error = Some("Spacing is 0 to 500 points. The change was not applied.".into());
                } else {
                    this.editor.set_spacing(ParagraphFormat { spacing_before_points: Some(b), spacing_after_points: Some(a), ..Default::default() });
                }
                this.edited(window, cx);
            })))
            .child(h_flex().gap_1().children([1.0, 1.5, 2.0].into_iter().map(|multiple| {
                Button::new(SharedString::from(format!("line-{multiple}"))).small().label(format!("{}× spacing", trim(multiple))).selected(current == Some(multiple)).disabled(read_only).on_click(cx.listener(move |this, _, window, cx| {
                    this.editor.set_spacing(ParagraphFormat { line_spacing_multiple: Some(Some(multiple)), ..Default::default() });
                    this.edited(window, cx);
                }))
            })))
    }

    fn review_tool(&self, read_only: bool, field: &dyn Fn(&str, &Entity<InputState>) -> Div, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme().clone();
        let editor = &self.editor;
        let doc = editor.rich().clone();
        let comments_locked = read_only || !doc.revisions.is_empty();
        let author = self.inputs.author.clone();
        let (comment_author, comment_text) = (self.inputs.comment_author.clone(), self.inputs.comment_text.clone());
        let chars: usize = doc.text.chars().count();
        v_flex()
            .gap_2()
            .child(div().text_sm().child(format!("{} words · {chars} characters · {} paragraphs", editor.word_count(), doc.paragraphs.len())))
            .child(field("Revision author", &self.inputs.author))
            .child(
                Button::new("toggle-tracking")
                    .small()
                    .label("Track paragraph text only")
                    .selected(editor.tracking)
                    .disabled(read_only)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.editor.review_author = author.read(cx).value().trim().to_string();
                        let on = !this.editor.tracking;
                        this.editor.set_tracking(on);
                        this.changed(window, cx);
                    })),
            )
            .child(
                h_flex()
                    .gap_1()
                    .child(Button::new("accept-all").small().label("Accept all").disabled(read_only || doc.revisions.is_empty()).on_click(cx.listener(|this, _, window, cx| {
                        this.editor.accept_all();
                        this.edited(window, cx);
                    })))
                    .child(Button::new("reject-all").small().label("Reject all").disabled(read_only || doc.revisions.is_empty()).on_click(cx.listener(|this, _, window, cx| {
                        this.editor.reject_all();
                        this.edited(window, cx);
                    }))),
            )
            .child(div().text_xs().text_color(theme.muted_foreground).child(
                "Tracks text edits inside existing paragraphs. Font, layout, new paragraph, table and picture changes are not tracked.",
            ))
            .child(
                h_flex()
                    .gap_1()
                    .child(Button::new("final-text").small().label("Final text").selected(!editor.original_view).on_click(cx.listener(|this, _, window, cx| {
                        this.editor.set_original_view(false);
                        this.changed(window, cx);
                    })))
                    .child(Button::new("original-text").small().label("Original text").selected(editor.original_view).disabled(doc.original_text.is_none()).on_click(cx.listener(|this, _, window, cx| {
                        this.editor.set_original_view(true);
                        this.changed(window, cx);
                    }))),
            )
            .child(div().text_xs().text_color(theme.muted_foreground).child(if doc.revisions.is_empty() {
                "No pending tracked text changes.".to_string()
            } else {
                format!("{} tracked changes, shown in the margin.", doc.revisions.len())
            }))
            .child(field("Comment author", &self.inputs.comment_author))
            .child(field("Comment on the selected paragraph", &self.inputs.comment_text))
            .child(Button::new("add-comment").small().primary().label("Add comment").disabled(comments_locked).on_click(cx.listener(move |this, _, window, cx| {
                let text = comment_text.read(cx).value().to_string();
                let who = comment_author.read(cx).value().to_string();
                if this.editor.add_comment(&text, &who) {
                    comment_text.update(cx, |state, cx| state.set_value("", window, cx));
                }
                this.edited(window, cx);
            })))
            .when(!doc.revisions.is_empty(), |d| d.child(div().text_xs().text_color(theme.muted_foreground).child("Resolve tracked text changes before changing comments.")))
            .children(doc.comments.iter().map(|comment| {
                let id = comment.id.clone();
                v_flex()
                    .gap_0p5()
                    .p_2()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .text_xs()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(comment.author.clone()))
                    .child(comment.text.clone())
                    .child(Button::new(SharedString::from(format!("delete-comment-{id}"))).xsmall().label("Delete comment").disabled(comments_locked).on_click(cx.listener(move |this, _, window, cx| {
                        this.editor.delete_comment(&id);
                        this.edited(window, cx);
                    })))
            }))
            .when(!doc.diagnostics.is_empty(), |d| {
                d.child(div().text_xs().font_weight(FontWeight::SEMIBOLD).child("Document compatibility"))
                    .children(doc.diagnostics.iter().map(|item| div().text_xs().text_color(theme.muted_foreground).child(item.message.clone())))
            })
    }
}
