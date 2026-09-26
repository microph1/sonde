/**
 * Point the TypeScript projects at published packages.
 *
 * `api` and `web` depend on @microphi/* and @microgamma/* through `file:` paths
 * into sibling checkouts. That is deliberate: those packages are developed
 * alongside this one, and a `file:` dependency means a change there shows up
 * here without a publish. It also means the tree only installs on a machine
 * that has those checkouts - which CI, and anyone who clones this repository,
 * does not.
 *
 * So CI swaps them for the published versions before installing. Local
 * development is untouched; `npm link` is the supported way to put a working
 * copy back on top.
 *
 * Usage: node .github/ci/use-published-packages.mjs api web
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const PUBLISHED = {
  '@microphi/debug': '^2.11.0',
  '@microphi/di': '^2.11.0',
  '@microphi/store': '^2.11.0',
  '@microphi/styles': '^1.5.0',
  '@microgamma/apigator': '^2.1.0',
};

for (const project of process.argv.slice(2)) {
  const path = `${project}/package.json`;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const swapped = [];

  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (!range.startsWith('file:')) {
        continue;
      }

      const published = PUBLISHED[name];

      // Failing loudly beats installing something that silently is not there:
      // a new local dependency has to be added to the table above, and if it
      // is not published yet then that is the thing to fix.
      if (!published) {
        throw new Error(`${name} is a file: dependency with no published version on record`);
      }

      manifest[section][name] = published;
      swapped.push(`${name}@${published}`);
    }
  }

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

  // The lock file still describes those dependencies as links to a path that
  // is not there, and npm honours the lock: it installed everything else and
  // said nothing, leaving a build that could not resolve @microphi/di. With
  // the manifest rewritten the lock is no longer a description of this tree,
  // so it goes.
  if (swapped.length) {
    rmSync(`${project}/package-lock.json`, { force: true });
  }
  console.log(`${path}: ${swapped.length ? swapped.join(', ') : 'nothing to swap'}`);
}
