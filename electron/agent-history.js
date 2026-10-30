// What the MCP server tells the app about a write it is about to make, so
// version history can name the agent instead of calling it an outside edit.
//
// The MCP server writes files itself, straight to disk; the app is not in that
// path and must not be (a write must work while Markie is closed). So just
// before writing, the server sends the path, the agent's name and the SHA-256
// of the bytes it will write over the agent bridge. The app keeps what the
// file says now as a version and remembers the agent as the author of those
// bytes. Whenever those bytes are later kept as a version (the open-file
// watcher sees them, or the user saves over them), they carry the agent's name.
//
// When Markie is not running there is nobody to tell, and the write shows as
// "External edit" the next time Markie sees the file. That is the limit.
//
// Pure and dependency-injected so it is tested without Electron.
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const { sanitizeAgentName } = require("./agent-cloud");

// The bridge reads the file to keep it as a version. Past this it is not a
// document anyone reads in Markie, and copying it on every agent write is not
// worth the disk.
const MAX_NOTE_BYTES = 10 * 1024 * 1024;

/**
 * @param {object} deps
 * @param {{ noteAgentWrite: (path: string, args: {agent: string, hash: string}) => object }} deps.history
 * @param {string} deps.home
 * @param {() => boolean} [deps.unlocked]  false while a private build is locked
 */
function createAgentHistory({ history, home, unlocked = () => true, fs = nodeFs }) {
  const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();

  function inHome(p) {
    for (const root of new Set([home, realHome])) {
      const rel = nodePath.relative(root, p);
      if (rel && !rel.startsWith("..") && !nodePath.isAbsolute(rel)) return true;
    }
    return false;
  }

  async function noteWrite({ path: raw, agent, sha256 }) {
    // A locked private build answers nothing about the user's files.
    if (!unlocked()) return { noted: false };
    if (typeof raw !== "string" || !nodePath.isAbsolute(raw)) throw new Error("Give the absolute path of a file.");
    const p = nodePath.resolve(raw);
    if (!inHome(p)) throw new Error("Only files in your home folder have version history.");
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("sha256 is required.");
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error(`Not a file: ${p}`);
      if (st.size > MAX_NOTE_BYTES) return { noted: false };
    } catch (err) {
      // A file the agent is creating has nothing to keep yet. History still
      // records the agent as the author of what is about to land.
      if (!err || err.code !== "ENOENT") throw err;
    }
    const res = history.noteAgentWrite(p, { agent: sanitizeAgentName(agent), hash: sha256.toLowerCase() });
    return { noted: !(res && res.skipped === "bad-hash") };
  }

  return { handlers: { history_note_write: noteWrite } };
}

module.exports = { createAgentHistory, MAX_NOTE_BYTES };
