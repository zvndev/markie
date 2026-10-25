import { useEffect, useMemo, useState } from "react";
import { getElectronAPI } from "@/lib/electron";
import { CopyBlock } from "@/components/copy-block";
import { RemoteAgentsPanel } from "@/components/remote-agents-panel";

interface AgentsDialogProps {
  onClose: () => void;
  /** Passed to the Remote agents panel: true while a new token has not been copied. */
  onSecretShownChange?: (shown: boolean) => void;
}

// Mirrors TOOLS in mcp/markie-mcp.mjs. The markdown-only originals stay in the
// server for configs that already name them, so they get one line here.
const TOOLS: [string, string][] = [
  ["markie_find_documents", "find any document by name, path or type"],
  ["markie_search_documents", "search inside documents, Word and RTF too"],
  ["markie_read_document", "read any document, Word and RTF as plain text"],
  ["markie_write_document", "write markdown, text and data files, home folder only"],
  ["markie_open_in_markie", "open any document here in Markie"],
  ["markie_list_skills", "list your agent and skill files, grouped by tool"],
  ["markie_check_md", "say which pictures, clips and tags in a document will not show"],
  ["markie_cloud_sync", "put a file in your Markie Cloud and hand back its private link"],
  ["markie_cloud_public_link", "a public link, only when you ask for one, and you confirm it"],
  ["markie_guide", "what Markie renders and which types each tool handles"],
  ["markie_*_md", "markdown-only find, read and write, for older setups"],
];

// The front matter an agent writes when it declares where a document belongs.
const FRONT_MATTER_EXAMPLE = `---
markie:
  project: bevrly
  block: checkout-redesign
---`;

// Shown when we can't resolve the real bundled path (web/dev preview).
const FALLBACK_PATH =
  "/Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs";

export function AgentsDialog({ onClose, onSecretShownChange }: AgentsDialogProps) {
  const [serverPath, setServerPath] = useState<string | null>(null);
  const [cloudAlways, setCloudAlways] = useState(false);
  const [showRemote, setShowRemote] = useState(false);

  useEffect(() => {
    getElectronAPI()
      ?.agentPermissions?.()
      .then((p) => setCloudAlways(p.cloudSync))
      .catch(() => setCloudAlways(false));
  }, []);

  useEffect(() => {
    getElectronAPI()
      ?.mcpInfo?.()
      .then((i) => setServerPath(i.serverPath))
      .catch(() => setServerPath(null));
  }, []);

  // While the Remote agents panel is open it owns Escape, and closing it
  // should leave this dialog where it was.
  useEffect(() => {
    if (showRemote) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, showRemote]);

  const p = serverPath ?? FALLBACK_PATH;
  const claudeCmd = useMemo(() => `claude mcp add markie -- node ${p}`, [p]);
  const codexCfg = useMemo(
    () => `[mcp_servers.markie]\ncommand = "node"\nargs = ["${p}"]`,
    [p]
  );

  return (
    <div
      className="markie-scrim fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel w-[520px] max-w-[94vw] max-h-[86vh] overflow-y-auto rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-agents-title"
        // The Remote agents panel is modal over this one: nothing here can be
        // tabbed to, clicked or read out while it is open.
        inert={showRemote}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 id="markie-agents-title" className="text-[14px] font-semibold text-foreground">
            Connect an agent to Markie
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="markie-overlay-close"
          >
            ×
          </button>
        </div>
        <p className="text-[12px] text-muted leading-relaxed mb-2.5">
          Hand your agent the documents on this computer. It can find a
          document by name, search inside it, read it, write a new one, and
          open it here in Markie: your notes and docs, Word, RTF and
          OpenDocument files, CSV, JSON and YAML, and your agent files too
          (<code>CLAUDE.md</code>, <code>AGENTS.md</code>,{" "}
          <code>~/.claude/skills</code>, <code>~/.codex</code>).
        </p>
        <p className="text-[12px] text-muted leading-relaxed mb-2.5">
          Word, RTF, OpenDocument and HTML files stay read-only to agents. An
          agent reads their text and opens them here for you to edit, so their
          formatting is never overwritten.
        </p>
        <p className="text-[12px] leading-relaxed mb-4 text-[var(--status-green)]">
          Runs on demand, on this computer. Nothing is uploaded unless you let
          an agent put a file in your Markie Cloud.
        </p>

        <div className="markie-overlay-section mb-1.5">
          Tools it gives your agent
        </div>
        <div className="flex flex-col gap-1 mb-4">
          {TOOLS.map(([name, desc]) => (
            <div key={name} className="flex gap-2 text-[12px]">
              <code className="text-foreground/90 shrink-0">{name}</code>
              <span className="text-muted truncate">{desc}</span>
            </div>
          ))}
        </div>

        <div className="markie-overlay-section mb-1.5">
          Markie Cloud
        </div>
        <p className="text-[12px] text-muted leading-relaxed mb-2">
          Ask an agent for a private Markie copy of something and it puts the
          file in your Cloud and hands you a private link. That link opens only
          for you, after you sign in, on any browser or phone. Markie asks you
          before the first upload. A public link is only made when you ask for
          one, and Markie confirms it with you every time.
        </p>
        <label className="flex items-center gap-2 text-[12px] text-foreground mb-4">
          <input
            type="checkbox"
            checked={cloudAlways}
            onChange={(e) => {
              const next = e.target.checked;
              void getElectronAPI()?.setAgentPermissions?.({ cloudSync: next }).then((r) => setCloudAlways(r.cloudSync)).catch(() => {});
            }}
          />
          Let agents put files in Markie Cloud without asking
        </label>

        <div className="markie-overlay-section mb-1.5">
          Remote agents
        </div>
        <p className="text-[12px] text-muted leading-relaxed mb-2">
          An agent that is not on this computer, such as Claude on your phone,
          can make documents in your Cloud with a token. Create and revoke
          tokens here.
        </p>
        <button
          onClick={() => setShowRemote(true)}
          className="markie-overlay-button text-[12px] px-3 py-1 rounded-md bg-accent text-foreground hover:opacity-90 mb-4"
        >
          Remote agents&hellip;
        </button>

        <div className="markie-overlay-section mb-1.5">
          It files what it writes
        </div>
        <p className="text-[12px] text-muted leading-relaxed mb-2">
          Every connected agent is handed Markie&rsquo;s organization
          conventions when it starts, so it declares which project and block a
          document belongs to as it writes:
        </p>
        <pre className="text-[11.5px] leading-relaxed bg-background border border-border rounded-md p-2.5 mb-2 overflow-x-auto text-foreground/90">
          {FRONT_MATTER_EXAMPLE}
        </pre>
        <p className="text-[12px] text-muted leading-relaxed mb-4">
          New documents arrive organized in Projects instead of loose on disk,
          and nothing moves on your disk to make it happen. Works with Claude
          Code, Codex, and any other MCP client.
        </p>

        <CopyBlock
          label="Claude Code"
          hint="run this in your terminal"
          text={claudeCmd}
        />
        <CopyBlock
          label="Codex"
          hint="add to ~/.codex/config.toml"
          text={codexCfg}
        />

        <p className="text-[11px] text-muted leading-relaxed mt-3">
          Needs <code>node</code> on your PATH. After adding it, ask your agent to{" "}
          <em>“list my Markie skills”</em> or <em>“search my documents for X.”</em>
          {!serverPath && (
            <>
              {" "}
              <span className="text-[var(--status-yellow)]">
                Open this from the Markie desktop app to auto-fill the exact
                server path.
              </span>
            </>
          )}
        </p>
      </div>
      {showRemote && <RemoteAgentsPanel onClose={() => setShowRemote(false)} onSecretShownChange={onSecretShownChange} />}
    </div>
  );
}
