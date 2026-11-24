// The Spacious proof's page (scripts/markdown-style-gallery.mjs). It draws the
// sample document the way the desktop's reading pane does, through the app's
// real boot path, and nothing else.
//
// It imports only what existed before Markdown styles, so the very same file
// runs on a checkout of main and on this branch. The two screenshots are then
// compared pixel for pixel: whatever differs is something this work changed
// about the default look.
import "@/app/globals.css";
import { createRoot } from "react-dom/client";
import { applyColorMode } from "@/lib/color-mode";
import { installBundledFonts } from "@/lib/fonts/bundled-fonts";
import { startCodeFont } from "@/lib/fonts/code-font";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { MARKDOWN_STYLE_SAMPLE } from "./sample";

// Whatever stylesheets the feature added load here too, so a rule that leaked
// out of the settings chrome into a document would show up in the comparison.
// On main this matches nothing.
import.meta.glob("/src/components/markdown-style*.css", { eager: true });

const tone = new URLSearchParams(window.location.search).get("tone") === "dark" ? "dark" : "light";
localStorage.clear();
// The app's own boot (src/main.tsx): the bundled faces are declared and the
// code font is kept painted, before the theme is.
installBundledFonts();
startCodeFont();
applyColorMode(tone);

createRoot(document.getElementById("root")!).render(
  <div className="markie-document-scroll">
    <article
      className="markdown-body markie-document-canvas mx-auto"
      style={{ width: "min(100%, var(--doc-width, 768px))", fontSize: "var(--doc-font-size, 16px)", fontFamily: "var(--doc-font-family, inherit)" }}
      dangerouslySetInnerHTML={{ __html: renderMarkdownHTML(MARKDOWN_STYLE_SAMPLE) }}
    />
  </div>
);

void document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => (document.body.dataset.ready = "1"))));
