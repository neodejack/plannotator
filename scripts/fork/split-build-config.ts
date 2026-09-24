// Fork-only: turn an app's single-file Vite config into a code-split build.
//
// Output goes to <app>/dist/split/ with every chunk and asset under /_app/,
// the prefix packages/server/app-shell.ts serves as immutable. Vite names each
// file by content hash, so chunks identical in both apps (Shiki grammars,
// React, the shared UI) get identical names and are cached once.
import type { PluginOption, UserConfig } from 'vite';

export const SPLIT_ASSETS_DIR = '_app';

function flatten(plugins: PluginOption[] | undefined): PluginOption[] {
  return (plugins ?? []).flat(Infinity as 1) as PluginOption[];
}

export function splitBuildConfig(base: UserConfig): UserConfig {
  const output = base.build?.rollupOptions?.output;
  if (Array.isArray(output)) throw new Error('split build: array rollup outputs are not supported');
  return {
    ...base,
    plugins: flatten(base.plugins).filter(
      (p) => !(p && typeof p === 'object' && 'name' in p && p.name === 'vite:singlefile'),
    ),
    build: {
      ...base.build,
      outDir: 'dist/split',
      emptyOutDir: true,
      assetsDir: SPLIT_ASSETS_DIR,
      // Back to Vite's default: small assets inline, large ones get their own
      // cacheable file instead of a base64 copy inside a chunk.
      assetsInlineLimit: 4096,
      cssCodeSplit: true,
      rollupOptions: {
        ...base.build?.rollupOptions,
        output: { ...output, inlineDynamicImports: false },
      },
    },
  };
}
