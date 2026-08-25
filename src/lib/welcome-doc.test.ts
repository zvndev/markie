import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WELCOME_DOC } from "./welcome-doc";

describe("WELCOME_DOC", () => {
  it("demonstrates the formatting it talks about", () => {
    // The document is also the product demo, so the features it names have to
    // be present in it, not merely described.
    expect(WELCOME_DOC).toMatch(/^# /m); // headings
    expect(WELCOME_DOC).toMatch(/^\| /m); // a table
    expect(WELCOME_DOC).toMatch(/- \[x\]/); // a task list
    expect(WELCOME_DOC).toMatch(/```typescript/); // a fenced code block
    expect(WELCOME_DOC).toMatch(/^> /m); // a blockquote
    expect(WELCOME_DOC).toMatch(/\$E = mc\^2\$/); // math
  });

  it("states the local-first promise", () => {
    expect(WELCOME_DOC).toMatch(/do not need an account/i);
  });

  it("does not ask a first-time user to sign in", () => {
    // The whole posture of this pass: the account is earned at the moment it
    // buys something, never demanded on the first screen.
    expect(WELCOME_DOC).not.toMatch(/sign in to (get started|continue|begin)/i);
    expect(WELCOME_DOC).not.toMatch(/create an account to/i);
  });

  it("says sharing and sync will ask later rather than hiding them", () => {
    expect(WELCOME_DOC).toMatch(/sync and sharing/i);
    expect(WELCOME_DOC).toMatch(/ask you then/i);
  });

  // A welcome document that teaches a shortcut the app does not have is worse
  // than no welcome document: the very first thing the user tries fails.
  it("only promises shortcuts the app actually registers", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../app/page.tsx", import.meta.url)),
      "utf8"
    );
    const registered = new Set(
      [...page.matchAll(/shortcut:\s*"([^"]+)"/g)].map((m) => m[1])
    );
    expect(registered.size).toBeGreaterThan(10);

    // Shortcuts in the doc are written inside backticks, e.g. `⇧⌘E`.
    const promised = new Set(
      [...WELCOME_DOC.matchAll(/`([⌘⌥⇧⌃][^`]*)`/g)].map((m) => m[1])
    );
    expect(promised.size).toBeGreaterThan(5);

    const missing = [...promised].filter((s) => !registered.has(s));
    expect(missing).toEqual([]);
  });
});
