// Touch ID unlock for the local vault, from the main process.
//
// The vault's passphrase stays its master key. Turning on Touch ID gives the
// renderer a second key slot: the vault key encrypted under a random 32-byte
// device secret. That secret lives here, encrypted with safeStorage (Keychain
// on macOS) in one file per vault under userData, and goes back to the
// renderer only after systemPreferences.promptTouchID succeeds. The renderer
// decrypts its slot with it and zeroes it. Nothing here ever sees the vault
// key, a passphrase, or a document.
//
// Electron-free and dependency-injected, like secret-clipboard.js, so the
// rules can be tested with fakes.
const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");

const SECRET_BYTES = 32;
const MAX_FILE_BYTES = 4096;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ENROLL_REASON = "turn on Touch ID for your vault";
const UNLOCK_REASON = "unlock your vault";
const REVEAL_ACTIONS = new Set(["open", "reveal", "copy"]);
const MAX_LABEL = 60;

/**
 * The Touch ID sheet reads "Markie is trying to <reason>." The renderer only
 * names the item; the verb comes from a fixed list and the name is flattened
 * to one short printable line, so a crafted filename cannot reword the sheet.
 */
function revealReason(action, label) {
  if (!REVEAL_ACTIONS.has(action) || typeof label !== "string") return null;
  const flat = label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"“”]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  const name = chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL - 1).join("")}…` : flat;
  return `${action} “${name}” from your vault`;
}

/** A canonical 16-byte base64url vault ID, the only thing allowed into a file name. */
function validVaultId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value) && (BASE64URL.indexOf(value[21]) & 15) === 0;
}

/**
 * @param {{
 *   safeStorage: { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string; encryptString(text: string): Buffer; decryptString(data: Buffer): string },
 *   systemPreferences: { canPromptTouchID?(): boolean; promptTouchID?(reason: string): Promise<void> },
 *   userData: string,
 *   platform?: string,
 *   fs?: typeof import("fs"),
 * }} options
 */
function createVaultTouchId({ safeStorage, systemPreferences, userData, platform = process.platform, fs = nodeFs }) {
  const directory = nodePath.join(userData, "vault-touch-id");
  let prompting = false;

  const keychainReady = () => {
    try { return !!safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text"; }
    catch { return false; }
  };
  const canPrompt = () => {
    try {
      return platform === "darwin" && typeof systemPreferences?.promptTouchID === "function"
        && typeof systemPreferences.canPromptTouchID === "function" && systemPreferences.canPromptTouchID() === true;
    } catch { return false; }
  };
  const available = () => canPrompt() && keychainReady();
  const fileFor = (vaultId) => nodePath.join(directory, `${vaultId}.bin`);
  const hasFile = (vaultId) => {
    try {
      const stat = fs.lstatSync(fileFor(vaultId));
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_FILE_BYTES;
    } catch { return false; }
  };

  /** One prompt at a time; a second request while the sheet is up is refused, not queued. */
  const prompt = async (reason) => {
    if (prompting) return "busy";
    prompting = true;
    try {
      // Checked again right before prompting: the sensor can be disabled or the lid closed.
      if (!canPrompt()) return "unavailable";
      await systemPreferences.promptTouchID(reason);
      return "ok";
    } catch { return "cancelled"; }
    finally { prompting = false; }
  };

  // Answers without touching safeStorage. Its first use reads, or creates, the
  // app's Keychain item, which can raise a macOS password sheet that blocks the
  // main process. Opening the vault must never do that; only turning Touch ID
  // on, or using it, may.
  const status = (vaultId) => {
    const ready = canPrompt();
    return { available: ready, enrolled: ready && validVaultId(vaultId) && hasFile(vaultId) };
  };

  const enroll = async (vaultId, secret) => {
    if (!validVaultId(vaultId) || !(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) return { ok: false, reason: "unavailable" };
    const copy = Buffer.from(secret);
    try {
      if (!available()) return { ok: false, reason: "unavailable" };
      const outcome = await prompt(ENROLL_REASON);
      if (outcome !== "ok") return { ok: false, reason: outcome };
      // safeStorage only takes strings. This base64 copy cannot be zeroed; it is short-lived.
      const encrypted = safeStorage.encryptString(copy.toString("base64"));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = fileFor(vaultId);
      const temporary = `${target}.${nodeCrypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); }
      finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
      return { ok: true };
    } finally { copy.fill(0); }
  };

  const unlock = async (vaultId) => {
    if (!validVaultId(vaultId)) return { ok: false, reason: "missing" };
    if (!available()) return { ok: false, reason: "unavailable" };
    // No prompt for a secret that is not there: the renderer falls straight back to the passphrase.
    if (!hasFile(vaultId)) return { ok: false, reason: "missing" };
    const outcome = await prompt(UNLOCK_REASON);
    if (outcome !== "ok") return { ok: false, reason: outcome };
    let decoded;
    try {
      const encoded = safeStorage.decryptString(fs.readFileSync(fileFor(vaultId)));
      if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return { ok: false, reason: "missing" };
      decoded = Buffer.from(encoded, "base64");
      if (decoded.length !== SECRET_BYTES) return { ok: false, reason: "missing" };
      return { ok: true, secret: new Uint8Array(decoded) };
    } catch { return { ok: false, reason: "missing" }; }
    finally { decoded?.fill(0); }
  };

  /**
   * A fresh Touch ID check before one item is opened, revealed or copied. Only
   * for a vault with Touch ID turned on, so the renderer cannot use it to put
   * arbitrary sheets on screen. Never touches safeStorage and releases nothing.
   */
  const confirm = async (vaultId, action, label) => {
    const reason = revealReason(action, label);
    if (!validVaultId(vaultId) || !reason || !canPrompt()) return { ok: false, reason: "unavailable" };
    if (!hasFile(vaultId)) return { ok: false, reason: "missing" };
    const outcome = await prompt(reason);
    return outcome === "ok" ? { ok: true } : { ok: false, reason: outcome };
  };

  const remove = (vaultId) => {
    if (!validVaultId(vaultId)) return { ok: false };
    try { fs.unlinkSync(fileFor(vaultId)); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { ok: true };
  };

  return { status, enroll, unlock, confirm, remove };
}

module.exports = { createVaultTouchId, validVaultId, revealReason, SECRET_BYTES, ENROLL_REASON, UNLOCK_REASON };
