// Derive CommonJS declarations (.d.cts) from the ESM ones tsc emits (.d.ts).
//
// package.json sets "type": "module", so a .d.ts file is an *ESM* declaration.
// A CJS consumer under moduleResolution node16 that resolves types through the
// "require" condition and lands on a .d.ts gets TS1479 ("the referenced file is
// an ECMAScript module and cannot be imported with 'require'"). It needs a
// .d.cts, whose extension tells TypeScript the module is CommonJS.
//
// The declarations are emitted per-file rather than bundled, so a plain copy is
// not enough: index.d.cts importing './client.js' would resolve to client.d.ts
// (ESM again). Relative specifiers are rewritten to .cjs so each one resolves to
// the .d.cts sibling this script writes alongside it.

import { readdir, readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);

const declarations = (await readdir(dist)).filter((name) => name.endsWith('.d.ts'));
if (declarations.length === 0) {
  throw new Error('No .d.ts files in dist/ — run `npm run build:types` first.');
}

for (const name of declarations) {
  const source = await readFile(new URL(name, dist), 'utf8');
  const rewritten = source.replace(/(\bfrom\s+['"]\.{1,2}\/[^'"]+)\.js(['"])/g, '$1.cjs$2');
  await writeFile(new URL(name.replace(/\.d\.ts$/, '.d.cts'), dist), rewritten);
}

console.log(`emit-cjs-types: wrote ${declarations.length} .d.cts file(s)`);
