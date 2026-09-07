// The git object id of a folder, computed from files in memory.
//
// This exists so Markie and the Vercel CLI agree about whether an installed
// skill is up to date. The CLI stores the skill folder's **git tree object id**
// in ~/.agents/.skill-lock.json (it reads it straight off GitHub's tree API)
// and compares that against the repository's current tree id. Any other digest
// makes every Markie install look outdated to the CLI, and every CLI install
// look outdated to Markie.
//
// Markie already has the folder's bytes: it downloaded the tarball. So the id
// is computed here rather than fetched, which also means no extra request and
// nothing to be rate-limited.
//
// Git's rules, in full:
//   * a blob's id is sha1("blob " + byteLength + "\0" + bytes);
//   * a tree's body is its immediate children, each `<mode> <name>\0` followed
//     by the child's 20 raw bytes of id, and its id is
//     sha1("tree " + byteLength(body) + "\0" + body);
//   * mode is 100644 for a file, 100755 when it is executable, and 40000 (no
//     leading zero) for a subtree;
//   * children sort by name compared as bytes, with a directory's name treated
//     as name + "/" — so a directory `a` sorts after a file `a-b`, because
//     "a/" is greater than "a-b".
//
// Two things git has that a tar-derived folder here does not. Empty
// directories have no object at all, and fall out naturally because a tree is
// built from the files under it. Symlinks are mode 120000 entries, and
// electron/ustar.js drops them along with every other non-file, so a skill
// folder containing one gets an id git would not agree with. No skill in the
// three default sources has one, and the cost of being wrong is a spurious
// "update available", not a bad write.
const crypto = require("crypto");

function objectId(type, body) {
  return crypto
    .createHash("sha1")
    .update(Buffer.from(`${type} ${body.length}\0`, "utf8"))
    .update(body)
    .digest();
}

// The sort key. A directory compares as though its name ended in "/"; a file's
// name simply ends, and a shorter byte string sorts first, which is the same
// answer git's NUL gives.
function sortKey(name, isTree) {
  return Buffer.from(isTree ? `${name}/` : name, "utf8");
}

// The 20 raw bytes of the tree object for this set of files, whose paths are
// relative to the folder and separated by "/".
function treeObject(files) {
  const entries = [];
  const subtrees = new Map();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    if (slash === -1) {
      entries.push({
        name: file.path,
        key: sortKey(file.path, false),
        mode: file.mode & 0o111 ? "100755" : "100644",
        id: objectId("blob", file.data),
      });
      continue;
    }
    const dir = file.path.slice(0, slash);
    const rest = file.path.slice(slash + 1);
    if (!rest) continue;
    if (!subtrees.has(dir)) subtrees.set(dir, []);
    subtrees.get(dir).push({ ...file, path: rest });
  }
  for (const [name, children] of subtrees) {
    entries.push({ name, key: sortKey(name, true), mode: "40000", id: treeObject(children) });
  }
  entries.sort((a, b) => Buffer.compare(a.key, b.key));
  const body = Buffer.concat(
    entries.map((entry) =>
      Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), entry.id])
    )
  );
  return objectId("tree", body);
}

/**
 * The git tree object id of a folder.
 *
 * @param {{ path: string, data: Buffer, mode: number }[]} files
 *   every file in the folder, by its path relative to it
 * @returns {string} the id, 40 hex characters, the same one
 *   `git rev-parse HEAD:<folder>` prints
 */
function treeId(files) {
  return treeObject(files || []).toString("hex");
}

module.exports = { treeId };
