import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Dir } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  encodeEnvelope, encodeWrapping, MAX_ENVELOPE_BYTES, MAX_WRAPPING_BYTES,
  type EnvelopePurpose, type SealedEnvelope, type WrappingEnvelope,
} from '../../src/main/vault-crypto.ts';
import { VaultFolder, type FolderEnvelope } from '../../src/main/vault-folder.ts';
import { UserError } from '../../src/shared/validation.ts';

const APP_DIRECTORY = 'Shinano Sync';
const STAGING_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.svstage$/;

function isStagingPath(path: unknown, directory: string): path is string {
  return typeof path === 'string' && dirname(path) === directory && STAGING_NAME.test(basename(path));
}

async function stagingNames(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((name) => STAGING_NAME.test(name)).sort();
}

async function fixture(context: TestContext): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'shinano-vault-folder-fixture-'));
  context.after(async () => { await fs.rm(path, { recursive: true, force: true }); });
  return fs.realpath(path);
}

// Schema-only ciphertext fixtures: transport neither authenticates these tags/proofs nor handles keys.
function operation(vaultId: string, purpose: EnvelopePurpose = 'operation'): SealedEnvelope {
  return {
    version: 1, purpose, vaultId, envelopeId: randomUUID(),
    salt: Buffer.alloc(32, 11).toString('base64'),
    nonce: Buffer.alloc(12, 12).toString('base64'),
    ciphertext: Buffer.alloc(32, 13).toString('base64'),
    tag: Buffer.alloc(16, 14).toString('base64'),
  };
}

function wrapping(vaultId: string): WrappingEnvelope {
  return {
    version: 1, vaultId, wrapperId: randomUUID(), generation: 1, parents: [],
    kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt: Buffer.alloc(32, 15).toString('base64') },
    passphrase: operation(vaultId, 'passphrase'), recovery: operation(vaultId, 'recovery'),
    proof: Buffer.alloc(32, 16).toString('base64'),
  };
}

async function createdVault(context: TestContext): Promise<{
  root: string; folder: VaultFolder; vaultId: string; wrapper: WrappingEnvelope; directory: string;
}> {
  const root = await fixture(context);
  const folder = await VaultFolder.select(root, []);
  const vaultId = randomUUID();
  const wrapper = wrapping(vaultId);
  await folder.createVault(vaultId, wrapper);
  return { root, folder, vaultId, wrapper, directory: join(folder.root, APP_DIRECTORY, vaultId) };
}

async function collect(folder: VaultFolder, vaultId: string): Promise<FolderEnvelope[]> {
  const entries: FolderEnvelope[] = [];
  for await (const entry of folder.operations(vaultId)) entries.push(entry);
  return entries;
}

function safeError(error: unknown): error is UserError {
  assert.ok(error instanceof UserError);
  assert.match(error.message, /ローカルフォルダー/);
  assert.doesNotMatch(error.message, /Synthetic private|vault-folder-fixture-|ENOENT|EACCES|EIO/);
  return true;
}

async function link(
  context: TestContext, target: string, path: string, type: 'file' | 'dir',
): Promise<boolean> {
  try {
    await fs.symlink(target, path, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error
      && (error.code === 'EPERM' || error.code === 'EACCES')) {
      context.skip('Windows のリンク作成権限がありません。リンク検証を実行できませんでした。');
      return false;
    }
    throw error;
  }
}

test('selection is read-only; creation and enumeration stay in the new app/vault scope', async (context) => {
  const root = await fixture(context);
  const unrelated = join(root, 'unrelated.bin');
  const unknownBytes = Buffer.from([0, 255, 1, 2, 3]);
  await fs.writeFile(unrelated, unknownBytes);
  const folder = await VaultFolder.select(root, []);
  assert.equal(folder.root, await fs.realpath(root));
  assert.deepEqual(await folder.listVaultIds(), []);
  assert.deepEqual(await fs.readdir(root), ['unrelated.bin']);

  const a = randomUUID();
  const b = randomUUID();
  const aWrapping = wrapping(a);
  const bWrapping = wrapping(b);
  await folder.createVault(a, aWrapping);
  await folder.createVault(b, bWrapping);
  const aOperation = operation(a);
  const bOperation = operation(b);
  await folder.publishOperation(a, aOperation);
  await folder.publishOperation(b, bOperation);
  const unknownDirectory = join(root, APP_DIRECTORY, a, 'unrelated-directory');
  await fs.mkdir(unknownDirectory);
  const nestedUnknownFile = join(unknownDirectory, `${randomUUID()}.svop`);
  await fs.writeFile(nestedUnknownFile, 'Synthetic broken unrelated file');
  await fs.writeFile(join(root, `${randomUUID()}.svop`), 'Synthetic root file, not a vault record');

  assert.deepEqual(await folder.listVaultIds(), [a, b].sort());
  assert.deepEqual(await folder.readWrappings(a), [aWrapping]);
  assert.deepEqual(await folder.readWrappings(b), [bWrapping]);
  assert.deepEqual((await collect(folder, a)).map((entry) => entry.envelope), [aOperation]);
  assert.deepEqual((await collect(folder, b)).map((entry) => entry.envelope), [bOperation]);
  assert.deepEqual(await fs.readFile(unrelated), unknownBytes);
  assert.equal(await fs.readFile(nestedUnknownFile, 'utf8'), 'Synthetic broken unrelated file');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(join(root, APP_DIRECTORY))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(join(root, APP_DIRECTORY, a))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(join(root, APP_DIRECTORY, a, `${aWrapping.wrapperId}.svkey`))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(join(root, APP_DIRECTORY, a, `${aOperation.envelopeId}.svop`))).mode & 0o777, 0o600);
  }
});

test('selection requires an existing absolute regular directory and rejects final links including trailing separators', async (context) => {
  const root = await fixture(context);
  await assert.rejects(VaultFolder.select('relative-directory', []), safeError);
  await assert.rejects(VaultFolder.select(join(root, 'missing'), []), safeError);
  const regular = join(root, 'regular-file');
  await fs.writeFile(regular, 'Synthetic regular file');
  await assert.rejects(VaultFolder.select(regular, []), safeError);
  const target = join(root, 'actual');
  await fs.mkdir(target);
  const alias = join(root, 'selected-link');
  if (!await link(context, target, alias, 'dir')) return;
  await assert.rejects(VaultFolder.select(alias, []), safeError);
  await assert.rejects(VaultFolder.select(`${alias}${sep}`, []), safeError);
  assert.deepEqual(await fs.readdir(target), []);
});

test('canonical parent aliases work, but selecting an app-owned directory or descendant does not nest a vault', async (context) => {
  const root = await fixture(context);
  const actual = join(root, 'actual');
  await fs.mkdir(actual);
  const picked = join(actual, 'picked');
  await fs.mkdir(picked);
  const alias = join(root, 'parent-alias');
  if (!await link(context, actual, alias, 'dir')) return;
  const folder = await VaultFolder.select(join(alias, 'picked'), []);
  assert.equal(folder.root, await fs.realpath(picked));
  const vaultId = randomUUID();
  await folder.createVault(vaultId, wrapping(vaultId));
  await assert.rejects(VaultFolder.select(join(picked, APP_DIRECTORY), []), safeError);
  await assert.rejects(VaultFolder.select(join(picked, APP_DIRECTORY, vaultId), []), safeError);
  assert.deepEqual(await fs.readdir(join(picked, APP_DIRECTORY)), [vaultId]);
});

test('forbidden destinations include canonical aliases and not-yet-created app directories, not similar siblings', async (context) => {
  const root = await fixture(context);
  for (const name of ['application', 'repository', 'resources', 'synthetic-userData']) {
    const protectedRoot = join(root, name);
    const picked = join(protectedRoot, 'picked');
    await fs.mkdir(picked, { recursive: true });
    await assert.rejects(VaultFolder.select(picked, [protectedRoot]), safeError);
    assert.deepEqual(await fs.readdir(picked), []);
  }
  const safe = join(root, 'synthetic-userData-other');
  await fs.mkdir(safe);
  const folder = await VaultFolder.select(safe, [join(root, 'synthetic-userData')]);
  assert.deepEqual(await folder.listVaultIds(), []);
  await assert.rejects(VaultFolder.select(safe, [join(safe, APP_DIRECTORY)]), safeError);
  await assert.rejects(VaultFolder.select(safe, [join(safe, APP_DIRECTORY.toLowerCase())]), safeError);
  const protectedAlias = join(root, 'protected-alias');
  if (!await link(context, join(root, 'synthetic-userData'), protectedAlias, 'dir')) return;
  await assert.rejects(VaultFolder.select(join(root, 'synthetic-userData', 'picked'), [protectedAlias]), safeError);
  await assert.rejects(VaultFolder.select(join(protectedAlias, 'picked'), [join(root, 'synthetic-userData')]), safeError);
  const dangling = join(root, 'future-protected-alias');
  if (!await link(context, join(safe, APP_DIRECTORY), dangling, 'dir')) return;
  await assert.rejects(VaultFolder.select(safe, [dangling]), safeError);
});

test('Git directory markers reject repository roots and gitignored descendants outside packaged application paths', async (context) => {
  const root = await fixture(context);
  const repository = join(root, 'repository');
  const picked = join(repository, 'ignored', 'nested');
  const marker = join(repository, '.git');
  const config = join(marker, 'config');
  const ignored = join(repository, '.gitignore');
  await fs.mkdir(picked, { recursive: true });
  await fs.mkdir(marker);
  await fs.writeFile(config, 'Synthetic repository metadata');
  await fs.writeFile(ignored, 'ignored/\n');
  const forbiddenRoots = ['packaged-app', 'resources', 'synthetic-userData'].map((name) => join(root, name));
  await Promise.all(forbiddenRoots.map((path) => fs.mkdir(path)));
  for (const path of [repository, picked]) {
    await assert.rejects(VaultFolder.select(path, forbiddenRoots), /ローカルフォルダー.*Git 作業ツリー/);
    await assert.rejects(fs.lstat(join(path, APP_DIRECTORY)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(config, 'utf8'), 'Synthetic repository metadata');
  assert.equal(await fs.readFile(ignored, 'utf8'), 'ignored/\n');
  assert.deepEqual(await fs.readdir(picked), []);

  const safe = join(root, 'non-repository-sibling');
  await fs.mkdir(safe);
  const folder = await VaultFolder.select(safe, forbiddenRoots);
  assert.deepEqual(await folder.listVaultIds(), []);
});

test('worktree-style .git files reject roots and descendants without reading gitdir contents or scanning unrelated folders', async (context) => {
  const root = await fixture(context);
  const worktree = join(root, 'worktree');
  const picked = join(worktree, 'ignored', 'nested');
  await fs.mkdir(picked, { recursive: true });
  const marker = join(worktree, '.git');
  const bytes = 'gitdir: ../synthetic-administration/worktrees/fixture\n';
  await fs.writeFile(marker, bytes);
  const readFileMock = context.mock.method(fs, 'readFile', async () => { throw new Error('Unexpected Git content read'); });
  const readdirMock = context.mock.method(fs, 'readdir', async () => { throw new Error('Unexpected unrelated scan'); });
  const opendirMock = context.mock.method(fs, 'opendir', async () => { throw new Error('Unexpected unrelated scan'); });
  try {
    for (const path of [worktree, picked]) {
      await assert.rejects(VaultFolder.select(path, []), /ローカルフォルダー.*Git 作業ツリー/);
      await assert.rejects(fs.lstat(join(path, APP_DIRECTORY)), { code: 'ENOENT' });
    }
    assert.equal(readFileMock.mock.callCount(), 0);
    assert.equal(readdirMock.mock.callCount(), 0);
    assert.equal(opendirMock.mock.callCount(), 0);
  } finally {
    opendirMock.mock.restore();
    readdirMock.mock.restore();
    readFileMock.mock.restore();
  }
  assert.equal(await fs.readFile(marker, 'utf8'), bytes);
  await assert.rejects(fs.lstat(join(root, 'synthetic-administration')), { code: 'ENOENT' });
});

test('canonical parent aliases cannot hide a repository ancestor from folder selection', async (context) => {
  const root = await fixture(context);
  const repository = join(root, 'repository');
  const picked = join(repository, 'ignored', 'nested');
  await fs.mkdir(picked, { recursive: true });
  await fs.mkdir(join(repository, '.git'));
  const alias = join(root, 'parent-alias');
  if (!await link(context, repository, alias, 'dir')) return;
  await assert.rejects(VaultFolder.select(join(alias, 'ignored', 'nested'), []), /Git 作業ツリー/);
  assert.deepEqual(await fs.readdir(picked), []);
});

test('unreadable Git markers fail closed with a sanitized folder error', async (context) => {
  const root = await fixture(context);
  const lstat = fs.lstat;
  const marker = join(root, '.git');
  const markerMock = context.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === marker) {
      throw Object.assign(new Error(`Synthetic private ${marker}`), { code: 'EACCES' });
    }
    return lstat(...args);
  });
  await assert.rejects(VaultFolder.select(root, []), safeError);
  markerMock.mock.restore();
  assert.deepEqual(await fs.readdir(root), []);
});

test('Git ancestry checks stop after 128 markers and reject an unverified deeper location without writes', async (context) => {
  const root = await fixture(context);
  const picked = join(root, ...Array.from({ length: 129 }, () => 'd'));
  await fs.mkdir(picked, { recursive: true });
  await fs.mkdir(join(root, '.git'));
  const lstat = fs.lstat;
  const probes: string[] = [];
  const markerMock = context.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const path = String(args[0]);
    if (basename(path) === '.git') probes.push(path);
    return lstat(...args);
  });
  await assert.rejects(VaultFolder.select(picked, []), /ローカルフォルダー.*上限.*Git 管理外/);
  markerMock.mock.restore();
  assert.equal(probes.length, 128);
  assert.equal(probes[0], join(picked, '.git'));
  for (let index = 1; index < probes.length; index++) {
    assert.equal(probes[index], join(dirname(dirname(probes[index - 1]!)), '.git'));
  }
  assert.equal(probes.includes(join(root, '.git')), false);
  assert.deepEqual(await fs.readdir(picked), []);
});

test('a root initialized as a Git worktree after selection cannot receive vault data', async (context) => {
  const root = await fixture(context);
  const folder = await VaultFolder.select(root, []);
  const marker = join(root, '.git');
  await fs.writeFile(marker, 'gitdir: ../synthetic-git-administration\n');
  const vaultId = randomUUID();
  await assert.rejects(folder.createVault(vaultId, wrapping(vaultId)), /Git 作業ツリー/);
  await assert.rejects(folder.listVaultIds(), /Git 作業ツリー/);
  assert.deepEqual(await fs.readdir(root), ['.git']);
  assert.equal(await fs.readFile(marker, 'utf8'), 'gitdir: ../synthetic-git-administration\n');
});

test('Git markers in owned app or vault directories prevent access without touching existing encrypted files', async (context) => {
  const { root, folder, vaultId, wrapper, directory } = await createdVault(context);
  const file = join(directory, `${wrapper.wrapperId}.svkey`);
  const bytes = await fs.readFile(file);
  const marker = join(directory, '.git');
  await fs.writeFile(marker, 'gitdir: ../../synthetic-git-administration\n');
  await assert.rejects(folder.listVaultIds(), /Git 作業ツリー/);
  await assert.rejects(folder.readWrappings(vaultId), /Git 作業ツリー/);
  await assert.rejects(folder.publishOperation(vaultId, operation(vaultId)), /Git 作業ツリー/);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.git', `${wrapper.wrapperId}.svkey`].sort());

  await fs.mkdir(join(root, APP_DIRECTORY, '.git'));
  await assert.rejects(VaultFolder.select(root, []), /Git 作業ツリー/);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('existing vaults are never recreated, and invalid publication does not initialize a vault', async (context) => {
  const { root, folder, vaultId, wrapper, directory } = await createdVault(context);
  const before = await fs.readFile(join(directory, `${wrapper.wrapperId}.svkey`));
  await assert.rejects(folder.createVault(vaultId, wrapper), /既にあります/);
  await assert.rejects(folder.createVault(randomUUID(), wrapper), safeError);
  for (const value of ['../escape', '', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
    await assert.rejects(folder.createVault(value, wrapper), safeError);
    await assert.rejects(collect(folder, value), safeError);
  }
  assert.deepEqual(await fs.readdir(join(root, APP_DIRECTORY)), [vaultId]);
  assert.deepEqual(await fs.readFile(join(directory, `${wrapper.wrapperId}.svkey`)), before);
  const fresh = join(root, 'fresh-selection');
  await fs.mkdir(fresh);
  const selected = await VaultFolder.select(fresh, []);
  await assert.rejects(selected.createVault(vaultId, { ...wrapper, version: 2 } as unknown as WrappingEnvelope), safeError);
  assert.deepEqual(await fs.readdir(fresh), []);
});

test('vault listing rejects recognized files or links, ignores unknown names, and enforces 64 UUID directories', async (context) => {
  const { root, folder, vaultId } = await createdVault(context);
  const app = join(root, APP_DIRECTORY);
  await fs.writeFile(join(app, 'not-a-vault'), 'Synthetic unknown bytes');
  const invalid = randomUUID();
  await fs.writeFile(join(app, invalid), 'Synthetic recognized non-directory');
  await assert.rejects(folder.listVaultIds(), safeError);
  await fs.unlink(join(app, invalid));
  const ids = Array.from({ length: 63 }, () => randomUUID());
  await Promise.all(ids.map((value) => fs.mkdir(join(app, value))));
  assert.deepEqual(await folder.listVaultIds(), [vaultId, ...ids].sort());
  await fs.mkdir(join(app, randomUUID()));
  await assert.rejects(folder.listVaultIds(), /上限/);
  assert.equal(await fs.readFile(join(app, 'not-a-vault'), 'utf8'), 'Synthetic unknown bytes');
});

test('wrapping aliases deduplicate identical bytes and do not choose a conflicting same-ID winner', async (context) => {
  const { folder, vaultId, wrapper, directory } = await createdVault(context);
  const alias = join(directory, `${wrapper.wrapperId} (PC の競合コピー).svkey`);
  const bytes = encodeWrapping(wrapper);
  await fs.writeFile(alias, bytes);
  assert.deepEqual(await folder.readWrappings(vaultId), [wrapper]);
  const changedWrapper = { ...wrapper, proof: Buffer.alloc(32, 20).toString('base64') };
  const changedBytes = encodeWrapping(changedWrapper);
  await fs.writeFile(alias, changedBytes);
  await assert.rejects(folder.readWrappings(vaultId), /同じ ID の異なる/);
  assert.equal(await fs.readFile(alias, 'utf8'), changedBytes);
  assert.equal(await fs.readFile(join(directory, `${wrapper.wrapperId}.svkey`), 'utf8'), bytes);
});

test('64 wrapping IDs are bounded independently of parent-authenticated head selection', async (context) => {
  const { folder, vaultId, wrapper, directory } = await createdVault(context);
  const wrappers = [wrapper, ...Array.from({ length: 63 }, () => wrapping(vaultId))];
  await Promise.all(wrappers.slice(1).map((value) =>
    fs.writeFile(join(directory, `${value.wrapperId}.svkey`), encodeWrapping(value))));
  assert.equal((await folder.readWrappings(vaultId)).length, 64);
  const extra = wrapping(vaultId);
  await fs.writeFile(join(directory, `${extra.wrapperId}.svkey`), encodeWrapping(extra));
  await assert.rejects(folder.readWrappings(vaultId), /上限/);
  assert.equal((await fs.readdir(directory)).length, 65);
});

test('missing vaults/wrappers and recognized malformed wrapping files fail without an empty-success replacement', async (context) => {
  const { folder, vaultId, wrapper, directory } = await createdVault(context);
  const file = join(directory, `${wrapper.wrapperId}.svkey`);
  await assert.rejects(folder.readWrappings(randomUUID()), safeError);
  await assert.rejects(collect(folder, randomUUID()), safeError);
  for (const bytes of [
    '', '{', JSON.stringify({ ...wrapper, version: 2 }),
  ]) {
    await fs.writeFile(file, bytes);
    await assert.rejects(folder.readWrappings(vaultId), safeError);
    await assert.rejects(folder.publishWrapping(vaultId, wrapper), safeError);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
  await fs.writeFile(file, Buffer.alloc(MAX_WRAPPING_BYTES + 1, 1));
  await assert.rejects(folder.readWrappings(vaultId), safeError);
  assert.equal((await fs.stat(file)).size, MAX_WRAPPING_BYTES + 1);
  await fs.unlink(file);
  await assert.rejects(folder.readWrappings(vaultId), safeError);
  const other = wrapping(randomUUID());
  await fs.writeFile(file, encodeWrapping(other));
  await assert.rejects(folder.readWrappings(vaultId), safeError);
  await fs.writeFile(file, encodeWrapping({ ...wrapper, wrapperId: randomUUID() }));
  await assert.rejects(folder.readWrappings(vaultId), safeError);
});

test('exclusive publication is idempotent only for identical complete operation and wrapping bytes', async (context) => {
  const { folder, vaultId, wrapper, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const simultaneous = await Promise.allSettled([
    folder.publishOperation(vaultId, envelope), folder.publishOperation(vaultId, envelope),
  ]);
  assert.ok(simultaneous.some((result) => result.status === 'fulfilled'));
  for (const result of simultaneous) if (result.status === 'rejected') safeError(result.reason);
  await folder.publishOperation(vaultId, envelope);
  await folder.publishWrapping(vaultId, wrapper);
  const operationFile = join(directory, `${envelope.envelopeId}.svop`);
  const wrapperFile = join(directory, `${wrapper.wrapperId}.svkey`);
  const operationBefore = await fs.readFile(operationFile);
  const wrapperBefore = await fs.readFile(wrapperFile);
  await assert.rejects(folder.publishOperation(vaultId, { ...envelope, tag: Buffer.alloc(16, 21).toString('base64') }), /同じ ID の異なる/);
  await assert.rejects(folder.publishWrapping(vaultId, { ...wrapper, generation: 2 }), /同じ ID の異なる/);
  await assert.rejects(folder.publishOperation(vaultId, operation(vaultId, 'local')), safeError);
  await assert.rejects(folder.publishOperation(vaultId, operation(randomUUID())), safeError);
  await assert.rejects(folder.publishWrapping(vaultId, wrapping(randomUUID())), safeError);
  assert.deepEqual(await fs.readFile(operationFile), operationBefore);
  assert.deepEqual(await fs.readFile(wrapperFile), wrapperBefore);
  const names = await fs.readdir(directory);
  assert.deepEqual(names.filter((name) => !STAGING_NAME.test(name)).sort(), [
    `${envelope.envelopeId}.svop`, `${wrapper.wrapperId}.svkey`,
  ].sort());
  for (const name of await stagingNames(directory)) {
    assert.deepEqual(await fs.readFile(join(directory, name)), operationBefore);
  }
});

test('operation scanning yields aliases with exact byte digests and leaves logical conflict handling to the caller', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const bytes = encodeEnvelope(envelope);
  await folder.publishOperation(vaultId, envelope);
  const aliasName = `${envelope.envelopeId}${'x'.repeat(100)}.svop`;
  await fs.writeFile(join(directory, aliasName), bytes);
  const conflicting = { ...envelope, tag: Buffer.alloc(16, 22).toString('base64') };
  const conflictName = `${envelope.envelopeId} (another PC).svop`;
  await fs.writeFile(join(directory, conflictName), encodeEnvelope(conflicting));
  const entries = await collect(folder, vaultId);
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    const exact = await fs.readFile(join(directory, entry.name));
    assert.equal(entry.digest, createHash('sha256').update(exact).digest('hex'));
    assert.equal(entry.envelope.envelopeId, envelope.envelopeId);
  }
  assert.equal(entries.find((entry) => entry.name === aliasName)!.digest, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(entries.find((entry) => entry.name === conflictName)!.envelope, conflicting);
});

test('unknown files and out-of-bounds aliases are untouched, never parsed or removed', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  await folder.publishOperation(vaultId, envelope);
  const unknownNames = [
    'unrelated.json', 'unsupported.svop', `${randomUUID()}.other`,
    `${randomUUID()}${'x'.repeat(101)}.svop`, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.svop',
  ];
  const bytes = Buffer.from([255, 0, 254, 1]);
  await Promise.all(unknownNames.map((name) => fs.writeFile(join(directory, name), bytes)));
  const entries = await collect(folder, vaultId);
  assert.equal(entries.length, 1);
  for (const name of unknownNames) {
    await assert.rejects(folder.removeOperation(vaultId, { ...entries[0]!, name }), safeError);
    assert.deepEqual(await fs.readFile(join(directory, name)), bytes);
  }
  for (const name of [`../${envelope.envelopeId}.svop`, `nested\\${envelope.envelopeId}.svop`, `${envelope.envelopeId}:stream.svop`]) {
    await assert.rejects(folder.removeOperation(vaultId, { ...entries[0]!, name }), safeError);
  }
  assert.equal((await collect(folder, vaultId)).length, 1);
});

test('truncated, oversize, unsupported and relabeled operation files remain visible failures', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  const malformed = [
    '', '{', JSON.stringify({ ...envelope, version: 2 }),
    encodeEnvelope({ ...envelope, purpose: 'local' }),
    encodeEnvelope({ ...envelope, vaultId: randomUUID() }),
    encodeEnvelope({ ...envelope, envelopeId: randomUUID() }),
    JSON.stringify({ ...envelope, ciphertext: 'not base64' }),
    Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 1),
  ];
  for (const bytes of malformed) {
    await fs.writeFile(file, bytes);
    await assert.rejects(collect(folder, vaultId), safeError);
    await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
    assert.deepEqual(await fs.readFile(file), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }
});

test('guarded removal requires unchanged exact bytes, identity binding and digest; it only removes that alias', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  await folder.publishOperation(vaultId, envelope);
  const aliasName = `${envelope.envelopeId} (duplicate).svop`;
  await fs.writeFile(join(directory, aliasName), encodeEnvelope(envelope));
  const entries = await collect(folder, vaultId);
  const entry = entries.find((value) => value.name === `${envelope.envelopeId}.svop`)!;
  const file = join(directory, entry.name);
  await assert.rejects(folder.removeOperation(vaultId, { ...entry, digest: '0'.repeat(64) }), safeError);
  await assert.rejects(folder.removeOperation(vaultId, { ...entry, envelope: operation(vaultId) }), safeError);
  assert.equal(await fs.readFile(file, 'utf8'), encodeEnvelope(envelope));
  const changedBytes = encodeEnvelope({ ...envelope, tag: Buffer.alloc(16, 23).toString('base64') });
  await fs.writeFile(file, changedBytes);
  await assert.rejects(folder.removeOperation(vaultId, entry), safeError);
  assert.equal(await fs.readFile(file, 'utf8'), changedBytes);
  await fs.writeFile(file, encodeEnvelope(envelope));
  await folder.removeOperation(vaultId, entry);
  await folder.removeOperation(vaultId, entry);
  assert.deepEqual((await collect(folder, vaultId)).map((value) => value.name), [aliasName]);
  assert.equal(await fs.readFile(join(directory, aliasName), 'utf8'), encodeEnvelope(envelope));
});

test('owned app/vault directories and recognized file links are rejected without touching their targets', async (context) => {
  const root = await fixture(context);
  const picked = join(root, 'picked');
  const outside = join(root, 'outside');
  await fs.mkdir(picked);
  await fs.mkdir(outside);
  const marker = join(outside, 'marker');
  await fs.writeFile(marker, 'Synthetic unrelated target');
  const selected = await VaultFolder.select(picked, []);
  const app = join(picked, APP_DIRECTORY);
  if (!await link(context, outside, app, 'dir')) return;
  await assert.rejects(VaultFolder.select(picked, []), safeError);
  await assert.rejects(selected.listVaultIds(), safeError);
  const vaultId = randomUUID();
  await assert.rejects(selected.createVault(vaultId, wrapping(vaultId)), safeError);
  assert.deepEqual(await fs.readdir(outside), ['marker']);
  await fs.unlink(app);
  const wrapper = wrapping(vaultId);
  await selected.createVault(vaultId, wrapper);
  const directory = join(app, vaultId);
  await fs.rename(directory, join(app, 'preserved-vault'));
  if (!await link(context, outside, directory, 'dir')) return;
  await assert.rejects(selected.listVaultIds(), safeError);
  await assert.rejects(selected.readWrappings(vaultId), safeError);
  await assert.rejects(collect(selected, vaultId), safeError);
  await assert.rejects(selected.publishOperation(vaultId, operation(vaultId)), safeError);
  assert.deepEqual(await fs.readdir(outside), ['marker']);
  assert.equal(await fs.readFile(marker, 'utf8'), 'Synthetic unrelated target');
});

test('recognized symlink files cannot be read, published over, or removed', async (context) => {
  const { root, folder, vaultId, wrapper, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  await folder.publishOperation(vaultId, envelope);
  const entry = (await collect(folder, vaultId))[0]!;
  const file = join(directory, entry.name);
  const outside = join(root, 'preserved-operation');
  await fs.rename(file, outside);
  if (!await link(context, outside, file, 'file')) return;
  await assert.rejects(collect(folder, vaultId), safeError);
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  await assert.rejects(folder.removeOperation(vaultId, entry), safeError);
  assert.equal(await fs.readFile(outside, 'utf8'), encodeEnvelope(envelope));
  const wrapperFile = join(directory, `${wrapper.wrapperId}.svkey`);
  const outsideWrapper = join(root, 'preserved-wrapper');
  await fs.rename(wrapperFile, outsideWrapper);
  if (!await link(context, outsideWrapper, wrapperFile, 'file')) return;
  await assert.rejects(folder.readWrappings(vaultId), safeError);
  await assert.rejects(folder.publishWrapping(vaultId, wrapper), safeError);
  assert.equal(await fs.readFile(outsideWrapper, 'utf8'), encodeWrapping(wrapper));
});

test('recognized directories masquerading as envelope files fail rather than being traversed', async (context) => {
  const { folder, vaultId, wrapper, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  await fs.mkdir(join(directory, `${envelope.envelopeId}.svop`));
  await assert.rejects(collect(folder, vaultId), safeError);
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  const file = join(directory, `${wrapper.wrapperId}.svkey`);
  await fs.rename(file, join(directory, 'preserved-key'));
  await fs.mkdir(file);
  await assert.rejects(folder.readWrappings(vaultId), safeError);
  assert.deepEqual(await fs.readdir(file), []);
});

test('missing or replaced selected roots are errors, not an empty vault list or successful removal', async (context) => {
  const root = await fixture(context);
  const picked = join(root, 'picked');
  await fs.mkdir(picked);
  const folder = await VaultFolder.select(picked, []);
  const vaultId = randomUUID();
  await folder.createVault(vaultId, wrapping(vaultId));
  await folder.publishOperation(vaultId, operation(vaultId));
  const entry = (await collect(folder, vaultId))[0]!;
  await fs.rename(picked, join(root, 'preserved-root'));
  await assert.rejects(folder.listVaultIds(), safeError);
  await assert.rejects(folder.readWrappings(vaultId), safeError);
  await assert.rejects(folder.removeOperation(vaultId, entry), safeError);
  await fs.mkdir(picked);
  await assert.rejects(folder.listVaultIds(), safeError);
  const freshId = randomUUID();
  await assert.rejects(folder.createVault(freshId, wrapping(freshId)), safeError);
  assert.deepEqual(await fs.readdir(picked), []);
});

test('unreadable directory and unhydrated operation errors are sanitized and never treated as absence', async (context) => {
  const { root, folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  await folder.publishOperation(vaultId, envelope);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  const entry = (await collect(folder, vaultId))[0]!;
  const openDirectory = fs.opendir;
  const directoryMock = context.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    const [path] = args;
    if (String(path) === join(root, APP_DIRECTORY)) {
      throw Object.assign(new Error(`Synthetic private ${path}`), { code: 'EACCES' });
    }
    return openDirectory(...args);
  });
  await assert.rejects(folder.listVaultIds(), safeError);
  directoryMock.mock.restore();
  const open = fs.open;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path] = args;
    if (String(path) === file) throw Object.assign(new Error(`Synthetic private ${path}`), { code: 'EIO' });
    return open(...args);
  });
  await assert.rejects(collect(folder, vaultId), safeError);
  await assert.rejects(folder.removeOperation(vaultId, entry), safeError);
  openMock.mock.restore();
  assert.equal(await fs.readFile(file, 'utf8'), encodeEnvelope(envelope));
});

test('an interrupted staged operation leaves no final file and does not block collection or a restarted fresh-ID retry', async (context) => {
  const { root, folder, vaultId, wrapper, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  let stagingPath = '';
  const open = fs.open;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    const handle = await open(...args);
    if (isStagingPath(path, directory) && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) {
      stagingPath = path;
      context.mock.method(handle, 'writeFile', async () => {
        await handle.write(Buffer.from('{'));
        throw new Error(`Synthetic private ${path}`);
      });
    }
    return handle;
  });
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  openMock.mock.restore();
  assert.match(basename(stagingPath), STAGING_NAME);
  assert.equal(await fs.readFile(stagingPath, 'utf8'), '{');
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.deepEqual(await collect(folder, vaultId), []);
  assert.deepEqual(await folder.readWrappings(vaultId), [wrapper]);

  const restarted = await VaultFolder.select(root, []);
  assert.deepEqual(await collect(restarted, vaultId), []);
  const fresh = operation(vaultId);
  assert.notEqual(fresh.envelopeId, envelope.envelopeId);
  await restarted.publishOperation(vaultId, fresh);
  assert.equal(await fs.readFile(stagingPath, 'utf8'), '{');
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(join(directory, `${fresh.envelopeId}.svop`), 'utf8'), encodeEnvelope(fresh));
  assert.deepEqual((await collect(restarted, vaultId)).map((entry) => entry.envelope), [fresh]);
  assert.deepEqual(await stagingNames(directory), [basename(stagingPath)]);
});

test('failed initial wrapping staging is preserved and a restarted wrapping publication can complete the selected vault', async (context) => {
  const root = await fixture(context);
  await fs.writeFile(join(root, 'unrelated'), 'Synthetic untouched bytes');
  const folder = await VaultFolder.select(root, []);
  const vaultId = randomUUID();
  const wrapper = wrapping(vaultId);
  const directory = join(folder.root, APP_DIRECTORY, vaultId);
  const file = join(directory, `${wrapper.wrapperId}.svkey`);
  let stagingPath = '';
  const open = fs.open;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    const handle = await open(...args);
    if (isStagingPath(path, directory) && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) {
      stagingPath = path;
      context.mock.method(handle, 'writeFile', async () => {
        await handle.write(Buffer.from('{'));
        throw new Error('Synthetic private write failure');
      });
    }
    return handle;
  });
  await assert.rejects(folder.createVault(vaultId, wrapper), safeError);
  openMock.mock.restore();
  assert.match(basename(stagingPath), STAGING_NAME);
  assert.equal(await fs.readFile(stagingPath, 'utf8'), '{');
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(join(root, 'unrelated'), 'utf8'), 'Synthetic untouched bytes');
  await assert.rejects(folder.createVault(vaultId, wrapper), /既にあります/);
  await assert.rejects(folder.readWrappings(vaultId), safeError);

  const restarted = await VaultFolder.select(root, []);
  assert.deepEqual(await restarted.listVaultIds(), [vaultId]);
  const fresh = wrapping(vaultId);
  await restarted.publishWrapping(vaultId, fresh);
  assert.deepEqual(await restarted.readWrappings(vaultId), [fresh]);
  assert.deepEqual(await collect(restarted, vaultId), []);
  assert.equal(await fs.readFile(stagingPath, 'utf8'), '{');
  assert.deepEqual(await stagingNames(directory), [basename(stagingPath)]);
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
});

test('staging fsync failure retains uncommitted ciphertext without publishing it, and a retry leaves that stage alone', async (context) => {
  const { root, folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  let stagingPath = '';
  const open = fs.open;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    const handle = await open(...args);
    if (isStagingPath(path, directory) && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) {
      stagingPath = path;
      context.mock.method(handle, 'sync', async () => {
        throw Object.assign(new Error('Synthetic private fsync failure'), { code: 'EIO' });
      });
    }
    return handle;
  });
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  openMock.mock.restore();
  assert.equal(await fs.readFile(stagingPath, 'utf8'), encodeEnvelope(envelope));
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.deepEqual(await collect(folder, vaultId), []);
  let retryFlushes = 0;
  const retryMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (isStagingPath(args[0], directory) && typeof args[1] === 'number' && (args[1] & constants.O_EXCL) !== 0) {
      const sync = handle.sync.bind(handle);
      context.mock.method(handle, 'sync', async () => {
        retryFlushes++;
        await sync();
      });
    }
    return handle;
  });
  const restarted = await VaultFolder.select(root, []);
  await restarted.publishOperation(vaultId, envelope);
  retryMock.mock.restore();
  assert.equal(retryFlushes, 1);
  assert.deepEqual((await collect(restarted, vaultId)).map((entry) => entry.envelope), [envelope]);
  assert.equal(await fs.readFile(stagingPath, 'utf8'), encodeEnvelope(envelope));
  assert.deepEqual(await stagingNames(directory), [basename(stagingPath)]);
});

test('publication links only closed, flushed complete staging and removes it only after final readback', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  const bytes = encodeEnvelope(envelope);
  const events: string[] = [];
  let stagingPath = '';
  const open = fs.open;
  const hardLink = fs.link;
  const unlink = fs.unlink;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    const handle = await open(...args);
    if (isStagingPath(path, directory) && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) {
      stagingPath = path;
      const writeFile = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      context.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        events.push('write');
        await writeFile(...writeArgs);
      });
      context.mock.method(handle, 'sync', async () => {
        events.push('fsync');
        await sync();
      });
      context.mock.method(handle, 'close', async () => {
        events.push('close');
        await close();
      });
    } else if (String(path) === file) {
      assert.equal(typeof flags, 'number');
      assert.equal(Number(flags) & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC), 0);
      events.push('readback');
    }
    return handle;
  });
  const linkMock = context.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    assert.equal(String(args[0]), stagingPath);
    assert.equal(String(args[1]), file);
    assert.deepEqual(events, ['write', 'fsync', 'close']);
    assert.equal(await fs.readFile(stagingPath, 'utf8'), bytes);
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(stagingPath)).mode & 0o777, 0o600);
    }
    events.push('link');
    await hardLink(...args);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    const stage = await fs.lstat(stagingPath, { bigint: true });
    const published = await fs.lstat(file, { bigint: true });
    assert.ok(published.isFile() && !published.isSymbolicLink());
    assert.equal(stage.ino, published.ino);
    assert.equal(stage.dev, published.dev);
  });
  const unlinkMock = context.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
    assert.equal(String(args[0]), stagingPath);
    assert.deepEqual(events, ['write', 'fsync', 'close', 'link', 'readback']);
    events.push('unlink stage');
    await unlink(...args);
  });
  await folder.publishOperation(vaultId, envelope);
  unlinkMock.mock.restore();
  linkMock.mock.restore();
  openMock.mock.restore();
  assert.deepEqual(events, ['write', 'fsync', 'close', 'link', 'readback', 'unlink stage', 'readback']);
  assert.deepEqual(await stagingNames(directory), []);
  assert.equal((await fs.stat(file)).nlink, 1);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('unsupported hard-link publication fails explicitly, preserves stages, and never falls back to rename or overwrites', async (context) => {
  const { root, folder, vaultId, directory } = await createdVault(context);
  const renameMock = context.mock.method(fs, 'rename', async () => { throw new Error('Unexpected rename fallback'); });
  const preserved = new Map<string, string>();
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM', 'EACCES', 'EINVAL', 'EMLINK']) {
    const envelope = operation(vaultId);
    const file = join(directory, `${envelope.envelopeId}.svop`);
    let stagingPath = '';
    const linkMock = context.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
      stagingPath = String(args[0]);
      assert.equal(String(args[1]), file);
      throw Object.assign(new Error(`Synthetic private ${file}`), { code });
    });
    await assert.rejects(folder.publishOperation(vaultId, envelope), (error: unknown) => {
      assert.ok(safeError(error));
      assert.match(error.message, /ハードリンク/);
      assert.match(error.message, /ファイルシステム/);
      return true;
    });
    assert.equal(linkMock.mock.callCount(), 1);
    linkMock.mock.restore();
    preserved.set(stagingPath, encodeEnvelope(envelope));
    assert.equal(await fs.readFile(stagingPath, 'utf8'), encodeEnvelope(envelope));
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    assert.deepEqual(await collect(folder, vaultId), []);
  }
  assert.equal(renameMock.mock.callCount(), 0);
  renameMock.mock.restore();
  const restarted = await VaultFolder.select(root, []);
  const fresh = operation(vaultId);
  await restarted.publishOperation(vaultId, fresh);
  assert.deepEqual((await collect(restarted, vaultId)).map((entry) => entry.envelope), [fresh]);
  assert.equal((await stagingNames(directory)).length, preserved.size);
  for (const [path, bytes] of preserved) assert.equal(await fs.readFile(path, 'utf8'), bytes);
});

test('an exclusive staging creation failure is explicit and creates no final file', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  const open = fs.open;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (isStagingPath(args[0], directory)) {
      assert.equal(typeof args[1], 'number');
      assert.ok((Number(args[1]) & constants.O_EXCL) !== 0);
      throw Object.assign(new Error('Synthetic private exclusive creation failure'), { code: 'ENOTSUP' });
    }
    return open(...args);
  });
  await assert.rejects(folder.publishOperation(vaultId, envelope), /ローカルフォルダー.*ハードリンク/);
  openMock.mock.restore();
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.deepEqual(await stagingNames(directory), []);
  assert.deepEqual(await collect(folder, vaultId), []);
});

test('an EEXIST commit race accepts complete identical bytes but preserves conflicting or partial canonical data and its stage', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const hardLink = fs.link;
  for (const kind of ['identical', 'different', 'partial'] as const) {
    const envelope = operation(vaultId);
    const file = join(directory, `${envelope.envelopeId}.svop`);
    const bytes = encodeEnvelope(envelope);
    const winner = kind === 'identical' ? bytes : kind === 'partial' ? '{'
      : encodeEnvelope({ ...envelope, tag: Buffer.alloc(16, 24).toString('base64') });
    let stagingPath = '';
    const linkMock = context.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
      stagingPath = String(args[0]);
      assert.equal(String(args[1]), file);
      await fs.writeFile(file, winner, { flag: 'wx' });
      await hardLink(...args);
    });
    if (kind === 'identical') await folder.publishOperation(vaultId, envelope);
    else await assert.rejects(folder.publishOperation(vaultId, envelope), /同じ ID の異なる/);
    linkMock.mock.restore();
    assert.equal(await fs.readFile(file, 'utf8'), winner);
    if (kind === 'identical') await assert.rejects(fs.lstat(stagingPath), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(stagingPath, 'utf8'), bytes);
  }
  await assert.rejects(collect(folder, vaultId), safeError);
});

test('staging corrupted after close is never linked into a recognized canonical file', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  let stagingPath = '';
  const open = fs.open;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    const handle = await open(...args);
    if (isStagingPath(path, directory) && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) {
      stagingPath = path;
      const close = handle.close.bind(handle);
      context.mock.method(handle, 'close', async () => {
        await close();
        await fs.writeFile(path, '{');
      });
    }
    return handle;
  });
  const linkMock = context.mock.method(fs, 'link', async () => { throw new Error('Unexpected corrupt staging commit'); });
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  assert.equal(linkMock.mock.callCount(), 0);
  linkMock.mock.restore();
  openMock.mock.restore();
  assert.equal(await fs.readFile(stagingPath, 'utf8'), '{');
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.deepEqual(await collect(folder, vaultId), []);
});

test('a corrupted published canonical file still pauses scans and is never repaired or removed by staging cleanup', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  let stagingPath = '';
  const hardLink = fs.link;
  const linkMock = context.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    stagingPath = String(args[0]);
    await hardLink(...args);
    await fs.writeFile(file, '{');
  });
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  linkMock.mock.restore();
  assert.equal(await fs.readFile(file, 'utf8'), '{');
  assert.equal(await fs.readFile(stagingPath, 'utf8'), '{');
  await assert.rejects(collect(folder, vaultId), safeError);
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  assert.equal(await fs.readFile(file, 'utf8'), '{');
  assert.deepEqual(await stagingNames(directory), [basename(stagingPath)]);
});

test('a replaced staging file is not deleted even when final publication contains the expected ciphertext', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  let stagingPath = '';
  const preserved = join(directory, 'preserved-staging-inode');
  const hardLink = fs.link;
  const linkMock = context.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    stagingPath = String(args[0]);
    await hardLink(...args);
    await fs.rename(stagingPath, preserved);
    await fs.writeFile(stagingPath, 'Synthetic unrelated replacement', { flag: 'wx' });
  });
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  linkMock.mock.restore();
  assert.equal(await fs.readFile(stagingPath, 'utf8'), 'Synthetic unrelated replacement');
  assert.equal(await fs.readFile(preserved, 'utf8'), encodeEnvelope(envelope));
  assert.equal(await fs.readFile(file, 'utf8'), encodeEnvelope(envelope));
  assert.deepEqual((await collect(folder, vaultId)).map((entry) => entry.envelope), [envelope]);
});

test('a staging unlink failure preserves complete publication and retry never cleans up the stale stage', async (context) => {
  const { root, folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  let stagingPath = '';
  const unlinkMock = context.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
    stagingPath = String(args[0]);
    throw Object.assign(new Error(`Synthetic private ${stagingPath}`), { code: 'EACCES' });
  });
  await assert.rejects(folder.publishOperation(vaultId, envelope), safeError);
  unlinkMock.mock.restore();
  assert.match(basename(stagingPath), STAGING_NAME);
  assert.equal(await fs.readFile(stagingPath, 'utf8'), encodeEnvelope(envelope));
  assert.deepEqual((await collect(folder, vaultId)).map((entry) => entry.envelope), [envelope]);
  const restarted = await VaultFolder.select(root, []);
  await restarted.publishOperation(vaultId, envelope);
  assert.equal(await fs.readFile(stagingPath, 'utf8'), encodeEnvelope(envelope));
  assert.deepEqual(await stagingNames(directory), [basename(stagingPath)]);
});

test('file growth during reading is bounded and rejected, preserving the changed bytes', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  await folder.publishOperation(vaultId, envelope);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  const originalLength = Buffer.byteLength(encodeEnvelope(envelope));
  const open = fs.open;
  let requestedBytes = 0;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path] = args;
    const handle = await open(...args);
    if (String(path) === file) {
      const read = handle.read.bind(handle);
      context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        requestedBytes += length;
        const result = await read(buffer, offset, length, position);
        await fs.appendFile(file, Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 1));
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(collect(folder, vaultId), safeError);
  openMock.mock.restore();
  assert.equal(requestedBytes, originalLength);
  assert.equal((await fs.stat(file)).size, originalLength + MAX_ENVELOPE_BYTES + 1);
});

test('an equal-byte inode replacement during reading is not silently accepted', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = operation(vaultId);
  await folder.publishOperation(vaultId, envelope);
  const file = join(directory, `${envelope.envelopeId}.svop`);
  const bytes = encodeEnvelope(envelope);
  const open = fs.open;
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const [path] = args;
    const handle = await open(...args);
    if (String(path) === file) {
      const read = handle.read.bind(handle);
      context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        await fs.rename(file, join(directory, 'preserved-replaced-file'));
        await fs.writeFile(file, bytes);
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(collect(folder, vaultId), safeError);
  openMock.mock.restore();
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.equal(await fs.readFile(join(directory, 'preserved-replaced-file'), 'utf8'), bytes);
});

test('unknown and staging entries count toward the 120000 cap and scans yield event-loop progress and close handles', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const openDirectory = fs.opendir;
  let reads = 0;
  let closed = false;
  let progressed = false;
  const pending = setImmediate(() => { progressed = true; });
  context.after(() => { clearImmediate(pending); });
  const directoryMock = context.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    const [path] = args;
    if (String(path) !== directory) return openDirectory(...args);
    return {
      read: async () => {
        reads++;
        return reads <= 120_001
          ? { name: reads % 2 === 0 ? 'unknown-entry' : '11111111-1111-4111-8111-111111111111.svstage' } : null;
      },
      close: async () => { closed = true; },
    } as unknown as Dir;
  });
  await assert.rejects(collect(folder, vaultId), /上限/);
  directoryMock.mock.restore();
  assert.equal(reads, 120_001);
  assert.equal(closed, true);
  assert.equal(progressed, true);
});

test('the cumulative ciphertext budget stops before reading more than 512 MiB, without retaining a scan in memory', async (context) => {
  const { folder, vaultId, directory } = await createdVault(context);
  const envelope = { ...operation(vaultId), ciphertext: Buffer.alloc(45 * 1024, 13).toString('base64') };
  const bytes = Buffer.from(encodeEnvelope(envelope));
  const name = `${envelope.envelopeId}.svop`;
  const file = join(directory, name);
  await fs.writeFile(file, bytes);
  const nodes = new Map<string, BigIntStats>();
  for (const path of [folder.root, join(folder.root, APP_DIRECTORY), directory, file]) {
    nodes.set(path, await fs.lstat(path, { bigint: true }));
  }
  const lstat = fs.lstat;
  const realpath = fs.realpath;
  const open = fs.open;
  const opendir = fs.opendir;
  let bytesRead = 0;
  let closed = false;
  let yielded = 0;
  // A virtual stream reuses one real schema-valid fixture instead of creating 512 MiB of test files.
  const statMock = context.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) =>
    nodes.get(String(args[0])) ?? lstat(...args));
  const realpathMock = context.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) =>
    nodes.has(String(args[0])) ? String(args[0]) : realpath(...args));
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) !== file) return open(...args);
    return {
      stat: async () => nodes.get(file)!,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        bytes.copy(buffer, offset, position, position + length);
        bytesRead += length;
        return { bytesRead: length, buffer };
      },
      close: async () => {},
    } as unknown as FileHandle;
  });
  const directoryMock = context.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    if (String(args[0]) !== directory) return opendir(...args);
    return {
      read: async () => ({ name }),
      close: async () => { closed = true; },
    } as unknown as Dir;
  });
  try {
    await assert.rejects((async () => {
      for await (const entry of folder.operations(vaultId)) {
        assert.equal(entry.envelope.envelopeId, envelope.envelopeId);
        yielded++;
      }
    })(), /上限/);
  } finally {
    directoryMock.mock.restore();
    openMock.mock.restore();
    realpathMock.mock.restore();
    statMock.mock.restore();
  }
  const limit = 512 * 1024 * 1024;
  assert.equal(yielded, Math.floor(limit / bytes.length));
  assert.equal(bytesRead, yielded * bytes.length);
  assert.ok(bytesRead <= limit && bytesRead + bytes.length > limit);
  assert.equal(closed, true);
});
