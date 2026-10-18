// A video link alone on its line, drawn as a card.
//
// The file keeps the bare URL and nothing else, which is what every other
// renderer shows as a link, so a document with a video in it is still a plain
// markdown document. In the rich pane that paragraph becomes this node: a
// card with the thumbnail and the title, and the player itself only once the
// card is clicked. Nothing is framed until then, because an embedded player
// is somebody else's page running inside the document, and a document with
// six videos in it should not open six of them to be read.
//
// Only a paragraph that is nothing but the address qualifies. A link inside a
// sentence is a link, and `[watch this](https://youtu.be/x)` is a link somebody
// chose words for.
import { Node, type NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import {
  embedLabel,
  parseEmbed,
  type Embed,
} from "@/lib/embeds";
import { getElectronAPI, type LinkPreview } from "@/lib/electron";
import { getLinkPreviewsEnabled, subscribeLinkPreviews } from "@/lib/link-previews";
import { requestVideoViewer } from "@/lib/media-viewer-events";
import { isDocumentLinkActive } from "@/lib/external-link";

const TEXT_NODE = 3;

/**
 * The embed a paragraph stands for when it holds one link and nothing else,
 * and the link's words are its address. Null for any other paragraph.
 */
export function bareEmbedLink(paragraph: HTMLElement): Embed | null {
  let anchor: HTMLAnchorElement | null = null;
  for (const child of Array.from(paragraph.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      if ((child.textContent ?? "").trim() !== "") return null;
      continue;
    }
    if (!(child instanceof HTMLAnchorElement) || anchor) return null;
    anchor = child;
  }
  if (!anchor) return null;
  const href = (anchor.getAttribute("href") ?? "").trim();
  const text = (anchor.textContent ?? "").trim();
  if (!href || text !== href) return null;
  return parseEmbed(text);
}

// One request per address for the life of the renderer, whatever happens to
// the node views. Main caches too, but a card should not wait on an IPC round
// trip to draw a title it drew a moment ago.
const previews = new Map<string, Promise<LinkPreview | null>>();

function previewFor(url: string): Promise<LinkPreview | null> {
  const api = getElectronAPI();
  if (!api?.linkPreview) return Promise.resolve(null);
  let pending = previews.get(url);
  if (!pending) {
    pending = api.linkPreview(url).catch(() => null);
    previews.set(url, pending);
  }
  return pending;
}

/** Tests only: forget every preview. */
export function clearEmbedPreviews(): void {
  previews.clear();
}

function createEmbedView(node: ProseMirrorNode) {
  const url = String(node.attrs.url ?? "");
  const embed = parseEmbed(url);
  const dom = document.createElement("div");
  dom.className = "markie-embed";
  dom.dataset.markieEmbed = url;

  // A node whose address stopped being a video (an edit through collab, a
  // schema from another build) is drawn as the link it is.
  if (!embed) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    dom.appendChild(link);
    return { dom };
  }

  const label = embedLabel(embed);
  const card = document.createElement("button");
  card.type = "button";
  card.setAttribute("contenteditable", "false");
  card.className = "markie-embed-card";
  card.dataset.markieEmbedCard = "";
  card.setAttribute("aria-label", `Play the video on ${label}`);
  // Not draggable as a button: the node is dragged by its frame.
  card.draggable = false;

  const thumb = document.createElement("img");
  thumb.className = "markie-embed-thumb";
  thumb.alt = "";
  thumb.draggable = false;

  const play = document.createElement("span");
  play.className = "markie-embed-play";
  play.setAttribute("aria-hidden", "true");

  const strip = document.createElement("span");
  strip.className = "markie-embed-strip";
  const title = document.createElement("span");
  title.className = "markie-embed-title";
  title.textContent = url;
  const host = document.createElement("span");
  host.className = "markie-embed-host";
  host.textContent = label;
  strip.append(title, host);

  card.append(thumb, play, strip);
  dom.appendChild(card);

  // Reading a document is not consent to contact every provider in it. Only
  // deliberate hover/focus asks main for its guarded metadata and raster bytes.
  thumb.hidden = true;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewGeneration = 0;
  let destroyed = false;
  const cancelPreview = () => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    previewGeneration += 1;
  };
  const beginPreview = () => {
    cancelPreview();
    if (!getLinkPreviewsEnabled() || !isDocumentLinkActive(card) || destroyed) return;
    const generation = previewGeneration;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (generation !== previewGeneration || destroyed || !getLinkPreviewsEnabled() || !isDocumentLinkActive(card)) return;
      void previewFor(url).then((preview) => {
        if (!preview || generation !== previewGeneration || destroyed || !getLinkPreviewsEnabled() || !isDocumentLinkActive(card)) return;
        if (preview.title) title.textContent = preview.title;
        // Never hand an unguarded remote URL (or SVG) to the renderer. Main
        // bounds and inlines raster bytes after checking each network hop.
        if (preview.image && preview.image.length <= 750_000 && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(preview.image)) {
          thumb.src = preview.image;
          thumb.hidden = false;
        }
      });
    }, 450);
  };
  const unsubscribe = subscribeLinkPreviews(() => {
    cancelPreview();
    if (!getLinkPreviewsEnabled()) { thumb.removeAttribute("src"); thumb.hidden = true; title.textContent = url; }
  });
  card.addEventListener("mouseenter", beginPreview);
  card.addEventListener("mouseleave", cancelPreview);
  card.addEventListener("focus", beginPreview);
  card.addEventListener("blur", cancelPreview);

  card.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelPreview();
    requestVideoViewer(card, url);
  });
  card.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!event.repeat) card.click();
  });

  return {
    dom,
    // A press on the card selects the node, as on any block, and the click
    // that follows is the card's own. Everything inside the player is the
    // player's.
    stopEvent: (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      if (target.closest("iframe")) return true;
      return ["click", "dblclick", "keydown", "keyup"].includes(event.type) && !!target.closest("button");
    },
    // Swapping the card for the player, or filling in a title, is this
    // view's doing and not a change to the document.
    ignoreMutation: () => true,
    update: (updated: ProseMirrorNode) =>
      updated.type === node.type && String(updated.attrs.url ?? "") === url,
    destroy: () => { destroyed = true; cancelPreview(); unsubscribe(); },
  };
}

export const EmbedNode = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      // The address as written. Provider and id are read from it on demand so
      // there is one source of truth and nothing to keep in step.
      url: { default: null },
    };
  },

  parseHTML() {
    return [
      // The editor's own output, copied and pasted.
      {
        tag: "div[data-markie-embed]",
        getAttrs: (element) => {
          const url = (element as HTMLElement).getAttribute("data-markie-embed") ?? "";
          return parseEmbed(url) ? { url } : false;
        },
      },
      // A paragraph that is nothing but a video link: markdown-it's linkify
      // made an anchor of the bare URL on its line. Tried before the
      // paragraph rule (priority 50), and it falls through to it for every
      // paragraph that is anything else.
      {
        tag: "p",
        priority: 100,
        getAttrs: (element) => {
          const embed = bareEmbedLink(element as HTMLElement);
          return embed ? { url: embed.url } : false;
        },
      },
    ];
  },

  // For the clipboard, and for anything that draws the node without a view:
  // the link, which is what the file holds.
  renderHTML({ node }) {
    const url = String(node.attrs.url ?? "");
    return ["div", { "data-markie-embed": url, class: "markie-embed" }, ["a", { href: url }, url]];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          state.write(String(node.attrs.url ?? ""));
          state.closeBlock(node);
        },
        parse: {
          // handled by markdown-it, through the paragraph rule above
        },
      },
    };
  },

  // Enter at the end of a line that is only a video address turns it into
  // the card there and then, rather than on the next open. Anything else
  // about Enter is left to the editor.
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "paragraph") return false;
        if ($from.parentOffset !== $from.parent.content.size) return false;
        const embed = parseEmbed($from.parent.textContent);
        if (!embed) return false;
        const from = $from.before();
        const to = $from.after();
        return editor
          .chain()
          .command(({ tr, state }) => {
            const card = state.schema.nodes.embed.create({ url: embed.url });
            const paragraph = state.schema.nodes.paragraph.create();
            tr.replaceWith(from, to, [card, paragraph]);
            tr.setSelection(TextSelection.create(tr.doc, from + card.nodeSize + 1));
            return true;
          })
          .run();
      },
    };
  },

  addNodeView() {
    if (typeof document === "undefined") return null;
    return ({ node }: NodeViewRendererProps) => createEmbedView(node);
  },
});
