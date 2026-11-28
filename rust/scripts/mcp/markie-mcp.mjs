// Contents/Resources/mcp/markie-mcp.mjs in the public Mac app.
//
// Markie on Apple silicon is the Rust app. Agents set up for Electron Markie
// run `node /Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs`,
// and that path keeps working: this file hands over to the adapter beside the
// folder, which runs Electron Markie's own MCP server (pinned, in
// ../mcp-server) against this app's agent bridge. It never discovers,
// launches or talks to Electron. rust/scripts/stage-mcp.sh puts it here.
await import(new URL("../markie-rs-mcp.mjs", import.meta.url));
