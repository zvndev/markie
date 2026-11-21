// Markie additions to the mitex scope. Kept apart from the vendored mitex
// files (typst/mitex/, Apache-2.0) so those stay easy to diff and update.
#import "/mitex/mod.typ": mitex-scope

#let markie-scope = mitex-scope + (
  // In the mitex spec as plain symbols, but with no Typst definition.
  // KaTeX users write them via \operatorname*; render them the same way.
  argmax: math.op("arg max", limits: true),
  argmin: math.op("arg min", limits: true),
)
