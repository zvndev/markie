import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// CI installs with `npm ci --ignore-scripts`, so the Electron binary is never
// downloaded and `require("electron")` throws at module load. A main-process
// module that reaches for it at the top level therefore cannot be unit tested
// on the runner: the whole suite fails to import, and every test in it stops
// running. That is how registry.js took sync.test.ts (54 tests) off CI while
// passing locally, where the binary is installed.
//
// So: every module under electron/ must load without the binary, except the
// ones that only ever execute inside Electron. Defer the require into the
// function that needs it, the way registry.js defers better-sqlite3.
const here = path.dirname(fileURLToPath(import.meta.url));

// Genuine Electron-runtime entry points. Nothing unit tests these, and they
// have no meaning outside the app. Adding to this list should be a deliberate
// decision, not a way to silence the test.
const RUNTIME_ENTRY_POINTS = new Set(["main.js", "preload.js", "workspace.js"]);

// Poison the module loader to reproduce the runner's error exactly, rather than
// deleting node_modules/electron to find out.
const CHILD = `
  const Module = require("module");
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      throw new Error("Electron failed to install correctly, please delete node_modules/electron and try installing again");
    }
    return load.call(this, request, parent, isMain);
  };
  const failures = [];
  for (const file of process.argv.slice(1)) {
    try {
      require(file);
    } catch (err) {
      failures.push(path.basename(file) + ": " + err.message);
    }
  }
  console.log(JSON.stringify(failures));
`;

function loadWithoutElectron(files: string[]): string[] {
  const out = execFileSync(
    process.execPath,
    ["-e", `const path = require("path");${CHILD}`, "--", ...files],
    { encoding: "utf8" }
  );
  return JSON.parse(out.trim().split("\n").pop() ?? "[]");
}

describe("main-process modules load without the Electron binary", () => {
  const modules = readdirSync(here)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .filter((f) => !RUNTIME_ENTRY_POINTS.has(f));

  it("covers every module that is not a runtime entry point", () => {
    // A guard on the guard: if the filter ever matches nothing, the test below
    // would pass while checking nothing at all.
    expect(modules.length).toBeGreaterThan(0);
    expect(modules).toContain("registry.js");
    expect(modules).toContain("sync.js");
  });

  it("imports each of them with require(\"electron\") throwing", () => {
    const failures = loadWithoutElectron(modules.map((f) => path.join(here, f)));

    expect(failures).toEqual([]);
  });
});
