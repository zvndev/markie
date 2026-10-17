# Connected documents and pending features

[Back to the test guide](README.md) · [Document types](document-types.md)

The following product direction is approved but not implemented in the RTF/ODT milestone. These are future acceptance checks, not working controls hidden elsewhere in this preview.

## Trusted interactive Darkmown

Darkmown `.wd` documents should support both source plus live preview and an opinionated interactive document experience. `.md` remains ordinary Markdown. `.skin` styles and assets are part of the authored document; optional page code must not gain unrestricted access to Markie.

The target includes images/video, state-bound document toolbar controls, forms, calculations and external API connections. For example, choosing a customer and date range could refresh a report's tables and narrative. Document source/defaults, transient/personal/shared runtime state and connection secrets must remain separate.

Untrusted documents start inactive. Explicit trust should enable reviewed runtime capabilities inside an isolated environment. API keys stay outside portable document source; network destinations and external writes must be intentional. Changed dependencies, revoked access and offline operation need visible behavior. A static-only preview is not completion of this feature.

## Cleaner cloud and people

Cloud should make local copies, owned/shared documents and access roles easy to distinguish. Search/filter by a person already involved in authorized shares. Share typeahead should autocomplete previous collaborators by name/email, support the keyboard and avoid cross-account or cross-server suggestions. Choosing a suggestion must not itself invite or change access.

## Links between documents

Documents should link to each other through intentional, format-aware navigation that preserves unsaved buffers. Relative links must not bypass file grants, follow unsafe paths or leak protected content. Local, cloud and vault targets require distinct authorization. Existing operating-system file-link behavior is not the completed in-app navigation feature.

## Remaining acceptance areas

Broader Word/RTF/ODT fidelity, native DOC writing, rich HTML, extensionless README/text aliases, all-files body indexing, live Office multiplayer, biometric vault keys and full browser acceptance remain open. The public release is a separate human-gated step after desktop testing and polish.
