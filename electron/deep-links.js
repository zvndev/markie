// Which markie:// links mean what.
//
// Kept apart from main.js because the OS cannot be used to test this: firing a
// markie:// URL on a machine with Markie installed opens the installed copy,
// not the build under test. The routing is where a mistake is silent and
// expensive, so it lives in a function with no Electron in it.
//
//   markie://auth?token=…&state=…   sign-in coming back from the browser
//   markie://open?token=…&src=…     a public link: fetch with the link's own
//                                   token, no account needed
//   markie://doc?id=…&src=…         a document shared with this account: fetch
//                                   with the signed-in user's credentials
//
// The difference between the last two is the whole security story. `open`
// carries its authority in the URL. `doc` carries none, so a stranger who
// gets hold of it opens nothing.

const SCHEME = "markie://";

// "cloud-doc" and "shared-token" are handled in the main process because they
// touch the network and the disk; everything else is the renderer's business.
function classifyDeepLink(link) {
  if (typeof link !== "string" || !link.startsWith(SCHEME)) return "ignore";
  if (link.startsWith(`${SCHEME}open`)) return "shared-token";
  if (link.startsWith(`${SCHEME}doc`)) return "cloud-doc";
  return "renderer";
}

function paramsOf(link) {
  try {
    return new URL(link).searchParams;
  } catch {
    return null;
  }
}

// The document id from a markie://doc link, or null when it is missing. An id
// is the only thing this link is allowed to contribute: anything else about
// the request comes from the signed-in session.
function cloudDocId(link) {
  if (classifyDeepLink(link) !== "cloud-doc") return null;
  const id = paramsOf(link)?.get("id");
  return id ? id : null;
}

// The origin hint on a link, used only to pick between allowlisted Markie
// servers. Never fetched directly.
function sourceHint(link) {
  return paramsOf(link)?.get("src") ?? null;
}

module.exports = { classifyDeepLink, cloudDocId, sourceHint };
