import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Panel, Profile } from '../../src/shared/model.ts';
import { HISTORY_RETENTION_MS, MAX_BOOKMARKS, MAX_VISITS, type LibraryKind } from '../../src/shared/library.ts';
import { parseLibraryCommand, historyLocation, sensitiveHistoryUrl } from '../../src/shared/library-validation.ts';
import { parseSyncCommand } from '../../src/shared/sync-validation.ts';
import { LibraryStore } from '../../src/main/library-store.ts';
import { DataController, type DataHost } from '../../src/main/sync-controller.ts';
import { TotpStore, type SecretProtection } from '../../src/main/totp-store.ts';
import { VaultFolder } from '../../src/main/vault-folder.ts';
import { totpAt } from '../../src/main/totp.ts';
import { parseOperation, VaultModel, type PortableTotp, type VaultOperation } from '../../src/main/vault-records.ts';

const passphrase = 'Public synthetic fixture master passphrase only';
const publicKey = Buffer.from('12345678901234567890'); // RFC 6238 public vector.
const allowed = () => true;

function protection(): SecretProtection & { available: boolean } {
  const key = randomBytes(32);
  return {
    available: true,
    isEncryptionAvailable() { return this.available; },
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
}

class Installation {
  readonly library: LibraryStore;
  readonly totp: TotpStore;
  readonly data: DataController;
  panel: Panel = 'sync';
  confirm = true;
  profiles: Profile[];
  opened: { profileId: string; url: string }[] = [];
  notices: string[] = [];
  private queued: Promise<void> = Promise.resolve();
  readonly userData: string;
  readonly folder: string;
  readonly os: ReturnType<typeof protection>;
  readonly clock: { now: number };

  constructor(
    userData: string,
    folder: string,
    os: ReturnType<typeof protection>,
    clock: { now: number },
    profiles?: Profile[],
  ) {
    this.userData = userData;
    this.folder = folder;
    this.os = os;
    this.clock = clock;
    this.profiles = profiles ?? [{ id: randomUUID(), name: 'Synthetic profile', color: 'teal' }];
    this.library = new LibraryStore(userData, os, 'darwin');
    this.totp = new TotpStore(userData, os, 'darwin');
    this.data = new DataController(this.library, this.totp, [userData], () => clock.now);
  }

  async start(): Promise<void> {
    await this.data.initialize();
    const host: DataHost = {
      profiles: () => this.profiles,
      deletedProfileIds: () => [],
      panel: () => this.panel,
      applyProfile: (profile) => {
        this.profiles = [...this.profiles.filter((entry) => entry.id !== profile.id), profile];
      },
      currentBookmark: () => ({ profileId: this.profiles[0]!.id, title: 'Synthetic current title', url: 'https://example.invalid/current?approved=bookmark#section' }),
      open: (profileId, url) => { this.opened.push({ profileId, url }); },
      confirm: async () => this.confirm,
      chooseDirectory: async () => this.folder,
      enqueue: (operation) => this.run(operation),
      changed: () => {},
      notify: (message) => { this.notices.push(message); },
    };
    this.data.attach(host);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queued.then(operation);
    this.queued = result.then(() => undefined, () => undefined);
    return result;
  }

  async create(): Promise<{ vaultId: string; recovery: string }> {
    this.panel = 'sync';
    const choice = await this.data.chooseFolder(allowed);
    assert.ok(choice);
    const setup = await this.data.create({ selectionId: choice.selectionId, passphrase, confirmation: passphrase, remember: true }, allowed);
    await this.data.syncCommand({ type: 'finish-create', setupId: setup.setupId, recoveryAcknowledged: true }, allowed);
    const status = this.data.status(allowed);
    assert.equal(status.phase, 'ready');
    assert.ok(status.vaultId);
    return { vaultId: status.vaultId, recovery: setup.recoveryKey };
  }

  async join(vaultId: string, input = passphrase, method: 'passphrase' | 'recovery' = 'passphrase'): Promise<void> {
    this.panel = 'sync';
    const choice = await this.data.chooseFolder(allowed);
    assert.ok(choice);
    await this.data.join({ selectionId: choice.selectionId, vaultId, method, input, remember: true }, allowed);
  }

  async link(profileId: string, bookmarks = true, history = true): Promise<void> {
    this.panel = 'sync';
    await this.data.syncCommand({ type: 'profile:link', profileId, bookmarks, history }, allowed);
  }

  async list(profileId: string, kind: LibraryKind) {
    this.panel = kind;
    return (await this.data.query({ profileId, kind, query: '', cursor: null }, allowed)).entries;
  }

  async bookmark(profileId: string, title = 'Synthetic bookmark', recordId: string | null = null, parents: string[] = []) {
    this.panel = 'bookmarks';
    await this.data.libraryCommand({ type: 'bookmark:save', profileId, recordId, parents, title, url: 'https://example.invalid/report?explicit=bookmark#part' }, allowed);
    return (await this.list(profileId, 'bookmarks')).find((entry) => recordId ? entry.id === recordId : entry.title === title)!;
  }

  async refresh(): Promise<void> { this.panel = 'sync'; await this.data.refresh(allowed); }
  dispose(): void { this.data.dispose(); }
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'shinano-sync-fixture-'));
  const clock = { now: 2_000_000_000_000 };
  const instances: Installation[] = [];
  context.after(async () => {
    for (const instance of instances) instance.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, clock,
    async installation(name: string, os = protection(), profiles?: Profile[]) {
      const userData = join(root, `${name}-data`);
      const folder = join(root, `${name}-replica`);
      await mkdir(userData, { recursive: true });
      await mkdir(folder, { recursive: true });
      const instance = new Installation(userData, folder, os, clock, profiles);
      instances.push(instance);
      await instance.start();
      return instance;
    },
  };
}

async function deliver(from: Installation, to: Installation, vaultId: string, duplicate = false): Promise<void> {
  const source = join(from.folder, 'Shinano Sync', vaultId);
  const destination = join(to.folder, 'Shinano Sync', vaultId);
  await mkdir(destination, { recursive: true });
  for (const name of (await readdir(source)).filter((name) => name.endsWith('.svop') || name.endsWith('.svkey')).sort().reverse()) {
    await copyFile(join(source, name), join(destination, name));
    if (duplicate && name.endsWith('.svop')) {
      await copyFile(join(source, name), join(destination, name.replace('.svop', ' (Synthetic PC conflicted copy).svop')));
    }
  }
}

async function durableText(directory: string): Promise<string> {
  let text = '';
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    text += item.name;
    text += item.isDirectory() ? await durableText(path) : (await readFile(path)).toString('utf8');
  }
  return text;
}

test('new library/sync IPC is exact and history privacy never expands SavedTab behavior', () => {
  const profileId = randomUUID();
  for (const url of ['otpauth://totp/X?secret=PUBLIC', 'file:///tmp/public', 'javascript:alert(1)', 'https://user:pass@example.invalid/']) {
    assert.throws(() => parseLibraryCommand({ type: 'bookmark:save', profileId, recordId: null, parents: [], title: 'Fixture', url }));
  }
  assert.equal(historyLocation('https://example.invalid/path/value?q=private#private', 'detailed'), 'https://example.invalid/path/value');
  assert.equal(historyLocation('https://example.invalid/path/value?q=private#private', 'origins'), 'https://example.invalid/');
  for (const url of ['https://login.microsoftonline.com/example/', 'https://example.invalid/oauth/callback', 'https://example.invalid/path?code=synthetic', 'https://example.invalid/path#access_token=synthetic']) {
    assert.equal(sensitiveHistoryUrl(url), true);
    assert.equal(historyLocation(url, 'detailed'), null);
  }
  assert.throws(() => parseSyncCommand({ type: 'refresh', arbitraryPath: '/not-authorized' }));
  assert.throws(() => parseSyncCommand({ type: 'totp:share', profileId, registrationId: randomUUID(), secret: 'not-accepted' }));
});

test('local library is OS-protected, keeps full explicit bookmarks and detailed history, and survives restart', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const profileId = a.profiles[0]!.id;
  const bookmark = await a.bookmark(profileId, '<img src=x onerror=synthetic()>');
  await a.data.recordVisit(profileId, 'https://example.invalid/secret-path?neverPersistThisQuery#neverPersistThisFragment', 'Synthetic private page title', f.clock.now, 'detailed');
  const visits = await a.list(profileId, 'history');
  assert.equal(visits.length, 1);
  assert.equal(visits[0]!.title, 'Synthetic private page title');
  assert.equal(visits[0]!.url, 'https://example.invalid/secret-path');
  const text = await durableText(a.library.directory);
  for (const sensitive of ['neverPersistThisQuery', 'neverPersistThisFragment', '/secret-path', 'Synthetic private page title', bookmark.title, bookmark.url]) assert.equal(text.includes(sensitive), false);
  a.dispose();
  const restarted = await f.installation('a', a.os, a.profiles);
  assert.equal((await restarted.list(profileId, 'history')).length, 1);
  assert.equal((await restarted.list(profileId, 'bookmarks'))[0]?.id, bookmark.id);
  await restarted.data.libraryCommand({ type: 'entry:open', kind: 'bookmarks', profileId, recordId: bookmark.id, revision: bookmark.revision }, allowed);
  assert.deepEqual(restarted.opened, [{ profileId, url: bookmark.url }]);
  await assert.rejects(restarted.data.libraryCommand({ type: 'entry:open', kind: 'bookmarks', profileId: randomUUID(), recordId: bookmark.id, revision: bookmark.revision }, allowed));
});

test('history has exact ongoing 90-day expiry, local clear fences and opt-out without storing sensitive callbacks', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const profileId = a.profiles[0]!.id;
  const boundary = f.clock.now - HISTORY_RETENTION_MS;
  await a.data.recordVisit(profileId, 'https://example.invalid/expired', 'Expired fixture', boundary, 'detailed');
  await a.data.recordVisit(profileId, 'https://example.invalid/remaining', 'Boundary fixture', boundary + 1, 'detailed');
  await a.data.recordVisit(profileId, 'https://example.invalid/callback?code=not-a-code', 'Not history', f.clock.now, 'detailed');
  assert.equal((await a.list(profileId, 'history')).length, 1);
  f.clock.now++;
  assert.equal((await a.list(profileId, 'history')).length, 0);
  await a.library.prune(f.clock.now);
  const floor = a.library.settings.retentionFloor;
  f.clock.now--;
  assert.equal((await a.list(profileId, 'history')).length, 0);
  assert.equal(a.library.settings.retentionFloor, floor);
  await a.data.libraryCommand({ type: 'history:mode', profileId, mode: 'off' }, allowed);
  await a.data.recordVisit(profileId, 'https://example.invalid/disabled', 'Disabled fixture', f.clock.now, 'detailed');
  assert.equal((await a.list(profileId, 'history')).length, 0);
  await a.data.libraryCommand({ type: 'history:mode', profileId, mode: 'origins' }, allowed);
  await a.data.recordVisit(profileId, 'https://example.invalid/path?q=x', 'Must not retain title', f.clock.now, 'origins');
  assert.equal((await a.list(profileId, 'history'))[0]?.title, 'example.invalid');
  await a.data.libraryCommand({ type: 'history:clear', profileId, scope: 'local' }, allowed);
  assert.equal((await a.list(profileId, 'history')).length, 0);
  a.dispose();
  const restarted = await f.installation('a', a.os, a.profiles);
  assert.equal((await restarted.list(profileId, 'history')).length, 0);
});

test('two isolated installations join without OS ciphertext copying and import TOTP only after explicit authorization', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  const registrationId = a.totp.save(profileId, { key: publicKey, metadata: { algorithm: 'SHA1', digits: 6, period: 30, issuer: 'Synthetic issuer', account: 'Synthetic account' } });
  const original = await readFile(join(a.totp.directory, `${profileId}.json`));
  const { vaultId, recovery } = await a.create();
  assert.equal((await readdir(join(a.folder, 'Shinano Sync', vaultId))).filter((name) => name.endsWith('.svop')).length, 0);
  await a.bookmark(profileId);
  await a.data.recordVisit(profileId, 'https://example.invalid/report?never-sync-query', 'Synthetic history to share', f.clock.now, 'detailed');
  await a.link(profileId);
  assert.equal(a.data.status(allowed).profiles.find((entry) => entry.id === profileId)?.sharedRegistrationId, null);
  await a.data.syncCommand({ type: 'totp:share', profileId, registrationId }, allowed);
  assert.deepEqual(await readFile(join(a.totp.directory, `${profileId}.json`)), original);
  await deliver(a, b, vaultId, true);
  await b.join(vaultId, recovery, 'recovery');
  assert.equal(b.profiles.some((entry) => entry.id === profileId), false);
  assert.equal(b.totp.registration(profileId).status, 'none');
  await b.link(profileId);
  assert.equal(b.totp.registration(profileId).status, 'none');
  const shared = b.data.status(allowed).profiles.find((entry) => entry.id === profileId)!;
  assert.equal(shared.sharedRegistrationId, registrationId);
  await b.data.syncCommand({ type: 'totp:accept', profileId, revision: shared.totpVersions[0]!.revision, expectedRegistrationId: null }, allowed);
  const aStored = a.totp.load(profileId, registrationId);
  const bStored = b.totp.load(profileId, registrationId);
  try {
    assert.equal(totpAt(aStored.key, aStored.metadata.algorithm, f.clock.now).code, totpAt(bStored.key, bStored.metadata.algorithm, f.clock.now).code);
    assert.notDeepEqual(await readFile(join(b.totp.directory, `${profileId}.json`)), original);
    assert.throws(() => b.os.decryptString(Buffer.from(JSON.parse(original.toString()).ciphertext, 'base64')));
  } finally { aStored.key.fill(0); bStored.key.fill(0); }
  assert.equal((await b.list(profileId, 'bookmarks')).length, 1);
  assert.equal((await b.list(profileId, 'history'))[0]?.url, 'https://example.invalid/report');
  const vaultText = await durableText(join(a.folder, 'Shinano Sync', vaultId));
  for (const sensitive of [passphrase, recovery, publicKey.toString(), publicKey.toString('base64'), 'Synthetic issuer', 'Synthetic profile', 'example.invalid', 'never-sync-query']) assert.equal(vaultText.includes(sensitive), false);
  b.dispose();
  const restarted = await f.installation('b', b.os, b.profiles);
  assert.throws(() => restarted.data.checkTotp(profileId), /解除/);
  await restarted.data.unlock({ method: 'device', input: '' }, allowed);
  restarted.data.checkTotp(profileId);
  assert.equal(restarted.totp.load(profileId, registrationId).registrationId, registrationId);
});

test('offline concurrent bookmark edits preserve both heads; resolution and shared tombstones converge after reordered duplicate delivery', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  const { vaultId } = await a.create();
  const original = await a.bookmark(profileId);
  await a.link(profileId);
  await deliver(a, b, vaultId);
  await b.join(vaultId);
  await b.link(profileId);
  const aBase = (await a.list(profileId, 'bookmarks'))[0]!;
  const bBase = (await b.list(profileId, 'bookmarks'))[0]!;
  await a.bookmark(profileId, 'Synthetic A edit', original.id, aBase.versions.map((entry) => entry.revision));
  await b.bookmark(profileId, 'Synthetic B edit', original.id, bBase.versions.map((entry) => entry.revision));
  await a.refresh();
  await b.refresh();
  await deliver(a, b, vaultId, true);
  await deliver(b, a, vaultId, true);
  await a.refresh();
  await b.refresh();
  const aConflict = (await a.list(profileId, 'bookmarks'))[0]!;
  const bConflict = (await b.list(profileId, 'bookmarks'))[0]!;
  assert.equal(aConflict.versions.length, 2);
  assert.deepEqual(aConflict.versions, bConflict.versions);
  await a.bookmark(profileId, 'Synthetic resolved edit', original.id, aConflict.versions.map((entry) => entry.revision));
  await a.refresh();
  await deliver(a, b, vaultId);
  await b.refresh();
  assert.equal((await b.list(profileId, 'bookmarks'))[0]?.title, 'Synthetic resolved edit');
  assert.equal((await b.list(profileId, 'bookmarks'))[0]?.versions.length, 1);
  a.panel = 'bookmarks';
  await a.data.libraryCommand({ type: 'entry:remove', kind: 'bookmarks', profileId, recordId: original.id, scope: 'vault' }, allowed);
  await a.refresh();
  await deliver(a, b, vaultId, true);
  await b.refresh();
  assert.equal((await a.list(profileId, 'bookmarks')).length, 0);
  assert.equal((await b.list(profileId, 'bookmarks')).length, 0);
  await deliver(b, a, vaultId, true);
  await a.refresh();
  assert.equal((await a.list(profileId, 'bookmarks')).length, 0);
});

test('local profile removal and local TOTP removal work with OS protection locked and cannot auto-resurrect from the vault', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  const registrationId = a.totp.save(profileId, { key: publicKey, metadata: { algorithm: 'SHA256', digits: 6, period: 30, issuer: null, account: null } });
  const { vaultId } = await a.create();
  await a.link(profileId);
  await a.data.syncCommand({ type: 'totp:share', profileId, registrationId }, allowed);
  await deliver(a, b, vaultId);
  await b.join(vaultId);
  await b.link(profileId);
  let status = b.data.status(allowed).profiles.find((entry) => entry.id === profileId)!;
  await b.data.syncCommand({ type: 'totp:accept', profileId, revision: status.totpVersions[0]!.revision, expectedRegistrationId: null }, allowed);
  b.os.available = false;
  await b.data.localTotpChanged(profileId);
  b.totp.remove(profileId);
  b.os.available = true;
  await b.refresh();
  assert.equal(b.totp.registration(profileId, true).status, 'none');
  b.os.available = false;
  b.data.suppressProfile(profileId);
  b.totp.remove(profileId);
  b.data.removeLocalProfile(profileId);
  b.profiles = b.profiles.filter((profile) => profile.id !== profileId);
  b.os.available = true;
  b.dispose();
  const restarted = await f.installation('b', b.os, b.profiles);
  await restarted.data.unlock({ method: 'device', input: '' }, allowed);
  status = restarted.data.status(allowed).profiles.find((entry) => entry.id === profileId)!;
  assert.equal(status.suppressed, true);
  assert.equal(status.installed, false);
  await assert.rejects(restarted.link(profileId), /復元/);
  assert.equal(a.totp.load(profileId, registrationId).registrationId, registrationId);
});

test('wrong passphrases, tampered data, locked local protection and untrusted callers preserve old data', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  const { vaultId } = await a.create();
  await a.bookmark(profileId);
  await a.link(profileId);
  await deliver(a, b, vaultId);
  const old = await durableText(join(b.folder, 'Shinano Sync', vaultId));
  await assert.rejects(b.join(vaultId, 'Wrong synthetic public fixture password'));
  assert.equal(b.data.status(allowed).vaultId, null);
  assert.equal(await durableText(join(b.folder, 'Shinano Sync', vaultId)), old);
  await b.join(vaultId);
  await b.link(profileId);
  const files = await readdir(join(b.folder, 'Shinano Sync', vaultId));
  const file = join(b.folder, 'Shinano Sync', vaultId, files.find((name) => name.endsWith('.svop'))!);
  await writeFile(file, '{"synthetic":"truncated');
  await assert.rejects(b.refresh());
  assert.equal(await readFile(file, 'utf8'), '{"synthetic":"truncated');
  assert.equal((await b.list(profileId, 'bookmarks')).length, 1);
  await assert.rejects(b.data.libraryCommand({ type: 'history:mode', profileId, mode: 'off' }, () => false));
  b.os.available = false;
  await assert.rejects(b.bookmark(profileId, 'Must not save'));
  b.os.available = true;
  assert.equal((await b.list(profileId, 'bookmarks')).length, 1);
});

test('TOTP import preserves registration ID and previous encrypted file until validated migration commit', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const profileId = a.profiles[0]!.id;
  const originalId = a.totp.save(profileId, { key: publicKey, metadata: { algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } });
  const original = await readFile(join(a.totp.directory, `${profileId}.json`));
  const incomingId = randomUUID();
  const incoming = { registrationId: incomingId, key: Buffer.from('Synthetic other public key'), metadata: { algorithm: 'SHA256' as const, digits: 6 as const, period: 30 as const, issuer: 'Synthetic', account: null } };
  a.totp.importRegistration(profileId, incoming, originalId);
  assert.deepEqual(await readFile(join(a.totp.directory, `${profileId}.json.${incomingId}.bak`)), original);
  assert.equal(a.totp.load(profileId, incomingId).registrationId, incomingId);
  a.totp.importRegistration(profileId, incoming, originalId);
  assert.throws(() => a.totp.importRegistration(profileId, { ...incoming, key: Buffer.from('Different public value') }, incomingId), /異なります/);
  a.totp.finishImport(profileId, incomingId);
  assert.equal((await readdir(a.totp.directory)).some((name) => name.endsWith('.bak')), false);
});

test('local encrypted migration intents and hide records authenticate their profile directory', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const profileId = a.profiles[0]!.id;
  const targetId = randomUUID();
  const space = randomUUID();
  const source = join(a.library.directory, 'profiles', profileId);
  const target = join(a.library.directory, 'profiles', targetId);
  await mkdir(target, { recursive: true });
  await a.library.saveIntent(profileId, {
    version: 1, profileId, vaultId: space, cancelled: false, expectedRegistrationId: null,
    next: { registrationId: randomUUID(), key: publicKey.toString('base64'), algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null },
  });
  await a.library.hide(profileId, space, 'bookmarks', randomUUID(), f.clock.now);
  const hiddenName = (await readdir(source)).find((name) => name.startsWith('hide-'))!;
  for (const name of ['totp-intent.json', hiddenName]) {
    const original = await readFile(join(source, name));
    await copyFile(join(source, name), join(target, name));
    const reopened = new LibraryStore(a.userData, a.os, 'darwin');
    try { await assert.rejects(reopened.initialize(), /暗号化ライブラリー/); }
    finally { reopened.dispose(); }
    assert.deepEqual(await readFile(join(target, name)), original);
    await rm(join(target, name));
  }
});

test('TOTP cancellation authenticates the original backup, preserves damaged copies, and reverses only the pending registration', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const profileId = a.profiles[0]!.id;
  const originalId = a.totp.save(profileId, { key: publicKey, metadata: { algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } });
  const file = join(a.totp.directory, `${profileId}.json`);
  const original = await readFile(file);
  const incomingId = randomUUID();
  const incoming = { registrationId: incomingId, key: Buffer.from('Synthetic pending fixture key'), metadata: { algorithm: 'SHA256' as const, digits: 6 as const, period: 30 as const, issuer: null, account: null } };
  a.totp.importRegistration(profileId, incoming, originalId);
  const replacement = await readFile(file);
  const backup = join(a.totp.directory, `${profileId}.json.${incomingId}.bak`);
  assert.throws(() => a.totp.assertCanSave(profileId), /保存前コピー/);
  assert.throws(() => a.totp.cancelImport(profileId, incomingId, randomUUID()), /一致/);
  await writeFile(backup, 'synthetic truncated backup');
  assert.throws(() => a.totp.cancelImport(profileId, incomingId, originalId));
  assert.equal(await readFile(backup, 'utf8'), 'synthetic truncated backup');
  assert.deepEqual(await readFile(file), replacement);
  await rm(backup);
  assert.throws(() => a.totp.cancelImport(profileId, incomingId, originalId), /見つかりません/);
  assert.deepEqual(await readFile(file), replacement);
  await writeFile(backup, original);
  a.totp.cancelImport(profileId, incomingId, originalId);
  assert.deepEqual(await readFile(file), original);
  assert.equal(a.totp.registration(profileId, true).registrationId, originalId);
  a.totp.cancelImport(profileId, incomingId, originalId);
  a.totp.remove(profileId);
  a.totp.importRegistration(profileId, incoming, null);
  a.totp.cancelImport(profileId, incomingId, null);
  assert.equal(a.totp.registration(profileId, true).status, 'none');
  assert.deepEqual(await readdir(a.totp.directory), []);
});

for (const target of ['totp', 'profile'] as const) {
  test(`pending TOTP import stops after shared ${target} deletion and cancellation restores the original without unlocking the vault`, async (context) => {
    const f = await fixture(context);
    const a = await f.installation('a');
    const b = await f.installation('b');
    const profileId = a.profiles[0]!.id;
    const originalId = a.totp.save(profileId, { key: publicKey, metadata: { algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } });
    const file = join(a.totp.directory, `${profileId}.json`);
    const original = await readFile(file);
    const { vaultId } = await a.create();
    await a.link(profileId);
    await a.data.syncCommand({ type: 'totp:share', profileId, registrationId: originalId }, allowed);
    await deliver(a, b, vaultId);
    await b.join(vaultId);
    await b.link(profileId);
    const incomingId = b.totp.save(profileId, { key: Buffer.from('Synthetic shared replacement key'), metadata: { algorithm: 'SHA256', digits: 6, period: 30, issuer: null, account: null } });
    await b.data.localTotpChanged(profileId);
    await b.data.syncCommand({ type: 'totp:share', profileId, registrationId: incomingId }, allowed);
    await deliver(b, a, vaultId);
    let imports = 0;
    const importRegistration = a.totp.importRegistration.bind(a.totp);
    a.totp.importRegistration = (...args) => { imports++; importRegistration(...args); };
    const updateProfile = a.library.updateProfile.bind(a.library);
    a.library.updateProfile = async (settings) => {
      if (settings.totpBinding?.registrationId === incomingId) throw new Error('Synthetic settings commit interruption');
      return updateProfile(settings);
    };
    await assert.rejects(a.refresh());
    a.library.updateProfile = updateProfile;
    assert.equal(imports, 1);
    assert.equal(a.library.intent(profileId)?.profileId, profileId);
    assert.equal(a.data.status(allowed).profiles.find((entry) => entry.id === profileId)?.totpState, 'pending');
    assert.throws(() => a.data.checkTotp(profileId), /未完了/);
    assert.throws(() => a.data.checkTotpReplacement(profileId), /未完了/);
    await assert.rejects(a.data.syncCommand({ type: 'unlink' }, allowed), /未完了/);
    await assert.rejects(a.data.syncCommand({ type: 'profile:unlink', profileId }, allowed), /未完了/);
    const interrupted = await readFile(file);
    await b.data.syncCommand(target === 'profile' ? { type: 'profile:delete', profileId } : { type: 'totp:delete', profileId, registrationId: incomingId }, allowed);
    await deliver(b, a, vaultId);
    await assert.rejects(a.refresh(), /移行/);
    assert.equal(imports, 1);
    assert.deepEqual(await readFile(file), interrupted);
    a.data.lock();
    if (target === 'totp') {
      const block = a.library.blockTotpSync.bind(a.library);
      a.library.blockTotpSync = () => { throw new Error('Synthetic cancellation cleanup interruption'); };
      await assert.rejects(a.data.syncCommand({ type: 'totp:cancel-import', profileId }, allowed));
      a.library.blockTotpSync = block;
      assert.equal(a.library.intent(profileId)?.cancelled, true);
      assert.throws(() => a.data.checkTotp(profileId), /未完了/);
    } else {
      await a.data.syncCommand({ type: 'totp:cancel-import', profileId }, allowed);
      assert.equal(a.library.intent(profileId), null);
      a.data.checkTotp(profileId);
    }
    assert.deepEqual(await readFile(file), original);
    assert.equal(a.totp.registration(profileId, true).registrationId, originalId);
    assert.equal((await readdir(a.totp.directory)).some((name) => name.endsWith('.bak')), false);
    a.dispose();
    const restarted = await f.installation('a', a.os, a.profiles);
    await restarted.data.unlock({ method: 'device', input: '' }, allowed);
    assert.equal(restarted.library.intent(profileId), null);
    restarted.data.checkTotp(profileId);
    assert.equal(restarted.totp.registration(profileId, true).registrationId, originalId);
  });
}

test('concurrent TOTP replacements retain both candidates, block code use, and converge only after explicit resolution', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  const { vaultId } = await a.create();
  await a.link(profileId);
  await deliver(a, b, vaultId);
  await b.join(vaultId);
  await b.link(profileId);
  const aId = a.totp.save(profileId, { key: publicKey, metadata: { algorithm: 'SHA1', digits: 6, period: 30, issuer: 'Synthetic A', account: null } });
  const bId = b.totp.save(profileId, { key: Buffer.from('Synthetic concurrent public key'), metadata: { algorithm: 'SHA256', digits: 6, period: 30, issuer: 'Synthetic B', account: null } });
  await a.data.syncCommand({ type: 'totp:share', profileId, registrationId: aId }, allowed);
  await b.data.syncCommand({ type: 'totp:share', profileId, registrationId: bId }, allowed);
  await deliver(a, b, vaultId, true);
  await deliver(b, a, vaultId, true);
  await a.refresh();
  await b.refresh();
  const aConflict = a.data.status(allowed).profiles.find((entry) => entry.id === profileId)!;
  const bConflict = b.data.status(allowed).profiles.find((entry) => entry.id === profileId)!;
  assert.equal(aConflict.totpState, 'conflict');
  assert.equal(aConflict.totpVersions.length, 2);
  assert.deepEqual(aConflict.totpVersions, bConflict.totpVersions);
  assert.throws(() => a.data.checkTotp(profileId), /競合/);
  assert.throws(() => b.data.checkTotp(profileId), /競合/);
  const selected = aConflict.totpVersions.find((entry) => entry.registrationId === aId)!;
  await a.data.syncCommand({ type: 'totp:accept', profileId, revision: selected.revision, expectedRegistrationId: aId }, allowed);
  await deliver(a, b, vaultId);
  await b.refresh();
  a.data.checkTotp(profileId);
  b.data.checkTotp(profileId);
  const first = a.totp.load(profileId, aId);
  const second = b.totp.load(profileId, aId);
  try {
    assert.equal(totpAt(first.key, first.metadata.algorithm, f.clock.now).code, totpAt(second.key, second.metadata.algorithm, f.clock.now).code);
  } finally { first.key.fill(0); second.key.fill(0); }
});

test('concurrent passphrase changes preserve wrapping heads and resolve without losing recovery or silently accepting stale passwords', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const { vaultId, recovery } = await a.create();
  await deliver(a, b, vaultId);
  await b.join(vaultId);
  const aPassword = 'Synthetic concurrent wrapping passphrase A only';
  const bPassword = 'Synthetic concurrent wrapping passphrase B only';
  const resolved = 'Synthetic resolved wrapping passphrase only';
  await a.data.changePassphrase({ passphrase: aPassword, confirmation: aPassword }, allowed);
  await b.data.changePassphrase({ passphrase: bPassword, confirmation: bPassword }, allowed);
  await deliver(a, b, vaultId);
  await deliver(b, a, vaultId);
  await a.refresh();
  await b.refresh();
  assert.equal(a.data.status(allowed).wrappingConflict, true);
  assert.equal(b.data.status(allowed).wrappingConflict, true);
  await a.data.changePassphrase({ passphrase: resolved, confirmation: resolved }, allowed);
  await deliver(a, b, vaultId);
  await b.refresh();
  assert.equal(b.data.status(allowed).wrappingConflict, false);
  b.data.lock();
  await assert.rejects(b.data.unlock({ method: 'passphrase', input: bPassword }, allowed));
  await b.data.unlock({ method: 'recovery', input: recovery }, allowed);
  b.data.lock();
  await b.data.unlock({ method: 'passphrase', input: resolved }, allowed);
  assert.equal(b.data.status(allowed).phase, 'ready');
});

function op(profileId: string, changes: Partial<VaultOperation>): VaultOperation {
  return parseOperation({
    version: 1, id: randomUUID(), writerId: randomUUID(), sequence: 1, profileId, recordId: profileId, at: 2_000_000_000_000,
    parents: [], kind: 'profile', value: { id: profileId, name: 'Synthetic', color: 'blue' }, ...changes,
  });
}

test('causal model handles late parents and detects forks, cycles and immutable credential collisions', () => {
  const profileId = randomUUID();
  const initial = op(profileId, {});
  const later = op(profileId, { parents: [initial.id], value: { id: profileId, name: 'Later synthetic', color: 'rose' } });
  const model = new VaultModel();
  model.add(later, later.at);
  assert.equal(model.heads('profile', profileId).length, 0);
  assert.equal(model.hasPending(), true);
  model.add(initial, initial.at);
  assert.equal(model.heads('profile', profileId)[0]?.id, later.id);
  assert.throws(() => model.add(op(profileId, { writerId: initial.writerId }), initial.at), /操作番号/);
  const cyclic = new VaultModel();
  const aId = randomUUID();
  const bId = randomUUID();
  cyclic.add(op(profileId, { id: aId, parents: [bId] }), initial.at);
  assert.throws(() => cyclic.add(op(profileId, { id: bId, parents: [aId] }), initial.at), /循環/);
  const registrationId = randomUUID();
  const value: PortableTotp = { registrationId, key: publicKey.toString('base64'), algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null };
  model.add(op(profileId, { kind: 'totp', value }), initial.at);
  assert.throws(() => model.add(op(profileId, { kind: 'totp', value: { ...value, key: Buffer.from('Different synthetic').toString('base64') } }), initial.at), /登録 ID/);
});

test('shared 90-day fences suppress old replica files even after clock regression and another restart', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  const { vaultId } = await a.create();
  await a.link(profileId);
  const at = f.clock.now - HISTORY_RETENTION_MS + 1;
  await a.data.recordVisit(profileId, 'https://example.invalid/near-retention', 'Synthetic retention visit', at, 'detailed');
  await a.refresh();
  const originalFiles = new Map<string, Buffer>();
  const aPath = join(a.folder, 'Shinano Sync', vaultId);
  for (const name of await readdir(aPath)) originalFiles.set(name, await readFile(join(aPath, name)));
  await deliver(a, b, vaultId);
  await b.join(vaultId);
  await b.link(profileId);
  assert.equal((await b.list(profileId, 'history')).length, 1);
  f.clock.now++;
  await a.refresh();
  assert.equal((await a.list(profileId, 'history')).length, 0);
  await deliver(a, b, vaultId);
  f.clock.now--;
  await b.refresh();
  assert.equal((await b.list(profileId, 'history')).length, 0);
  const bPath = join(b.folder, 'Shinano Sync', vaultId);
  for (const [name, bytes] of originalFiles) if (name.endsWith('.svop')) await writeFile(join(bPath, name), bytes);
  await b.refresh();
  assert.equal((await b.list(profileId, 'history')).length, 0);
  b.dispose();
  const restarted = await f.installation('b', b.os, b.profiles);
  await restarted.data.unlock({ method: 'device', input: '' }, allowed);
  assert.equal((await restarted.list(profileId, 'history')).length, 0);
});

test('shared profile deletion removes shared credentials but leaves an installed browser profile in place', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  await a.bookmark(profileId, 'Synthetic pre-migration bookmark');
  await a.data.recordVisit(profileId, 'https://example.invalid/pre-migration', 'Synthetic pre-migration visit', f.clock.now, 'detailed');
  const { vaultId } = await a.create();
  await a.link(profileId);
  const registrationId = a.totp.save(profileId, { key: publicKey, metadata: { algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } });
  await a.data.syncCommand({ type: 'totp:share', profileId, registrationId }, allowed);
  await deliver(a, b, vaultId);
  await b.join(vaultId);
  await b.link(profileId);
  const remote = b.data.status(allowed).profiles.find((profile) => profile.id === profileId)!;
  await b.data.syncCommand({ type: 'totp:accept', profileId, revision: remote.totpVersions[0]!.revision, expectedRegistrationId: null }, allowed);
  await a.data.syncCommand({ type: 'profile:delete', profileId }, allowed);
  await deliver(a, b, vaultId);
  await b.refresh();
  assert.equal(b.profiles.some((profile) => profile.id === profileId), true);
  assert.equal(b.totp.registration(profileId, true).status, 'none');
  assert.equal(b.library.profile(profileId).linkedVaultId, null);
  assert.equal(a.profiles.some((profile) => profile.id === profileId), true);
  assert.equal(a.totp.registration(profileId, true).status, 'none');
  for (const installation of [a, b]) {
    assert.equal((await installation.list(profileId, 'bookmarks')).length, 0);
    assert.equal((await installation.list(profileId, 'history')).length, 0);
    assert.notEqual(installation.library.profile(profileId).bookmarkSpace, vaultId);
    const bookmark = await installation.bookmark(profileId, 'Synthetic local-only bookmark after shared deletion');
    assert.equal(bookmark.title, 'Synthetic local-only bookmark after shared deletion');
    await installation.data.recordVisit(profileId, 'https://example.invalid/after-deletion', 'Synthetic local-only visit', f.clock.now, 'detailed');
    assert.equal((await installation.list(profileId, 'history')).length, 1);
    await installation.refresh();
    assert.equal((await installation.list(profileId, 'bookmarks')).length, 1);
  }
});

test('local history clear removes unsent visits before a refresh without deleting visits already shared with another PC', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const profileId = a.profiles[0]!.id;
  const { vaultId } = await a.create();
  await a.link(profileId);
  await a.data.recordVisit(profileId, 'https://example.invalid/already-shared', 'Synthetic already shared', f.clock.now, 'detailed');
  await a.refresh();
  await deliver(a, b, vaultId);
  await b.join(vaultId);
  await b.link(profileId);
  assert.equal((await b.list(profileId, 'history')).length, 1);
  f.clock.now++;
  await a.data.recordVisit(profileId, 'https://example.invalid/not-sent', 'Synthetic unsent visit', f.clock.now, 'detailed');
  a.panel = 'history';
  await a.data.libraryCommand({ type: 'history:clear', profileId, scope: 'local' }, allowed);
  await a.refresh();
  await deliver(a, b, vaultId, true);
  await b.refresh();
  assert.equal((await a.list(profileId, 'history')).length, 0);
  const remote = await b.list(profileId, 'history');
  assert.equal(remote.length, 1);
  assert.equal(remote[0]?.url, 'https://example.invalid/already-shared');
});

test('partial library promotion is retryable without changing ownership or duplicating visits', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const profileId = a.profiles[0]!.id;
  const { vaultId } = await a.create();
  await a.bookmark(profileId);
  await a.data.recordVisit(profileId, 'https://example.invalid/retry', 'Synthetic retry visit', f.clock.now, 'detailed');
  const originalSpace = a.library.profile(profileId).historySpace;
  const commit = a.library.commit.bind(a.library);
  let injected = false;
  a.library.commit = async (space, operation, published) => {
    if (!injected && space === vaultId && operation.kind === 'visit') { injected = true; throw new Error('Synthetic interrupted promotion'); }
    return commit(space, operation, published);
  };
  await assert.rejects(a.link(profileId));
  assert.equal(a.library.profile(profileId).historySpace, originalSpace);
  assert.equal((await a.list(profileId, 'history')).length, 1);
  a.library.commit = commit;
  await a.link(profileId);
  assert.equal((await a.list(profileId, 'history')).length, 1);
  assert.equal((await a.list(profileId, 'bookmarks')).length, 1);
});

test('lock invalidates in-flight creation and join, and passphrase changes retain recovery without pretending to revoke old devices', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const b = await f.installation('b');
  const selection = await a.data.chooseFolder(allowed);
  assert.ok(selection);
  const pendingCreate = a.data.create({ selectionId: selection.selectionId, passphrase, confirmation: passphrase, remember: false }, allowed);
  a.data.lock();
  await assert.rejects(pendingCreate, /中止/);
  assert.equal(a.data.status(allowed).vaultId, null);
  const { vaultId, recovery } = await a.create();
  await a.link(a.profiles[0]!.id);
  await deliver(a, b, vaultId);
  const choice = await b.data.chooseFolder(allowed);
  assert.ok(choice);
  const pendingJoin = b.data.join({ selectionId: choice.selectionId, vaultId, method: 'passphrase', input: passphrase, remember: true }, allowed);
  b.data.lock();
  await assert.rejects(pendingJoin, /中止/);
  assert.equal(b.data.status(allowed).vaultId, null);
  const replacement = 'Another public synthetic fixture passphrase only';
  await a.data.changePassphrase({ passphrase: replacement, confirmation: replacement }, allowed);
  await deliver(a, b, vaultId);
  await b.join(vaultId, recovery, 'recovery');
  b.data.lock();
  await assert.rejects(b.data.unlock({ method: 'passphrase', input: passphrase }, allowed));
  await b.data.unlock({ method: 'passphrase', input: replacement }, allowed);
  assert.equal(b.data.status(allowed).phase, 'ready');
  a.data.lock();
  await a.data.unlock({ method: 'device', input: '' }, allowed);
  assert.equal(a.data.status(allowed).phase, 'ready');
});

test('native creation cancellation clears pending setup and does not write a vault', async (context) => {
  const f = await fixture(context);
  const a = await f.installation('a');
  const choice = await a.data.chooseFolder(allowed);
  assert.ok(choice);
  const request = { selectionId: choice.selectionId, passphrase, confirmation: passphrase, remember: true };
  const setup = await a.data.create({ ...request }, allowed);
  a.confirm = false;
  assert.equal((await a.data.syncCommand({ type: 'finish-create', setupId: setup.setupId, recoveryAcknowledged: true }, allowed)).outcome, 'cancelled');
  assert.equal(a.data.status(allowed).vaultId, null);
  assert.deepEqual(await readdir(a.folder), []);
  const retry = await a.data.create({ ...request }, allowed);
  assert.notEqual(retry.setupId, setup.setupId);
  await a.data.syncCommand({ type: 'cancel-setup' }, allowed);
});

for (const stage of ['publication', 'association', 'remembering'] as const) {
  test(`locking during first-device ${stage} never reactivates or caches a cleared setup key`, async (context) => {
    const f = await fixture(context);
    const a = await f.installation('a');
    const choice = await a.data.chooseFolder(allowed);
    assert.ok(choice);
    const setup = await a.data.create({ selectionId: choice.selectionId, passphrase, confirmation: passphrase, remember: true }, allowed);
    if (stage === 'publication') {
      const create = VaultFolder.prototype.createVault;
      context.mock.method(VaultFolder.prototype, 'createVault', async function (this: VaultFolder, ...args: Parameters<VaultFolder['createVault']>) {
        await create.apply(this, args);
        a.data.lock();
      });
    } else if (stage === 'association') {
      const update = a.library.updateSettings.bind(a.library);
      context.mock.method(a.library, 'updateSettings', async (...args: Parameters<LibraryStore['updateSettings']>) => {
        await update(...args);
        if (args[0].association) a.data.lock();
      });
    } else {
      const remember = a.library.remember.bind(a.library);
      context.mock.method(a.library, 'remember', async (...args: Parameters<LibraryStore['remember']>) => {
        await remember(...args);
        a.data.lock();
      });
    }
    await assert.rejects(a.data.syncCommand({ type: 'finish-create', setupId: setup.setupId, recoveryAcknowledged: true }, allowed), /作成完了前/);
    context.mock.restoreAll();
    const state = a.data.status(allowed);
    assert.notEqual(state.phase, 'ready');
    assert.equal(state.hasDeviceKey, stage === 'remembering');
    if (state.vaultId) {
      await a.data.unlock({ method: stage === 'remembering' ? 'device' : 'passphrase', input: stage === 'remembering' ? '' : passphrase }, allowed);
    } else {
      const ids = await (await VaultFolder.select(a.folder, [a.userData])).listVaultIds();
      assert.equal(ids.length, 1);
      await a.join(ids[0]!);
    }
    assert.equal(a.data.status(allowed).phase, 'ready');
  });
}

test('live-record quotas test the exact bookmark and 90-day visit thresholds', () => {
  const profileId = randomUUID();
  const writerId = randomUUID();
  const now = 2_000_000_000_000;
  for (const [kind, maximum] of [['bookmark', MAX_BOOKMARKS], ['visit', MAX_VISITS]] as const) {
    const model = new VaultModel();
    model.add(op(profileId, { writerId, sequence: 1 }), now);
    for (let index = 0; index <= maximum; index++) {
      if (index === maximum) assert.doesNotThrow(() => model.assertLiveLimits(now));
      const recordId = randomUUID();
      model.add(parseOperation({
        version: 1, id: randomUUID(), writerId, sequence: index + 2, at: now, profileId, recordId, parents: [], kind,
        value: kind === 'bookmark' ? { title: 'Synthetic bounded item', url: 'https://example.invalid/item', createdAt: now }
          : { title: 'Synthetic bounded visit', url: 'https://example.invalid/visit', visitedAt: now, mode: 'detailed' },
      }), now);
    }
    assert.throws(() => model.assertLiveLimits(now), /上限/);
  }
});
