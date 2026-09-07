// Comment threads client and types. The Yjs anchor helpers live in
// src/lib/comment-anchors.ts, behind the live-session chunk, so this module
// can be imported at launch without pulling yjs along.
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
