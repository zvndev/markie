//! The account sheet. The rail's account button calls `open_account`; the
//! cloud sign-in work replaces this stub with the real sheet.

use gpui_kit::*;

use super::Workspace;

impl Workspace {
    /// Open the account sheet (sign in, or the signed-in account).
    pub(crate) fn open_account(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {}
}
