import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CommonJS main-process module: load it the way main.js does.
const load = createRequire(import.meta.url);
const { createSkillTrash, skillDirs } = load("./skill-trash.js") as {
  createSkillTrash: (deps: {
    dirs: () => string[];
    trashItem: (p: string) => Promise<void>;
  }) => { trash: (folder: unknown) => Promise<{ ok: boolean; error?: string }> };
  skillDirs: (home: string, env: Record<string, string | undefined>) => string[];
};

let tmp: string;
let skills: string;
let trashItem: ReturnType<typeof vi.fn<(p: string) => Promise<void>>>;
let trasher: ReturnType<typeof createSkillTrash>;

const mkSkill = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n");
  return dir;
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markie-skill-trash-")));
  skills = path.join(tmp, "home", ".claude", "skills");
  fs.mkdirSync(skills, { recursive: true });
  trashItem = vi.fn(async (_p: string) => {});
  trasher = createSkillTrash({ dirs: () => [skills], trashItem });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("which folders may go to the Trash", () => {
  it("trashes a skill folder directly inside a known skills folder", async () => {
    const pdf = mkSkill(path.join(skills, "pdf"));
    expect(await trasher.trash(pdf)).toEqual({ ok: true });
    expect(trashItem).toHaveBeenCalledWith(pdf);
  });

  it("refuses a folder outside every skills folder", async () => {
    const elsewhere = mkSkill(path.join(tmp, "elsewhere", "pdf"));
    const res = await trasher.trash(elsewhere);
    expect(res.ok).toBe(false);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("refuses the skills folder itself, and anything nested deeper than a skill", async () => {
    mkSkill(path.join(skills, "pdf", "references"));
    for (const folder of [skills, path.join(skills, "pdf", "references")]) {
      expect((await trasher.trash(folder)).ok).toBe(false);
    }
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("refuses a path that climbs out with ..", async () => {
    mkSkill(path.join(tmp, "home", "important"));
    const res = await trasher.trash(path.join(skills, "..", "..", "important"));
    expect(res.ok).toBe(false);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("refuses a symlink inside a skills folder that points out of it", async () => {
    const target = mkSkill(path.join(tmp, "documents", "precious"));
    const link = path.join(skills, "precious");
    fs.symlinkSync(target, link, "dir");
    const res = await trasher.trash(link);
    expect(res.ok).toBe(false);
    expect(trashItem).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(true);
  });

  it("refuses a file, a relative path, and anything that is not a string", async () => {
    const file = path.join(skills, "loose.md");
    fs.writeFileSync(file, "# loose");
    for (const folder of [file, "pdf", "", null, 42]) {
      expect((await trasher.trash(folder)).ok).toBe(false);
    }
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("says so when the folder is already gone", async () => {
    const res = await trasher.trash(path.join(skills, "missing"));
    expect(res).toEqual({ ok: false, error: "That skill folder is not there any more." });
  });
});

describe("the skills folders main checks against", () => {
  it("covers every tool's skills folder and a moved config folder", () => {
    const home = path.join(tmp, "h");
    const dirs = skillDirs(home, { CLAUDE_CONFIG_DIR: path.join(tmp, "cfg", "claude") });
    for (const expected of [
      path.join(home, ".claude", "skills"),
      path.join(home, ".codex", "skills"),
      path.join(home, ".cursor", "skills"),
      path.join(home, ".gemini", "skills"),
      path.join(home, ".agents", "skills"),
      path.join(tmp, "cfg", "claude", "skills"),
    ]) {
      expect(dirs).toContain(expected);
    }
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});
