import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultPanel } from "./vault-panel";
import { validateStoredVault, VaultStorageError, type StoredVault, type VaultStorage } from "@/lib/vault/storage";
import { VaultRepository } from "@/lib/vault/repository";

const picker = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock("@/lib/web-files", async () => ({ ...await vi.importActual("@/lib/web-files"), pickWebDocument: picker.pick }));
const secret = "quartz maple orbit lantern harbor";

class TestStorage implements VaultStorage {
  value: StoredVault | null = null;
  fail = false;
  beforeCommit?: () => Promise<void>;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async commit(expected: number | null, next: StoredVault, signal?: AbortSignal) {
    await this.beforeCommit?.();
    if (signal?.aborted) throw new VaultStorageError("aborted");
    if (this.fail) throw new VaultStorageError("quota");
    if ((this.value?.revision ?? null) !== expected) throw new VaultStorageError("conflict");
    this.value = structuredClone(validateStoredVault(next));
  }
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  picker.pick.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function create(storage: TestStorage) {
  const view = render(<VaultPanel storage={storage} />);
  await screen.findByRole("button", { name: "Create encrypted vault" });
  fireEvent.change(screen.getByLabelText("Vault passphrase"), { target: { value: secret } });
  fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: secret } });
  fireEvent.click(screen.getByRole("button", { name: "Create encrypted vault" }));
  await screen.findByRole("button", { name: "New private note" });
  return view;
}

async function unlock() {
  fireEvent.change(screen.getByLabelText("Vault passphrase"), { target: { value: secret } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
  await screen.findByRole("button", { name: "New private note" });
}

describe("usable isolated encrypted vault panel", () => {
  it("creates, edits, durably saves, locks, reopens and searches without plaintext storage", async () => {
    const storage = new TestStorage();
    const view = await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private text" }), { target: { value: "Secret letter **literal**" } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText("Encrypted saved copy · Sharing and multiplayer are off in the vault.");
    expect(JSON.stringify(storage.value)).not.toContain("Secret letter");
    expect(JSON.stringify(storage.value)).not.toContain("Untitled.txt");
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    expect(screen.queryByRole("textbox", { name: "Private text" })).toBeNull();
    expect(screen.queryByText("Untitled.txt")).toBeNull();
    view.unmount();
    render(<VaultPanel storage={storage} />);
    await screen.findByRole("button", { name: "Unlock vault" });
    await unlock();
    fireEvent.change(screen.getByLabelText("Search private filenames"), { target: { value: "nothing" } });
    expect(screen.getByText("No matching files.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search private filenames"), { target: { value: "untitled" } });
    fireEvent.click(screen.getByRole("button", { name: /Untitled.txt/ }));
    expect(await screen.findByRole("textbox", { name: "Private text" })).toHaveValue("Secret letter **literal**");
  });

  it("retains dirty text on storage failure and encrypted recovery survives lock in this tab", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private text" }), { target: { value: "Do not lose my draft" } });
    storage.fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("storage is full");
    expect(screen.getByRole("textbox", { name: "Private text" })).toHaveValue("Do not lose my draft");
    expect(screen.getByText(/Unsaved private edits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    expect(screen.getByRole("textbox", { name: "Private text" })).toBeInTheDocument();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    storage.fail = false;
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /Untitled.txt/ }));
    expect(await screen.findByRole("textbox", { name: "Private text" })).toHaveValue("Do not lose my draft");
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText(/Encrypted saved copy/);
    expect(storage.value?.records.length).toBe(1);
  });

  it("shields hidden plaintext and checkpoints dirty text before automatic lock", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private text" }), { target: { value: "Keep through tab switch" } });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("textbox", { name: "Private text" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Securing last edits");
    await screen.findByRole("button", { name: "Unlock vault" });
    expect(storage.value?.records.length).toBe(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /Untitled.txt/ }));
    expect(await screen.findByRole("textbox", { name: "Private text" })).toHaveValue("Keep through tab switch");
  });

  it("hidden checkpoint failure keeps only encrypted recovery and makes its volatility explicit", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private text" }), { target: { value: "Quota failure secret" } });
    storage.fail = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByRole("button", { name: "Unlock vault" });
    expect(screen.getByRole("status")).toHaveTextContent("encrypted in memory only");
    expect(screen.queryByText("Quota failure secret")).toBeNull();
    expect(JSON.stringify(storage.value)).not.toContain("Quota failure secret");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    storage.fail = false;
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /Untitled.txt/ }));
    expect(await screen.findByRole("textbox", { name: "Private text" })).toHaveValue("Quota failure secret");
  });

  it("imports an encrypted text copy without using normal library callbacks", async () => {
    const storage = new TestStorage();
    await create(storage);
    picker.pick.mockResolvedValue({ name: "Imported.txt", bytes: new TextEncoder().encode("imported private text"),
      format: { mimeType: "text/plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Import encrypted copy" }));
    expect(await screen.findByRole("textbox", { name: "Private text" })).toHaveValue("imported private text");
    expect(JSON.stringify(storage.value)).not.toContain("Imported.txt");
    expect(JSON.stringify(storage.value)).not.toContain("imported private text");
  });

  it("edits a generated DOCX privately and reopens its encrypted saved version", async () => {
    const storage = new TestStorage();
    await create(storage);
    const { createDocx, exportDocx } = await import("@/lib/office/docx");
    picker.pick.mockResolvedValue({ name: "Private.docx", bytes: await exportDocx(await createDocx("Original private sentence")),
      format: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
    fireEvent.click(screen.getByRole("button", { name: "Import encrypted copy" }));
    const run = await screen.findByRole("textbox", { name: "Private paragraph 1, run 1" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Import encrypted copy" })).not.toBeDisabled());
    fireEvent.change(run, { target: { value: "Edited private sentence" } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText(/Encrypted saved copy/);
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /Private.docx/ }));
    expect(await screen.findByRole("textbox", { name: "Private paragraph 1, run 1" })).toHaveValue("Edited private sentence");
    expect(JSON.stringify(storage.value)).not.toContain("Edited private sentence");
  });

  it("does not adopt private entries when authentication completes in a hidden tab", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    fireEvent.change(screen.getByLabelText("Vault passphrase"), { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("locked because this page is hidden"));
    expect(screen.queryByLabelText("Search private filenames")).toBeNull();
  });

  it("locks after a stuck checkpoint and cannot commit its late storage result", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private text" }), { target: { value: "Late checkpoint body" } });
    let release!: () => void;
    storage.beforeCommit = () => new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByRole("button", { name: "Unlock vault" }, { timeout: 3000 });
    expect(screen.getByRole("status")).toHaveTextContent("checkpoint time limit");
    expect(storage.value?.records).toEqual([]);
    release();
    storage.beforeCommit = undefined;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await unlock();
    expect(storage.value?.records).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Untitled.txt/ }));
    expect(await screen.findByRole("textbox", { name: "Private text" })).toHaveValue("Late checkpoint body");
  });

  it("requires confirmation before decrypted export and deletion", async () => {
    const storage = new TestStorage();
    await create(storage);
    // Saving commits before the subsequent decrypted list refresh finishes.
    // Hold that real decrypt so the busy/disabled interval is deterministic.
    let release!: () => void;
    const refreshGate = new Promise<void>((resolve) => { release = resolve; });
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...arguments_) => {
      const result = await decrypt(...arguments_);
      await refreshGate;
      return result;
    });
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText(/Encrypted saved copy/);
    const download = screen.getByRole("button", { name: /Download unencrypted/ });
    expect(download).toBeDisabled();
    release();
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("unencrypted copy"));
    fireEvent.click(screen.getByRole("button", { name: "Delete encrypted copy" }));
    expect(storage.value?.records.length).toBe(1);
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete encrypted copy" }));
    await waitFor(() => expect(storage.value?.records.length).toBe(0));
  });

  it("allows normal filename typing but does not disguise text bytes as DOCX", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    const name = screen.getByLabelText("Private filename");
    fireEvent.change(name, { target: { value: "R" } });
    expect(name).toHaveValue("R");
    fireEvent.change(name, { target: { value: "Renamed.docx" } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("original file type");
    expect(storage.value?.records).toEqual([]);
    fireEvent.change(name, { target: { value: "Renamed.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText(/Encrypted saved copy/);
    expect(await screen.findByRole("button", { name: /Renamed.txt/ })).toBeInTheDocument();
  });

  it("does not open private data after a wrong passphrase", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    fireEvent.change(screen.getByLabelText("Vault passphrase"), { target: { value: "the wrong long passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("incorrect or the vault was altered");
    expect(screen.queryByRole("button", { name: "New private note" })).toBeNull();
    expect(screen.getByLabelText("Vault passphrase")).toHaveValue("");
  });

  it("locks keys after a tampered record prevents listing and permits a safe retry", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText(/Encrypted saved copy/);
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    const original = storage.value!;
    const changed = JSON.parse(original.records[0].envelope);
    changed.ciphertext = (changed.ciphertext[0] === "A" ? "B" : "A") + changed.ciphertext.slice(1);
    storage.value = { ...original, records: [{ ...original.records[0], envelope: JSON.stringify(changed) }] };
    fireEvent.change(screen.getByLabelText("Vault passphrase"), { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Search private filenames")).toBeNull();
    storage.value = original;
    await unlock();
    expect(screen.getByRole("button", { name: /Untitled.txt/ })).toBeInTheDocument();
  });

  it("exposes a no-plaintext navigation guard that prevents dirty editor unmount", async () => {
    const storage = new TestStorage();
    let guard: (() => boolean) | null = null;
    const view = render(<VaultPanel storage={storage} onCloseGuard={(value) => { guard = value; }} />);
    await screen.findByRole("button", { name: "Create encrypted vault" });
    fireEvent.change(screen.getByLabelText("Vault passphrase"), { target: { value: secret } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Create encrypted vault" }));
    await screen.findByRole("button", { name: "New private note" });
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private text" }), { target: { value: "Keep when navigation canceled" } });
    expect(guard!()).toBe(false);
    expect(screen.getByRole("textbox", { name: "Private text" })).toHaveValue("Keep when navigation canceled");
    view.unmount();
    expect(guard).toBeNull();
  });

  it("routes Cmd-S to encrypted save rather than the browser's Save Page", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private text" }), { target: { value: "Keyboard encrypted save" } });
    const event = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
    await screen.findByText(/Encrypted saved copy/);
    expect(storage.value?.records.length).toBe(1);
    expect(JSON.stringify(storage.value)).not.toContain("Keyboard encrypted save");
  });
});

describe("vault page with environment keys", () => {
  async function decryptedFiles(storage: TestStorage) {
    const repository = new VaultRepository(storage);
    await repository.unlock(secret);
    try {
      const files = new Map<string, Uint8Array>();
      for (const entry of await repository.list()) files.set(entry.name, (await repository.read(entry.id)).bytes);
      return files;
    } finally { repository.lock(); }
  }

  it("is a page with a Vault header, a lock button and no close button", async () => {
    const storage = new TestStorage();
    render(<VaultPanel storage={storage} onClose={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "Vault" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close vault" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lock vault" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Vault passphrase"), { target: { value: secret } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Create encrypted vault" }));
    await screen.findByRole("button", { name: "New environment keys" });
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Lock vault" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close vault" })).toBeNull();
  });

  it("creates environment keys, saves them encrypted and reopens them masked under Environment keys", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New environment keys" }));
    expect(screen.getByLabelText("Private filename")).toHaveValue("Untitled.env");
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getByLabelText("Key name, row 1"), { target: { value: "API_TOKEN" } });
    fireEvent.change(screen.getByLabelText("Value of API_TOKEN"), { target: { value: "tok_secret_value" } });
    expect(screen.getByText(/Unsaved private edits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText(/Encrypted saved copy/);
    expect(JSON.stringify(storage.value)).not.toContain("API_TOKEN");
    expect(JSON.stringify(storage.value)).not.toContain("tok_secret_value");
    expect(JSON.stringify(storage.value)).not.toContain("Untitled.env");
    expect(new TextDecoder().decode((await decryptedFiles(storage)).get("Untitled.env"))).toBe("API_TOKEN=tok_secret_value\n");

    fireEvent.click(screen.getByRole("button", { name: "New private note" }));
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByRole("button", { name: /Untitled.txt/ });
    fireEvent.click(screen.getByRole("button", { name: "Lock vault" }));
    expect(screen.queryByLabelText("Value of API_TOKEN")).toBeNull();
    await unlock();
    const items = screen.getByRole("navigation", { name: "Encrypted items" });
    const envGroup = within(items).getByRole("heading", { name: "Environment keys" }).parentElement!;
    const fileGroup = within(items).getByRole("heading", { name: "Files" }).parentElement!;
    expect(within(envGroup).getByRole("button", { name: /Untitled.env/ })).toBeInTheDocument();
    expect(within(fileGroup).getByRole("button", { name: /Untitled.txt/ })).toBeInTheDocument();
    expect(within(fileGroup).queryByRole("button", { name: /Untitled.env/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search private filenames"), { target: { value: ".txt" } });
    expect(within(items).queryByRole("heading", { name: "Environment keys" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search private filenames"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Untitled.env/ }));
    const value = await screen.findByLabelText("Value of API_TOKEN");
    expect(value).toHaveAttribute("type", "password");
    expect(value).toHaveValue("tok_secret_value");
  });

  it("imports a .env file as text and saves edits with its original encoding, newlines and untouched lines", async () => {
    const storage = new TestStorage();
    await create(storage);
    const source = "# shared\r\nexport DB_URL=postgres://a\r\nSECRET='old' # rotate\r\nnot valid\r\n";
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(source)]);
    // The shared format table does not know dotenv names, so the picker reports them as opaque bytes.
    picker.pick.mockResolvedValue({ name: ".env.local", bytes, format: { mimeType: "application/octet-stream" } });
    fireEvent.click(screen.getByRole("button", { name: "Import encrypted copy" }));
    const secretValue = await screen.findByLabelText("Value of SECRET");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import encrypted copy" })).not.toBeDisabled());
    expect(secretValue).toHaveValue("old");
    expect(screen.getByLabelText(/Unreadable line/)).toBeInTheDocument();
    fireEvent.change(secretValue, { target: { value: "new value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    await screen.findByText(/Encrypted saved copy/);
    const saved = (await decryptedFiles(storage)).get(".env.local")!;
    expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(saved.subarray(3))).toBe(source.replace("SECRET='old'", "SECRET='new value'"));
    expect(JSON.stringify(storage.value)).not.toContain("SECRET");
  });

  it("checkpoints dirty environment keys before an automatic lock", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New environment keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Environment file text" }), { target: { value: "KEEP=through-lock\n" } });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("textbox", { name: "Environment file text" })).toBeNull();
    await screen.findByRole("button", { name: "Unlock vault" });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /Untitled.env/ }));
    expect(await screen.findByLabelText("Value of KEEP")).toHaveValue("through-lock");
  });

  it("keeps an environment file's type when renaming", async () => {
    const storage = new TestStorage();
    await create(storage);
    fireEvent.click(screen.getByRole("button", { name: "New environment keys" }));
    fireEvent.change(screen.getByLabelText("Private filename"), { target: { value: "Untitled.docx" } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("original file type");
    fireEvent.change(screen.getByLabelText("Private filename"), { target: { value: "prod.env" } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted changes" }));
    expect(await screen.findByRole("button", { name: /prod.env/ })).toBeInTheDocument();
  });
});
