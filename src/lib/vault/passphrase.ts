import { VAULT_LIMITS } from "./envelope";
import { PASSPHRASE_WORDS } from "./wordlist";

export const SUGGESTED_PASSPHRASE_WORDS = 6;
const WORD_BITS = Math.log2(PASSPHRASE_WORDS.length);
const WORDS = new Set(PASSPHRASE_WORDS);

/** A uniform index below `size`, by rejection sampling so no word is more likely than another. */
export function uniformIndex(size: number, crypto: Pick<Crypto, "getRandomValues">): number {
  const limit = Math.floor(0x1_0000_0000 / size) * size;
  const sample = new Uint32Array(1);
  try {
    for (;;) {
      crypto.getRandomValues(sample);
      if (sample[0] < limit) return sample[0] % size;
    }
  } finally { sample.fill(0); }
}

/** Six random words from the embedded list, joined by hyphens: about 66 bits. */
export function suggestPassphrase(words = SUGGESTED_PASSPHRASE_WORDS, crypto: Pick<Crypto, "getRandomValues"> = globalThis.crypto): string {
  if (!crypto?.getRandomValues) throw new Error("Secure random numbers are unavailable.");
  return Array.from({ length: words }, () => PASSPHRASE_WORDS[uniformIndex(PASSPHRASE_WORDS.length, crypto)]).join("-");
}

export type PassphraseStrengthLevel = "too-short" | "weak" | "fair" | "strong" | "very-strong";

export interface PassphraseStrength {
  readonly bits: number;
  readonly level: PassphraseStrengthLevel;
  readonly label: string;
}

function poolSize(characters: readonly string[]): number {
  let pool = 0;
  if (characters.some((character) => /[a-z]/.test(character))) pool += 26;
  if (characters.some((character) => /[A-Z]/.test(character))) pool += 26;
  if (characters.some((character) => /[0-9]/.test(character))) pool += 10;
  if (characters.some((character) => /[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(character))) pool += 33;
  if (characters.some((character) => character.codePointAt(0)! > 0x7e)) pool += 100;
  return Math.max(pool, 1);
}

/** Bits for a run that is not a list word: repeats and keyboard-order sequences add almost nothing. */
function characterBits(characters: readonly string[], perCharacter: number): number {
  let bits = 0;
  for (let index = 0; index < characters.length; index++) {
    const code = characters[index].codePointAt(0)!;
    const previous = index > 0 ? characters[index - 1].codePointAt(0)! : NaN;
    if (code === previous) bits += 0.25;
    else if (Math.abs(code - previous) === 1) bits += 1;
    else bits += perCharacter;
  }
  return bits;
}

/**
 * A rough guess at how hard the passphrase is to guess, in bits. Words from the suggestion list
 * count as one choice each, lowercase-only words count like ordinary language, and anything else
 * counts per character from the character classes used. It is a guide, not a proof.
 */
export function estimatePassphraseBits(passphrase: string): number {
  const characters = Array.from(passphrase);
  if (characters.length === 0) return 0;
  const perCharacter = Math.log2(poolSize(characters));
  let bits = 0;
  for (const match of passphrase.matchAll(/\p{L}+|[^\p{L}]+/gu)) {
    const token = match[0];
    const tokenCharacters = Array.from(token);
    if (/^\p{L}+$/u.test(token)) {
      const lower = token.toLocaleLowerCase();
      if (WORDS.has(lower)) bits += WORD_BITS + (token === lower ? 0 : 1);
      // Lowercase words read like language: count about 2.5 bits a letter, not 4.7.
      else if (token === lower && tokenCharacters.length >= 4) bits += Math.min(characterBits(tokenCharacters, 2.5), WORD_BITS + 6);
      else bits += characterBits(tokenCharacters, perCharacter);
    } else if (/^[\s\-_.]$/.test(token) && match.index! > 0 && match.index! + 1 < passphrase.length) {
      bits += 1; // A single separator between words is nearly free to guess.
    } else bits += characterBits(tokenCharacters, perCharacter);
  }
  return Math.round(bits);
}

export function passphraseStrength(passphrase: string): PassphraseStrength {
  const bits = estimatePassphraseBits(passphrase);
  if (Array.from(passphrase).length < VAULT_LIMITS.minimumPassphraseCodePoints) return { bits, level: "too-short", label: "Too short" };
  if (bits < 45) return { bits, level: "weak", label: "Weak" };
  if (bits < 60) return { bits, level: "fair", label: "Fair" };
  if (bits < 80) return { bits, level: "strong", label: "Strong" };
  return { bits, level: "very-strong", label: "Very strong" };
}
