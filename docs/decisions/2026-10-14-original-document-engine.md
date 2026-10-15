# Original document engine

## Decision

Kirby's October 14, 2026 instruction selects an original DOC/DOCX engine for Markie, with shared web/desktop document logic, ordinary plain text, optional multiplayer and encrypted protected storage. This supersedes the earlier third-party-engine recommendation. It does not authorize deployment, release, additional dependencies or changes to the human-maintained vision/constitution files.

Markdown documents keep their current Markdown representation. Office documents must not travel through Markdown serialization. The first additive milestone is a bounded package/text foundation and a development-only workbench, not a complete Word editor.

## Implementation provenance

- DOCX, ZIP and XML interpretation was authored independently from ECMA-376/OPC, the public PKWARE ZIP specification and W3C XML rules. Browser-standard decompression is a generic platform primitive, not a document engine.
- Legacy CFB/DOC interpretation was authored by a fresh isolated implementer using Microsoft MS-CFB/MS-DOC specification pages only. Fixtures were generated from those specifications, not exported by or copied from a competing implementation.
- No third-party Office engine, conversion service, engine source, minified engine artifact or document SDK was installed, copied, translated or linked into the implementation. Existing React, CodeMirror and Markdown editor infrastructure remains in place for its established purpose.
- Earlier planning considered public vendor feature/licensing documentation. It did not supply implementation internals to the original engine implementers.
- One initial DOC researcher reported an incidental third-party allocator snippet in an unfiltered search result. That agent wrote zero DOC/CFB implementation files, stopped, and released the lane. A new agent with no inherited context implemented the parser. The original researcher later performed read-only validation grounded in explicit Microsoft specification references and did not write fixes.
- An independent platform text consumer (`textutil`) read the generated browser-exported DOCX correctly. This is black-box interoperability testing, not reuse of that consumer in Markie.

This records the development controls and source provenance. It is not legal certification, a patent opinion, a guarantee about an AI model's prior training, or a claim of universal Office compatibility.

## Initial capability limits

DOCX can inspect basic direct run formatting and edit supported plain text runs. Unknown/dependent markup, protection/review state, external relationships and opaque unsafe settings make a document read-only. An untouched export returns owned byte-identical original bytes. XML/ZIP well-formedness and package validation are necessary but do not prove Microsoft Word layout fidelity.

Legacy DOC support is bounded main-story text extraction with typed unsupported/encrypted/malformed outcomes. It is not DOC editing, formatting interpretation or a DOC writer. Plain text and browser file utilities preserve supported encodings/BOM/separators and never identify DOC/DOCX as text solely from a filename.

Vault code is a standalone cryptographic foundation with no production storage or biometric UI. It must not be marketed as a usable secure area before trusted key protection, encrypted recovery/index integration and application-wide leak testing exist.

## Verification contract

Each parser/crypto module has generated fixtures and hostile-input tests. Independent reviewers report issues to the owning implementer; reviewers do not quietly fix their own findings. The current integration keeps Office packages outside production text-file grants and exposes a development-only copy/export workbench. No source-file autosave, cloud Office schema, vault migration or public sharing is enabled by this milestone.

Before broad document support is advertised, validate a sanitized Word-generated corpus and real Microsoft Word reopen/repair/layout/review behavior. Before vault UI is enabled, complete independent security review of native/browser key protection, recovery, lock lifecycle, search, clipboard, logs, temporary files and sharing. The full product sequence is in ../superpowers/plans/2026-10-14-document-platform.md.
