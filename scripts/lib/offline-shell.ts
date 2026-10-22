import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/** Only emitted application resources are cacheable; never documents or APIs. */
export function offlineWorkerSource(version: string, fileNames: readonly string[]): string {
  if (!/^[a-f0-9]{16}$/.test(version)) throw new Error("Invalid offline shell version.");
  const files = [...new Set(fileNames)].sort();
  if (!files.includes("index.html") || files.some((file) => !/^(?:index\.html|favicon\.ico|assets\/[a-zA-Z0-9_.-]+)$/.test(file))) {
    throw new Error("Only the app shell and generated assets may be cached.");
  }
  return `"use strict";
const PREFIX = "markie-shell-" + encodeURIComponent(self.registration.scope) + "-";
const CACHE = PREFIX + "${version}";
const FILES = ${JSON.stringify(files)};
const urls = FILES.map(name => new URL(name, self.registration.scope).href);
const allowed = new Set(urls);
const shell = new URL("index.html", self.registration.scope).href;
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try { await (await caches.open(CACHE)).addAll(urls); }
    catch (error) { await caches.delete(CACHE); throw error; }
  })());
});
// Do not skip waiting or reload clients: dirty documents must never be replaced
// by a new application version in the middle of an editing session.
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (request.method !== "GET" || url.origin !== scope.origin) return;
  if (url.pathname === scope.pathname && request.mode === "navigate") {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(shell, { ignoreVary: true })) || fetch(request)));
  } else if (allowed.has(url.href) && !url.search && !url.hash) {
    // Static build assets cannot vary by account. Module/CSS requests may add
    // Origin where install's addAll did not, so Vary: Origin must not miss.
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.href, { ignoreVary: true })) || fetch(request)));
  }
});
`;
}

export function offlineShellPlugin(): Plugin {
  return {
    name: "markie-offline-shell",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).filter((name) => /^(?:index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(name));
      const digest = createHash("sha256");
      digest.update(offlineWorkerSource("0000000000000000", ["index.html"]));
      for (const name of [...names].sort()) {
        const output = bundle[name];
        digest.update(name);
        digest.update(output.type === "chunk" ? output.code : output.source);
      }
      this.emitFile({ type: "asset", fileName: "service-worker.js", source: offlineWorkerSource(digest.digest("hex").slice(0, 16), [...names, "favicon.ico"]) });
    },
  };
}
