// Which cloud document a request belongs to, and the reference the requested
// path is under it.
//
// The renderer names the open document by its own path, not by its folder:
// two synced documents can sit in one folder and reference the same missing
// picture, and answering with whichever of them was opened last would render
// one document's media inside another.
//
// Pure and dependency-injected: `get` is registry.get in production and
// whatever a test wants to answer with everywhere else, so this can be unit
// tested without a database, and the caller in main.js can wrap it in a
// try/catch of its own for when the real one throws.
const path = require("node:path");

function cloudDocFor({ docPath, requested, get }) {
  // Normalised first: the registry canonicalises what it is handed, so a
  // spelling with a "." or ".." segment in it still finds the row, and the
  // folder taken from the raw string would then name the reference wrongly.
  const resolved = path.resolve(docPath);
  const row = get(resolved);
  if (!row || !row.cloud_doc_id) return null;
  const rel = path.relative(path.dirname(resolved), requested);
  // `rel.startsWith("..")` alone would refuse a child folder literally named
  // "..hidden" along with an actual walk upward: the only two shapes a walk
  // upward can take are the parent itself ("..") and anything under it
  // ("../" + more).
  const outside = path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep);
  // A document may embed an allowed absolute path, and the uploader stored
  // that absolute string verbatim as its ref. The reading device has to ask
  // under the same name or the server holds nothing by it.
  const ref = outside ? requested : rel.split(path.sep).join("/");
  return { cloudId: row.cloud_doc_id, ref };
}

module.exports = { cloudDocFor };
