import { describe, expect, it } from "vitest";
import { crashReport, formatCrashDetails } from "./crash-report";

const ENV = { version: "0.4.0", platform: "darwin", mode: "preview" };

describe("crashReport", () => {
  it("keeps the message and stack of a real error", () => {
    const err = new Error("Cannot read properties of undefined (reading 'role')");
    const report = crashReport({ error: err, source: "render", env: ENV, now: 1000 });
    expect(report.message).toMatch(/Cannot read properties of undefined/);
    expect(report.stack).toContain("Error:");
    expect(report.source).toBe("render");
  });

  it("records what the app was when it broke", () => {
    // A stack with no version or platform is a stack you cannot act on: the
    // first question about any crash report is "which build".
    const report = crashReport({ error: new Error("x"), source: "render", env: ENV, now: 1000 });
    expect(report.version).toBe("0.4.0");
    expect(report.platform).toBe("darwin");
    expect(report.at).toBe(new Date(1000).toISOString());
  });

  it("survives something thrown that is not an Error", () => {
    // Promise rejections routinely carry strings, DOM events, or undefined.
    // A crash reporter that throws while reporting a crash is worse than none.
    for (const thrown of ["boom", null, undefined, 42, { code: "EACCES" }]) {
      const report = crashReport({ error: thrown, source: "unhandled-rejection", env: ENV, now: 1 });
      expect(typeof report.message).toBe("string");
      expect(report.message.length).toBeGreaterThan(0);
    }
  });

  it("keeps the React component stack when there is one", () => {
    const report = crashReport({
      error: new Error("x"),
      source: "render",
      env: ENV,
      now: 1,
      componentStack: "\n    at ShareBanner\n    at Page",
    });
    expect(report.componentStack).toContain("ShareBanner");
  });

  it("never carries document content", () => {
    // Reports are written to a log the user can send to us. A crash reporter
    // that scoops up the document is a data leak wearing a bug report's hat.
    const err = new Error("failed");
    const report = crashReport({ error: err, source: "render", env: ENV, now: 1 });
    expect(Object.keys(report)).not.toContain("content");
    expect(JSON.stringify(report)).not.toMatch(/documentContent/);
  });

  it("truncates an enormous stack rather than writing it whole", () => {
    const err = new Error("x");
    err.stack = "Error: x\n" + "    at frame\n".repeat(5000);
    const report = crashReport({ error: err, source: "render", env: ENV, now: 1 });
    expect(report.stack.length).toBeLessThanOrEqual(8192);
  });
});

describe("formatCrashDetails", () => {
  it("produces something a person can paste into a bug report", () => {
    const report = crashReport({
      error: new Error("kaboom"),
      source: "render",
      env: ENV,
      now: 1000,
      componentStack: "\n    at Editor",
    });
    const text = formatCrashDetails(report);
    expect(text).toContain("kaboom");
    expect(text).toContain("0.4.0");
    expect(text).toContain("darwin");
    expect(text).toContain("at Editor");
  });
});
