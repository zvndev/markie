use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;

pub(super) struct DocumentFailure {
    details: String,
    expanded: bool,
    copied: bool,
}

impl Workspace {
    pub(super) fn show_document_failure(&mut self, details: &str, cx: &mut Context<Self>) {
        if self.document_failure.is_some() {
            return;
        }
        let details: String = details.chars().take(8_192).collect();
        crate::logs::log_crash("renderer", &details);
        self.document_failure = Some(DocumentFailure { details, expanded: false, copied: false });
        self.autosave.cancel();
        self._recovery_task = Task::ready(());
        cx.notify();
    }

    fn reload_failed_document(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.file_path();
        self.doc = None;
        self.dirty = false;
        self.document_failure = None;
        if let Some(path) = path {
            self.open_path(&path, window, cx);
        } else {
            self.open_untitled("Untitled.md".into(), String::new(), window, cx);
        }
    }

    pub(super) fn render_document_failure(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(failure) = &self.document_failure else { return div().into_any_element() };
        let theme = cx.theme().clone();
        let show = if failure.expanded { "Hide details" } else { "Show details" };
        let copy = if failure.copied { "Copied" } else { "Copy details" };
        let muted = theme.muted_foreground;
        v_flex().size_full().justify_center().items_center().p_8().bg(theme.background)
            .child(v_flex().w_full().max_w(px(680.)).gap_4()
                .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child("Markie hit an error"))
                .child(div().text_sm().text_color(muted).child("Your file on disk is untouched, but changes you hadn’t saved may be lost."))
                .child(Button::new("failure-details").ghost().small().label(show)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(failure) = this.document_failure.as_mut() {
                            failure.expanded = !failure.expanded;
                            cx.notify();
                        }
                    })))
                .when(failure.expanded, |body| {
                    body.child(div().id("failure-detail-text").max_h(px(280.)).overflow_y_scroll()
                        .rounded_md().border_1().border_color(theme.border).p_3()
                        .font_family("Menlo").text_xs().child(failure.details.clone()))
                })
                .child(h_flex().gap_2()
                    .child(Button::new("failure-reload").outline().small().label("Reload")
                        .on_click(cx.listener(|this, _, window, cx| this.reload_failed_document(window, cx))))
                    .child(Button::new("failure-copy").outline().small().label(copy)
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(failure) = this.document_failure.as_mut() {
                                cx.write_to_clipboard(ClipboardItem::new_string(failure.details.clone()));
                                failure.copied = true;
                                cx.notify();
                            }
                        }))))
                .child(div().text_xs().text_color(muted).child("This crash was saved to Markie’s local crash log (Help → Reveal Crash Log).")))
            .into_any_element()
    }
}
