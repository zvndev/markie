---
name: markie-conventions
description: Conventions for writing and organizing markdown through the Markie MCP server. Use whenever writing documents for the user via markie_write_md, or when the user asks to organize, file, or find their markdown.
---

# Markie conventions

Markie is the user's local markdown workspace. It organizes files into projects
(a repo or a product) containing blocks (units of work). Files never move on
disk; organization is metadata.

## Writing documents

1. Search before you write: `markie_find_md` with a few keywords. Update the
   document that already exists instead of creating `plan-v2-final.md` beside
   it. If the search says it was truncated, it did not see the whole disk, so
   do not read a miss as proof the document is new.
2. Declare where the document belongs. Either pass `project` and `block` to
   `markie_write_md`, or write the front matter yourself:

   ```yaml
   ---
   markie:
     project: bevrly
     block: checkout-redesign
   ---
   ```

3. One block per unit of work: a feature, an investigation, a report series.
   Reuse the block name across every document from that work.
4. Name blocks after the work, not the date: `auth-flow`, not `march-notes`.
   A date says when you filed something and never what it was, and Markie
   strips leading date stamps out of the names it derives for that reason.
5. Match existing project names. A document about a repo belongs to a project
   named like the repo folder.
6. Project, then block, then file is the whole tree. Do not invent deeper
   levels, and do not move, rename, or restructure files on disk to organize
   them. Declaring the project and block is the organizing.

## Showing results

When the user asked for a document, finish with `markie_open_in_markie` on the
file you wrote, so it renders in front of them.
