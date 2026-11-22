// List on-screen windows as JSON lines: {id, pid, owner, name, x, y, w, h}.
// Usage: osascript -l JavaScript windows.js [pid]
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
function run(argv) {
  const want = argv.length ? parseInt(argv[0], 10) : null;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0));
  const rows = ObjC.deepUnwrap(list) || [];
  const out = [];
  for (const w of rows) {
    if (want !== null && w.kCGWindowOwnerPID !== want) continue;
    if (w.kCGWindowLayer !== 0) continue;
    const b = w.kCGWindowBounds || {};
    if ((b.Width || 0) < 100 || (b.Height || 0) < 100) continue;
    out.push(JSON.stringify({ id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, owner: w.kCGWindowOwnerName, name: w.kCGWindowName || "", onscreen: !!w.kCGWindowIsOnscreen, x: b.X, y: b.Y, w: b.Width, h: b.Height }));
  }
  return out.join("\n");
}
