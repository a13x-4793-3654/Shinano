import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { packager } from '@electron/packager';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'shinano-package-'));
const packagingOutput = await mkdtemp(join(tmpdir(), 'shinano-output-'));
try {
  await cp('dist', join(staging, 'dist'), { recursive: true });
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name: manifest.name,
    productName: manifest.productName,
    version: manifest.version,
    author: manifest.author,
    main: manifest.main,
    private: true,
  }));
  const packagedPaths = await packager({
    dir: staging,
    name: 'Shinano',
    executableName: 'Shinano',
    appBundleId: 'io.github.a13x-4793-3654.shinano',
    appVersion: manifest.version,
    electronVersion: manifest.devDependencies.electron,
    out: packagingOutput,
    platform: process.platform,
    arch: process.arch,
    asar: true,
    overwrite: true,
    prune: true,
  });
  const releaseDirectory = resolve('release');
  await mkdir(releaseDirectory, { recursive: true });
  const outputs = [];
  for (const packagedPath of packagedPaths) {
    const destination = join(releaseDirectory, basename(packagedPath));
    await rm(destination, { recursive: true, force: true });
    await cp(packagedPath, destination, { recursive: true });
    outputs.push(destination);
  }
  console.log(`Unsigned local application: ${outputs.join(', ')}`);
} finally {
  await Promise.all([
    rm(staging, { recursive: true, force: true }),
    rm(packagingOutput, { recursive: true, force: true }),
  ]);
}
