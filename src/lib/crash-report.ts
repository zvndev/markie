// Turning something that went wrong into something we can act on.
//
// Markie had no crash reporting of any kind: a render error took the window to
// a blank screen, wrote nothing anywhere, and left the user to relaunch and the
// developer to guess. The first question about any crash is "which build, doing
// what", so a report that is only a stack is barely better than no report.
//
// Two rules shape what goes in here:
//
//   - It must never throw. This runs on the failure path, and a reporter that
//     dies while reporting turns a recoverable render error into a silent one.
//     Everything below tolerates a non-Error being thrown, because promise
//     rejections routinely carry strings, DOM events, or nothing at all.
//   - It must never carry document content. Reports are written to a log the
//     user may hand to us, and Markie is a local-first app whose whole promise
//     is that documents stay on the machine.

/** Where the failure surfaced, which is usually the fastest triage signal. */
export type CrashSource =
  | "render" // a React render/lifecycle threw; the error boundary caught it
  | "window-error" // window.onerror
  | "unhandled-rejection" // a promise nobody caught
  | "main"; // the Electron main process

export interface CrashEnv {
  version: string;
  platform: string;
  /** The view the user was in. Cheap, and it narrows a crash enormously. */
  mode?: string;
}

export interface CrashRecord {
  at: string;
  source: CrashSource;
  message: string;
  stack: string;
  componentStack?: string;
  version: string;
  platform: string;
  mode?: string;
}

// Long enough for any real stack, short enough that a runaway recursion cannot
// fill the disk with one report.
const MAX_STACK = 8192;

function clamp(text: string): string {
  return text.length > MAX_STACK ? `${text.slice(0, MAX_STACK - 20)}\n… truncated` : text;
}

/** Describe whatever was thrown, without assuming it was an Error. */
function describe(thrown: unknown): { message: string; stack: string } {
  if (thrown instanceof Error) {
    return {
      message: thrown.message || thrown.name || "Unknown error",
      stack: clamp(thrown.stack ?? `${thrown.name}: ${thrown.message}`),
    };
  }
  if (typeof thrown === "string" && thrown.trim()) {
    return { message: thrown, stack: "" };
  }
  try {
    const json = JSON.stringify(thrown);
    // "undefined" and "null" read as noise; name the shape instead so the
    // report says something true rather than something empty.
    return {
      message: json && json !== "null" ? `Non-error thrown: ${json}` : `Non-error thrown: ${String(thrown)}`,
      stack: "",
    };
  } catch {
    return { message: `Non-error thrown: ${String(thrown)}`, stack: "" };
  }
}

export function crashReport(opts: {
  error: unknown;
  source: CrashSource;
  env: CrashEnv;
  now?: number;
  componentStack?: string;
}): CrashRecord {
  const { message, stack } = describe(opts.error);
  const record: CrashRecord = {
    at: new Date(opts.now ?? Date.now()).toISOString(),
    source: opts.source,
    message,
    stack,
    version: opts.env.version,
    platform: opts.env.platform,
  };
  if (opts.env.mode) record.mode = opts.env.mode;
  // React's component stack names the component that blew up, which is usually
  // the whole diagnosis.
  if (opts.componentStack) record.componentStack = clamp(opts.componentStack);
  return record;
}

/** A block of text the user can copy straight into a bug report. */
export function formatCrashDetails(record: CrashRecord): string {
  const lines = [
    `Markie ${record.version} (${record.platform})`,
    `${record.at} — ${record.source}`,
    "",
    record.message,
  ];
  if (record.stack) lines.push("", record.stack);
  if (record.componentStack) lines.push("", "Component stack:", record.componentStack);
  return lines.join("\n");
}
