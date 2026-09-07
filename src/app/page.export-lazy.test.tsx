import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

// Counts evaluations of the export pipeline module. A mock factory runs the
// first time anything imports the module it stands in for, so a static import
// anywhere on the launch path ticks this before the app has even mounted.
// Nothing else in this file may import @/lib/markdown-html at the top level,
// or the count starts at one no matter what page.tsx does.
const pipeline = vi.hoisted(() => ({ loads: 0 }));
vi.mock("@/lib/markdown-html", async (importOriginal) => {
  pipeline.loads += 1;
  return await importOriginal<typeof import("@/lib/markdown-html")>();
});

import Home from "./page";

// Every construct the pipeline is carried for: GFM tables, highlight.js on a
// fence, KaTeX on the math. If the lazy import ever resolved to something
// lighter, this document would come out different.
const FIXTURE = [
  "# Report",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "$E = mc^2$",
  "",
].join("\n");

const OPEN = { name: "report.md", path: "/notes/report.md", content: FIXTURE };

async function boot(overrides: Partial<ElectronAPI> = {}) {
  installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    ...overrides,
  });
  render(<Home />);
  await waitFor(() => expect(document.title).toBe("report.md — Markie"));
  await screen.findByText("Report");
}

const push = async (channel: string, ...args: unknown[]) => {
  await act(async () => {
    emit(channel, ...args);
  });
};

beforeEach(() => {
  localStorage.clear();
});

// unified, remark, rehype-katex, KaTeX and highlight.js are the heaviest thing
// the renderer can pull in, and they are only wanted for HTML export, print and
// PDF. They must load when one of those runs, not when Markie opens.
describe("the export pipeline is off the launch path", () => {
  it("loads it at the moment of export, and exports the same document", async () => {
    const exportHTML = vi.fn(async () => ({ success: true, path: "/tmp/report.html" }));
    await boot({ exportHTML } as Partial<ElectronAPI>);

    expect(pipeline.loads).toBe(0);

    await push("onMenuExportHTML");
    await waitFor(() => expect(exportHTML).toHaveBeenCalledTimes(1));
    expect(pipeline.loads).toBe(1);

    // Imported only now, so the assertion above stays honest.
    const { renderMarkdownHTML } = await import("@/lib/markdown-html");
    const { html } = (exportHTML.mock.calls[0] as unknown[])[0] as { html: string };
    expect(html).toContain(renderMarkdownHTML(FIXTURE));
  });
});
