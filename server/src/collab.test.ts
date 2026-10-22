import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-collab-")), "t.db");
process.env.BETTER_AUTH_SECRET = "markie-collab-test-secret-32-plus-chars";
const { readAccessControlledSyncMessage, roomHasCollabContent } = await import("./collab.ts");

test("a room seeded as plain text counts as holding the document", () => {
  const empty = new Y.Doc();
  assert.equal(roomHasCollabContent(empty), false);
  // Asking must not create the text type in a Markdown room.
  assert.equal(empty.share.has("content"), false);
  // A metadata-only stamp is not a document either.
  empty.getMap("meta").set("schemaVersion", 1);
  assert.equal(roomHasCollabContent(empty), false);

  const textDoc = new Y.Doc();
  textDoc.getText("content").insert(0, "plain text body");
  assert.equal(roomHasCollabContent(textDoc), true);

  const richDoc = new Y.Doc();
  richDoc.getXmlFragment("default").insert(0, [new Y.XmlText("rich")]);
  assert.equal(roomHasCollabContent(richDoc), true);
});

function writeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

test("viewer-originated sync updates do not mutate the server doc", () => {
  const serverDoc = new Y.Doc();
  serverDoc.getText("default").insert(0, "trusted");

  const viewerDoc = new Y.Doc();
  viewerDoc.getText("default").insert(0, "viewer-write");

  const reply = encoding.createEncoder();
  readAccessControlledSyncMessage(
    decoding.createDecoder(writeUpdateMessage(Y.encodeStateAsUpdate(viewerDoc))),
    reply,
    serverDoc,
    {},
    false
  );

  assert.equal(serverDoc.getText("default").toString(), "trusted");
  assert.equal(encoding.length(reply), 0);
});

test("editor-originated sync updates can mutate the server doc", () => {
  const serverDoc = new Y.Doc();
  const editorDoc = new Y.Doc();
  editorDoc.getText("default").insert(0, "editor-write");

  readAccessControlledSyncMessage(
    decoding.createDecoder(writeUpdateMessage(Y.encodeStateAsUpdate(editorDoc))),
    encoding.createEncoder(),
    serverDoc,
    {},
    true
  );

  assert.equal(serverDoc.getText("default").toString(), "editor-write");
});

test("viewer sync-step1 requests still receive a server state reply", () => {
  const serverDoc = new Y.Doc();
  serverDoc.getText("default").insert(0, "trusted");

  const clientDoc = new Y.Doc();
  const request = encoding.createEncoder();
  syncProtocol.writeSyncStep1(request, clientDoc);
  const reply = encoding.createEncoder();

  readAccessControlledSyncMessage(
    decoding.createDecoder(encoding.toUint8Array(request)),
    reply,
    serverDoc,
    {},
    false
  );

  assert.ok(encoding.length(reply) > 0);
});
