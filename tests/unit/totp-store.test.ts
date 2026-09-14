import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs, { type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { assertExternalTotpDirectory, MAX_TOTP_FILE_BYTES, requireSecretProtection, TotpStore, type SecretProtection } from '../../src/main/totp-store.ts';
import { partitionDirectory, StateStore } from '../../src/main/store.ts';
import type { ParsedTotp } from '../../src/main/totp.ts';

const publicKey = Buffer.from('12345678901234567890'); // RFC 6238 public test key, not a credential.
const parsed: ParsedTotp = {
  key: publicKey,
  metadata: { algorithm: 'SHA1', digits: 6, period: 30, issuer: 'Synthetic fixture', account: 'not-an-account' },
};

function directory(context: TestContext): string {
  const path = fs.mkdtempSync(join(tmpdir(), 'shinano-totp-store-'));
  context.after(() => fs.rmSync(path, { recursive: true, force: true }));
  return path;
}

// This unit-only cipher tests persistence, not OS protection; Electron E2E uses real safeStorage.
function fixtureProtection(): SecretProtection {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

test('encrypted per-profile files survive store recreation without plaintext or metadata leakage', (context) => {
  const path = directory(context);
  const protection = fixtureProtection();
  const vault = new TotpStore(path, protection);
  const a = randomUUID();
  const b = randomUUID();
  const aRegistration = vault.save(a, parsed);
  const bRegistration = vault.save(b, { ...parsed, key: Buffer.from('Synthetic unrelated B key') });
  const file = join(vault.directory, `${a}.json`);
  const content = fs.readFileSync(file, 'utf8');
  const envelope = JSON.parse(content);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'profileId', 'registrationId', 'version']);
  for (const sensitive of [publicKey.toString(), publicKey.toString('base64'), 'Synthetic fixture', 'not-an-account', 'otpauth://']) {
    assert.equal(content.includes(sensitive), false);
    assert.equal(JSON.stringify(vault.registration(a)).includes(sensitive), false);
  }
  assert.deepEqual(fs.readdirSync(vault.directory).sort(), [`${a}.json`, `${b}.json`].sort());
  const restarted = new TotpStore(path, protection);
  assert.deepEqual(restarted.load(a, aRegistration).key, publicKey);
  assert.equal(restarted.load(b, bRegistration).key.toString(), 'Synthetic unrelated B key');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(vault.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('encryption unavailable or failing never creates or replaces a registration', (context) => {
  const protection = fixtureProtection();
  const vault = new TotpStore(directory(context), protection);
  const profileId = randomUUID();
  const registrationId = vault.save(profileId, parsed);
  const file = join(vault.directory, `${profileId}.json`);
  const original = fs.readFileSync(file);
  protection.isEncryptionAvailable = () => false;
  assert.throws(() => vault.save(profileId, parsed), /OS/);
  assert.throws(() => vault.load(profileId, registrationId), /OS/);
  const missingId = randomUUID();
  assert.throws(() => vault.save(missingId, parsed));
  assert.equal(fs.existsSync(join(vault.directory, `${missingId}.json`)), false);
  protection.isEncryptionAvailable = () => true;
  protection.encryptString = () => { throw new Error(`Synthetic sensitive ${publicKey.toString()}`); };
  assert.throws(() => vault.save(profileId, parsed), (error: unknown) =>
    error instanceof Error && error.message.includes('暗号化できません') && !error.message.includes(publicKey.toString()));
  assert.deepEqual(fs.readFileSync(file), original);
});

test('Linux requires an identified real OS key provider even when availability says true', () => {
  const protection = fixtureProtection();
  for (const backend of ['basic_text', 'unknown', 'new-unverified-backend', '']) {
    protection.getSelectedStorageBackend = () => backend;
    assert.throws(() => requireSecretProtection(protection, 'linux'), /Linux/);
  }
  delete protection.getSelectedStorageBackend;
  assert.throws(() => requireSecretProtection(protection, 'linux'), /Linux/);
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    protection.getSelectedStorageBackend = () => backend;
    assert.doesNotThrow(() => requireSecretProtection(protection, 'linux'));
  }
  protection.isEncryptionAvailable = () => { throw new Error('Synthetic locked key provider'); };
  assert.throws(() => requireSecretProtection(protection, 'darwin'), /OS/);
});

test('corrupt and unsupported envelopes are retained and cannot be silently replaced', (context) => {
  const vault = new TotpStore(directory(context), fixtureProtection());
  const profileId = randomUUID();
  const file = join(vault.directory, `${profileId}.json`);
  const registrationId = vault.save(profileId, parsed);
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const malformed of [
    '{synthetic broken',
    JSON.stringify({ ...original, version: 2 }),
    JSON.stringify({ ...original, ciphertext: 'not valid base64!' }),
    JSON.stringify({ ...original, extra: 'unsupported' }),
    'x'.repeat(MAX_TOTP_FILE_BYTES + 1),
  ]) {
    fs.writeFileSync(file, malformed);
    assert.equal(vault.registration(profileId, true).status, 'unreadable');
    assert.throws(() => vault.load(profileId, registrationId));
    assert.throws(() => vault.save(profileId, parsed));
    assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  }
  vault.remove(profileId);
  assert.equal(fs.existsSync(file), false);
  assert.equal(vault.registration(profileId).status, 'none');
});

test('encrypted identity and stored parameters cannot be relabeled or silently defaulted', (context) => {
  const protection = fixtureProtection();
  const vault = new TotpStore(directory(context), protection);
  const a = randomUUID();
  const b = randomUUID();
  const registrationId = vault.save(a, parsed);
  const original = JSON.parse(fs.readFileSync(join(vault.directory, `${a}.json`), 'utf8'));
  fs.writeFileSync(join(vault.directory, `${b}.json`), JSON.stringify({ ...original, profileId: b }));
  assert.throws(() => vault.load(b, registrationId), /保存データ/);
  const payload = JSON.parse(protection.decryptString(Buffer.from(original.ciphertext, 'base64')));
  for (const change of [{ digits: 8 }, { period: 60 }, { algorithm: 'MD5' }, { registrationId: randomUUID() }]) {
    fs.writeFileSync(join(vault.directory, `${a}.json`), JSON.stringify({
      ...original, ciphertext: protection.encryptString(JSON.stringify({ ...payload, ...change })).toString('base64'),
    }));
    assert.throws(() => vault.load(a, registrationId), /保存データ/);
  }
});

test('replacement retains undecryptable or unsupported encrypted payloads until explicit removal', (context) => {
  const protection = fixtureProtection();
  const vault = new TotpStore(directory(context), protection);
  const profileId = randomUUID();
  const registrationId = vault.save(profileId, parsed);
  const file = join(vault.directory, `${profileId}.json`);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const payload = JSON.parse(protection.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
  const badVersion = protection.encryptString(JSON.stringify({ ...payload, version: 2 })).toString('base64');
  const damaged = Buffer.from(envelope.ciphertext, 'base64');
  damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
  for (const ciphertext of [badVersion, damaged.toString('base64')]) {
    const content = JSON.stringify({ ...envelope, ciphertext });
    fs.writeFileSync(file, content);
    assert.throws(() => vault.load(profileId, registrationId));
    assert.throws(() => vault.save(profileId, parsed));
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  protection.isEncryptionAvailable = () => false;
  vault.remove(profileId);
  assert.equal(fs.existsSync(file), false);
});

test('atomic replacement failures preserve old ciphertext and remove only their temporary file', (context) => {
  const vault = new TotpStore(directory(context), fixtureProtection());
  const profileId = randomUUID();
  vault.save(profileId, parsed);
  const file = join(vault.directory, `${profileId}.json`);
  const original = fs.readFileSync(file);
  const unrelated = join(vault.directory, 'unrelated.tmp');
  fs.writeFileSync(unrelated, 'Synthetic unrelated fixture');
  const rename = context.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic rename failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => vault.save(profileId, parsed), /以前の登録は変更していません/);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(fs.readdirSync(vault.directory).sort(), [`${profileId}.json`, 'unrelated.tmp'].sort());
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
});

test('missing profile metadata and orphan ciphertext are not reset or reassigned', (context) => {
  const path = directory(context);
  const vault = new TotpStore(path, fixtureProtection());
  const profileId = randomUUID();
  vault.save(profileId, parsed);
  const store = new StateStore(path);
  assert.throws(() => store.load(vault.hasData()), /state.json/);
  assert.equal(fs.existsSync(store.file), false);
  vault.reconcileProfiles([], []);
  assert.match(vault.error ?? '', /自動削除・再割り当てはしていません/);
  assert.equal(fs.existsSync(join(vault.directory, `${profileId}.json`)), true);
});

test('deletion intent survives a failure and removes only its ciphertext without decrypting', (context) => {
  const path = directory(context);
  const protection = fixtureProtection();
  const vault = new TotpStore(path, protection);
  const store = new StateStore(path);
  const state = store.load();
  const keptId = state.profiles[0]!.id;
  const deletedId = randomUUID();
  const keptRegistration = vault.save(keptId, parsed);
  vault.save(deletedId, parsed);
  state.deletedProfileIds = [deletedId];
  store.save(state);
  const sessionRoot = join(path, 'sessions');
  const deletedPartition = partitionDirectory(sessionRoot, deletedId);
  fs.mkdirSync(deletedPartition, { recursive: true });
  assert.throws(() => store.finishDeletions(state, sessionRoot, () => { throw new Error('Synthetic delete failure'); }));
  assert.deepEqual(store.load().deletedProfileIds, [deletedId]);
  assert.equal(fs.existsSync(deletedPartition), true);
  protection.isEncryptionAvailable = () => false;
  const result = store.finishDeletions(store.load(), sessionRoot, (profileId) => vault.remove(profileId));
  assert.deepEqual(result.deletedProfileIds, []);
  assert.equal(fs.existsSync(deletedPartition), false);
  assert.equal(fs.existsSync(join(vault.directory, `${deletedId}.json`)), false);
  assert.equal(fs.existsSync(join(vault.directory, `${keptId}.json`)), true);
  vault.remove(deletedId);
  protection.isEncryptionAvailable = () => true;
  assert.deepEqual(vault.load(keptId, keptRegistration).key, publicKey);
});

test('recovery removes abandoned target staging ciphertext before completing deletion intent', (context) => {
  const path = directory(context);
  const protection = fixtureProtection();
  const vault = new TotpStore(path, protection);
  const store = new StateStore(path);
  const state = store.load();
  const keptId = state.profiles[0]!.id;
  const deletedId = randomUUID();
  const keptRegistration = vault.save(keptId, parsed);
  vault.save(deletedId, parsed);
  const rename = context.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic interrupted rename'); });
  const unlink = context.mock.method(fs, 'unlinkSync', () => { throw new Error('Synthetic interrupted cleanup'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => vault.save(deletedId, parsed));
  } finally {
    rename.mock.restore();
    unlink.mock.restore();
    syncBuiltinESMExports();
  }
  const staging = fs.readdirSync(vault.directory).find((name) => name.startsWith(`${deletedId}.json.`) && name.endsWith('.tmp'));
  assert.ok(staging);
  assert.equal(vault.registration(deletedId, true).status, 'unreadable');
  const unrelated = join(vault.directory, 'unrelated.tmp');
  const keptFile = join(vault.directory, `${keptId}.json`);
  const keptStaging = join(vault.directory, `${keptId}.json.${randomUUID()}.tmp`);
  fs.writeFileSync(unrelated, 'Synthetic unrelated file');
  fs.copyFileSync(keptFile, keptStaging);
  const keptCiphertext = fs.readFileSync(keptFile);
  state.deletedProfileIds = [deletedId];
  store.save(state);
  protection.isEncryptionAvailable = () => false;
  const originalUnlink = fs.unlinkSync;
  const failure = context.mock.method(fs, 'unlinkSync', (file: PathLike) => {
    if (file === join(vault.directory, staging)) throw new Error('Synthetic target staging lock');
    originalUnlink(file);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.finishDeletions(state, join(path, 'sessions'), (profileId) => vault.remove(profileId)));
    assert.deepEqual(store.load().deletedProfileIds, [deletedId]);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
  const finished = store.finishDeletions(store.load(), join(path, 'sessions'), (profileId) => vault.remove(profileId));
  assert.deepEqual(finished.deletedProfileIds, []);
  assert.equal(fs.existsSync(join(vault.directory, staging)), false);
  assert.equal(fs.existsSync(join(vault.directory, `${deletedId}.json`)), false);
  assert.deepEqual(fs.readFileSync(keptFile), keptCiphertext);
  assert.deepEqual(fs.readFileSync(keptStaging), keptCiphertext);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'Synthetic unrelated file');
  fs.unlinkSync(keptStaging);
  protection.isEncryptionAvailable = () => true;
  assert.deepEqual(vault.load(keptId, keptRegistration).key, publicKey);
});

test('the data directory guard resolves aliases before excluding the source and application', (context) => {
  const path = directory(context);
  const application = join(path, 'app');
  const outside = join(path, 'outside');
  const inside = join(application, 'data');
  const alias = join(path, 'alias');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(application, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.doesNotThrow(() => assertExternalTotpDirectory(outside, application));
  assert.throws(() => assertExternalTotpDirectory(application, application), /リポジトリの外/);
  assert.throws(() => assertExternalTotpDirectory(inside, application), /リポジトリの外/);
  assert.throws(() => assertExternalTotpDirectory(join(alias, 'data'), application), /リポジトリの外/);
});

test('UUID traversal and symlinks never access another file', (context) => {
  const path = directory(context);
  const vault = new TotpStore(path, fixtureProtection());
  const profileId = randomUUID();
  const outside = join(path, 'unrelated-fixture');
  fs.writeFileSync(outside, 'Synthetic unrelated fixture');
  fs.symlinkSync(outside, join(vault.directory, `${profileId}.json`));
  assert.equal(vault.registration(profileId).status, 'unreadable');
  assert.throws(() => vault.save(profileId, parsed));
  assert.throws(() => vault.remove(profileId));
  assert.throws(() => vault.remove('../unrelated-fixture'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Synthetic unrelated fixture');
});
