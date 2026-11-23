#!/usr/bin/env python3
"""A synthetic home folder for the Browse scenes (docs/rust-port/SCREEN.md).

Usage: browse-fixture.py <scene-home>/data

Writes a few hundred small documents under the given folder: nested folders,
mixed formats, long names, one large folder, and agent and skill folders. A
scene run with a scratch MARKIE_RS_DATA_DIR indexes that folder instead of the
real home folder, so every name a capture shows comes from this file. The
output is the same on every run, apart from times, which count back from now.
"""
import os
import sys
import time

root = sys.argv[1]
now = time.time()
count = 0


def put(rel, age_hours, body=None):
    """One file, changed `age_hours` ago."""
    global count
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    name = os.path.basename(rel)
    if body is None:
        title = os.path.splitext(name)[0]
        ext = os.path.splitext(name)[1].lower()
        if ext in (".docx", ".doc", ".odt"):
            body = "PK\x03\x04 synthetic"
        elif ext == ".json":
            body = '{"synthetic": true}\n'
        elif ext in (".yaml", ".yml"):
            body = "synthetic: true\n"
        elif ext == ".csv":
            body = "item,owner,due\nDraft,Sam,Friday\n"
        elif ext == ".xml":
            body = "<note>synthetic</note>\n"
        elif ext == ".html":
            body = "<h1>%s</h1>\n" % title
        elif ext == ".rtf":
            body = "{\\rtf1 synthetic}"
        else:
            body = "# %s\n\nSynthetic text for a Markie RS scene.\n" % title
    with open(path, "w") as f:
        f.write(body)
    stamp = now - age_hours * 3600
    os.utime(path, (stamp, stamp))
    count += 1


DAY = 24
clients = ["Northwind Traders", "Acme Rockets", "Globex", "Initech", "Umbrella Health"]
for ci, client in enumerate(clients):
    base = "Documents/Work/Clients/%s" % client
    put("%s/Overview.md" % base, 3 * DAY + ci * 30)
    for i, name in enumerate(["Statement of work.docx", "Pricing.csv", "Proposal draft.md", "Proposal final.docx"]):
        put("%s/Proposals/%s" % (base, name), (ci + 1) * 9 * DAY + i * 7)
    for week in range(1, 7):
        put("%s/Meeting notes/2026-%02d-%02d weekly sync.md" % (base, 5 + week, 3 + ci), (7 - week) * 7 * DAY + ci * 5)
    put("%s/Contracts/Master services agreement.docx" % base, 200 * DAY + ci)
    put("%s/Contracts/Non-disclosure agreement.docx" % base, 210 * DAY + ci)

put("Documents/Work/Clients/Northwind Traders/Proposals/Quarterly business review and roadmap alignment notes (final, revised after the call).docx", 5)
put("Documents/Work/Clients/Northwind Traders/Meeting notes/Kickoff.md", 1.5)

for q in range(1, 5):
    base = "Documents/Work/Planning/2026/Q%d" % q
    for i, name in enumerate(["Goals.md", "Budget.csv", "Hiring plan.md", "Roadmap.md", "Risks.md", "Retrospective.md"]):
        put("%s/%s" % (base, name), (5 - q) * 80 * DAY + i * 11)
put("Documents/Work/Planning/2026/Q4/Roadmap.md", 0.4)
put("Documents/Work/Planning/Team handbook.docx", 44 * DAY)
put("Documents/Work/Planning/Onboarding checklist.md", 12 * DAY)
put("Documents/Work/Expenses 2026.csv", 6 * DAY)
put("Documents/Work/Org chart.xml", 90 * DAY)

for month in range(1, 12):
    for day in range(2, 28, 3 if month > 6 else 5):
        put("Documents/Personal/Journal/2026/%02d/2026-%02d-%02d.md" % (month, month, day), (11 - month) * 30 * DAY + (27 - day) * DAY + 8)
recipes = ["Lemon pasta", "Weeknight curry", "Sourdough starter", "Tomato soup", "Granola", "Pancakes", "Miso salmon", "Chili", "Focaccia", "Shakshuka", "Banana bread", "Ramen broth"]
for i, r in enumerate(recipes):
    put("Documents/Personal/Recipes/%s.md" % r, (i + 2) * 13 * DAY)
put("Documents/Personal/Recipes/Shopping list.txt", 20)
for trip, days in [("Lisbon 2026", 30), ("Kyoto", 400), ("Road trip", 150)]:
    for i, name in enumerate(["Itinerary.md", "Packing list.txt", "Budget.csv", "Bookings.docx"]):
        put("Documents/Personal/Travel/%s/%s" % (trip, name), days * DAY + i * 3)
put("Documents/Personal/Travel/Lisbon 2026/Day trips/Sintra.md", 29 * DAY)
put("Documents/Personal/Travel/Lisbon 2026/Day trips/Cascais.md", 29 * DAY + 2)
put("Documents/Personal/Letters/Cover letter.docx", 70 * DAY)
put("Documents/Personal/Letters/Reference for Sam.rtf", 71 * DAY)
put("Documents/Personal/Letters/Landlord notice.odt", 300 * DAY)
put("Documents/Personal/Taxes 2025.csv", 250 * DAY)

for ch in range(1, 25):
    put("Documents/Writing/Novel draft/Chapters/Chapter %02d.md" % ch, (25 - ch) * 4 * DAY + 3)
put("Documents/Writing/Novel draft/Outline.md", 2 * DAY)
put("Documents/Writing/Novel draft/Characters.md", 9 * DAY)
put("Documents/Writing/Novel draft/Research/Lighthouses.md", 40 * DAY)
put("Documents/Writing/Novel draft/Research/Tide tables.csv", 41 * DAY)
posts = ["Why plain text lasts", "A year of daily notes", "Markdown tables, quickly", "Writing with an outline", "Notes on focus", "What I read this spring", "Small tools", "Drafts I never sent"]
for i, post in enumerate(posts):
    put("Documents/Writing/Blog/%s.md" % post, (i + 1) * 16 * DAY)
put("Documents/Writing/Blog/Published/index.html", 15 * DAY)
put("Documents/Writing/Ideas.txt", 30)

for i, name in enumerate(["Scratch.md", "Call notes.txt", "Offer letter.docx", "Read me first.md", "todo.md"]):
    put("Desktop/%s" % name, i * 10 + 2)
for i, name in enumerate(["Invoice 1042.docx", "Invoice 1043.docx", "export.csv", "Release notes.html", "survey-results.json", "Conference schedule.rtf", "Lease.doc", "Minutes.odt"]):
    put("Downloads/%s" % name, (i + 1) * 5 * DAY)

projects = {
    "atlas-api": ["README.md", "CHANGELOG.md", "docs/Architecture.md", "docs/API reference.md", "docs/Deploying.md", "docs/adr/0001-use-postgres.md", "docs/adr/0002-queue.md", "docs/adr/0003-auth.md", "openapi.yaml", "package.json"],
    "lantern-web": ["README.md", "CONTRIBUTING.md", "docs/Design tokens.md", "docs/Routing.md", "docs/Testing.md", "content/About.md", "content/Pricing.md", "tsconfig.json"],
    "field-notes-app": ["README.md", "docs/Roadmap.md", "docs/Sync.md", "docs/Privacy.md", "fastlane/metadata.xml"],
    "handbook": ["README.md", "Engineering/Code review.md", "Engineering/Incidents.md", "Engineering/On call.md", "People/Time off.md", "People/Expenses.md", "People/Hiring.md"],
}
for pi, (project, files) in enumerate(projects.items()):
    for i, name in enumerate(files):
        put("Projects/%s/%s" % (project, name), (pi + 1) * 2 * DAY + i * 9)
for week in range(1, 4):
    for day in range(1, 6):
        put("Projects/atlas-api/docs/guides/onboarding/week-%d/day-%d/Checklist.md" % (week, day), (week * 7 + day) * DAY)
        put("Projects/atlas-api/docs/guides/onboarding/week-%d/day-%d/Reading.md" % (week, day), (week * 7 + day) * DAY + 1)
put("Projects/atlas-api/docs/Architecture.md", 0.1)
put("Projects/Archive/2024/old-site/README.md", 600 * DAY)
put("Projects/Archive/2024/old-site/docs/Notes.md", 601 * DAY)
put("Projects/Archive/2023/prototype/README.md", 900 * DAY)

for skill in ["release-notes", "code-review", "weekly-summary", "meeting-minutes"]:
    put(".claude/skills/%s/SKILL.md" % skill, 20 * DAY, "---\nname: %s\ndescription: A synthetic skill for a scene.\n---\n\nSteps.\n" % skill)
put(".claude/skills/release-notes/Template.md", 21 * DAY)
put(".codex/AGENTS.md", 14 * DAY)
put(".codex/skills/triage/SKILL.md", 15 * DAY, "---\nname: triage\ndescription: A synthetic skill for a scene.\n---\n")
put(".agents/skills/proofread/SKILL.md", 16 * DAY, "---\nname: proofread\ndescription: A synthetic skill for a scene.\n---\n")

print("wrote %d files under %s" % (count, root))
