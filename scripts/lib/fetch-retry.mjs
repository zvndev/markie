// A fetch that retries when the connection drops before any response.
//
// Backblaze closes idle keep-alive sockets, and Node's fetch sometimes reuses
// one it has not yet seen close. The request then throws "fetch failed" with
// cause UND_ERR_SOCKET ("other side closed") a few milliseconds in. On
// 2026-11-20 this failed the 0.9.7 macOS and Linux early publishes six times
// in a row, after every upload had landed.
//
// Only errors thrown before a response are retried. A response of any status
// is returned as it is, so every status, size and SHA-512 check in the caller
// still decides.

const RETRYABLE = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE"]);

export function isRetryableFetchError(error) {
  return RETRYABLE.has(error?.cause?.code ?? error?.code ?? "");
}

export function createRetryingFetch(baseFetch, { attempts = 4, delayMs = 1000, log = console.error, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async function retryingFetch(url, options = {}) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await baseFetch(url, options);
      } catch (error) {
        if (attempt >= attempts || !isRetryableFetchError(error)) throw error;
        log(`[release] ${options.method ?? "GET"} ${url} dropped (${error.cause?.code ?? error.code}), retry ${attempt}`);
        await wait(delayMs * attempt);
      }
    }
  };
}
