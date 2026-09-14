import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packager } from '@electron/packager';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'shinano-package-'));
try {
  await cp('dist', join(staging, 'dist'), { recursive: true });
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name: manifest.name,
    productName: manifest.productName,
    version: manifest.version,
    main: manifest.main,
    private: true,
  }));
  const outputs = await packager({
    dir: staging,
    name: 'Shinano',
    executableName: 'Shinano',
    appBundleId: 'io.github.a13x-4793-3654.shinano',
    appVersion: manifest.version,
    electronVersion: manifest.devDependencies.electron,
    out: resolve('release'),
    platform: process.platform,
    arch: process.arch,
    asar: true,
    overwrite: true,
    prune: true,
  });
  console.log(`Unsigned local application: ${outputs.join(', ')}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
