//! The keyboard shortcuts sheet (⌘/), drawn like
//! `src/components/shortcuts-help.tsx`, and About, which in Electron is the
//! standard macOS About panel (`{ role: "about" }`), so it is here too.

use gpui_kit::*;

use super::Workspace;
use super::dialog_chrome::{Tokens, fade, section_label};
use super::palette::{PaletteCommand, commands};

/// Commands with a shortcut, grouped in first-seen order like Electron's Map.
pub(super) fn shortcut_groups() -> Vec<(&'static str, Vec<PaletteCommand>)> {
    let mut groups: Vec<(&'static str, Vec<PaletteCommand>)> = Vec::new();
    for c in commands().into_iter().filter(|c| c.shortcut.is_some()) {
        match groups.iter_mut().find(|(g, _)| *g == c.group) {
            Some((_, list)) => list.push(c),
            None => groups.push((c.group, vec![c])),
        }
    }
    groups
}

impl Workspace {
    pub(super) fn render_shortcuts(&mut self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let groups = shortcut_groups();
        let column = |(group, cmds): (&'static str, Vec<PaletteCommand>)| {
            div()
                .flex_1()
                .min_w_0()
                .child(section_label(group, t).mb(px(6.)))
                .children(cmds.into_iter().map(|c| {
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .py(px(2.))
                        .text_size(px(12.))
                        .child(div().text_color(fade(t.foreground, 0.8)).child(c.title.clone()))
                        .child(div().text_color(t.muted).child(c.shortcut.unwrap_or_default()))
                }))
        };
        let mut rows = Vec::new();
        let mut it = groups.into_iter();
        while let Some(first) = it.next() {
            let second = it.next();
            rows.push(
                div()
                    .flex()
                    .gap(px(32.))
                    .child(column(first))
                    .child(match second {
                        Some(g) => column(g),
                        None => div().flex_1(),
                    }),
            );
        }
        self.panel(t, 12.)
            .id("shortcuts")
            .w(px(560.))
            .max_w(relative(0.92))
            .max_h(window.viewport_size().height * 0.8)
            .overflow_y_scroll()
            .p(px(20.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .mb(px(16.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Keyboard Shortcuts"))
                    .child(self.close_button("shortcuts-close", t, cx)),
            )
            .child(div().flex().flex_col().gap(px(16.)).children(rows))
            .into_any_element()
    }
}

/// The standard macOS About panel: name, version and icon from the bundle.
pub(super) fn show_about(_cx: &mut App) {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        if let Some(mtm) = MainThreadMarker::new() {
            let app = NSApplication::sharedApplication(mtm);
            app.orderFrontStandardAboutPanel(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::shortcut_groups;

    #[test]
    fn groups_follow_electron_order() {
        let names: Vec<&str> = shortcut_groups().iter().map(|(g, _)| *g).collect();
        // Format holds Format Tables (⌥⌘T), as Electron's sheet does for a
        // document that can be edited.
        assert_eq!(names, ["File", "View", "Format", "Help"]);
        let file = &shortcut_groups()[0].1;
        assert_eq!(file[0].title.as_ref(), "Open File…");
        assert_eq!(file[0].shortcut, Some("⌘O"));
    }
}
