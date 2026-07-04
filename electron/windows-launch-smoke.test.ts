import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertWindowsHost,
  resolveWindowsApp,
  selectPageTarget,
  validateRendererProbe,
  windowsExecutablePath,
} from "../scripts/windows-launch-smoke.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "markie-win-launch-smoke-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Windows launch smoke", () => {
  it("runs only on a Windows host", () => {
    expect(() => assertWindowsHost("win32")).not.toThrow();
    expect(() => assertWindowsHost("darwin")).toThrow(/must run on win32/);
    expect(() => assertWindowsHost("linux")).toThrow(/must run on win32/);
  });

  it("resolves the electron-builder Windows unpacked executable", () => {
    const rootDir = makeTempDir();
    const executable = windowsExecutablePath(rootDir);
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "fixture");

    expect(resolveWindowsApp(rootDir)).toEqual({
      appDir: path.dirname(executable),
      executable,
    });
  });

  it("reports a concrete packaging command when the executable is missing", () => {
    const rootDir = makeTempDir();

    expect(() => resolveWindowsApp(rootDir)).toThrow(/run npm run electron:pack:win first/);
  });

  it("chooses the packaged Markie page target and ignores DevTools targets", () => {
    const target = selectPageTarget([
      {
        type: "page",
        title: "DevTools",
        url: "devtools://devtools/bundled/inspector.html",
        webSocketDebuggerUrl: "ws://ignored",
      },
      {
        type: "page",
        title: "Markie — Markdown Viewer",
        url: "app://markie/index.html",
        webSocketDebuggerUrl: "ws://markie",
      },
      {
        type: "browser",
        title: "browser",
        url: "",
        webSocketDebuggerUrl: "ws://browser",
      },
    ]);

    expect(target?.webSocketDebuggerUrl).toBe("ws://markie");
  });

  it("validates that the renderer is real Markie UI", () => {
    expect(
      validateRendererProbe({
        title: "Markie — Markdown Viewer",
        readyState: "complete",
        bodyText: "Library Markdown",
        hasEditor: true,
      })
    ).toEqual({ ok: true, failures: [] });

    expect(
      validateRendererProbe({
        title: "Blank",
        readyState: "loading",
        bodyText: "",
        hasEditor: false,
      }).failures
    ).toEqual(
      expect.arrayContaining([
        "document.readyState is loading",
        "window title is not Markie: Blank",
        "renderer body does not contain expected Markie UI",
      ])
    );
  });
});
