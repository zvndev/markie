// The two modules that decide whether a dropped file can be shown, wired the
// way main.js wires them. file-grants.js says what the user has chosen and
// local-assets.js says whether a given path is inside that, and the bug worth
// catching lives in the seam: an attachment lives nowhere near a workspace
// root, so it is reachable only if the per-file grant is actually passed
// through. A test of either module alone would miss that.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileGrants } from "./file-grants.js";
import localAssets from "./local-assets.js";

function world() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "markie-attach-")));
  const workspace = path.join(root, "workspace");
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(workspace);
  fs.mkdirSync(desktop);
  fs.writeFileSync(path.join(workspace, "report.md"), "# report");
  fs.writeFileSync(path.join(desktop, "shot.png"), "png");
  fs.writeFileSync(path.join(desktop, "private.png"), "also png");
  fs.writeFileSync(path.join(desktop, "clip.mp4"), "mp4");

  const grants = createFileGrants({
    workspaceRoots: (() => [workspace]) as unknown as () => never[],
  });
  // What electron/main.js hands the asset protocol on every request.
  const reach = (target: string) =>
    localAssets.allowedRealPath(target, {
      roots: grants.assetRoots(),
      files: grants.grantedFilePaths(),
    });
  return { workspace, desktop, grants, reach };
}

describe("reaching a dropped file", () => {
  it("cannot reach a picture on the Desktop before it is dropped", () => {
    const { desktop, reach } = world();
    expect(reach(path.join(desktop, "shot.png"))).toBe(null);
  });

  it("reaches it once it has been dropped onto a document", () => {
    const { desktop, grants, reach } = world();
    const shot = path.join(desktop, "shot.png");
    grants.grantAttachment(shot);
    expect(reach(shot)).toBe(shot);
  });

  it("still cannot reach the file next to it", () => {
    // The grant is one file, not the folder it was in. Dropping a screenshot
    // must not open the rest of somebody's Desktop to the document.
    const { desktop, grants, reach } = world();
    grants.grantAttachment(path.join(desktop, "shot.png"));
    expect(reach(path.join(desktop, "private.png"))).toBe(null);
  });

  it("reaches a clip the same way, since video is the same rule", () => {
    const { desktop, grants, reach } = world();
    const clip = path.join(desktop, "clip.mp4");
    grants.grantAttachment(clip);
    expect(reach(clip)).toBe(clip);
    expect(localAssets.mediaKindFor(clip)).toBe("video");
  });

  it("keeps reaching anything inside a workspace root, dropped or not", () => {
    const { workspace, reach } = world();
    const inside = path.join(workspace, "logo.png");
    fs.writeFileSync(inside, "png");
    expect(reach(inside)).toBe(inside);
  });

  it("does not let a document be written just because it can be shown", () => {
    const { desktop, grants } = world();
    const shot = path.join(desktop, "shot.png");
    grants.grantAttachment(shot);
    expect(grants.canWrite(shot).ok).toBe(false);
  });
});
