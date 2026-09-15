import { isUtf8 } from 'node:buffer';
import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID, scrypt, timingSafeEqual,
} from 'node:crypto';
import { UserError, id } from '../shared/validation.ts';

export type EnvelopePurpose = 'operation' | 'local' | 'passphrase' | 'recovery';

export interface SealedEnvelope {
  version: 1;
  purpose: EnvelopePurpose;
  vaultId: string;
  envelopeId: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface WrappingEnvelope {
  version: 1;
  vaultId: string;
  wrapperId: string;
  generation: number;
  parents: string[];
  kdf: { name: 'scrypt'; N: 131072; r: 8; p: 1; salt: string };
  passphrase: SealedEnvelope;
  recovery: SealedEnvelope;
  proof: string;
}

export const MAX_ENVELOPE_BYTES = 65_536;
export const MAX_WRAPPING_BYTES = 16_384;

const MAX_PLAINTEXT_BYTES = 45 * 1024;
const KEY_BYTES = 32;
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const ENVELOPE_FIELDS = ['version', 'purpose', 'vaultId', 'envelopeId', 'salt', 'nonce', 'ciphertext', 'tag'];
const WRAPPING_FIELDS = ['version', 'vaultId', 'wrapperId', 'generation', 'parents', 'kdf', 'passphrase', 'recovery', 'proof'];
const KEY_DOMAIN = 'Shinano/vault/envelope-key';
const PROOF_DOMAIN = 'Shinano/vault/wrapping-proof/v1\0';
type EnvelopeHeader = Omit<SealedEnvelope, 'ciphertext' | 'tag'>;
type WrappingHeader = Omit<WrappingEnvelope, 'proof'>;
let scryptQueue: Promise<void> = Promise.resolve();

function formatError(): UserError {
  return new UserError('暗号化データの形式、サイズ、または設定が正しくありません。');
}

function authenticationError(): UserError {
  return new UserError('暗号化データを認証できませんでした。鍵またはデータを確認してください。');
}

function cryptoError(): UserError {
  return new UserError('暗号処理を実行できませんでした。データは変更されていません。');
}

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== names.length) {
    throw formatError();
  }
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property || !property.enumerable || !('value' in property)) throw formatError();
    result[name] = property.value;
  }
  return result;
}

function purpose(value: unknown): EnvelopePurpose {
  if (value !== 'operation' && value !== 'local' && value !== 'passphrase' && value !== 'recovery') {
    throw formatError();
  }
  return value;
}

function keyBytes(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== KEY_BYTES) {
    throw new UserError('暗号鍵の形式が正しくありません。');
  }
  return value;
}

function base64(value: unknown, byteLimit: number, exact = true): string {
  if (typeof value !== 'string' || value.length > Math.ceil(byteLimit / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw formatError();
  }
  const decoded = Buffer.from(value, 'base64');
  try {
    if ((exact ? decoded.length !== byteLimit : decoded.length > byteLimit) || decoded.toString('base64') !== value) {
      throw formatError();
    }
    return value;
  } finally {
    decoded.fill(0);
  }
}

function boundedJson(value: unknown, byteLimit: number): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > byteLimit) throw formatError();
  return text;
}

function inputText(value: unknown, byteLimit: number): string {
  if (typeof value === 'string') {
    if (value.length > byteLimit || Buffer.byteLength(value, 'utf8') > byteLimit) throw formatError();
    return value;
  }
  if (!Buffer.isBuffer(value) || value.length > byteLimit || !isUtf8(value)) throw formatError();
  return value.toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw formatError();
    throw error;
  }
}

function envelopeValue(value: unknown): SealedEnvelope {
  const data = fields(value, ENVELOPE_FIELDS);
  if (data.version !== 1) throw formatError();
  const envelope: SealedEnvelope = {
    version: 1,
    purpose: purpose(data.purpose),
    vaultId: id(data.vaultId),
    envelopeId: id(data.envelopeId),
    salt: base64(data.salt, 32),
    nonce: base64(data.nonce, 12),
    ciphertext: base64(data.ciphertext, MAX_PLAINTEXT_BYTES, false),
    tag: base64(data.tag, 16),
  };
  boundedJson(envelope, MAX_ENVELOPE_BYTES);
  return envelope;
}

function envelopeHeader(envelope: EnvelopeHeader): EnvelopeHeader {
  return {
    version: envelope.version, purpose: envelope.purpose, vaultId: envelope.vaultId,
    envelopeId: envelope.envelopeId, salt: envelope.salt, nonce: envelope.nonce,
  };
}

function objectKey(key: Buffer, envelope: EnvelopeHeader): Buffer {
  const salt = Buffer.from(envelope.salt, 'base64');
  const info = Buffer.from(JSON.stringify({
    domain: KEY_DOMAIN, version: envelope.version, purpose: envelope.purpose,
    vaultId: envelope.vaultId, envelopeId: envelope.envelopeId,
  }), 'utf8');
  try {
    return Buffer.from(hkdfSync('sha256', key, salt, info, KEY_BYTES));
  } catch {
    throw cryptoError();
  } finally {
    salt.fill(0);
    info.fill(0);
  }
}

function freshId(): string {
  try {
    return randomUUID();
  } catch {
    throw cryptoError();
  }
}

function freshBytes(length: number): Buffer {
  try {
    return randomBytes(length);
  } catch {
    throw cryptoError();
  }
}

function freshBase64(length: number): string {
  const bytes = freshBytes(length);
  try {
    return bytes.toString('base64');
  } finally {
    bytes.fill(0);
  }
}

export function seal(
  requestedPurpose: EnvelopePurpose, vaultId: string, key: Buffer, plaintext: Buffer,
): SealedEnvelope {
  const validPurpose = purpose(requestedPurpose);
  const validVaultId = id(vaultId);
  keyBytes(key);
  if (!Buffer.isBuffer(plaintext) || plaintext.length > MAX_PLAINTEXT_BYTES) throw formatError();
  const header: EnvelopeHeader = {
    version: 1, purpose: validPurpose, vaultId: validVaultId, envelopeId: freshId(),
    salt: freshBase64(32), nonce: freshBase64(12),
  };
  const nonce = Buffer.from(header.nonce, 'base64');
  const aad = Buffer.from(JSON.stringify(header), 'utf8');
  const derived = objectKey(key, header);
  let encrypted: Buffer | undefined;
  let final: Buffer | undefined;
  let tag: Buffer | undefined;
  let envelope: SealedEnvelope;
  try {
    const cipher = createCipheriv('aes-256-gcm', derived, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    encrypted = cipher.update(plaintext);
    final = cipher.final();
    tag = cipher.getAuthTag();
    envelope = { ...header, ciphertext: encrypted.toString('base64'), tag: tag.toString('base64') };
    if (final.length !== 0) throw cryptoError();
  } catch {
    throw cryptoError();
  } finally {
    derived.fill(0);
    nonce.fill(0);
    aad.fill(0);
    encrypted?.fill(0);
    final?.fill(0);
    tag?.fill(0);
  }
  return envelopeValue(envelope);
}

export function unseal(
  requestedPurpose: EnvelopePurpose, vaultId: string, key: Buffer, value: SealedEnvelope,
): Buffer {
  const validPurpose = purpose(requestedPurpose);
  const validVaultId = id(vaultId);
  keyBytes(key);
  const envelope = envelopeValue(value);
  if (envelope.purpose !== validPurpose || envelope.vaultId !== validVaultId) throw authenticationError();
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const aad = Buffer.from(JSON.stringify(envelopeHeader(envelope)), 'utf8');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const derived = objectKey(key, envelope);
  let partial: Buffer | undefined;
  let final: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    partial = decipher.update(ciphertext);
    final = decipher.final();
    return Buffer.concat([partial, final]);
  } catch {
    throw authenticationError();
  } finally {
    derived.fill(0);
    nonce.fill(0);
    aad.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
    partial?.fill(0);
    final?.fill(0);
  }
}

export function encodeEnvelope(envelope: SealedEnvelope): string {
  return boundedJson(envelopeValue(envelope), MAX_ENVELOPE_BYTES);
}

export function parseEnvelope(text: string | Buffer): SealedEnvelope {
  const input = inputText(text, MAX_ENVELOPE_BYTES);
  const envelope = envelopeValue(parseJson(input));
  if (encodeEnvelope(envelope) !== input) throw formatError();
  return envelope;
}

function generation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 64) throw formatError();
  return value;
}

function parents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8 || Reflect.ownKeys(value).length !== value.length + 1) {
    throw formatError();
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !('value' in property)) throw formatError();
    const parent = id(property.value);
    if (index > 0 && result[index - 1]! >= parent) throw formatError();
    result.push(parent);
  }
  return result;
}

function wrappingSlot(value: unknown, expectedPurpose: 'passphrase' | 'recovery', vaultId: string): SealedEnvelope {
  const slot = envelopeValue(value);
  if (slot.purpose !== expectedPurpose || slot.vaultId !== vaultId) throw formatError();
  base64(slot.ciphertext, KEY_BYTES);
  return slot;
}

function wrappingValue(value: unknown): WrappingEnvelope {
  const data = fields(value, WRAPPING_FIELDS);
  const kdf = fields(data.kdf, ['name', 'N', 'r', 'p', 'salt']);
  if (data.version !== 1 || kdf.name !== 'scrypt' || kdf.N !== 131072 || kdf.r !== 8 || kdf.p !== 1) {
    throw formatError();
  }
  const vaultId = id(data.vaultId);
  const wrapping: WrappingEnvelope = {
    version: 1, vaultId, wrapperId: id(data.wrapperId), generation: generation(data.generation),
    parents: parents(data.parents),
    kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt: base64(kdf.salt, 32) },
    passphrase: wrappingSlot(data.passphrase, 'passphrase', vaultId),
    recovery: wrappingSlot(data.recovery, 'recovery', vaultId),
    proof: base64(data.proof, 32),
  };
  if (wrapping.parents.includes(wrapping.wrapperId)
    || wrapping.passphrase.envelopeId === wrapping.recovery.envelopeId) throw formatError();
  boundedJson(wrapping, MAX_WRAPPING_BYTES);
  return wrapping;
}

function wrappingHeader(wrapping: WrappingHeader): WrappingHeader {
  return {
    version: wrapping.version, vaultId: wrapping.vaultId, wrapperId: wrapping.wrapperId,
    generation: wrapping.generation, parents: wrapping.parents, kdf: wrapping.kdf,
    passphrase: wrapping.passphrase, recovery: wrapping.recovery,
  };
}

function wrappingProof(wrapping: WrappingHeader, rootKey: Buffer): Buffer {
  const data = Buffer.from(JSON.stringify(wrappingHeader(wrapping)), 'utf8');
  try {
    return createHmac('sha256', rootKey).update(PROOF_DOMAIN, 'utf8').update(data).digest();
  } catch {
    throw cryptoError();
  } finally {
    data.fill(0);
  }
}

export function encodeWrapping(value: WrappingEnvelope): string {
  return boundedJson(wrappingValue(value), MAX_WRAPPING_BYTES);
}

export function parseWrapping(text: string | Buffer): WrappingEnvelope {
  const input = inputText(text, MAX_WRAPPING_BYTES);
  const wrapping = wrappingValue(parseJson(input));
  if (encodeWrapping(wrapping) !== input) throw formatError();
  return wrapping;
}

export function validatePassphrase(input: unknown): string {
  const invalid = () => new UserError('パスフレーズは 20 文字以上、UTF-8 で 1,024 バイト以内で入力してください。');
  if (typeof input !== 'string' || input.length > 1024 || Buffer.byteLength(input, 'utf8') > 1024) throw invalid();
  let count = 0;
  for (const character of input) {
    const codepoint = character.codePointAt(0)!;
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) throw invalid();
    count++;
  }
  if (count < 20) throw invalid();
  return input;
}

function recoveryKeyBytes(input: unknown): Buffer {
  if (typeof input !== 'string' || input.length < 64 || input.length > 127
    || !/^[0-9A-Fa-f]+(?:[- ][0-9A-Fa-f]+)*$/.test(input)) {
    throw new UserError('回復キーの形式または長さが正しくありません。');
  }
  const hex = input.replaceAll('-', '').replaceAll(' ', '');
  if (hex.length !== 64) throw new UserError('回復キーの形式または長さが正しくありません。');
  return Buffer.from(hex, 'hex');
}

function passphraseKey(password: string, salt: Buffer): Promise<Buffer> {
  const job = scryptQueue.then(async () => {
    const bytes = Buffer.from(password, 'utf8');
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        try {
          scrypt(bytes, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, derived) => {
            if (error) {
              derived?.fill(0);
              reject(new UserError('パスフレーズの鍵を導出できませんでした。利用可能なメモリなどを確認してください。'));
            } else {
              resolve(derived);
            }
          });
        } catch {
          reject(new UserError('パスフレーズの鍵を導出できませんでした。利用可能なメモリなどを確認してください。'));
        }
      });
    } finally {
      bytes.fill(0);
    }
  });
  // Failed jobs release the queue too; no later derivation can overlap this one.
  scryptQueue = job.then(() => undefined, () => undefined);
  return job;
}

export async function createWrapping(
  vaultId: string,
  rootKey: Buffer,
  passphrase: string,
  options?: { generation: number; parents: string[]; recovery: SealedEnvelope },
): Promise<{ wrapping: WrappingEnvelope; recoveryKey: string | null }> {
  const validVaultId = id(vaultId);
  keyBytes(rootKey);
  const password = validatePassphrase(passphrase);
  const rewrap = options === undefined ? undefined : fields(options, ['generation', 'parents', 'recovery']);
  const nextGeneration = rewrap === undefined ? 1 : generation(rewrap.generation);
  const nextParents = rewrap === undefined ? [] : parents(rewrap.parents);
  // The caller must verify the source wrapping with this same root before reusing its recovery slot.
  const previousRecovery = rewrap === undefined ? undefined : wrappingSlot(rewrap.recovery, 'recovery', validVaultId);
  const root = Buffer.from(rootKey);
  let salt: Buffer | undefined;
  let passwordKey: Buffer | undefined;
  let recovery: Buffer | undefined;
  let proof: Buffer | undefined;
  try {
    const wrapperId = freshId();
    salt = freshBytes(32);
    passwordKey = await passphraseKey(password, salt);
    if (previousRecovery === undefined) recovery = freshBytes(KEY_BYTES);
    const header: WrappingHeader = {
      version: 1, vaultId: validVaultId, wrapperId, generation: nextGeneration, parents: nextParents,
      kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt: salt.toString('base64') },
      passphrase: seal('passphrase', validVaultId, passwordKey, root),
      recovery: previousRecovery ?? seal('recovery', validVaultId, recovery!, root),
    };
    proof = wrappingProof(header, root);
    const wrapping = wrappingValue({ ...header, proof: proof.toString('base64') });
    return {
      wrapping,
      recoveryKey: recovery === undefined ? null : recovery.toString('hex').toUpperCase().match(/.{8}/g)!.join('-'),
    };
  } finally {
    root.fill(0);
    salt?.fill(0);
    passwordKey?.fill(0);
    recovery?.fill(0);
    proof?.fill(0);
  }
}

export function verifyWrapping(value: WrappingEnvelope, rootKey: Buffer): void {
  keyBytes(rootKey);
  const wrapping = wrappingValue(value);
  const proof = Buffer.from(wrapping.proof, 'base64');
  const expected = wrappingProof(wrapping, rootKey);
  let valid: boolean;
  try {
    valid = timingSafeEqual(proof, expected);
  } catch {
    throw cryptoError();
  } finally {
    proof.fill(0);
    expected.fill(0);
  }
  if (!valid) throw authenticationError();
}

export async function unlockWrapping(
  value: WrappingEnvelope, method: 'passphrase' | 'recovery', input: string,
): Promise<Buffer> {
  const wrapping = wrappingValue(value);
  if (method !== 'passphrase' && method !== 'recovery') throw formatError();
  let key: Buffer | undefined;
  let salt: Buffer | undefined;
  let root: Buffer | undefined;
  try {
    if (method === 'passphrase') {
      const password = validatePassphrase(input);
      salt = Buffer.from(wrapping.kdf.salt, 'base64');
      key = await passphraseKey(password, salt);
    } else {
      key = recoveryKeyBytes(input);
    }
    root = unseal(method, wrapping.vaultId, key, wrapping[method]);
    if (root.length !== KEY_BYTES) throw authenticationError();
    verifyWrapping(wrapping, root);
    const result = root;
    root = undefined;
    return result;
  } finally {
    key?.fill(0);
    salt?.fill(0);
    root?.fill(0);
  }
}
