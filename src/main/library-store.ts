import { chmodSync, constants, lstatSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { HISTORY_RETENTION_MS, type HistoryMode, type LibraryKind } from '../shared/library.ts';
import { boolean, boundedIds, boundedInteger, historyMode } from '../shared/library-validation.ts';
import { exactKeys, id, record, UserError } from '../shared/validation.ts';
import { assertRegularFile, isMissingFile, syncParentDirectory, writeAtomic } from './atomic-file.ts';
import { requireSecretProtection, type SecretProtection } from './totp-store.ts';
import { encodeEnvelope, parseEnvelope, seal, unseal, MAX_ENVELOPE_BYTES } from './vault-crypto.ts';
import { digest, parseOperation, parsePortableTotp, type OperationInput, type PortableTotp, type VaultOperation } from './vault-records.ts';

const IO_ERROR = '暗号化ライブラリーを読み書きできません。OS の鍵・ファイル権限・未完了または破損したデータを確認してください。既存データは保持しています。起動時のエラーは原因を解消してから Shinano を再起動してください。';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const operationName = new RegExp(`^(${UUID})\\.json$`);
const hideName = new RegExp(`^hide-(${UUID})\\.json$`);
const knownName = new RegExp(`^(?:settings\\.json|totp-intent\\.json|totp-local-only\\.json|(?:hide-|totp-)?${UUID}\\.json)(?:\\.${UUID}\\.tmp)?$`);
const totpName = new RegExp(`^totp-${UUID}\\.json(?:\\.${UUID}\\.tmp)?$`);

function entryName(operation: VaultOperation): string {
  return `${operation.kind === 'totp' ? 'totp-' : ''}${operation.id}.json`;
}

async function directory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  if (!(await lstat(path)).isDirectory()) throw new UserError(IO_ERROR);
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readDataFile(path: string, maximum = MAX_ENVELOPE_BYTES): Promise<Buffer | null> {
  let before;
  try { before = await lstat(path); } catch (error) { if (isMissingFile(error)) return null; throw new UserError(IO_ERROR); }
  if (!before.isFile() || before.size <= 0 || before.size > maximum) throw new UserError(IO_ERROR);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== before.size || stat.ino !== before.ino || stat.dev !== before.dev) throw new UserError(IO_ERROR);
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new UserError(IO_ERROR);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function atomic(path: string, content: string): Promise<void> {
  assertRegularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
    assertRegularFile(path);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!closed) await handle.close();
    try { await unlink(temporary); } catch (cleanup) { if (!isMissingFile(cleanup)) throw new UserError(IO_ERROR); }
    throw error;
  }
}

export interface VaultAssociation {
  vaultId: string;
  root: string;
  wrappingGeneration: number;
  wrappingIds: string[];
}

interface DeviceSettings {
  version: 1;
  sequence: number;
  retentionFloor: number;
  association: VaultAssociation | null;
  lastReadAt: number | null;
  lastWriteAt: number | null;
}

export interface ProfileSettings {
  version: 1;
  profileId: string;
  bookmarkSpace: string;
  historySpace: string;
  mode: HistoryMode;
  clearThrough: number;
  linkedVaultId: string | null;
  bookmarks: boolean;
  history: boolean;
  totpBinding: { vaultId: string; registrationId: string } | null;
  totpOverride: boolean;
}

export interface LocalEntry {
  version: 1;
  space: string;
  operation: VaultOperation;
  published: boolean;
}

interface HiddenEntry {
  version: 1;
  profileId: string;
  space: string;
  kind: LibraryKind;
  recordId: string;
  at: number;
}

export interface TotpIntent {
  version: 1;
  profileId: string;
  vaultId: string;
  cancelled: boolean;
  expectedRegistrationId: string | null;
  next: PortableTotp;
}

function parseAssociation(input: unknown): VaultAssociation | null {
  if (input === null) return null;
  const value = record(input);
  exactKeys(value, ['vaultId', 'root', 'wrappingGeneration', 'wrappingIds']);
  if (typeof value.root !== 'string' || !value.root || value.root.length > 4096 || value.root.includes('\0')) throw new UserError(IO_ERROR);
  return { vaultId: id(value.vaultId), root: value.root, wrappingGeneration: boundedInteger(value.wrappingGeneration, 64), wrappingIds: boundedIds(value.wrappingIds, 64) };
}

function parseDevice(input: unknown): DeviceSettings {
  const value = record(input);
  exactKeys(value, ['version', 'sequence', 'retentionFloor', 'association', 'lastReadAt', 'lastWriteAt']);
  if (value.version !== 1) throw new UserError(IO_ERROR);
  return {
    version: 1, sequence: boundedInteger(value.sequence), retentionFloor: boundedInteger(value.retentionFloor), association: parseAssociation(value.association),
    lastReadAt: value.lastReadAt === null ? null : boundedInteger(value.lastReadAt),
    lastWriteAt: value.lastWriteAt === null ? null : boundedInteger(value.lastWriteAt),
  };
}

function parseProfile(input: unknown, profileId: string): ProfileSettings {
  const value = record(input);
  exactKeys(value, ['version', 'profileId', 'bookmarkSpace', 'historySpace', 'mode', 'clearThrough', 'linkedVaultId', 'bookmarks', 'history', 'totpBinding', 'totpOverride']);
  if (value.version !== 1 || value.profileId !== profileId) throw new UserError(IO_ERROR);
  let binding = null;
  if (value.totpBinding !== null) {
    const entry = record(value.totpBinding);
    exactKeys(entry, ['vaultId', 'registrationId']);
    binding = { vaultId: id(entry.vaultId), registrationId: id(entry.registrationId) };
  }
  return {
    version: 1, profileId, bookmarkSpace: id(value.bookmarkSpace), historySpace: id(value.historySpace),
    mode: historyMode(value.mode), clearThrough: boundedInteger(value.clearThrough), linkedVaultId: value.linkedVaultId === null ? null : id(value.linkedVaultId),
    bookmarks: boolean(value.bookmarks), history: boolean(value.history), totpBinding: binding, totpOverride: boolean(value.totpOverride),
  };
}

export class LibraryStore {
  readonly directory: string;
  readonly profileDirectory: string;
  readonly suppressionDirectory: string;
  private storeId: string = randomUUID();
  private writerId: string = randomUUID();
  private key: Buffer | null = null;
  private device: DeviceSettings = { version: 1, sequence: 0, retentionFloor: 0, association: null, lastReadAt: null, lastWriteAt: null };
  private readonly profileCache = new Map<string, ProfileSettings>();
  private readonly entries = new Map<string, LocalEntry>();
  private readonly hidden = new Map<string, HiddenEntry>();
  private readonly hiddenKeys = new Set<string>();
  private readonly intents = new Map<string, TotpIntent>();
  private readonly localOnlyTotp = new Set<string>();
  private readonly suppressions = new Set<string>();
  private failure: string | null = null;
  private initialized = false;
  private readonly protection: SecretProtection;
  private readonly platform: NodeJS.Platform;

  constructor(userData: string, protection: SecretProtection, platform: NodeJS.Platform = process.platform) {
    this.protection = protection;
    this.platform = platform;
    this.directory = join(userData, 'library');
    this.profileDirectory = join(this.directory, 'profiles');
    this.suppressionDirectory = join(this.directory, 'removed-profiles');
    for (const path of [this.directory, this.profileDirectory, this.suppressionDirectory]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (!lstatSync(path).isDirectory()) throw new UserError(IO_ERROR);
      if (platform !== 'win32') chmodSync(path, 0o700);
    }
  }

  get error(): string | null { return this.failure; }
  get localSpace(): string { this.ready(); return this.storeId; }
  get writer(): string { this.ready(); return this.writerId; }
  get settings(): Readonly<DeviceSettings> { this.ready(); return this.device; }
  all(): LocalEntry[] { this.ready(); return [...this.entries.values()]; }
  isSuppressed(profileId: string): boolean { return this.suppressions.has(id(profileId)); }
  suppressedProfiles(): string[] { return [...this.suppressions].sort(); }

  hasData(): boolean {
    return assertRegularFile(join(this.directory, 'device.json'))
      || readdirSync(this.profileDirectory).length > 0;
  }

  private ready(): void {
    if (!this.initialized || this.failure) throw new UserError(this.failure ?? '暗号化ライブラリーを準備しています。');
  }

  private checkDirectory(): void {
    for (const path of [this.directory, this.profileDirectory, this.suppressionDirectory]) if (!lstatSync(path).isDirectory()) throw new UserError(IO_ERROR);
  }

  async initialize(): Promise<void> {
    this.failure = null;
    this.initialized = false;
    try {
      this.checkDirectory();
      this.entries.clear();
      this.profileCache.clear();
      this.hidden.clear();
      this.hiddenKeys.clear();
      this.intents.clear();
      this.localOnlyTotp.clear();
      this.suppressions.clear();
      const suppressionNames = await readdir(this.suppressionDirectory);
      if (suppressionNames.length > 50_000) throw new UserError(IO_ERROR);
      for (const name of suppressionNames) {
        const match = operationName.exec(name);
        if (!match) throw new UserError(IO_ERROR);
        const file = await readDataFile(join(this.suppressionDirectory, name), 256);
        if (!file) throw new UserError(IO_ERROR);
        const marker = record(JSON.parse(file.toString('utf8')));
        exactKeys(marker, ['version', 'profileId']);
        if (marker.version !== 1 || marker.profileId !== match[1]) throw new UserError(IO_ERROR);
        this.suppressions.add(id(marker.profileId));
      }
      const device = await readDataFile(join(this.directory, 'device.json'), 16 * 1024);
      if (device) {
        const envelope = record(JSON.parse(device.toString('utf8')));
        exactKeys(envelope, ['version', 'storeId', 'writerId', 'ciphertext']);
        if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 16 * 1024) throw new UserError(IO_ERROR);
        requireSecretProtection(this.protection, this.platform);
        let plaintext = this.protection.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
        try {
          const value = record(JSON.parse(plaintext));
          exactKeys(value, ['version', 'storeId', 'writerId', 'key']);
          if (value.version !== 1 || value.storeId !== envelope.storeId || value.writerId !== envelope.writerId || typeof value.key !== 'string') throw new UserError(IO_ERROR);
          const key = Buffer.from(value.key, 'base64');
          if (key.length !== 32 || key.toString('base64') !== value.key) { key.fill(0); throw new UserError(IO_ERROR); }
          this.key?.fill(0);
          this.key = key;
          this.storeId = id(value.storeId);
          this.writerId = id(value.writerId);
        } finally { plaintext = ''; }
        const settings = await this.readObject(join(this.directory, 'settings.json'));
        if (!settings) throw new UserError(IO_ERROR);
        this.device = parseDevice(settings);
      } else if (await readDataFile(join(this.directory, 'settings.json'))) {
        throw new UserError('ライブラリーの OS 保護鍵が見つかりません。既存の暗号文を初期化せず保持しています。');
      }
      const profiles = await readdir(this.profileDirectory);
      if (profiles.length > 128) throw new UserError(IO_ERROR);
      let count = 0;
      let total = 0;
      for (const profileId of profiles) {
        id(profileId);
        const path = join(this.profileDirectory, profileId);
        if (!(await lstat(path)).isDirectory()) throw new UserError(IO_ERROR);
        const names = await readdir(path);
        count += names.length;
        if (count > 250_000) throw new UserError(IO_ERROR);
        for (const name of names) {
          if (!knownName.test(name) || name.endsWith('.tmp')) throw new UserError('ライブラリーに未完了または未知の保存ファイルがあります。自動で上書きしていません。');
          if (name === 'totp-local-only.json') {
            const bytes = await readDataFile(join(path, name), 256);
            if (!bytes) throw new UserError(IO_ERROR);
            const marker = record(JSON.parse(bytes.toString('utf8')));
            exactKeys(marker, ['version', 'profileId']);
            if (marker.version !== 1 || marker.profileId !== profileId) throw new UserError(IO_ERROR);
            this.localOnlyTotp.add(profileId);
            continue;
          }
          const data = await this.readObject(join(path, name));
          if (!data) throw new UserError(IO_ERROR);
          total += Buffer.byteLength(JSON.stringify(data));
          if (total > 128 * 1024 * 1024) throw new UserError('ローカルライブラリーの読み込み上限を超えています。');
          if (name === 'settings.json') this.profileCache.set(profileId, parseProfile(data, profileId));
          else if (name === 'totp-intent.json') this.intents.set(profileId, this.parseIntent(data, profileId));
          else if (hideName.test(name)) {
            const hidden = this.parseHidden(data, profileId);
            this.hidden.set(`${profileId}:${name}`, hidden);
            this.hiddenKeys.add(`${profileId}:${hidden.space}:${hidden.kind}:${hidden.recordId}`);
          } else {
            const value = record(data);
            exactKeys(value, ['version', 'space', 'operation', 'published']);
            const operation = parseOperation(value.operation);
            if (value.version !== 1 || operation.profileId !== profileId || name !== entryName(operation)) throw new UserError(IO_ERROR);
            const entry: LocalEntry = { version: 1, space: id(value.space), operation, published: boolean(value.published) };
            if (this.entries.has(operation.id)) throw new UserError(IO_ERROR);
            this.entries.set(operation.id, entry);
            if (operation.writerId === this.writerId && operation.sequence > this.device.sequence) throw new UserError('ローカル操作番号が保存状態と一致しません。自動修正していません。');
          }
          if (count % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      this.initialized = true;
    } catch (error) {
      this.failure = error instanceof UserError ? error.message : IO_ERROR;
      this.initialized = true;
      this.key?.fill(0);
      this.key = null;
      throw new UserError(this.failure);
    }
  }

  private async ensureKey(): Promise<Buffer> {
    this.ready();
    this.checkDirectory();
    requireSecretProtection(this.protection, this.platform);
    if (this.key) return this.key;
    if (assertRegularFile(join(this.directory, 'device.json'))) throw new UserError(IO_ERROR);
    const key = randomBytes(32);
    try {
      const ciphertext = this.protection.encryptString(JSON.stringify({ version: 1, storeId: this.storeId, writerId: this.writerId, key: key.toString('base64') }));
      if (!ciphertext.length) throw new UserError(IO_ERROR);
      // Commit settings first; an interrupted key creation is detected, never silently reset.
      await atomic(join(this.directory, 'settings.json'), encodeEnvelope(seal('local', this.storeId, key, Buffer.from(JSON.stringify(this.device)))));
      await atomic(join(this.directory, 'device.json'), JSON.stringify({ version: 1, storeId: this.storeId, writerId: this.writerId, ciphertext: ciphertext.toString('base64') }));
      this.key = key;
      return key;
    } catch {
      key.fill(0);
      this.failure = IO_ERROR;
      throw new UserError(IO_ERROR);
    }
  }

  private async readObject(path: string): Promise<unknown | null> {
    const bytes = await readDataFile(path);
    if (!bytes) return null;
    if (!this.key) throw new UserError(IO_ERROR);
    const plaintext = unseal('local', this.storeId, this.key, parseEnvelope(bytes));
    try { return JSON.parse(plaintext.toString('utf8')) as unknown; } finally { plaintext.fill(0); }
  }

  private async writeObject(path: string, value: unknown): Promise<void> {
    const key = await this.ensureKey();
    const plaintext = Buffer.from(JSON.stringify(value));
    try { await atomic(path, encodeEnvelope(seal('local', this.storeId, key, plaintext))); } finally { plaintext.fill(0); }
  }

  async updateSettings(patch: Partial<Omit<DeviceSettings, 'version'>>): Promise<void> {
    const next = parseDevice({ ...this.device, ...patch });
    await this.writeObject(join(this.directory, 'settings.json'), next);
    this.device = next;
  }

  profile(profileId: string): ProfileSettings {
    this.ready();
    id(profileId);
    const settings = this.profileCache.get(profileId) ?? {
      version: 1, profileId, bookmarkSpace: this.storeId, historySpace: this.storeId, mode: 'detailed', clearThrough: 0,
      linkedVaultId: null, bookmarks: false, history: false, totpBinding: null, totpOverride: false,
    };
    const result = structuredClone(settings);
    if (this.localOnlyTotp.has(profileId)) { result.totpBinding = null; result.totpOverride = true; }
    return result;
  }

  async updateProfile(settings: ProfileSettings): Promise<void> {
    const next = parseProfile(settings, id(settings.profileId));
    const path = join(this.profileDirectory, next.profileId);
    await directory(path);
    await this.writeObject(join(path, 'settings.json'), next);
    this.profileCache.set(next.profileId, next);
  }

  async operation(input: OperationInput, at: number): Promise<VaultOperation> {
    this.ready();
    const sequence = this.device.sequence + 1;
    boundedInteger(sequence);
    const operation = parseOperation({ version: 1, id: randomUUID(), writerId: this.writerId, sequence, at, ...input });
    await this.updateSettings({ sequence });
    return operation;
  }

  async commit(space: string, input: VaultOperation, published = false): Promise<void> {
    this.ready();
    id(space);
    const operation = parseOperation(input);
    if (this.isSuppressed(operation.profileId)) throw new UserError('この端末から削除したプロファイルには取り込みません。');
    const existing = this.entries.get(operation.id);
    if (existing && (existing.space !== space || digest(existing.operation) !== digest(operation))) throw new UserError('ローカル同期操作が競合しています。');
    if (existing && (!published || existing.published)) return;
    if (!existing && this.entries.size >= 100_000) throw new UserError('ローカルライブラリーの操作数上限です。');
    const entry: LocalEntry = { version: 1, space, operation, published: published || (existing?.published ?? false) };
    const path = join(this.profileDirectory, id(operation.profileId));
    await directory(path);
    await this.writeObject(join(path, entryName(operation)), entry);
    this.entries.set(operation.id, entry);
  }

  private parseHidden(input: unknown, profileId: string): HiddenEntry {
    const value = record(input);
    exactKeys(value, ['version', 'profileId', 'space', 'kind', 'recordId', 'at']);
    if (value.version !== 1 || value.profileId !== profileId || (value.kind !== 'bookmarks' && value.kind !== 'history')) throw new UserError(IO_ERROR);
    return { version: 1, profileId: id(profileId), space: id(value.space), kind: value.kind, recordId: id(value.recordId), at: boundedInteger(value.at) };
  }

  hiddenRecord(profileId: string, space: string, kind: LibraryKind, recordId: string): boolean {
    return this.hiddenKeys.has(`${profileId}:${space}:${kind}:${recordId}`);
  }

  async hide(profileId: string, space: string, kind: LibraryKind, recordId: string, at: number): Promise<void> {
    const entry = this.parseHidden({ version: 1, profileId, space, kind, recordId, at }, profileId);
    if (this.hidden.size >= 50_000) throw new UserError('この端末の非表示記録が上限に達しています。');
    const path = join(this.profileDirectory, id(profileId));
    await directory(path);
    const name = `hide-${randomUUID()}.json`;
    await this.writeObject(join(path, name), entry);
    this.hidden.set(`${profileId}:${name}`, entry);
    this.hiddenKeys.add(`${profileId}:${space}:${kind}:${recordId}`);
  }

  async prune(now: number, sharedFences: ReadonlyMap<string, number> = new Map()): Promise<void> {
    this.ready();
    const floor = Math.max(this.device.retentionFloor, now - HISTORY_RETENTION_MS, 0);
    if (floor > this.device.retentionFloor && (this.key || this.entries.size)) await this.updateSettings({ retentionFloor: floor });
    for (const [operationId, entry] of this.entries) {
      if (entry.operation.kind !== 'visit') continue;
      const cutoff = Math.max(floor, sharedFences.get(`${entry.space}:${entry.operation.profileId}`) ?? 0, this.profileCache.get(entry.operation.profileId)?.clearThrough ?? 0);
      if (entry.operation.at > cutoff && !this.hiddenRecord(entry.operation.profileId, entry.space, 'history', entry.operation.recordId)) continue;
      const path = join(this.profileDirectory, entry.operation.profileId, `${operationId}.json`);
      if (assertRegularFile(path)) await unlink(path);
      this.entries.delete(operationId);
    }
    for (const [key, entry] of this.hidden) {
      if (entry.kind !== 'history' || entry.at > floor) continue;
      const separator = key.indexOf(':');
      const path = join(this.profileDirectory, key.slice(0, separator), key.slice(separator + 1));
      if (assertRegularFile(path)) await unlink(path);
      this.hidden.delete(key);
      this.hiddenKeys.delete(`${key.slice(0, separator)}:${entry.space}:${entry.kind}:${entry.recordId}`);
    }
  }

  suppressProfile(profileId: string): void {
    this.checkDirectory();
    id(profileId);
    writeAtomic(join(this.suppressionDirectory, `${profileId}.json`), JSON.stringify({ version: 1, profileId }));
    syncParentDirectory(join(this.suppressionDirectory, `${profileId}.json`));
    this.suppressions.add(profileId);
  }

  restoreProfile(profileId: string): void {
    this.checkDirectory();
    const path = join(this.suppressionDirectory, `${id(profileId)}.json`);
    if (assertRegularFile(path)) unlinkSync(path);
    this.suppressions.delete(profileId);
  }

  removeProfile(profileId: string): void {
    this.checkDirectory();
    const path = join(this.profileDirectory, id(profileId));
    try {
      if (!lstatSync(path).isDirectory()) throw new UserError(IO_ERROR);
      for (const name of readdirSync(path)) {
        if (!knownName.test(name)) throw new UserError('プロファイルのライブラリーに未知のファイルがあるため、削除を完了できません。');
        const file = join(path, name);
        if (assertRegularFile(file)) unlinkSync(file);
      }
      rmdirSync(path);
    } catch (error) { if (!isMissingFile(error)) throw new UserError(IO_ERROR); }
    for (const [key, entry] of this.entries) if (entry.operation.profileId === profileId) this.entries.delete(key);
    for (const key of this.hidden.keys()) if (key.startsWith(`${profileId}:`)) this.hidden.delete(key);
    for (const key of this.hiddenKeys) if (key.startsWith(`${profileId}:`)) this.hiddenKeys.delete(key);
    this.profileCache.delete(profileId);
    this.intents.delete(profileId);
    this.localOnlyTotp.delete(profileId);
  }

  private parseIntent(input: unknown, profileId: string): TotpIntent {
    const value = record(input);
    exactKeys(value, ['version', 'profileId', 'vaultId', 'cancelled', 'expectedRegistrationId', 'next']);
    if (value.version !== 1 || value.profileId !== profileId) throw new UserError(IO_ERROR);
    return {
      version: 1, profileId: id(profileId), vaultId: id(value.vaultId), cancelled: boolean(value.cancelled),
      expectedRegistrationId: value.expectedRegistrationId === null ? null : id(value.expectedRegistrationId),
      next: parsePortableTotp(value.next),
    };
  }

  intent(profileId: string): TotpIntent | null { return this.intents.get(id(profileId)) ?? null; }
  pendingProfiles(): string[] { return [...this.intents.keys()].sort(); }

  async saveIntent(profileId: string, input: TotpIntent): Promise<void> {
    const value = this.parseIntent(input, profileId);
    const existing = this.intents.get(id(profileId));
    if (existing && digest(existing) !== digest(value)) throw new UserError('未完了の TOTP 移行があります。先にその移行を完了してください。');
    const path = join(this.profileDirectory, profileId);
    await directory(path);
    await this.writeObject(join(path, 'totp-intent.json'), value);
    this.intents.set(profileId, value);
  }

  async clearIntent(profileId: string): Promise<void> {
    const path = join(this.profileDirectory, id(profileId), 'totp-intent.json');
    if (assertRegularFile(path)) {
      await unlink(path);
      await syncDirectory(dirname(path));
    }
    this.intents.delete(profileId);
  }

  async cancelIntent(profileId: string): Promise<void> {
    const existing = this.intents.get(id(profileId));
    if (!existing) throw new UserError('取り消す TOTP 移行がありません。');
    const next = { ...existing, cancelled: true };
    await this.writeObject(join(this.profileDirectory, profileId, 'totp-intent.json'), next);
    this.intents.set(profileId, next);
  }

  async removeTotpEntries(profileId: string, space: string, registrationId?: string): Promise<void> {
    for (const [operationId, entry] of this.entries) {
      if (entry.space !== space || entry.operation.profileId !== profileId || entry.operation.kind !== 'totp'
        || (registrationId !== undefined && entry.operation.value.registrationId !== registrationId)) continue;
      const path = join(this.profileDirectory, profileId, entryName(entry.operation));
      if (assertRegularFile(path)) await unlink(path);
      this.entries.delete(operationId);
    }
  }

  blockTotpSync(profileId: string): void {
    this.checkDirectory();
    const path = join(this.profileDirectory, id(profileId));
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new UserError(IO_ERROR);
    writeAtomic(join(path, 'totp-local-only.json'), JSON.stringify({ version: 1, profileId }));
    syncParentDirectory(join(path, 'totp-local-only.json'));
    this.localOnlyTotp.add(profileId);
    for (const name of readdirSync(path)) {
      if (!totpName.test(name) && name !== 'totp-intent.json') continue;
      const file = join(path, name);
      if (assertRegularFile(file)) unlinkSync(file);
    }
    for (const [operationId, entry] of this.entries) if (entry.operation.profileId === profileId && entry.operation.kind === 'totp') this.entries.delete(operationId);
    this.intents.delete(profileId);
  }

  allowTotpSync(profileId: string): void {
    this.checkDirectory();
    const file = join(this.profileDirectory, id(profileId), 'totp-local-only.json');
    if (assertRegularFile(file)) unlinkSync(file);
    this.localOnlyTotp.delete(profileId);
  }

  hasDeviceKey(): boolean {
    this.checkDirectory();
    return assertRegularFile(join(this.directory, 'vault-access.json'));
  }

  async remember(vaultId: string, key: Buffer): Promise<void> {
    requireSecretProtection(this.protection, this.platform);
    const wrapped = this.protection.encryptString(JSON.stringify({ version: 1, storeId: this.storeId, vaultId: id(vaultId), key: key.toString('base64') }));
    if (!wrapped.length) throw new UserError(IO_ERROR);
    await atomic(join(this.directory, 'vault-access.json'), JSON.stringify({ version: 1, ciphertext: wrapped.toString('base64') }));
  }

  async remembered(vaultId: string): Promise<Buffer> {
    requireSecretProtection(this.protection, this.platform);
    const bytes = await readDataFile(join(this.directory, 'vault-access.json'), 16 * 1024);
    if (!bytes) throw new UserError('この端末には同期金庫の OS 保護付き解除鍵がありません。');
    const envelope = record(JSON.parse(bytes.toString('utf8')));
    exactKeys(envelope, ['version', 'ciphertext']);
    if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string') throw new UserError(IO_ERROR);
    let plaintext = this.protection.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
    try {
      const value = record(JSON.parse(plaintext));
      exactKeys(value, ['version', 'storeId', 'vaultId', 'key']);
      if (value.version !== 1 || value.storeId !== this.storeId || value.vaultId !== vaultId || typeof value.key !== 'string') throw new UserError(IO_ERROR);
      const key = Buffer.from(value.key, 'base64');
      if (key.length !== 32 || key.toString('base64') !== value.key) { key.fill(0); throw new UserError(IO_ERROR); }
      return key;
    } finally { plaintext = ''; }
  }

  forget(): void {
    this.checkDirectory();
    const path = join(this.directory, 'vault-access.json');
    if (assertRegularFile(path)) unlinkSync(path);
  }

  dispose(): void { this.key?.fill(0); this.key = null; }
}
