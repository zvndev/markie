// Run the unchanged Node MCP against Markie RS only. Never discover or launch
// Electron. This adapter is retired when the MCP itself is ported to Rust.
import { registerHooks } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// The public Mac app keeps Electron's server in mcp-server/, because its
// mcp/markie-mcp.mjs is the hand-over to this file (rust/scripts/stage-mcp.sh).
// The nightly and the dev build keep it in mcp/.
const bundled = [join(here, "mcp-server", "markie-mcp.mjs"), join(here, "mcp", "markie-mcp.mjs")].find((file) => existsSync(file));
const server = pathToFileURL(resolve(process.env.MARKIE_RS_MCP_SERVER ||
  bundled || join(here, "../../../../mcp/markie-mcp.mjs")));
const client = new URL("./agent-client.mjs", server);
// Which build this adapter belongs to: the name the app answers with, and the
// name of its data folder. The Mac app ("Markie", data in "Markie Nightly" on
// the super-nightly channel, "Markie App" on the public feeds) says so in
// app-identity.json beside this file, written by the bundle script and
// covered by the bundle's signature. Only those exact pairs are honoured;
// anything else is the dev build.
let appName = "Markie RS", profileName = "Markie RS";
try {
  const identity = JSON.parse(readFileSync(join(here, "app-identity.json"), "utf8"));
  if (identity.appName === "Markie" && ["Markie Nightly", "Markie App"].includes(identity.profileName)) ({ appName, profileName } = identity);
} catch { /* The dev build and a source checkout have no such file. */ }
const base = process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support")
  : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const directory = resolve(process.env.MARKIE_RS_DATA_DIR || join(base, profileName), "agent");
let realDirectory;
try { realDirectory = realpathSync(directory); } catch { realDirectory = directory; }

function replaceOnce(source, needle, replacement) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("This Node MCP version is not compatible with the Markie RS adapter.");
  }
  return source.slice(0, at) + replacement + source.slice(at + needle.length);
}

registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url !== client.href && url !== server.href) return loaded;
    let source = Buffer.from(loaded.source).toString("utf8");
    if (url === client.href) {
      source = replaceOnce(source, 'dir = join(homedir(), ".markie")', `dir = ${JSON.stringify(directory)}`);
      source = replaceOnce(source, "launch = launchMarkie", "launch = () => false");
      source = replaceOnce(source, "Open the Markie app, sign in to Markie Cloud", `Open ${appName}, sign in to Markie Cloud`);
      // Accept only this app's live listener. Never follow a discovery entry
      // naming another app's socket, including through relative paths.
      source = replaceOnce(source, "&& isAlive(info.pid)", `&& info.app === ${JSON.stringify(appName)} && info.socket === ${JSON.stringify(join(realDirectory, "markie-rs.sock"))} && isAlive(info.pid)`);
    } else {
      source = replaceOnce(source,
        `const launcher = markieOpenCommand(g.path);
      if (!launcher.ok) throw new Error(launcher.error);
      const child = spawn(launcher.command, launcher.args, {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      return launcher.message;`,
        `return await askMarkie("open_in_markie", { path: g.path }, {
        notRunning: ${JSON.stringify(`${appName} isn't running. Open ${appName} and try again.`)},
      });`);
    }
    return { ...loaded, source };
  },
});

await import(server.href);
