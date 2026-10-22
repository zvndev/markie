import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudDocumentEditor, type CloudEditingState } from "./cloud-document-editor";
import { createDocx, exportDocx, openDocx } from "@/lib/office/docx";

afterEach(cleanup);
describe("existing cloud Word editor commands", () => {
  it("keeps advanced page layout reachable in the cloud modal and preserves exported OOXML", async () => {
    const initial: CloudEditingState = { kind: "docx", document: await createDocx("Existing shared Markie document") };
    let latest = initial;
    const outerEscape = vi.fn();
    function Host() {
      const [value, setValue] = useState<CloudEditingState>(initial);
      return <section role="dialog" aria-modal="true" aria-label="Cloud document" onKeyDown={(event) => { if (event.key === "Escape") outerEscape(); }}><CloudDocumentEditor value={value} readOnly={false} onChange={(next) => { if (next.kind !== "docx") throw new Error("The cloud Word renderer changed file types."); latest = next; setValue(next); }} /></section>;
    }
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Document commands" }));
    fireEvent.change(screen.getByPlaceholderText("Type a command…"), { target: { value: "Page Setup" } });
    fireEvent.click(screen.getByRole("option", { name: /Page Setup/ }));
    await screen.findByRole("dialog", { name: "Page Setup" });
    fireEvent.click(screen.getByRole("button", { name: "Landscape" })); fireEvent.click(screen.getByRole("button", { name: "Close Page Setup" }));
    const reopened = await openDocx(await exportDocx(latest.document));
    expect(reopened.pageLayout.orientation).toBe("landscape"); expect(reopened.text).toBe("Existing shared Markie document");
    expect(screen.queryByRole("tablist")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Document commands" })); fireEvent.keyDown(screen.getByPlaceholderText("Type a command…"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull(); expect(outerEscape).not.toHaveBeenCalled();
  });
});
