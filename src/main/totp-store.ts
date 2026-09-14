import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MAX_TOTP_LABEL_LENGTH, MAX_TOTP_SECRET_BYTES, TOTP_ALGORITHMS, TOTP_DIGITS, TOTP_PERIOD,
  type TotpMetadata, type TotpRegistration,
} from '../shared/totp.ts';
import { exactKeys, id, record, UserError } from '../shared/validation.ts';
import { assertRegularFile, isMissingFile, writeAtomic } from './atomic-file.ts';
import type { ParsedTotp } from './totp.ts';

export const MAX_TOTP_FILE_BYTES = 16 * 1024;

export interface SecretProtection {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?: () => string;
}

interface Envelope {
  version: 1;
  profileId: string;
  registrationId: string;
  ciphertext: string;
}

export interface StoredTotp extends ParsedTotp {
  registrationId: string;
}

const unreadableMessage = 'TOTP の保存データを読み込めません。破損・未対応の形式・ファイル権限を確認してください。既存データは上書きしていません。';
const protectionMessage = 'OS の保護された鍵を利用できません。キーチェーン等のロック・アクセス許可を確認してください。平文では保存しません。';
const incompleteMessage = 'TOTP の未完了の一時保存データがあります。自動で上書きしていません。必要な場合は対象を確認して登録を削除し、再登録してください。';

export function assertExternalTotpDirectory(userData: string, applicationRoot: string): void {
  const path = relative(realpathSync(applicationRoot), realpathSync(userData));
  if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) {
    throw new UserError('userData はアプリやソースリポジトリの外の専用ディレクトリにしてください。TOTP をアプリ内には保存しません。');
  }
}

export function requireSecretProtection(protection: SecretProtection, platform: NodeJS.Platform): void {
  try {
    if (platform === 'linux') {
      const backend = protection.getSelectedStorageBackend?.();
      if (!backend || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) {
        throw new UserError('Linux の保護された秘密ストアが利用できません。basic_text や不明な方式では TOTP を保存・復号しません。');
      }
    }
    if (!protection.isEncryptionAvailable()) throw new UserError(protectionMessage);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(protectionMessage);
  }
}

function canonicalBase64(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum / 3) * 4) {
    throw new UserError(unreadableMessage);
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) {
    bytes.fill(0);
    throw new UserError(unreadableMessage);
  }
  return bytes;
}

function storedLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > MAX_TOTP_LABEL_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new UserError(unreadableMessage);
  }
  return value;
}

function storedMetadata(value: Record<string, unknown>): TotpMetadata {
  const algorithm = TOTP_ALGORITHMS.find((entry) => entry === value.algorithm);
  if (!algorithm || value.digits !== TOTP_DIGITS || value.period !== TOTP_PERIOD) {
    throw new UserError(unreadableMessage);
  }
  return {
    algorithm, digits: TOTP_DIGITS, period: TOTP_PERIOD,
    issuer: storedLabel(value.issuer), account: storedLabel(value.account),
  };
}

export class TotpStore {
  readonly directory: string;
  private readonly protection: SecretProtection;
  private readonly platform: NodeJS.Platform;
  private readonly summaries = new Map<string, TotpRegistration>();
  private metadataError: string | null = null;

  constructor(
    userData: string,
    protection: SecretProtection,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.protection = protection;
    this.platform = platform;
    if (!isAbsolute(userData)) throw new UserError('TOTP の保存先には専用 userData の絶対パスが必要です。');
    this.directory = join(userData, 'totp');
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.checkDirectory();
      if (platform !== 'win32') chmodSync(this.directory, 0o700);
    } catch {
      throw new UserError('TOTP の専用保存先を利用できません。ファイル形式と権限を確認してください。');
    }
  }

  private checkDirectory(): void {
    if (!lstatSync(this.directory).isDirectory()) throw new UserError(unreadableMessage);
  }

  private entries(): string[] {
    try {
      this.checkDirectory();
      return readdirSync(this.directory).filter((name) => name !== '.DS_Store');
    } catch {
      throw new UserError(unreadableMessage);
    }
  }

  hasData(): boolean {
    return this.entries().length > 0;
  }

  reconcileProfiles(profileIds: readonly string[], deletedProfileIds: readonly string[]): void {
    const known = new Set([...profileIds, ...deletedProfileIds].map(id));
    this.metadataError = this.entries().some((name) => !name.endsWith('.json') || !known.has(name.slice(0, -5)))
      ? '関連付けできない、または未完了の TOTP 保存データがあります。自動削除・再割り当てはしていません。'
      : null;
  }

  get error(): string | null {
    return this.metadataError;
  }

  private file(profileId: string): string {
    this.checkDirectory();
    return join(this.directory, `${id(profileId)}.json`);
  }

  private stagingFiles(profileId: string): string[] {
    const prefix = `${id(profileId)}.json.`;
    return this.entries().filter((name) => {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
      try {
        id(name.slice(prefix.length, -4));
        return true;
      } catch {
        return false;
      }
    });
  }

  private readEnvelope(profileId: string): Envelope | null {
    try {
      const file = this.file(profileId);
      if (!assertRegularFile(file)) return null;
      const size = lstatSync(file).size;
      if (!size || size > MAX_TOTP_FILE_BYTES) throw new UserError(unreadableMessage);
      const value = record(JSON.parse(readFileSync(file, 'utf8')));
      exactKeys(value, ['version', 'profileId', 'registrationId', 'ciphertext']);
      if (value.version !== 1 || id(value.profileId) !== profileId) throw new UserError(unreadableMessage);
      const registrationId = id(value.registrationId);
      const ciphertext = canonicalBase64(value.ciphertext, MAX_TOTP_FILE_BYTES).toString('base64');
      return { version: 1, profileId, registrationId, ciphertext };
    } catch {
      throw new UserError(unreadableMessage);
    }
  }

  registration(profileId: string, refresh = false): TotpRegistration {
    id(profileId);
    const cached = this.summaries.get(profileId);
    if (cached && !refresh) return { ...cached };
    let summary: TotpRegistration;
    try {
      if (this.stagingFiles(profileId).length) throw new UserError(incompleteMessage);
      const envelope = this.readEnvelope(profileId);
      summary = envelope
        ? { profileId, status: 'registered', registrationId: envelope.registrationId, error: null }
        : { profileId, status: 'none', registrationId: null, error: null };
    } catch (error) {
      summary = { profileId, status: 'unreadable', registrationId: null, error: error instanceof UserError ? error.message : unreadableMessage };
    }
    this.summaries.set(profileId, summary);
    return { ...summary };
  }

  load(profileId: string, registrationId: string): StoredTotp {
    id(profileId);
    id(registrationId);
    if (this.stagingFiles(profileId).length) throw new UserError(incompleteMessage);
    const envelope = this.readEnvelope(profileId);
    if (!envelope) throw new UserError('このプロファイルには TOTP が登録されていません。');
    if (envelope.registrationId !== registrationId) {
      throw new UserError('TOTP の登録が変更されました。プロファイルを選び直して表示してください。');
    }
    requireSecretProtection(this.protection, this.platform);
    let plaintext: string;
    try {
      plaintext = this.protection.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
    } catch {
      throw new UserError('TOTP を復号できません。OS の鍵・アクセス許可、または保存データを確認してください。既存データは変更していません。');
    }
    let key: Buffer | undefined;
    try {
      if (typeof plaintext !== 'string' || plaintext.length > MAX_TOTP_FILE_BYTES) throw new UserError(unreadableMessage);
      const value = record(JSON.parse(plaintext));
      exactKeys(value, ['version', 'profileId', 'registrationId', 'key', 'algorithm', 'digits', 'period', 'issuer', 'account']);
      if (value.version !== 1 || value.profileId !== profileId || value.registrationId !== registrationId) {
        throw new UserError(unreadableMessage);
      }
      const metadata = storedMetadata(value);
      key = canonicalBase64(value.key, MAX_TOTP_SECRET_BYTES);
      return { key, metadata, registrationId };
    } catch {
      key?.fill(0);
      this.summaries.set(profileId, { profileId, status: 'unreadable', registrationId: null, error: unreadableMessage });
      throw new UserError(unreadableMessage);
    } finally {
      plaintext = '';
    }
  }

  save(profileId: string, parsed: ParsedTotp): string {
    id(profileId);
    const existing = this.registration(profileId, true);
    if (existing.status === 'unreadable') throw new UserError(existing.error);
    if (existing.status === 'registered') {
      const previous = this.load(profileId, existing.registrationId);
      previous.key.fill(0);
    }
    if (!parsed.key.length || parsed.key.length > MAX_TOTP_SECRET_BYTES) throw new UserError('共有秘密鍵の長さが正しくありません。');
    const metadata = storedMetadata({ ...parsed.metadata });
    requireSecretProtection(this.protection, this.platform);
    const registrationId = randomUUID();
    let ciphertext: Buffer;
    try {
      ciphertext = this.protection.encryptString(JSON.stringify({
        version: 1, profileId, registrationId, key: parsed.key.toString('base64'), ...metadata,
      }));
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error('Encryption failed.');
    } catch {
      throw new UserError('TOTP を暗号化できませんでした。OS の鍵とアクセス許可を確認してください。以前の登録は変更していません。');
    }
    const envelope: Envelope = { version: 1, profileId, registrationId, ciphertext: ciphertext.toString('base64') };
    const content = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(content) > MAX_TOTP_FILE_BYTES) throw new UserError('暗号化された TOTP データが保存上限を超えています。');
    try {
      writeAtomic(this.file(profileId), content);
    } catch {
      throw new UserError('TOTP を保存できませんでした。空き容量とファイル権限を確認してください。以前の登録は変更していません。');
    }
    this.summaries.set(profileId, { profileId, status: 'registered', registrationId, error: null });
    return registrationId;
  }

  remove(profileId: string): void {
    id(profileId);
    let failed = false;
    try {
      const files = [this.file(profileId), ...this.stagingFiles(profileId).map((name) => join(this.directory, name))];
      for (const file of files) {
        try {
          if (assertRegularFile(file)) unlinkSync(file);
        } catch (error) {
          if (!isMissingFile(error)) failed = true;
        }
      }
    } catch {
      failed = true;
    }
    if (failed) {
      this.summaries.delete(profileId);
      throw new UserError('TOTP の保存ファイルや一時ファイルを削除できませんでした。ファイル権限を確認してください。');
    }
    this.summaries.set(profileId, { profileId, status: 'none', registrationId: null, error: null });
  }
}
