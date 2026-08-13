// Where a file dialog should open.
//
// Left unset, macOS reopens the last place any dialog was, which is why
// pressing Open while reading a document in one folder could land you
// somewhere unrelated. Starting beside the open document is almost always
// where its neighbours are.
//
// Only ever a starting directory. The file the user picks is what grants
// access, so an unusable value here costs nothing and falls back to the OS
// default.
const path = require("path");
const fs = require("fs");

function dialogStartDir(filePath, deps = fs) {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  try {
    const dir = path.dirname(filePath);
    // dirname("foo") is ".", which would open the process working directory —
    // wherever the app happened to be launched from, and never what was meant.
    if (dir === "." || dir === "") return null;
    return deps.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

module.exports = { dialogStartDir };
