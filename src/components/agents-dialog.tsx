"use client";

import { useEffect, useMemo, useState } from "react";
import { getElectronAPI } from "@/lib/electron";

interface AgentsDialogProps {
  onClose: () => void;
}

const TOOLS: [string, string][] = [
  ["markie_find_md", "find markdown anywhere on this computer, by name or path"],
  ["markie_read_md", "read a markdown file"],
  ["markie_write_md", "write a markdown file, inside your home folder only"],
  ["markie_list_skills", "list your agent and skill files, grouped by tool"],
  ["markie_open_in_markie", "open a file rendered in Markie"],
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

export function AgentsDialog({ onClose }: AgentsDialogProps) {
  const [serverPath, setServerPath] = useState<string | null>(null);

  useEffect(() => {
    getElectronAPI()
      ?.mcpInfo?.()
      .then((i) => setServerPath(i.serverPath))
      .catch(() => setServerPath(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
          Hand your agent the markdown on this computer. It can find a document
          by name, read it, write a new one, and open it here in Markie: your
          notes and docs, and your agent files too (<code>CLAUDE.md</code>,{" "}
          <code>AGENTS.md</code>, <code>~/.claude/skills</code>,{" "}
          <code>~/.codex</code>).
        </p>
        <p className="text-[12px] leading-relaxed mb-4 text-[var(--status-green)]">
          Runs on demand, on this computer. Nothing is uploaded.
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
          <em>“list my Markie skills”</em> or <em>“find my markdown about X.”</em>
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
    </div>
  );
}

function CopyBlock({
  label,
  hint,
  text,
}: {
  label: string;
  hint: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked — user can select manually */
      }
    );
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted">
          <span className="uppercase tracking-wide font-semibold">{label}</span>{" "}
          <span>{hint}</span>
        </span>
        <button
          onClick={copy}
          className="markie-overlay-button text-[11px] px-2 py-0.5 rounded-md bg-accent text-foreground hover:opacity-90"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="text-[11.5px] leading-relaxed bg-background border border-border rounded-md p-2.5 overflow-x-auto text-foreground/90 whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}
