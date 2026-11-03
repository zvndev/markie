import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseCssColor } from "@/components/documents/word-colors";

// The read view's code colours. globals.css loads highlight.js's github-dark
// for every theme, so in light mode any class doc-view.css leaves alone keeps
// a colour meant for a near-black background: tag names, selectors, YAML
// bullets, regexes and `${…}` read at 1.4 to 1.7:1 on the light code block.
// Every class the theme colours must be given a colour per tone here, and
// each must reach WCAG AA (4.5:1) on the code block it sits on.

const require = createRequire(import.meta.url);
const theme = readFileSync(require.resolve("highlight.js/styles/github-dark.css"), "utf8");
const view = readFileSync(new URL("./doc-view.css", import.meta.url), "utf8");

/** A selector list split at its top-level commas, not the ones inside :is(). */
function selectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selectors: selectorList(match[1]), body: match[2] }));
}

function vars(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const SCOPE = ":is(.markie-view, .markie-print-layer) ";
const viewRules = rules(view);
const light = { ...vars(viewRules.find((r) => r.selectors[0] === ".markie-view")!.body), ...vars(viewRules.find((r) => r.selectors[0] === ":is(.markie-view, .markie-print-layer)")!.body) };
const darkRules = viewRules.filter((r) => r.selectors[0] === ':root[data-theme-tone="dark"] .markie-view');
const dark = { ...light, ...Object.assign({}, ...darkRules.map((r) => vars(r.body))) };

function themed(property: "color" | "background-color") {
  const found = new Map<string, string>();
  for (const rule of viewRules) {
    const value = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*var\\((--hl-[\\w-]+)\\)`).exec(rule.body)?.[1];
    if (!value) continue;
    for (const selector of rule.selectors) if (selector.startsWith(SCOPE)) found.set(selector.slice(SCOPE.length), value);
  }
  return found;
}

describe("code colours in the read view", () => {
  const colours = themed("color");
  const backgrounds = themed("background-color");
  const themeColoured = rules(theme)
    .filter((r) => /(?:^|;)\s*color\s*:/.test(r.body))
    .flatMap((r) => r.selectors)
    .filter((s) => s.startsWith(".hljs-") || s === ".hljs");

  it("gives every class github-dark colours a colour of its own", () => {
    expect(themeColoured.length).toBeGreaterThan(30);
    expect(themeColoured.filter((selector) => !colours.has(selector))).toEqual([]);
  });

  for (const [tone, palette] of [["light", light], ["dark", dark]] as const) {
    it(`reaches 4.5:1 for every class on the ${tone} code block`, () => {
      const block = parseCssColor(palette["--view-code"])!;
      expect(block).toBeTruthy();
      const failing: string[] = [];
      for (const [selector, variable] of colours) {
        const background = backgrounds.get(selector);
        const behind = background ? parseCssColor(palette[background])! : block;
        const ratio = contrastRatio(parseCssColor(palette[variable])!, behind);
        if (!(ratio >= 4.5)) failing.push(`${selector} ${palette[variable]} ${ratio.toFixed(2)}`);
      }
      expect(failing).toEqual([]);
    });
  }
});
