// The window title.
//
// It is also the only thing the packaging gate can see. build/preflight.cjs
// launches the packed .app and reads the window title over AppleScript to
// decide whether the renderer actually loaded, because an Electron window with
// no page still exists and still reports the application name. The title has to
// carry a marker that only a loaded renderer can produce.
//
// It did not. With no document open the renderer set the title to bare
// "Markie", which is exactly what an empty window reports, and with a document
// open it set it to the file name. The gate's marker ("Markdown Viewer") came
// from the static HTML title and survived only in the moment before React's
// first effect replaced it — so the gate was passing on a race, and failed the
// first time macOS restored a document at launch.

export const APP_NAME = "Markie";
// Present in every title, and impossible for an unloaded window to report.
export const TITLE_MARKER = "Markdown Viewer";

export function windowTitle(fileName: string | null, isDirty = false): string {
  if (!fileName) return `${APP_NAME} — ${TITLE_MARKER}`;
  return `${isDirty ? "• " : ""}${fileName} — ${APP_NAME} — ${TITLE_MARKER}`;
}
