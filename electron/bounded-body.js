// Read a fetch response's body with a ceiling on how much of it main will
// hold. A server the user added, or one a share link names, decides how many
// bytes it sends; `res.text()` would buffer every one of them in the main
// process before anyone could look at the length. This reads the stream
// chunk by chunk and stops, cancelling the stream and aborting the request,
// the moment the total passes the cap.
//
// Pure apart from the Response it is handed, so it unit-tests without
// Electron.

class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`The response is larger than ${maxBytes} bytes.`);
    this.name = "BodyTooLargeError";
    this.code = "EBODYTOOLARGE";
    this.maxBytes = maxBytes;
  }
}

/**
 * The body as a Buffer of at most `maxBytes`, or a BodyTooLargeError.
 * `controller` is the AbortController behind the request, when the caller
 * has one: aborting it is what actually closes the connection.
 * @param {Response} res
 * @param {number} maxBytes
 * @param {{ controller?: AbortController | null }} [opts]
 * @returns {Promise<Buffer>}
 */
async function readBodyCapped(res, maxBytes, { controller = null } = {}) {
  const giveUp = async (reader) => {
    try {
      if (reader) await reader.cancel();
      else await res.body?.cancel?.();
    } catch {
      // already closed
    }
    try {
      controller?.abort();
    } catch {
      // nothing to abort
    }
    throw new BodyTooLargeError(maxBytes);
  };
  // A declared length over the cap is refused before a byte is read. One
  // under it proves nothing, so the stream is counted regardless.
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) await giveUp(null);
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) await giveUp(reader);
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/** The same, decoded as UTF-8. */
async function readTextCapped(res, maxBytes, opts) {
  return (await readBodyCapped(res, maxBytes, opts)).toString("utf8");
}

module.exports = { BodyTooLargeError, readBodyCapped, readTextCapped };
