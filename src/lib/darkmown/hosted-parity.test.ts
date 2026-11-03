// @vitest-environment jsdom
//
// A hosted Live Doc (server/src/live-docs-worker.ts) must be exactly what the
// Mac preview shows. The server runs synced copies of the pinned compiler and
// of this folder's sanitizer (server/scripts/sync-darkmown.mjs), resolving its
// own node_modules, so the copies and the dependency tree can each drift. This
// runs every sample, every guide example and the known edge cases through both
// pipelines and asserts the same sanitized output. The server suite separately
// asserts the copies are byte-identical (server/src/live-docs-parity.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MARKDOWN_GUIDE } from "../../../mcp/markdown-guide.mjs";
import { validateDarkmownPreviewSource } from "../../../mcp/darkmown-limits.mjs";
import { compileDarkmown } from "./compiler";
import { sanitizeDarkmownBody } from "./security";
import { compileDarkmownPreview } from "./preview";
import { compileFromMemory as hostedCompileFromMemory } from "../../../server/src/generated/darkmown/compiler-browser.mjs";
import { sanitizeDarkmownBody as hostedSanitize } from "../../../server/src/generated/darkmown/security";

vi.mock("./compiler-worker-client", async () => {
  const { compileDarkmown } = await import("./compiler");
  return { compileDarkmownOffThread: async (source: string) => compileDarkmown(source) };
});

const SERVER_COPY = path.resolve(__dirname, "../../../server/src/generated/darkmown");
const SAMPLES = path.resolve(__dirname, "../../../docs/document-testing/samples");

// The hosted worker's steps, in order (live-docs-worker.ts compile()).
async function hosted(source: string) {
  validateDarkmownPreviewSource(source);
  const compiled = hostedCompileFromMemory({ "site/pages/document.wd": source }, "site/pages/document.wd", { cwd: "/" });
  const start = compiled.html.indexOf("<body>\n");
  const end = compiled.html.lastIndexOf("\n</body>");
  const clean = await hostedSanitize(compiled.html.slice(start + "<body>\n".length, end), true);
  return { bodyHtml: clean.bodyHtml, seeds: clean.seeds, warnings: [...compiled.warnings, ...clean.warnings] };
}

// The Mac preview's steps for a trusted document (preview.ts).
async function mac(source: string) {
  const compiled = compileDarkmown(source);
  const clean = await sanitizeDarkmownBody(compiled.bodyHtml, true);
  return { bodyHtml: clean.bodyHtml, seeds: clean.seeds, warnings: [...compiled.warnings, ...clean.warnings] };
}

const samples = readdirSync(SAMPLES).filter((name) => name.endsWith(".wd")).map((name) => [name, readFileSync(path.join(SAMPLES, name), "utf8")]);
const guide = [...MARKDOWN_GUIDE.matchAll(/^```wd\n([\s\S]*?)\n```$/gm)].map((match, index) => [`guide example ${index}`, `${match[1]}\n`]);
const EDGES = [
  ':fetch roster from "https://example.invalid/r"\n\n{ roster_loading }\n',
  ":store cart = 5\n\n{ cart }\n",
  ":state n = 0 persist\n\n{ n }\n",
  ":state q = 0 from-url\n\n{ q }\n",
  ":state secs = 0\n:every 1s -> secs++\n\n{ secs }\n",
  "[Docs](https://example.com)\n",
  "![pic](x.png)\n",
  ':state on = true\n\n::: .card when on\nCard\n:::\n',
  ':form action="/api/x"\n:input name\n:submit "Go"\n:endform\n',
  ":state rows = [1, 2]\n@loop rows into r\n{ r }\n@endloop\n",
  ":state p = 5\n\n{ p | money }\n",
  "- [ ] One\n- [x] Two\n",
  "<script>alert(1)</script>\n\n# Title\n",
].map((source, index) => [`edge ${index}`, source]);

describe("a hosted Live Doc is the Mac preview", () => {
  it.each([...samples, ...guide, ...EDGES])("%s compiles and sanitizes identically on the server", async (_name, source) => {
    expect(await hosted(source)).toEqual(await mac(source));
  });

  it("refuses what the preview refuses", async () => {
    for (const source of ["@include /other.wd\n", "a".repeat(128_001)]) {
      await expect(hosted(source)).rejects.toThrow();
      expect(() => compileDarkmown(source)).toThrow();
    }
  });

  it.each([
    '<script>parent.postMessage("attack","*")</script>',
    '<svg><a xlink:href="javascript:alert(1)"><animate attributeName="href" to="https://evil.test"></animate></a></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://evil.test"></object>',
    '<link rel="stylesheet" href="https://evil.test"><style>@import "https://evil.test";</style>',
    '<img src="https://evil.test" onerror="alert(1)">',
    '<template><img src="https://evil.test"><script>alert(1)</script></template>',
    '<form data-wd-form="f" action="https://evil.test"><input name="x"></form>',
  ])("the server's sanitizer copy drops what the Mac's drops (%s)", async (markup) => {
    expect(await hostedSanitize(markup, true)).toEqual(await sanitizeDarkmownBody(markup, true));
  });

  it("uses the preview's page style", async () => {
    const preview = await compileDarkmownPreview("# Style\n", true);
    const style = /<style>:root\{color-scheme:light\}([\s\S]*?)<\/style>/.exec(preview.srcDoc)?.[1];
    expect(style).toBe(readFileSync(path.join(SERVER_COPY, "preview-style.css"), "utf8"));
  });
});
