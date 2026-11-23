// Local mode: the screens for files on this phone, and how they stack. The
// same routes sit on the signed-in stack and on the signed-out one, so a
// person with no account gets the same reader, folders and editor.
//
// Nothing in a local route reaches a server. The one exception is a button
// the person taps on purpose, signed in: "Save a copy to Markie Cloud".
import type { MutableRefObject } from "react";
import { ApiError, type ApiClient } from "../lib/api";
import type { IncomingFile } from "../lib/incoming-file";
import { localEditing, type LocalEditing } from "../lib/local-editing";
import { LocalFileError, type LocalDocument, type LocalFiles, type LocalGrant, type LocalRef } from "../lib/local-files";
import { isMarkieCloud } from "../lib/server-origin";
import type { Tone } from "../lib/theme-mode";
import type { StackEntry } from "../components/navigator";
import { EditorScreen, type EditorUser } from "./editor";
import { LocalDocScreen } from "./local-doc";
import { LocalFolderScreen } from "./local-folder";
import { LocalHomeScreen } from "./local-home";

export type LocalRoute =
  | { key: string; kind: "local-home" }
  | { key: string; kind: "local-folder"; grant: LocalGrant; entry: string | null; name: string }
  | { key: string; kind: "local-doc"; doc: LocalDocument }
  | { key: string; kind: "local-edit"; doc: LocalDocument }
  /** A copy another app handed over, read with nobody signed in. There is no file to save back to. */
  | { key: string; kind: "local-copy"; file: IncomingFile };

export function isLocalRoute<R extends { kind: string }>(route: R): route is Extract<R, LocalRoute> {
  return route.kind.startsWith("local-");
}

/** What the screens need from the app: the stack they are on, and who is signed in, if anyone. */
export interface LocalHost {
  files: LocalFiles;
  tone: Tone;
  /** The signed-in client, for "Save a copy to Markie Cloud" only. Null with nobody signed in. */
  api: ApiClient | null;
  /** The editor's props ask for a client and a person. A local file uses neither. */
  editorApi: ApiClient;
  me: EditorUser;
  backGuard: MutableRefObject<(() => void) | null>;
  nextKey: (prefix: string) => string;
  push: (route: LocalRoute) => void;
  pop: () => void;
  /** Rewrites the local routes on the stack; null takes one off. */
  update: (change: (route: LocalRoute) => LocalRoute | null) => void;
  /** Signed out: leave local mode for the sign-in screen. */
  onSignIn: (() => void) | null;
  /** Signed in: a copy was saved to the cloud; open it. */
  onCloudCopy: ((saved: { id: string; name: string }) => void) | null;
  onUnauthorized: () => void;
}

const sameRef = (a: LocalRef, b: LocalRef) => a.grantId === b.grantId && a.entry === b.entry;

/** Opens a file and puts it on the stack. Throws LocalFileError for the screen that asked to show. */
export async function openLocalFile(host: Pick<LocalHost, "files" | "push" | "nextKey">, ref: LocalRef, { fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  let doc: LocalDocument;
  try {
    doc = await host.files.open(ref);
  } catch (error) {
    // A file just picked that turns out not to be a document is not kept.
    if (fresh && ref.entry === null && error instanceof LocalFileError && error.code === "not-text") await host.files.forget(ref.grantId).catch(() => undefined);
    throw error;
  }
  // A converted copy has nothing to save back to, so its permission isn't kept either.
  if (doc.readOnly === "converted" && ref.entry === null) await host.files.forget(ref.grantId).catch(() => undefined);
  host.push({ key: host.nextKey("local-doc"), kind: "local-doc", doc });
}

function noteFor(doc: LocalDocument): string {
  if (doc.readOnly === "converted") return `A text copy of a ${doc.convertedFrom} file. The original is not changed.`;
  if (doc.readOnly === "not-writable") return "On this phone. This file is read-only here.";
  return "On this phone. Changes save back to this file.";
}

// One per open editor, so the conflict sheet compares once, not on every draw.
const editing = new WeakMap<LocalRoute, LocalEditing>();

export function localEntry(route: LocalRoute, { host, backLabel, active }: { host: LocalHost; backLabel: string; active: boolean }): StackEntry {
  const back = { label: backLabel, onBack: host.pop };
  const where = host.api && isMarkieCloud(host.api.origin) ? "Markie Cloud" : "your server";
  const cloudCopy = (name: string, content: string) => (host.api && host.onCloudCopy ? {
    where,
    save: async () => {
      try {
        const created = await host.api!.createDoc({ name, content });
        host.onCloudCopy!({ id: created.id, name });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) host.onUnauthorized();
        throw error;
      }
    },
  } : null);

  if (route.kind === "local-home") {
    return {
      key: route.key,
      node: (
        <LocalHomeScreen
          files={host.files}
          back={host.onSignIn ? { label: "Sign in", onBack: host.onSignIn } : back}
          active={active}
          onOpenFile={(grant) => openLocalFile(host, { grantId: grant.id, entry: null }, { fresh: true })}
          onOpenFolder={(grant) => host.push({ key: host.nextKey("local-folder"), kind: "local-folder", grant, entry: null, name: grant.name })}
        />
      ),
    };
  }

  if (route.kind === "local-folder") {
    return {
      key: route.key,
      node: (
        <LocalFolderScreen
          files={host.files}
          grant={route.grant}
          entry={route.entry}
          name={route.name}
          back={back}
          active={active}
          onOpenFolder={(item) => host.push({ key: host.nextKey("local-folder"), kind: "local-folder", grant: route.grant, entry: item.id, name: item.name })}
          onOpenFile={(item) => openLocalFile(host, { grantId: route.grant.id, entry: item.id, parent: route.entry })}
          // Every screen inside the lost folder goes; the folder picked again takes their place.
          onGrantedAgain={(grant) => {
            let placed = false;
            host.update((item) => {
              if (item.kind !== "local-folder" || item.grant.id !== route.grant.id) return item.kind === "local-doc" && item.doc.ref.grantId === route.grant.id ? null : item;
              if (placed) return null;
              placed = true;
              return { key: host.nextKey("local-folder"), kind: "local-folder", grant, entry: null, name: grant.name };
            });
          }}
          onRemoved={() => host.update((item) => ((item.kind === "local-folder" && item.grant.id === route.grant.id) || ((item.kind === "local-doc" || item.kind === "local-edit") && item.doc.ref.grantId === route.grant.id) ? null : item))}
        />
      ),
    };
  }

  if (route.kind === "local-copy") {
    const { file } = route;
    return {
      key: route.key,
      node: (
        <LocalDocScreen
          docKey={route.key}
          name={file.name}
          format={file.format}
          content={file.content}
          note={file.convertedFrom ? `A text copy of a ${file.convertedFrom} file from another app.` : "A copy from another app. There is no file to save back to."}
          tone={host.tone}
          back={back}
          onEdit={null}
          cloud={cloudCopy(file.name, file.content)}
          onSignIn={host.onSignIn}
        />
      ),
    };
  }

  const { doc } = route;
  if (route.kind === "local-doc") {
    return {
      key: route.key,
      node: (
        <LocalDocScreen
          docKey={route.key}
          name={doc.name}
          format={doc.format}
          content={doc.content}
          note={noteFor(doc)}
          tone={host.tone}
          back={back}
          onEdit={doc.shape ? () => host.push({ key: host.nextKey("local-edit"), kind: "local-edit", doc }) : null}
          cloud={cloudCopy(doc.cloudName, doc.content)}
          onSignIn={doc.shape ? null : host.onSignIn}
        />
      ),
    };
  }

  let local = editing.get(route);
  if (!local) {
    local = localEditing(host.files, doc, {
      // Saved: the editor closes and every open copy of the file shows what is on the device now.
      saved: (next) => host.update((item) => (item.key === route.key ? null : item.kind === "local-doc" && sameRef(item.doc.ref, next.ref) ? { ...item, doc: next } : item)),
      gone: () => host.update((item) => (item.key === route.key || (item.kind === "local-doc" && sameRef(item.doc.ref, doc.ref)) ? null : item)),
    });
    editing.set(route, local);
  }
  return {
    key: route.key,
    locked: true,
    node: (
      <EditorScreen
        api={host.editorApi}
        draft={{ kind: "local", name: doc.name, format: doc.format, content: doc.content }}
        me={host.me}
        backGuard={host.backGuard}
        local={local}
        onCancel={host.pop}
        onSaved={() => undefined}
        onUnauthorized={() => undefined}
      />
    ),
  };
}
