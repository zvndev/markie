// Plain text for search, pulled out of every document type Markie indexes.
//
// The extraction and ranking live in mcp/doc-text.cjs, because the Markie MCP
// server runs the very same search for agents and ships outside the asar,
// where it may never reach back into electron/. This file only re-exports that
// module so the app's global search (Shift-Command-F) and an agent's
// markie_search_documents can never drift apart. electron-builder.config.cjs
// lists mcp/doc-text.cjs in `files`, so the require below resolves inside the
// packaged asar as it does in the repo.
module.exports = require("../mcp/doc-text.cjs");
