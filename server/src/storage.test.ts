import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fsStore, s3Store, assetStore, sigV4Headers } from "./storage.ts";
import { assetMimeFor } from "./asset-mime.ts";

// A key is "<uploader_id>/<sha256 hex>"; these build well-formed 64-char
// lowercase-hex second segments for tests, the shape checkKey enforces.
const H = (c: string) => c.repeat(64);

test("assetMimeFor knows the allow-list and nothing else", () => {
  assert.equal(assetMimeFor("shots/a.PNG"), "image/png");
  assert.equal(assetMimeFor("clip.mov?x=1"), "video/quicktime");
  assert.equal(assetMimeFor("notes.txt"), null);
  assert.equal(assetMimeFor("evil.html"), null);
});

// The table says it is kept in step with electron/local-assets.js, and these
// are the two extensions where it was not: Markie draws an .m4v as video/mp4
// and an .opus as audio/ogg, and those are the types it declares when it
// uploads one.
test("assetMimeFor answers with the types Markie itself uses", () => {
  assert.equal(assetMimeFor("clip.m4v"), "video/mp4");
  assert.equal(assetMimeFor("voice.opus"), "audio/ogg");
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream as never as AsyncIterable<Uint8Array>) parts.push(chunk);
  return Buffer.concat(parts);
}

test("fsStore round-trips a file, honours a range, and deletes", async () => {
  const store = fsStore(mkdtempSync(join(tmpdir(), "markie-store-")));
  const key = `u1/${H("a")}`;
  await store.put(key, Buffer.from("0123456789"), 10, "image/png");
  assert.deepEqual(await store.head(key), { size: 10 });
  const whole = await store.get(key);
  assert.equal((await collect(whole!.stream)).toString(), "0123456789");
  const part = await store.get(key, { start: 2, end: 4 });
  assert.equal((await collect(part!.stream)).toString(), "234");
  assert.deepEqual([part!.start, part!.end, part!.total], [2, 4, 10]);
  const tail = await store.get(key, { start: 8 });
  assert.equal((await collect(tail!.stream)).toString(), "89");
  await store.delete(key);
  assert.equal(await store.head(key), null);
  assert.equal(await store.get(key), null);
});

test("fsStore never escapes its directory", async () => {
  const store = fsStore(mkdtempSync(join(tmpdir(), "markie-store-")));
  await assert.rejects(() => store.put("../x", Buffer.from("x"), 1, "image/png"), /key/);
  await assert.rejects(() => store.head("u1/../../x"), /key/);
  await assert.rejects(() => store.head(`u1/${H("A")}`), /key/); // uppercase hex is refused
  await assert.rejects(() => store.head(`u1/${H("a").slice(0, 63)}`), /key/); // one char short
});

// AWS Signature Version 4 test suite, "get-vanilla" vector (empty payload,
// host header only), which every SigV4 implementation is checked against.
test("sigV4Headers matches the AWS known answer", () => {
  const headers = sigV4Headers({
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: {},
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    keyId: "AKIDEXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    now: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(
    headers.Authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
  );
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
});

// AWS's own S3 example ("Example: GET Object", a ranged read of test.txt),
// which is the shape production actually signs: service "s3", the content
// hash header in the signed set, and a caller-supplied header beside it. The
// vanilla vector above signs neither, so without this one the signature the
// bucket sees was never checked against a known answer.
test("sigV4Headers matches the AWS known answer for S3 with a caller's header", () => {
  const headers = sigV4Headers({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { Range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    keyId: "AKIAIOSFODNN7EXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(
    headers.Authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
  );
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.equal(
    headers["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("s3Store issues signed requests against the bucket and streams a range back", async () => {
  const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    seen.push({ method: init.method!, url, headers });
    if (init.method === "PUT") return new Response(null, { status: 200 });
    if (init.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "10" } });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response("234", {
      status: 206,
      headers: { "content-range": "bytes 2-4/10", "content-length": "3" },
    });
  }) as unknown as typeof fetch;
  const store = s3Store({
    bucket: "markie-assets",
    endpoint: "https://s3.us-east-005.backblazeb2.com",
    keyId: "k",
    appKey: "s",
    fetchImpl,
    now: () => new Date("2026-09-12T00:00:00Z"),
  });
  const key = `u1/${H("a")}`;
  await store.put(key, Buffer.from("0123456789"), 10, "image/png");
  assert.equal(seen[0].url, `https://s3.us-east-005.backblazeb2.com/markie-assets/${key}`);
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=k\/20260912\/us-east-005\/s3\/aws4_request/);
  assert.equal(seen[0].headers["content-type"], "image/png");
  assert.deepEqual(await store.head(key), { size: 10 });
  const part = await store.get(key, { start: 2, end: 4 });
  assert.equal(seen[2].headers.range, "bytes=2-4");
  assert.deepEqual([part!.start, part!.end, part!.total], [2, 4, 10]);
  assert.equal((await collect(part!.stream)).toString(), "234");
  await store.delete(key);
  assert.equal(seen[3].method, "DELETE");
});

test("s3Store answers null for a missing object", async () => {
  const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const store = s3Store({ bucket: "b", endpoint: "https://s3.example", keyId: "k", appKey: "s", fetchImpl });
  const key = `u1/${H("b")}`;
  assert.equal(await store.head(key), null);
  assert.equal(await store.get(key), null);
});

test("s3Store refuses a malformed key before touching the network", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const store = s3Store({ bucket: "b", endpoint: "https://s3.example", keyId: "k", appKey: "s", fetchImpl });
  await assert.rejects(() => store.head(`u1/${H("A")}`), /key/); // uppercase hex is refused
  await assert.rejects(() => store.head(`u1/${H("a").slice(0, 63)}`), /key/); // one char short
  assert.equal(calls, 0);
});

test("assetStore picks the filesystem, then S3, then nothing", () => {
  assert.ok(assetStore({ ASSETS_DIR: mkdtempSync(join(tmpdir(), "markie-store-")) }));
  assert.ok(assetStore({ ASSETS_BUCKET: "b", B2_ENDPOINT: "https://s3.example", B2_KEY_ID: "k", B2_APP_KEY: "s" }));
  assert.equal(assetStore({}), null);
  assert.equal(assetStore({ ASSETS_BUCKET: "b" }), null);
});

test("the real bucket round-trips (ASSETS_LIVE_TEST=1 only)", { skip: process.env.ASSETS_LIVE_TEST !== "1" }, async () => {
  const store = assetStore(process.env)!;
  const key = `livetest/${"0".repeat(60)}beef`;
  // A web ReadableStream with the size and mime declared separately, which is
  // exactly what assets.ts hands the store for a real upload. A Buffer body
  // takes a different path through fetch and would leave the streaming PUT
  // that production uses unproven.
  const body = Readable.toWeb(Readable.from(Buffer.from("live"))) as ReadableStream<Uint8Array>;
  await store.put(key, body, 4, "image/png");
  try {
    assert.deepEqual(await store.head(key), { size: 4 });
    const part = await store.get(key, { start: 1, end: 2 });
    assert.equal((await collect(part!.stream)).toString(), "iv");
  } finally {
    await store.delete(key);
  }
  assert.equal(await store.head(key), null);
});
