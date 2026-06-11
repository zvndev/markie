// Cloud half of theming: the preset store follows the account across
// devices, and doc owners can pin their theme to a shared doc.
import { getAuthToken, getServerURL } from "@/lib/auth-client";
import { loadThemeStore, saveThemeStore, type ThemeTokens } from "@/lib/theme";

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
