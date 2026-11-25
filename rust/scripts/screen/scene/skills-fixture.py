#!/usr/bin/env python3
"""A synthetic agent tree for the Skills scenes (docs/rust-port/SCREEN.md).

Usage: skills-fixture.py <scene-home>/data

Writes skills and agent files under the given folder, which a scene run with a
scratch MARKIE_RS_DATA_DIR indexes as home: short and long names, names with
hyphens, underscores and no break at all, short, long and missing
descriptions, plus instructions, commands, subagents and a project. Every name
a Skills capture shows comes from this file. The folder must not be under
/tmp, which the Skills view skips as a cache.
"""
import os
import sys

root = sys.argv[1]

LONG = (
    "Use when designing or modifying an LLM coding agent harness: tool "
    "definitions, permission prompts, context management, subagent handoffs "
    "and the evaluation loop that keeps them honest."
)

SKILLS = {
    ".claude/skills": [
        ("agent-harness-best-practices", LONG),
        ("api-design-review", "Review a REST or GraphQL API for naming, errors and versioning."),
        ("brand-voice", "Write in the house voice."),
        ("changelog-from-commits-and-pull-requests-since-last-release",
         "Draft a changelog from the commits and merged pull requests since the last tag, grouped by area."),
        ("database-migration-safety-checklist",
         "Use before running a schema migration on a shared database: locks, backfills, rollbacks, "
         "connection poolers and the order to deploy code and schema in."),
        ("pdf_form_filler_with_ocr_support", "Fill PDF forms, including scanned ones, with OCR."),
        ("superlongskillnamewithoutanybreakpointsatallforwrapping", "A name with nowhere to break."),
        ("tidy", None),
        ("writing-plans", "Turn a spec into a step by step implementation plan with checkpoints."),
    ],
    ".codex/skills": [
        ("release-notes", "Summarise a release for customers."),
        ("rust-borrow-checker-explainer-for-reviewers", LONG),
    ],
    ".agents/skills": [
        ("shared-review-rubric", "One rubric every agent uses for code review, from correctness to naming."),
    ],
}

OTHER = {
    ".claude/CLAUDE.md": "# Global instructions\n",
    ".claude/commands/ship.md": "Ship it.\n",
    ".claude/commands/review-the-current-branch-against-main.md": "Review.\n",
    ".claude/agents/code-reviewer.md": "A reviewer.\n",
    ".codex/AGENTS.md": "# Codex\n",
    "work/very-long-project-folder-name/packages/web-client/CLAUDE.md": "# Project\n",
    "work/very-long-project-folder-name/packages/web-client/AGENTS.md": "# Project agents\n",
}


def put(rel, body):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


count = 0
for base, skills in SKILLS.items():
    for name, description in skills:
        front = f"---\nname: {name}\n"
        if description:
            front += f"description: {description}\n"
        put(f"{base}/{name}/SKILL.md", front + f"---\n\n# {name}\n")
        count += 1
for rel, body in OTHER.items():
    put(rel, body)
    count += 1
print(f"skills-fixture: wrote {count} files under {root}")
