#!/usr/bin/env python3
"""Made-up documents for the Recent page bench (docs/rust-port/PERF.md).

    many-fixture.py <dir> [count]

Writes <count> documents (200 by default) to <dir>/docs, mostly Markdown of
every length (a few lines to several pages), with text, CSV, data and PDF
files among them, and the scene arguments to <dir>/many.json: every file in
Recent, opened over the last two months, newest first. All text is invented
here from a fixed seed, so every run writes the same files.
"""
import json
import os
import random
import sys

out = os.path.abspath(sys.argv[1])
count = int(sys.argv[2]) if len(sys.argv) > 2 else 200
rng = random.Random(7)
docs = os.path.join(out, "docs")
os.makedirs(docs, exist_ok=True)

WORDS = ("plan team ship draft review notes budget launch design build test release goal week month idea "
         "studio reader table chart page card list guide field project road map client brief summary").split()
TOPICS = ["Roadmap", "Weekly sync", "Design review", "Launch plan", "Budget", "Interview", "Retro", "Field notes",
          "Proposal", "Onboarding", "Research", "Brief", "Postmortem", "Strategy", "Checklist", "Reading list"]


def sentence(n):
    words = [rng.choice(WORDS) for _ in range(n)]
    return " ".join(words).capitalize() + "."


def paragraph():
    return " ".join(sentence(rng.randint(6, 14)) for _ in range(rng.randint(2, 5)))


def markdown(title, sections):
    parts = [f"# {title}", "", paragraph(), ""]
    for s in range(sections):
        parts += [f"## {rng.choice(TOPICS)} {s + 1}", ""]
        kind = rng.choice(["list", "tasks", "table", "code", "quote", "text", "numbered"])
        if kind == "list":
            parts += [f"- {sentence(rng.randint(3, 8))}" for _ in range(rng.randint(3, 6))]
        elif kind == "tasks":
            parts += [f"- [{'x' if rng.random() < 0.5 else ' '}] {sentence(rng.randint(3, 7))}" for _ in range(rng.randint(3, 6))]
        elif kind == "numbered":
            parts += [f"{i + 1}. {sentence(rng.randint(3, 8))}" for i in range(rng.randint(3, 5))]
        elif kind == "table":
            parts += ["| Item | Owner | Due |", "| --- | --- | --- |"]
            parts += [f"| {rng.choice(WORDS).title()} | {rng.choice(['Alice', 'Bob', 'Carol', 'Dana'])} | Week {rng.randint(1, 12)} |" for _ in range(rng.randint(3, 6))]
        elif kind == "code":
            parts += ["```js", "const plan = load('plan');", "for (const step of plan.steps) {", "  run(step);", "}", "```"]
        elif kind == "quote":
            parts += [f"> {sentence(rng.randint(8, 16))}"]
        else:
            parts += [f"{paragraph()} Some **bold** words, some *italic* ones and `code`."]
        parts += ["", paragraph(), ""]
    return "\n".join(parts) + "\n"


recents = []
for i in range(count):
    roll = rng.random()
    topic = rng.choice(TOPICS)
    if roll < 0.70:
        name = f"{topic} {i + 1}.md"
        text = markdown(f"{topic} {i + 1}", rng.choice([1, 2, 3, 5, 8, 14]))
    elif roll < 0.78:
        name = f"{topic} notes {i + 1}.txt"
        text = "\n".join(sentence(rng.randint(5, 12)) for _ in range(rng.randint(4, 30))) + "\n"
    elif roll < 0.86:
        name = f"{topic} data {i + 1}.csv"
        text = "Item,Owner,Count,Cost\n" + "\n".join(f"{rng.choice(WORDS)},{rng.choice(['Alice', 'Bob'])},{rng.randint(1, 99)},{rng.randint(10, 999)}" for _ in range(rng.randint(5, 40))) + "\n"
    elif roll < 0.92:
        name = f"settings-{i + 1}.json"
        text = json.dumps({"name": topic, "zoom": round(rng.uniform(0.8, 1.4), 2), "tags": rng.sample(WORDS, 3)}, indent=2) + "\n"
    else:
        name = f"{topic} scan {i + 1}.pdf"
        text = "%PDF-1.4\n%%EOF\n"
    path = os.path.join(docs, name)
    with open(path, "w") as f:
        f.write(text)
    recents.append({"path": path, "hours_ago": round(0.1 + (i ** 1.6) * 0.06, 2)})

with open(os.path.join(out, "many.json"), "w") as f:
    json.dump({"docs": docs, "recents": recents}, f)
print(f"many fixtures: {count} documents in {docs}")
