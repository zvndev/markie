// Cloud half of theming: the preset store follows the account across
// devices, and doc owners can pin their theme to a shared doc.
import { getAuthToken, getServerURL } from "@/lib/auth-client";
import { loadThemeStore, saveThemeStore, type ThemeTokens } from "@/lib/theme";
import { sanitizeMarkdownStyle, type MarkdownStyle } from "@/lib/markdown-style-schema";

async function call<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T | null> {
  try {
    const token = getAuthToken();
    if (!token) return null;
    const res = await fetch(`${getServerURL()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type CloudStore = ReturnType<typeof loadThemeStore>;

// Pull the account's preset store. Returns the store when the cloud has
// one (also persisted locally), false when signed in with nothing stored
// yet, null when signed out / unreachable.
export async function pullCloudThemes(): Promise<CloudStore | false | null> {
  const res = await call<{ store: CloudStore | null }>("GET", "/api/me/themes");
  if (!res) return null;
  if (!res.store) return false;
  saveThemeStore(res.store);
  return res.store;
}

export function pushCloudThemes(): void {
  void call("PUT", "/api/me/themes", { store: loadThemeStore() });
}

export async function getDocTheme(docId: string): Promise<ThemeTokens | null> {
  const res = await call<{ tokens: ThemeTokens | null }>(
    "GET",
    `/api/docs/${encodeURIComponent(docId)}/theme`
  );
  return res?.tokens ?? null;
}

export async function setDocTheme(
  docId: string,
  tokens: ThemeTokens | null
): Promise<boolean> {
  const res = await call<{ ok: boolean }>(
    "PUT",
    `/api/docs/${encodeURIComponent(docId)}/theme`,
    { tokens }
  );
  return !!res?.ok;
}

/**
 * The look an owner pinned to a document: the theme tokens, and the Markdown
 * style beside them. `style` is null for a pin made before styles existed,
 * which reads as Spacious.
 */
export interface DocLook {
  tokens: ThemeTokens;
  style: MarkdownStyle | null;
}

/** The pinned look, or null when nothing is pinned. The style is cleaned here, whatever the server sent. */
export async function getDocLook(docId: string): Promise<DocLook | null> {
  const res = await call<{ tokens: ThemeTokens | null; style?: unknown }>(
    "GET",
    `/api/docs/${encodeURIComponent(docId)}/theme`
  );
  if (!res?.tokens) return null;
  return { tokens: res.tokens, style: sanitizeMarkdownStyle(res.style) };
}

/** Pin a look to a document, or unpin with null. */
export async function setDocLook(docId: string, look: DocLook | null): Promise<boolean> {
  const res = await call<{ ok: boolean }>(
    "PUT",
    `/api/docs/${encodeURIComponent(docId)}/theme`,
    look ? { tokens: look.tokens, style: look.style } : { tokens: null, style: null }
  );
  return !!res?.ok;
}

/**
 * Whether a look is pinned, for the owner's Share dialog. "unknown" when the
 * server could not be asked, so the dialog never shows a wrong switch.
 */
export async function docLookState(docId: string): Promise<{ pinned: boolean; look: DocLook | null } | "unknown"> {
  const res = await call<{ tokens: ThemeTokens | null; style?: unknown }>(
    "GET",
    `/api/docs/${encodeURIComponent(docId)}/theme`
  );
  if (!res) return "unknown";
  return res.tokens ? { pinned: true, look: { tokens: res.tokens, style: sanitizeMarkdownStyle(res.style) } } : { pinned: false, look: null };
}
