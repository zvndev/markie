// @vitest-environment jsdom
//
// markie_check_wd reads compiled output with patterns, because the MCP server takes
// no dependencies. The app's preview reads it with a real parser. An agent trusts
// the first and a person sees the second, so here they have to agree.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkDarkmown } from "../../../mcp/check-wd.mjs";
import { MARKDOWN_GUIDE } from "../../../mcp/markdown-guide.mjs";
import { compileDarkmownPreview } from "./preview";

vi.mock("./compiler-worker-client", async () => {
  const { compileDarkmown } = await import("./compiler");
  return { compileDarkmownOffThread: async (source: string) => compileDarkmown(source) };
});

const SAMPLES = path.resolve(__dirname, "../../../docs/document-testing/samples");
const samples = readdirSync(SAMPLES).filter((name) => name.endsWith(".wd")).map((name) => [name, readFileSync(path.join(SAMPLES, name), "utf8")]);
const guide = [...MARKDOWN_GUIDE.matchAll(/^```wd\n([\s\S]*?)\n```$/gm)].map((match, index) => [`guide example ${index}`, `${match[1]}\n`]);

const SWITCHED_OFF = [
  ':fetch roster from "https://example.invalid/r"\n\n{ roster_loading }\n',
  ":store cart = 5\n\n{ cart }\n",
  ":state n = 0 persist\n\n{ n }\n",
  ":state q = 0 from-url\n\n{ q }\n",
  ":state secs = 0\n:every 1s -> secs++\n\n{ secs }\n",
  ':state q = 0\n:state s = 0\n:effect q -> s++\n\n{ s }\n',
  ":theme\n",
  "[Docs](https://example.com)\n",
  ':state u = "/a"\n\n[Docs]({ u })\n',
  "![pic](x.png)\n",
  "| A |\n| ---: |\n| 1 |\n",
  ':state on = true\n\n::: .card when on\nCard\n:::\n',
  ':form action="/api/x"\n:input name\n:submit "Go"\n:endform\n',
];
const STOPS = [":state\n", "@include /other.wd\n", "@loop /rows.json into r\n{ r.a }\n@endloop\n", ":computed b = a * 2\n"];
const CLEAN = [
  ":state n = 1\n\n{ n }\n",
  ':state open = false\n:if open\nYes\n:else\nNo\n:endif\n',
  ":state rows = [1, 2]\n@loop rows into r\n{ r }\n@endloop\n",
  ":state p = 5\n\n{ p | money }\n",
  "- [ ] One\n- [x] Two\n",
];

describe("markie_check_wd agrees with the app's preview", () => {
  it("on every sample and guide example, which all run clean", async () => {
    for (const [name, source] of [...samples, ...guide]) {
      const check = await checkDarkmown(source, `/d/${name}`);
      const preview = await compileDarkmownPreview(source, true);
      expect(check.errors, name).toEqual([]);
      expect(check.switchedOff, name).toEqual([]);
      expect(preview.warnings, name).toEqual([]);
      expect(check.ok, name).toBe(true);
    }
  });

  it("on what the preview switches off", async () => {
    for (const source of SWITCHED_OFF) {
      const check = await checkDarkmown(source, "/d/a.wd");
      const preview = await compileDarkmownPreview(source, true);
      expect(preview.warnings.length, `preview: ${source}`).toBeGreaterThan(0);
      expect(check.switchedOff.length, `check: ${source}`).toBeGreaterThan(0);
      expect(check.ok, source).toBe(false);
    }
  });

  it("on what stops the preview", async () => {
    for (const source of STOPS) {
      await expect(compileDarkmownPreview(source, true), source).rejects.toThrow();
      const check = await checkDarkmown(source, "/d/a.wd");
      expect(check.errors.length, source).toBe(1);
      expect(check.ok, source).toBe(false);
    }
  });

  it("on what runs clean", async () => {
    for (const source of CLEAN) {
      const check = await checkDarkmown(source, "/d/a.wd");
      const preview = await compileDarkmownPreview(source, true);
      expect(preview.warnings, source).toEqual([]);
      expect(check, source).toMatchObject({ ok: true, errors: [], warnings: [], switchedOff: [] });
    }
  });
});
