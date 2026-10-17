import { useState } from "react";
import type { RichDocument } from "@/lib/office/rich-text-types";
import { findWordText, replaceWordText, type WordTextMatch } from "./word-find";

export function WordFindTools({ document, readOnly, onChange, onSelect, onError }: {
  document: RichDocument; readOnly: boolean; onChange: (document: RichDocument) => void;
  onSelect: (match: WordTextMatch) => void; onError: (message: string) => void;
}) {
  const [query, setQuery] = useState(""), [replacement, setReplacement] = useState("");
  const [index, setIndex] = useState(0);
  const [receipt, setReceipt] = useState<string | null>(null);
  const matches = findWordText(document, query);
  const replace = (all: boolean) => {
    try {
      const result = replaceWordText(document, query, replacement, all ? undefined : index % matches.length);
      if (result.document !== document) onChange(result.document);
      setReceipt(`Replaced ${result.count} ${result.count === 1 ? "match" : "matches"}.`); setIndex(0);
    } catch (failure) { onError(failure instanceof Error ? failure.message : "The matching text could not be replaced."); }
  };
  return <div className="docs-find-tools" role="group" aria-label="Find and replace"><label>Find text<input aria-label="Find Word text" value={query} placeholder="Case-sensitive text" onChange={(event) => { setQuery(event.target.value); setIndex(0); setReceipt(null); }} /></label><button type="button" disabled={!matches.length} onClick={() => { onSelect(matches[index % matches.length]); setIndex(index + 1); }}>Find next</button><label>Replace with<input aria-label="Replacement text" value={replacement} onChange={(event) => { setReplacement(event.target.value); setReceipt(null); }} /></label><button type="button" disabled={readOnly || !matches.length} onClick={() => replace(false)}>Replace next</button><button type="button" disabled={readOnly || !matches.length} onClick={() => replace(true)}>Replace all</button><span role="status">{receipt ?? `${matches.length} matches`}</span></div>;
}
