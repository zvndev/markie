import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdownHTML } from "@/lib/markdown-html";

const mathCount = (html: string) => (html.match(/<span class="katex">/g) ?? []).length;
const tex = (html: string) =>
  [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map((m) => m[1]);

describe("single-dollar math follows Pandoc's rule", () => {
  it("keeps ordinary inline math", () => {
    expect(tex(renderMarkdownHTML("Area is $x^2$ here."))).toEqual(["x^2"]);
    expect(tex(renderMarkdownHTML("Energy: $E = mc^2$."))).toEqual(["E = mc^2"]);
    expect(tex(renderMarkdownHTML("($a$, $b$)"))).toEqual(["a", "b"]);
    expect(tex(renderMarkdownHTML("$2x$ apples"))).toEqual(["2x"]);
  });

  it("keeps double-dollar math, inline and as a block", () => {
    expect(tex(renderMarkdownHTML("Inline $$ a + b $$ too."))).toEqual(["a + b"]);
    const block = renderMarkdownHTML("$$\n\\int_0^1 x\\,dx\n$$\n");
    expect(block).toContain("katex-display");
  });

  it("leaves prices as text", () => {
    for (const md of [
      "It costs $5 and $10.",
      "Somewhere between $5-$10 a bottle.",
      "Prices: $3.50, $7.07 and $4.45.",
      "A $ sign alone, and $x $ with a space.",
      "Paid $x$1 for it.",
    ]) {
      const html = renderMarkdownHTML(md);
      expect(mathCount(html), md).toBe(0);
      expect(html).toContain("$");
    }
  });

  it("does not turn a transcript between two prices into one equation", () => {
    const lines = [
      "Meeting Title: Monday Meeting\\",
      "Transcript:\\",
      "Them: A 150 means you sold you know, $6.\\",
      ...Array.from({ length: 30 }, (_, i) => `Me: line ${i} of the conversation, nothing about money.\\`),
      "Them: You took a $100 worth of lemons. You wasted 50 of them.\\",
      "Me: They charge you, I think, $8 per person. There's an $8 Pellegrino button,\\",
      "Them: And then there is a $0 Pellegrino button.",
    ];
    const html = renderMarkdownHTML(lines.join("\n"));
    expect(mathCount(html)).toBe(0);
    expect(html).toContain("$6.");
    expect(html).toContain("$100 worth");
    // The hard breaks still break: each speaker keeps a line of their own.
    expect((html.match(/<br>/g) ?? []).length).toBe(lines.length - 1);
  });

  it("honours an escaped dollar", () => {
    expect(mathCount(renderMarkdownHTML("\\$x\\$ is not math"))).toBe(0);
  });

  it("stays linear on a paragraph full of prices", () => {
    const md = Array.from({ length: 20000 }, (_, i) => `item ${i} $${i % 97}`).join(" ");
    const started = performance.now();
    const html = renderMarkdownHTML(md);
    expect(mathCount(html)).toBe(0);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("is the same code the server renders with", () => {
    const below = (file: string) => {
      const text = readFileSync(path.resolve(__dirname, file), "utf8");
      return text.slice(text.indexOf("import type"));
    };
    expect(below("../../server/src/remark-strict-math.ts")).toBe(below("./remark-strict-math.ts"));
  });
});
