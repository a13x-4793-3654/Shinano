import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import type { SavedState } from '../shared/model.ts';
import { parseBackupRequest } from '../shared/backup.ts';
import { exactKeys, id, parseSavedState, record, UserError } from '../shared/validation.ts';
import { MAX_TOTP_SECRET_BYTES } from '../shared/totp.ts';
import { storedMetadata } from './totp-store.ts';
import type { ParsedTotp } from './totp.ts';

export const MAX_BACKUP_BYTES = 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 512 * 1024;
const AAD = Buffer.from('Shinano backup v1: scrypt N=32768 r=8 p=1; AES-256-GCM');
const FORMAT = 'shinano-encrypted-backup';
const INVALID_BACKUP = 'バックアップの形式・サイズ・バージョンが正しくありません。既存データは変更していません。';

export interface BackupTotp extends ParsedTotp {
  profileId: string;
}

export interface PortableBackup {
  state: SavedState;
  totp: BackupTotp[];
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  parseBackupRequest({ passphrase });
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(new UserError('バックアップの暗号化鍵を生成できませんでした。')) : resolve(key));
  });
}

function base64(value: unknown, maximum: number, exactLength?: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum / 3) * 4) {
    throw new UserError(INVALID_BACKUP);
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value
    || (exactLength !== undefined && bytes.length !== exactLength)) {
    bytes.fill(0);
    throw new UserError(INVALID_BACKUP);
  }
  return bytes;
}

function parsePayload(value: unknown): PortableBackup {
  const totp: BackupTotp[] = [];
  try {
    const payload = record(value);
    exactKeys(payload, ['version', 'state', 'totp']);
    if (payload.version !== 1 || !Array.isArray(payload.totp)) throw new UserError(INVALID_BACKUP);
    const state = parseSavedState(payload.state);
    if (!state.profiles.length || state.deletedProfileIds.length || payload.totp.length > state.profiles.length) {
      throw new UserError(INVALID_BACKUP);
    }
    const profileIds = new Set(state.profiles.map((profile) => profile.id));
    const seen = new Set<string>();
    for (const value of payload.totp) {
      const entry = record(value);
      exactKeys(entry, ['profileId', 'key', 'algorithm', 'digits', 'period', 'issuer', 'account']);
      const profileId = id(entry.profileId);
      if (!profileIds.has(profileId) || seen.has(profileId)) throw new UserError(INVALID_BACKUP);
      const metadata = storedMetadata(entry);
      const key = base64(entry.key, MAX_TOTP_SECRET_BYTES);
      totp.push({ profileId, key, metadata });
      seen.add(profileId);
    }
    return { state, totp };
  } catch {
    for (const entry of totp) entry.key.fill(0);
    throw new UserError(INVALID_BACKUP);
  }
}

export async function encryptBackup(backup: PortableBackup, passphrase: string): Promise<string> {
  const checked = parsePayload({
    version: 1, state: backup.state,
    totp: backup.totp.map((entry) => ({ profileId: entry.profileId, key: entry.key.toString('base64'), ...entry.metadata })),
  });
  const plaintext = Buffer.from(JSON.stringify({
    version: 1, state: checked.state,
    totp: checked.totp.map((entry) => ({ profileId: entry.profileId, key: entry.key.toString('base64'), ...entry.metadata })),
  }));
  for (const entry of checked.totp) entry.key.fill(0);
  let key: Buffer | undefined;
  try {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new UserError(INVALID_BACKUP);
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    key = await deriveKey(passphrase, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${JSON.stringify({
      format: FORMAT, version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    })}\n`;
  } finally {
    plaintext.fill(0);
    key?.fill(0);
  }
}

export async function decryptBackup(content: string, passphrase: string): Promise<PortableBackup> {
  parseBackupRequest({ passphrase });
  let envelope: Record<string, unknown>;
  try {
    if (Buffer.byteLength(content) > MAX_BACKUP_BYTES) throw new UserError(INVALID_BACKUP);
    envelope = record(JSON.parse(content));
    exactKeys(envelope, ['format', 'version', 'salt', 'iv', 'tag', 'ciphertext']);
    if (envelope.format !== FORMAT || envelope.version !== 1) throw new UserError(INVALID_BACKUP);
  } catch {
    throw new UserError(INVALID_BACKUP);
  }
  const salt = base64(envelope.salt, 32, 32);
  const iv = base64(envelope.iv, 12, 12);
  const tag = base64(envelope.tag, 16, 16);
  const ciphertext = base64(envelope.ciphertext, MAX_PLAINTEXT_BYTES);
  const key = await deriveKey(passphrase, salt);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    try {
      const first = decipher.update(ciphertext);
      try {
        plaintext = Buffer.concat([first, decipher.final()]);
      } finally {
        first.fill(0);
      }
    } catch {
      throw new UserError('パスフレーズが違うか、バックアップが破損・変更されています。既存データは変更していません。');
    }
    try {
      return parsePayload(JSON.parse(plaintext.toString('utf8')));
    } catch {
      throw new UserError(INVALID_BACKUP);
    }
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
