import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { isMissingFile } from './atomic-file.ts';
import {
  encodeEnvelope, encodeWrapping, MAX_ENVELOPE_BYTES, MAX_WRAPPING_BYTES, parseEnvelope, parseWrapping,
  type SealedEnvelope, type WrappingEnvelope,
} from './vault-crypto.ts';
import { id, UserError } from '../shared/validation.ts';

export interface FolderEnvelope {
  name: string;
  envelope: SealedEnvelope;
  // Guards unchanged encrypted file bytes; the caller must authenticate the envelope separately.
  digest: string;
}

const APP_DIRECTORY = 'Shinano Sync';
const MAX_DIRECTORY_ENTRIES = 120_000;
const MAX_READ_BYTES = 512 * 1024 * 1024;
const MAX_VAULTS = 64;
const MAX_WRAPPINGS = 64;
const MAX_GIT_ANCESTORS = 128;
const BATCH_SIZE = 64;
const STAGING_EXTENSION = '.svstage';
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSAFE_SUFFIX = /[/\\<>:"|?*\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

interface Directory {
  path: string;
  expectedPath: string;
  identity: BigIntStats;
}

interface FileContents {
  bytes: Buffer;
  identity: BigIntStats;
}

interface ReadBudget {
  bytes: number;
}

interface ReadOptions {
  budget?: ReadBudget;
  flushExpected?: Buffer;
}

class FolderError extends UserError {}

function unavailable(): FolderError {
  return new FolderError('選択したローカルフォルダーにアクセスできないか、読み書きが完了していません。フォルダーの状態を確認して再試行してください。');
}

function unsafePath(): FolderError {
  return new FolderError('選択したローカルフォルダーまたは同期ファイルの保存先を安全に確認できません。リンクや保存場所を確認してください。');
}

function incomplete(): FolderError {
  return new FolderError('選択したローカルフォルダーの同期ファイルが不完全か、形式・ID が正しくありません。既存ファイルは置き換えていません。');
}

function changed(): FolderError {
  return new FolderError('選択したローカルフォルダーのファイルまたは保存先が処理中に変わりました。処理は完了していません。');
}

function conflict(): FolderError {
  return new FolderError('選択したローカルフォルダーに同じ ID の異なるファイルがあります。既存ファイルは置き換えていません。');
}

function quota(): FolderError {
  return new FolderError('選択したローカルフォルダーのファイル数または読み取りサイズが上限を超えています。既存ファイルを確認してください。');
}

function publicationFailure(error: unknown): unknown {
  if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM', 'EACCES', 'EINVAL', 'EMLINK']
    .some((code) => hasCode(error, code))) {
    return new FolderError('選択したローカルフォルダーでは、排他的な作成・上書きしないハードリンク公開を利用できません。対応するファイルシステムとアクセス権限を確認してください。既存ファイルは置き換えていません。');
  }
  return error;
}

function sanitized(error: unknown): FolderError {
  if (error instanceof FolderError) return error;
  return error instanceof UserError ? incomplete() : unavailable();
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === '';
}

function within(path: string, parent: string): boolean {
  const difference = relative(parent, path);
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`));
}

function forbidden(path: string, roots: readonly string[]): boolean {
  // Be conservative for case/normalization aliases without changing paths or assuming a volume's format.
  const folded = path.normalize('NFC').toLowerCase();
  return roots.some((root) => within(path, root) || within(folded, root.normalize('NFC').toLowerCase()));
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameNode(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function regularFile(stats: BigIntStats, limit: number): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw unsafePath();
  if (stats.size <= 0n || stats.size > BigInt(limit)) throw incomplete();
}

function recognizedId(name: unknown, extension: 'svkey' | 'svop'): string | undefined {
  if (typeof name !== 'string' || name.length > 36 + 100 + extension.length + 1
    || !name.endsWith(`.${extension}`)) return undefined;
  const prefix = name.slice(0, 36);
  const suffix = name.slice(36, -(extension.length + 1));
  if (!UUID_NAME.test(prefix) || UNSAFE_SUFFIX.test(suffix)) return undefined;
  return prefix;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function absolutePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw unsafePath();
  return resolve(path);
}

async function canonicalDestination(path: string): Promise<string> {
  let ancestor = absolutePath(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(await fs.realpath(ancestor), ...missing.reverse());
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      try {
        await fs.lstat(ancestor);
        throw unsafePath();
      } catch (statError) {
        if (!isMissingFile(statError)) throw statError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function assertNoGitMarker(directory: string): Promise<void> {
  let marker: BigIntStats;
  try {
    marker = await fs.lstat(join(directory, '.git'), { bigint: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (!marker.isDirectory() && !marker.isFile()) throw unsafePath();
  throw new FolderError('選択したローカルフォルダーは Git 作業ツリー内にあるため使用できません。Git 管理外のフォルダーを選択してください。');
}

async function assertOutsideGitWorktree(path: string): Promise<void> {
  let ancestor = path;
  // Inspect only known marker paths; never enumerate a user's folders or read gitdir/config contents.
  for (let count = 0; count < MAX_GIT_ANCESTORS; count++) {
    await assertNoGitMarker(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
  throw new FolderError('選択したローカルフォルダーの上位フォルダー数が上限を超えたため、Git 管理外か確認できません。より浅い保存先を選択してください。');
}

async function inspectDirectory(expectedPath: string, parent?: Directory): Promise<Directory> {
  const before = await fs.lstat(expectedPath, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw unsafePath();
  const path = await fs.realpath(expectedPath);
  if (parent && !samePath(dirname(path), parent.path)) throw unsafePath();
  const after = await fs.lstat(expectedPath, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameNode(before, after)) throw changed();
  return { path, expectedPath, identity: after };
}

async function verifyDirectories(directories: readonly Directory[]): Promise<void> {
  for (const directory of directories) {
    const current = await inspectDirectory(directory.expectedPath);
    if (!samePath(current.path, directory.path) || !sameNode(current.identity, directory.identity)) throw changed();
  }
}

async function syncDirectory(directories: readonly Directory[]): Promise<void> {
  await verifyDirectories(directories);
  // Windows does not provide portable directory fsync through Node's file handles.
  if (process.platform !== 'win32') {
    const directory = directories[directories.length - 1]!;
    const handle = await fs.open(directory.path, constants.O_RDONLY | NO_FOLLOW | (constants.O_DIRECTORY ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isDirectory() || !sameNode(before, directory.identity)) throw changed();
      try {
        await handle.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].some((code) => hasCode(error, code))) throw error;
      }
      const after = await handle.stat({ bigint: true });
      if (!after.isDirectory() || !sameNode(before, after)) throw changed();
    } finally {
      await handle.close();
    }
  }
  await verifyDirectories(directories);
}

async function* directoryNames(directories: readonly Directory[]): AsyncGenerator<string> {
  await verifyDirectories(directories);
  const directory = await fs.opendir(directories[directories.length - 1]!.path, { bufferSize: BATCH_SIZE });
  try {
    await verifyDirectories(directories);
    let count = 0;
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      if (++count > MAX_DIRECTORY_ENTRIES) throw quota();
      if (count % BATCH_SIZE === 0) {
        await setImmediate();
        await verifyDirectories(directories);
      }
      yield entry.name;
    }
  } finally {
    await directory.close();
  }
  await verifyDirectories(directories);
}

async function readFile(
  directories: readonly Directory[], name: string, limit: number, options: ReadOptions = {},
): Promise<FileContents> {
  await verifyDirectories(directories);
  const path = join(directories[directories.length - 1]!.path, name);
  const before = await fs.lstat(path, { bigint: true });
  regularFile(before, limit);
  if (options.budget && options.budget.bytes + Number(before.size) > MAX_READ_BYTES) throw quota();
  const flags = options.flushExpected ? constants.O_RDWR | NO_FOLLOW | (constants.O_NONBLOCK ?? 0) : READ_FLAGS;
  const handle = await fs.open(path, flags);
  let bytes: Buffer;
  let identity: BigIntStats;
  try {
    const opened = await handle.stat({ bigint: true });
    regularFile(opened, limit);
    if (!sameFile(before, opened)) throw changed();
    await verifyDirectories(directories);
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    // Never use handle.readFile(): a growing file must not cause an unbounded allocation or read.
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw incomplete();
      offset += bytesRead;
      if (options.budget) options.budget.bytes += bytesRead;
    }
    if (options.flushExpected) {
      if (!bytes.equals(options.flushExpected)) throw conflict();
      // An earlier complete write may have failed at fsync; a retry must flush it, not just read the cache.
      await handle.sync();
    }
    identity = await handle.stat({ bigint: true });
    regularFile(identity, limit);
    if (!sameFile(opened, identity)) throw changed();
  } finally {
    await handle.close();
  }
  const current = await fs.lstat(path, { bigint: true });
  regularFile(current, limit);
  if (!sameFile(identity, current)) throw changed();
  await verifyDirectories(directories);
  return { bytes, identity };
}

async function verifyExistingPublication(
  directories: readonly Directory[], name: string, bytes: Buffer, limit: number,
): Promise<FileContents> {
  const existing = await readFile(directories, name, limit, { flushExpected: bytes });
  await syncDirectory(directories);
  const verified = await readFile(directories, name, limit);
  if (!sameFile(existing.identity, verified.identity) || !verified.bytes.equals(bytes)) throw changed();
  return verified;
}

async function writeStaging(
  directories: readonly Directory[], name: string, bytes: Buffer, limit: number,
): Promise<FileContents> {
  const path = join(directories[directories.length - 1]!.path, name);
  await verifyDirectories(directories);
  let handle: FileHandle;
  try {
    handle = await fs.open(path, CREATE_FLAGS, 0o600);
  } catch (error) {
    throw publicationFailure(error);
  }
  let written: BigIntStats;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size !== 0n) throw changed();
    const current = await fs.lstat(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameNode(opened, current)) throw changed();
    await verifyDirectories(directories);
    await handle.writeFile(bytes);
    await handle.sync();
    written = await handle.stat({ bigint: true });
    regularFile(written, limit);
    if (!sameNode(opened, written) || written.size !== BigInt(bytes.length)) throw changed();
  } finally {
    // Interrupted writes remain uncommitted staging, never a recognized operation or wrapping file.
    await handle.close();
  }
  const verified = await readFile(directories, name, limit);
  if (!sameFile(written, verified.identity) || !verified.bytes.equals(bytes)) throw changed();
  return verified;
}

async function publish(
  directories: readonly Directory[], name: string, bytes: Buffer, limit: number,
): Promise<void> {
  await verifyDirectories(directories);
  const directory = directories[directories.length - 1]!.path;
  const path = join(directory, name);
  let exists = false;
  try {
    await fs.lstat(path, { bigint: true });
    exists = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await verifyDirectories(directories);
  }
  if (exists) {
    await verifyExistingPublication(directories, name, bytes, limit);
    return;
  }

  const stagingName = `${randomUUID()}${STAGING_EXTENSION}`;
  const stagingPath = join(directory, stagingName);
  const staged = await writeStaging(directories, stagingName, bytes, limit);
  await verifyDirectories(directories);
  const beforeLink = await fs.lstat(stagingPath, { bigint: true });
  regularFile(beforeLink, limit);
  if (!sameFile(staged.identity, beforeLink)) throw changed();
  let linked = false;
  try {
    // This requires local atomic, non-overwriting hard links; it makes no cloud propagation guarantee.
    await fs.link(stagingPath, path);
    linked = true;
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw publicationFailure(error);
  }
  let published: FileContents;
  if (linked) {
    await syncDirectory(directories);
    published = await readFile(directories, name, limit);
    // Creating/removing a hard link changes ctime, but must not change the inode or sealed bytes.
    if (!sameNode(staged.identity, published.identity) || !published.bytes.equals(bytes)) throw changed();
  } else {
    published = await verifyExistingPublication(directories, name, bytes, limit);
  }

  const staging = await readFile(directories, stagingName, limit);
  if (!sameNode(staged.identity, staging.identity) || !staging.bytes.equals(bytes)) throw changed();
  await verifyDirectories(directories);
  const currentStaging = await fs.lstat(stagingPath, { bigint: true });
  const currentFinal = await fs.lstat(path, { bigint: true });
  regularFile(currentStaging, limit);
  regularFile(currentFinal, limit);
  if (!sameFile(staging.identity, currentStaging) || !sameFile(published.identity, currentFinal)) throw changed();
  // Only this attempt's verified staging file is eligible; stale stages and canonical files are never cleaned up here.
  await fs.unlink(stagingPath);
  await syncDirectory(directories);
  const verified = await readFile(directories, name, limit);
  if (!sameNode(published.identity, verified.identity) || !verified.bytes.equals(bytes)) throw changed();
}

export class VaultFolder {
  readonly root: string;
  readonly #rootDirectory: Directory;
  readonly #forbiddenRoots: readonly string[];
  #appDirectory: Directory | undefined;

  private constructor(root: Directory, forbiddenRoots: readonly string[]) {
    this.root = root.path;
    this.#rootDirectory = root;
    this.#forbiddenRoots = forbiddenRoots;
  }

  static async select(root: string, forbiddenRoots: readonly string[]): Promise<VaultFolder> {
    try {
      const selected = await inspectDirectory(absolutePath(root));
      if (selected.path.split(sep).some((part) => part.toLowerCase() === APP_DIRECTORY.toLowerCase())) throw unsafePath();
      const roots: string[] = [];
      for (const path of forbiddenRoots) roots.push(await canonicalDestination(path));
      const canonical = await inspectDirectory(selected.path);
      if (!sameNode(selected.identity, canonical.identity)) throw changed();
      const folder = new VaultFolder(canonical, roots);
      await folder.#app(false);
      return folder;
    } catch (error) {
      throw sanitized(error);
    }
  }

  async #app(create: boolean): Promise<Directory | undefined> {
    await verifyDirectories([this.#rootDirectory]);
    await assertOutsideGitWorktree(this.root);
    const path = join(this.root, APP_DIRECTORY);
    if (forbidden(path, this.#forbiddenRoots)) throw unsafePath();
    let directory: Directory;
    try {
      directory = await inspectDirectory(path, this.#rootDirectory);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await verifyDirectories([this.#rootDirectory]);
      if (this.#appDirectory) throw unavailable();
      if (!create) return undefined;
      try {
        await fs.mkdir(path, { mode: 0o700 });
      } catch (mkdirError) {
        if (!hasCode(mkdirError, 'EEXIST')) throw mkdirError;
      }
      directory = await inspectDirectory(path, this.#rootDirectory);
    }
    await assertNoGitMarker(directory.path);
    if (forbidden(directory.path, this.#forbiddenRoots)) throw unsafePath();
    if (this.#appDirectory && (!samePath(directory.path, this.#appDirectory.path)
      || !sameNode(directory.identity, this.#appDirectory.identity))) throw changed();
    this.#appDirectory = directory;
    if (create) await syncDirectory([this.#rootDirectory]);
    await verifyDirectories([this.#rootDirectory, directory]);
    return directory;
  }

  async #vault(vaultId: string): Promise<Directory[]> {
    const validId = id(vaultId);
    const app = await this.#app(false);
    if (!app) throw unavailable();
    const path = join(app.path, validId);
    if (forbidden(path, this.#forbiddenRoots)) throw unsafePath();
    const vault = await inspectDirectory(path, app);
    await assertNoGitMarker(vault.path);
    if (forbidden(vault.path, this.#forbiddenRoots)) throw unsafePath();
    const directories = [this.#rootDirectory, app, vault];
    await verifyDirectories(directories);
    return directories;
  }

  async listVaultIds(): Promise<string[]> {
    try {
      const app = await this.#app(false);
      if (!app) return [];
      const directories = [this.#rootDirectory, app];
      const ids: string[] = [];
      for await (const name of directoryNames(directories)) {
        if (!UUID_NAME.test(name)) continue;
        if (ids.length >= MAX_VAULTS) throw quota();
        const vault = await inspectDirectory(join(app.path, name), app);
        await assertNoGitMarker(vault.path);
        if (forbidden(vault.path, this.#forbiddenRoots)) throw unsafePath();
        ids.push(name);
      }
      return ids.sort();
    } catch (error) {
      throw sanitized(error);
    }
  }

  async createVault(vaultId: string, wrapping: WrappingEnvelope): Promise<void> {
    try {
      const validId = id(vaultId);
      const bytes = Buffer.from(encodeWrapping(wrapping), 'utf8');
      const candidate = parseWrapping(bytes);
      if (candidate.vaultId !== validId) throw incomplete();
      const app = (await this.#app(true))!;
      const path = join(app.path, validId);
      if (forbidden(path, this.#forbiddenRoots)) throw unsafePath();
      try {
        await fs.mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (hasCode(error, 'EEXIST')) throw new FolderError('選択したローカルフォルダーには同じ ID の保管庫が既にあります。既存データは置き換えていません。');
        throw error;
      }
      const vault = await inspectDirectory(path, app);
      await assertNoGitMarker(vault.path);
      if (forbidden(vault.path, this.#forbiddenRoots)) throw unsafePath();
      await syncDirectory([this.#rootDirectory, app]);
      await publish([this.#rootDirectory, app, vault], `${candidate.wrapperId}.svkey`, bytes, MAX_WRAPPING_BYTES);
    } catch (error) {
      throw sanitized(error);
    }
  }

  async readWrappings(vaultId: string): Promise<WrappingEnvelope[]> {
    try {
      const directories = await this.#vault(vaultId);
      const candidates = new Map<string, { bytes: Buffer; wrapping: WrappingEnvelope }>();
      const budget = { bytes: 0 };
      for await (const name of directoryNames(directories)) {
        const prefix = recognizedId(name, 'svkey');
        if (!prefix) continue;
        const content = await readFile(directories, name, MAX_WRAPPING_BYTES, { budget });
        const existing = candidates.get(prefix);
        if (existing) {
          if (!existing.bytes.equals(content.bytes)) throw conflict();
          continue;
        }
        if (candidates.size >= MAX_WRAPPINGS) throw quota();
        const wrapping = parseWrapping(content.bytes);
        if (wrapping.wrapperId !== prefix || wrapping.vaultId !== vaultId) throw incomplete();
        candidates.set(prefix, { bytes: content.bytes, wrapping });
      }
      if (candidates.size === 0) throw incomplete();
      return [...candidates.values()].map((candidate) => candidate.wrapping)
        .sort((left, right) => left.wrapperId < right.wrapperId ? -1 : left.wrapperId > right.wrapperId ? 1 : 0);
    } catch (error) {
      throw sanitized(error);
    }
  }

  async publishWrapping(vaultId: string, wrapping: WrappingEnvelope): Promise<void> {
    try {
      const bytes = Buffer.from(encodeWrapping(wrapping), 'utf8');
      const candidate = parseWrapping(bytes);
      if (candidate.vaultId !== id(vaultId)) throw incomplete();
      const directories = await this.#vault(vaultId);
      await publish(directories, `${candidate.wrapperId}.svkey`, bytes, MAX_WRAPPING_BYTES);
    } catch (error) {
      throw sanitized(error);
    }
  }

  async publishOperation(vaultId: string, envelope: SealedEnvelope): Promise<void> {
    try {
      const bytes = Buffer.from(encodeEnvelope(envelope), 'utf8');
      const candidate = parseEnvelope(bytes);
      if (candidate.vaultId !== id(vaultId) || candidate.purpose !== 'operation') throw incomplete();
      const directories = await this.#vault(vaultId);
      await publish(directories, `${candidate.envelopeId}.svop`, bytes, MAX_ENVELOPE_BYTES);
    } catch (error) {
      throw sanitized(error);
    }
  }

  async *operations(vaultId: string): AsyncGenerator<FolderEnvelope> {
    try {
      const directories = await this.#vault(vaultId);
      const budget = { bytes: 0 };
      for await (const name of directoryNames(directories)) {
        const prefix = recognizedId(name, 'svop');
        if (!prefix) continue;
        const { bytes } = await readFile(directories, name, MAX_ENVELOPE_BYTES, { budget });
        const envelope = parseEnvelope(bytes);
        if (envelope.purpose !== 'operation' || envelope.vaultId !== vaultId || envelope.envelopeId !== prefix) throw incomplete();
        yield { name, envelope, digest: digest(bytes) };
      }
    } catch (error) {
      throw sanitized(error);
    }
  }

  async removeOperation(vaultId: string, entry: FolderEnvelope): Promise<void> {
    try {
      const prefix = recognizedId(entry?.name, 'svop');
      if (!prefix || typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.digest)) throw incomplete();
      const expected = Buffer.from(encodeEnvelope(entry.envelope), 'utf8');
      const envelope = parseEnvelope(expected);
      if (envelope.vaultId !== id(vaultId) || envelope.purpose !== 'operation' || envelope.envelopeId !== prefix) throw incomplete();
      const directories = await this.#vault(vaultId);
      const path = join(directories[directories.length - 1]!.path, entry.name);
      let content: FileContents;
      try {
        content = await readFile(directories, entry.name, MAX_ENVELOPE_BYTES);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await verifyDirectories(directories);
        try {
          await fs.lstat(path, { bigint: true });
        } catch (missingError) {
          if (isMissingFile(missingError)) return;
          throw missingError;
        }
        throw changed();
      }
      if (digest(content.bytes) !== entry.digest || !content.bytes.equals(expected)) throw changed();
      await verifyDirectories(directories);
      try {
        const current = await fs.lstat(path, { bigint: true });
        regularFile(current, MAX_ENVELOPE_BYTES);
        if (!sameFile(content.identity, current)) throw changed();
        // Node has no portable unlink-by-handle; a hostile same-user lstat/unlink race remains possible.
        await fs.unlink(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await verifyDirectories(directories);
        return;
      }
      await syncDirectory(directories);
    } catch (error) {
      throw sanitized(error);
    }
  }
}
