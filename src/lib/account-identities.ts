import { getAuthToken, getConfirmedAuthIdentity, getServerURL } from "./auth-client";
import { authStore } from "./auth-store";
// Keep Window.fetch's receiver; storing it as a client method changes `this`.
const browserFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export interface AccountIdentity { id: string; email: string; primary: boolean; verifiedAt: string | number | null }
export interface AccountProvider { id: string; providerId: string }
export interface CloudArea { id: string; label: string; identityId?: string | null }
export interface CloudPlacement { kind: "markdown" | "snapshot"; documentId: string; areaId: string }
export interface CloudAreas { areas: CloudArea[]; placements: CloudPlacement[] }
export interface IdentityChallenge { challengeId: string; expiresInSeconds: number }
export interface AccountScope { userId: string; serverURL: string; token: string }
export interface AliasSignInChallenge extends IdentityChallenge { flowId: string }

export function confirmedAccountScope(): AccountScope | null {
  const { user, status } = authStore.getSnapshot(); if (status !== "in" || !user) return null;
  const confirmed = getConfirmedAuthIdentity(), serverURL = getServerURL(), token = getAuthToken();
  return token && confirmed?.userId === user.id && confirmed.serverURL === serverURL ? { userId: user.id, serverURL, token } : null;
}
export const accountScopeKey = () => { const scope = confirmedAccountScope(); return scope ? JSON.stringify([scope.serverURL, scope.userId, scope.token]) : ""; };
export function subscribeAccountScope(listener: () => void) {
  const unsubscribe = authStore.subscribe(listener);
  window.addEventListener("storage", listener); window.addEventListener("markie:account-session-change", listener);
  return () => { unsubscribe(); window.removeEventListener("storage", listener); window.removeEventListener("markie:account-session-change", listener); };
}
export class AccountIdentityError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "AccountIdentityError"; }
}
const invalid = () => new AccountIdentityError(0, "invalid-response", "The server returned invalid account information.");
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function identity(value: unknown): AccountIdentity {
  if (!record(value) || !id(value.id) || typeof value.email !== "string" || value.email.length > 320 || typeof value.primary !== "boolean" || !(value.verifiedAt === null || typeof value.verifiedAt === "string" || typeof value.verifiedAt === "number")) throw invalid();
  return { id: value.id, email: value.email, primary: value.primary, verifiedAt: value.verifiedAt };
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (Number(response.headers.get("content-length")) > 65_536) throw invalid();
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 65_536) { await reader.cancel(); throw invalid(); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let result: unknown; try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!record(result)) throw invalid(); return result;
}
function failure(status: number, code: string) {
  const message = status === 404 || status === 501 ? "This server does not support linked sign-ins or cloud areas yet. Your account and documents are unchanged."
    : status === 401 ? "Sign in again to confirm this account."
      : code === "identity-not-removable" ? "The primary sign-in cannot be removed."
      : code === "identity-limit" ? "This account already has the most linked emails it can hold. Unlink one first."
      : status === 409 ? "That email already belongs to another account. Accounts were not merged."
        : /primary/i.test(code) ? "The primary sign-in cannot be removed."
          : /proof|step.?up/i.test(code) ? "Confirm your primary email again before making this change."
            : /code|otp|expired|verification/i.test(code) ? "That code is incorrect or expired. Request a new code."
              : status === 429 ? "Too many attempts. Wait before requesting another code."
                : status === 403 ? "This account is not allowed to make that change."
                  : "The account change could not be completed. Nothing was merged.";
  return new AccountIdentityError(status, code, message);
}

/** Every request is bound to the exact confirmed server, UID and bearer, including response application. */
export class AccountIdentitiesClient {
  readonly #key: string;
  readonly #scope: AccountScope;
  constructor(readonly request: typeof fetch = browserFetch) {
    const scope = confirmedAccountScope(); if (!scope) throw failure(401, "unconfirmed");
    const origin = new URL(scope.serverURL);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw failure(401, "invalid-server");
    this.#scope = scope; this.#key = accountScopeKey();
  }
  static async startAliasSignIn(email: string, request: typeof fetch = browserFetch): Promise<AliasSignInChallenge> {
    const { data } = await aliasCall("start", { email: email.trim() }, request);
    if (!id(data.challengeId) || typeof data.flowId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.flowId) || !Number.isSafeInteger(data.expiresInSeconds)) throw invalid();
    return { challengeId: data.challengeId, flowId: data.flowId, expiresInSeconds: Number(data.expiresInSeconds) };
  }
  static async verifyAliasSignIn(challengeId: string, flowId: string, code: string, request: typeof fetch = browserFetch) {
    const { data, response } = await aliasCall("verify", { challengeId, flowId, code }, request);
    const token = response.headers.get("set-auth-token") ?? data.token;
    if (typeof token !== "string" || !token) throw invalid();
    const user = record(data.user) && typeof data.user.id === "string" && typeof data.user.email === "string" && typeof data.user.name === "string" ? { id: data.user.id, email: data.user.email, name: data.user.name } : undefined;
    return { token, ...(user ? { user } : {}) };
  }
  async call(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^\/(?:identities|cloud-areas)(?:\/[A-Za-z0-9_-]+)*$/.test(path)) throw invalid();
    const check = () => { if (signal?.aborted || this.#key !== accountScopeKey()) throw new AccountIdentityError(0, "stale-session", "The account or server changed. Reopen this panel before continuing."); };
    check();
    const response = await this.request(`${this.#scope.serverURL.replace(/\/$/, "")}/api/account${path}`, { method, signal, redirect: "error", cache: "no-store", credentials: "omit", headers: { Authorization: `Bearer ${this.#scope.token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    check();
    if (response.status === 404 || response.status === 501) throw failure(response.status, "unsupported");
    const data = await boundedJson(response); check();
    if (!response.ok) throw failure(response.status, typeof data.code === "string" ? data.code : typeof data.error === "string" ? data.error : "request-failed");
    return data;
  }
  async identities(signal?: AbortSignal) {
    const data = await this.call("/identities", "GET", undefined, signal);
    if (!Array.isArray(data.identities) || data.identities.length > 100) throw invalid();
    if (data.providers !== undefined && (!Array.isArray(data.providers) || data.providers.length > 100)) throw invalid();
    const providers = ((data.providers ?? []) as unknown[]).map((provider): AccountProvider => { if (!record(provider) || !id(provider.id) || typeof provider.providerId !== "string" || provider.providerId.length > 80) throw invalid(); return { id: provider.id, providerId: provider.providerId }; });
    return { identities: data.identities.map(identity), providers, googleAvailable: data.googleAvailable === true };
  }
  async startGoogle(proofId: string, signal?: AbortSignal) {
    const data = await this.call("/identities/google/start", "POST", { proofId }, signal);
    if (!id(data.intentId) || typeof data.browserUrl !== "string") throw invalid();
    const target = new URL(data.browserUrl), base = new URL(this.#scope.serverURL);
    if (target.origin !== base.origin || target.pathname !== "/account/link-google" || target.username || target.password || target.search || !target.hash.startsWith(`#${data.intentId}.`) || !/^#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(target.hash)) throw invalid();
    return { intentId: data.intentId, browserUrl: target.href };
  }
  async googleStatus(intentId: string, signal?: AbortSignal): Promise<"pending" | "complete" | "expired"> {
    if (!id(intentId)) throw invalid(); const data = await this.call(`/identities/google/${intentId}`, "GET", undefined, signal);
    if (data.intentId !== intentId || !["pending", "complete", "expired"].includes(String(data.status))) throw invalid(); return data.status as "pending" | "complete" | "expired";
  }
  async unlinkGoogle(providerId: string, proofId: string, signal?: AbortSignal) {
    if (!id(providerId)) throw invalid(); const data = await this.call(`/identities/google-provider/${providerId}`, "DELETE", { proofId }, signal);
    if (data.ok !== true || data.signedOut !== true) throw invalid(); return data;
  }
  async challenge(path: "/identities/step-up/start" | "/identities/email/start", body: unknown, signal?: AbortSignal): Promise<IdentityChallenge> {
    const data = await this.call(path, "POST", body, signal);
    if (!id(data.challengeId) || !Number.isSafeInteger(data.expiresInSeconds) || Number(data.expiresInSeconds) < 1) throw invalid();
    return { challengeId: data.challengeId, expiresInSeconds: Number(data.expiresInSeconds) };
  }
  startStepUp(scope: "email-add" | "email-remove" | "google-link" | "google-remove" = "email-add", signal?: AbortSignal) { return this.challenge("/identities/step-up/start", { scope }, signal); }
  async verifyStepUp(challengeId: string, code: string, signal?: AbortSignal) {
    const data = await this.call("/identities/step-up/verify", "POST", { challengeId, code }, signal);
    if (!id(data.proofId)) throw invalid(); return data.proofId;
  }
  startEmail(email: string, proofId: string, signal?: AbortSignal) { return this.challenge("/identities/email/start", { email: email.trim(), proofId }, signal); }
  async verifyEmail(challengeId: string, code: string, signal?: AbortSignal) { const data = await this.call("/identities/email/verify", "POST", { challengeId, code }, signal); return identity(data.identity); }
  unlink(identityId: string, proofId: string, signal?: AbortSignal) { if (!id(identityId)) throw invalid(); return this.call(`/identities/${identityId}`, "DELETE", { proofId }, signal); }
  async areas(signal?: AbortSignal): Promise<CloudAreas> {
    const data = await this.call("/cloud-areas", "GET", undefined, signal);
    if (!Array.isArray(data.areas) || data.areas.length > 100 || !Array.isArray(data.placements ?? []) || ((data.placements ?? []) as unknown[]).length > 5000) throw invalid();
    const areas = data.areas.map((area): CloudArea => { if (!record(area) || !id(area.id) || typeof area.label !== "string" || area.label.length > 100 || area.identityId != null && !id(area.identityId)) throw invalid(); return { id: area.id, label: area.label, ...(area.identityId === undefined ? {} : { identityId: area.identityId as string | null }) }; });
    const placements = ((data.placements ?? []) as unknown[]).map((placement): CloudPlacement => { if (!record(placement) || !["markdown", "snapshot"].includes(String(placement.kind)) || !id(placement.documentId) || !id(placement.areaId)) throw invalid(); return placement as unknown as CloudPlacement; });
    return { areas, placements };
  }
  async createArea(label: string, signal?: AbortSignal): Promise<CloudArea> {
    const trimmed = label.trim(); if (!trimmed || trimmed.length > 80 || /[\x00-\x1f]/.test(trimmed)) throw new AccountIdentityError(0, "invalid-label", "Use a cloud area label between 1 and 80 characters.");
    const data = await this.call("/cloud-areas", "POST", { label: trimmed }, signal);
    if (!record(data.area) || !id(data.area.id) || typeof data.area.label !== "string") throw invalid(); return data.area as unknown as CloudArea;
  }
  place(kind: CloudPlacement["kind"], documentId: string, areaId: string, signal?: AbortSignal) { if (!id(documentId) || !id(areaId)) throw invalid(); return this.call(`/cloud-areas/placements/${kind}/${documentId}`, "PUT", { areaId }, signal); }
}

async function aliasCall(action: "start" | "verify", body: unknown, request: typeof fetch) {
  const base = getServerURL(), beforeToken = getAuthToken(), beforeUser = authStore.getSnapshot().user?.id;
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw failure(401, "invalid-server");
  const response = await request(`${base.replace(/\/$/, "")}/api/account/identities/sign-in/${action}`, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const check = () => { if (getServerURL() !== base || getAuthToken() !== beforeToken || authStore.getSnapshot().user?.id !== beforeUser) throw new AccountIdentityError(0, "stale-session", "The account or server changed. Start sign-in again."); };
  check(); if (response.status === 404 || response.status === 501) throw failure(response.status, "unsupported");
  const data = await boundedJson(response); check(); if (!response.ok) throw failure(response.status, typeof data.code === "string" ? data.code : typeof data.error === "string" ? data.error : "request-failed");
  return { data, response };
}
