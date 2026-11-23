// What the signed-out reader says when a public link can't be shown. Kept
// apart from documentErrorCopy (api.ts): that one speaks to an account
// ("hasn't been shared with this account"), and here there is none.
import { ApiError } from "./api";

export interface PublicLinkErrorCopy {
  title: string;
  body: string;
  /** Trying again could work. A link that is off stays off. */
  retry: boolean;
}

export function publicLinkErrorCopy(error: unknown): PublicLinkErrorCopy {
  if (error instanceof ApiError) {
    if (error.status === 0) return { title: "You're offline", body: error.message, retry: true };
    if (error.status === 404) return { title: "This link is off", body: "The owner turned this public link off, or it never existed. If the document was shared with you, sign in to find it.", retry: false };
    return { title: "Couldn't open this document", body: error.message, retry: true };
  }
  return { title: "Couldn't open this document", body: error instanceof Error ? error.message : "Something went wrong.", retry: true };
}
