// Private renderer event: a provider card asks the surrounding rich pane to
// display its known video URL. This is not a document or host capability API.
export const OPEN_VIDEO_VIEWER = "markie-open-video-viewer";
export const CLOSE_MEDIA_VIEWER_COMMAND = "dismiss-media-viewer";

export function requestVideoViewer(card: HTMLElement, url: string): void {
  card.dispatchEvent(new CustomEvent(OPEN_VIDEO_VIEWER, {
    bubbles: true,
    detail: { url },
  }));
}

export function requestLocalVideoViewer(button: HTMLElement): void {
  button.dispatchEvent(new CustomEvent(OPEN_VIDEO_VIEWER, { bubbles: true, detail: { local: true } }));
}
