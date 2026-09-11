import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The dashboard imports the agents' indexer and scorer directly from ../agents/src/lib
 * so the web UI and the CLI agents can never disagree about what a number means. Those
 * files live outside this Vite root, hence the fs.allow entry.
 *
 * `base: './'` keeps the built asset paths relative, so the same dist/ works on Vercel,
 * Netlify, and a GitHub Pages project subpath without a rebuild.
 */
export default defineConfig({
  base: './',
  server: { fs: { allow: ['..'] } },
  // The agents lib lives outside this root, so a bare `viem` import inside it would
  // otherwise be resolved by walking up from agents/ and miss web/node_modules on a
  // clean checkout (Vercel installs only this package). Pin it to ours.
  resolve: {
    dedupe: ['viem'],
    alias: [{ find: /^viem($|\/)/, replacement: fileURLToPath(new URL('./node_modules/viem/', import.meta.url)) }],
  },
  build: { target: 'es2022', outDir: 'dist' },
});
