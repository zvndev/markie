// @vitest-environment jsdom
// Files on this phone, with the native plugin faked: a small pretend device
// that holds bytes, checks the version a save started from, and can be told
// to change a file behind the app's back, refuse a write or revoke a grant.
// What the fake cannot show (that Android really truncates, that iOS really
// swaps the file in whole) is proven on devices, not here.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDocx, exportDocx } from "@/lib/office/docx";
import {
  base64ToBytes, besideName, bytesToBase64, createLocalFiles, encodeLocalText, isOpenableName, LocalFileError,
  type LocalEntry, type LocalFilesPlugin, type LocalGrant,
} from "../src/lib/local-files";
import { localEditing } from "../src/lib/local-editing";
import { localDiffSummary } from "../src/components/local-conflict-sheet";
import { sha256Bytes } from "../src/lib/sha256";

vi.mock("@/components/rich-view", () => ({ RichView: () => null }));
vi.mock("@/components/text-collab-editor", () => ({ TextCollabEditor: () => null }));
vi.mock("../src/components/darkmown-view", () => ({ DarkmownView: () => null }));

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Array.from(sha256Bytes(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const fail = (code: string, message = code) => Object.assign(new Error(message), { code });

/** A pretend device: one granted folder ("notes") and any number of single files. */
function fakeDevice() {
  const disk = new Map<string, Uint8Array>();
  const grants = new Map<string, LocalGrant & { path: string }>();
  const revoked = new Set<string>();
  const calls = { write: 0, create: 0, read: 0 };
  let failWrites: string | null = null;
  let nextPick: string | null = null;
  let seq = 0;

  const grant = (kind: "file" | "folder", path: string): LocalGrant => {
    const id = `g${++seq}`;
    const made = { id, kind, name: path.split("/").pop()!, reachable: true, persisted: true, usedAt: seq, path };
    grants.set(id, made);
    return made;
  };
  const pathOf = (grantId: string, entry?: string) => {
    const held = grants.get(grantId);
    if (!held || revoked.has(grantId)) throw fail("unreachable");
    if (held.kind === "file") {
      if (entry) throw fail("outside");
      return held.path;
    }
    if (entry?.split("/").some((part) => part === ".." || part === "" || part === ".")) throw fail("outside");
    return entry ? `${held.path}/${entry}` : held.path;
  };

  const plugin: LocalFilesPlugin = {
    async pickDocument() { return nextPick ? { grant: grant("file", nextPick) } : {}; },
    async pickFolder() { return nextPick ? { grant: grant("folder", nextPick) } : {}; },
    async grants() { return { grants: [...grants.values()].map(({ path: _path, ...rest }) => ({ ...rest, reachable: !revoked.has(rest.id) })) }; },
    async forget({ grantId }) { grants.delete(grantId); },
    async list({ grantId, entry }) {
      const folder = pathOf(grantId, entry);
      const entries = new Map<string, LocalEntry>();
      for (const [path, bytes] of disk) {
        if (!path.startsWith(`${folder}/`)) continue;
        const [name, ...rest] = path.slice(folder.length + 1).split("/");
        const id = entry ? `${entry}/${name}` : name;
        entries.set(name, rest.length ? { id, name, folder: true } : { id, name, folder: false, size: bytes.length });
      }
      return { entries: [...entries.values()] };
    },
    async read({ grantId, entry }) {
      calls.read += 1;
      const path = pathOf(grantId, entry);
      const bytes = disk.get(path);
      if (!bytes) throw fail("missing");
      return { name: path.split("/").pop()!, data: bytesToBase64(bytes), hash: hex(bytes), writable: true };
    },
    async write({ grantId, entry, data, baseHash }) {
      calls.write += 1;
      const path = pathOf(grantId, entry);
      if (failWrites) throw fail(failWrites, "The disk is full.");
      const current = disk.get(path);
      if (baseHash !== undefined) {
        if (!current) throw fail("missing");
        if (hex(current) !== baseHash) throw fail("changed");
      }
      // The whole file is replaced: what is on the disk afterwards is exactly the new bytes.
      const bytes = base64ToBytes(data);
      disk.set(path, bytes);
      return { hash: hex(bytes) };
    },
    async create({ grantId, parent, name, data }) {
      calls.create += 1;
      const path = `${pathOf(grantId, parent)}/${name}`;
      if (disk.has(path)) throw fail("exists");
      disk.set(path, base64ToBytes(data));
      return { entry: { id: parent ? `${parent}/${name}` : name, name, folder: false } };
    },
    async adopt({ url }) { return url.startsWith("file:///in-place/") ? { grant: grant("file", url.slice("file://".length)) } : { name: "From Gmail.md" }; },
  };

  return {
    plugin, disk, calls, grant,
    files: createLocalFiles(plugin),
    pickNext(path: string | null) { nextPick = path; },
    revoke(grantId: string) { revoked.add(grantId); },
    failWrites(code: string | null) { failWrites = code; },
    text: (path: string) => new TextDecoder().decode(disk.get(path)),
  };
}

describe("opening one file and saving it in place", () => {
  it("writes the edited text back to the same file, and a second save starts from the first", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/Plan.md", utf8("# Plan\n\nFirst.\n"));
    const grant = device.grant("file", "/phone/Plan.md");
    const doc = await device.files.open({ grantId: grant.id, entry: null });
    expect(doc).toMatchObject({ name: "Plan.md", format: "markdown", content: "# Plan\n\nFirst.\n", readOnly: null, convertedFrom: null });

    const saved = await device.files.save(doc, "# Plan\n\nFirst.\nSecond.\n");
    expect(device.text("/phone/Plan.md")).toBe("# Plan\n\nFirst.\nSecond.\n");
    expect(saved.content).toBe("# Plan\n\nFirst.\nSecond.\n");

    await device.files.save(saved, "# Plan\n");
    expect(device.text("/phone/Plan.md")).toBe("# Plan\n");
  });

  it("leaves nothing of the old text behind when the file gets shorter", async () => {
    const device = fakeDevice();
    const long = `# Notes\n\n${"A long line that will be deleted.\n".repeat(200)}`;
    device.disk.set("/phone/Notes.md", utf8(long));
    const grant = device.grant("file", "/phone/Notes.md");
    const doc = await device.files.open({ grantId: grant.id, entry: null });
    const saved = await device.files.save(doc, "# Notes\n");
    const onDisk = device.disk.get("/phone/Notes.md")!;
    expect(onDisk.length).toBe(8);
    expect(new TextDecoder().decode(onDisk)).toBe("# Notes\n");
    // What the app now believes is on the device is what is on the device.
    expect(saved.shape?.hash).toBe(hex(onDisk));
    expect((await device.files.open(doc.ref)).content).toBe("# Notes\n");
  });

  it("keeps the file's encoding, its mark and its line endings", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/win.txt", new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("one\r\ntwo\r\n")]));
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from("hi\n").flatMap((c) => [c.charCodeAt(0), 0])]);
    device.disk.set("/phone/wide.txt", utf16);
    const win = await device.files.open({ grantId: device.grant("file", "/phone/win.txt").id, entry: null });
    // The editor works in plain line feeds.
    expect(win.content).toBe("one\ntwo\n");
    await device.files.save(win, "one\ntwo\nthree\n");
    expect(Array.from(device.disk.get("/phone/win.txt")!)).toEqual([0xef, 0xbb, 0xbf, ...utf8("one\r\ntwo\r\nthree\r\n")]);

    const wide = await device.files.open({ grantId: device.grant("file", "/phone/wide.txt").id, entry: null });
    expect(wide.content).toBe("hi\n");
    await device.files.save(wide, "ho\n");
    expect(Array.from(device.disk.get("/phone/wide.txt")!)).toEqual([0xff, 0xfe, 0x68, 0, 0x6f, 0, 0x0a, 0]);
  });

  it("does not turn lone line feeds into CR LF, or the other way round", () => {
    expect(Array.from(encodeLocalText("a\nb", { encoding: "utf-8", bom: false, crlf: false }))).toEqual(Array.from(utf8("a\nb")));
    expect(Array.from(encodeLocalText("a\r\nb\nc", { encoding: "utf-8", bom: false, crlf: true }))).toEqual(Array.from(utf8("a\r\nb\r\nc")));
  });
});

describe("a file that changed underneath", () => {
  it("is never written over: the save is refused and the other version is untouched", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/Plan.md", utf8("one\n"));
    const doc = await device.files.open({ grantId: device.grant("file", "/phone/Plan.md").id, entry: null });
    // Another app, or iCloud, saves a newer version while the editor is open.
    device.disk.set("/phone/Plan.md", utf8("one\nfrom the other app\n"));
    const refused = await device.files.save(doc, "one\nmine\n").catch((error) => error);
    expect(refused).toBeInstanceOf(LocalFileError);
    expect(refused.code).toBe("changed");
    expect(device.text("/phone/Plan.md")).toBe("one\nfrom the other app\n");
  });

  it("is written over only when the person chose that", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/Plan.md", utf8("one\n"));
    const doc = await device.files.open({ grantId: device.grant("file", "/phone/Plan.md").id, entry: null });
    device.disk.set("/phone/Plan.md", utf8("theirs\n"));
    const saved = await device.files.save(doc, "mine\n", { overwrite: true });
    expect(device.text("/phone/Plan.md")).toBe("mine\n");
    // The next ordinary save starts from what was just written.
    await device.files.save(saved, "mine again\n");
    expect(device.text("/phone/Plan.md")).toBe("mine again\n");
  });

  it("says so when the file was deleted, and writes nothing", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/Plan.md", utf8("one\n"));
    const doc = await device.files.open({ grantId: device.grant("file", "/phone/Plan.md").id, entry: null });
    device.disk.delete("/phone/Plan.md");
    const refused = await device.files.save(doc, "mine\n").catch((error) => error);
    expect(refused.code).toBe("missing");
    expect(device.disk.has("/phone/Plan.md")).toBe(false);
  });

  it("keeps both in a folder: a second file beside the first, which is left alone", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/notes/Plan.md", utf8("one\n"));
    device.disk.set("/phone/notes/Plan (my version).md", utf8("an earlier rescue\n"));
    const folder = device.grant("folder", "/phone/notes");
    const doc = await device.files.open({ grantId: folder.id, entry: "Plan.md", parent: null });
    device.disk.set("/phone/notes/Plan.md", utf8("theirs\n"));
    const copy = await device.files.saveBeside(doc, "mine\n");
    expect(copy.name).toBe("Plan (my version 2).md");
    expect(device.text("/phone/notes/Plan (my version 2).md")).toBe("mine\n");
    expect(device.text("/phone/notes/Plan.md")).toBe("theirs\n");
    expect(device.text("/phone/notes/Plan (my version).md")).toBe("an earlier rescue\n");
  });

  it("has no second file to offer for a file opened on its own", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/Plan.md", utf8("one\n"));
    const doc = await device.files.open({ grantId: device.grant("file", "/phone/Plan.md").id, entry: null });
    expect(localEditing(device.files, doc, { saved: () => {}, gone: () => {} }).keepBoth).toBeNull();
    expect(await device.files.saveBeside(doc, "mine\n").catch((error) => error.code)).toBe("failed");
    expect(device.calls.create).toBe(0);
  });

  it("names a rescue so it never lands on a file that is there", () => {
    expect(besideName("Plan.md", () => false)).toBe("Plan (my version).md");
    expect(besideName("notes", (name) => name === "notes (my version)")).toBe("notes (my version 2)");
    expect(besideName("Plan.md", () => true)).toBeNull();
  });

  it("states the cost in lines", () => {
    expect(localDiffSummary({ added: 0, removed: 0 })).toBe("The file and your version are the same.");
    expect(localDiffSummary({ added: 2, removed: 0 })).toBe("The file has 2 lines your version doesn't.");
    expect(localDiffSummary({ added: 1, removed: 3 })).toBe("Your version has 3 lines the file doesn't, and the file has 1 line yours doesn't.");
  });
});

describe("a write that fails", () => {
  it("reports it, changes nothing on the device and leaves the document as it was", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/Plan.md", utf8("one\n"));
    const doc = await device.files.open({ grantId: device.grant("file", "/phone/Plan.md").id, entry: null });
    device.failWrites("failed");
    const failed = await device.files.save(doc, "mine\n").catch((error) => error);
    expect(failed).toBeInstanceOf(LocalFileError);
    expect(failed.code).toBe("failed");
    expect(failed.message).toBe("The disk is full.");
    expect(device.text("/phone/Plan.md")).toBe("one\n");
    // The same document can be saved once the device takes writes again.
    device.failWrites(null);
    await device.files.save(doc, "mine\n");
    expect(device.text("/phone/Plan.md")).toBe("mine\n");
  });

  it("refuses text the file's encoding can't hold before anything is written", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/Plan.md", utf8("one\n"));
    const doc = await device.files.open({ grantId: device.grant("file", "/phone/Plan.md").id, entry: null });
    const failed = await device.files.save(doc, "bad \u0000 byte").catch((error) => error);
    expect(failed).toBeInstanceOf(LocalFileError);
    expect(device.calls.write).toBe(0);
    expect(device.text("/phone/Plan.md")).toBe("one\n");
  });
});

describe("a grant the phone took back", () => {
  it("is listed as unreachable, and reading or saving through it says so", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/notes/Plan.md", utf8("one\n"));
    const folder = device.grant("folder", "/phone/notes");
    const doc = await device.files.open({ grantId: folder.id, entry: "Plan.md", parent: null });
    device.revoke(folder.id);

    expect((await device.files.grants())[0]).toMatchObject({ id: folder.id, reachable: false });
    expect(await device.files.list(folder.id, null).catch((error) => error.code)).toBe("unreachable");
    expect(await device.files.open(doc.ref).catch((error) => error.code)).toBe("unreachable");
    const refused = await device.files.save(doc, "mine\n").catch((error) => error);
    expect(refused.code).toBe("unreachable");
    expect(refused.message).toBe("Markie can't reach this file any more.");
    expect(device.text("/phone/notes/Plan.md")).toBe("one\n");
  });

  it("can be removed, and a path that climbs out of a folder is never followed", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/secret.md", utf8("not granted\n"));
    device.disk.set("/phone/notes/Plan.md", utf8("one\n"));
    const folder = device.grant("folder", "/phone/notes");
    expect(await device.files.open({ grantId: folder.id, entry: "../secret.md" }).catch((error) => error.code)).toBe("unreachable");
    await device.files.forget(folder.id);
    expect(await device.files.grants()).toEqual([]);
  });
});

describe("what a local file may be", () => {
  it("refuses a file that isn't valid text rather than repair it", async () => {
    const device = fakeDevice();
    // "café" in Latin-1: the é is one byte that is not UTF-8.
    device.disk.set("/phone/old.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const refused = await device.files.open({ grantId: device.grant("file", "/phone/old.txt").id, entry: null }).catch((error) => error);
    expect(refused).toBeInstanceOf(LocalFileError);
    expect(refused.code).toBe("not-text");
    expect(refused.message).toContain("No bytes were replaced");
    expect(Array.from(device.disk.get("/phone/old.txt")!)).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    expect(device.calls.write).toBe(0);
  });

  it("opens a Word file as a converted copy that can never be saved over the original", async () => {
    const device = fakeDevice();
    const docx = await exportDocx(await createDocx("From Word"));
    device.disk.set("/phone/Report.docx", docx);
    const doc = await device.files.open({ grantId: device.grant("file", "/phone/Report.docx").id, entry: null });
    expect(doc).toMatchObject({ name: "Report.docx", cloudName: "Report.md", convertedFrom: "Word", readOnly: "converted", shape: null });
    expect(doc.content).toContain("From Word");
    const refused = await device.files.save(doc, doc.content).catch((error) => error);
    expect(refused.code).toBe("read-only");
    expect(await device.files.save(doc, "x", { overwrite: true }).catch((error) => error.code)).toBe("read-only");
    expect(device.calls.write).toBe(0);
    expect(device.disk.get("/phone/Report.docx")).toBe(docx);
  });

  it("lists a folder's subfolders first, then the documents it can open", async () => {
    const device = fakeDevice();
    for (const name of ["b.md", "a.txt", "photo.jpg", "data.toml", "Report.docx", "archive/old.md", "Zed/z.md"]) device.disk.set(`/phone/notes/${name}`, utf8("x"));
    const folder = device.grant("folder", "/phone/notes");
    expect((await device.files.list(folder.id, null)).map((item) => item.name)).toEqual(["archive", "Zed", "a.txt", "b.md", "data.toml", "Report.docx"]);
    expect((await device.files.list(folder.id, "archive")).map((item) => item.id)).toEqual(["archive/old.md"]);
    expect(isOpenableName("clip.mov")).toBe(false);
  });

  it("carries bytes across the bridge unchanged, large files included", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("the pickers and files from other apps", () => {
  it("returns nothing when the person backs out of the picker", async () => {
    const device = fakeDevice();
    expect(await device.files.pickDocument()).toBeNull();
    device.pickNext("/phone/notes");
    expect(await device.files.pickFolder()).toMatchObject({ kind: "folder", name: "notes" });
  });

  it("edits in place a file the other app lets it change, and only names one it doesn't", async () => {
    const device = fakeDevice();
    device.disk.set("/in-place/Plan.md", utf8("one\n"));
    const adopted = await device.files.adopt("file:///in-place/Plan.md");
    const doc = await device.files.open({ grantId: adopted.grant!.id, entry: null });
    await device.files.save(doc, "two\n");
    expect(device.text("/in-place/Plan.md")).toBe("two\n");
    expect(await device.files.adopt("content://gmail/attachment/1")).toEqual({ grant: null, name: "From Gmail.md" });
  });
});

// ── The editor on a local file ──────────────────────────────────────────────

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let page: HTMLElement | null = null;
async function mount(element: ReturnType<typeof createElement>) {
  page = document.createElement("div");
  document.body.appendChild(page);
  root = createRoot(page);
  await act(async () => { root!.render(element); });
  return page;
}
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
afterEach(() => {
  act(() => root?.unmount());
  page?.remove();
  root = null; page = null;
});

function type(box: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(box, value); box.dispatchEvent(new Event("input", { bubbles: true })); });
}
const button = (host: ParentNode, label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined;

/** The editor on a text file from the pretend device, with a client that fails the test if anything calls it. */
async function openEditor(device: ReturnType<typeof fakeDevice>, ref: { grantId: string; entry: string | null; parent?: string | null }) {
  const { EditorScreen } = await import("../src/screens/editor");
  const doc = await device.files.open(ref);
  const saved = vi.fn();
  const gone = vi.fn();
  // Every method of the client throws: a local file must never reach for it.
  const api = new Proxy({ origin: "https://api.markiedocs.com" }, {
    get(target, key) {
      if (key in target) return (target as Record<string | symbol, unknown>)[key];
      if (typeof key === "symbol" || key === "then") return undefined;
      return () => { throw new Error(`a local file called the server: ${String(key)}`); };
    },
  });
  const host = await mount(createElement(EditorScreen, {
    api: api as never,
    draft: { kind: "local", name: doc.name, format: doc.format, content: doc.content },
    me: { id: "", name: "", email: "" },
    local: localEditing(device.files, doc, { saved, gone }),
    onCancel: () => {}, onSaved: () => { throw new Error("a local save was reported as a cloud save"); }, onUnauthorized: () => {}, backGuard: { current: null },
  }));
  await settle();
  return { host, saved, gone, box: host.querySelector("textarea") as HTMLTextAreaElement };
}

describe("the editor on a file from this phone", () => {
  it("saves back to the file and calls no server", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/list.txt", utf8("milk\n"));
    const { host, saved, box } = await openEditor(device, { grantId: device.grant("file", "/phone/list.txt").id, entry: null });
    type(box, "milk\neggs\n");
    await act(async () => { button(host, "Save")!.click(); });
    await settle();
    expect(device.text("/phone/list.txt")).toBe("milk\neggs\n");
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0][0].content).toBe("milk\neggs\n");
  });

  it("keeps the text on screen when the write fails", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/list.txt", utf8("milk\n"));
    const { host, saved, box } = await openEditor(device, { grantId: device.grant("file", "/phone/list.txt").id, entry: null });
    type(box, "milk\neggs\n");
    device.failWrites("failed");
    await act(async () => { button(host, "Save")!.click(); });
    await settle();
    expect(host.querySelector(".m-editor-error")?.textContent).toBe("The disk is full.");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("milk\neggs\n");
    expect(saved).not.toHaveBeenCalled();
    expect(device.text("/phone/list.txt")).toBe("milk\n");
    // Saving again works once the device does.
    device.failWrites(null);
    await act(async () => { button(host, "Save")!.click(); });
    await settle();
    expect(device.text("/phone/list.txt")).toBe("milk\neggs\n");
  });

  it("asks instead of writing over a file that changed underneath, and each choice does what it says", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/notes/list.txt", utf8("milk\n"));
    const folder = device.grant("folder", "/phone/notes");
    const { host, saved, box } = await openEditor(device, { grantId: folder.id, entry: "list.txt", parent: null });
    type(box, "milk\neggs\n");
    device.disk.set("/phone/notes/list.txt", utf8("milk\nbread\n"));
    await act(async () => { button(host, "Save")!.click(); });
    await settle();

    // Nothing was written, the text is still there, and the sheet states the cost.
    expect(device.text("/phone/notes/list.txt")).toBe("milk\nbread\n");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("milk\neggs\n");
    const sheet = host.querySelector('[role="dialog"]')!;
    expect(sheet.querySelector("[data-conflict-summary]")?.textContent).toContain("Your version has 1 line the file doesn't, and the file has 1 line yours doesn't.");
    expect([...sheet.querySelectorAll("[data-conflict-choice]")].map((item) => item.getAttribute("data-conflict-choice"))).toEqual(["keep-both", "keep-mine", "take-file"]);

    // Keep both: their text becomes a second file; the first is left as the other app wrote it.
    await act(async () => { (sheet.querySelector('[data-conflict-choice="keep-both"]') as HTMLButtonElement).click(); });
    await settle();
    expect(device.text("/phone/notes/list (my version).txt")).toBe("milk\neggs\n");
    expect(device.text("/phone/notes/list.txt")).toBe("milk\nbread\n");
    await act(async () => { button(host.querySelector('[role="dialog"]')!, "OK")!.click(); });
    await settle();
    expect(saved.mock.calls[0][0].content).toBe("milk\nbread\n");
  });

  it("offers a lone file no second copy, and Keep mine writes over it", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/list.txt", utf8("milk\n"));
    const { host, saved, box } = await openEditor(device, { grantId: device.grant("file", "/phone/list.txt").id, entry: null });
    type(box, "milk\neggs\n");
    device.disk.set("/phone/list.txt", utf8("milk\nbread\n"));
    await act(async () => { button(host, "Save")!.click(); });
    await settle();
    const sheet = host.querySelector('[role="dialog"]')!;
    expect(sheet.querySelector('[data-conflict-choice="keep-both"]')).toBeNull();
    await act(async () => { (sheet.querySelector('[data-conflict-choice="keep-mine"]') as HTMLButtonElement).click(); });
    await settle();
    expect(device.text("/phone/list.txt")).toBe("milk\neggs\n");
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("says a deleted file is gone and still holds the text", async () => {
    const device = fakeDevice();
    device.disk.set("/phone/list.txt", utf8("milk\n"));
    const { host, box } = await openEditor(device, { grantId: device.grant("file", "/phone/list.txt").id, entry: null });
    type(box, "milk\neggs\n");
    device.disk.delete("/phone/list.txt");
    await act(async () => { button(host, "Save")!.click(); });
    await settle();
    expect(host.querySelector("[data-local-conflict]")?.getAttribute("data-local-conflict")).toBe("gone");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("milk\neggs\n");
    expect(device.disk.has("/phone/list.txt")).toBe(false);
  });
});
