"use client";

import { useEffect, useMemo, useState } from "react";
import { getElectronAPI } from "@/lib/electron";

interface AgentsDialogProps {
  onClose: () => void;
}

const TOOLS: [string, string][] = [
  ["markie_find_md", "find markdown anywhere on this Mac (name or path)"],
  ["markie_read_md", "read a markdown file"],
  ["markie_write_md", "create or edit a markdown file (guard-railed)"],
  ["markie_list_skills", "list your agent/skill files, grouped by tool"],
  ["markie_open_in_markie", "open a file rendered in Markie"],
];

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
    () =>
      `# ~/.codex/config.toml\n[mcp_servers.markie]\ncommand = "node"\nargs = ["${p}"]`,
    [p]
  );

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[520px] max-w-[94vw] max-h-[86vh] overflow-y-auto rounded-xl border border-border shadow-2xl p-5"
        style={{ background: "var(--surface-2)" }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[14px] font-semibold text-foreground">
            Connect an agent to Markie
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-foreground"
          >
            ×
          </button>
        </div>
        <p className="text-[12px] text-muted leading-relaxed mb-4">
          Markie ships a local <strong>MCP server</strong> that gives an agent
          like Claude Code or Codex markdown-aware access to the files on this
          Mac — your notes, docs, and agent/skill files (<code>CLAUDE.md</code>,{" "}
          <code>AGENTS.md</code>, <code>~/.claude/skills</code>,{" "}
          <code>~/.codex</code>). It runs on demand, locally; nothing is uploaded.
        </p>

        <div className="text-[10px] uppercase tracking-wide text-muted mb-1.5">
          Tools it gives your agent
        </div>
        <div className="flex flex-col gap-1 mb-4">
          {TOOLS.map(([name, desc]) => (
            <div key={name} className="flex gap-2 text-[12px]">
              <code className="text-foreground/90 shrink-0">{name}</code>
              <span className="text-muted truncate">— {desc}</span>
            </div>
          ))}
        </div>

        <CopyBlock label="Claude Code — run this in your terminal" text={claudeCmd} />
        <CopyBlock label="Codex — add to ~/.codex/config.toml" text={codexCfg} />

        <p className="text-[11px] text-muted leading-relaxed mt-3">
          Needs <code>node</code> on your PATH. After adding it, ask your agent to{" "}
          <em>“list my Markie skills”</em> or <em>“find my markdown about X.”</em>
          {!serverPath && (
            <>
              {" "}
              <span className="text-yellow-500/90">
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

function CopyBlock({ label, text }: { label: string; text: string }) {
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
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {label}
        </span>
        <button
          onClick={copy}
          className="text-[11px] px-2 py-0.5 rounded-md bg-accent text-foreground hover:opacity-90"
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
