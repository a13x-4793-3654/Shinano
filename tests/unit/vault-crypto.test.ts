import assert from 'node:assert/strict';
import crypto, { type BinaryLike, type ScryptOptions } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import {
  MAX_ENVELOPE_BYTES, MAX_WRAPPING_BYTES, createWrapping, encodeEnvelope, encodeWrapping,
  parseEnvelope, parseWrapping, seal, unlockWrapping, unseal, validatePassphrase, verifyWrapping,
  type EnvelopePurpose, type SealedEnvelope, type WrappingEnvelope,
} from '../../src/main/vault-crypto.ts';
import { UserError } from '../../src/shared/validation.ts';

// Public, synthetic fixtures only. Compare secret-bearing values as booleans so failures never dump them.
const VAULT = '10000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const ROOT = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const PAYLOAD = Buffer.from('PUBLIC_SYNTHETIC_PAYLOAD', 'utf8');
const PASSWORD = '  PUBLIC synthetic e\u0301 🔒 passphrase  ';
const NEXT_PASSWORD = ' PUBLIC different synthetic passphrase ';
const SENTINEL = 'PUBLIC_SYNTHETIC_FAILURE_MARKER';
const PURPOSES: EnvelopePurpose[] = ['operation', 'local', 'passphrase', 'recovery'];

function openedEquals(actual: Buffer, expected: Buffer): void {
  try {
    assert.ok(actual.equals(expected), 'Authenticated bytes match the synthetic fixture');
  } finally {
    actual.fill(0);
  }
}

function flipBase64(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  try {
    bytes[0] = bytes[0]! ^ 1;
    return bytes.toString('base64');
  } finally {
    bytes.fill(0);
  }
}

function safeError(error: unknown): boolean {
  assert.ok(error instanceof UserError);
  assert.match(error.message, /[ぁ-んァ-ヶ一-龯]/u);
  for (const excluded of [SENTINEL, PASSWORD, NEXT_PASSWORD, PAYLOAD.toString('utf8')]) {
    assert.equal(String(error).includes(excluded), false);
  }
  assert.equal(error.cause, undefined);
  return true;
}

test('every envelope purpose roundtrips binary and empty plaintext without changing caller buffers', () => {
  for (const purpose of PURPOSES) {
    for (const plaintext of [Buffer.alloc(0), PAYLOAD, Buffer.from([0, 255, 128, 1])]) {
      const beforeKey = Buffer.from(ROOT);
      const beforePlaintext = Buffer.from(plaintext);
      const envelope = seal(purpose, VAULT, ROOT, plaintext);
      assert.equal(envelope.version, 1);
      assert.equal(envelope.purpose, purpose);
      assert.equal(envelope.vaultId, VAULT);
      assert.match(envelope.envelopeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      for (const [field, size] of [['salt', 32], ['nonce', 12], ['tag', 16]] as const) {
        assert.equal(Buffer.from(envelope[field], 'base64').length, size);
      }
      const encoded = encodeEnvelope(envelope);
      openedEquals(unseal(purpose, VAULT, ROOT, parseEnvelope(encoded)), plaintext);
      openedEquals(unseal(purpose, VAULT, ROOT, parseEnvelope(Buffer.from(encoded, 'utf8'))), plaintext);
      assert.ok(ROOT.equals(beforeKey));
      assert.ok(plaintext.equals(beforePlaintext));
      beforeKey.fill(0);
      beforePlaintext.fill(0);
    }
  }
});

test('equal logical plaintext always receives fresh UUID, salt, nonce and envelope bytes', () => {
  const values = Array.from({ length: 16 }, () => seal('operation', VAULT, ROOT, PAYLOAD));
  for (const field of ['envelopeId', 'salt', 'nonce', 'ciphertext', 'tag'] as const) {
    assert.equal(new Set(values.map((value) => value[field])).size, values.length);
  }
  assert.equal(new Set(values.map(encodeEnvelope)).size, values.length);
});

test('envelopes interoperate with explicit HKDF-SHA256, canonical AAD and full-tag AES-256-GCM', () => {
  const envelope = seal('operation', VAULT, ROOT, PAYLOAD);
  const header = {
    version: 1, purpose: envelope.purpose, vaultId: envelope.vaultId, envelopeId: envelope.envelopeId,
    salt: envelope.salt, nonce: envelope.nonce,
  };
  const derived = Buffer.from(crypto.hkdfSync('sha256', ROOT, Buffer.from(envelope.salt, 'base64'),
    Buffer.from(JSON.stringify({
      domain: 'Shinano/vault/envelope-key', version: 1, purpose: envelope.purpose,
      vaultId: envelope.vaultId, envelopeId: envelope.envelopeId,
    })), 32));
  let partial: Buffer | undefined;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derived, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    partial = decipher.update(Buffer.from(envelope.ciphertext, 'base64'));
    openedEquals(Buffer.concat([partial, decipher.final()]), PAYLOAD);
  } finally {
    derived.fill(0);
    partial?.fill(0);
  }
});

test('purpose, vault identity, encryption identity, AAD, ciphertext and tag tampering fail closed', () => {
  const envelope = seal('operation', VAULT, ROOT, PAYLOAD);
  assert.throws(() => unseal('local', VAULT, ROOT, envelope), safeError);
  assert.throws(() => unseal('operation', OTHER, ROOT, envelope), safeError);
  assert.throws(() => unseal('operation', VAULT, Buffer.alloc(32, 99), envelope), safeError);
  for (const changed of [
    { ...envelope, purpose: 'local' as const },
    { ...envelope, vaultId: OTHER },
    { ...envelope, envelopeId: OTHER },
    ...(['salt', 'nonce', 'ciphertext', 'tag'] as const).map((field) => ({
      ...envelope, [field]: flipBase64(envelope[field]),
    })),
  ]) {
    assert.throws(() => unseal(changed.purpose, changed.vaultId, ROOT, changed), safeError);
  }
});

test('temporary HKDF keys and derivation contexts are cleared on success and authentication failure', (t) => {
  const nativeHkdf = crypto.hkdfSync;
  const temporary: Buffer[] = [];
  const observer = t.mock.method(crypto, 'hkdfSync', (...args: Parameters<typeof crypto.hkdfSync>) => {
    const result = nativeHkdf(...args);
    temporary.push(Buffer.from(result));
    for (const input of args.slice(2, 4)) if (Buffer.isBuffer(input)) temporary.push(input);
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { observer.mock.restore(); syncBuiltinESMExports(); });
  const envelope = seal('operation', VAULT, ROOT, PAYLOAD);
  openedEquals(unseal('operation', VAULT, ROOT, envelope), PAYLOAD);
  assert.throws(() => unseal('operation', VAULT, ROOT, { ...envelope, tag: flipBase64(envelope.tag) }), safeError);
  assert.equal(observer.mock.callCount(), 3);
  for (const bytes of temporary) {
    assert.ok(bytes.every((byte) => byte === 0), 'Temporary HKDF buffers have been cleared');
  }
});

test('envelopes require exact runtime fields, supported identities and canonical base64', () => {
  const envelope = seal('operation', VAULT, ROOT, PAYLOAD);
  const missing = { ...envelope } as Partial<SealedEnvelope>;
  delete missing.tag;
  for (const value of [
    null, false, 1, [], {}, missing, { ...envelope, extra: true },
    { ...envelope, version: 2 }, { ...envelope, version: '1' }, { ...envelope, purpose: 'unknown' },
    { ...envelope, vaultId: VAULT.replace('-4000-', '-1000-') },
    { ...envelope, envelopeId: 'ABCDEFAB-0000-4000-8000-000000000001' },
    { ...envelope, nonce: Buffer.alloc(11).toString('base64') },
    { ...envelope, salt: Buffer.alloc(31).toString('base64') },
    { ...envelope, tag: Buffer.alloc(12).toString('base64') },
    { ...envelope, ciphertext: 'AB==' },
    { ...envelope, salt: `${'A'.repeat(42)}B=` },
    { ...envelope, tag: `${'A'.repeat(21)}B==` },
    ...['salt', 'nonce', 'ciphertext', 'tag'].flatMap((field) => [
      { ...envelope, [field]: 0 }, { ...envelope, [field]: `${envelope[field as keyof SealedEnvelope]}\n` },
      { ...envelope, [field]: '-___' },
    ]),
    { ...envelope, salt: envelope.salt.replaceAll('=', '') },
    { ...envelope, tag: `${envelope.tag}=` },
  ]) {
    assert.throws(() => encodeEnvelope(value as SealedEnvelope), UserError);
    assert.throws(() => parseEnvelope(JSON.stringify(value)), UserError);
    assert.throws(() => unseal('operation', VAULT, ROOT, value as SealedEnvelope), UserError);
  }
  assert.throws(() => encodeEnvelope(Object.create(envelope) as SealedEnvelope), UserError);
  assert.throws(() => encodeEnvelope({ ...envelope, [Symbol('extra')]: true }), UserError);
  let invoked = false;
  const accessor = { ...envelope };
  Object.defineProperty(accessor, 'tag', { enumerable: true, get: () => { invoked = true; return envelope.tag; } });
  assert.throws(() => encodeEnvelope(accessor), UserError);
  assert.equal(invoked, false);
  for (const key of [null, 'not a key', Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32)]) {
    assert.throws(() => seal('operation', VAULT, key as Buffer, PAYLOAD), UserError);
    assert.throws(() => unseal('operation', VAULT, key as Buffer, envelope), UserError);
  }
  assert.throws(() => seal('unknown' as EnvelopePurpose, VAULT, ROOT, PAYLOAD), UserError);
  assert.throws(() => seal('local', 'not-a-uuid', ROOT, PAYLOAD), UserError);
  assert.throws(() => seal('local', VAULT, ROOT, new Uint8Array(1) as Buffer), UserError);
});

test('canonical JSON rejects alternate spellings, duplicate keys, whitespace and truncation', () => {
  const envelope = seal('operation', VAULT, ROOT, PAYLOAD);
  const encoded = encodeEnvelope(envelope);
  const { tag, ...headerAndCiphertext } = envelope;
  const reordered = { tag, ...headerAndCiphertext };
  assert.ok(encodeEnvelope(reordered) === encoded);
  for (const text of [
    ` ${encoded}`, `${encoded}\n`, JSON.stringify(envelope, null, 2), JSON.stringify(reordered),
    encoded.replace('"version":1', '"version":1.0'), encoded.replace('"version":1', '"version":1e0'),
    encoded.replace('"version":1', '"version":1,"version":1'),
    encoded.replace('"operation"', '"\\u006fperation"'), encoded.slice(0, -1),
    `{"${SENTINEL}":`, `${encoded}${encoded}`,
  ]) {
    assert.throws(() => parseEnvelope(text), safeError);
  }
});

test('raw plaintext is limited to 45 KiB and final sealed JSON stays below the 64 KiB limit', () => {
  assert.equal(MAX_ENVELOPE_BYTES, 65_536);
  const plaintext = Buffer.alloc(45 * 1024, 7);
  const envelope = seal('operation', VAULT, ROOT, plaintext);
  assert.ok(Buffer.byteLength(encodeEnvelope(envelope), 'utf8') <= MAX_ENVELOPE_BYTES);
  openedEquals(unseal('operation', VAULT, ROOT, envelope), plaintext);
  const oversized = Buffer.alloc(45 * 1024 + 1);
  assert.throws(() => seal('operation', VAULT, ROOT, oversized), UserError);
  assert.throws(() => encodeEnvelope({ ...envelope, ciphertext: oversized.toString('base64') }), UserError);
  assert.throws(() => unseal('operation', VAULT, ROOT, { ...envelope, ciphertext: oversized.toString('base64') }), UserError);
});

test('both decoders bound UTF-8 bytes and reject non-UTF-8 buffers before calling JSON.parse', (t) => {
  assert.equal(MAX_WRAPPING_BYTES, 16_384);
  const parse = t.mock.method(JSON, 'parse', JSON.parse);
  for (const [decode, limit] of [[parseEnvelope, MAX_ENVELOPE_BYTES], [parseWrapping, MAX_WRAPPING_BYTES]] as const) {
    for (const value of [
      ' '.repeat(limit + 1), Buffer.alloc(limit + 1, 32), 'あ'.repeat(Math.floor(limit / 3) + 1),
      Buffer.from([0xff]), Buffer.from([0xed, 0xa0, 0x80]),
      null, undefined, 123, new String('{}'), new Uint8Array(1),
    ]) {
      assert.throws(() => decode(value as string | Buffer), UserError);
    }
  }
  assert.equal(parse.mock.callCount(), 0);
});

test('passphrases preserve exact Unicode and spaces and enforce codepoint and UTF-8 byte bounds', () => {
  for (const value of [
    PASSWORD, PASSWORD.normalize('NFC'), ' '.repeat(20), 'A'.repeat(20), '🔒'.repeat(20),
    'a'.repeat(1024), 'é'.repeat(512), '🔒'.repeat(256), `${'x'.repeat(20)}\u0000\r\n`,
  ]) {
    assert.ok(validatePassphrase(value) === value);
  }
  for (const value of [
    null, undefined, false, 123, [], {}, new String(PASSWORD), Buffer.from(PASSWORD),
    '', 'a'.repeat(19), '🔒'.repeat(19), 'a'.repeat(1025), 'é'.repeat(513), '🔒'.repeat(257),
    `${'a'.repeat(20)}\ud800`, `\udfff${'a'.repeat(20)}`, `${'a'.repeat(20)}\ud800\ud800`,
  ]) {
    assert.throws(() => validatePassphrase(value), safeError);
  }
});

test('wrapping authenticates both slots and metadata, supports recovery and rewrap, and serializes real async scrypt', async (t) => {
  const nativeScrypt = crypto.scrypt;
  let failFirst = true;
  let active = 0;
  let peak = 0;
  let realJobs = 0;
  const parameters: boolean[] = [];
  const passwords: Buffer[] = [];
  const salts: Buffer[] = [];
  const derivedKeys: Buffer[] = [];
  const observe = (
    password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions,
    callback: (error: Error | null, derived: Buffer) => void,
  ): void => {
    active++;
    peak = Math.max(peak, active);
    parameters.push(keylen === 32 && options.N === 131072 && options.r === 8 && options.p === 1
      && options.maxmem === 256 * 1024 * 1024 && Buffer.isBuffer(password) && Buffer.isBuffer(salt) && salt.length === 32);
    if (Buffer.isBuffer(password)) passwords.push(password);
    if (Buffer.isBuffer(salt)) salts.push(salt);
    if (failFirst) {
      failFirst = false;
      setImmediate(() => { active--; callback(new Error(SENTINEL), Buffer.alloc(0)); });
      return;
    }
    realJobs++;
    nativeScrypt(password, salt, keylen, options, (error, derived) => {
      if (derived) derivedKeys.push(derived);
      active--;
      callback(error, derived);
    });
  };
  const observer = t.mock.method(crypto, 'scrypt', observe as typeof crypto.scrypt);
  syncBuiltinESMExports();
  t.after(() => { observer.mock.restore(); syncBuiltinESMExports(); });

  const failed = createWrapping(VAULT, ROOT, PASSWORD);
  const callerRoot = Buffer.from(ROOT);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const creating = createWrapping(VAULT, callerRoot, PASSWORD);
  callerRoot.fill(0);
  let created: Awaited<ReturnType<typeof createWrapping>>;
  try {
    await assert.rejects(failed, safeError);
    created = await creating;
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'The event loop makes progress during the real memory-hard derivation');
  const { wrapping, recoveryKey } = created;
  assert.ok(recoveryKey !== null);
  assert.ok(/^[0-9A-F]{8}(?:-[0-9A-F]{8}){7}$/.test(recoveryKey));
  assert.equal(wrapping.generation, 1);
  assert.equal(wrapping.parents.length, 0);
  assert.equal(wrapping.vaultId, VAULT);
  verifyWrapping(wrapping, ROOT);

  await t.test('exact passphrases unlock and simultaneous correct/wrong attempts never overlap KDF jobs', async () => {
    const candidate = structuredClone(wrapping);
    const correct = unlockWrapping(candidate, 'passphrase', PASSWORD);
    candidate.wrapperId = OTHER;
    candidate.kdf.salt = flipBase64(candidate.kdf.salt);
    await Promise.all([
      correct.then((root) => openedEquals(root, ROOT)),
      assert.rejects(unlockWrapping(wrapping, 'passphrase', PASSWORD.normalize('NFC')), safeError),
    ]);
  });

  await t.test('recovery accepts only ASCII hex grouping and verifies proof before releasing the root', async () => {
    const hex = recoveryKey.replaceAll('-', '');
    for (const input of [
      recoveryKey, hex, hex.toLowerCase(), recoveryKey.replaceAll('-', ' '),
      hex.match(/.{4}/g)!.join('-'), hex.match(/.{2}/g)!.join(' '),
    ]) {
      openedEquals(await unlockWrapping(wrapping, 'recovery', input), ROOT);
    }
    for (const input of [
      '', SENTINEL, hex.slice(2), `${hex}00`, ` ${hex}`, `${hex} `, `0x${hex}`, `${hex}\n`,
      recoveryKey.replace('-', '\t'), recoveryKey.replace('-', '\u00a0'), recoveryKey.replace('-', '‐'),
      recoveryKey.replace('-', '--'), recoveryKey.replace('-', '  '), recoveryKey.replace('-', '/'),
      `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`, null,
    ]) {
      await assert.rejects(unlockWrapping(wrapping, 'recovery', input as string), safeError);
    }
    await assert.rejects(unlockWrapping(wrapping, 'other' as 'recovery', hex), UserError);
    assert.throws(() => verifyWrapping(wrapping, Buffer.alloc(32, 77)), safeError);
    assert.throws(() => verifyWrapping(wrapping, Buffer.alloc(31)), UserError);
  });

  await t.test('canonical wrapping serialization includes exactly the declared HMAC-bound header', () => {
    const encoded = encodeWrapping(wrapping);
    assert.ok(Buffer.byteLength(encoded, 'utf8') <= MAX_WRAPPING_BYTES);
    assert.ok(encodeWrapping(parseWrapping(encoded)) === encoded);
    assert.ok(encodeWrapping(parseWrapping(Buffer.from(encoded, 'utf8'))) === encoded);
    assert.ok(!encoded.includes(recoveryKey) && !encoded.includes(PASSWORD));
    const { proof, ...header } = wrapping;
    const expected = crypto.createHmac('sha256', ROOT)
      .update('Shinano/vault/wrapping-proof/v1\0', 'utf8').update(JSON.stringify(header), 'utf8').digest();
    openedEquals(expected, Buffer.from(proof, 'base64'));
    for (const text of [
      `${encoded}\n`, ` ${encoded}`, JSON.stringify(wrapping, null, 2),
      JSON.stringify({ proof, ...header }), encoded.slice(0, -1),
      encoded.replace('"N":131072', '"N":131072.0'),
      encoded.replace('"version":1', '"version":1,"version":1'),
      encoded.replace('"scrypt"', '"\\u0073crypt"'),
    ]) {
      assert.throws(() => parseWrapping(text), UserError);
    }
  });

  await t.test('strict wrapping candidates and KDF bounds reject before any derivation', async () => {
    const before = realJobs;
    const manyParents = Array.from({ length: 9 }, (_, index) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const maximum = { ...wrapping, generation: 64, parents: manyParents.slice(0, 8) };
    assert.equal(parseWrapping(encodeWrapping(maximum)).generation, 64);
    assert.throws(() => verifyWrapping(maximum, ROOT), UserError);
    for (const value of [
      null, {}, [], { ...wrapping, version: 2 }, { ...wrapping, extra: true },
      ...[0, -1, 65, 1.5, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1'].map((generation) => ({ ...wrapping, generation })),
      ...[null, [OTHER, OTHER], [OTHER, VAULT], manyParents, ['not-a-uuid'], [wrapping.wrapperId], Array(1)]
        .map((parents) => ({ ...wrapping, parents })),
      { ...wrapping, wrapperId: VAULT.replace('-4000-', '-1000-') },
      { ...wrapping, proof: '' }, { ...wrapping, proof: `${'A'.repeat(42)}B=` },
      { ...wrapping, proof: Buffer.alloc(31).toString('base64') },
      ...[
        { name: 'pbkdf2' }, { name: 'SCRYPT' }, { N: 1024 }, { N: 262144 }, { N: '131072' },
        { r: 1 }, { p: 2 }, { maxmem: 256 * 1024 * 1024 }, { salt: Buffer.alloc(31).toString('base64') },
        { salt: `${'A'.repeat(42)}B=` },
      ].map((kdf) => ({ ...wrapping, kdf: { ...wrapping.kdf, ...kdf } })),
      { ...wrapping, passphrase: { ...wrapping.passphrase, vaultId: OTHER } },
      { ...wrapping, recovery: { ...wrapping.recovery, purpose: 'passphrase' } },
      { ...wrapping, recovery: { ...wrapping.recovery, envelopeId: wrapping.passphrase.envelopeId } },
      ...[31, 33].flatMap((size) => ['passphrase', 'recovery'].map((slot) => ({
        ...wrapping, [slot]: { ...wrapping[slot as 'passphrase' | 'recovery'], ciphertext: Buffer.alloc(size).toString('base64') },
      }))),
    ]) {
      assert.throws(() => encodeWrapping(value as WrappingEnvelope), UserError);
      assert.throws(() => parseWrapping(JSON.stringify(value)), UserError);
      assert.throws(() => verifyWrapping(value as WrappingEnvelope, ROOT), UserError);
      await assert.rejects(unlockWrapping(value as WrappingEnvelope, 'passphrase', PASSWORD), UserError);
    }
    for (const options of [
      null, {}, { generation: 65, parents: [wrapping.wrapperId], recovery: wrapping.recovery },
      { generation: 2, parents: [OTHER, VAULT], recovery: wrapping.recovery },
      { generation: 2, parents: [wrapping.wrapperId], recovery: wrapping.passphrase },
      { generation: 2, parents: [wrapping.wrapperId], recovery: wrapping.recovery, extra: true },
    ]) {
      await assert.rejects(createWrapping(VAULT, ROOT, PASSWORD, options as Parameters<typeof createWrapping>[3]), UserError);
    }
    await assert.rejects(createWrapping(VAULT, ROOT, 'short'), UserError);
    await assert.rejects(unlockWrapping(wrapping, 'passphrase', 'short'), UserError);
    assert.equal(realJobs, before);
  });

  await t.test('proof binds every outer field, KDF salt, and both complete ciphertext slots', async () => {
    for (const changed of [
      { ...wrapping, wrapperId: OTHER },
      { ...wrapping, generation: 2 },
      { ...wrapping, parents: [OTHER] },
      { ...wrapping, kdf: { ...wrapping.kdf, salt: flipBase64(wrapping.kdf.salt) } },
      { ...wrapping, proof: flipBase64(wrapping.proof) },
      ...(['passphrase', 'recovery'] as const).flatMap((slot) => [
        { ...wrapping, [slot]: { ...wrapping[slot], envelopeId: OTHER } },
        ...(['salt', 'nonce', 'ciphertext', 'tag'] as const).map((field) => ({
          ...wrapping, [slot]: { ...wrapping[slot], [field]: flipBase64(wrapping[slot][field]) },
        })),
      ]),
      {
        ...wrapping, vaultId: OTHER,
        passphrase: { ...wrapping.passphrase, vaultId: OTHER },
        recovery: { ...wrapping.recovery, vaultId: OTHER },
      },
    ]) {
      const candidate = parseWrapping(encodeWrapping(changed));
      assert.throws(() => verifyWrapping(candidate, ROOT), safeError);
      await assert.rejects(unlockWrapping(candidate, 'recovery', recoveryKey), safeError);
    }
  });

  await t.test('rewrap retains the authenticated recovery slot and root but creates a new passphrase generation', async () => {
    verifyWrapping(wrapping, ROOT);
    const changed = await createWrapping(VAULT, ROOT, NEXT_PASSWORD, {
      generation: 2, parents: [wrapping.wrapperId], recovery: wrapping.recovery,
    });
    assert.equal(changed.recoveryKey, null);
    assert.equal(changed.wrapping.generation, 2);
    assert.deepEqual(changed.wrapping.parents, [wrapping.wrapperId]);
    assert.ok(changed.wrapping.wrapperId !== wrapping.wrapperId);
    assert.ok(changed.wrapping.kdf.salt !== wrapping.kdf.salt);
    assert.ok(changed.wrapping.passphrase.envelopeId !== wrapping.passphrase.envelopeId);
    assert.ok(encodeEnvelope(changed.wrapping.recovery) === encodeEnvelope(wrapping.recovery));
    verifyWrapping(changed.wrapping, ROOT);
    openedEquals(await unlockWrapping(changed.wrapping, 'recovery', recoveryKey), ROOT);
    await Promise.all([
      unlockWrapping(changed.wrapping, 'passphrase', NEXT_PASSWORD).then((root) => openedEquals(root, ROOT)),
      assert.rejects(unlockWrapping(changed.wrapping, 'passphrase', PASSWORD), safeError),
    ]);
    verifyWrapping(wrapping, ROOT);
  });

  assert.equal(realJobs, 6, 'Only six real, unweakened scrypt derivations are needed');
  assert.equal(active, 0);
  assert.equal(peak, 1);
  assert.ok(parameters.every(Boolean));
  for (const bytes of [...passwords, ...salts, ...derivedKeys]) {
    assert.ok(bytes.every((byte) => byte === 0), 'Temporary derivation buffers have been cleared');
  }
});
