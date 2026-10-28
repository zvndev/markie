import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENROLL_REASON, UNLOCK_REASON, createVaultTouchId, revealReason, validVaultId } from "./vault-touch-id.js";

const VAULT = "AAECAwQFBgcICQoLDA0ODw"; // 16 bytes, canonical base64url
const OTHER = "EBESExQVFhcYGRobHB0eHw";
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A reversible stand-in for Keychain-backed safeStorage that never writes the plaintext. */
function fakeSafeStorage({ ready = true, backend = "keychain" } = {}) {
  return {
    isEncryptionAvailable: vi.fn(() => ready),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((text: string) => Buffer.from(`sealed:${Buffer.from(text).reverse().toString("hex")}`)),
    decryptString: vi.fn((data: Buffer) => {
      const value = data.toString();
      if (!value.startsWith("sealed:")) throw new Error("bad");
      return Buffer.from(value.slice(7), "hex").reverse().toString();
    }),
  };
}

function fakeTouchId({ can = true, outcome = "ok" as "ok" | "cancel" } = {}) {
  const state = { can, outcome };
  return {
    state,
    canPromptTouchID: vi.fn(() => state.can),
    promptTouchID: vi.fn(async () => { if (state.outcome === "cancel") throw new Error("User cancelled"); }),
  };
}

function setup(options: { platform?: string; safe?: ReturnType<typeof fakeSafeStorage>; touch?: ReturnType<typeof fakeTouchId> } = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), "markie-touch-id-"));
  dirs.push(userData);
  const safeStorage = options.safe ?? fakeSafeStorage();
  const systemPreferences = options.touch ?? fakeTouchId();
  const touchId = createVaultTouchId({ safeStorage, systemPreferences, userData, platform: options.platform ?? "darwin" });
  return { touchId, safeStorage, systemPreferences, userData, folder: path.join(userData, "vault-touch-id") };
}

const secret = () => Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe("vault Touch ID keychain (main process)", () => {
  it("enrolls behind a Touch ID prompt and releases the same secret only after another prompt", async () => {
    const { touchId, systemPreferences, folder } = setup();
    expect(touchId.status(VAULT)).toEqual({ available: true, enrolled: false });
    const handed = secret();
    expect(await touchId.enroll(VAULT, handed)).toEqual({ ok: true });
    expect(systemPreferences.promptTouchID).toHaveBeenLastCalledWith(ENROLL_REASON);
    expect(handed).toEqual(secret()); // The renderer zeroes its own copy, not main.
    expect(touchId.status(VAULT)).toEqual({ available: true, enrolled: true });
    const file = path.join(folder, `${VAULT}.bin`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).toString()).not.toContain(Buffer.from(secret()).toString("base64"));
    expect(readdirSync(folder)).toEqual([`${VAULT}.bin`]);
    const released = await touchId.unlock(VAULT);
    expect(systemPreferences.promptTouchID).toHaveBeenLastCalledWith(UNLOCK_REASON);
    expect(released).toEqual({ ok: true, secret: secret() });
    expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(2);
  });

  it("releases nothing when Touch ID is cancelled", async () => {
    const touch = fakeTouchId();
    const { touchId, safeStorage } = setup({ touch });
    await touchId.enroll(VAULT, secret());
    touch.state.outcome = "cancel";
    expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "cancelled" });
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
    expect(await touchId.enroll(OTHER, secret())).toEqual({ ok: false, reason: "cancelled" });
    expect(touchId.status(OTHER).enrolled).toBe(false);
  });

  it("does not prompt for a vault with no keychain secret", async () => {
    const { touchId, systemPreferences } = setup();
    expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "missing" });
    expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
  });

  it("keeps one file per vault and remove deletes only that one", async () => {
    const { touchId, folder } = setup();
    await touchId.enroll(VAULT, secret());
    await touchId.enroll(OTHER, Uint8Array.from({ length: 32 }, () => 9));
    expect(readdirSync(folder).sort()).toEqual([`${OTHER}.bin`, `${VAULT}.bin`].sort());
    expect(touchId.remove(VAULT)).toEqual({ ok: true });
    expect(touchId.remove(VAULT)).toEqual({ ok: true });
    expect(readdirSync(folder)).toEqual([`${OTHER}.bin`]);
    expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "missing" });
    expect(await touchId.unlock(OTHER)).toEqual({ ok: true, secret: Uint8Array.from({ length: 32 }, () => 9) });
  });

  it("is unavailable off macOS or without a sensor", async () => {
    for (const options of [{ platform: "win32" }, { touch: fakeTouchId({ can: false }) }]) {
      const { touchId, systemPreferences } = setup(options);
      expect(touchId.status(VAULT)).toEqual({ available: false, enrolled: false });
      expect(await touchId.enroll(VAULT, secret())).toEqual({ ok: false, reason: "unavailable" });
      expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "unavailable" });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    }
  });

  // A Linux desktop with no keyring daemon is the case that matters here:
  // Electron falls back to basic_text rather than failing, and a safeStorage
  // that throws on that path would take the vault page down with it.
  it("stays quietly unavailable on Linux, keyring or not, and never touches safeStorage", async () => {
    for (const backend of ["gnome_libsecret", "basic_text"]) {
      const safe = fakeSafeStorage({ backend });
      safe.isEncryptionAvailable.mockImplementation(() => { throw new Error("no keyring"); });
      const { touchId, systemPreferences } = setup({ platform: "linux", safe });
      expect(touchId.status(VAULT)).toEqual({ available: false, enrolled: false });
      expect(await touchId.enroll(VAULT, secret())).toEqual({ ok: false, reason: "unavailable" });
      expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "unavailable" });
      expect(safe.encryptString).not.toHaveBeenCalled();
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    }
  });

  it("refuses to enroll or unlock without a real keychain, and never prompts for one", async () => {
    for (const safe of [fakeSafeStorage({ ready: false }), fakeSafeStorage({ backend: "basic_text" })]) {
      const { touchId, systemPreferences } = setup({ safe });
      expect(await touchId.enroll(VAULT, secret())).toEqual({ ok: false, reason: "unavailable" });
      expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "unavailable" });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    }
  });

  // safeStorage's first use can raise a macOS keychain password sheet that
  // blocks the main process; merely opening the vault page must not.
  it("answers status without touching the keychain", () => {
    const safe = fakeSafeStorage();
    const { touchId } = setup({ safe });
    expect(touchId.status(VAULT)).toEqual({ available: true, enrolled: false });
    expect(safe.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safe.getSelectedStorageBackend).not.toHaveBeenCalled();
    expect(safe.decryptString).not.toHaveBeenCalled();
  });

  it("rejects path-like vault IDs and malformed secrets before touching disk", async () => {
    const { touchId, systemPreferences, userData } = setup();
    for (const id of ["../../etc/passwd", "AAECAwQFBgcICQoLDA0OD", "AAECAwQFBgcICQoLDA0ODx", "", 42, null]) {
      expect(validVaultId(id)).toBe(false);
      expect(await touchId.enroll(id as string, secret())).toEqual({ ok: false, reason: "unavailable" });
      expect(await touchId.unlock(id as string)).toEqual({ ok: false, reason: "missing" });
      expect(touchId.remove(id as string)).toEqual({ ok: false });
    }
    for (const bad of [new Uint8Array(16), new Uint8Array(33), "x".repeat(32), [1, 2, 3]]) {
      expect(await touchId.enroll(VAULT, bad as Uint8Array)).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    expect(readdirSync(userData)).toEqual([]);
  });

  it("treats a corrupt, foreign or symlinked keychain file as missing", async () => {
    const { touchId, folder } = setup();
    await touchId.enroll(VAULT, secret());
    const file = path.join(folder, `${VAULT}.bin`);
    writeFileSync(file, "not sealed");
    expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "missing" });
    rmSync(file);
    const elsewhere = path.join(folder, "elsewhere");
    writeFileSync(elsewhere, "sealed:00");
    symlinkSync(elsewhere, file);
    expect(touchId.status(VAULT).enrolled).toBe(false);
    expect(await touchId.unlock(VAULT)).toEqual({ ok: false, reason: "missing" });
  });

  it("asks a fresh Touch ID per item reveal, naming it, without touching the keychain", async () => {
    const touch = fakeTouchId();
    const safe = fakeSafeStorage();
    const { touchId, systemPreferences } = setup({ touch, safe });
    // Not turned on for this vault: no sheet at all.
    expect(await touchId.confirm(VAULT, "reveal", "API_KEY in prod.env")).toEqual({ ok: false, reason: "missing" });
    expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    await touchId.enroll(VAULT, secret());
    safe.decryptString.mockClear();
    safe.isEncryptionAvailable.mockClear();
    expect(await touchId.confirm(VAULT, "reveal", "API_KEY in prod.env")).toEqual({ ok: true });
    expect(systemPreferences.promptTouchID).toHaveBeenLastCalledWith("reveal “API_KEY in prod.env” from your vault");
    expect(await touchId.confirm(VAULT, "copy", "API_KEY in prod.env")).toEqual({ ok: true });
    expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(3);
    touch.state.outcome = "cancel";
    expect(await touchId.confirm(VAULT, "open", "notes.txt")).toEqual({ ok: false, reason: "cancelled" });
    expect(safe.decryptString).not.toHaveBeenCalled();
    expect(safe.isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it("builds the reveal sheet text from a fixed verb and a flattened, short name", async () => {
    expect(revealReason("open", "notes.txt")).toBe("open “notes.txt” from your vault");
    expect(revealReason("delete", "notes.txt")).toBeNull();
    expect(revealReason("open", "  \n‮ ")).toBeNull();
    expect(revealReason("open", 42)).toBeNull();
    expect(revealReason("copy", "a”. Enter your password\n\"x")).toBe("copy “a . Enter your password x” from your vault");
    const long = revealReason("reveal", "k".repeat(200))!;
    expect(long).toBe(`reveal “${"k".repeat(59)}…” from your vault`);
    const { touchId, systemPreferences } = setup();
    await touchId.enroll(VAULT, secret());
    expect(await touchId.confirm(VAULT, "unlock", "x")).toEqual({ ok: false, reason: "unavailable" });
    expect(await touchId.confirm("../x", "open", "x")).toEqual({ ok: false, reason: "unavailable" });
    expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(1);
  });

  it("never prompts per item off macOS or without a sensor", async () => {
    for (const options of [{ platform: "win32" }, { platform: "linux" }, { touch: fakeTouchId({ can: false }) }]) {
      const { touchId, systemPreferences } = setup(options);
      expect(await touchId.confirm(VAULT, "reveal", "API_KEY")).toEqual({ ok: false, reason: "unavailable" });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    }
  });

  it("refuses a second prompt while one is on screen", async () => {
    const touch = fakeTouchId();
    let finish!: () => void;
    touch.promptTouchID.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { touchId } = setup({ touch });
    const first = touchId.enroll(VAULT, secret());
    expect(await touchId.enroll(VAULT, secret())).toEqual({ ok: false, reason: "busy" });
    finish();
    expect(await first).toEqual({ ok: true });
  });
});
