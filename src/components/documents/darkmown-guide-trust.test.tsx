// What the agent guide says about trust in a .wd, held to the component that
// enforces it. The guide tells agents the preview starts switched off, that
// the user chooses "Trust this document" to turn the controls on, and that any
// edit to the source takes the trust away. Trust is tied to the exact source
// (darkmown-document-editor.tsx compares the granted text with the session
// text), so even typing a character and deleting it again must leave the
// document untrusted.
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentSession, editDocumentText, restoreDocumentText, type DocumentSession } from "@/lib/document-session";
import { compileDarkmownPreview } from "@/lib/darkmown/preview";
import { MARKDOWN_GUIDE } from "../../../mcp/markdown-guide.mjs";
import { DarkmownDocumentEditor } from "./darkmown-document-editor";

vi.mock("@/lib/darkmown/preview", () => ({ compileDarkmownPreview: vi.fn() }));
const compile = vi.mocked(compileDarkmownPreview);

/** The guide's own counter, so this test follows the example agents copy. */
const COUNTER = (/^```wd\n(# Water tracker[\s\S]*?)\n```$/m.exec(MARKDOWN_GUIDE)?.[1] ?? "") + "\n";
const frame = () => screen.queryByTitle("Darkmown document preview") as HTMLIFrameElement | null;

beforeEach(() => {
  compile.mockReset().mockImplementation(async (source, trusted) => ({ srcDoc: `<p>${trusted ? "trusted" : "inactive"}:${source.length}</p>`, warnings: [] }));
});
afterEach(cleanup);

describe("the guide's claims about trusting a .wd", () => {
  it("opens the guide's counter switched off, turns controls on for a trust choice, and takes trust away on any edit", async () => {
    expect(COUNTER).toContain(":state cups = 0");
    expect(MARKDOWN_GUIDE).toContain("**Trust this document**");
    expect(MARKDOWN_GUIDE).toContain("any edit to the source takes the trust away");

    let latest: DocumentSession = { ...await createDocumentSession("darkmown"), text: COUNTER };
    function Host() {
      const [session, setSession] = useState(latest);
      const update = (next: DocumentSession) => { latest = next; setSession(next); };
      return <DarkmownDocumentEditor session={session} onChange={(text) => update(editDocumentText(latest, text))} onRestoreText={(text) => update(restoreDocumentText(latest, text))} onFlushReady={vi.fn()} />;
    }
    render(<Host />);

    // Switched off: the frame runs no script, and the trust button is offered.
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect(screen.getByText("Controls inactive")).toBeInTheDocument();

    // Trusted: scripts may run in the opaque frame.
    fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", "allow-scripts"));
    const trustedFrame = frame();

    // One edit revokes it at once, before the next preview even builds.
    const field = screen.getByRole("textbox", { name: "Document text" });
    fireEvent.change(field, { target: { value: `${COUNTER}x` } });
    expect(trustedFrame).not.toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect(screen.getByRole("button", { name: "Trust this document" })).toBeInTheDocument();

    // Putting the text back does not bring the trust back: it was granted for the earlier edit's source.
    fireEvent.change(field, { target: { value: COUNTER } });
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect(screen.getByRole("button", { name: "Trust this document" })).toBeInTheDocument();
    expect(latest.text).toBe(COUNTER);
  });
});
