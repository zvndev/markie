// @vitest-environment jsdom
//
// The Darkmown half of what agents are taught (mcp/markdown-guide.mjs).
//
// An agent cannot run Markie's preview, so it copies the shapes the guide
// shows. A shape that does not compile, or that Markie's sanitizer quietly
// switches off, is a document that looks broken to a person who never sees
// the guide. So every ```wd example in the guide, and every .wd sample under
// docs/document-testing/samples, goes through the same compile, sanitize and
// runtime path the app's preview uses, and the limits the guide states are
// asserted here too. When one of these fails, either fix the example or fix
// the sentence that describes it.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKDOWN_GUIDE } from "../../../mcp/markdown-guide.mjs";
import { compileDarkmownPreview } from "./preview";
import { DARKMOWN_RUNTIME_SOURCE } from "./compiler";
import { DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE } from "./runtime";

// Production compiles off the UI thread in a disposable worker. The worker
// client has its own tests; here the compile itself is what is under test.
vi.mock("./compiler-worker-client", async () => {
  const { compileDarkmown } = await import("./compiler");
  return { compileDarkmownOffThread: async (source: string) => compileDarkmown(source) };
});

const SAMPLES_DIR = path.resolve(__dirname, "../../../docs/document-testing/samples");
const SKILL = readFileSync(path.resolve(__dirname, "../../../mcp/skills/markie-conventions/SKILL.md"), "utf8");

/** Every ```wd fence in the guide, with the first heading as its name. */
function guideExamples(): { title: string; source: string }[] {
  const found: { title: string; source: string }[] = [];
  for (const match of MARKDOWN_GUIDE.matchAll(/^```wd\n([\s\S]*?)\n```$/gm)) {
    const source = `${match[1]}\n`;
    const title = /^# (.+)$/m.exec(source)?.[1] ?? "";
    found.push({ title, source });
  }
  return found;
}

const examples = guideExamples();
const example = (title: string) => {
  const hit = examples.find((e) => e.title === title);
  if (!hit) throw new Error(`The guide has no Darkmown example titled "${title}"`);
  return hit.source;
};

/** The error message a source is refused with, or "" when it compiles. */
const rejected = async (source: string) => {
  try { await compileDarkmownPreview(source, true); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return "";
};

const tick = (win: Window) => new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));

/** A document in the same sandbox shape as the app's preview iframe. */
async function open(source: string, trusted = true) {
  const { srcDoc, warnings } = await compileDarkmownPreview(source, trusted);
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const win = frame.contentWindow as Window & typeof globalThis;
  const parsed = new DOMParser().parseFromString(srcDoc, "text/html");
  win.document.documentElement.innerHTML = parsed.documentElement.innerHTML;
  Object.defineProperty(win, "structuredClone", { value: structuredClone });
  if (trusted) {
    win.eval(DARKMOWN_RUNTIME_SOURCE);
    win.eval(DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE);
    await tick(win);
  }
  const doc = win.document;
  const main = () => doc.querySelector("main") ?? doc.body;
  const fire = async (el: Element, type = "input") => {
    el.dispatchEvent(new win.Event(type, { bubbles: true }));
    await tick(win);
  };
  return {
    warnings,
    doc,
    text: () => main().textContent!.replace(/\s+/g, " ").trim(),
    button: (label: string) => {
      const found = [...doc.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!found) throw new Error(`No button "${label}"`);
      return found;
    },
    async click(label: string) {
      const found = [...doc.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!found) throw new Error(`No button "${label}"`);
      found.click();
      await tick(win);
    },
    /** Tick or untick a labelled checkbox. */
    async toggleBox(label: string) {
      const input = [...doc.querySelectorAll("label")].find((l) => l.textContent!.trim() === label)?.querySelector("input");
      if (!input) throw new Error(`No checkbox "${label}"`);
      input.checked = !input.checked;
      await fire(input);
    },
    /** Pick a radio option by its text. */
    async pickRadio(value: string) {
      const input = [...doc.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((r) => r.value === value);
      if (!input) throw new Error(`No radio "${value}"`);
      input.checked = true;
      await fire(input);
    },
    /** Set a bound control, found by the state it is bound to. */
    async setBound(key: string, value: string) {
      const input = doc.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-wd-bind-input="${key}"]`);
      if (!input) throw new Error(`Nothing is bound to "${key}"`);
      input.value = value;
      await fire(input);
    },
    async type(name: string, value: string) {
      const input = doc.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
      if (!input) throw new Error(`No field "${name}"`);
      input.value = value;
    },
    close: () => frame.remove(),
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("every Darkmown example the guide shows", () => {
  it("is there in strength, so deleting them cannot make this suite pass", () => {
    expect(examples.map((e) => e.title)).toEqual([
      "Water tracker",
      "Project estimate",
      "Greeting",
      "Plan picker",
      "Order total",
      "Launch checklist",
      "Make pasta",
      "RSVP",
      "Notes",
    ]);
  });

  for (const { title, source } of examples) {
    it(`compiles and survives Markie's sanitizer untouched: ${title}`, async () => {
      // No error from the compiler or the preview limits, and no warning: a
      // warning is the sanitizer saying it switched something off.
      const trusted = await compileDarkmownPreview(source, true);
      expect(trusted.warnings).toEqual([]);
      // Untrusted drops a form's markup until the user trusts the document, so
      // it may warn about that. It must still build.
      await expect(compileDarkmownPreview(source, false)).resolves.toBeDefined();
    });
  }

  it("includes the one in the plugin skill, which compiles the same way", async () => {
    const fromSkill = [...SKILL.matchAll(/^```wd\n([\s\S]*?)\n```$/gm)].map((m) => `${m[1]}\n`);
    expect(fromSkill).toHaveLength(1);
    const page = await open(fromSkill[0]);
    expect(page.warnings).toEqual([]);
    expect(page.text()).toContain("Left to do: 2 of 2.");
    await page.toggleBox("Design approved");
    expect(page.text()).toContain("Left to do: 1 of 2.");
  });

  it("is within every preview limit it states", () => {
    for (const { source } of examples) {
      expect(source.length).toBeLessThan(128_000);
      expect(source.split("\n").length).toBeLessThan(5_000);
    }
  });
});

describe("the .wd samples shipped with the test guide", () => {
  const samples = readdirSync(SAMPLES_DIR).filter((name) => name.endsWith(".wd"));

  it("include the originals and the agent-guide ones", () => {
    expect(samples).toEqual(expect.arrayContaining(["Counter.wd", "Local-form.wd", "Launch-checklist.wd", "Estimate.wd", "Step-through.wd", "Order-total.wd"]));
  });

  for (const name of samples) {
    it(`${name} compiles with nothing switched off`, async () => {
      const source = readFileSync(path.join(SAMPLES_DIR, name), "utf8");
      const result = await compileDarkmownPreview(source, true);
      expect(result.warnings).toEqual([]);
    });
  }
});

describe("the examples do what the guide says they do", () => {
  it("starts switched off until the user trusts the document", async () => {
    const page = await open(example("Water tracker"), false);
    expect(page.text()).toContain("Today: 0 cups, about 0 ounces.");
    expect([...page.doc.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  });

  it("counts, derives and resets (:state, :computed, :button)", async () => {
    const page = await open(example("Water tracker"));
    expect(page.text()).toContain("Today: 0 cups, about 0 ounces.");
    await page.click("Add a cup");
    await page.click("Add a cup");
    expect(page.text()).toContain("Today: 2 cups, about 16 ounces.");
    await page.click("Remove a cup");
    expect(page.text()).toContain("Today: 1 cups, about 8 ounces.");
    await page.click("Start over");
    expect(page.text()).toContain("Today: 0 cups, about 0 ounces.");
  });

  it("recalculates a table from sliders (:slider, chained :computed)", async () => {
    const page = await open(example("Project estimate"));
    const cells = () => [...page.doc.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells()).toEqual(["Hours", "20", "Rate", "120", "Subtotal", "2400", "Discount", "240", "Total", "2160"]);
    await page.setBound("hours", "10");
    expect(cells()).toEqual(["Hours", "10", "Rate", "120", "Subtotal", "1200", "Discount", "120", "Total", "1080"]);
    await page.setBound("rate", "100");
    expect(cells().slice(-2)).toEqual(["Total", "900"]);
  });

  it("echoes typed text (:bind)", async () => {
    const page = await open(example("Greeting"));
    await page.setBound("who", "Ada");
    expect(page.text()).toContain("Hello Ada.");
  });

  it("keeps digits typed into a bound input usable in arithmetic", async () => {
    const page = await open(':state n = 4\n:computed double = n * 2\n:bind n\n\n{ double }\n');
    await page.setBound("n", "50");
    expect(page.text()).toBe("100");
  });

  it("follows bound radio, select, checkbox and slider controls", async () => {
    const page = await open(example("Plan picker"));
    expect(page.text()).toContain("Plan: Basic. Region: Europe. Seats: 5. Pay yearly: false.");
    await page.pickRadio("Pro");
    await page.setBound("region", "Asia");
    await page.setBound("seats", "12");
    await page.toggleBox("Pay yearly");
    expect(page.text()).toContain("Plan: Pro. Region: Asia. Seats: 12. Pay yearly: true.");
  });

  it("counts ticked boxes by subtraction and rounds the percentage with % (a checklist that counts)", async () => {
    const page = await open(example("Launch checklist"));
    expect(page.text()).toContain("Left to do: 3 of 3. Progress: 0%.");
    await page.toggleBox("Design approved");
    expect(page.text()).toContain("Left to do: 2 of 3. Progress: 33%.");
    await page.toggleBox("Copy written");
    expect(page.text()).toContain("Left to do: 1 of 3. Progress: 66%.");
    await page.toggleBox("Shipped");
    expect(page.text()).toContain("Left to do: 0 of 3. Progress: 100%.");
    await page.toggleBox("Shipped");
    expect(page.text()).toContain("Left to do: 1 of 3. Progress: 66%.");
  });

  it("would print 33.333333333333336 for one of three without the rounding the guide teaches", async () => {
    expect(MARKDOWN_GUIDE).toContain("33.333333333333336");
    const raw = await open(":state done = 1\n:computed raw = done * 100 / 3\n\n{ raw }\n");
    expect(raw.text()).toBe("33.333333333333336");
    const rounded = await open(":state done = 1\n:computed raw = done * 100 / 3\n:computed percent = raw - raw % 1\n\n{ percent }\n");
    expect(rounded.text()).toBe("33");
  });

  it("adds by subtracting a negative, with a name or with parentheses, and both update live", async () => {
    const page = await open(':state a = 4\n:state b = 3\n:computed s = a - -b\n:computed t = a - (0 - b)\n:button "Up" -> a++\n\n{ s } { t }\n');
    expect(page.warnings).toEqual([]);
    expect(page.text()).toContain("7 7");
    await page.click("Up");
    expect(page.text()).toContain("8 8");
    // The exact sentence the guide and the skill teach.
    expect(MARKDOWN_GUIDE).toContain("total = subtotal - -tax");
    expect(SKILL).toContain("total = subtotal - -tax");
    expect(await rejected(":state a = 1\n:state b = 2\n:computed c = a + b\n\n{ c }\n")).toMatch(/Computed addition/);
  });

  it("rounds with % on a number, to the nearest by adding one half first", async () => {
    const floor = await open(":state x = 7.9\n:computed whole = x - x % 1\n\n{ whole }\n");
    expect(floor.text()).toBe("7");
    const nearest = await open(":state x = 7.9\n:computed half = x - -0.5\n:computed whole = half - half % 1\n\n{ whole }\n");
    expect(nearest.text()).toBe("8");
  });

  it("feeds numeric radio and select options straight into :computed, and rounds money to the nearest cent", async () => {
    const page = await open(example("Order total"));
    expect(page.warnings).toEqual([]);
    // 12.99 plus 8% tax is 14.0292, which rounds to 14.03. A floor would say 14.02.
    expect(page.text()).toContain("Total with tax: 14.03 for 1 at 12.99 each.");
    await page.setBound("qty", "5");
    expect(page.text()).toContain("Total with tax: 70.15 for 5 at 12.99 each.");
    await page.pickRadio("40");
    expect(page.text()).toContain("Total with tax: 216 for 5 at 40 each.");
    await page.pickRadio("24.5");
    await page.setBound("qty", "2");
    expect(page.text()).toContain("Total with tax: 52.92 for 2 at 24.5 each.");
    // Trailing zeros are not printed, and the guide says so.
    await page.pickRadio("40");
    await page.setBound("qty", "1");
    expect(page.text()).toContain("Total with tax: 43.2 for 1 at 40 each.");
    expect(MARKDOWN_GUIDE).toContain("70.50 shows `70.5`");
  });

  it("adds two numeric choices with a subtracted negative", async () => {
    const page = await open(":state qty = 1\n:state tier = 10\n:radio tier\n- 10\n- 25\n:select qty\n- 1\n- 5\n:computed s = qty - -tier\n\nSum { s }\n");
    await page.pickRadio("25");
    await page.setBound("qty", "5");
    expect(page.text()).toContain("Sum 30");
  });

  it("steps through text by setting state, and toggles a flag", async () => {
    const page = await open(example("Make pasta"));
    expect(page.text()).toContain("Step 1 of 4: Boil salted water.");
    await page.click("Step 3");
    expect(page.text()).toContain("Step 3 of 4: Drain, and keep a cup of the water.");
    await page.click("Step 4");
    expect(page.text()).toContain("Step 4 of 4: Toss with the sauce and serve.");
    expect(page.text()).toContain("Stove on: false");
    await page.click("Switch the stove");
    expect(page.text()).toContain("Stove on: true");
    await page.click("Switch the stove");
    expect(page.text()).toContain("Stove on: false");
  });

  it("puts a submitted form into temporary state, sending nothing", async () => {
    const page = await open(example("RSVP"));
    const network = vi.fn();
    (page.doc.defaultView as unknown as { fetch: unknown }).fetch = network;
    await page.type("name", "Ada");
    await page.type("meal", "Fish");
    await page.pickRadio("Window");
    await page.type("note", "No nuts");
    await page.click("Send RSVP");
    expect(page.text()).toContain("Last answer: Ada wants the Fish, Window seat. No nuts");
    expect(network).not.toHaveBeenCalled();
  });

  it("draws a plain group for ::: and keeps the words inside it", async () => {
    const page = await open(example("Notes"));
    expect(page.text()).toContain("Heads up: the totals below update as you move the sliders.");
    expect(page.doc.querySelector("strong")?.textContent).toBe("Heads up:");
  });

  it("chains actions with a semicolon and reaches into an object", async () => {
    const page = await open(':state cart = {"count": 0, "total": 0}\n:button "Add" -> cart.count++ ; cart.total += 9\n\nItems { cart.count }, total { cart.total }\n');
    await page.click("Add");
    await page.click("Add");
    expect(page.text()).toContain("Items 2, total 18");
  });

  it("supports every button action the guide lists", async () => {
    const page = await open([
      ":state n = 0",
      ":state label = \"start\"",
      ":state on = false",
      ':button "inc" -> n++',
      ':button "dec" -> n--',
      ':button "plus" -> n += 5',
      ':button "minus" -> n -= 2',
      ':button "set" -> n = 10',
      ':button "label" -> label = "Done"',
      ':button "true" -> on = true',
      ':button "flip" -> on toggle',
      ':button "reset" -> n reset',
      "",
      "{ n } { label } { on }",
      "",
    ].join("\n"));
    const run = async (...labels: string[]) => { for (const l of labels) await page.click(l); return page.text().split(" ").slice(-3).join(" "); };
    expect(await run("inc", "inc", "dec")).toBe("1 start false");
    expect(await run("plus", "minus")).toBe("4 start false");
    expect(await run("set")).toBe("10 start false");
    expect(await run("label", "true")).toBe("10 Done true");
    expect(await run("flip")).toBe("10 Done false");
    expect(await run("reset")).toBe("0 Done false");
  });

  it("allows a semicolon between actions and numbers with a leading minus", async () => {
    const page = await open(':state a = 10\n:state b = 3\n:computed d = -a\n:computed e = (a - b) * 2\n:computed f = a % b\n:computed g = a / 4\n\n{ d } { e } { f } { g }\n');
    expect(page.text()).toBe("-10 14 1 2.5");
  });

  it("lets a computed value use another computed value", async () => {
    const page = await open(':state a = 4\n:computed b = a * 2\n:computed c = b - 1\n:button "Up" -> a++\n\n{ c }\n');
    await page.click("Up");
    expect(page.text()).toContain("9");
  });

  it("prints floating point numbers the way JavaScript does", async () => {
    const page = await open(":state a = 0.1\n:computed t = a * 3\n\n{ t }\n");
    expect(page.text()).toBe("0.30000000000000004");
  });

  it("puts bindings in headings, lists, quotes and table cells", async () => {
    const page = await open(":state n = 2\n:button \"Up\" -> n++\n\n## Total { n }\n\n- Item { n }\n\n> Quote { n }\n\n| A |\n| - |\n| { n } |\n");
    await page.click("Up");
    expect(page.doc.querySelector("h2")?.textContent).toBe("Total 3");
    expect(page.doc.querySelector("li")?.textContent).toBe("Item 3");
    expect(page.doc.querySelector("blockquote")?.textContent?.trim()).toBe("Quote 3");
    expect(page.doc.querySelector("td")?.textContent).toBe("3");
  });
});

describe("what the guide says does not work in Darkmown preview", () => {
  const switchedOff = async (source: string) => (await compileDarkmownPreview(source, true)).warnings.length > 0;

  it(":if never switches, so its text is never shown by a click", async () => {
    const source = ':state open = false\n:button "Flip" -> open toggle\n\n:if open\nDetails shown.\n:endif\n';
    expect(await switchedOff(source)).toBe(true);
    const page = await open(source);
    await page.click("Flip");
    expect(page.text()).not.toContain("Details shown.");
  });

  it("refuses loops and includes", async () => {
    expect(await rejected(":state rows = [1]\n\n@loop rows into r\n{ r }\n@endloop\n")).toMatch(/Loops and included files are not available/);
    expect(await rejected("@include /other.wd\n")).toMatch(/Loops and included files are not available/);
  });

  it("refuses + in :computed", async () => {
    expect(await rejected(":state a = 1\n:state b = 2\n:computed c = a + b\n\n{ c }\n")).toMatch(/Computed addition/);
  });

  it("refuses format pipes", async () => {
    expect(await rejected(":state p = 5\n\n{ p | money }\n")).toMatch(/Format pipelines are not available/);
  });

  it("switches off comparisons and aggregates in :computed", async () => {
    expect(await switchedOff(":state n = 1\n:computed big = n > 5\n\n{ big }\n")).toBe(true);
    expect(await switchedOff(':state rows = [{"p": 1}, {"p": 2}]\n:computed total = sum(rows, p)\n\n{ total }\n')).toBe(true);
    expect(await switchedOff(':state rows = [{"p": 1}, {"p": 2}]\n:computed total = count(rows)\n\n{ total }\n')).toBe(true);
  });

  it("warns on :store and persist, and :store loses its starting value", async () => {
    expect(await switchedOff(':store cart = 5\n:button "Add" -> cart++\n\n{ cart }\n')).toBe(true);
    expect(await switchedOff(':state n = 0 persist\n:button "Add" -> n++\n\n{ n }\n')).toBe(true);
    const page = await open(':store cart = 5\n\nCart: { cart }\n');
    expect(page.text()).toBe("Cart:");
  });

  it("refuses a semicolon inside a quoted action value", async () => {
    expect(await rejected(':state now = "x"\n:button "Go" -> now = "one; two"\n\n{ now }\n')).toMatch(/WD314/);
  });

  it("switches off timers, effects, fetches, themes and carousels", async () => {
    expect(await switchedOff(":state secs = 0\n:every 1s -> secs++\n\n{ secs }\n")).toBe(true);
    expect(await switchedOff(':state q = 0\n:state s = 0\n:effect q -> s++\n:button "Go" -> q++\n\n{ s }\n')).toBe(true);
    expect(await switchedOff(':fetch roster from "https://example.invalid/r"\n\n{ roster_loading }\n')).toBe(true);
    expect(await switchedOff(":theme\n")).toBe(true);
    expect(await switchedOff(":carousel\n::: slide\nOne\n:::\n:endcarousel\n")).toBe(true);
  });

  it("switches off media directives", async () => {
    for (const source of [':video "clip.mp4"\n', ':audio "tone.mp3"\n', ':embed "https://example.com/x"\n']) {
      const message = await rejected(source);
      const warned = message ? true : await switchedOff(source);
      expect(warned, source).toBe(true);
    }
  });

  it("disables buttons whose action changes a list or an object", async () => {
    for (const action of ['list append "x"', 'list prepend "x"', 'list remove "x"', "list clear", 'obj merge {"a": 1}', 'obj delete "a"']) {
      const source = `:state list = ["a"]\n:state obj = {"a": 0}\n:button "Go" -> ${action}\n\n{ list }\n`;
      const page = await open(source).catch(() => null);
      if (page === null) continue; // refused outright is also not available
      const disabled = page.button("Go").disabled || page.warnings.length > 0;
      expect(disabled, action).toBe(true);
    }
  });

  it("disables an :input and a :textarea outside a form without a notice, and says :bind is the way", async () => {
    const input = ":state qty = 2\n:input qty type=number\n\nQty: { qty }\n";
    const textarea = ':state note = ""\n:textarea note placeholder="Notes"\n\n{ note }\n';
    const a = await open(input);
    expect(a.doc.querySelector("input")?.disabled).toBe(true);
    expect(a.warnings).toEqual([]);
    const b = await open(textarea);
    expect(b.doc.querySelector("textarea")?.disabled).toBe(true);
    expect(b.warnings).toEqual([]);
    expect(MARKDOWN_GUIDE).toContain("`:input` and `:textarea` outside a form are disabled silently");
  });

  it("raises no notice for a - [ ] task list, footnotes, math or raw HTML, which is why the guide says so", async () => {
    for (const source of ["- [ ] one\n- [x] two\n", "Note[^1]\n\n[^1]: the note\n", "$x^2$\n", "<mark>marked</mark>\n"]) {
      expect((await compileDarkmownPreview(source, true)).warnings, source).toEqual([]);
    }
    expect(MARKDOWN_GUIDE).toContain("`- [ ]` task lists show the literal brackets");
  });

  it("raises a notice for links and pictures, an :if and a right-aligned table", async () => {
    for (const source of ["[Docs](https://example.com)\n", "![pic](x.png)\n", ":state o = false\n:if o\nX\n:endif\n", "| A |\n| ---: |\n| 1 |\n"]) {
      expect((await compileDarkmownPreview(source, true)).warnings.length, source).toBeGreaterThan(0);
    }
  });

  it("stops with WD234 when :computed names something declared later or never, and prints an undeclared { name } as itself", async () => {
    expect(await rejected(":state a = 1\n:computed b = a * missing\n\n{ b }\n")).toMatch(/WD234/);
    expect(await rejected(":computed b = a * 2\n:state a = 1\n\n{ b }\n")).toMatch(/WD234/);
    const before = await open("Hello { a }\n\n:state a = 1\n");
    expect(before.warnings).toEqual([]);
    expect(before.text()).toContain("Hello { a }");
    const never = await open(":state a = 1\n\nHello { missing } and { a }\n");
    expect(never.text()).toContain("Hello { missing } and 1");
    expect(MARKDOWN_GUIDE).toContain("prints as `{ name }`");
    expect(MARKDOWN_GUIDE).toContain("WD234");
  });

  it("switches off a checkbox group inside a form", async () => {
    expect(await switchedOff(":form into f\n:checkbox channels\n- Email\n- SMS\n:submit \"Save\"\n:endform\n\n{ f.channels }\n")).toBe(true);
  });

  it("refuses a bound control whose state is not declared, and a bound checkbox with several labels", async () => {
    expect(await rejected(":select density\n- Compact\n- Spacious\n")).toMatch(/WD450/);
    expect(await rejected(":state a = false\n:checkbox a\n- One\n- Two\n")).toMatch(/WD451/);
  });

  it("refuses :bind attributes other than placeholder", async () => {
    expect(await rejected(":state price = 40\n:bind price min=0 max=100\n\n{ price }\n")).toMatch(/WD408/);
  });

  it("reports compile errors with a code and leaves the source alone", async () => {
    expect(await rejected(":state\n")).toMatch(/WD201/);
  });

  it("does not render links, pictures, task lists, footnotes, math or raw HTML the way .md does", async () => {
    const page = await open("[Docs](https://example.com) and [rel](other.md)\n\n![pic](x.png)\n\n- [ ] one\n- [x] two\n\nNote[^1]\n\n[^1]: the note\n\n$x^2$\n\n<mark>marked</mark>\n");
    expect(page.doc.querySelector("a[href]")).toBeNull();
    expect(page.doc.querySelector("img")).toBeNull();
    expect(page.doc.querySelector("input[type=checkbox]")).toBeNull();
    expect(page.text()).toContain("[ ] one");
    expect(page.text()).toContain("$x^2$");
    expect(page.doc.querySelector("mark")).toBeNull();
    expect(page.text()).toContain("Docs and rel");
  });

  it("switches off column alignment in a table, with a notice", async () => {
    expect(await switchedOff("| A | B |\n| --- | ---: |\n| 1 | 2 |\n")).toBe(true);
    expect(await switchedOff("| A | B |\n| --- | --- |\n| 1 | 2 |\n")).toBe(false);
  });

  it("renders fenced code with no colour", async () => {
    const page = await open("```js\nconst x = 1;\n```\n");
    expect(page.doc.querySelector("pre code")?.textContent).toContain("const x = 1;");
    expect(page.doc.querySelector("pre [class]")).toBeNull();
  });

  it("drops style classes on ::: so it adds no box", async () => {
    const page = await open("::: card .featured\nInside.\n:::\n");
    expect(page.doc.querySelector("main div[class]")).toBeNull();
    expect(page.text()).toContain("Inside.");
  });

  it("treats a directive that is indented, in a list, or in a fence as text", async () => {
    const page = await open(":state n = 1\n\n  :button \"Indented\" -> n++\n\n- :button \"Listed\" -> n++\n\n```\n:button \"Fenced\" -> n++\n```\n\n{ n }\n");
    expect([...page.doc.querySelectorAll("button")]).toHaveLength(0);
  });
});

describe("the limits the guide states", () => {
  it("previews at most 128,000 characters, and exactly 128,000 is accepted", async () => {
    expect(await rejected("a".repeat(128_000))).toBe("");
    expect(await rejected("a".repeat(128_001))).toMatch(/128,000 characters and 5,000 lines/);
    expect(await rejected(`# Big\n\n${"a".repeat(128_000)}`)).toMatch(/128,000 characters and 5,000 lines/);
  });

  it("previews at most 5,000 lines, and exactly 5,000 is accepted", async () => {
    expect(await rejected(Array.from({ length: 5_000 }, () => "a").join("\n"))).toBe("");
    expect(await rejected(Array.from({ length: 5_001 }, () => "a").join("\n"))).toMatch(/5,000 lines/);
    expect(await rejected("a\n".repeat(5_001))).toMatch(/5,000 lines/);
  });

  it("counts the empty line after a final newline, as the guide says", async () => {
    // 5,000 lines that each end in a newline are 5,001 once split.
    expect(await rejected("a\n".repeat(5_000))).toMatch(/5,000 lines/);
    expect(await rejected("a\n".repeat(4_999))).toBe("");
    expect(MARKDOWN_GUIDE).toContain("(a final newline counts as a line)");
  });

  it("holds length times (braces plus :computed lines) to 1,000,000", async () => {
    // 100,000 characters can carry ten braces. Eleven pass the line.
    const filler = (braces: number) => `:state n = 1\n${"{ n } ".repeat(braces)}\n${"x ".repeat(48_000)}\n`;
    expect(await rejected(filler(2))).toBe("");
    expect(await rejected(filler(20))).toMatch(/complexity budget/);
  });
});
