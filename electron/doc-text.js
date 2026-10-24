// Plain text for search, pulled out of every document type Markie indexes.
//
// The extraction and ranking live in mcp/doc-text.cjs, because the Markie MCP
// server runs the very same search for agents and ships outside the asar,
// where it may never reach back into electron/. This file only re-exports that
// module so the app's global search (Shift-Command-F) and an agent's
// markie_search_documents can never drift apart. doc-text-path.js says which
// copy, because the public build has it in Resources rather than the asar.
const { resolveDocText } = require("./doc-text-path");

/** @type {typeof import("../mcp/doc-text.cjs")} */
module.exports = require(resolveDocText());
