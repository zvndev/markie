// Which cloud document a folder belongs to, and the reference a requested
// absolute path is under it, if the path does not walk out of that folder.
//
// The renderer names the folder; a registry row for a file directly inside
// it names the cloud id. Several documents can share a folder, so the first
// row that is in the cloud wins.
//
// Pure and dependency-injected — `cloudDocsInDir` is registry.cloudDocsInDir
// in production and whatever a test wants to answer with everywhere else —
// so this can be unit tested without a database, and the caller in main.js
// can wrap it in a try/catch of its own for when the real one throws.
const path = require("node:path");

function cloudDocFor({ docDir, requested, cloudDocsInDir }) {
  const rel = path.relative(docDir, requested);
  // `rel.startsWith("..")` alone refuses a child folder literally named
  // "..hidden" along with an actual walk upward: the only two shapes a walk
  // upward can take are the parent itself ("..") and anything under it
  // ("../" + more).
  const escapes = path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep);
  if (escapes) return null;
  const ref = rel.split(path.sep).join("/");
  const rows = cloudDocsInDir(docDir);
  return rows.length > 0 ? { cloudId: rows[0].cloud_doc_id, ref } : null;
}

module.exports = { cloudDocFor };
