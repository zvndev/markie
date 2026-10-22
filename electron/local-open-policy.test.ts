import { describe, expect, it } from "vitest";
import { localOpenAction } from "./local-open-policy.js";

describe("what a document link may launch", () => {
  it("opens documents, pictures and media directly", () => {
    for (const file of ["/w/notes.md", "/w/Report.PDF", "/w/plan.docx", "/w/photo.heic", "/w/clip.mov", "/w/data.csv"]) {
      expect(localOpenAction(file, false), file).toBe("open");
    }
  });

  it("shows scripts, apps and installers in Finder instead of running them", () => {
    for (const file of ["/w/setup.command", "/w/run.sh", "/w/tool", "/w/x.terminal", "/w/a.scpt", "/w/b.jar", "/w/c.dmg", "/w/d.webloc", "/w/e.inetloc"]) {
      expect(localOpenAction(file, false), file).toBe("reveal");
    }
  });

  it("opens a plain folder but only reveals a bundle", () => {
    expect(localOpenAction("/w/assets", true)).toBe("open");
    expect(localOpenAction("/w/Evil.app", true)).toBe("reveal");
    expect(localOpenAction("/w/Installer.pkg", true)).toBe("reveal");
  });
});
