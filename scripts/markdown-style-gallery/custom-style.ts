// The made-up profile the gallery uses wherever it needs "somebody's own
// style": in the editor, and pinned to the hosted link.
import type { MarkdownStyle } from "../../src/lib/markdown-style";

export const GALLERY_CUSTOM_STYLE: MarkdownStyle = {
  base: "technical",
  choices: {
    headingRule: "short",
    headingCase: "upper-minor",
    bulletStyle: "dash",
    orderedStyle: "outline",
    tableStyle: "zebra",
    tableHeader: "bold",
    quoteStyle: "italic",
    quoteAccent: "link",
    codeBlockStyle: "bar",
    dividerStyle: "ornament",
    imageAlign: "center",
    captionStyle: "centered",
    taskDone: "strike",
  },
  numbers: { blockGap: 0.9, listIndent: 1.4, imageRadius: 12 },
};
