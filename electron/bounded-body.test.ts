import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { readBodyCapped, readTextCapped, BodyTooLargeError } = load("./bounded-body.js");

function endless(chunk = 1024) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      seen.pulled += chunk;
      c.enqueue(new Uint8Array(chunk).fill(97));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

describe("readBodyCapped", () => {
  it("returns a body under the cap whole", async () => {
    expect(await readTextCapped(new Response("héllo"), 64)).toBe("héllo");
    expect((await readBodyCapped(new Response(new Uint8Array(64)), 64)).length).toBe(64);
  });

  it("returns nothing for a response with no body", async () => {
    expect((await readBodyCapped(new Response(null, { status: 204 }), 10)).length).toBe(0);
  });

  it("aborts an oversize body mid-stream instead of buffering it", async () => {
    const { stream, seen } = endless();
    const controller = new AbortController();
    await expect(readBodyCapped(new Response(stream), 4096, { controller })).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(seen.cancelled).toBe(true);
    // It read just past the cap and no further.
    expect(seen.pulled).toBeLessThanOrEqual(4096 + 2 * 1024);
    expect(controller.signal.aborted).toBe(true);
  });

  it("refuses a declared length over the cap before reading anything", async () => {
    const { stream, seen } = endless();
    const res = new Response(stream, { headers: { "content-length": "999999" } });
    await expect(readBodyCapped(res, 1000)).rejects.toMatchObject({ code: "EBODYTOOLARGE" });
    expect(seen.cancelled).toBe(true);
    // At most what the stream had queued on its own before anyone read.
    expect(seen.pulled).toBeLessThanOrEqual(1024);
  });

  it("does not trust a declared length under the cap", async () => {
    const { stream } = endless();
    const res = new Response(stream, { headers: { "content-length": "10" } });
    await expect(readBodyCapped(res, 2048)).rejects.toMatchObject({ code: "EBODYTOOLARGE" });
  });
});
