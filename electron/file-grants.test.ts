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

// createFileGrants declares its option as `workspaceRoots = () => []`, so its
// inferred return type is `never[]`. Real roots are handed over through this,
// rather than every call site repeating the same cast.
const rootsAre = (list: string[]) => (() => list) as unknown as () => never[];

// An attachment is any file the user drags in, so the fixture deliberately uses
// types the document grant would reject: a screenshot and a zip, both living
// outside every workspace root.
function attachmentFixture() {
  const { workspace, outside: outsideDir } = fixture();
  const outside = path.join(outsideDir, "screenshot.png");
  const zip = path.join(outsideDir, "bundle.zip");
  fs.writeFileSync(outside, "png");
  fs.writeFileSync(zip, "zip");
  const grants = createFileGrants({ workspaceRoots: rootsAre([workspace]) });
  return { grants, outside, zip, workspace };
}

describe("Electron file grants", () => {
  it("refuses ungranted paths outside workspace roots", () => {
    const { workspace, outside } = fixture();
    const grants = createFileGrants({ workspaceRoots: rootsAre([workspace]) });

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
    const grants = createFileGrants({ workspaceRoots: rootsAre([workspace]) });
    const inside = path.join(workspace, "inside.md");
    const next = path.join(workspace, "next.csv");

    expect(grants.canRead(inside)).toMatchObject({ ok: true, path: inside });
    expect(grants.canWrite(next)).toMatchObject({ ok: true, path: next });
  });

  it("rejects unsupported extensions even inside a workspace", () => {
    const { workspace } = fixture();
    const grants = createFileGrants({ workspaceRoots: rootsAre([workspace]) });
    const binary = path.join(workspace, "state.db");
    fs.writeFileSync(binary, "x");

    expect(grants.canRead(binary)).toMatchObject({
      ok: false,
      error: "Unsupported file type",
    });
  });

  it("rejects symlink escapes from a workspace root", () => {
    const { workspace, outside } = fixture();
    const grants = createFileGrants({ workspaceRoots: rootsAre([workspace]) });
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

describe("attachments", () => {
  it("makes a dropped file reachable wherever it lives", () => {
    // Kirby: "If a local file, then just make sure it's linked even if the
    // file moves outside." A file dragged in by hand is a file the user chose,
    // which is the same gesture as the Open dialog.
    const { grants, outside } = attachmentFixture();
    expect(grants.grantedFilePaths()).not.toContain(outside);
    expect(grants.grantAttachment(outside)).toEqual({ ok: true, path: outside });
    expect(grants.grantedFilePaths()).toContain(outside);
  });

  it("takes any file type, since an attachment is not a document", () => {
    const { grants, zip } = attachmentFixture();
    expect(grants.grantAttachment(zip).ok).toBe(true);
  });

  it("refuses a file that is not there", () => {
    const { grants } = attachmentFixture();
    expect(grants.grantAttachment("/nowhere/at/all.pdf").ok).toBe(false);
  });

  it("does not make an attachment openable or writable as a document", () => {
    // The whole reason attachments are their own set: dropping a PDF is
    // permission to show it, never permission to load or overwrite it.
    const { grants, zip } = attachmentFixture();
    grants.grantAttachment(zip);
    expect(grants.canRead(zip).ok).toBe(false);
    expect(grants.canWrite(zip).ok).toBe(false);
  });

  it("does not make the dropped file's whole folder readable", () => {
    // Otherwise dragging one screenshot off the Desktop would let any open
    // document display everything else on it.
    const { grants, outside } = attachmentFixture();
    grants.grantAttachment(outside);
    expect(grants.assetRoots()).not.toContain(path.dirname(outside));
  });
});
