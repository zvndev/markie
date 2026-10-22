// Example documents Markie places in its own workspace folder, once.
//
// A new format is easiest to understand by opening one, so Markie puts a short
// Darkmown example in ~/Documents/Markie the first time it sees that folder.
// Once per example, ever: the marker in userData remembers what was offered,
// so deleting or renaming the file keeps it gone. An existing file with the
// same name is never touched.
const fs = require("fs");
const path = require("path");

const WELCOME_DARKMOWN = `---
title: Welcome to Darkmown
---

# Welcome to Darkmown

Darkmown is Markdown that can do things. This file is plain text you can read in any editor, and in Markie it becomes a small working document.

Choose **View > Darkmown Source and Preview** to see the source beside the result. The preview starts switched off: trust this document to turn its controls on. Nothing here goes online.

## A counter

:state cups = 0
:computed ounces = cups * 8

You have had { cups } cups of water today, about { ounces } ounces.

:button "Add a cup" -> cups++
:button "Start over" -> cups reset

## A quick estimate

:state hours = 6
:state rate = 120
:computed total = hours * rate

:slider hours min=1 max=40 step=1

{ hours } hours at { rate } an hour comes to { total }.

## A small form

:form into visitor
:input name placeholder="Your name"
:submit "Say hello"
:endform

Hello, { visitor.name }.

## How it saves

Markie saves the source you see in Source view. Counts, slider positions and form answers are temporary preview state, so they reset when you open the file again. Edit the lines that start with a colon to change what the document does.
`;

const EXAMPLES = [
  { id: "darkmown-welcome-v1", name: "Welcome to Darkmown.wd", content: WELCOME_DARKMOWN },
];

function readMarker(markerPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return Array.isArray(parsed?.seeded) ? parsed.seeded.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Offer each example once into `root`. Returns the paths written.
 * Does nothing when the folder is missing; Markie never creates it here.
 */
function seedExamples(root, markerPath) {
  if (!root || !markerPath) return [];
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const seeded = readMarker(markerPath);
  const written = [];
  let changed = false;
  for (const example of EXAMPLES) {
    if (seeded.includes(example.id)) continue;
    const target = path.join(root, example.name);
    try {
      // "wx" refuses to replace a file the user already has under this name.
      fs.writeFileSync(target, example.content, { encoding: "utf8", flag: "wx" });
      written.push(target);
    } catch (error) {
      if (error?.code !== "EEXIST") continue; // retry on a later launch
    }
    seeded.push(example.id);
    changed = true;
  }
  if (changed) {
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ seeded }, null, 2));
    } catch { /* the marker is a courtesy; a missing one means one more offer */ }
  }
  return written;
}

module.exports = { EXAMPLES, WELCOME_DARKMOWN, seedExamples };
