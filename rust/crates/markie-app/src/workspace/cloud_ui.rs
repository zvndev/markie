//! What sits above a synced document: the update strip (`cloud_strip.rs`)
//! and, under it, a cloud action that failed. Electron has no per-document
//! sync bar; its sync controls live in the Library row menu, the share gate
//! and the conflict dialog, as Markie RS's now do.
use super::Workspace;
use gpui_kit::*;
use markie_cloud::docs::Role;

impl Workspace {
    pub(super) fn render_cloud_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let strip = self.render_update_strip(cx);
        let error = self.cloud.notice.clone().filter(|_| self.doc.is_some());
        if strip.is_none() && error.is_none() {
            return None;
        }
        let t = self.tokens(cx);
        let fg = t.foreground;
        // ShareBanner's error row: the sentence in red, never truncated past
        // two lines, with a × that clears only the error.
        let error_row = error.map(|message| {
            div()
                .flex_none()
                .flex()
                .items_start()
                .gap(px(8.))
                .px(px(12.))
                .py(px(6.))
                .bg(t.surface)
                .shadow(vec![super::dialog_chrome::inset(t.border, -1.)])
                .child(div().flex_1().min_w_0().text_size(px(11.)).line_height(relative(1.375)).line_clamp(2).text_color(t.red).child(message))
                .child(
                    div()
                        .id("cloud-error-dismiss")
                        .flex_none()
                        .rounded(px(4.))
                        .border_1()
                        .border_color(t.border)
                        .px(px(6.))
                        .text_size(px(12.))
                        .line_height(px(14.))
                        .text_color(t.muted)
                        .cursor_pointer()
                        .hover(move |s| s.text_color(fg))
                        .child("×")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.cloud.notice = None;
                            cx.notify();
                        })),
                )
        });
        Some(div().flex().flex_col().children(strip).children(error_row).into_any_element())
    }
}

pub(super) fn role_name(role: Role) -> &'static str {
    match role {
        Role::Owner => "Owner",
        Role::Editor => "Can save versions",
        Role::Viewer => "Can view",
    }
}
