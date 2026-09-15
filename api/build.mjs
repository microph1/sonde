import { build } from 'esbuild';
import { resolve } from 'node:path';

/**
 * `@microphi/di` keys its container off `Symbol('ClassName')`, which is unique
 * per module instance. Under npm link, apigator resolves `@microphi/di` to the
 * microgamma checkout's own copy, so decorators would register into a second,
 * invisible registry and every injection would fail with "is it annotated with
 * @Injectable()?". Aliasing collapses them to one copy.
 */
// These are symlinks into the local checkouts; esbuild resolves them to their
// real paths, so every importer ends up on one physical copy.
const single = (name) => resolve('node_modules', name);

await build({
  entryPoints: ['lib/main.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/main.js',
  sourcemap: true,
  external: ['express'],
  alias: {
    '@microphi/di': single('@microphi/di'),
    '@microphi/debug': single('@microphi/debug'),
  },
  logLevel: 'warning',
});
