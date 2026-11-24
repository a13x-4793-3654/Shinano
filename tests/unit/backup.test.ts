import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { decryptBackup, encryptBackup, MAX_BACKUP_BYTES, type PortableBackup } from '../../src/main/backup.ts';
import { commitBackupImport, mergeBackup, recoverBackupImport } from '../../src/main/backup-import.ts';
import { StateStore } from '../../src/main/store.ts';
import { TotpStore, type SecretProtection } from '../../src/main/totp-store.ts';
import { parseBackupRequest } from '../../src/shared/backup.ts';
import type { SavedState } from '../../src/shared/model.ts';

const passphrase = 'Synthetic test passphrase only';
const publicKey = Buffer.from('12345678901234567890'); // RFC 6238 public test key.

function backup(): PortableBackup {
  const profileId = randomUUID();
  const tabId = randomUUID();
  return {
    state: {
      version: 1, profiles: [{ id: profileId, name: 'Synthetic portable profile', color: 'teal' }],
      tabs: [{ id: tabId, profileId, restoreUrl: 'https://example.test/' }],
      activeTabId: tabId, deletedProfileIds: [],
    },
    totp: [{
      profileId, key: publicKey,
      metadata: { algorithm: 'SHA256', digits: 6, period: 30, issuer: 'Synthetic', account: 'fixture' },
    }],
  };
}

function directory(context: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'shinano-backup-unit-'));
  context.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

// Unit-only, independently keyed stores; real OS re-encryption is exercised in Electron.
function protection(): SecretProtection {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

test('portable backups encrypt metadata and keys with randomized authenticated encryption', async () => {
  const original = backup();
  const first = await encryptBackup(original, passphrase);
  const second = await encryptBackup(original, passphrase);
  assert.notEqual(first, second);
  for (const sensitive of [passphrase, original.state.profiles[0]!.id, 'example.test', 'Synthetic', publicKey.toString(), publicKey.toString('base64')]) {
    assert.ok(!first.includes(sensitive));
  }
  const restored = await decryptBackup(first, passphrase);
  try {
    assert.deepEqual(restored.state, original.state);
    assert.deepEqual(restored.totp, original.totp);
  } finally {
    restored.totp.forEach((entry) => entry.key.fill(0));
  }
});

test('wrong passphrase and changes to every cryptographic envelope field fail without exposing secrets', async () => {
  const encrypted = await encryptBackup(backup(), passphrase);
  await assert.rejects(decryptBackup(encrypted, 'A different test passphrase'), /パスフレーズ/);
  for (const field of ['salt', 'iv', 'tag', 'ciphertext']) {
    const envelope = JSON.parse(encrypted);
    const bytes = Buffer.from(envelope[field], 'base64');
    bytes[0] = bytes[0]! ^ 1;
    envelope[field] = bytes.toString('base64');
    await assert.rejects(decryptBackup(JSON.stringify(envelope), passphrase), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /パスフレーズ/);
      assert.ok(!error.message.includes(passphrase) && !error.message.includes(publicKey.toString()));
      return true;
    });
  }
});

test('backup validation rejects unknown versions, extra fields, oversized files and sensitive IPC extras', async () => {
  const content = await encryptBackup(backup(), passphrase);
  for (const invalid of [
    JSON.stringify({ ...JSON.parse(content), version: 2 }),
    JSON.stringify({ ...JSON.parse(content), cost: 99999999 }),
    JSON.stringify({ ...JSON.parse(content), tag: 'AAAA' }),
    '{broken', 'x'.repeat(MAX_BACKUP_BYTES + 1),
  ]) await assert.rejects(decryptBackup(invalid, passphrase), /形式・サイズ/);
  for (const input of [null, {}, { passphrase: 'short' }, { passphrase, path: '../untrusted' }, { passphrase: 'x'.repeat(1025) }]) {
    assert.throws(() => parseBackupRequest(input));
  }
  const invalid = backup();
  invalid.state.tabs[0]!.restoreUrl = 'https://example.test/path?token=synthetic';
  await assert.rejects(encryptBackup(invalid, passphrase), /形式・サイズ/);
  const duplicate = backup();
  duplicate.totp.push(duplicate.totp[0]!);
  await assert.rejects(encryptBackup(duplicate, passphrase), /形式・サイズ/);
});

test('imports add new identities only and preserve existing state, rejecting ID and capacity conflicts', () => {
  const current = backup().state;
  const incoming = backup();
  const merged = mergeBackup(current, incoming);
  assert.equal(merged.profiles.length, 2);
  assert.equal(merged.activeTabId, current.activeTabId);
  assert.deepEqual(merged.profiles[0], current.profiles[0]);
  assert.throws(() => mergeBackup(current, { ...incoming, state: current }), /同じ ID/);
  const full: SavedState = {
    ...current, profiles: Array.from({ length: 20 }, () => ({ id: randomUUID(), name: 'Existing', color: 'blue' })),
    tabs: [], activeTabId: null,
  };
  assert.throws(() => mergeBackup(full, incoming), /上限/);
});

test('import re-encrypts keys for a different store and completes the journal on restart', async (context) => {
  const source = backup();
  const content = await encryptBackup(source, passphrase);
  const imported = await decryptBackup(content, passphrase);
  const path = directory(context);
  const stateStore = new StateStore(path);
  const current = stateStore.load();
  const vault = new TotpStore(path, protection(), 'win32');
  const merged = commitBackupImport(stateStore, vault, current, imported);
  imported.totp.forEach((entry) => entry.key.fill(0));
  assert.deepEqual(stateStore.load(), merged);
  const id = source.state.profiles[0]!.id;
  const registration = vault.registration(id);
  assert.equal(registration.status, 'registered');
  const loaded = vault.load(id, registration.registrationId!);
  assert.deepEqual(loaded.key, publicKey);
  loaded.key.fill(0);
  const encrypted = readFileSync(join(vault.directory, `${id}.json`), 'utf8');
  assert.ok(!encrypted.includes(publicKey.toString('base64')));
  assert.ok(existsSync(join(path, 'backup-import.json')));
  recoverBackupImport(stateStore, vault);
  assert.ok(!existsSync(join(path, 'backup-import.json')));
  assert.deepEqual(stateStore.load(), merged);
});

test('failed state commit rolls back imported keys without touching an existing registration', (context) => {
  const path = directory(context);
  const stateStore = new StateStore(path);
  const current = stateStore.load();
  const vault = new TotpStore(path, protection(), 'win32');
  const incoming = backup();
  const existingId = current.profiles[0]!.id;
  vault.save(existingId, incoming.totp[0]!);
  const existing = readFileSync(join(vault.directory, `${existingId}.json`));
  const save = stateStore.save.bind(stateStore);
  stateStore.save = (state) => {
    if (state.profiles.length > current.profiles.length) throw new Error('Synthetic disk failure');
    save(state);
  };
  assert.throws(() => commitBackupImport(stateStore, vault, current, incoming), /復元できません/);
  assert.deepEqual(stateStore.load(), current);
  assert.deepEqual(readFileSync(join(vault.directory, `${existingId}.json`)), existing);
  assert.equal(vault.registration(incoming.state.profiles[0]!.id).status, 'none');
  assert.ok(!existsSync(join(path, 'backup-import.json')));
});

test('startup rolls back interrupted key writes and refuses recovery after an unrelated state change', (context) => {
  const path = directory(context);
  const store = new StateStore(path);
  const current = store.load();
  const incoming = backup();
  const vault = new TotpStore(path, protection(), 'win32');
  const profileId = incoming.state.profiles[0]!.id;
  const hash = (state: SavedState) => createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const journal = {
    version: 1, profileIds: [profileId], baseHash: hash(current),
    targetHash: hash(mergeBackup(current, incoming)),
  };
  writeFileSync(join(path, 'backup-import.json'), JSON.stringify(journal));
  vault.save(profileId, incoming.totp[0]!);
  recoverBackupImport(store, vault);
  assert.equal(vault.registration(profileId).status, 'none');
  writeFileSync(join(path, 'backup-import.json'), JSON.stringify(journal));
  vault.save(profileId, incoming.totp[0]!);
  store.save({ ...current, profiles: [{ ...current.profiles[0]!, name: 'Unrelated change' }] });
  assert.throws(() => recoverBackupImport(store, vault), /未完了/);
  assert.equal(vault.registration(profileId).status, 'registered');
  assert.ok(existsSync(join(path, 'backup-import.json')));
});
