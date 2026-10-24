// Where mcp/doc-text.cjs sits depends on the build. electron-builder drops from
// the asar every file an extraResources entry also copies, so the public build,
// which ships mcp/ to Resources/mcp for the standalone server, has no
// mcp/doc-text.cjs inside the asar even though `files` names it. The private
// build has no extraResources and keeps it in the asar. The repo has it next
// door. So: the copy beside electron/ when there is one, otherwise Resources.
const fs = require("node:fs");
const path = require("node:path");

function resolveDocText(dir = __dirname, resourcesPath = process.resourcesPath, exists = fs.existsSync) {
  const beside = path.join(dir, "..", "mcp", "doc-text.cjs");
  if (exists(beside) || !resourcesPath) return beside;
  return path.join(resourcesPath, "mcp", "doc-text.cjs");
}

module.exports = { resolveDocText };
