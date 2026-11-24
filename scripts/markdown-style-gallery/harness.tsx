// The gallery's page (scripts/markdown-style-gallery.mjs): the sample document
// in any Markdown style and tone, the Settings section, the style editor, and
// the exported page. Development only; nothing in the app loads it.
//
//   ?view=doc&style=<preset id | custom>&tone=light|dark
//   ?view=settings&style=...&tone=...
//   ?view=export&style=...&theme=light|dark   (replaces the page with the exported HTML)
import "@/app/globals.css";
import { createRoot } from "react-dom/client";
import { applyColorMode } from "@/lib/color-mode";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { MARKDOWN_STYLE_PRESETS, activeMarkdownStyle, saveMarkdownStyleAs, editMarkdownStyle, chooseMarkdownStyle, type MarkdownStyleStore } from "@/lib/markdown-style";
import { commitMarkdownStyleStore, loadMarkdownStyleStore } from "@/lib/markdown-style-store";
import { buildPDFHTMLSync } from "@/lib/pdf-styles";
import { MarkdownStyleSection } from "@/components/markdown-style-settings";
import { GALLERY_CUSTOM_STYLE } from "./custom-style";
import { MARKDOWN_STYLE_SAMPLE } from "./sample";

const params = new URLSearchParams(window.location.search);
const tone = params.get("tone") === "dark" ? "dark" : "light";
const view = params.get("view") ?? "doc";
const styleId = params.get("style") ?? "spacious";

localStorage.clear();
applyColorMode(tone);

// The store a person would have after choosing this style in Settings.
let store: MarkdownStyleStore = loadMarkdownStyleStore();
if (styleId === "custom") {
  store = editMarkdownStyle(chooseMarkdownStyle(store, GALLERY_CUSTOM_STYLE.base), GALLERY_CUSTOM_STYLE);
  if (params.get("saved") !== "0") store = saveMarkdownStyleAs(store, "Field manual", "style-gallery");
} else if (MARKDOWN_STYLE_PRESETS.some((preset) => preset.id === styleId)) {
  store = chooseMarkdownStyle(store, styleId);
}
store = commitMarkdownStyleStore(store);

const html = renderMarkdownHTML(MARKDOWN_STYLE_SAMPLE);
const ready = () => void document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => (document.body.dataset.ready = "1"))));

if (view === "export") {
  const page = buildPDFHTMLSync(html, params.get("theme") === "dark" ? "dark" : "light", { markdownStyle: activeMarkdownStyle(store) });
  document.open();
  document.write(page.replace("</body>", '<script>document.body.dataset.ready = "1";</script></body>'));
  document.close();
} else if (view === "settings") {
  createRoot(document.getElementById("root")!).render(
    <div className="markie-shell" style={{ minHeight: "100vh", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 32 }}>
      <div className="markie-overlay-panel w-[680px] max-w-[94vw] rounded-xl p-5" role="dialog" aria-label="Settings">
        <MarkdownStyleSection />
      </div>
    </div>
  );
  ready();
} else {
  createRoot(document.getElementById("root")!).render(
    <div className="markie-document-scroll">
      <article
        className="markdown-body markie-document-canvas mx-auto"
        style={{ width: "min(100%, var(--doc-width, 768px))", fontSize: "var(--doc-font-size, 16px)", fontFamily: "var(--doc-font-family, inherit)" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
  ready();
}
