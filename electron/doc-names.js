// The extensions Markie writes a document from somewhere else under: a
// shared link's download, a cloud document landing in the workspace. The
// name comes from whoever sent it, so a file it names "run.command" or
// "notes.html" must not land as one; anything outside the markdown and
// plain-text family (CSV included, which the Library syncs) gets ".md" on
// the end instead.
const SAFE_DOC_EXTENSION = /\.(md|markdown|mdx|txt|text|log|csv)$/i;

function withSafeDocExtension(name) {
  return SAFE_DOC_EXTENSION.test(name) ? name : `${name}.md`;
}

module.exports = { SAFE_DOC_EXTENSION, withSafeDocExtension };
