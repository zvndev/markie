// The extensions Markie writes a document from somewhere else under: a
// shared link's download, a cloud document landing in the workspace. The
// name comes from whoever sent it, so a file it names "run.command" or
// "notes.html" must not land as one; anything outside the markdown and
// plain-text family (CSV included, which the Library syncs) gets ".md" on
// the end instead. Darkmown (.wd) is in the family: it is Markie's own text
// format, runs only inside Markie's sandbox after the user trusts it, and a
// document an agent syncs as Plan.wd must not land on another device as
// Plan.wd.md, which would open as plain Markdown and lose its controls.
const SAFE_DOC_EXTENSION = /\.(md|markdown|mdx|txt|text|log|csv|wd)$/i;

function withSafeDocExtension(name) {
  return SAFE_DOC_EXTENSION.test(name) ? name : `${name}.md`;
}

module.exports = { SAFE_DOC_EXTENSION, withSafeDocExtension };
