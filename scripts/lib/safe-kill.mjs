// Kill ONLY the child we spawned, never a process group.
//
// The scripts here used to spawn Electron with `detached: true` and clean up
// with `process.kill(-child.pid, "SIGKILL")` — a negative pid, which kills the
// whole process group. On macOS that is dangerous: Electron re-launches itself
// through LaunchServices (launchViaCSUA), so the real app process leaves the
// group, the launcher pid gets recycled, and the group-kill lands on whatever
// now holds that pgid. On 2026-08-24 that was `coreservices.uiagent` and a
// long-lived user service — killing the uiagent took Finder and the login
// session down with it.
//
// A real ChildProcess.kill(signal) signals just that one process; the Electron
// main process reaps its own helpers as it quits. A leftover Electron is a
// nuisance; killing Finder is a catastrophe. Direct-child kill only.
export function safeKill(child, signal = "SIGKILL") {
  if (!child) return;
  // A pseudo-child (e.g. a local server wrapped as { kill }) carries no pid.
  if ("pid" in child && (typeof child.pid !== "number" || child.pid <= 1)) {
    // Still let it clean up through its own kill(), just never via a group.
    if (typeof child.kill === "function" && !("exitCode" in child && child.exitCode !== null)) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}
