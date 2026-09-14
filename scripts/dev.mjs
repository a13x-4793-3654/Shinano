import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import { buildMain, rendererOptions } from './build.mjs';

await buildMain();
const server = await createServer({
  ...rendererOptions,
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, SHINANO_DEV_URL: 'http://127.0.0.1:5173/' },
});
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill('SIGTERM');
  await server.close();
  process.exitCode = code;
}
child.on('exit', (code) => void stop(code ?? 1));
child.on('error', () => {
  console.error('Electron could not start.');
  void stop(1);
});
process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));
console.log('Shinano: renderer HMR on http://127.0.0.1:5173/; restart for main/preload changes.');
