import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { pathToFileURL } from 'node:url';

export const mainOptions = {
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  outfile: 'dist/main/main.cjs',
  logLevel: 'warning',
};

export const preloadOptions = {
  entryPoints: ['src/preload/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  outfile: 'dist/main/preload.cjs',
  logLevel: 'warning',
};

export const rendererOptions = {
  configFile: false,
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome152',
  },
};

export async function buildMain() {
  await Promise.all([bundle(mainOptions), bundle(preloadOptions)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await Promise.all([buildMain(), buildRenderer(rendererOptions)]);
}
