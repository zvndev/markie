// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { compileDarkmownPreview } from "./preview";
import { DARKMOWN_RUNTIME_SOURCE } from "./compiler";
import { DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE } from "./runtime";
import runtimePolicy from "../../../electron/darkmown-runtime-policy.json";

// Production compilation never falls back to the UI thread. This test exercises
// sanitization/runtime separately from the worker-client tests.
vi.mock("./compiler-worker-client", async () => {
  const { compileDarkmown } = await import("./compiler");
  return { compileDarkmownOffThread: async (source: string) => compileDarkmown(source) };
});

function previewWindow(srcDoc: string, execute = false, network = vi.fn()) {
  const frame = document.createElement("iframe"); document.body.append(frame);
  const window = frame.contentWindow as Window & typeof globalThis;
  const parsed = new DOMParser().parseFromString(srcDoc, "text/html");
  window.document.documentElement.innerHTML = parsed.documentElement.innerHTML;
  Object.defineProperty(window, "structuredClone", { value: structuredClone });
  window.fetch = network;
  if (execute) { window.eval(DARKMOWN_RUNTIME_SOURCE); window.eval(DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE); }
  return { window, close: () => frame.remove() };
}

const COUNTER = '# Counter\n\n:state count = 0\n\nCount: { count }.\n\n:button "Add one" -> count++\n';

describe("trusted interactive Darkmown preview", () => {
  it("pins precisely the framework interpreter rather than allowing inline author JavaScript", async () => {
    const result = await compileDarkmownPreview(COUNTER, true);
    const digest = createHash("sha256").update(DARKMOWN_RUNTIME_SOURCE).digest("base64");
    expect(runtimePolicy.runtimeSha256).toBe(digest);
    expect(runtimePolicy.bootstrapSha256).toBe(createHash("sha256").update(DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE).digest("base64"));
    expect(result.srcDoc).toContain(`sha256-${digest}`);
    expect(result.srcDoc).toContain(`sha256-${runtimePolicy.bootstrapSha256}`);
    expect(result.srcDoc).not.toContain("unsafe-eval");
    expect(result.srcDoc).not.toContain("script-src &#39;unsafe-inline");
    expect(result.srcDoc).toContain("connect-src &#39;none&#39;");
    expect(result.srcDoc).toContain("form-action &#39;none&#39;");
    expect(result.srcDoc).not.toContain('src="/__wd/runtime.js"');
    expect(result.warnings).toEqual([]);
  });

  it("runs a real counter with ephemeral isolated state, without changing source", async () => {
    const { srcDoc } = await compileDarkmownPreview(COUNTER, true);
    const network = vi.fn();
    const dom = previewWindow(srcDoc, true, network);
    expect(dom.window.document.querySelector("[data-wd-bind]")?.textContent).toBe("0");
    dom.window.document.querySelector("button")?.click();
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    expect(dom.window.document.querySelector("[data-wd-bind]")?.textContent).toBe("1");
    expect(network).not.toHaveBeenCalled();
    expect("electronAPI" in dom.window).toBe(false);
    expect(COUNTER).toContain(":state count = 0");
    dom.close();
  });

  it("ships no executable interpreter or state in an untrusted preview", async () => {
    const result = await compileDarkmownPreview(COUNTER, false);
    const dom = previewWindow(result.srcDoc);
    expect(dom.window.document.querySelectorAll("script")).toHaveLength(0);
    expect(dom.window.document.querySelector("button")?.disabled).toBe(true);
    expect(result.srcDoc).toContain("script-src &#39;none&#39;");
    dom.close();
  });

  it("removes author scripts, local paths, fetch directives and parent messaging before runtime executes", async () => {
    const source = COUNTER + '\n<script>parent.postMessage("leak","*");window.hacked=true</script>\n\n<img src="file:///private/secret" onerror="alert(1)">\n\n<a href="https://evil.test">Link</a>\n';
    const result = await compileDarkmownPreview(source, true);
    const dom = previewWindow(result.srcDoc, true);
    expect(dom.window.document.querySelector("img")).toBe(null);
    expect(dom.window.document.querySelector("a[href]")).toBe(null);
    expect("hacked" in dom.window).toBe(false);
    // The first-party compiler can render author HTML literally. Literal text
    // remains visible, but it never becomes an executable element.
    expect([...dom.window.document.querySelectorAll("script")].every((script) => !script.textContent?.includes("parent.postMessage"))).toBe(true);
    dom.close();
  });

  it("submits a local form into temporary document state without a request", async () => {
    const source = ':form into profile\n:input name placeholder="Your name"\n:submit "Use this name"\n:endform\n\nSubmitted: { profile.name }.\n';
    const { srcDoc, warnings } = await compileDarkmownPreview(source, true);
    const network = vi.fn();
    const dom = previewWindow(srcDoc, true, network);
    const input = dom.window.document.querySelector<HTMLInputElement>("input")!;
    input.value = "Avery";
    const form = dom.window.document.querySelector("form")!;
    let submitted: Event | null = null;
    form.addEventListener("submit", (event) => { submitted = event; });
    dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    expect(submitted).not.toBe(null);
    expect((submitted as unknown as Event).defaultPrevented).toBe(true);
    expect(dom.window.document.querySelector("[data-wd-bind]")?.textContent).toBe("Avery");
    expect(network).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    input.value = "Blair";
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    expect(dom.window.document.querySelector("[data-wd-bind]")?.textContent).toBe("Blair");
    expect(network).not.toHaveBeenCalled();
    dom.close();
  });

  it("runs range controls and numeric calculations with the same pinned interpreter", async () => {
    const source = ':state quantity = 2\n:computed total = quantity * 4\n\n:slider quantity min=0 max=10 step=1\n\nTotal: { total }.\n';
    const { srcDoc, warnings } = await compileDarkmownPreview(source, true);
    const dom = previewWindow(srcDoc, true);
    const input = dom.window.document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(input.disabled).toBe(false);
    expect(dom.window.document.querySelector('[data-wd-bind="total"]')?.textContent).toBe("8");
    input.value = "3";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    expect(dom.window.document.querySelector('[data-wd-bind="total"]')?.textContent).toBe("12");
    expect(warnings).toEqual([]);
    dom.close();
  });

  it("Enter does not bypass a disabled default submit button", async () => {
    const source = ':form into profile\n:input name placeholder="Your name"\n:submit "First"\n:submit "Second"\n:endform\n\nSubmitted: { profile.name }.\n';
    const { srcDoc } = await compileDarkmownPreview(source, true);
    const dom = previewWindow(srcDoc, true);
    const buttons = dom.window.document.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
    buttons[0].disabled = true;
    const submitted = vi.fn();
    dom.window.document.querySelector("form")!.addEventListener("submit", submitted);
    const input = dom.window.document.querySelector<HTMLInputElement>("input")!;
    input.value = "Avery";
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(submitted).not.toHaveBeenCalled();
    expect(dom.window.document.querySelector("[data-wd-bind]")?.textContent).toBe("");
    buttons[0].disabled = false;
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    expect(submitted).toHaveBeenCalledOnce();
    expect(dom.window.document.querySelector("[data-wd-bind]")?.textContent).toBe("Avery");
    dom.close();
  });

  it("accepts only the parent's exact one-way appearance enum without resetting runtime state", async () => {
    const { srcDoc } = await compileDarkmownPreview(COUNTER, true, { colorScheme: "dark" });
    expect(srcDoc).toContain(":root{color-scheme:dark}");
    const dom = previewWindow(srcDoc, true);
    const root = dom.window.document.documentElement;
    const postMessage = vi.spyOn(dom.window.parent, "postMessage");
    dom.window.document.querySelector<HTMLButtonElement>("button")!.click();
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    const send = (data: unknown, source: MessageEventSource | null = dom.window.parent) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source }));
    for (const invalid of [null, "dark", [], { type: "wrong", theme: "dark" }, { type: "markie:preview-theme", theme: "url(https://evil.test)" }, { type: "markie:preview-theme", theme: "dark", state: "secret" }]) send(invalid);
    send({ type: "markie:preview-theme", theme: "dark" }, dom.window);
    expect(root.style.colorScheme).toBe("");
    send({ type: "markie:preview-theme", theme: "dark" });
    expect(root.style.colorScheme).toBe("dark");
    send({ type: "markie:preview-theme", theme: "light" });
    expect(root.style.colorScheme).toBe("light");
    expect(dom.window.document.querySelector("[data-wd-bind]")?.textContent).toBe("1");
    expect(postMessage).not.toHaveBeenCalled();
    postMessage.mockRestore();
    dom.close();
  });

  it("projects a fixed initial theme into scriptless untrusted previews", async () => {
    const result = await compileDarkmownPreview(COUNTER, false, { colorScheme: "dark" });
    expect(result.srcDoc).toContain(":root{color-scheme:dark}");
    expect(result.srcDoc).not.toContain("<script>");
  });

  it("rejects oversized input before invoking the compiler", async () => {
    await expect(compileDarkmownPreview("x".repeat(200_001), true)).rejects.toThrow("limited");
  });
});
