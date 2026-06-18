// Comment threads client + Yjs anchor helpers. Anchors are relative
// positions into the shared doc, so they survive concurrent edits; they
// round-trip through the server as opaque JSON.
import type { Editor } from "@tiptap/react";
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { getAuthToken, getServerURL } from "@/lib/auth-client";

export interface ThreadComment {
  id: string;
  thread_id: string;
  author_id: string;
  author_name: string;
  author_email: string;
  body: string;
  created_at: string;
}

export interface CommentThread {
  id: string;
  doc_id: string;
  anchor: { from: unknown; to: unknown };
  status: "open" | "resolved";
  created_by: string;
  created_at: string;
  comments: ThreadComment[];
}

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

export const commentsClient = {
  list: async (docId: string): Promise<CommentThread[] | null> => {
    const res = await call<{ threads: CommentThread[] }>(
      "GET",
      `/api/docs/${encodeURIComponent(docId)}/threads`
    );
    return res?.threads ?? null;
  },
  createThread: (docId: string, anchor: unknown, body: string) =>
    call<{ id: string }>("POST", `/api/docs/${encodeURIComponent(docId)}/threads`, {
      anchor,
      body,
    }),
  reply: (docId: string, threadId: string, body: string) =>
    call<{ id: string }>(
      "POST",
      `/api/docs/${encodeURIComponent(docId)}/threads/${threadId}/comments`,
      { body }
    ),
  setStatus: (docId: string, threadId: string, status: "open" | "resolved") =>
    call<{ ok: boolean }>(
      "POST",
      `/api/docs/${encodeURIComponent(docId)}/threads/${threadId}/status`,
      { status }
    ),
  deleteComment: (docId: string, threadId: string, commentId: string) =>
    call<{ ok: boolean }>(
      "DELETE",
      `/api/docs/${encodeURIComponent(docId)}/threads/${threadId}/comments/${commentId}`
    ),
};

type YMapping = Parameters<typeof absolutePositionToRelativePosition>[2];

interface YSyncState {
  type: Y.XmlFragment;
  binding?: { mapping: YMapping } | null;
}

function syncState(editor: Editor): YSyncState | null {
  const state = ySyncPluginKey.getState(editor.state) as YSyncState | null;
  return state?.binding ? state : null;
}

// Editor selection → serializable anchor
export function selectionToAnchor(
  editor: Editor,
  from: number,
  to: number
): { from: unknown; to: unknown } | null {
  const ystate = syncState(editor);
  if (!ystate) return null;
  const relFrom = absolutePositionToRelativePosition(
    from,
    ystate.type,
    ystate.binding!.mapping
  );
  const relTo = absolutePositionToRelativePosition(
    to,
    ystate.type,
    ystate.binding!.mapping
  );
  if (!relFrom || !relTo) return null;
  return {
    from: Y.relativePositionToJSON(relFrom),
    to: Y.relativePositionToJSON(relTo),
  };
}

// Anchor → current absolute positions; null when the text was deleted
export function anchorToAbsolute(
  editor: Editor,
  ydoc: Y.Doc,
  anchor: { from: unknown; to: unknown }
): { from: number; to: number } | null {
  const ystate = syncState(editor);
  if (!ystate) return null;
  try {
    const from = relativePositionToAbsolutePosition(
      ydoc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.from),
      ystate.binding!.mapping
    );
    const to = relativePositionToAbsolutePosition(
      ydoc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.to),
      ystate.binding!.mapping
    );
    if (from == null || to == null) return null;
    return { from, to };
  } catch {
    return null;
  }
}
