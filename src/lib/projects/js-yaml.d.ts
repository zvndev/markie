// js-yaml is a devDependency (already vendored for scripts/release.mjs) and
// ships no type declarations. @types/js-yaml would be a new dependency, which
// this release does not take, so declare exactly the surface the rules parser
// uses: `load`, which returns something of unknown shape and throws a YAMLError
// with a readable message on malformed input. Both facts are what rules.ts
// relies on, and neither is a guess.
declare module "js-yaml" {
  export function load(input: string, options?: { filename?: string }): unknown;
}
