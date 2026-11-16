// Who is on a document, for each store a document can live in. Markdown and
// text use the desktop share dialog's routes (server/src/shares.ts); a Word,
// RTF or OpenDocument file uses the document platform's members, the ones
// the desktop's cloud document panel manages.
import type { ApiClient, ShareRole } from "./api";
import type { PublicLinkApi, SharePeopleApi, SharePerson } from "../components/share-sheet";

export function docsPeople(api: ApiClient, docId: string): SharePeopleApi {
  return {
    invites: true,
    list: () => api.shares(docId),
    add: (email, role) => api.addShare(docId, email, role),
    // The server's own way to change a role: share again with the new one.
    setRole: async (person, role) => { await api.addShare(docId, person.email, role); },
    remove: (person) => api.removeShare(docId, person.userId ?? person.email),
  };
}

/** The owner's public link for a Markdown or text document. */
export function docsPublicLink(api: ApiClient, docId: string): PublicLinkApi {
  return {
    get: () => api.publicLink(docId),
    create: () => api.createPublicLink(docId),
    revoke: () => api.revokePublicLink(docId),
  };
}

const MEMBER_ID =/^[A-Za-z0-9_-]{1,128}$/;

export function platformPeople(api: ApiClient, docId: string): SharePeopleApi {
  const base = `/documents/${docId}/members`;
  return {
    invites: false,
    async list() {
      const result = await api.platform().call(base);
      const members = Array.isArray(result.members) ? result.members : [];
      return members.slice(0, 200).flatMap((value): SharePerson[] => {
        const raw = (value ?? {}) as { userId?: unknown; email?: unknown; role?: unknown; waiting?: unknown };
        if (typeof raw.userId !== "string" || !MEMBER_ID.test(raw.userId)) return [];
        if (raw.role !== "viewer" && raw.role !== "editor") return [];
        const email = typeof raw.email === "string" ? raw.email.slice(0, 320) : raw.userId;
        return [{ userId: raw.userId, email, name: null, role: raw.role, pending: false, waiting: raw.waiting === true }];
      });
    },
    async add(email: string, role: ShareRole) {
      const address = email.trim().toLowerCase();
      await api.platform().call(base, "POST", { email: address, role });
      // The platform's answer does not say whether the file reached them: it
      // does only once they accept the owner (server/src/share-people-store.ts).
      const added = (await this.list()).find((person) => person.email.toLowerCase() === address);
      return added?.waiting ? "requested" : "member";
    },
    async setRole(person, role) {
      if (!person.userId) return;
      await api.platform().call(base, "POST", { userId: person.userId, role });
    },
    async remove(person) {
      if (!person.userId || !MEMBER_ID.test(person.userId)) return;
      await api.platform().call(`${base}/${person.userId}`, "DELETE");
    },
  };
}
