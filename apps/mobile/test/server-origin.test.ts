import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_ORIGIN, loadPreferredOrigin, normalizeServerOrigin, serverLabel } from "../src/lib/server-origin";
import { formatFromName, nameFromDisposition, originLabel, parseOrigin, publicDocName } from "../src/lib/docs";

describe("server origin", () => {
  it("defaults to Markie Cloud", () => {
    expect(DEFAULT_SERVER_ORIGIN).toBe("https://api.markiedocs.com");
    expect(loadPreferredOrigin({ getItem: () => null })).toBe(DEFAULT_SERVER_ORIGIN);
    expect(loadPreferredOrigin({ getItem: () => "http://evil.example" })).toBe(DEFAULT_SERVER_ORIGIN);
  });

  it.each([
    ["markie.example.com", "https://markie.example.com"],
    [" https://markie.example.com/ ", "https://markie.example.com"],
    ["https://markie.example.com:8443", "https://markie.example.com:8443"],
    ["http://localhost:8790", "http://localhost:8790"],
    ["http://10.0.2.2:8790", "http://10.0.2.2:8790"],
    ["https://api-production-602f.up.railway.app", "https://api.markiedocs.com"],
  ])("accepts %s", (input, origin) => {
    expect(normalizeServerOrigin(input)).toEqual({ ok: true, origin });
  });

  it.each([
    "",
    "http://markie.example.com",
    "ftp://markie.example.com",
    "https://markie.example.com/api",
    "https://markie.example.com/?x=1",
    "https://user:pass@markie.example.com",
    "javascript:alert(1)",
  ])("rejects %s", (input) => {
    expect(normalizeServerOrigin(input).ok).toBe(false);
  });

  it("names the server plainly", () => {
    expect(serverLabel("https://api.markiedocs.com")).toBe("Markie Cloud");
    expect(serverLabel("https://markie.example.com")).toBe("markie.example.com");
  });
});

describe("document fields", () => {
  it("derives the format from the extension, per the contract", () => {
    expect(formatFromName("Plan.wd")).toBe("darkmown");
    expect(formatFromName("a.TXT")).toBe("text");
    expect(formatFromName("a.text")).toBe("text");
    expect(formatFromName("a.log")).toBe("text");
    expect(formatFromName("a.md")).toBe("markdown");
    expect(formatFromName("a.mdx")).toBe("markdown");
    expect(formatFromName("no-extension")).toBe("markdown");
  });

  it("cleans an agent name before showing it", () => {
    expect(parseOrigin({ kind: "agent", agent: "  Claude‮ Code\u0007 " })).toEqual({ kind: "agent", agent: "Claude Code" });
    expect(parseOrigin({ kind: "agent", agent: "x".repeat(100) }).agent).toHaveLength(64);
    expect(parseOrigin({ kind: "app", agent: "ignored" })).toEqual({ kind: "app", agent: null });
    expect(parseOrigin("agent")).toEqual({ kind: "app", agent: null });
    expect(originLabel({ kind: "agent", agent: null })).toBe("from an agent");
  });

  it("reads a public share's name from its download header", () => {
    expect(nameFromDisposition("attachment; filename=\"Plan.wd.md\"; filename*=UTF-8''Caf%C3%A9.wd.md")).toBe("Café.wd.md");
    expect(publicDocName("Café.wd.md")).toBe("Café.wd");
    expect(publicDocName("Notes.md")).toBe("Notes.md");
    expect(publicDocName(null)).toBe("Shared document.md");
  });
});
