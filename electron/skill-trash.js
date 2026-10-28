// Moving one installed skill to the Trash, from the Skills panel.
//
// The renderer names a folder; this decides whether it is one Markie may
// throw away. Only a folder that sits directly in one of the tool skills
// folders the markdown index scans (~/.claude/skills, ~/.agents/skills, a
// moved CLAUDE_CONFIG_DIR/skills, ...) qualifies. Both sides are compared by
// their real paths, so a symlink that points out of those folders, or a path
// spelled with `..`, is refused rather than followed. A project's own
// .claude/skills is not on the list: it belongs to the project.
//
// It goes to the Trash, never straight to deletion, so a wrong click is one
// drag back out.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { allowlist, skillRoots } = require("./mdindex");

/** Every tool skills folder the index reads, once each. */
function skillDirs(home = os.homedir(), env = process.env) {
  const dirs = [
    ...allowlist(home, env).filter((d) => path.basename(d) === "skills"),
    ...skillRoots(home, env).map(([, root]) => path.join(root, "skills")),
  ];
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

function createSkillTrash({
  dirs = () => skillDirs(),
  trashItem,
  realpath = fs.realpathSync.native || fs.realpathSync,
  stat = fs.statSync,
  platform = process.platform,
} = {}) {
  const fold = (p) => (platform === "win32" ? p.toLowerCase() : p);
  const real = (p) => {
    try {
      return realpath(p);
    } catch {
      return null;
    }
  };

  /** The real folder to trash, or why it may not be. */
  function check(folder) {
    if (typeof folder !== "string" || !folder.trim() || !path.isAbsolute(folder)) {
      return { error: "That is not a skill folder." };
    }
    const target = real(path.resolve(folder));
    if (!target) return { error: "That skill folder is not there any more." };
    let isDir = false;
    try {
      isDir = stat(target).isDirectory();
    } catch {
      /* gone between the two calls */
    }
    if (!isDir) return { error: "That is not a skill folder." };
    const parent = fold(path.dirname(target));
    const inside = dirs()
      .map(real)
      .filter(Boolean)
      .some((dir) => fold(dir) === parent);
    if (!inside) return { error: "Markie only removes skills from your agents' skills folders." };
    return { path: target };
  }

  async function trash(folder) {
    const found = check(folder);
    if (!found.path) return { ok: false, error: found.error };
    await trashItem(found.path);
    return { ok: true };
  }

  return { check, trash };
}

module.exports = { createSkillTrash, skillDirs };
