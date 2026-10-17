import { compileDarkmownOffThread } from "./compiler-worker-client";
import { DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE, DARKMOWN_RUNTIME_SOURCE } from "./runtime";
import runtimePolicy from "../../../electron/darkmown-runtime-policy.json";
import { sanitizeDarkmownBody } from "./security";

const STYLE = `:root{font:16px/1.7 system-ui,sans-serif;color:light-dark(#27272a,#e4e4e7);background:light-dark(#fff,#18181b)}*{box-sizing:border-box}body{margin:0;padding:32px;overflow-wrap:anywhere}main{max-width:760px;margin:auto}h1,h2,h3{line-height:1.25;letter-spacing:-.02em}button,input,select,textarea{font:inherit;color:inherit;background:light-dark(#fafafa,#27272a);border:1px solid light-dark(#d4d4d8,#52525b);border-radius:6px;padding:6px 10px}button{cursor:pointer}button:disabled,input:disabled,select:disabled,textarea:disabled{cursor:default;opacity:.6}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #8b5cf6;outline-offset:3px}pre,blockquote{padding:12px;background:light-dark(#f4f4f5,#27272a);border-radius:6px}pre{overflow:auto}table{border-collapse:collapse}td,th{border:1px solid light-dark(#d4d4d8,#52525b);padding:6px 10px}input[type=range]{padding:0;vertical-align:middle}hr{border:0;border-top:1px solid light-dark(#d4d4d8,#52525b)}`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Only pinned interpreter/appearance adapter execute. No authored JS or host capability bridge. */
export async function compileDarkmownPreview(source: string, trusted: boolean, options: { signal?: AbortSignal; colorScheme?: "light" | "dark" } = {}): Promise<{ srcDoc: string; warnings: string[] }> {
  if (source.length > 200_000) throw new Error("Darkmown preview is limited to 200,000 characters");
  const compiled = await compileDarkmownOffThread(source, options);
  if (options.signal?.aborted) throw new DOMException("Interactive preview canceled", "AbortError");
  const clean = await sanitizeDarkmownBody(compiled.bodyHtml, trusted);
  if (options.signal?.aborted) throw new DOMException("Interactive preview canceled", "AbortError");
  if ([DARKMOWN_RUNTIME_SOURCE, DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE].some((script) => /<\/script/i.test(script))) throw new Error("The bundled Darkmown runtime cannot be embedded safely");
  const csp = ["default-src 'none'", `script-src ${trusted ? `'sha256-${runtimePolicy.runtimeSha256}' 'sha256-${runtimePolicy.bootstrapSha256}'` : "'none'"}`, "script-src-attr 'none'", "style-src 'unsafe-inline'", "img-src 'none'", "media-src 'none'", "font-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"].join("; ");
  const seeds = trusted ? clean.seeds.map((seed) => `<script type="application/json" data-wd-state>${seed}</script>`).join("") : "";
  const runtime = trusted ? `<script>${DARKMOWN_RUNTIME_SOURCE}</script><script>${DARKMOWN_LOCAL_FORM_BOOTSTRAP_SOURCE}</script>` : "";
  const colorScheme = options.colorScheme === "dark" ? "dark" : "light";
  return {
    srcDoc: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="referrer" content="no-referrer"><title>${escapeHtml(compiled.title)}</title><style>:root{color-scheme:${colorScheme}}${STYLE}</style></head><body>${clean.bodyHtml}${seeds}${runtime}</body></html>`,
    warnings: [...compiled.warnings, ...clean.warnings],
  };
}
