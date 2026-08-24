import { describe, it, expect } from "vitest";
import {
  parseDsn,
  parseStackFrames,
  scrubText,
  sentryEnvelope,
} from "./sentry-envelope.js";

const DSN = "https://abc123def456@o12345.ingest.sentry.io/7654321";

const record = (over: Record<string, unknown> = {}) => ({
  at: "2026-08-19T12:00:00.000Z",
  source: "render",
  message: "Cannot read properties of undefined (reading 'role')",
  stack: "TypeError: boom\n    at ShareBanner (app://markie/_next/chunks/a.js:12:34)",
  version: "0.5.0",
  platform: "darwin/arm64",
  ...over,
});

describe("parseDsn", () => {
  it("pulls the ingest URL and public key out of a DSN", () => {
    const dsn = parseDsn(DSN);
    expect(dsn).toEqual({
      publicKey: "abc123def456",
      host: "o12345.ingest.sentry.io",
      projectId: "7654321",
      envelopeUrl: "https://o12345.ingest.sentry.io/api/7654321/envelope/",
    });
  });

  it("returns null for anything that is not a usable DSN", () => {
    // An unset or fat-fingered DSN must disable reporting, never crash the app
    // it is supposed to be watching.
    for (const bad of ["", "   ", "not a url", "https://sentry.io", "https://@host/1"]) {
      expect(parseDsn(bad)).toBe(null);
    }
    expect(parseDsn(undefined)).toBe(null);
  });
});

describe("scrubText", () => {
  const home = "/Users/someone";

  it("reduces an absolute path to its basename", () => {
    // A crash message routinely carries the path of the document being edited,
    // which in a local-first app is exactly what must not leave the machine.
    const text = scrubText(`ENOENT: ${home}/Desktop/Q3 salary review.md not found`, home);
    expect(text).not.toContain("Desktop");
    expect(text).not.toContain(home);
    expect(text).toContain("Q3 salary review.md");
  });

  it("keeps the home directory out even without a full path", () => {
    expect(scrubText(`failed in ${home}`, home)).not.toContain("someone");
  });

  it("scrubs every path in a line, not just the first", () => {
    const text = scrubText(`copy ${home}/a/one.md to ${home}/b/two.md`, home);
    expect(text).not.toContain("/a/");
    expect(text).not.toContain("/b/");
    expect(text).toContain("one.md");
    expect(text).toContain("two.md");
  });

  it("leaves ordinary messages untouched", () => {
    const text = "Cannot read properties of undefined (reading 'role')";
    expect(scrubText(text, home)).toBe(text);
  });

  it("does not mangle app:// or https:// URLs into nonsense", () => {
    // Those are Markie's own bundle URLs and carry no user data, but they are
    // the whole value of a stack frame.
    const text = scrubText("at f (app://markie/_next/chunks/a.js:1:2)", home);
    expect(text).toContain("app://markie/_next/chunks/a.js");
  });

  it("survives an empty or missing home directory", () => {
    expect(() => scrubText("anything", "")).not.toThrow();
    expect(scrubText("anything", "")).toBe("anything");
  });
});

describe("parseStackFrames", () => {
  it("reads function, file, line and column out of a V8 stack", () => {
    const frames = parseStackFrames(
      "TypeError: boom\n    at ShareBanner (app://markie/_next/chunks/a.js:12:34)",
      ""
    );
    expect(frames.at(-1)).toMatchObject({
      function: "ShareBanner",
      filename: "app://markie/_next/chunks/a.js",
      lineno: 12,
      colno: 34,
    });
  });

  it("handles a frame with no function name", () => {
    const frames = parseStackFrames("Error: x\n    at app://markie/a.js:5:6", "");
    expect(frames.at(-1)).toMatchObject({ filename: "app://markie/a.js", lineno: 5, colno: 6 });
  });

  it("orders frames oldest first, which is what Sentry expects", () => {
    const frames = parseStackFrames(
      ["Error: x", "    at inner (a.js:1:1)", "    at outer (b.js:2:2)"].join("\n"),
      ""
    );
    // The crashing frame is last in Sentry's model, first in a JS stack.
    expect(frames.at(-1)?.function).toBe("inner");
    expect(frames[0]?.function).toBe("outer");
  });

  it("is empty for a stack that carries no frames", () => {
    expect(parseStackFrames("just a message", "")).toEqual([]);
    expect(parseStackFrames("", "")).toEqual([]);
  });

  it("scrubs paths inside frame filenames", () => {
    const frames = parseStackFrames(
      "Error: x\n    at read (/Users/someone/Documents/notes.md:1:1)",
      "/Users/someone"
    );
    expect(JSON.stringify(frames)).not.toContain("Documents");
  });
});

describe("sentryEnvelope", () => {
  it("produces the three newline-delimited parts Sentry expects", () => {
    const body = sentryEnvelope(record(), { dsn: parseDsn(DSN)!, home: "", environment: "production" });
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toEqual({ type: "event" });
  });

  it("carries the release, so a crash can be tied to a build", () => {
    const body = sentryEnvelope(record(), { dsn: parseDsn(DSN)!, home: "", environment: "production" });
    const event = JSON.parse(body.trim().split("\n")[2]);
    expect(event.release).toBe("0.5.0");
    expect(event.tags.source).toBe("render");
  });

  it("sends an exception with frames, so Sentry can group and symbolicate", () => {
    const body = sentryEnvelope(record(), { dsn: parseDsn(DSN)!, home: "", environment: "production" });
    const event = JSON.parse(body.trim().split("\n")[2]);
    expect(event.exception.values[0].value).toMatch(/Cannot read properties/);
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  });

  it("gives every event a distinct id", () => {
    const opts = { dsn: parseDsn(DSN)!, home: "", environment: "production" };
    const idOf = (b: string) => JSON.parse(b.trim().split("\n")[0]).event_id;
    expect(idOf(sentryEnvelope(record(), opts))).not.toBe(idOf(sentryEnvelope(record(), opts)));
  });

  it("never carries document content", () => {
    const body = sentryEnvelope(
      record({ message: "failed", stack: "" }),
      { dsn: parseDsn(DSN)!, home: "", environment: "production" }
    );
    expect(body).not.toMatch(/content|documentText/i);
  });

  it("scrubs the user's paths out of everything it sends", () => {
    const body = sentryEnvelope(
      record({
        message: "ENOENT: /Users/someone/Desktop/salary.md",
        stack: "Error: x\n    at read (/Users/someone/Desktop/salary.md:1:1)",
      }),
      { dsn: parseDsn(DSN)!, home: "/Users/someone", environment: "production" }
    );
    expect(body).not.toContain("/Users/someone");
    expect(body).not.toContain("Desktop");
  });
});
