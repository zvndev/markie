import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { useProjects } from "@/lib/use-projects";

const NOW = Date.now();
const ROWS = [
  {
    path: "/home/u/Documents/P/a.md",
    name: "a.md",
    dir: "/home/u/Documents/P",
    mtimeMs: NOW,
    birthtimeMs: NOW - 1000,
    fmProject: null,
    fmBlock: null,
    repoName: null,
  },
];

function bridge(over: Record<string, unknown> = {}) {
  return installBridge({
    projectsState: vi.fn(async () => ({
      pins: [],
      blocks: [],
      assignments: [],
      fingerprint: "fp1",
      rulesKnownGood: null,
      rulesError: null,
    })),
    projectsConfig: vi.fn(async () => ({
      path: "/home/u/Documents/Markie/Projects.md",
      content: "",
      created: false,
      home: "/home/u",
    })),
    mdIndexScan: vi.fn(async () => ({ files: ROWS, scannedAt: "now" })),
    ...over,
  } as never);
}

describe("useProjects", () => {
  it("computes a taxonomy from index rows and saves the cache", async () => {
    const api = bridge();
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.taxonomy?.projects[0].name).toBe("P");
    expect(api.projectsSaveCache).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: "fp1" })
    );
  });

  it("records the rules that produced the cache as known-good", async () => {
    const api = bridge({
      projectsConfig: vi.fn(async () => ({
        path: "/p/Projects.md",
        content: "---\nmarkie_rules:\n  rules: []\n---\n",
        created: false,
        home: "/home/u",
      })),
    });
    renderHook(() => useProjects(0));
    await waitFor(() =>
      expect(api.projectsSaveCache).toHaveBeenCalledWith(
        expect.objectContaining({ rulesKnownGood: expect.stringContaining("markie_rules") })
      )
    );
  });

  it("falls back to known-good rules and surfaces the error on malformed config", async () => {
    bridge({
      projectsConfig: vi.fn(async () => ({
        path: "/p/Projects.md",
        content: "---\nmarkie_rules: [broken\n---\n",
        created: false,
        home: "/home/u",
      })),
      projectsState: vi.fn(async () => ({
        pins: [],
        blocks: [],
        assignments: [],
        fingerprint: "fp1",
        rulesKnownGood: "---\nmarkie_rules:\n  rules: []\n---\n",
        rulesError: null,
      })),
    });
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rulesError).toMatch(/./);
    expect(result.current.taxonomy).not.toBeNull(); // known-good kept it alive
    expect(result.current.taxonomy?.projects[0].name).toBe("P");
  });

  it("never writes a broken document back as known-good", async () => {
    const api = bridge({
      projectsConfig: vi.fn(async () => ({
        path: "/p/Projects.md",
        content: "---\nmarkie_rules: [broken\n---\n",
        created: false,
        home: "/home/u",
      })),
    });
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.projectsSaveCache).toHaveBeenCalledWith(
      expect.not.objectContaining({ rulesKnownGood: expect.anything() })
    );
  });

  it("applies the user's rules from the config document", async () => {
    bridge({
      projectsConfig: vi.fn(async () => ({
        path: "/p/Projects.md",
        content:
          '---\nmarkie_rules:\n  rules:\n    - match: "~/Documents/**"\n      project: Everything\n---\n',
        created: false,
        home: "/home/u",
      })),
    });
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.taxonomy?.projects[0].name).toBe("Everything");
  });

  it("says it is still scanning rather than claiming there is nothing", async () => {
    bridge({ mdIndexScan: vi.fn(async () => ({ files: [], scannedAt: null })) });
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scanning).toBe(true);
    expect(result.current.taxonomy?.projects).toEqual([]);
  });

  it("knows the difference between scanning and an empty machine", async () => {
    bridge({ mdIndexScan: vi.fn(async () => ({ files: [], scannedAt: "now" })) });
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scanning).toBe(false);
  });

  it("recomputes when the index broadcasts fresher rows", async () => {
    const api = bridge();
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.taxonomy?.projects[0].name).toBe("P"));
    const listener = (api.onMdIndexUpdated as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as (info: unknown) => void;
    listener({
      files: [{ ...ROWS[0], repoName: "my-repo" }],
      scannedAt: "later",
    });
    await waitFor(() => expect(result.current.taxonomy?.projects[0].name).toBe("my-repo"));
  });

  it("persists a pin and recomputes", async () => {
    const api = bridge();
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await result.current.pin("/home/u/Documents/P/a.md", "Chosen", "b1");
    expect(api.projectsPin).toHaveBeenCalledWith({
      path: "/home/u/Documents/P/a.md",
      project: "Chosen",
      blockId: "b1",
    });
    await waitFor(() => expect(api.projectsState).toHaveBeenCalledTimes(2));
  });

  it("clears a pin, renames, and merges through the decision channels", async () => {
    const api = bridge();
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await result.current.unpin("/x.md");
    await result.current.rename("b1", "Release work");
    await result.current.merge("b1", "b2");
    expect(api.projectsPin).toHaveBeenCalledWith({ path: "/x.md", clear: true });
    expect(api.projectsBlockSet).toHaveBeenCalledWith({ blockId: "b1", customName: "Release work" });
    expect(api.projectsBlockSet).toHaveBeenCalledWith({ blockId: "b1", mergeInto: "b2" });
  });

  it("does nothing at all without the desktop bridge", async () => {
    installBridge({ projectsState: undefined, projectsConfig: undefined } as never);
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
    expect(result.current.taxonomy).toBeNull();
  });
});
