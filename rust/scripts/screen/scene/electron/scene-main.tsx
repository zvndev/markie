// One Electron component in a named state, for headless screenshots.
// The page is /scene.html?scene=<name>&theme=<light|dark>&args=<json>.
// Sessions arrive in localStorage before this runs (shoot.mjs).
import "@/app/globals.css";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { applyColorMode } from "@/lib/color-mode";
import { ShareDialog } from "@/components/share-dialog";
import { DocumentCloudDialog } from "@/components/document-cloud-dialog";
import { Settings } from "@/components/settings";
import { RichView } from "@/components/rich-view";
import { installBundledFonts } from "@/lib/fonts/bundled-fonts";
import { startCodeFont } from "@/lib/fonts/code-font";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { chooseMarkdownStyle, paintedMarkdownStyle } from "@/lib/markdown-style";
import { exportFontCss } from "@/lib/fonts/export-fonts";
import { buildPDFHTML } from "@/lib/pdf-styles";
import { sanitizeMarkdownStyleStore } from "@/lib/markdown-style-schema";
import { commitMarkdownStyleStore, loadMarkdownStyleStore } from "@/lib/markdown-style-store";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "";
const args = JSON.parse(params.get("args") ?? "{}");
applyColorMode(params.get("theme") === "dark" ? "dark" : "light");

function OfficeCloud() {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    fetch(`/@fs${args.file}`).then((r) => r.arrayBuffer()).then((b) => setBytes(new Uint8Array(b)));
  }, []);
  if (!bytes) return null;
  return <DocumentCloudDialog file={{ name: args.file.split("/").pop(), bytes }} onClose={() => {}} />;
}

// A document in a Markdown style: `file` (a Markdown file), `style` (a preset
// id, or a whole style store) and `surface`: "rich" is the editing view
// (TipTap, what Markie RS's View draws), "read" the rendered page a shared
// link shows. The style and fonts are set up the way the app's boot does.
function Doc() {
  const [md, setMd] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/@fs${args.file}`).then((r) => r.text()).then(setMd);
  }, []);
  if (md === null) return null;
  if (args.surface === "read") {
    return (
      <div className="markie-document-scroll" data-scene-doc>
        <article
          className="markdown-body markie-document-canvas mx-auto"
          style={{ width: "min(100%, var(--doc-width, 768px))", fontSize: "var(--doc-font-size, 16px)", fontFamily: "var(--doc-font-family, inherit)" }}
          dangerouslySetInnerHTML={{ __html: renderMarkdownHTML(md) }}
        />
      </div>
    );
  }
  return (
    <div style={{ height: "100%" }} data-scene-doc>
      <RichView value={md} onChange={() => {}} />
    </div>
  );
}

if (scene === "doc" || scene === "style-settings" || scene === "export") {
  installBundledFonts();
  startCodeFont();
  const styles = typeof args.style === "string" ? chooseMarkdownStyle(loadMarkdownStyleStore(), args.style) : sanitizeMarkdownStyleStore(args.style);
  if (styles) commitMarkdownStyleStore(styles);
}

// The export page as the app makes it (src/lib/use-export.ts): the document's
// HTML with the style's rules and the bundled faces it uses inside the file.
// The page is replaced by it, so `pdf` in a job prints what Export PDF prints.
function Export() {
  useEffect(() => {
    void (async () => {
      const md = await fetch(`/@fs${args.file}`).then((r) => r.text());
      const html = renderMarkdownHTML(md);
      const fontCss = await exportFontCss(html);
      const page = await buildPDFHTML(html, args.theme === "dark" ? "dark" : "light", { markdownStyle: paintedMarkdownStyle(), fontCss });
      document.open();
      document.write(page.replace("</body>", '<script>document.fonts.ready.then(function () { document.body.dataset.sceneExport = "1"; });</script></body>'));
      document.close();
    })();
  }, []);
  return null;
}

function Scene() {
  if (scene === "doc") return <Doc />;
  if (scene === "export") return <Export />;
  if (scene === "share") {
    return <ShareDialog docId={args.doc_id} fileName={args.file_name} body={args.body ?? ""} onClose={() => {}} onChanged={() => {}} />;
  }
  if (scene === "office-cloud") return <OfficeCloud />;
  if (scene === "servers") return <Settings onClose={() => {}} initialSection="advanced" />;
  return <p>unknown scene {scene}</p>;
}

createRoot(document.getElementById("root")!).render(
  <div className="h-screen w-screen bg-background text-foreground">
    <Scene />
  </div>
);
document.body.dataset.sceneMounted = "1";
