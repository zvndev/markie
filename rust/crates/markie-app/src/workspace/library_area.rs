//! The Library's "Upload destination" (library.tsx with
//! `cloud-area-picker.tsx`): signed in, the Recent tab picks the cloud area a
//! row's "Sync to cloud" puts a new cloud document in. "Default cloud" is
//! none. A file already in the cloud keeps its area.

use gpui_kit::component::h_flex;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::chrome::menu_panel;
use super::cloud_page::{AreaTarget, select_button};
use crate::themes::Palette;

/// The picker's label: the chosen area's, or "Default cloud".
pub(super) fn upload_area_label(chosen: Option<&str>, areas: &[(String, String)]) -> String {
    chosen
        .and_then(|id| areas.iter().find(|(a, _)| a == id))
        .map(|(_, label)| label.clone())
        .unwrap_or_else(|| "Default cloud".into())
}

impl Workspace {
    pub(super) fn render_library_area_picker(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let areas: Vec<(String, String)> = self
            .cloud
            .primary_scope()
            .and_then(|s| self.cloud.listing(&s).map(|l| l.areas.iter().map(|a| (a.id.clone(), a.label.clone())).collect()))
            .unwrap_or_default();
        let open = self.shell.upload_area_open;
        let label = upload_area_label(self.shell.upload_area.as_deref(), &areas);
        let chosen = self.shell.upload_area.clone();
        let chip = |id: Option<String>, text: String, cx: &mut Context<Self>| {
            let on = id == chosen;
            div()
                .id(SharedString::from(format!("library-area-{}", id.as_deref().unwrap_or("default"))))
                .rounded(px(6.))
                .border_1()
                .border_color(if on { p.foreground.opacity(0.25) } else { p.border })
                .when(on, |el| el.bg(p.accent))
                .px(px(8.))
                .py(px(4.))
                .text_size(px(11.))
                .text_color(if on { p.foreground } else { p.muted })
                .hover(|s| s.text_color(p.foreground))
                .cursor_pointer()
                .child(text)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.shell.upload_area = id.clone();
                    this.shell.upload_area_open = false;
                    cx.notify();
                }))
        };
        let mut chips = vec![chip(None, "Default cloud".into(), cx)];
        for (id, text) in areas {
            chips.push(chip(Some(id), text, cx));
        }
        div()
            .flex_none()
            .px(px(8.))
            .py(px(4.))
            .relative()
            .child(select_button("library-upload-area", Some("Upload destination"), &label, open, &p).w_full().on_click(cx.listener(
                |this, _, window, cx| {
                    this.shell.upload_area_open = !this.shell.upload_area_open;
                    if this.shell.upload_area_open {
                        this.ensure_area_input(window, cx);
                    }
                    cx.notify();
                },
            )))
            .when(open, |el| {
                el.child(
                    div().absolute().top(px(40.)).left(px(8.)).child(deferred(
                        anchored().snap_to_window_with_margin(px(8.)).child(
                            menu_panel(&p)
                                .id("library-area-menu")
                                .occlude()
                                .w(px(300.))
                                .p(px(8.))
                                .rounded(px(10.))
                                .child(h_flex().flex_wrap().gap(px(4.)).children(chips))
                                .children(self.render_area_create(AreaTarget::Library, &p, cx))
                                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                    this.shell.upload_area_open = false;
                                    cx.notify();
                                })),
                        ),
                    )),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::upload_area_label;

    #[test]
    fn the_picker_names_the_chosen_area_or_the_default_cloud() {
        let areas = vec![("a1".to_string(), "Clients".to_string())];
        assert_eq!(upload_area_label(None, &areas), "Default cloud");
        assert_eq!(upload_area_label(Some("a1"), &areas), "Clients");
        assert_eq!(upload_area_label(Some("gone"), &areas), "Default cloud");
    }
}
