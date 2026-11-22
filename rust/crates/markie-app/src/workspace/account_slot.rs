//! The Account tab of Settings. It belongs to the cloud sign-in work
//! (markie-cloud, workspace/account.rs): this slot draws Electron's
//! signed-out form (`src/components/sign-in.tsx`) so the tab looks right
//! today, and every control in it calls `Workspace::open_account`.
//!
//! `open_account` lives in account.rs. When the cloud work lands it may
//! replace `render_account_section` with the live account view.

use gpui_kit::*;

use super::Workspace;
use super::dialog_chrome::Tokens;

impl Workspace {
    pub(super) fn render_account_section(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let primary = |id: &'static str, label: &'static str, cx: &mut Context<Self>| {
            div()
                .id(id)
                .w_full()
                .rounded(px(6.))
                .py(px(8.))
                .flex()
                .justify_center()
                .bg(t.accent)
                .text_size(px(13.))
                .text_color(t.foreground)
                .cursor_pointer()
                .hover(|el| el.opacity(0.9))
                .child(label)
                .on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx)))
        };
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Sign in to Markie"))
                    .child(
                        div()
                            .mt(px(4.))
                            .text_size(px(12.))
                            .line_height(px(19.5))
                            .text_color(t.muted)
                            .child("For syncing and sharing across your devices. Markie works fully without an account, and your files stay on this Mac either way."),
                    ),
            )
            .child(primary("account-google", "Continue with Google", cx))
            .child(primary("account-apple", "Continue with Apple", cx))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .py(px(4.))
                    .child(div().h(px(1.)).flex_1().bg(t.border))
                    .child(div().text_size(px(11.)).text_color(t.muted).child("or"))
                    .child(div().h(px(1.)).flex_1().bg(t.border)),
            )
            .child(
                div()
                    .id("account-email")
                    .w_full()
                    .rounded(px(7.))
                    .border_1()
                    .border_color(t.field_border())
                    .bg(t.field_bg())
                    .px(px(12.))
                    .py(px(8.))
                    .text_size(px(13.))
                    .text_color(t.muted)
                    .cursor_text()
                    .child("you@work.com")
                    .on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx))),
            )
            .child(
                div()
                    .w_full()
                    .rounded(px(6.))
                    .border_1()
                    .border_color(t.border)
                    .py(px(8.))
                    .flex()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(t.foreground)
                    .opacity(0.5)
                    .child("Email me a code"),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(t.muted)
                    .child("Use an email verified on your account. New here? Use a password to create an account."),
            )
            .child(
                div()
                    .id("account-password")
                    .text_size(px(11.))
                    .text_color(t.muted)
                    .cursor_pointer()
                    .child("Use a password instead")
                    .on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx))),
            )
            .into_any_element()
    }
}
