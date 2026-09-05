#!/usr/bin/env node
// Opens a document with pictures next to it and checks that they are on screen.
//
// Every one of the four bugs behind this feature was invisible to a unit test.
// A relative image resolved against the app's origin and 403ed; an inlined one
// was thrown away by the editor before it reached the DOM; the same inlined one
// had its src stripped by the export sanitizer; a link to a file beside the
// document did nothing at all. The CSS was valid, the HTML was correct, the
// pipeline returned a string with an <img> in it. Only a real window, with a
// real protocol handler and a real CSP, can say whether the picture is there.
//
// So this asks the browser the only question that matters: did the image load,
// and is it the right size.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { safeKill } from "./lib/safe-kill.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("local-assets-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "local-assets-check");
const children = [];
const tempPaths = [];
let debugOrigin = "";

await mkdir(artifactDir, { recursive: true });
const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed });
  process.stdout.write(
    `${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`
  );
};

function start(command, args, options = {}) {
  const fd = options.log ? openSync(options.log, "a") : "ignore";
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: ["ignore", fd, fd],
  });
  children.push(child);
  if (typeof fd === "number") child.on("exit", () => closeSync(fd));
  return child;
}

function killTree(child) {
  // Direct-child kill only; see scripts/lib/safe-kill.mjs for why a group kill
  // (process.kill(-pid)) is banned here.
  safeKill(child, "SIGKILL");
}
async function cleanup() {
  for (const c of children) killTree(c);
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}
process.on("exit", () => {
  for (const c of children) killTree(c);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    for (const c of children) killTree(c);
    process.exit(1);
  });
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

// `next dev` leaves a `next-server` behind after the run: safe-kill signals
// only the direct child, on purpose (see scripts/lib/safe-kill.mjs, and the
// afternoon a group kill took Finder down), and the survivor keeps holding
// .next/dev/lock so the next run cannot start. Clear it here, and only it:
// the pid has to be both the holder of this exact lock file and a next-server,
// or nothing is signalled.
function releaseStaleDevLock() {
  const lock = path.join(root, ".next", "dev", "lock");
  let holders = "";
  try {
    holders = execFileSync("lsof", ["-t", lock], { encoding: "utf-8" });
  } catch {
    return; // lsof exits non-zero when nobody holds it, which is the good case
  }
  for (const line of holders.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let command = "";
    try {
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
    } catch {
      continue;
    }
    if (!command.includes("next-server")) continue;
    try {
      process.kill(pid, "SIGKILL");
      process.stdout.write(`  ..   cleared a leftover next-server holding the dev lock (pid ${pid})\n`);
    } catch {
      /* already gone */
    }
  }
}

async function pickPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
      ?.result?.value;
  return { send, ev, close: () => ws.close() };
}



// Non-zero naturalWidth is the whole assertion: an <img> with a src that 403s
// is still an <img> in the DOM, and only the browser knows the difference
// between a picture and a broken one. A real 240x120 picture rather than a 1x1 pixel: naturalWidth is what the
// checks assert on, but the screenshot this leaves behind is only worth
// looking at if there is something in it to see.
const PNG = Buffer.from(
  "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",
  "base64"
);

const imageReport = `(() => [...document.querySelectorAll('.markdown-body img')].map((i) => ({
  alt: i.getAttribute('alt'),
  scheme: (i.getAttribute('src') || '').split(':')[0].slice(0, 24),
  kept: i.getAttribute('data-markie-src'),
  loaded: i.complete && i.naturalWidth > 0,
  drawn: Math.round(i.getBoundingClientRect().width),
})))()`;

// Video and audio are the same document node as a picture; only the element
// differs. readyState >= 1 is HAVE_METADATA, which Chromium only reaches after
// main actually served the bytes and the decoder read a header, so it is the
// one assertion that cannot pass on a 403.
const mediaReport = `(() => [...document.querySelectorAll('.markdown-body video, .markdown-body audio')].map((m) => ({
  tag: m.tagName.toLowerCase(),
  alt: m.getAttribute('alt'),
  scheme: (m.getAttribute('src') || '').split(':')[0].slice(0, 24),
  kept: m.getAttribute('data-markie-src'),
  controls: m.hasAttribute('controls'),
  preload: m.getAttribute('preload'),
  ready: m.readyState,
  duration: Number.isFinite(m.duration) ? Math.round(m.duration * 100) / 100 : null,
  error: m.error ? m.error.code : null,
})))()`;

const bodyText = `document.querySelector('.markdown-body')?.innerText || ''`;

// A real clip, because the point of the check is that Chromium decodes what
// main served. Without ffmpeg the media checks say so and stand down rather
// than passing on a file nothing could play.
function makeMedia(target, args) {
  const out = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, target], {
    encoding: "utf-8",
  });
  return out.status === 0;
}

const haveFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;

async function main() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-assets-profile-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-assets-home-"));
  tempPaths.push(userDataDir, homeDir);

  const write = async (rel, body) => {
    const full = path.join(homeDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
    return full;
  };

  await write("report/demo/shot.png", PNG);
  await write("assets/logo.png", PNG);
  // Outside both the document's folder and any workspace root.
  await write("private/secret.png", PNG);
  await write("report/spec.pdf", Buffer.from("%PDF-1.4\n"));

  if (haveFfmpeg) {
    await mkdir(path.join(homeDir, "report", "demo"), { recursive: true });
    await mkdir(path.join(homeDir, "private"), { recursive: true });
    const clipArgs = [
      "-f", "lavfi", "-i", "color=c=navy:s=160x90:d=1", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
    ];
    makeMedia(path.join(homeDir, "report", "demo", "clip.mp4"), clipArgs);
    makeMedia(path.join(homeDir, "private", "secret.mp4"), clipArgs);
    makeMedia(path.join(homeDir, "report", "demo", "take.m4a"), [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    ]);
  }

  const dataUri = `data:image/png;base64,${PNG.toString("base64")}`;
  const docPath = await write(
    "report/report.md",
    Buffer.from(
      [
        "# Report",
        "",
        "![beside](demo/shot.png)",
        "",
        `![inlined](${dataUri})`,
        "",
        "![outside](../private/secret.png)",
        "",
        "![remote](https://example.invalid/nope.png)",
        "",
        // Written the way the editor writes a resized picture: the HTML tag
        // every renderer accepts, with a width. It must open in the rich pane
        // as a picture, at that width, and not as held-aside raw HTML.
        '<img src="demo/shot.png" alt="sized" width="120">',
        "",
        "[the spec](spec.pdf)",
        "",
        "![clip](demo/clip.mp4)",
        "",
        "![take](demo/take.m4a)",
        "",
        "![hiddenclip](../private/secret.mp4)",
        "",
      ].join("\n"),
      "utf-8"
    )
  );

  releaseStaleDevLock();
  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start(path.join(root, "node_modules", ".bin", "next"), ["dev", "--turbopack", "--port", String(devPort)], {
    log: path.join(artifactDir, "next.log"),
  });
  await waitFor("dev server", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  start(
    path.join(root, "node_modules", ".bin", "electron"),
    [".", docPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    {
      env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
      log: path.join(artifactDir, "electron.log"),
    }
  );

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("document", async () => (await cdp.ev(bodyText)).includes("Report"), 40000);
  // Images load after the node renders.
  await waitFor("images", async () => (await cdp.ev(imageReport))?.length >= 5, 20000);
  await new Promise((r) => setTimeout(r, 1200));

  const images = await cdp.ev(imageReport);
  const byAlt = Object.fromEntries(images.map((i) => [i.alt, i]));

  check(
    "a picture beside the document is on screen",
    byAlt.beside?.loaded === true,
    JSON.stringify(byAlt.beside)
  );
  check(
    "it is served over the asset scheme, not the app origin",
    byAlt.beside?.scheme === "markie-asset",
    String(byAlt.beside?.scheme)
  );
  check(
    "the document keeps the relative path it was written with",
    byAlt.beside?.kept === "demo/shot.png",
    String(byAlt.beside?.kept)
  );

  check(
    "an inlined picture is on screen",
    byAlt.inlined?.loaded === true,
    JSON.stringify(byAlt.inlined)
  );
  check("an inlined picture is left inline", byAlt.inlined?.scheme === "data");

  check(
    "a picture outside the document's folder is refused",
    byAlt.outside !== undefined && byAlt.outside.loaded === false,
    JSON.stringify(byAlt.outside)
  );

  check("a remote picture is left to the network", byAlt.remote?.scheme === "https");

  // ── A picture with a chosen width ────────────────────────────────────────
  check(
    "a picture written as an HTML tag with a width is on screen in the rich pane",
    byAlt.sized?.loaded === true && byAlt.sized?.scheme === "markie-asset",
    JSON.stringify(byAlt.sized)
  );
  check(
    "it is drawn at that width",
    byAlt.sized?.drawn === 120,
    `drawn ${byAlt.sized?.drawn}px, wanted 120px`
  );
  check(
    "the one written with the markdown syntax is drawn at its own size",
    byAlt.beside?.drawn === 240,
    `drawn ${byAlt.beside?.drawn}px, wanted 240px`
  );
  check(
    "rich editing stayed on: a sized picture is not raw HTML to the guard",
    (await cdp.ev(`!!document.querySelector('.ProseMirror[contenteditable="true"]') && !document.querySelector('[data-markie-rich-guard]')`)) === true
  );

  // ── Video and audio ──────────────────────────────────────────────────────
  if (!haveFfmpeg) {
    check("media checks need ffmpeg, which is not installed", false, "brew install ffmpeg");
  } else {
    await waitFor(
      "media metadata",
      async () => {
        const m = await cdp.ev(mediaReport);
        return m.length >= 3 && m.every((x) => x.ready > 0 || x.error !== null);
      },
      30000
    );
    const media = await cdp.ev(mediaReport);
    const byName = Object.fromEntries(media.map((m) => [m.alt, m]));

    check(
      "a clip beside the document is a video element, not a broken picture",
      byName.clip?.tag === "video",
      JSON.stringify(byName.clip)
    );
    check(
      "it plays: Chromium read a header off what main served",
      byName.clip?.ready >= 1 && byName.clip?.duration > 0,
      JSON.stringify(byName.clip)
    );
    check(
      "it is served over the asset scheme",
      byName.clip?.scheme === "markie-asset",
      String(byName.clip?.scheme)
    );
    check(
      "it carries controls, so it is not a decoration",
      byName.clip?.controls === true && byName.clip?.preload === "metadata"
    );
    check(
      "audio beside the document plays too",
      byName.take?.tag === "audio" && byName.take?.ready >= 1,
      JSON.stringify(byName.take)
    );
    check(
      "a clip outside the document's folder is refused",
      byName.hiddenclip !== undefined && byName.hiddenclip.ready === 0,
      JSON.stringify(byName.hiddenclip)
    );

    // Seeking is the whole reason main answers Range requests: without a 206
    // the player can only start from the beginning.
    const seeked = await cdp.ev(`(() => {
      const v = [...document.querySelectorAll('.markdown-body video')].find((x) => x.getAttribute('alt') === 'clip');
      if (!v) return Promise.resolve('no clip');
      return new Promise((resolve) => {
        const done = () => resolve(Math.round(v.currentTime * 100) / 100);
        v.addEventListener('seeked', done, { once: true });
        setTimeout(() => resolve('timed out at ' + v.currentTime), 5000);
        v.currentTime = 0.5;
      });
    })()`);
    check("seeking into the middle of a clip works", seeked >= 0.4, String(seeked));
  }

  await shootTo(cdp, "01-assets");

  // ── The picture viewer ───────────────────────────────────────────────────
  // Real input through CDP rather than a synthetic event: Chromium decides
  // what a double-click is from two presses in one place, and the editor
  // underneath sees the same presses and gets its say first.
  const lightbox = `document.querySelector('[data-markie-lightbox]')`;
  const viewerReport = `(() => {
    const box = ${lightbox};
    if (!box) return null;
    const img = box.querySelector('img');
    return {
      scheme: (img?.getAttribute('src') || '').split(':')[0].slice(0, 24),
      alt: img?.getAttribute('alt') ?? null,
      loaded: !!img && img.complete && img.naturalWidth > 0,
      counter: box.querySelector('[data-markie-lightbox-caption]')?.textContent ?? '',
      focused: document.activeElement === box,
    };
  })()`;
  const centerOf = await cdp.ev(`(() => {
    const img = [...document.querySelectorAll('.markdown-body img')].find((i) => i.getAttribute('alt') === 'beside');
    if (!img) return null;
    img.scrollIntoView({ block: 'center' });
    const r = img.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check("the picture is somewhere a pointer can reach", !!centerOf, JSON.stringify(centerOf));
  if (centerOf) {
    const mouse = async (type, clickCount) =>
      cdp.send("Input.dispatchMouseEvent", {
        type,
        x: centerOf.x,
        y: centerOf.y,
        button: "left",
        clickCount,
      });
    await mouse("mousePressed", 1);
    await mouse("mouseReleased", 1);
    check("one click does not open the viewer while editing", (await cdp.ev(viewerReport)) === null);
    await mouse("mousePressed", 2);
    await mouse("mouseReleased", 2);
    const opened = await waitFor("viewer", () => cdp.ev(viewerReport), 5000).catch(() => null);
    check(
      "a double-click opens the viewer on that picture",
      opened?.alt === "beside" && opened?.loaded === true && opened?.scheme === "markie-asset",
      JSON.stringify(opened)
    );
    check("the viewer has the keyboard", opened?.focused === true);
    check("it counts every picture in the document", opened?.counter?.includes("1 / 5") === true, String(opened?.counter));
    await shootTo(cdp, "02-lightbox");

    const key = async (name, code) => {
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: name,
          code: name,
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
        });
      }
    };
    await key("ArrowRight", 39);
    let now = await cdp.ev(viewerReport);
    check(
      "the right arrow moves to the next picture",
      now?.alt === "inlined" && now?.scheme === "data" && now?.counter?.includes("2 / 5"),
      JSON.stringify(now)
    );
    await key("ArrowLeft", 37);
    now = await cdp.ev(viewerReport);
    check("the left arrow moves back", now?.alt === "beside", JSON.stringify(now));
    await key("Escape", 27);
    await new Promise((r) => setTimeout(r, 300));
    check("Escape closes it", (await cdp.ev(viewerReport)) === null);
    check(
      "the document is still there underneath, untouched by the arrows",
      (await cdp.ev(bodyText)).includes("Report") && (await cdp.ev(imageReport))?.length >= 5
    );
  }

  // ── The document's markdown is not rewritten ─────────────────────────────
  const onDisk = await readFile(docPath, "utf-8");
  check(
    "nothing on disk was touched by rendering it",
    onDisk.includes("![beside](demo/shot.png)") &&
      (!haveFfmpeg || onDisk.includes("![clip](demo/clip.mp4)")) &&
      !onDisk.includes("markie-asset"),
  );

  // ── Links to files beside the document ───────────────────────────────────
  const opened = await cdp.ev(`(() => {
    const a = [...document.querySelectorAll('.markdown-body a')].find((x) => x.textContent.includes('the spec'));
    if (!a) return 'no link';
    a.click();
    return 'clicked';
  })()`);
  check("a link to a file beside the document is there to click", opened === "clicked");
  await new Promise((r) => setTimeout(r, 1500));
  check(
    "clicking it does not navigate the window away from the app",
    (await cdp.ev(bodyText)).includes("Report")
  );

  // ── Resizing a picture by its corner ─────────────────────────────────────
  // Last, because it is the one thing here that is meant to change the file.
  const selectBeside = await cdp.ev(`(() => {
    const img = [...document.querySelectorAll('.markdown-body img')].find((i) => i.getAttribute('alt') === 'beside');
    if (!img) return null;
    img.scrollIntoView({ block: 'center' });
    const r = img.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: Math.round(r.width) };
  })()`);
  if (selectBeside) {
    const mouseAt = (type, x, y, extra = {}) =>
      cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
    await mouseAt("mousePressed", selectBeside.x, selectBeside.y);
    await mouseAt("mouseReleased", selectBeside.x, selectBeside.y);
    await new Promise((r) => setTimeout(r, 300));
    const handle = await cdp.ev(`(() => {
      const frame = document.querySelector('.markie-media.ProseMirror-selectednode');
      if (!frame) return { selected: false };
      const h = frame.querySelector('[data-resize-handle="bottom-right"]');
      if (!h) return { selected: true, handle: false };
      const r = h.getBoundingClientRect();
      return {
        selected: true,
        handle: true,
        visible: getComputedStyle(h).opacity === '1',
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    })()`);
    check("clicking a picture selects it and shows its corner handles", handle?.visible === true, JSON.stringify(handle));
    if (handle?.handle) {
      // What is actually under the pointer, and what the view thinks is
      // happening at each step: a drag that does nothing is otherwise
      // indistinguishable from a drag that never started.
      const dragState = () => cdp.ev(`(() => {
        const frame = document.querySelector('.markie-media.ProseMirror-selectednode') || document.querySelector('.markie-media');
        const img = frame?.querySelector('img');
        return {
          under: document.elementFromPoint(${handle.x}, ${handle.y})?.getAttribute('data-resize-handle') ?? document.elementFromPoint(${handle.x}, ${handle.y})?.tagName,
          resizing: frame?.dataset.resizeState ?? null,
          styleWidth: img?.style.width ?? null,
        };
      })()`);
      const before = await dragState();
      check("the handle is the thing under the pointer", before?.under === "bottom-right", JSON.stringify(before));
      // A drag of 60px towards the top-left on the bottom-right corner, in
      // steps the way a hand moves, then let go.
      await mouseAt("mousePressed", handle.x, handle.y);
      const pressed = await dragState();
      for (let step = 1; step <= 6; step++) {
        await mouseAt("mouseMoved", handle.x - step * 10, handle.y - step * 5, { buttons: 1 });
        await new Promise((r) => setTimeout(r, 30));
      }
      const moved = await dragState();
      await mouseAt("mouseReleased", handle.x - 60, handle.y - 30);
      await new Promise((r) => setTimeout(r, 400));
      check(
        "pressing the handle starts a resize, and moving changes the picture",
        pressed?.resizing === "true" && /px$/.test(moved?.styleWidth ?? ""),
        `pressed ${JSON.stringify(pressed)}, moved ${JSON.stringify(moved)}`
      );

      const after = await cdp.ev(`(() => {
        const ed = window.__markieEditor;
        const attrs = ed ? ed.getAttributes('image') : null;
        const img = [...document.querySelectorAll('.markdown-body img')].find((i) => i.getAttribute('alt') === 'beside');
        return {
          width: attrs ? attrs.width : null,
          drawn: img ? Math.round(img.getBoundingClientRect().width) : null,
          markdown: ed ? ed.storage.markdown.getMarkdown() : '',
        };
      })()`);
      check(
        "dragging the corner makes the picture smaller on screen",
        after?.drawn !== null && after.drawn < selectBeside.width && after.drawn >= 150,
        `${selectBeside.width}px before, ${after?.drawn}px after`
      );
      check(
        "the width lands on the document node as whole pixels",
        Number.isInteger(after?.width) && after.width === after.drawn,
        JSON.stringify({ width: after?.width, drawn: after?.drawn })
      );
      const tag = new RegExp(`<img src="demo/shot.png" alt="beside" width="${after?.width}">`);
      check(
        "the document now says so as the img tag every renderer accepts",
        tag.test(after?.markdown ?? ""),
        (after?.markdown ?? "").split("\n").find((l) => l.includes("shot.png")) ?? "(no line)"
      );
      check(
        "and only for that picture: the others are still plain markdown",
        (after?.markdown ?? "").includes("![inlined](data:") &&
          (!haveFfmpeg || (after?.markdown ?? "").includes("![clip](demo/clip.mp4)"))
      );

      // Autosave writes it to disk; the file is the only thing that outlives
      // the window.
      const onDiskAfter = await waitFor(
        "autosave",
        async () => {
          const text = await readFile(docPath, "utf-8");
          return tag.test(text) ? text : null;
        },
        15000
      ).catch(() => null);
      check("autosave writes the sized picture to the file", onDiskAfter !== null);
      check(
        "everything else in the file is byte for byte what it was",
        onDiskAfter !== null &&
          onDiskAfter.includes("![inlined](data:") &&
          onDiskAfter.includes('<img src="demo/shot.png" alt="sized" width="120">') &&
          onDiskAfter.includes("[the spec](spec.pdf)") &&
          !onDiskAfter.includes("markie-asset") &&
          !onDiskAfter.includes("![beside](demo/shot.png)")
      );
      await shootTo(cdp, "03-resized");
    }
  }

  cdp.close();
  const failed = checks.filter((c) => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((c) => c.name).join(", ")}\n`);
  return failed.length === 0;
}

async function shootTo(cdp, name) {
  await new Promise((r) => setTimeout(r, 450));
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(path.join(artifactDir, `${name}.png`), Buffer.from(shot.data, "base64"));
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  process.stderr.write(`local-assets-check failed: ${err.stack ?? err}\n`);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
