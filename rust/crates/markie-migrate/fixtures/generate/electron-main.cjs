// Writes gen.ts's fixture data through a real Electron, the same one Markie
// ships, into a scratch userData folder. Run twice: phase 1 writes, phase 2
// reopens (so LevelDB turns phase 1's log into a table) and overwrites.
//
//   Electron electron-main.cjs <fixture-data.json> <scratch userData> <1|2>
//
// It refuses any userData inside ~/Library/Application Support.
const { app, BrowserWindow, protocol, session } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

const [dataFile, userData, phase] = process.argv.slice(-3);
const real = path.join(os.homedir(), "Library", "Application Support");
if (!userData || path.resolve(userData).startsWith(real)) throw new Error("refusing a userData folder that is not scratch");
app.setName("markie-fixture");
// No Dock icon and no menu bar: the window is never shown, and nothing on
// screen changes while the fixture is written.
if (process.platform === "darwin") app.setActivationPolicy?.("prohibited");
app.setPath("userData", path.resolve(userData));
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));

function pageScript() {
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const decodeRecord = (r) => ({ ...r, bytes: fromB64(r.bytes) });
  const open = (name, upgrade) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  return async (data, phase) => {
    const vault = await open("markie-encrypted-vault", (db) => db.createObjectStore("vault"));
    if (phase === "1") {
      for (const [key, value] of Object.entries(data.localStorage1)) localStorage.setItem(key, value);
      let tx = vault.transaction("vault", "readwrite", { durability: "strict" });
      tx.objectStore("vault").put(data.phase1, "snapshot");
      await done(tx);
      const library = await open("markie-document-library", (db) => {
        db.createObjectStore("documents", { keyPath: "id" });
        db.createObjectStore("recovery", { keyPath: ["documentId", "revision"] });
      });
      tx = library.transaction(["documents", "recovery"], "readwrite");
      for (const row of data.libraryRows.documents) tx.objectStore("documents").put(decodeRecord(row));
      for (const row of data.libraryRows.recovery) tx.objectStore("recovery").put({ ...row, record: decodeRecord(row.record) });
      await done(tx);
      library.close();
    } else {
      // Filler first, so both LevelDBs flush phase 1 into .ldb tables and
      // phase 2 lands in a fresh log, as in a long-used real profile.
      const filler = await open("fixture-filler", (db) => db.createObjectStore("rows"));
      const chunk = "filler ".repeat(1200);
      for (let batch = 0; batch < 10; batch++) {
        const fill = filler.transaction("rows", "readwrite");
        for (let i = 0; i < 100; i++) fill.objectStore("rows").put(`${batch}-${i}-${chunk}`, batch * 100 + i);
        await done(fill);
      }
      filler.close();
      await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase("fixture-filler"); r.onsuccess = resolve; r.onerror = () => reject(r.error); });
      for (let i = 0; i < 3000; i++) localStorage.setItem(`fixture.filler.${i}`, chunk.slice(0, 1000) + i);
      for (let i = 0; i < 3000; i++) localStorage.removeItem(`fixture.filler.${i}`);
      for (const [key, value] of Object.entries(data.localStorage2.set)) localStorage.setItem(key, value);
      for (const key of data.localStorage2.remove) localStorage.removeItem(key);
      const tx = vault.transaction("vault", "readwrite", { durability: "strict" });
      tx.objectStore("vault").put(data.phase2, "snapshot");
      await done(tx);
    }
    vault.close();
    return localStorage.length;
  };
}

app.whenReady().then(async () => {
  protocol.handle("app", () => new Response("<!doctype html><title>fixture</title>", { headers: { "content-type": "text/html" } }));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL("app://markie/index.html");
  const count = await win.webContents.executeJavaScript(`(${pageScript})()(${JSON.stringify(data)}, ${JSON.stringify(phase)})`);
  console.log(`phase ${phase}: localStorage has ${count} keys`);
  await session.defaultSession.flushStorageData();
  await new Promise((r) => setTimeout(r, 1500));
  win.close();
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
