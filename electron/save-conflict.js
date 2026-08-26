// One rule for what a save may do when the file changed underneath us.
// Extracted from main.js so the autosave-must-never-dialog invariant is a
// tested fact instead of an if-statement nobody can see.
//
// force means the renderer already put the question to the user (the in-app
// conflict dialog) and they chose to overwrite; asking again would be a second
// prompt for an answered question. autosave means nobody is looking: a dialog
// would interrupt typing, and a blind write would destroy the other writer's
// work, so the only correct move is to refuse and let the renderer surface its
// non-modal strip.
//
// `changed` is the newer on-disk content, or null when nothing moved. It is
// compared against null on purpose: a file an agent truncated to nothing is
// still a change, and `if (changed)` would have written straight over it.
function saveConflictAction({ autosave = false, force = false, changed = null } = {}) {
  if (force || changed === null) return "proceed";
  return autosave ? "refuse" : "ask";
}

module.exports = { saveConflictAction };
