#!/usr/bin/env python3
"""A made-up home folder for the "Bring your documents" scenes
(docs/rust-port/SCREEN.md).

Usage: bring-fixture.py <scene-home>/data

A scene run with a scratch MARKIE_RS_DATA_DIR uses that folder as home, so
the step lists these folders and never the real ones. Every name is made up.

- Documents: about 1,300 documents in nested folders, and an Obsidian vault
- Desktop: a few loose files
- iCloud Drive (Library/Mobile Documents/com~apple~CloudDocs)
- Notes/Garden Vault: an Obsidian vault outside the protected folders
- Exports/Export-7c1e: a Notion export
- Studio/Kiln: a folder to register as a root, as the Electron import would
- Downloads: documents that must never be listed
"""
import os
import sys

root = sys.argv[1]


def put(rel, body="x\n"):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(body)


areas = ["Clients", "Finance", "Household", "Research", "Writing"]
kinds = ["md", "md", "md", "docx", "txt", "csv"]
for a, area in enumerate(areas):
    for t in range(12):
        for i in range(22):
            ext = kinds[(a + t + i) % len(kinds)]
            put(f"Documents/{area}/Topic {t + 1:02d}/note {i + 1:02d}.{ext}", f"# {area} {t} {i}\n")
put("Documents/Reading Vault/.obsidian/app.json", "{}")
put("Documents/Reading Vault/Books.md")
put("Desktop/todo.txt")
put("Desktop/meeting notes.md")
put("Desktop/budget draft.docx")
put("Library/Mobile Documents/com~apple~CloudDocs/Lists/groceries.md")
put("Library/Mobile Documents/com~apple~CloudDocs/Lists/packing.md")
put("Notes/Garden Vault/.obsidian/app.json", "{}")
for n in ["Seeds", "Beds", "Compost", "Watering"]:
    put(f"Notes/Garden Vault/{n}.md")
for n in ["Trip plan", "Reading list", "Recipes"]:
    put(f"Exports/Export-7c1e/{n} 0123456789abcdef0123456789abcdef.md")
put("Exports/Export-7c1e/Tasks 0123456789abcdef0123456789abcdef_all.csv", "a,b\n")
for n in ["glaze tests", "firing log", "orders"]:
    put(f"Studio/Kiln/{n}.md")
put("Downloads/never listed.md")
put("Downloads/Loose Vault/.obsidian/app.json", "{}")
print(f"wrote a made-up home in {root}")
