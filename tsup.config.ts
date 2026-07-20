import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: `index` is side-effect-free (classes + types, you call define()
  // yourself); `define` registers the elements on import, for a plain <script>.
  entry: ['src/index.ts', 'src/define.ts'],
  format: ['esm', 'cjs'],
  // Declarations come from tsc (`npm run build:types`), not tsup — see the SDK's
  // tsup.config.ts for why (rollup-plugin-dts crashes under TypeScript 7).
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  treeshake: true,
  target: 'es2022',
  // The SDK is a real dependency, not inlined: a till that already uses it
  // should not end up with two copies and two client classes.
  external: ['@nscodecom/loso-pos-sdk'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
