import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertWindowsHost,
  buildWindowsLaunchSmokeArtifact,
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

  it("builds self-contained launch evidence metadata", () => {
    const rootDir = makeTempDir();
    writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "markie", version: "0.2.8" })
    );
    const executable = windowsExecutablePath(rootDir);
    const app = {
      appDir: path.dirname(executable),
      executable,
    };
    const target = {
      type: "page",
      title: "Markie — Markdown Viewer",
      url: "app://markie/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:3210/devtools/page/1",
    };
    const probe = {
      title: "Markie — Markdown Viewer",
      readyState: "complete",
      url: "app://markie/index.html",
      bodyText: "Library Markdown",
      hasEditor: true,
    };

    const artifact = buildWindowsLaunchSmokeArtifact({
      baseDir: rootDir,
      distDir: "dist",
      productName: "Markie",
      app,
      debugOrigin: "http://127.0.0.1:3210",
      target,
      probe,
      validation: { ok: true, failures: [] },
      generatedAt: "2026-07-04T20:00:00.000Z",
      platform: "win32",
      arch: "x64",
      versions: { node: "22.13.1", electron: "41.0.2", chrome: "142.0.0.0" },
    });

    expect(artifact).toMatchObject({
      ok: true,
      generatedAt: "2026-07-04T20:00:00.000Z",
      executable,
      host: {
        platform: "win32",
        arch: "x64",
        node: "22.13.1",
        electron: "41.0.2",
        chrome: "142.0.0.0",
      },
      package: {
        name: "markie",
        version: "0.2.8",
        productName: "Markie",
        distDir: "dist",
        layout: "win-unpacked",
      },
      app,
      debugOrigin: "http://127.0.0.1:3210",
      target,
      probe,
      validation: { ok: true, failures: [] },
    });
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
