//! A video card's player: Electron's lightbox for a provider video
//! (`image-lightbox.tsx`, kind "video" with a frame). A click on the card
//! dims the window with the strong scrim and plays the YouTube (nocookie)
//! or Vimeo player in markie-web's `VideoPlayer` island, centred at 16:9,
//! with the round × at the top right. Escape, the × or a click on the scrim
//! closes it, and the web view goes with it.

use gpui_kit::component::ActiveTheme;
use gpui_kit::*;

use super::RichView;

pub(crate) struct VideoViewer {
    player: markie_web::island::VideoPlayer,
    /// Where the player was last placed, so a frame moves it only when the
    /// window changed size.
    placed: (f32, f32, f32, f32),
}

/// The player's rectangle in a window `w` by `h` points: the iframe's
/// `w-[min(1120px,calc(100vw-48px),calc((100vh-96px)*16/9))]` at
/// `aspect-video`, centred.
pub fn player_bounds(w: f32, h: f32) -> (f32, f32, f32, f32) {
    let width = 1120f32.min(w - 48.).min((h - 96.) * 16. / 9.).max(0.);
    let height = width * 9. / 16.;
    ((w - width) / 2., (h - height) / 2., width, height)
}

fn island((x, y, width, height): (f32, f32, f32, f32)) -> markie_web::island::Bounds {
    markie_web::island::Bounds { x: x as f64, y: y as f64, width: width as f64, height: height as f64 }
}

impl RichView {
    /// The card was clicked: play its video, as `requestVideoViewer` does.
    pub(crate) fn open_video(&mut self, url: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(embed) = markie_export::embeds::parse_embed(url) else { return };
        self.video = None;
        let size = window.viewport_size();
        let placed = player_bounds(f32::from(size.width), f32::from(size.height));
        match markie_web::island::VideoPlayer::new(window, island(placed), &embed) {
            Ok(player) => self.video = Some(VideoViewer { player, placed }),
            Err(e) => {
                eprintln!("markie-rs: video player: {e}");
                self.show_notice("Markie couldn't play that video.", cx);
            }
        }
        cx.notify();
    }

    pub(crate) fn close_video(&mut self, cx: &mut Context<Self>) -> bool {
        let open = self.video.take().is_some();
        if open {
            cx.notify();
        }
        open
    }

    pub(crate) fn render_video(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let v = self.video.as_mut()?;
        let size = window.viewport_size();
        let (w, h) = (f32::from(size.width), f32::from(size.height));
        let placed = player_bounds(w, h);
        if placed != v.placed {
            let _ = v.player.set_bounds(island(placed));
            v.placed = placed;
        }
        let theme = cx.theme();
        let (bg, surface2, border, fg) = (theme.background, theme.secondary, theme.border, theme.foreground);
        let close = div()
            .id("video-close")
            .absolute()
            .top(px(16.))
            .right(px(16.))
            .size(px(36.))
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(surface2.opacity(0.88))
            .border_1()
            .border_color(border)
            .text_color(fg)
            .text_size(px(20.))
            .line_height(px(20.))
            .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.22), offset: point(px(0.), px(6.)), blur_radius: px(18.), spread_radius: px(0.), inset: false }])
            .hover(move |s| s.bg(surface2))
            .cursor_pointer()
            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Close video").build(window, cx))
            .child("×")
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, _, cx| {
                this.close_video(cx);
            }));
        // `.markie-scrim-strong`: the page colour at 72%. The 12 px backdrop
        // blur has no GPUI counterpart.
        let scrim = div()
            .id("video-scrim")
            .w(px(w))
            .h(px(h))
            .bg(bg.opacity(0.72))
            .occlude()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
                this.close_video(cx);
            }))
            .child(close);
        Some(deferred(anchored().position(point(px(0.), px(0.))).child(scrim)).with_priority(10).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::player_bounds;

    #[test]
    fn the_player_is_centred_at_16_9_within_electrons_limits() {
        // A large window: capped at 1120 px.
        let (x, y, w, h) = player_bounds(1600., 1000.);
        assert_eq!((w, h), (1120., 630.));
        assert_eq!((x, y), (240., 185.));
        // A narrow window: 48 px less than its width.
        let (_, _, w, _) = player_bounds(800., 1000.);
        assert_eq!(w, 752.);
        // A short one: the height minus 96, at 16:9.
        let (_, _, w, h) = player_bounds(1600., 456.);
        assert_eq!((w, h), (640., 360.));
    }
}
