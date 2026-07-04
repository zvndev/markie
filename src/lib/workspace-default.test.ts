import { describe, expect, it } from "vitest";
import { ensureDefaultWorkspaceRoot } from "./workspace-default";

describe("default workspace root", () => {
  it("leaves existing workspace roots alone", async () => {
    let createCalls = 0;
    const result = await ensureDefaultWorkspaceRoot({
      wsRoots: async () => ["/Users/me/Notes"],
      wsDefaultPath: async () => "/Users/me/Documents/Markie",
      wsCreateDefault: async () => {
        createCalls += 1;
        return { ok: true, path: "/Users/me/Documents/Markie" };
      },
    });

    expect(result).toEqual({
      roots: ["/Users/me/Notes"],
      defaultPath: "/Users/me/Documents/Markie",
      created: false,
    });
    expect(createCalls).toBe(0);
  });

  it("creates and returns the default root on first use", async () => {
    let created = false;
    const result = await ensureDefaultWorkspaceRoot({
      wsRoots: async () => (created ? ["/Users/me/Documents/Markie"] : []),
      wsDefaultPath: async () => "/Users/me/Documents/Markie",
      wsCreateDefault: async () => {
        created = true;
        return { ok: true, path: "/Users/me/Documents/Markie" };
      },
    });

    expect(result).toEqual({
      roots: ["/Users/me/Documents/Markie"],
      defaultPath: "/Users/me/Documents/Markie",
      created: true,
    });
  });

  it("surfaces default-root creation failures without inventing a root", async () => {
    const result = await ensureDefaultWorkspaceRoot({
      wsRoots: async () => [],
      wsDefaultPath: async () => "/Users/me/Documents/Markie",
      wsCreateDefault: async () => ({ error: "permission denied" }),
    });

    expect(result).toEqual({
      roots: [],
      defaultPath: "/Users/me/Documents/Markie",
      created: false,
      error: "permission denied",
    });
  });
});
