import { useState } from "react";
import type { TextNewline } from "@/lib/document-formats";
import {
  addDotenvEntry,
  duplicateDotenvKeys,
  isValidDotenvKey,
  parseDotenv,
  removeDotenvLine,
  serializeDotenv,
  updateDotenvEntry,
  type DotenvDocument,
  type DotenvEntryLine,
} from "@/lib/vault/dotenv";

export interface VaultEnvEditorProps {
  /** The decrypted dotenv text. It is the single source of truth; the table is derived from it. */
  text: string;
  /** Line ending style of the decrypted source, used to keep typed raw text in the file's style. */
  newline: TextNewline;
  disabled?: boolean;
  onChange: (text: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

export const CLIPBOARD_CLEAR_MS = 30_000;

const button = "rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-40";
const quietButton = "rounded-md px-2 py-1 text-xs text-muted hover:bg-accent hover:text-foreground disabled:opacity-40";
const field = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[13px] text-foreground";
const MASK = "••••••••••••";

/** Browser text controls report bare LF; restore the source's own line ending. */
export function normalizeTypedNewlines(value: string, newline: TextNewline): string {
  if (newline === "crlf") return value.replace(/\r\n|\r|\n/g, "\r\n");
  if (newline === "cr") return value.replace(/\r\n|\r|\n/g, "\r");
  return value;
}

async function fingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  try {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally { bytes.fill(0); }
}

async function clearClipboardIfUnchanged(expected: string) {
  try {
    if (!navigator.clipboard?.readText) return;
    const current = await navigator.clipboard.readText();
    if (current && await fingerprint(current) === expected) await navigator.clipboard.writeText("");
  } catch { /* Without read permission or focus, leave the clipboard alone rather than guess. */ }
}

/**
 * Copies plaintext out of the vault. The delayed clear compares a SHA-256
 * fingerprint, so the secret itself is not retained after the vault locks.
 */
async function copyOutsideVault(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
  await navigator.clipboard.writeText(text);
  void fingerprint(text).then((expected) => { setTimeout(() => void clearClipboardIfUnchanged(expected), CLIPBOARD_CLEAR_MS); }, () => undefined);
}

const COPY_NOTE = "It is now on the clipboard, outside the vault. Markie clears it after 30 seconds if it is still there.";

export function KeyIcon() {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2" /></svg>;
}

function keyProblem(line: DotenvEntryLine, duplicates: Set<string>): string | null {
  if (line.key === "") return "Add a key name.";
  if (!isValidDotenvKey(line.key)) return "Start with a letter or underscore, then use letters, numbers, underscores or dots.";
  if (duplicates.has(line.key)) return `${line.key} is set more than once. Most loaders use the last one.`;
  return null;
}

/** `# OLD_TOKEN=abc` is a common way to park a secret, so its value is masked like a live one. */
function parkedKey(comment: string): string | null {
  const parked = parseDotenv(comment.replace(/^[ \t]*#[ \t]*/, ""));
  const line = parked.lines[0];
  return parked.lines.length === 1 && line.kind === "entry" && line.value !== "" ? line.key : null;
}

/** Structured editor for a decrypted .env file. Rendered only inside the vault panel. */
export function VaultEnvEditor({ text, newline, disabled = false, onChange, onNotice, onError }: VaultEnvEditorProps) {
  const [model, setModel] = useState<{ text: string; parsed: DotenvDocument }>(() => ({ text, parsed: parseDotenv(text) }));
  const [raw, setRaw] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [focusId, setFocusId] = useState<number | null>(null);

  // Keep row identity across structured edits; any outside change re-parses and masks everything again.
  let parsed = model.parsed;
  if (model.text !== text) {
    parsed = parseDotenv(text);
    setModel({ text, parsed });
    setRevealed(new Set());
  }

  const duplicates = duplicateDotenvKeys(parsed);
  const parked = new Map<number, string>();
  for (const line of parsed.lines) {
    const key = line.kind === "comment" ? parkedKey(line.raw) : null;
    if (key !== null) parked.set(line.id, key);
  }
  const maskable = parsed.lines.filter((line) => line.kind === "entry" || line.kind === "malformed" || parked.has(line.id));
  const keyCount = parsed.lines.filter((line) => line.kind === "entry").length;
  const allRevealed = maskable.length > 0 && maskable.every((line) => revealed.has(line.id));

  function commit(next: DotenvDocument) {
    const nextText = serializeDotenv(next);
    setModel({ text: nextText, parsed: next });
    onChange(nextText);
  }

  function toggle(id: number) {
    setRevealed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function copy(value: string, message: string) {
    try {
      await copyOutsideVault(value);
      onNotice(`${message} ${COPY_NOTE}`);
    } catch {
      onError("Clipboard access is unavailable. Nothing was copied.");
    }
  }

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Environment view" className="inline-flex rounded-md border border-border p-0.5">
        <button type="button" aria-pressed={!raw} className={`rounded px-2.5 py-1 text-xs ${raw ? "text-muted hover:text-foreground" : "bg-accent text-foreground"}`} onClick={() => setRaw(false)}>Keys</button>
        <button type="button" aria-pressed={raw} className={`rounded px-2.5 py-1 text-xs ${raw ? "bg-accent text-foreground" : "text-muted hover:text-foreground"}`} onClick={() => setRaw(true)}>Raw</button>
      </div>
      <span className="text-xs text-muted">{keyCount === 1 ? "1 key" : `${keyCount} keys`}</span>
      <span className="flex-1" />
      {!raw && <button type="button" className={button} disabled={maskable.length === 0} aria-pressed={allRevealed}
        onClick={() => setRevealed(allRevealed ? new Set() : new Set(maskable.map((line) => line.id)))}>{allRevealed ? "Hide all" : "Reveal all"}</button>}
      <button type="button" className={button} disabled={disabled || text === ""} onClick={() => void copy(text, "Copied the whole file as .env text.")}>Copy as .env</button>
    </div>

    {raw ? <>
      <textarea aria-label="Environment file text" spellCheck={false} autoComplete="off" className={`${field} min-h-80`} value={text} disabled={disabled}
        readOnly={newline === "mixed"} onChange={(event) => onChange(normalizeTypedNewlines(event.target.value, newline))} />
      {newline === "mixed" && <p className="text-xs text-muted">Mixed line endings are preserved read-only here. Switch to Keys to edit values.</p>}
    </> : <>
      {parsed.lines.length === 0 && <p className="text-sm text-muted py-4">No keys yet. Add one, or paste a .env file into Raw.</p>}
      {parsed.lines.length > 0 && <table className="w-full table-fixed border-separate border-spacing-y-1 text-sm">
        <thead><tr className="text-left text-xs text-muted">
          <th scope="col" className="w-[36%] px-1 font-normal">Key</th>
          <th scope="col" className="px-1 font-normal">Value</th>
          <th scope="col" className="w-[7.5rem] px-1 font-normal"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>{parsed.lines.map((line, index) => {
          const row = index + 1;
          if (line.kind === "blank") return null;
          const shown = revealed.has(line.id);
          if (line.kind === "comment") {
            const key = parked.get(line.id);
            return <tr key={line.id}>
              <td colSpan={key === undefined ? 3 : 2} className="px-1 pt-2 font-mono text-xs italic text-muted break-all">{key === undefined || shown ? line.raw.trim() : `# ${key}=${MASK}`}</td>
              {key !== undefined && <td className="px-1 pt-1"><button type="button" className={quietButton} aria-label={`${shown ? "Hide" : "Reveal"} commented ${key}`} aria-pressed={shown} onClick={() => toggle(line.id)}>{shown ? "Hide" : "Show"}</button></td>}
            </tr>;
          }
          if (line.kind === "malformed") return <tr key={line.id} className="align-top">
            <td colSpan={2} className="px-1">
              <code aria-label={`Unreadable line ${row}`} className="block rounded-md border border-dashed border-border px-2.5 py-1.5 font-mono text-[13px] text-muted break-all whitespace-pre-wrap">{shown ? line.raw : MASK}</code>
              <p className="mt-1 text-xs text-muted">{line.reason} Kept exactly as written. Edit it in Raw.</p>
            </td>
            <td className="px-1"><button type="button" className={quietButton} aria-label={`${shown ? "Hide" : "Reveal"} line ${row}`} aria-pressed={shown} onClick={() => toggle(line.id)}>{shown ? "Hide" : "Show"}</button></td>
          </tr>;
          const name = line.key || `row ${row}`;
          const problem = keyProblem(line, duplicates);
          const multiline = /[\r\n]/.test(line.value);
          const setValue = (value: string) => commit(updateDotenvEntry(parsed, line.id, { value }));
          return <tr key={line.id} className="align-top">
            <td className="px-1">
              <div className="flex items-center gap-1.5">
                <span className="text-muted"><KeyIcon /></span>
                <input aria-label={`Key name, row ${row}`} aria-invalid={problem !== null} spellCheck={false} autoComplete="off" className={field} value={line.key} disabled={disabled}
                  ref={line.id === focusId ? (node) => { if (node) { node.focus(); setFocusId(null); } } : undefined}
                  onChange={(event) => commit(updateDotenvEntry(parsed, line.id, { key: event.target.value }))} />
              </div>
              {problem && <p className="mt-1 pl-5 text-xs text-[var(--status-red)]">{problem}</p>}
            </td>
            <td className="px-1">{multiline
              ? shown
                ? <textarea aria-label={`Value of ${name}`} spellCheck={false} autoComplete="off" rows={Math.min(8, line.value.split(/\r\n|\r|\n/).length)} className={field} value={line.value} disabled={disabled}
                  onChange={(event) => setValue(normalizeTypedNewlines(event.target.value, line.value.includes("\r\n") ? "crlf" : line.value.includes("\r") ? "cr" : "lf"))} />
                : <p aria-label={`Value of ${name}, hidden`} className={`${field} text-muted`}>{MASK} <span className="font-sans text-xs">{line.value.split(/\r\n|\r|\n/).length} lines</span></p>
              : <input aria-label={`Value of ${name}`} type={shown ? "text" : "password"} spellCheck={false} autoComplete="off" className={field} value={line.value} disabled={disabled}
                onChange={(event) => setValue(event.target.value)} />}
            </td>
            <td className="px-1 whitespace-nowrap">
              <button type="button" className={quietButton} aria-label={`${shown ? "Hide" : "Reveal"} ${name}`} aria-pressed={shown} onClick={() => toggle(line.id)}>{shown ? "Hide" : "Show"}</button>
              <button type="button" className={quietButton} aria-label={`Copy value of ${name}`} disabled={disabled} onClick={() => void copy(line.value, `Copied the value of ${name}.`)}>Copy</button>
              <button type="button" className={quietButton} aria-label={`Remove ${name}`} disabled={disabled} onClick={() => commit(removeDotenvLine(parsed, line.id))}>×</button>
            </td>
          </tr>;
        })}</tbody>
      </table>}
      <button type="button" className={button} disabled={disabled} onClick={() => {
        const next = addDotenvEntry(parsed);
        setFocusId(next.nextId - 1);
        commit(next);
      }}>Add key</button>
    </>}
  </div>;
}
