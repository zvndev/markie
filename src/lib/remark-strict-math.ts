// Single-dollar math by Pandoc's rule, so prices stay prices.
//
// remark-math pairs any two `$` in a paragraph. A meeting transcript is one
// paragraph thousands of lines long (every line ends in a hard break), so
// "you sold, you know, $6" and "you took a $100 worth of lemons" twenty-seven
// lines later became one inline equation. KaTeX draws an equation as a single
// line that cannot wrap, and the transcript ran off the side of the page in
// exports, version history, the phone app and shared pages.
//
// Pandoc's rule is what people who write `$x$` already expect: the opening `$`
// is followed directly by something other than whitespace, and the closing `$`
// directly follows something other than whitespace and is not followed by a
// digit. "$6 ... a $100" has no closer under it, so both dollars stay text,
// while `$x^2$` and `$E = mc^2$` are still math. `$$…$$`, inline or on lines
// of its own, is left exactly as remark-math reads it.
//
// Use after remark-math: this swaps remark-math's own inline construct for a
// stricter copy of it and keeps its resolver, so the tokens, the mdast it
// builds and the KaTeX output are unchanged for everything that is still math.
//
// server/src/remark-strict-math.ts is a copy of this file below the imports;
// the server imports nothing from the app's module graph. A test keeps the two
// the same.
import type { Code, Construct, State, Token, TokenizeContext, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";
// Brings in the math token names (mathText, mathTextSequence, mathTextData).
import type {} from "micromark-extension-math";

const DOLLAR = 36;
const SPACE = 32;

// micromark's codes: null is the end of the text, -5 to -3 are line endings,
// -2 is a tab and -1 the virtual spaces a tab expands to.
function isWhitespace(code: Code): boolean {
  return code === null || code === SPACE || code < 0;
}

function isDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

// A single-dollar opener that found no closer scanned to the end of its text.
// Whether a `$` can close depends only on its own neighbours, so every later
// opener in that stretch would scan the same characters and fail the same
// way. Remembering the stretch keeps a paragraph of prices linear instead of
// quadratic. Keyed by the parse, so nothing outlives the document.
const failedScans = new WeakMap<object, { from: number; to: number }>();

export function strictMathText(original: Construct): Construct {
  const tokenize: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
    const parser = this.parser;
    const offsetNow = () => this.now().offset;
    const openedAt = offsetNow();
    let sizeOpen = 0;
    let size = 0;
    let sequence: Token | undefined;
    // The last character inside the math so far, and the one before the
    // closing run currently being read.
    let last: Code = DOLLAR;
    let beforeRun: Code = DOLLAR;

    return start;

    function start(code: Code): State | undefined {
      const failed = failedScans.get(parser);
      if (failed && openedAt > failed.from && openedAt < failed.to) return nok(code);
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      return sequenceOpen(code);
    }

    function sequenceOpen(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code);
        sizeOpen++;
        return sequenceOpen;
      }
      // "$ 5" or a `$` at the end of a line opens nothing.
      if (sizeOpen === 1 && isWhitespace(code)) return nok(code);
      effects.exit("mathTextSequence");
      return between(code);
    }

    function between(code: Code): State | undefined {
      if (code === null) {
        if (sizeOpen === 1) failedScans.set(parser, { from: openedAt, to: offsetNow() });
        return nok(code);
      }
      if (code === DOLLAR) {
        sequence = effects.enter("mathTextSequence");
        size = 0;
        beforeRun = last;
        return sequenceClose(code);
      }
      if (code === SPACE) {
        effects.enter("space");
        effects.consume(code);
        effects.exit("space");
        last = code;
        return between;
      }
      if (isLineEnding(code)) {
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        last = code;
        return between;
      }
      effects.enter("mathTextData");
      return data(code);
    }

    function data(code: Code): State | undefined {
      if (code === null || code === SPACE || code === DOLLAR || isLineEnding(code)) {
        effects.exit("mathTextData");
        return between(code);
      }
      effects.consume(code);
      last = code;
      return data;
    }

    function sequenceClose(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code);
        size++;
        return sequenceClose;
      }
      const closes = size === sizeOpen && (sizeOpen > 1 || (!isWhitespace(beforeRun) && !isDigit(code)));
      if (closes) {
        effects.exit("mathTextSequence");
        effects.exit("mathText");
        return ok(code);
      }
      // Not this one: the run is part of the math and the scan goes on.
      sequence!.type = "mathTextData";
      last = DOLLAR;
      return data(code);
    }
  };

  return { ...original, tokenize };
}

export function remarkStrictMath(this: Processor): undefined {
  const extensions = (this.data("micromarkExtensions") ?? []) as Array<{
    text?: Record<number, Construct | Construct[] | undefined>;
  }>;
  for (const extension of extensions) {
    const construct = extension.text?.[DOLLAR];
    if (construct && !Array.isArray(construct) && construct.name === "mathText") {
      extension.text![DOLLAR] = strictMathText(construct);
    }
  }
  return undefined;
}
