// Verifies that the *packed* package resolves for real consumers.
//
// `npm run typecheck` compiles src/ and proves nothing about what ships: the
// exports map, the declaration file layout, and the .d.ts/.d.cts split are only
// exercised once something installs the tarball. A CommonJS require-condition
// pointing at an ESM .d.ts typechecks fine inside this repo and fails for every
// consumer — that regression shipped once already.
//
// So: pack the tarball, install it into a throwaway project, and typecheck the
// fixtures in test/package-types/ against it under moduleResolution node16.
//
// Assumes dist/ is already built (CI runs `npm run build` first).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(repo, 'test', 'package-types');

// On Windows npm is a .cmd shim, and Node refuses to spawn those without a
// shell. Going through the shell means quoting anything that might contain a
// space (the temp directory usually does).
const onWindows = process.platform === 'win32';
const npm = onWindows ? 'npm.cmd' : 'npm';
const runNpm = (args, options) =>
  execFileSync(npm, onWindows ? args.map((a) => `"${a}"`) : args, {
    ...options,
    shell: onWindows,
    stdio: 'inherit',
  });

const work = mkdtempSync(join(tmpdir(), 'pkg-types-'));
let failed = false;

try {
  // Pack the real tarball rather than linking the source directory: only a
  // tarball respects the "files" allowlist, so a declaration left out of the
  // published package shows up here as a resolution failure.
  runNpm(['pack', '--pack-destination', work], { cwd: repo });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2),
  );

  runNpm(['install', join(work, tarball), '--no-audit', '--no-fund'], { cwd: work });

  for (const file of ['esm.mts', 'cjs.cts', 'tsconfig.esm.json', 'tsconfig.cjs.json']) {
    copyFileSync(join(fixtures, file), join(work, file));
  }

  // Compile the two consumers in SEPARATE programs. This package augments a
  // global (HTMLElementTagNameMap); loading the ESM and CJS declarations in one
  // program makes that augmentation collide with itself across the two module
  // identities. No real consumer is both at once, so each is checked alone.
  // Use this repo's tsc; the throwaway project has no TypeScript of its own.
  const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const config of ['tsconfig.esm.json', 'tsconfig.cjs.json']) {
    execFileSync(process.execPath, [tsc, '-p', join(work, config)], { stdio: 'inherit' });
  }

  console.log('\npackage-types: ESM and CJS consumers both resolve the packed package');
} catch (error) {
  failed = true;
  console.error(`\npackage-types: FAILED — ${error.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
