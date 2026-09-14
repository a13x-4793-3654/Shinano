import { createHmac } from 'node:crypto';
import {
  MAX_TOTP_INPUT_LENGTH, MAX_TOTP_LABEL_LENGTH, MAX_TOTP_SECRET_BYTES, TOTP_DIGITS, TOTP_PERIOD,
  type TotpAlgorithm, type TotpMetadata,
} from '../shared/totp.ts';
import { UserError } from '../shared/validation.ts';

export interface ParsedTotp {
  key: Buffer;
  metadata: TotpMetadata;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_PADDING = [0, -1, 6, -1, 4, 3, -1, 1] as const;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const IMPORT_FIELDS = ['secret', 'issuer', 'algorithm', 'digits', 'period'];
const MAX_COUNTER = 0xffffffffffffffffn;

function importError(): UserError {
  return new UserError('認証情報の形式または設定が正しくありません。');
}

function isAlgorithm(value: unknown): value is TotpAlgorithm {
  return value === 'SHA1' || value === 'SHA256' || value === 'SHA512';
}

export function decodeBase32(value: unknown, allowSpaces = false): Buffer {
  if (typeof value !== 'string' || value.length > MAX_TOTP_INPUT_LENGTH || typeof allowSpaces !== 'boolean') {
    throw new UserError('認証シークレットの形式または長さが正しくありません。');
  }
  const input = allowSpaces ? value.replaceAll(' ', '') : value;
  const paddingStart = input.indexOf('=');
  const data = paddingStart === -1 ? input : input.slice(0, paddingStart);
  const padding = input.slice(data.length);
  const expectedPadding = BASE32_PADDING[data.length % 8]!;
  const byteLength = Math.floor(data.length * 5 / 8);
  if (!data || /[^A-Za-z2-7]/u.test(data) || /[^=]/u.test(padding) || expectedPadding < 0
    || (padding.length > 0 && padding.length !== expectedPadding)
    || byteLength < 1 || byteLength > MAX_TOTP_SECRET_BYTES) {
    throw new UserError('認証シークレットの形式または長さが正しくありません。');
  }

  const normalized = data.toUpperCase();
  const unusedBits = data.length * 5 % 8;
  if ((BASE32_ALPHABET.indexOf(normalized[normalized.length - 1]!) & ((1 << unusedBits) - 1)) !== 0) {
    throw new UserError('認証シークレットの末尾の形式が正しくありません。');
  }

  const key = Buffer.alloc(byteLength);
  let bits = 0;
  let pending = 0;
  let position = 0;
  for (const character of normalized) {
    pending = (pending << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key[position++] = pending >>> bits;
      pending &= (1 << bits) - 1;
    }
  }
  return key;
}

function decodeUriComponent(value: string, query = false): string {
  if (/[^A-Za-z0-9\-._~!$&'()*+,;=:@%/?]/u.test(value)) throw importError();
  let decoded: string;
  try {
    decoded = decodeURIComponent(query ? value.replaceAll('+', ' ') : value);
  } catch {
    throw importError();
  }
  if (CONTROL_CHARACTERS.test(decoded)) throw importError();
  return decoded;
}

function label(value: string): string {
  if (!value.trim() || value.length > MAX_TOTP_LABEL_LENGTH || value.includes(':')
    || CONTROL_CHARACTERS.test(value)) {
    throw importError();
  }
  return value;
}

export function parseTotpImport(value: unknown): ParsedTotp {
  if (typeof value !== 'string' || value.length > MAX_TOTP_INPUT_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw importError();
  }
  const input = value.replace(/^ +| +$/g, '');
  if (!input.includes(':')) {
    return {
      key: decodeBase32(input, true),
      metadata: { algorithm: 'SHA1', digits: TOTP_DIGITS, period: TOTP_PERIOD, issuer: null, account: null },
    };
  }

  // Parse the original authority and components without URL normalization.
  const uri = /^otpauth:\/\/([^/?#]*)\/([^/?#]+)\?([^#]+)$/i.exec(input);
  if (!uri || uri[1]!.toLowerCase() !== 'totp') throw importError();
  const parts = decodeUriComponent(uri[2]!).split(':');
  if (parts.length > 2) throw importError();
  let issuer = parts.length === 2 ? label(parts[0]!) : null;
  const account = label(parts.length === 2 ? parts[1]!.replace(/^ +/, '') : parts[0]!);

  const fields = new Map<string, string>();
  for (const field of uri[3]!.split('&')) {
    const separator = field.indexOf('=');
    if (separator < 1 || separator === field.length - 1) throw importError();
    const name = decodeUriComponent(field.slice(0, separator), true);
    const content = decodeUriComponent(field.slice(separator + 1), true);
    if (!IMPORT_FIELDS.includes(name) || fields.has(name) || !content) throw importError();
    fields.set(name, content);
  }
  const secret = fields.get('secret');
  const algorithm = fields.get('algorithm') ?? 'SHA1';
  if (!secret || !isAlgorithm(algorithm)
    || (fields.get('digits') ?? '6') !== '6'
    || (fields.get('period') ?? '30') !== '30') {
    throw importError();
  }
  const queryIssuer = fields.get('issuer');
  if (queryIssuer !== undefined) {
    label(queryIssuer);
    if (issuer !== null && issuer !== queryIssuer) throw importError();
    issuer = queryIssuer;
  }
  return {
    key: decodeBase32(secret),
    metadata: { algorithm, digits: TOTP_DIGITS, period: TOTP_PERIOD, issuer, account },
  };
}

// Eight digits are available only for internal RFC vectors, never for imported settings.
export function hotp(key: Uint8Array, counter: bigint, algorithm: TotpAlgorithm, digits: 6 | 8 = 6): string {
  if (!ArrayBuffer.isView(key) || !(key instanceof Uint8Array)
    || key.byteLength < 1 || key.byteLength > MAX_TOTP_SECRET_BYTES
    || typeof counter !== 'bigint' || counter < 0n || counter > MAX_COUNTER
    || !isAlgorithm(algorithm) || (digits !== 6 && digits !== 8)) {
    throw new UserError('認証コードの生成条件が正しくありません。');
  }
  try {
    const movingFactor = Buffer.alloc(8);
    movingFactor.writeBigUInt64BE(counter);
    const digest = createHmac(algorithm.toLowerCase(), key).update(movingFactor).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
    return (truncated % (10 ** digits)).toString().padStart(digits, '0');
  } catch {
    throw new UserError('認証コードを生成できませんでした。');
  }
}

export function totpAt(key: Uint8Array, algorithm: TotpAlgorithm, nowMs: number): {
  code: string; generatedAt: number; validFrom: number; validUntil: number;
} {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new UserError('認証コードの生成時刻が正しくありません。');
  }
  const periodMs = BigInt(TOTP_PERIOD * 1000);
  const counter = BigInt(nowMs) / periodMs;
  const validFrom = Number(counter * periodMs);
  const validUntil = Number((counter + 1n) * periodMs);
  if (!Number.isSafeInteger(validFrom) || !Number.isSafeInteger(validUntil)) {
    throw new UserError('認証コードの有効時刻が範囲外です。');
  }
  return { code: hotp(key, counter, algorithm), generatedAt: nowMs, validFrom, validUntil };
}
