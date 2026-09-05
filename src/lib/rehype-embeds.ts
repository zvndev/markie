// A video link alone on its line becomes a card in an export or on a share
// page: the thumbnail, linked to the video.
//
// The file keeps the bare URL, which is what any other renderer shows as a
// link, so nothing Markie-only is ever written. Only a paragraph that is
// nothing but that link qualifies: a link inside a sentence is a link.
//
// No player is drawn here. An export is a file somebody opens later and a
// share page runs no script, so the card is a picture that goes to the video
// when clicked, which is what a card is for a reader who cannot press play in
// place.
//
// server/src/rehype-embeds.ts is a copy of this file; the server imports
// nothing from the app's module graph.
import { visit } from "unist-util-visit";
import { embedLabel, embedThumbnailUrl, parseEmbed } from "@/lib/embeds";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

// The one anchor in a paragraph that holds nothing else, or null.
function loneAnchor(p: HastNode): HastNode | null {
  let anchor: HastNode | null = null;
  for (const child of p.children ?? []) {
    if (child.type === "text") {
      if ((child.value ?? "").trim() !== "") return null;
      continue;
    }
    if (child.type !== "element" || child.tagName !== "a" || anchor) return null;
    anchor = child;
  }
  return anchor;
}

export function rehypeEmbeds() {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: HastNode) => {
      if (node.tagName !== "p") return;
      const anchor = loneAnchor(node);
      if (!anchor) return;
      const href = typeof anchor.properties?.href === "string" ? anchor.properties.href : "";
      // The words have to be the address. `[watch this](https://youtu.be/x)`
      // is a link somebody chose words for, and stays one.
      if (textOf(anchor).trim() !== href.trim()) return;
      const embed = parseEmbed(href);
      if (!embed) return;
      const thumbnail = embedThumbnailUrl(embed);
      if (!thumbnail) return;
      node.properties = { ...node.properties, className: ["markie-embed"] };
      node.children = [
        {
          type: "element",
          tagName: "a",
          properties: { href: embed.url },
          children: [
            {
              type: "element",
              tagName: "img",
              properties: {
                src: thumbnail,
                alt: `Watch on ${embedLabel(embed)}`,
                loading: "lazy",
              },
              children: [],
            },
          ],
        },
      ];
    });
  };
}
