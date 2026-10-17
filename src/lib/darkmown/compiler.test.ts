// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { compileDarkmown, DARKMOWN_RUNTIME_SOURCE, DARKMOWN_SOURCE_LIMIT } from "./compiler";
import { compileFromMemory } from "./vendor/compiler-browser.mjs";
import provenance from "./vendor/PROVENANCE.json";
import runtimePolicy from "../../../electron/darkmown-runtime-policy.json";

const COUNTER = `---
title: My counter
---
# Counter

:state count = 0
:computed total = count * 4

Count: { count }. Total: { total }.

:button "Add one" -> count++
:button "Reset" -> count reset
`;

afterEach(() => vi.unstubAllGlobals());

describe("pinned offline Darkmown compiler and runtime", () => {
  it("compiles real state, actions and calculations without evaluating the document", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = compileDarkmown(COUNTER);
    expect(result).toMatchObject({ title: "My counter", requiresRuntime: true, hasCode: false });
    expect(result.bodyHtml).toContain('data-wd-state>{"count":0}</script>');
    expect(result.bodyHtml).toContain('data-wd-action="inc" data-wd-target="count"');
    expect(result.bodyHtml).toContain('data-wd-computed-key="total"');
    expect(fetch).not.toHaveBeenCalled();
    expect(COUNTER).toContain(":state count = 0");
  });

  it("executes the original runtime offline and keeps runtime mutations out of authored source", async () => {
    const result = compileDarkmown(COUNTER);
    // A synthetic test document, not a production authorization/sanitization path.
    const frame = document.createElement("iframe"); document.body.append(frame);
    const runtimeWindow = frame.contentWindow as Window & typeof globalThis;
    runtimeWindow.document.body.innerHTML = result.bodyHtml;
    try {
      Object.defineProperty(runtimeWindow, "structuredClone", { value: structuredClone });
      runtimeWindow.eval(DARKMOWN_RUNTIME_SOURCE);
      const count = () => runtimeWindow.document.querySelector('[data-wd-bind="count"]')?.textContent;
      const total = () => runtimeWindow.document.querySelector('[data-wd-bind="total"]')?.textContent;
      expect(count()).toBe("0"); expect(total()).toBe("0");
      runtimeWindow.document.querySelector<HTMLButtonElement>('[data-wd-action="inc"]')!.click();
      await new Promise<void>((resolve) => runtimeWindow.requestAnimationFrame(() => resolve()));
      expect(count()).toBe("1"); expect(total()).toBe("4");
      runtimeWindow.document.querySelector<HTMLButtonElement>('[data-wd-action="reset"]')!.click();
      await new Promise<void>((resolve) => runtimeWindow.requestAnimationFrame(() => resolve()));
      expect(count()).toBe("0"); expect(total()).toBe("0");
      expect(COUNTER).toContain(":state count = 0");
    } finally { frame.remove(); }
  });

  it("does not reinterpret plain Markdown directives as an executable document", () => {
    const entry = "site/pages/notes.md";
    const result = compileFromMemory({ [entry]: COUNTER }, entry, { cwd: "/" });
    expect(result.assets.runtime).toBe(false);
    expect(result.html).not.toContain("data-wd-action");
    expect(result.html).toContain(":state count = 0");
  });

  it("has no implicit adjacent files, network data or arbitrary project script execution", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => compileDarkmown("@include /private.wd")).toThrow();
    expect(() => compileDarkmown("@loop /private.json into row\n{ row.name }\n@endloop")).toThrow();
    const result = compileDarkmown(':fetch roster from "https://example.invalid/roster"\n\n{ roster_loading }');
    expect(result.requiresRuntime).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.bodyHtml).not.toContain('src="/document.js"');
  });

  it("retains compiler diagnostics and rejects oversized preview input without changing it", () => {
    expect(() => compileDarkmown(":state")).toThrow(/WD201/);
    expect(() => compileDarkmown("x".repeat(DARKMOWN_SOURCE_LIMIT + 1))).toThrow(/source remains available/);
    expect(() => compileDarkmown("\n".repeat(5_000))).toThrow(/5,000 lines/);
  });

  it("pins every generated artifact, notices and the exact Electron runtime hash", () => {
    const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    expect(provenance.commit).toBe("f3023a444696bcbcbc0475d718889291d88af7b1");
    for (const [name, descriptor] of Object.entries(provenance.artifacts)) {
      const bytes = readFileSync(path.resolve("src/lib/darkmown/vendor", name));
      expect(bytes.byteLength).toBe(descriptor.bytes);
      expect(sha256(bytes)).toBe(descriptor.sha256);
    }
    expect(sha256(readFileSync(path.resolve("scripts/build-darkmown-vendor.mjs")))).toBe(provenance.build.scriptSha256);
    expect(createHash("sha256").update(DARKMOWN_RUNTIME_SOURCE).digest("base64")).toBe(runtimePolicy.runtimeSha256);
    for (const adaptation of provenance.hostAdaptations) {
      const bytes = readFileSync(path.resolve(adaptation.path));
      expect(bytes.byteLength).toBe(adaptation.bytes);
      expect(sha256(bytes)).toBe(adaptation.sha256);
      expect(bytes.toString("utf8")).not.toMatch(/<\/script/i);
    }
    const bootstrap = readFileSync(path.resolve("src/lib/darkmown/local-form-bootstrap.js.txt"));
    expect(createHash("sha256").update(bootstrap).digest("base64")).toBe(runtimePolicy.bootstrapSha256);
    expect(DARKMOWN_RUNTIME_SOURCE).not.toMatch(/<\/script/i);
    for (const name of ["PROVENANCE.json", "THIRD-PARTY-NOTICES.txt"]) {
      expect(readFileSync(path.resolve("public/darkmown", name), "utf8")).toBe(readFileSync(path.resolve("src/lib/darkmown/vendor", name), "utf8"));
    }
    const compiler = readFileSync(path.resolve("src/lib/darkmown/vendor/compiler-browser.mjs"), "utf8");
    expect(compiler).not.toMatch(/node:fs|\/Users\//);
    expect(provenance.inputs.every((item) => !item.path.includes("fs-reader") && !item.path.startsWith("../"))).toBe(true);
    expect(provenance.bundledPackages.map((item) => item.name)).toContain("@zvndev/darkmown");
    expect(provenance.bundledPackages.map((item) => item.name)).toContain("markdown-it");
  });
});
