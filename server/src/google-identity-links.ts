// Google's purpose-bound linking, under the names it had before Apple joined.
// The protocol lives in provider-identity-links.ts, one module for Google and
// Apple; this keeps Google's options, method names, routes, tables, fence and
// error codes exactly as they were.
import { createProviderIdentityLinks, type ProviderIdentityLinkOptions } from "./provider-identity-links.ts";

export type GoogleIdentityLinkOptions = Omit<ProviderIdentityLinkOptions<"google">, "provider">;

/** Purpose-bound OAuth linking. Importing this module does not boot auth or a database. */
export function createGoogleIdentityLinks(options: GoogleIdentityLinkOptions) {
  const links = createProviderIdentityLinks({ ...options, provider: "google" });
  return {
    ...links,
    assertGoogleAccountCreation: links.assertAccountCreation,
    assertGoogleAccountMutation: links.assertAccountMutation,
    authorizeGoogleAccountCreation: links.authorizeAccountCreation,
    noteGoogleAccountCreated: links.noteAccountCreated,
  };
}
