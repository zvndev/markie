export interface CompiledDarkmownPage {
  html: string;
  meta: Record<string, string | string[]>;
  warnings: string[];
  deps: Set<string>;
  assets: {
    runtime: boolean;
    hasCode: boolean;
    scripts: Set<string>;
    skins: Set<string>;
    behaviors: Set<string>;
  };
}

export function compileFromMemory(files: Record<string, string>, entryPath: string, options?: { cwd?: string }): CompiledDarkmownPage;
