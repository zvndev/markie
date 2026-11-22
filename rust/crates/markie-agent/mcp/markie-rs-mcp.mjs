// Run the unchanged Node MCP against Markie RS only. Never discover or launch
// Electron. This adapter is retired when the MCP itself is ported to Rust.
import { registerHooks } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const bundled = join(here, "mcp", "markie-mcp.mjs");
const server = pathToFileURL(resolve(process.env.MARKIE_RS_MCP_SERVER ||
  (existsSync(bundled) ? bundled : join(here, "../../../../mcp/markie-mcp.mjs"))));
const client = new URL("./agent-client.mjs", server);
const base = process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support")
  : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const directory = resolve(process.env.MARKIE_RS_DATA_DIR || join(base, "Markie RS"), "agent");
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
      source = replaceOnce(source, "Open the Markie app, sign in to Markie Cloud", "Open Markie RS, sign in to Markie Cloud");
      // Accept only this app's live listener. Never follow a discovery entry
      // naming another app's socket, including through relative paths.
      source = replaceOnce(source, "&& isAlive(info.pid)", `&& info.app === "Markie RS" && info.socket === ${JSON.stringify(join(realDirectory, "markie-rs.sock"))} && isAlive(info.pid)`);
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
        notRunning: "Markie RS isn't running. Open Markie RS and try again.",
      });`);
    }
    return { ...loaded, source };
  },
});

await import(server.href);
