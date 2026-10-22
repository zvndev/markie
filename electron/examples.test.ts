// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileDarkmown } from "../src/lib/darkmown/compiler";
import { WELCOME_DARKMOWN, seedExamples } from "./examples.js";

function folders() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "markie-examples-"));
  const root = path.join(base, "Markie");
  fs.mkdirSync(root);
  return { root, marker: path.join(base, "userData", "seeded-examples.json") };
}

describe("workspace examples", () => {
  it("ships a Darkmown example the pinned compiler accepts, with working controls", () => {
    const result = compileDarkmown(WELCOME_DARKMOWN);
    expect(result).toMatchObject({ title: "Welcome to Darkmown", requiresRuntime: true, hasCode: false });
    expect(result.bodyHtml).toContain('data-wd-action="inc" data-wd-target="cups"');
    expect(result.bodyHtml).toContain('data-wd-computed-key="total"');
    expect(result.bodyHtml).toContain('<input type="range" data-wd-bind-input="hours"');
    expect(result.bodyHtml).toContain('<form data-wd-form="visitor">');
    expect(result.warnings).toEqual([]);
    expect(WELCOME_DARKMOWN).not.toContain("—");
  });

  it("offers the example once, and leaves it gone after the user deletes it", () => {
    const { root, marker } = folders();
    const [written] = seedExamples(root, marker);
    expect(written).toBe(path.join(root, "Welcome to Darkmown.wd"));
    expect(fs.readFileSync(written, "utf8")).toBe(WELCOME_DARKMOWN);
    fs.rmSync(written);
    expect(seedExamples(root, marker)).toEqual([]);
    expect(fs.existsSync(written)).toBe(false);
  });

  it("never replaces a file the user already has under that name", () => {
    const { root, marker } = folders();
    const mine = path.join(root, "Welcome to Darkmown.wd");
    fs.writeFileSync(mine, "my own notes");
    expect(seedExamples(root, marker)).toEqual([]);
    expect(fs.readFileSync(mine, "utf8")).toBe("my own notes");
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).seeded).toContain("darkmown-welcome-v1");
  });

  it("does nothing until Markie's folder exists", () => {
    const { root, marker } = folders();
    fs.rmSync(root, { recursive: true });
    expect(seedExamples(root, marker)).toEqual([]);
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
