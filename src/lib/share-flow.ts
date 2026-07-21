// Decides what the toolbar Share button does. Reads the freshest registry
// entry instead of trusting mounted state: a doc synced after the page
// computed `canShare` must still open the dialog on the next click.

export type ShareAction = "open-dialog" | "sign-in" | "sync-first";

export function shareActionFor(opts: {
  // cloud_doc_id from the registry entry looked up at click time
  cloudDocId: string | null | undefined;
  signedIn: boolean;
}): ShareAction {
  if (!opts.signedIn) return "sign-in";
  return opts.cloudDocId ? "open-dialog" : "sync-first";
}
