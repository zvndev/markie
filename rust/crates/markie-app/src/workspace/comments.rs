//! Comments beside the document.
//!
//! * Cloud threads on a live rich document, in the right margin
//!   (`src/components/comments.tsx`): a bubble per open thread at its
//!   anchor, the thread card beside it, "Comment" on a selection, a
//!   resolved list, polled every 15 s. Anchors are Y.RelativePosition JSON,
//!   made and read by the rich binding exactly as TipTap does.
//! * Local comments on a local Markdown file (`local-comments.tsx`, a
//!   super-nightly feature in Electron, here behind `MARKIE_RS_NIGHTLY=1` or
//!   the `nightly` setting): a panel on the right, passages tinted in View,
//!   detached threads listed apart. Stored in Markie RS's own data folder in
//!   Electron's `doc-meta` format.
use std::cell::Cell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::input::{InputEvent, TextDecoration, TextDecorationCollection, Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::Value;

use markie_cloud::collab::{color_for_name, runtime};
use markie_cloud::comments::local::{Author, LocalComments, LocalThread, PlacedThread, Status, is_commentable_doc};
use markie_cloud::comments::project::{Range as TextRange, markdown_to_visible, visible_to_markdown};
use markie_cloud::comments::anchor::make_anchor;
use markie_cloud::comments::{CommentThread, CommentsClient, ThreadStatus};
use markie_cloud::docs::Role;
use markie_editor::RichView;
use markie_rich::edit::Unit;
use markie_rich::editor::{Editor, Pos};

use super::collab::avatar;
use super::{DocKind, Mode, OpenDoc, Workspace};
use crate::themes::{self, Palette, hex};

const POLL: Duration = Duration::from_secs(15);
/// Least vertical space between two bubbles.
const BUBBLE_GAP: f32 = 30.;

/// `toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})`.
fn fmt_time(iso: &str) -> String {
    use chrono::{Local, TimeZone};
    let parsed = chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| d.with_timezone(&Local))
        .ok()
        .or_else(|| chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S").ok().and_then(|n| chrono::Utc.from_utc_datetime(&n).with_timezone(&Local).into()));
    match parsed {
        Some(d) => d.format("%b %-d, %-I:%M %p").to_string(),
        None => iso.to_string(),
    }
}

fn short_quote(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 140 { format!("{}…", flat.chars().take(139).collect::<String>()) } else { flat }
}

pub(super) fn nightly(reg: Option<&markie_core::registry::Registry>) -> bool {
    std::env::var("MARKIE_RS_NIGHTLY").is_ok_and(|v| v == "1") || reg.and_then(|r| r.setting("nightly").ok().flatten()).as_deref() == Some("1")
}

/// A composer: the text field and what Enter does with it.
pub(super) struct Composer {
    pub input: Entity<TextareaState>,
    _sub: Subscription,
}

#[derive(Clone)]
enum Submit {
    NewCloud,
    ReplyCloud(String),
    NewLocal,
    ReplyLocal(String),
}

#[derive(Default)]
pub(super) struct Comments {
    // Cloud threads (live rich documents).
    threads: Option<Vec<CommentThread>>,
    open_thread: Option<String>,
    composing: Option<(Pos, Pos)>,
    show_resolved: bool,
    composers: HashMap<String, Composer>,
    _poll: Option<Task<()>>,
    origin: Rc<Cell<Option<Bounds<Pixels>>>>,
    error: Option<String>,
    // Local comments.
    local: Option<LocalPanel>,
    /// The window y of the last mouse up in Source.
    source_up: Option<Pixels>,
    /// The commented passages tinted in Source (`source-comments.ts`), and
    /// what they were drawn for (text, threads, active), to redraw on change.
    source_marks: Option<TextDecorationCollection>,
    source_marks_for: Option<u64>,
}

struct LocalPanel {
    path: PathBuf,
    store: LocalComments,
    threads: Vec<LocalThread>,
    open: bool,
    active: Option<String>,
    show_resolved: bool,
    composing: Option<markie_cloud::comments::anchor::TextAnchor>,
    error: Option<String>,
    /// The file's state as last seen on disk, to pick up an agent's comment.
    stamp: Option<std::time::SystemTime>,
    _watch: Option<Task<()>>,
}

impl Workspace {
    pub(super) fn comments_reset(&mut self, cx: &mut Context<Self>) {
        if let Some(marks) = self.collab.comments.source_marks.take() {
            marks.clear(cx);
        }
        self.collab.comments = Comments::default();
        self.rich.update(cx, |r, cx| {
            if !r.comment_marks.is_empty() {
                r.comment_marks.clear();
                cx.notify();
            }
        });
    }

    /// A two-row text area like comments.tsx's: Enter sends, Shift+Enter
    /// starts a new line, Escape cancels a new comment.
    fn composer(&mut self, key: &str, placeholder: &'static str, submit: Submit, window: &mut Window, cx: &mut Context<Self>) -> Entity<TextareaState> {
        if let Some(c) = self.collab.comments.composers.get(key) {
            return c.input.clone();
        }
        let input = cx.new(|cx| TextareaState::new(window, cx).rows(2).submit_on_enter(true).placeholder(placeholder));
        let sub = cx.subscribe_in(&input, window, move |this, state, ev: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { shift: false, .. } = ev {
                let body = state.read(cx).value().trim().to_string();
                if body.is_empty() {
                    return;
                }
                state.update(cx, |s, cx| s.set_value("", window, cx));
                this.submit_comment(submit.clone(), body, cx);
            }
        });
        self.collab.comments.composers.insert(key.to_string(), Composer { input: input.clone(), _sub: sub });
        input
    }

    fn submit_comment(&mut self, what: Submit, body: String, cx: &mut Context<Self>) {
        match what {
            Submit::NewCloud => {
                // The composer stays (this may run inside its own Enter event).
                let Some((from, to)) = self.collab.comments.composing.take() else { return };
                let anchor = self.live_rich_binding().and_then(|b| b.anchor_for(&self.rich.read(cx).editor, from, to));
                let Some(anchor) = anchor else { return };
                self.cloud_call(move |c, id| Box::pin(async move { CommentsClient::new(&c).create_thread(&id, anchor, &body).await.map(|_| ()) }), cx);
            }
            Submit::ReplyCloud(tid) => {
                self.cloud_call(move |c, id| Box::pin(async move { CommentsClient::new(&c).reply(&id, &tid, &body).await.map(|_| ()) }), cx);
            }
            Submit::NewLocal => {
                let Some(panel) = self.collab.comments.local.as_mut() else { return };
                let Some(anchor) = panel.composing.take() else { return };
                let r = panel.store.add_from_user(&panel.path, anchor, &body);
                self.local_result(r.map(|_| ()), cx);
            }
            Submit::ReplyLocal(tid) => {
                let Some(panel) = self.collab.comments.local.as_ref() else { return };
                let r = panel.store.reply(&panel.path, &tid, &body, Author::User);
                self.local_result(r.map(|_| ()), cx);
            }
        }
        cx.notify();
    }

    /// Cancel (or Escape) on a new comment: the composer goes.
    fn composer_cancel(&mut self, key: &'static str, cx: &mut Context<Self>) {
        match key {
            "new" => self.collab.comments.composing = None,
            "local-new" => {
                if let Some(panel) = self.collab.comments.local.as_mut() {
                    panel.composing = None;
                }
            }
            _ => return,
        }
        self.collab.comments.composers.remove(key);
        cx.notify();
    }

    // ------------------------------------------------------------ cloud

    /// The live rich room is ready: load its threads, and every 15 s after.
    pub(super) fn cloud_comments_open(&mut self, cx: &mut Context<Self>) {
        if self.live_rich_binding().is_none() {
            return;
        }
        self.collab.comments.local = None;
        self.cloud_refresh(cx);
        self.collab.comments._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                // Paused while the window is hidden, so a document left open
                // overnight does not ask thousands of times (comments.tsx).
                if this.update(cx, |w, cx| if w.cloud.window_visible { w.cloud_refresh(cx) }).is_err() {
                    return;
                }
            }
        }));
    }

    /// The window came back into view: refresh at once, as comments.tsx does
    /// on `visibilitychange`.
    pub(super) fn cloud_comments_visible(&mut self, cx: &mut Context<Self>) {
        if self.collab.comments._poll.is_some() && self.live_rich_binding().is_some() {
            self.cloud_refresh(cx);
        }
    }

    fn cloud_refresh(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = self.collab.cloud.clone() else { return };
        let task = runtime::handle().spawn(async move { CommentsClient::new(&cloud.account.client).list(&cloud.doc_id).await });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(threads)) = task.await else { return };
            this.update(cx, |w, cx| {
                w.collab.comments.threads = Some(threads);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// One REST call on the document's server, then a refresh.
    fn cloud_call<F>(&mut self, f: F, cx: &mut Context<Self>)
    where
        F: FnOnce(std::sync::Arc<markie_cloud::CloudClient>, String) -> std::pin::Pin<Box<dyn std::future::Future<Output = markie_cloud::error::Result<()>> + Send>> + Send + 'static,
    {
        let Some(cloud) = self.collab.cloud.clone() else { return };
        let task = runtime::handle().spawn(f(cloud.account.client.clone(), cloud.doc_id.clone()));
        cx.spawn(async move |this, cx| {
            let ok = matches!(task.await, Ok(Ok(())));
            this.update(cx, |w, cx| {
                w.collab.comments.error = (!ok).then(|| "Couldn't save the comment. Check your connection and try again.".to_string());
                w.cloud_refresh(cx);
            })
            .ok();
        })
        .detach();
    }

    fn can_moderate(&self) -> bool {
        self.collab.access.as_ref().is_some_and(|a| a.role == Role::Owner)
    }

    fn me(&self) -> Option<String> {
        self.collab.cloud.as_ref().map(|c| c.account.user.id.clone())
    }

    /// The margin over a live rich document.
    fn render_cloud_comments(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.live_rich_binding()?;
        let p = themes::palette(cx);
        let origin = self.collab.comments.origin.clone();
        let o = origin.get().map(|b| b.origin).unwrap_or_default();
        let readonly = !self.doc_editable();
        let can_comment = self.collab.note != Some(markie_cloud::sharing::view::ACCESS_REVOKED_LINE);
        let (bubbles, sel_top, composer_top) = {
            let rich = self.rich.read(cx);
            let binding = self.live_rich_binding()?;
            let ed = &rich.editor;
            let threads = self.collab.comments.threads.clone().unwrap_or_default();
            let mut bubbles: Vec<(CommentThread, f32, Pos, Pos)> = Vec::new();
            for t in threads.iter().filter(|t| t.status == ThreadStatus::Open) {
                let Some((f, to)) = binding.resolve_anchor(ed, &t.anchor) else { continue };
                let Some(rect) = rich.caret_rect(f) else { continue };
                bubbles.push((t.clone(), f32::from(rect.origin.y - o.y), f, to));
            }
            bubbles.sort_by(|a, b| a.1.total_cmp(&b.1));
            for i in 1..bubbles.len() {
                if bubbles[i].1 - bubbles[i - 1].1 < BUBBLE_GAP {
                    bubbles[i].1 = bubbles[i - 1].1 + BUBBLE_GAP;
                }
            }
            let (from, to) = ed.range();
            let sel_top = (ed.has_selection() && can_comment && self.collab.comments.composing.is_none())
                .then(|| rich.caret_rect(to).map(|r| f32::from(r.origin.y - o.y)))
                .flatten();
            let composer_top = self.collab.comments.composing.and_then(|(f, _)| rich.caret_rect(f)).map(|r| f32::from(r.origin.y - o.y));
            let _ = from;
            (bubbles, sel_top, composer_top)
        };
        let resolved: Vec<CommentThread> = self.collab.comments.threads.iter().flatten().filter(|t| t.status == ThreadStatus::Resolved).cloned().collect();
        let open_id = self.collab.comments.open_thread.clone();
        let open_bubble = bubbles.iter().find(|b| Some(&b.0.id) == open_id.as_ref()).cloned();
        let composer_input = composer_top.map(|_| self.composer("new", "Comment…", Submit::NewCloud, window, cx));
        let reply_input = open_bubble
            .as_ref()
            .filter(|b| can_comment && b.0.status == ThreadStatus::Open)
            .map(|b| self.composer(&format!("reply-{}", b.0.id), "Reply…", Submit::ReplyCloud(b.0.id.clone()), window, cx));
        let resolved_cards: Vec<AnyElement> = if self.collab.comments.show_resolved {
            resolved.iter().map(|t| self.cloud_thread_card(t, readonly, can_comment, None, &p, cx)).collect()
        } else {
            vec![]
        };
        let open_card = open_bubble.as_ref().map(|b| self.cloud_thread_card(&b.0, readonly, can_comment, reply_input.clone(), &p, cx));

        let surface2 = p.surface2;
        let el = div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(
                canvas(move |bounds, _, _| origin.set(Some(bounds)), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            // Resolved toggle.
            .when(!resolved.is_empty(), |el| {
                let n = resolved.len();
                let shown = self.collab.comments.show_resolved;
                el.child(
                    div()
                        .absolute()
                        .top(px(8.))
                        .right(px(8.))
                        .child(
                            div()
                                .id("comments-resolved")
                                .px(px(8.))
                                .py(px(2.))
                                .rounded_full()
                                .bg(surface2)
                                .border_1()
                                .border_color(p.border)
                                .text_size(px(11.))
                                .text_color(p.muted)
                                .hover(|s| s.text_color(p.foreground))
                                .cursor_pointer()
                                .child(format!("{n} resolved {}", if shown { "▴" } else { "▾" }))
                                .on_click(cx.listener(|w, _, _, cx| {
                                    w.collab.comments.show_resolved = !w.collab.comments.show_resolved;
                                    cx.notify();
                                })),
                        )
                        .when(shown, |el| {
                            el.child(
                                div()
                                    .id("comments-resolved-list")
                                    .absolute()
                                    .right_0()
                                    .top(px(26.))
                                    .w(px(280.))
                                    .max_h(px(360.))
                                    .overflow_y_scroll()
                                    .rounded(px(8.))
                                    .border_1()
                                    .border_color(p.border)
                                    .bg(surface2)
                                    .shadow_xl()
                                    .p(px(8.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .children(resolved_cards),
                            )
                        }),
                )
            })
            // "Comment" on a selection.
            .when_some(sel_top, |el, top| {
                el.child(
                    div()
                        .id("comment-start")
                        .absolute()
                        .top(px(top))
                        .right(px(6.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .px(px(8.))
                        .py(px(4.))
                        .rounded_full()
                        .border_1()
                        .border_color(p.border)
                        .bg(surface2)
                        .shadow_lg()
                        .text_size(px(11.))
                        .text_color(p.muted)
                        .hover(|s| s.text_color(p.foreground))
                        .cursor_pointer()
                        .child(svg().path("markie/comment.svg").size(px(11.)).text_color(p.muted))
                        .child("Comment")
                        .on_click(cx.listener(|w, _, window, cx| {
                            let range = w.rich.read(cx).editor.range();
                            w.collab.comments.composing = Some(range);
                            w.collab.comments.open_thread = None;
                            let input = w.composer("new", "Comment…", Submit::NewCloud, window, cx);
                            input.update(cx, |s, cx| s.focus(window, cx));
                            cx.notify();
                        })),
                )
            })
            // The new-thread composer.
            .when_some(composer_top.zip(composer_input), |el, (top, input)| {
                el.child(div().absolute().top(px(top)).right(px(6.)).w(px(260.)).child(composer_box(&input, true, &p, cx.listener(|w, _, _, cx| w.composer_cancel("new", cx)), cx.listener(|w, _, _, cx| w.composer_cancel("new", cx)), cx.listener(|w, _, window, cx| {
                    if let Some(c) = w.collab.comments.composers.get("new") {
                        let body = c.input.read(cx).value().trim().to_string();
                        if !body.is_empty() {
                            c.input.update(cx, |s, cx| s.set_value("", window, cx));
                            w.submit_comment(Submit::NewCloud, body, cx);
                        }
                    }
                }))))
            })
            // Gutter bubbles.
            .children(bubbles.iter().map(|(t, top, from, to)| {
                let first = t.comments.first();
                let author = first.and_then(|c| c.author_name.clone()).unwrap_or_else(|| "?".into());
                let tip = format!("{}: {}", author, first.map(|c| c.body.chars().take(60).collect::<String>()).unwrap_or_default());
                let (id, from, to) = (t.id.clone(), *from, *to);
                div()
                    .id(SharedString::from(format!("bubble-{}", t.id)))
                    .absolute()
                    .top(px(*top))
                    .right(px(6.))
                    .size(px(24.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(9.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hsla(0., 0., 0., 0.8))
                    .bg(hex(color_for_name(&author)))
                    .shadow_md()
                    .cursor_pointer()
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip.clone()).build(window, cx))
                    .child(t.comments.len().to_string())
                    .on_click(cx.listener(move |w, _, window, cx| {
                        let open = &mut w.collab.comments.open_thread;
                        *open = if open.as_deref() == Some(id.as_str()) { None } else { Some(id.clone()) };
                        w.rich.update(cx, |r, cx| {
                            r.editor.set_selection(from, to);
                            r.focus(window, cx);
                            cx.notify();
                        });
                        cx.notify();
                    }))
            }))
            // The open thread.
            .when_some(open_bubble.zip(open_card), |el, (b, card)| {
                el.child(div().absolute().top(px(b.1)).right(px(36.)).w(px(280.)).rounded(px(8.)).border_1().border_color(p.border).bg(surface2).shadow_xl().child(card))
            })
            .when_some(self.collab.comments.error.clone(), |el, e| {
                el.child(div().absolute().bottom(px(8.)).right(px(8.)).text_size(px(11.)).text_color(p.red).child(e))
            });
        let _ = window;
        Some(el.into_any_element())
    }

    fn cloud_thread_card(&self, t: &CommentThread, readonly: bool, can_comment: bool, reply: Option<Entity<TextareaState>>, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let resolved = t.status == ThreadStatus::Resolved;
        let me = self.me();
        let moderate = self.can_moderate();
        let tid = t.id.clone();
        let tid2 = t.id.clone();
        v_flex()
            .p(px(10.))
            .gap(px(8.))
            .child(
                h_flex()
                    .justify_between()
                    .child(div().text_size(px(10.)).text_color(if resolved { p.green } else { p.muted }).child(if resolved { "RESOLVED" } else { "OPEN" }))
                    .child(
                        h_flex()
                            .gap(px(8.))
                            .when(!readonly, |el| {
                                el.child(
                                    div()
                                        .id(SharedString::from(format!("status-{}", t.id)))
                                        .text_size(px(11.))
                                        .text_color(p.muted)
                                        .hover(|s| s.text_color(p.foreground))
                                        .cursor_pointer()
                                        .child(if resolved { "Reopen" } else { "Resolve" })
                                        .on_click(cx.listener(move |w, _, _, cx| {
                                            let next = if resolved { ThreadStatus::Open } else { ThreadStatus::Resolved };
                                            let tid = tid.clone();
                                            w.cloud_call(move |c, id| Box::pin(async move { CommentsClient::new(&c).set_status(&id, &tid, next).await }), cx);
                                        })),
                                )
                            })
                            .child(
                                div()
                                    .id(SharedString::from(format!("close-{}", t.id)))
                                    .text_size(px(13.))
                                    .text_color(p.muted)
                                    .hover(|s| s.text_color(p.foreground))
                                    .cursor_pointer()
                                    .child("×")
                                    .on_click(cx.listener(|w, _, _, cx| {
                                        w.collab.comments.open_thread = None;
                                        w.collab.comments.show_resolved = false;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .children(t.comments.iter().map(|c| {
                let name = c.author_name.clone().filter(|n| !n.is_empty()).or_else(|| c.author_email.clone()).unwrap_or_default();
                let mine = me.as_deref() == Some(c.author_id.as_str()) || moderate;
                let (tid, cid) = (tid2.clone(), c.id.clone());
                comment_row(&name, &fmt_time(&c.created_at), &c.body, p).when(mine, |el| {
                    el.child(
                        div()
                            .id(SharedString::from(format!("del-{}", c.id)))
                            .text_size(px(11.))
                            .text_color(p.muted)
                            .hover(|s| s.text_color(p.red))
                            .cursor_pointer()
                            .child("×")
                            .on_click(cx.listener(move |w, _, _, cx| {
                                let (tid, cid) = (tid.clone(), cid.clone());
                                w.cloud_call(move |c, id| Box::pin(async move { CommentsClient::new(&c).delete_comment(&id, &tid, &cid).await }), cx);
                            })),
                    )
                })
            }))
            .when_some(reply.filter(|_| can_comment && !resolved), |el, input| {
                let tid = tid2.clone();
                let key = format!("reply-{tid}");
                el.child(composer_box(&input, false, p, cx.listener(|_, _, _, _| {}), cx.listener(|_, _, _, _| {}), cx.listener(move |w, _, window, cx| {
                    if let Some(c) = w.collab.comments.composers.get(&key) {
                        let body = c.input.read(cx).value().trim().to_string();
                        if !body.is_empty() {
                            c.input.update(cx, |s, cx| s.set_value("", window, cx));
                            w.submit_comment(Submit::ReplyCloud(tid.clone()), body, cx);
                        }
                    }
                })))
            })
            .into_any_element()
    }

    // ------------------------------------------------------------ local

    /// A local Markdown file was opened: its comments, if the feature is on.
    pub(super) fn local_comments_open(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDoc { path, large: false, kind: DocKind::Text { .. }, .. }) = self.doc.as_ref() else { return };
        if !is_commentable_doc(path) || !nightly(self.registry.as_deref()) {
            return;
        }
        let path = path.clone();
        let store = LocalComments::new(&markie_core::paths::data_dir());
        let threads = store.threads(&path);
        let watch = cx.spawn(async move |this, cx| {
            // An agent's comment reaches the file's records without a reload.
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |w, cx| w.local_poll(cx)).is_err() {
                    return;
                }
            }
        });
        let stamp = std::fs::metadata(store.dir_for(&path).join("comments.json")).and_then(|m| m.modified()).ok();
        self.collab.comments.local = Some(LocalPanel { path, store, threads, open: false, active: None, show_resolved: false, composing: None, error: None, stamp, _watch: Some(watch) });
        self.local_marks(cx);
    }

    fn local_poll(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.collab.comments.local.as_mut() else { return };
        let stamp = std::fs::metadata(panel.store.dir_for(&panel.path).join("comments.json")).and_then(|m| m.modified()).ok();
        if stamp != panel.stamp {
            panel.stamp = stamp;
            panel.threads = panel.store.threads(&panel.path);
            self.local_marks(cx);
            cx.notify();
        } else {
            // Source's text may have been replaced (a switch from View, a
            // reload): draw its marks again when what they depend on moved.
            self.source_marks(cx);
        }
    }

    /// Tint every anchored, open passage in Source, as CodeMirror's
    /// `commentHighlightField` does: `rgba(96,165,250,0.14)` (0.32 for the
    /// active thread) with a 2 px `rgba(96,165,250,0.7)` underline. Not while
    /// the document is live, when local comments are hidden.
    fn source_marks(&mut self, cx: &mut Context<Self>) {
        use std::hash::{Hash, Hasher};
        let text = self.editor.read(cx).value().to_string();
        let live = self.live_running();
        let Some(panel) = self.collab.comments.local.as_ref() else { return };
        let mut h = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut h);
        panel.stamp.hash(&mut h);
        panel.active.hash(&mut h);
        live.hash(&mut h);
        panel.threads.len().hash(&mut h);
        let key = h.finish();
        if self.collab.comments.source_marks_for == Some(key) {
            return;
        }
        let decorations: Vec<TextDecoration> = if live {
            Vec::new()
        } else {
            source_decorations(&panel.threads, &text, panel.active.as_deref())
        };
        self.collab.comments.source_marks_for = Some(key);
        match &self.collab.comments.source_marks {
            Some(marks) => marks.set(decorations, cx),
            None => {
                let marks = self.editor.update(cx, |e, cx| e.create_decorations_collection(decorations, cx));
                self.collab.comments.source_marks = Some(marks);
            }
        }
    }

    fn local_result(&mut self, r: Result<(), String>, cx: &mut Context<Self>) {
        let Some(panel) = self.collab.comments.local.as_mut() else { return };
        match r {
            Ok(()) => {
                panel.error = None;
                panel.threads = panel.store.threads(&panel.path);
                panel.stamp = std::fs::metadata(panel.store.dir_for(&panel.path).join("comments.json")).and_then(|m| m.modified()).ok();
            }
            Err(e) => panel.error = Some(e),
        }
        self.local_marks(cx);
        cx.notify();
    }

    /// The editor's text as View shows it, with the editor position of each
    /// UTF-16 unit (the rich pane's comment target).
    fn visible_text(ed: &Editor) -> (String, Vec<Pos>) {
        let mut text = String::new();
        let mut map = Vec::new();
        let mut first = true;
        for b in 0..ed.block_count() {
            for l in 0..ed.leaves_of(b).len() {
                if !first {
                    text.push('\n');
                    map.push(Pos::new(b, l, 0));
                }
                first = false;
                for (i, u) in ed.units(b, l).iter().enumerate() {
                    if let Unit::Char(c, _) = u {
                        text.push(*c);
                        for _ in 0..c.len_utf16() {
                            map.push(Pos::new(b, l, i));
                        }
                    }
                }
            }
        }
        (text, map)
    }

    fn markdown_now(&self, cx: &App) -> String {
        self.current_text(cx)
    }

    /// Tint every anchored passage in View.
    fn local_marks(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.collab.comments.local.as_ref() else { return };
        let md = self.markdown_now(cx);
        let active = panel.active.clone();
        let placed = place(&panel.threads, &md);
        let marks = {
            let ed = &self.rich.read(cx).editor;
            let (visible, map) = Self::visible_text(ed);
            placed
                .iter()
                .filter(|p| p.thread.status == Status::Open)
                .filter_map(|p| {
                    let r = p.range?;
                    let v = markdown_to_visible(&md, TextRange { from: r.start, to: r.end }, &visible)?;
                    let from = *map.get(v.from)?;
                    let last = *map.get(v.to.saturating_sub(1))?;
                    let to = Pos { offset: last.offset + 1, ..last };
                    let a = if active.as_deref() == Some(p.thread.id.as_str()) { 0.32 } else { 0.14 };
                    Some((from, to, Hsla::from(rgba(0x60a5fa00 | ((a * 255.) as u32)))))
                })
                .collect::<Vec<_>>()
        };
        self.rich.update(cx, |r, cx| {
            r.comment_marks = marks;
            cx.notify();
        });
        self.collab.comments.source_marks_for = None;
        self.source_marks(cx);
    }

    /// Local comments are showing for the open document.
    pub(super) fn local_comments_on(&self) -> bool {
        self.collab.comments.local.is_some()
    }

    /// Where a Source selection ended, for placing "Comment" under it.
    pub(super) fn note_source_mouse_up(&mut self, y: Pixels) {
        self.collab.comments.source_up = Some(y);
    }

    /// The reader's selection as a quote anchor into the Markdown, with the
    /// height to offer "Comment" at. The focused pane decides (local-comments
    /// .tsx `readSelection`): Source by its own offsets, View through the
    /// visible-text projection.
    fn local_selection(&self, window: &Window, cx: &App) -> Option<(markie_cloud::comments::anchor::TextAnchor, f32)> {
        let source_focused = match self.mode {
            Mode::Source => true,
            Mode::Split => self.editor.read(cx).focus_handle(cx).is_focused(window),
            Mode::View => false,
        };
        let o = self.collab.comments.origin.get()?.origin;
        if source_focused {
            let input = self.editor.read(cx);
            let range = input.selected_range();
            let text = input.value();
            if range.is_empty() || range.end > text.len() || !text.is_char_boundary(range.start) || !text.is_char_boundary(range.end) {
                return None;
            }
            let from = text[..range.start].encode_utf16().count();
            let to = from + text[range.start..range.end].encode_utf16().count();
            let anchor = make_anchor(&text, from, to)?;
            // Under the point where the selection ended (the Source pane
            // records its last mouse up), as Electron puts it under the range.
            let bottom = self.collab.comments.source_up.unwrap_or(o.y + px(40.));
            return Some((anchor, f32::from(bottom - o.y) + 18.));
        }
        let anchor = self.local_selection_anchor(cx)?;
        let rich = self.rich.read(cx);
        let (_, to) = rich.editor.range();
        let top = rich.caret_rect(to).map(|r| f32::from(r.origin.y + r.size.height - o.y) + 6.)?;
        Some((anchor, top))
    }

    /// The selection in View as a quote anchor into the Markdown.
    fn local_selection_anchor(&self, cx: &App) -> Option<markie_cloud::comments::anchor::TextAnchor> {
        let md = self.markdown_now(cx);
        if self.mode == Mode::Source {
            return None;
        }
        let ed = &self.rich.read(cx).editor;
        if !ed.has_selection() {
            return None;
        }
        let (from, to) = ed.range();
        let (visible, map) = Self::visible_text(ed);
        let a = map.iter().position(|p| *p >= from)?;
        let b = map.iter().rposition(|p| *p < to).map(|i| i + 1)?;
        let r = visible_to_markdown(&md, &visible, TextRange { from: a, to: b })?;
        make_anchor(&md, r.from, r.to)
    }

    fn render_local_comments(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.live_running() {
            return None;
        }
        let p = themes::palette(cx);
        let md = self.markdown_now(cx);
        let can_comment = self.doc_editable();
        let selection = (can_comment && self.collab.comments.local.as_ref().is_some_and(|l| l.composing.is_none())).then(|| self.local_selection(window, cx)).flatten();
        let (sel_anchor, sel_top) = match selection {
            Some((anchor, top)) => (Some(anchor), Some(top)),
            None => (None, None),
        };
        let composing = self.collab.comments.local.as_ref()?.composing.clone();
        let composer = composing.as_ref().map(|_| self.composer("local-new", "Comment…", Submit::NewLocal, window, cx));
        let panel = self.collab.comments.local.as_ref()?;
        let placed = place(&panel.threads, &md);
        let mut anchored: Vec<&PlacedThread> = placed.iter().filter(|p| p.thread.status == Status::Open && p.range.is_some()).collect();
        anchored.sort_by_key(|p| p.range.map(|r| r.start));
        let detached: Vec<&PlacedThread> = placed.iter().filter(|p| p.thread.status == Status::Open && p.range.is_none()).collect();
        let resolved: Vec<&PlacedThread> = placed.iter().filter(|p| p.thread.status == Status::Resolved).collect();
        let total = anchored.len() + detached.len();
        let (open, active, show_resolved, error) = (panel.open, panel.active.clone(), panel.show_resolved, panel.error.clone());
        let origin = self.collab.comments.origin.clone();

        let reply_ids: Vec<String> = anchored.iter().chain(&detached).chain(&resolved).filter(|p| p.thread.status == Status::Open).map(|p| p.thread.id.clone()).collect();
        let mut replies = HashMap::new();
        if open && can_comment {
            for id in reply_ids {
                let input = self.composer(&format!("local-reply-{id}"), "Reply…", Submit::ReplyLocal(id.clone()), window, cx);
                replies.insert(id, input);
            }
        }
        let card = |w: &mut Self, pt: &PlacedThread, cx: &mut Context<Self>| w.local_thread_card(pt, active.as_deref() == Some(pt.thread.id.as_str()), can_comment, replies.get(&pt.thread.id).cloned(), &p, cx);
        let anchored_cards: Vec<AnyElement> = anchored.iter().map(|pt| card(self, pt, cx)).collect();
        let detached_cards: Vec<AnyElement> = detached.iter().map(|pt| card(self, pt, cx)).collect();
        let resolved_cards: Vec<AnyElement> = if show_resolved { resolved.iter().map(|pt| card(self, pt, cx)).collect() } else { vec![] };
        let n_resolved = resolved.len();

        let el = div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(canvas(move |bounds, _, _| origin.set(Some(bounds)), |_, _, _, _| {}).absolute().size_full())
            .when_some(sel_top.zip(sel_anchor), |el, (top, anchor)| {
                el.child(
                    div()
                        .id("local-comment-start")
                        .absolute()
                        .top(px(top.max(8.)))
                        .right(px(if open { 316. } else { 20. }))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .px(px(8.))
                        .py(px(4.))
                        .rounded_full()
                        .border_1()
                        .border_color(p.border)
                        .bg(p.surface2)
                        .shadow_lg()
                        .text_size(px(11.))
                        .text_color(p.muted)
                        .hover(|s| s.text_color(p.foreground))
                        .cursor_pointer()
                        .child(svg().path("markie/comment.svg").size(px(11.)).text_color(p.muted))
                        .child("Comment")
                        .on_click(cx.listener(move |w, _, window, cx| {
                            if let Some(panel) = w.collab.comments.local.as_mut() {
                                panel.composing = Some(anchor.clone());
                                panel.open = true;
                                panel.active = None;
                            }
                            let input = w.composer("local-new", "Comment…", Submit::NewLocal, window, cx);
                            input.update(cx, |s, cx| s.focus(window, cx));
                            cx.notify();
                        })),
                )
            })
            .when(!open, |el| {
                el.child(
                    div()
                        .id("local-comments-toggle")
                        .absolute()
                        .top(px(40.))
                        .right(px(18.))
                        .h(px(24.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.border)
                        .bg(p.surface.opacity(0.88))
                        .text_size(px(11.))
                        .text_color(p.muted)
                        .hover(|s| s.text_color(p.foreground))
                        .cursor_pointer()
                        .child(svg().path("markie/comment.svg").size(px(11.)).text_color(p.muted))
                        .child(if total > 0 { total.to_string() } else { "Comments".into() })
                        .on_click(cx.listener(|w, _, _, cx| {
                            if let Some(panel) = w.collab.comments.local.as_mut() {
                                panel.open = true;
                            }
                            cx.notify();
                        })),
                )
            })
            .when(open, |el| {
                el.child(
                    v_flex()
                        .id("local-comments-panel")
                        .absolute()
                        .top_0()
                        .right_0()
                        .bottom_0()
                        .w(px(300.))
                        .border_l_1()
                        .border_color(p.border)
                        .bg(p.surface2)
                        .shadow_xl()
                        .child(
                            h_flex()
                                .justify_between()
                                .px(px(12.))
                                .py(px(8.))
                                .border_b_1()
                                .border_color(p.border)
                                .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(if total > 0 { format!("Comments ({total})") } else { "Comments".into() }))
                                .child(
                                    div()
                                        .id("local-comments-close")
                                        .text_size(px(13.))
                                        .text_color(p.muted)
                                        .hover(|s| s.text_color(p.foreground))
                                        .cursor_pointer()
                                        .child("×")
                                        .on_click(cx.listener(|w, _, _, cx| {
                                            if let Some(panel) = w.collab.comments.local.as_mut() {
                                                panel.open = false;
                                                panel.active = None;
                                            }
                                            w.local_marks(cx);
                                            cx.notify();
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .id("local-comments-list")
                                .flex_1()
                                .min_h_0()
                                .overflow_y_scroll()
                                .p(px(8.))
                                .flex()
                                .flex_col()
                                .gap(px(8.))
                                .when_some(error, |el, e| el.child(div().px(px(4.)).text_size(px(11.)).text_color(p.red).child(e)))
                                .when_some(composing.zip(composer), |el, (anchor, input)| {
                                    el.child(
                                        v_flex()
                                            .rounded(px(8.))
                                            .border_1()
                                            .border_color(p.border)
                                            .p(px(8.))
                                            .gap(px(8.))
                                            .child(quote(&anchor.exact, &p))
                                            .child(composer_box(&input, true, &p, cx.listener(|w, _, _, cx| w.composer_cancel("local-new", cx)), cx.listener(|w, _, _, cx| w.composer_cancel("local-new", cx)), cx.listener(|w, _, window, cx| {
                                                if let Some(c) = w.collab.comments.composers.get("local-new") {
                                                    let body = c.input.read(cx).value().trim().to_string();
                                                    if !body.is_empty() {
                                                        c.input.update(cx, |s, cx| s.set_value("", window, cx));
                                                        w.submit_comment(Submit::NewLocal, body, cx);
                                                    }
                                                }
                                            }))),
                                    )
                                })
                                .when(total == 0 && n_resolved == 0 && self.collab.comments.local.as_ref().is_some_and(|l| l.composing.is_none()), |el| {
                                    el.child(div().px(px(4.)).py(px(8.)).text_size(px(12.)).text_color(p.muted).child("Select text and choose Comment. Agents can comment here too, through Markie's MCP tools."))
                                })
                                .children(anchored_cards)
                                .when(!detached_cards.is_empty(), |el| {
                                    el.child(div().px(px(4.)).mt(px(4.)).text_size(px(10.)).text_color(p.muted).child("DETACHED"))
                                        .child(div().px(px(4.)).text_size(px(11.)).text_color(p.muted).child("The text these were on has changed or been removed."))
                                        .children(detached_cards)
                                })
                                .when(n_resolved > 0, |el| {
                                    el.child(
                                        div()
                                            .id("local-resolved-toggle")
                                            .mt(px(4.))
                                            .px(px(8.))
                                            .py(px(2.))
                                            .rounded_full()
                                            .border_1()
                                            .border_color(p.border)
                                            .text_size(px(11.))
                                            .text_color(p.muted)
                                            .hover(|s| s.text_color(p.foreground))
                                            .cursor_pointer()
                                            .child(format!("{n_resolved} resolved {}", if show_resolved { "▴" } else { "▾" }))
                                            .on_click(cx.listener(|w, _, _, cx| {
                                                if let Some(panel) = w.collab.comments.local.as_mut() {
                                                    panel.show_resolved = !panel.show_resolved;
                                                }
                                                cx.notify();
                                            })),
                                    )
                                    .children(resolved_cards)
                                }),
                        ),
                )
            });
        Some(el.into_any_element())
    }

    fn local_thread_card(&mut self, pt: &PlacedThread, active: bool, can_comment: bool, reply: Option<Entity<TextareaState>>, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let t = &pt.thread;
        let resolved = t.status == Status::Resolved;
        let (id1, id2, id3) = (t.id.clone(), t.id.clone(), t.id.clone());
        let range = pt.range;
        v_flex()
            .rounded(px(8.))
            .border_1()
            .border_color(if active { p.accent } else { p.border })
            .bg(p.surface)
            .p(px(10.))
            .gap(px(8.))
            .child(
                h_flex()
                    .items_start()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .id(SharedString::from(format!("lq-{}", t.id)))
                            .flex_1()
                            .min_w_0()
                            .cursor_pointer()
                            .child(quote(&t.anchor.exact, p))
                            .on_click(cx.listener(move |w, _, window, cx| w.local_focus(&id1, range, window, cx))),
                    )
                    .when(can_comment, |el| {
                        el.child(
                            div()
                                .id(SharedString::from(format!("ls-{}", t.id)))
                                .flex_none()
                                .text_size(px(11.))
                                .text_color(p.muted)
                                .hover(|s| s.text_color(p.foreground))
                                .cursor_pointer()
                                .child(if resolved { "Reopen" } else { "Resolve" })
                                .on_click(cx.listener(move |w, _, _, cx| {
                                    let Some(panel) = w.collab.comments.local.as_ref() else { return };
                                    let r = panel.store.set_status(&panel.path, &id2, if resolved { Status::Open } else { Status::Resolved }, Author::User);
                                    w.local_result(r.map(|_| ()), cx);
                                })),
                        )
                    }),
            )
            .children(t.comments.iter().map(|c| {
                let name = c.author.label();
                let own = c.author == Author::User && can_comment;
                let (tid, cid) = (id3.clone(), c.id.clone());
                comment_row(&name, &fmt_time(&c.created_at), &c.body, p).when(own, |el| {
                    el.child(
                        div()
                            .id(SharedString::from(format!("ld-{}", c.id)))
                            .text_size(px(11.))
                            .text_color(p.muted)
                            .hover(|s| s.text_color(p.red))
                            .cursor_pointer()
                            .child("×")
                            .on_click(cx.listener(move |w, _, _, cx| {
                                let Some(panel) = w.collab.comments.local.as_ref() else { return };
                                let r = panel.store.remove_own(&panel.path, &tid, &cid);
                                w.local_result(r.map(|_| ()), cx);
                            })),
                    )
                })
            }))
            .when_some(t.resolved_by.as_ref().filter(|_| resolved), |el, by| {
                el.child(div().text_size(px(10.)).text_color(p.green).child(format!("Resolved by {}", by.label())))
            })
            .when_some(reply.filter(|_| can_comment && !resolved), |el, input| {
                let tid = t.id.clone();
                let key = format!("local-reply-{tid}");
                el.child(composer_box(&input, false, p, cx.listener(|_, _, _, _| {}), cx.listener(|_, _, _, _| {}), cx.listener(move |w, _, window, cx| {
                    if let Some(c) = w.collab.comments.composers.get(&key) {
                        let body = c.input.read(cx).value().trim().to_string();
                        if !body.is_empty() {
                            c.input.update(cx, |s, cx| s.set_value("", window, cx));
                            w.submit_comment(Submit::ReplyLocal(tid.clone()), body, cx);
                        }
                    }
                })))
            })
            .into_any_element()
    }

    fn local_focus(&mut self, id: &str, range: Option<markie_cloud::comments::anchor::TextRange>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.collab.comments.local.as_mut() {
            panel.active = Some(id.to_string());
        }
        if let Some(r) = range {
            let md = self.markdown_now(cx);
            self.rich.update(cx, |rv: &mut RichView, cx| {
                let (visible, map) = Self::visible_text(&rv.editor);
                if let Some(v) = markdown_to_visible(&md, TextRange { from: r.start, to: r.end }, &visible) {
                    if let (Some(f), Some(l)) = (map.get(v.from).copied(), map.get(v.to.saturating_sub(1)).copied()) {
                        rv.editor.set_selection(f, Pos { offset: l.offset + 1, ..l });
                        rv.focus(window, cx);
                        cx.notify();
                    }
                }
            });
        }
        self.local_marks(cx);
        cx.notify();
    }

    /// Everything comments draw over the document area.
    pub(super) fn render_comments(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.rich_active() {
            return None;
        }
        if self.live_rich_binding().is_some() {
            return self.render_cloud_comments(window, cx);
        }
        self.collab.comments.local.as_ref()?;
        self.render_local_comments(window, cx)
    }
}

/// UTF-16 offsets (the anchors' unit) to UTF-8 byte offsets (the editor's).
fn utf8_offsets(text: &str) -> Vec<usize> {
    let mut map = Vec::with_capacity(text.len() + 1);
    for (byte, ch) in text.char_indices() {
        for _ in 0..ch.len_utf16() {
            map.push(byte);
        }
    }
    map.push(text.len());
    map
}

/// The Source decorations for the open, anchored threads in `text`.
fn source_decorations(threads: &[LocalThread], text: &str, active: Option<&str>) -> Vec<TextDecoration> {
    let map = utf8_offsets(text);
    let blue = |a: f32| Hsla::from(rgba(0x60a5fa00 | ((a * 255.).round() as u32)));
    let mut marks: Vec<(std::ops::Range<usize>, bool)> = place(threads, text)
        .into_iter()
        .filter(|p| p.thread.status == Status::Open)
        .filter_map(|p| {
            let r = p.range?;
            let (from, to) = (*map.get(r.start)?, *map.get(r.end)?);
            (to > from).then(|| (from..to, active == Some(p.thread.id.as_str())))
        })
        .collect();
    marks.sort_by_key(|(r, _)| (r.start, r.end));
    marks
        .into_iter()
        .map(|(range, on)| {
            TextDecoration::new(
                range,
                HighlightStyle {
                    background_color: Some(blue(if on { 0.32 } else { 0.14 })),
                    underline: Some(UnderlineStyle { thickness: px(2.), color: Some(blue(0.7)), wavy: false }),
                    ..Default::default()
                },
            )
        })
        .collect()
}

/// Threads with where their quotes are in the text now (from memory: the
/// file is read when it changes, not on every frame).
fn place(threads: &[LocalThread], md: &str) -> Vec<PlacedThread> {
    threads.iter().map(|t| PlacedThread { thread: t.clone(), range: markie_cloud::comments::anchor::resolve_anchor(md, &t.anchor) }).collect()
}

fn quote(text: &str, p: &Palette) -> Div {
    div()
        .border_l_2()
        .border_color(hsla(213. / 360., 0.94, 0.68, 0.7))
        .pl(px(8.))
        .text_size(px(11.))
        .italic()
        .text_color(p.muted)
        .child(short_quote(text))
}

/// One comment: avatar, name, time, body.
fn comment_row(name: &str, time: &str, body: &str, p: &Palette) -> Div {
    h_flex()
        .items_start()
        .gap(px(8.))
        .child(avatar(name, hex(color_for_name(name)), transparent_black(), 20., 8.).border_0().mt(px(2.)))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    h_flex()
                        .justify_between()
                        .gap(px(8.))
                        .child(div().min_w_0().truncate().text_size(px(11.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(name.to_string()))
                        .child(div().flex_none().text_size(px(9.)).text_color(p.muted).child(time.to_string())),
                )
                .child(div().text_size(px(12.)).text_color(p.foreground.opacity(0.9)).child(body.to_string())),
        )
}

/// The comment composer: the field, Cancel (when there is one) and Send.
fn composer_box(
    input: &Entity<TextareaState>,
    cancel: bool,
    p: &Palette,
    on_cancel: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_escape: impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static,
    on_send: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Div {
    v_flex()
        .capture_key_down(move |ev: &KeyDownEvent, window, cx| {
            if cancel && ev.keystroke.key == "escape" {
                on_escape(ev, window, cx);
            }
        })
        .rounded(px(8.))
        .border_1()
        .border_color(p.border)
        .p(px(6.))
        .gap(px(6.))
        .bg(p.surface2)
        .shadow_xl()
        .child(div().rounded(px(6.)).border_1().border_color(p.border).bg(p.background).px(px(8.)).py(px(6.)).text_size(px(12.)).text_color(p.foreground).child(Textarea::new(input)))
        .child(
            h_flex()
                .justify_end()
                .gap(px(8.))
                .when(cancel, |el| {
                    el.child(div().id("composer-cancel").px(px(8.)).text_size(px(11.)).text_color(p.muted).hover(|s| s.text_color(p.foreground)).cursor_pointer().child("Cancel").on_click(on_cancel))
                })
                .child(
                    div()
                        .id("composer-send")
                        .px(px(10.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .bg(p.accent)
                        .text_size(px(11.))
                        .text_color(p.foreground)
                        .cursor_pointer()
                        .hover(|s| s.opacity(0.9))
                        .child("Send")
                        .on_click(on_send),
                ),
        )
}

#[allow(dead_code)]
fn unused(_: Value) {}

#[cfg(test)]
mod tests {
    #[test]
    fn source_marks_cover_the_quote_in_bytes() {
        use markie_cloud::comments::anchor::make_anchor;
        use markie_cloud::comments::local::{LocalThread, Status};
        let text = "# Café\n\nThe quick brown fox — ships.\n";
        let quote = "quick brown fox";
        let start16 = text[..text.find(quote).unwrap()].encode_utf16().count();
        let anchor = make_anchor(text, start16, start16 + quote.encode_utf16().count()).unwrap();
        let thread = |id: &str, status| LocalThread { id: id.into(), anchor: anchor.clone(), status, created_at: String::new(), comments: vec![], resolved_at: None, resolved_by: None };
        let marks = super::source_decorations(&[thread("t1", Status::Open), thread("t2", Status::Resolved)], text, Some("t1"));
        assert_eq!(marks.len(), 1, "resolved threads are not tinted");
        let range = marks[0].range.clone();
        assert_eq!(&text[range], quote);
        assert_eq!(super::utf8_offsets("é").as_slice(), &[0, 2]);
    }

    #[test]
    fn times_read_like_electrons() {
        let s = super::fmt_time("2026-11-22T15:04:00.000Z");
        assert!(s.contains(':') && (s.ends_with("AM") || s.ends_with("PM")), "{s}");
        assert!(s.starts_with("Nov 22") || s.starts_with("Nov 21") || s.starts_with("Nov 23"), "{s}");
    }
}
