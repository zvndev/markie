import { act, fireEvent, render, screen } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TextNewline } from "@/lib/document-formats";
import { CLIPBOARD_CLEAR_MS, normalizeTypedNewlines, VaultEnvEditor } from "./vault-env-editor";

const SOURCE = "# Payments\r\nSTRIPE_KEY=sk_live_123\r\nexport DB_URL=\"postgres://u:p@h/db\" # primary\r\n\r\n# OLD_TOKEN=parked-secret\r\nnot a pair\r\n";

function Harness({ initial, newline = "crlf", spy }: { initial: string; newline?: TextNewline; spy: { changes: string[]; notices: string[]; errors: string[] } }) {
  const [text, setText] = useState(initial);
  return <VaultEnvEditor text={text} newline={newline}
    onChange={(next) => { spy.changes.push(next); setText(next); }}
    onNotice={(message) => spy.notices.push(message)}
    onError={(message) => spy.errors.push(message)} />;
}

function setup(initial = SOURCE, newline: TextNewline = "crlf") {
  const spy = { changes: [] as string[], notices: [] as string[], errors: [] as string[] };
  render(<Harness initial={initial} newline={newline} spy={spy} />);
  return spy;
}

let clipboard: { writeText: Mock<(value: string) => Promise<void>>; readText: Mock<() => Promise<string>> };
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  let stored = "";
  clipboard = {
    writeText: vi.fn(async (value: string) => { stored = value; }),
    readText: vi.fn(async () => stored),
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("vault environment key editor", () => {
  it("masks values by default and reveals one row or all rows on request", () => {
    setup();
    const stripe = screen.getByLabelText("Value of STRIPE_KEY");
    expect(stripe).toHaveAttribute("type", "password");
    expect(stripe).toHaveValue("sk_live_123");
    expect(screen.getByLabelText("Value of DB_URL")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Reveal STRIPE_KEY" }));
    expect(stripe).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Value of DB_URL")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(screen.getByLabelText("Value of DB_URL")).toHaveAttribute("type", "text");
    expect(screen.getByText("# OLD_TOKEN=parked-secret")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
    expect(stripe).toHaveAttribute("type", "password");
    expect(screen.queryByText(/parked-secret/)).toBeNull();
  });

  it("shows comments as quiet rows and masks a secret parked in a comment", () => {
    setup();
    expect(screen.getByText("# Payments")).toBeInTheDocument();
    expect(screen.queryByText(/parked-secret/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal commented OLD_TOKEN" }));
    expect(screen.getByText("# OLD_TOKEN=parked-secret")).toBeInTheDocument();
  });

  it("keeps malformed lines read-only and verbatim", () => {
    const spy = setup();
    const line = screen.getByLabelText(/Unreadable line/);
    expect(line).not.toHaveTextContent("not a pair");
    expect(screen.getByText(/no = sign\. Kept exactly as written\. Edit it in Raw\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reveal line/ }));
    expect(line).toHaveTextContent("not a pair");
    expect(line.tagName).toBe("CODE");
    expect(spy.changes).toEqual([]);
  });

  it("edits a value by rewriting only that line and keeps CRLF", () => {
    const spy = setup();
    fireEvent.change(screen.getByLabelText("Value of STRIPE_KEY"), { target: { value: "sk live 456" } });
    expect(spy.changes.at(-1)).toBe(SOURCE.replace("STRIPE_KEY=sk_live_123", "STRIPE_KEY=\"sk live 456\""));
    fireEvent.change(screen.getByLabelText("Value of DB_URL"), { target: { value: "postgres://other" } });
    expect(spy.changes.at(-1)).toBe(SOURCE.replace("STRIPE_KEY=sk_live_123", "STRIPE_KEY=\"sk live 456\"")
      .replace("\"postgres://u:p@h/db\" # primary", "\"postgres://other\" # primary"));
  });

  it("validates key names inline and flags duplicates", () => {
    const spy = setup("A=1\nB=2\n", "lf");
    fireEvent.change(screen.getByLabelText("Key name, row 2"), { target: { value: "2B" } });
    expect(screen.getByText(/Start with a letter or underscore/)).toBeInTheDocument();
    expect(screen.getByLabelText("Key name, row 2")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(screen.getByLabelText("Key name, row 2"), { target: { value: "A" } });
    expect(screen.getAllByText("A is set more than once. Most loaders use the last one.")).toHaveLength(2);
    expect(spy.changes.at(-1)).toBe("A=1\nA=2\n");
    fireEvent.change(screen.getByLabelText("Key name, row 2"), { target: { value: "" } });
    expect(screen.getByText("Add a key name.")).toBeInTheDocument();
  });

  it("adds and removes rows in the file's line ending style", () => {
    const spy = setup("A=1\r\nB=2", "crlf");
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    const key = screen.getByLabelText("Key name, row 3");
    expect(key).toHaveFocus();
    fireEvent.change(key, { target: { value: "NEW" } });
    fireEvent.change(screen.getByLabelText("Value of NEW"), { target: { value: "v" } });
    expect(spy.changes.at(-1)).toBe("A=1\r\nB=2\r\nNEW=v");
    fireEvent.click(screen.getByRole("button", { name: "Remove B" }));
    expect(spy.changes.at(-1)).toBe("A=1\r\nNEW=v");
    expect(screen.queryByLabelText("Value of B")).toBeNull();
  });

  it("switches to editable raw text that stays in sync with the table", () => {
    const spy = setup("A=1\r\n", "crlf");
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    const raw = screen.getByRole("textbox", { name: "Environment file text" });
    // Browser text controls expose bare LF; the CRLF source is restored on change.
    expect(raw).toHaveValue("A=1\n");
    fireEvent.change(raw, { target: { value: "A=1\nB=two\n" } });
    expect(spy.changes.at(-1)).toBe("A=1\r\nB=two\r\n");
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByLabelText("Value of B")).toHaveValue("two");
    expect(screen.getByLabelText("Value of B")).toHaveAttribute("type", "password");
  });

  it("keeps mixed line endings read-only in raw view", () => {
    setup("A=1\r\nB=2\n", "mixed");
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByRole("textbox", { name: "Environment file text" })).toHaveAttribute("readonly");
    expect(screen.getByText(/Mixed line endings are preserved read-only/)).toBeInTheDocument();
  });

  it("copies a value, says it left the vault, and clears it after 30 seconds only if unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const spy = setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy value of STRIPE_KEY" })); });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("sk_live_123");
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(spy.notices.at(-1)).toBe("Copied the value of STRIPE_KEY. It is now on the clipboard, outside the vault. Markie clears it after 30 seconds if it is still there.");
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS); });
    // The clear reads the clipboard and hashes it on real async crypto after the timer fires.
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(""));

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy value of DB_URL" })); });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await clipboard.writeText("something the user copied later");
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS); });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("something the user copied later");
  });

  it("copies the whole file as .env text", async () => {
    const spy = setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy as .env" })); });
    expect(clipboard.writeText).toHaveBeenLastCalledWith(SOURCE);
    expect(spy.notices.at(-1)).toContain("outside the vault");
  });

  it("reports an unavailable clipboard without claiming a copy", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    const spy = setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy value of STRIPE_KEY" })); });
    expect(spy.errors).toEqual(["Clipboard access is unavailable. Nothing was copied."]);
    expect(spy.notices).toEqual([]);
  });

  it("masks multi-line values until revealed", () => {
    setup("PEM=\"-----BEGIN-----\nabc\n-----END-----\"\n", "lf");
    expect(screen.getByLabelText("Value of PEM, hidden")).toHaveTextContent("3 lines");
    expect(screen.queryByText(/abc/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal PEM" }));
    expect(screen.getByRole("textbox", { name: "Value of PEM" })).toHaveValue("-----BEGIN-----\nabc\n-----END-----");
  });

  it("starts empty files with an add prompt", () => {
    const spy = setup("", "none");
    expect(screen.getByText(/No keys yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as .env" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getByLabelText("Key name, row 1"), { target: { value: "API_KEY" } });
    expect(spy.changes.at(-1)).toBe("API_KEY=\n");
  });

  it("normalizes typed newlines to the source style", () => {
    expect(normalizeTypedNewlines("a\nb", "crlf")).toBe("a\r\nb");
    expect(normalizeTypedNewlines("a\nb", "cr")).toBe("a\rb");
    expect(normalizeTypedNewlines("a\nb", "lf")).toBe("a\nb");
  });
});
