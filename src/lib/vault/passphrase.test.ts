import { describe, expect, it } from "vitest";
import { VAULT_LIMITS } from "./envelope";
import { estimatePassphraseBits, passphraseStrength, suggestPassphrase, uniformIndex } from "./passphrase";
import { PASSPHRASE_WORDS } from "./wordlist";

describe("suggested passphrases", () => {
  it("embeds a 2,048-word list of distinct lowercase words", () => {
    expect(PASSPHRASE_WORDS.length).toBe(2048);
    expect(new Set(PASSPHRASE_WORDS).size).toBe(2048);
    expect(PASSPHRASE_WORDS.every((word) => /^[a-z]{4,6}$/.test(word))).toBe(true);
  });

  it("joins six list words with hyphens and meets the vault minimum", () => {
    const words = new Set(PASSPHRASE_WORDS);
    for (let attempt = 0; attempt < 50; attempt++) {
      const suggestion = suggestPassphrase();
      const parts = suggestion.split("-");
      expect(parts.length).toBe(6);
      expect(parts.every((part) => words.has(part))).toBe(true);
      expect(Array.from(suggestion).length).toBeGreaterThanOrEqual(VAULT_LIMITS.minimumPassphraseCodePoints);
      expect(passphraseStrength(suggestion).level).toBe("strong");
    }
  });

  it("draws from crypto.getRandomValues and rejects samples that would bias the choice", () => {
    const fixed = (samples: number[]) => {
      let call = 0;
      return { calls: () => call, getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        (array as unknown as Uint32Array)[0] = samples[call++];
        return array;
      } };
    };
    // 2,048 divides 2^32, so every sample maps by modulo with no rejection.
    expect(suggestPassphrase(3, fixed([0xffffffff, 0, 2049])).split("-")).toEqual([PASSPHRASE_WORDS[2047], PASSPHRASE_WORDS[0], PASSPHRASE_WORDS[1]]);
    // For a size that does not divide 2^32, the top partial range is redrawn.
    const source = fixed([0xffffffff, 0xffffffff, 5]);
    expect(uniformIndex(3, source)).toBe(2);
    expect(source.calls()).toBe(3);
  });

  it("differs between calls", () => {
    expect(new Set(Array.from({ length: 20 }, () => suggestPassphrase())).size).toBe(20);
  });
});

describe("passphrase strength", () => {
  it("is driven by estimated entropy, not by length alone", () => {
    expect(passphraseStrength("aaaaaaaaaaaaaaaaaaaaaaaa").level).toBe("weak");
    expect(passphraseStrength("abcdefghijklmnopqrstuvwx").level).toBe("weak");
    expect(passphraseStrength("1234567890123456").level).toBe("weak");
    expect(passphraseStrength("password password").level).toBe("weak");
    const random = "k7#Qv9!mZ2@xLp4$Rw8";
    expect(passphraseStrength(random).bits).toBeGreaterThan(80);
    expect(estimatePassphraseBits("aaaaaaaaaaaaaaaaaaaaaaaa")).toBeLessThan(estimatePassphraseBits("k7#Qv9!m"));
  });

  it("calls anything under the vault minimum too short, whatever its entropy", () => {
    expect(passphraseStrength("k7#Qv9!mZ2@x").level).toBe("too-short");
    expect(passphraseStrength("").level).toBe("too-short");
  });

  it("counts list words as one choice each", () => {
    const four = PASSPHRASE_WORDS.slice(100, 104).join("-");
    const six = PASSPHRASE_WORDS.slice(100, 106).join("-");
    expect(estimatePassphraseBits(four)).toBe(4 * 11 + 3);
    expect(estimatePassphraseBits(six)).toBe(6 * 11 + 5);
  });
});
