import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileGrants } from "./file-grants.js";

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "markie-grants-")));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, "inside.md"), "inside");
  fs.writeFileSync(path.join(outside, "loose.md"), "loose");
  fs.writeFileSync(path.join(outside, "plain.txt"), "text");
  fs.writeFileSync(path.join(outside, "secret.json"), "{}");
  return { root, workspace, outside };
}

describe("Electron file grants", () => {
  it("refuses ungranted paths outside workspace roots", () => {
    const { workspace, outside } = fixture();
    const grants = createFileGrants({ workspaceRoots: () => [workspace] });

    expect(grants.canRead(path.join(outside, "loose.md"))).toMatchObject({
      ok: false,
      error: "File access was not granted",
    });
    expect(grants.canWrite(path.join(outside, "loose.md"))).toMatchObject({
      ok: false,
      error: "File access was not granted",
    });
  });

  it("allows exact user-granted files but not sibling files", () => {
    const { outside } = fixture();
    const grants = createFileGrants({ workspaceRoots: () => [] });
    const loose = path.join(outside, "loose.md");
    const sibling = path.join(outside, "plain.txt");

    expect(grants.grantFile(loose)).toMatchObject({ ok: true, path: loose });
    expect(grants.canRead(loose)).toMatchObject({ ok: true, path: loose });
    expect(grants.canWrite(loose)).toMatchObject({ ok: true, path: loose });
    expect(grants.canRead(sibling)).toMatchObject({
      ok: false,
      error: "File access was not granted",
    });
  });

  it("allows markdown, text, and CSV under workspace roots", () => {
    const { workspace } = fixture();
    const grants = createFileGrants({ workspaceRoots: () => [workspace] });
    const inside = path.join(workspace, "inside.md");
    const next = path.join(workspace, "next.csv");

    expect(grants.canRead(inside)).toMatchObject({ ok: true, path: inside });
    expect(grants.canWrite(next)).toMatchObject({ ok: true, path: next });
  });

  it("rejects unsupported extensions even inside a workspace", () => {
    const { workspace } = fixture();
    const grants = createFileGrants({ workspaceRoots: () => [workspace] });
    const binary = path.join(workspace, "state.db");
    fs.writeFileSync(binary, "x");

    expect(grants.canRead(binary)).toMatchObject({
      ok: false,
      error: "Unsupported file type",
    });
  });

  it("rejects symlink escapes from a workspace root", () => {
    const { workspace, outside } = fixture();
    const grants = createFileGrants({ workspaceRoots: () => [workspace] });
    const link = path.join(workspace, "linked.md");
    fs.symlinkSync(path.join(outside, "loose.md"), link);

    expect(grants.canRead(link)).toMatchObject({
      ok: false,
      error: "File access was not granted",
    });
  });

  it("keeps renames in the same directory and transfers exact grants", () => {
    const { outside } = fixture();
    const grants = createFileGrants({ workspaceRoots: () => [] });
    const oldPath = path.join(outside, "loose.md");
    const next = path.join(outside, "renamed.md");

    grants.grantFile(oldPath);
    expect(grants.canRename(oldPath, "renamed.md")).toMatchObject({
      ok: true,
      oldPath,
      newPath: next,
      name: "renamed.md",
    });
    fs.renameSync(oldPath, next);
    grants.moveGrant(oldPath, next);

    expect(grants.canRead(oldPath)).toMatchObject({ ok: false });
    expect(grants.canRead(next)).toMatchObject({ ok: true, path: next });
  });

  it("rejects rename traversal and unsafe target extensions", () => {
    const { outside } = fixture();
    const grants = createFileGrants({ workspaceRoots: () => [] });
    const oldPath = path.join(outside, "loose.md");
    grants.grantFile(oldPath);

    expect(grants.canRename(oldPath, "../escape.md")).toMatchObject({
      ok: false,
      error: "Invalid file name",
    });
    expect(grants.canRename(oldPath, "state.db")).toMatchObject({
      ok: false,
      error: "Invalid file name",
    });
  });
});
