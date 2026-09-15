import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test, expect, Harness } from './harness.ts';
import { startFixture } from './fixture.ts';
import type { LibraryCommand, LibraryKind } from '../../src/shared/library.ts';
import type { SyncCommand } from '../../src/shared/sync.ts';

const syntheticPassphrase = 'Public synthetic cross-PC fixture passphrase only';
const publicBase32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 public test key.
let fixture: Awaited<ReturnType<typeof startFixture>>;
test.beforeAll(async () => { fixture = await startFixture(); });
test.afterAll(async () => { await fixture.close(); });

async function protection(harness: Harness): Promise<void> {
  const available = await harness.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  test.skip(!available, 'Real OS safeStorage unavailable; native encrypted persistence is NOT verified. No fallback.');
}

async function library(harness: Harness, command: LibraryCommand) {
  const response = await harness.page.evaluate((value) => window.shinano.library.command(value), command);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

async function query(harness: Harness, profileId: string, kind: LibraryKind) {
  const response = await harness.page.evaluate((value) => window.shinano.library.query(value), { kind, profileId, query: '', cursor: null });
  if (!response.ok) throw new Error(response.error);
  return response.value.entries;
}

async function sync(harness: Harness, command: SyncCommand) {
  const response = await harness.page.evaluate((value) => window.shinano.sync.command(value), command);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

async function status(harness: Harness) {
  const response = await harness.page.evaluate(() => window.shinano.sync.status());
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

async function choose(harness: Harness, folder: string) {
  await harness.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  const response = await harness.page.evaluate(() => window.shinano.sync.chooseFolder());
  if (!response.ok) throw new Error(response.error);
  if (!response.value) throw new Error('Synthetic folder selection unexpectedly cancelled.');
  return response.value;
}

async function copyReplica(from: string, to: string, vaultId: string): Promise<void> {
  const source = join(from, 'Shinano Sync', vaultId);
  const destination = join(to, 'Shinano Sync', vaultId);
  await mkdir(destination, { recursive: true });
  for (const name of (await readdir(source)).sort().reverse()) {
    if (name.endsWith('.svkey') || name.endsWith('.svop')) await copyFile(join(source, name), join(destination, name));
  }
}

test('real navigation records settled main-frame detailed history, never transient/iframe URLs, and renders bookmarks as text', async ({ shinano }) => {
  await protection(shinano);
  await shinano.dialogChoice(1);
  const profileId = (await shinano.state()).profiles[0]!.id;
  const url = `${fixture.origin}/history-one?NeverPersistHistoryQuery_42#NeverPersistHistoryFragment_42`;
  await shinano.createTab(profileId, url);
  await shinano.command({ type: 'ui:panel', panel: 'history' });
  await expect.poll(async () => (await query(shinano, profileId, 'history')).some((entry) => entry.url === `${fixture.origin}/history-one`)).toBe(true);
  const entries = await query(shinano, profileId, 'history');
  expect(entries.find((entry) => entry.url === `${fixture.origin}/history-one`)?.title).toBe('Fixture /history-one');
  expect(entries.every((entry) => !entry.url.includes('?') && !entry.url.includes('#'))).toBe(true);
  const savedState = await readFile(join(shinano.userData, 'state.json'), 'utf8');
  expect(savedState).not.toContain('history-one');
  expect(savedState).not.toContain('NeverPersistHistory');
  await shinano.remote(url, `(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${fixture.origin}/iframe-only-fixture`)}; document.body.append(frame); })()`);
  await shinano.createTab(profileId, `${fixture.origin}/history-transient`);
  await shinano.command({ type: 'ui:panel', panel: 'history' });
  await expect.poll(async () => (await query(shinano, profileId, 'history')).some((entry) => entry.url === `${fixture.origin}/history-settled`)).toBe(true);
  const settled = await query(shinano, profileId, 'history');
  expect(settled.some((entry) => /history-transient|iframe-only-fixture/.test(entry.url))).toBe(false);
  await library(shinano, { type: 'history:mode', profileId, mode: 'off' });
  await shinano.createTab(profileId, `${fixture.origin}/history-disabled`);
  await shinano.command({ type: 'ui:panel', panel: 'bookmarks' });
  const hostileTitle = '<img src=x onerror=syntheticLibraryXss=1>';
  await library(shinano, {
    type: 'bookmark:save', profileId, recordId: null, parents: [], title: hostileTitle,
    url: `${fixture.origin}/explicit-bookmark?UserApprovedBookmarkQuery_42#part`,
  });
  await expect(shinano.page.locator('#workspace')).toContainText(hostileTitle);
  await expect(shinano.page.locator('#workspace img')).toHaveCount(0);
  expect(await shinano.page.evaluate(() => Reflect.get(window, 'syntheticLibraryXss'))).toBeUndefined();
  const bookmarks = await query(shinano, profileId, 'bookmarks');
  expect(bookmarks[0]?.url).toContain('?UserApprovedBookmarkQuery_42#part');
  await shinano.page.locator('#address').fill(`${fixture.origin}/not-committed`);
  const draft = await shinano.page.evaluate(() => window.shinano.library.currentBookmark());
  expect(draft.ok && draft.value.url).toBe(`${fixture.origin}/history-disabled`);
  await shinano.command({ type: 'ui:panel', panel: 'history' });
  expect((await query(shinano, profileId, 'history')).some((entry) => entry.url.endsWith('/history-disabled'))).toBe(false);
});

test('two real Electron userData installations use a local replica transport and retain TOTP/profile bindings across restart without sessions', async ({ shinano }) => {
  test.setTimeout(90_000);
  await protection(shinano);
  const root = await mkdtemp(join(tmpdir(), 'shinano-electron-sync-'));
  const aFolder = join(root, 'a-replica');
  const bFolder = join(root, 'b-replica');
  const bData = join(root, 'b-userData');
  await Promise.all([mkdir(aFolder), mkdir(bFolder), mkdir(bData)]);
  const b = new Harness(bData);
  try {
    await b.start();
    await protection(b);
    await shinano.dialogChoice(1);
    await b.dialogChoice(1);
    const profileId = (await shinano.state()).profiles[0]!.id;
    const aUrl = `${fixture.origin}/sync-origin`;
    await shinano.createTab(profileId, aUrl);
    await shinano.remote(aUrl, `window.fixtureWrite('SyntheticOnlyOnInstallationA')`);
    await shinano.command({ type: 'ui:totp-profile', profileId });
    const registration = await shinano.page.evaluate((value) => window.shinano.totp.register(value.profileId, value.input), { profileId, input: publicBase32 });
    expect(registration.ok).toBe(true);
    const metadata = (await shinano.state()).totp.registrations.find((entry) => entry.profileId === profileId);
    if (metadata?.status !== 'registered') throw new Error('Synthetic local TOTP registration missing.');
    const registrationId = metadata.registrationId;
    await shinano.command({ type: 'ui:panel', panel: 'sync' });
    const aChoice = await choose(shinano, aFolder);
    const created = await shinano.page.evaluate((value) => window.shinano.sync.create(value), {
      selectionId: aChoice.selectionId, passphrase: syntheticPassphrase, confirmation: syntheticPassphrase, remember: true,
    });
    if (!created.ok) throw new Error(created.error);
    await sync(shinano, { type: 'finish-create', setupId: created.value.setupId, recoveryAcknowledged: true });
    const vaultId = (await status(shinano)).vaultId;
    if (!vaultId) throw new Error('Synthetic vault ID missing.');
    expect((await readdir(join(aFolder, 'Shinano Sync', vaultId))).filter((name) => name.endsWith('.svop'))).toEqual([]);
    await sync(shinano, { type: 'profile:link', profileId, bookmarks: true, history: true });
    await sync(shinano, { type: 'totp:share', profileId, registrationId });
    await shinano.command({ type: 'ui:panel', panel: 'bookmarks' });
    await library(shinano, { type: 'bookmark:save', profileId, recordId: null, parents: [], title: 'Synthetic portable bookmark', url: `${fixture.origin}/portable-bookmark?explicit=synthetic` });
    await shinano.command({ type: 'ui:panel', panel: 'sync' });
    await sync(shinano, { type: 'refresh' });
    await copyReplica(aFolder, bFolder, vaultId);
    await b.command({ type: 'ui:panel', panel: 'sync' });
    const bChoice = await choose(b, bFolder);
    const joined = await b.page.evaluate((value) => window.shinano.sync.join(value), {
      selectionId: bChoice.selectionId, vaultId, method: 'passphrase' as const, input: syntheticPassphrase, remember: true,
    });
    if (!joined.ok) throw new Error(joined.error);
    expect((await b.state()).profiles.some((entry) => entry.id === profileId)).toBe(false);
    await sync(b, { type: 'profile:link', profileId, bookmarks: true, history: true });
    expect((await b.state()).totp.registrations.find((entry) => entry.profileId === profileId)?.status).toBe('none');
    await b.app.evaluate(({ safeStorage }, profileId) => {
      const original = safeStorage.encryptString.bind(safeStorage);
      let imports = 0;
      safeStorage.encryptString = (value) => {
        if (value.includes(`"profileId":"${profileId}"`) && value.includes('"registrationId"') && value.includes('"key"')) imports++;
        return original(value);
      };
      Object.defineProperty(safeStorage, '__syntheticImportCount', { get: () => imports });
    }, profileId);
    const shared = (await status(b)).profiles.find((entry) => entry.id === profileId)!;
    await sync(b, { type: 'totp:accept', profileId, revision: shared.totpVersions[0]!.revision, expectedRegistrationId: null });
    expect(await b.app.evaluate(({ safeStorage }) => Reflect.get(safeStorage, '__syntheticImportCount'))).toBeGreaterThan(0);
    const controlledNow = Date.now();
    for (const app of [shinano, b]) {
      await app.app.evaluate((_electron, now) => { Date.now = () => now; }, controlledNow);
      await app.command({ type: 'ui:totp-profile', profileId });
    }
    const codes = await Promise.all([shinano, b].map((app) => app.page.evaluate((value) => window.shinano.totp.getCode(value.profileId, value.registrationId), { profileId, registrationId })));
    expect(codes[0]?.ok && codes[1]?.ok && codes[0].value.code === codes[1].value.code).toBe(true);
    await b.command({ type: 'ui:panel', panel: 'bookmarks' });
    expect((await query(b, profileId, 'bookmarks')).some((entry) => entry.title === 'Synthetic portable bookmark')).toBe(true);
    const bUrl = `${fixture.origin}/sync-no-session-copy`;
    await b.createTab(profileId, bUrl);
    expect(await b.remote(bUrl, 'window.fixtureRead()')).toEqual({ cookie: '', local: null, session: null });
    const pid = b.app.process().pid;
    await b.restart();
    expect(b.app.process().pid).not.toBe(pid);
    await b.dialogChoice(1);
    await b.command({ type: 'ui:panel', panel: 'sync' });
    const unlocked = await b.page.evaluate(() => window.shinano.sync.unlock({ method: 'device', input: '' }));
    if (!unlocked.ok) throw new Error(unlocked.error);
    await b.command({ type: 'ui:totp-profile', profileId });
    const after = await b.page.evaluate((value) => window.shinano.totp.getCode(value.profileId, value.registrationId), { profileId, registrationId });
    expect(after.ok && after.value.registrationId).toBe(registrationId);
    await b.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.show();
      BrowserWindow.getAllWindows()[0]?.focus();
    });
    await b.page.locator('#totp-show').click();
    await expect(b.page.locator('#totp-code')).toHaveText(/^\d{6}$/);
    await b.app.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); });
    await expect(b.page.locator('#totp-code')).not.toHaveText(/^\d{6}$/);
    expect((await b.state()).panel).toBe('totp');
    await b.command({ type: 'profile:delete', profileId });
    await b.restart();
    await b.dialogChoice(1);
    await b.command({ type: 'ui:panel', panel: 'sync' });
    const again = await b.page.evaluate(() => window.shinano.sync.unlock({ method: 'device', input: '' }));
    if (!again.ok) throw new Error(again.error);
    expect((await b.state()).profiles.some((entry) => entry.id === profileId)).toBe(false);
    expect((await status(b)).profiles.find((entry) => entry.id === profileId)?.suppressed).toBe(true);
    expect((await shinano.state()).profiles.some((entry) => entry.id === profileId)).toBe(true);
  } finally {
    await b.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a real interrupted TOTP import preserves its intent during local replacement and the locked-vault UI restores the original ciphertext', async ({ shinano }) => {
  test.setTimeout(90_000);
  await protection(shinano);
  const root = await mkdtemp(join(tmpdir(), 'shinano-electron-recovery-'));
  const aFolder = join(root, 'a-replica');
  const bFolder = join(root, 'b-replica');
  const bData = join(root, 'b-userData');
  await Promise.all([mkdir(aFolder), mkdir(bFolder), mkdir(bData)]);
  const b = new Harness(bData);
  try {
    await b.start();
    await protection(b);
    await shinano.dialogChoice(1);
    await b.dialogChoice(1);
    const profileId = (await shinano.state()).profiles[0]!.id;
    await shinano.command({ type: 'ui:totp-profile', profileId });
    const added = await shinano.page.evaluate((value) => window.shinano.totp.register(value.profileId, value.input), { profileId, input: publicBase32 });
    expect(added.ok).toBe(true);
    const source = (await shinano.state()).totp.registrations.find((entry) => entry.profileId === profileId);
    if (source?.status !== 'registered') throw new Error('Synthetic source registration missing.');
    await shinano.command({ type: 'ui:panel', panel: 'sync' });
    const selected = await choose(shinano, aFolder);
    const setup = await shinano.page.evaluate((value) => window.shinano.sync.create(value), {
      selectionId: selected.selectionId, passphrase: syntheticPassphrase, confirmation: syntheticPassphrase, remember: true,
    });
    if (!setup.ok) throw new Error(setup.error);
    await sync(shinano, { type: 'finish-create', setupId: setup.value.setupId, recoveryAcknowledged: true });
    const vaultId = (await status(shinano)).vaultId;
    if (!vaultId) throw new Error('Synthetic vault missing.');
    await sync(shinano, { type: 'profile:link', profileId, bookmarks: false, history: false });
    await sync(shinano, { type: 'totp:share', profileId, registrationId: source.registrationId });
    await copyReplica(aFolder, bFolder, vaultId);
    await b.command({ type: 'ui:panel', panel: 'sync' });
    const destination = await choose(b, bFolder);
    const joined = await b.page.evaluate((value) => window.shinano.sync.join(value), {
      selectionId: destination.selectionId, vaultId, method: 'passphrase' as const, input: syntheticPassphrase, remember: true,
    });
    if (!joined.ok) throw new Error(joined.error);
    await sync(b, { type: 'profile:link', profileId, bookmarks: false, history: false });
    await b.command({ type: 'ui:totp-profile', profileId });
    const local = await b.page.evaluate((value) => window.shinano.totp.register(value.profileId, value.input), { profileId, input: 'MFRGGZDFMZTWQ2LK' });
    expect(local.ok).toBe(true);
    const previous = (await b.state()).totp.registrations.find((entry) => entry.profileId === profileId);
    if (previous?.status !== 'registered') throw new Error('Synthetic original local registration missing.');
    const file = join(bData, 'totp', `${profileId}.json`);
    const original = await readFile(file);
    await b.command({ type: 'ui:panel', panel: 'sync' });
    const remote = (await status(b)).profiles.find((entry) => entry.id === profileId)!;
    await b.app.evaluate((_electron, target) => {
      const files = process.getBuiltinModule('fs/promises');
      const rename = files.rename;
      files.rename = async (source, destination) => {
        if (destination === target) {
          files.rename = rename;
          throw new Error('Synthetic interruption after OS-encrypted TOTP replacement');
        }
        return rename(source, destination);
      };
    }, join(bData, 'library', 'profiles', profileId, 'settings.json'));
    const interrupted = await b.page.evaluate((command) => window.shinano.sync.command(command), {
      type: 'totp:accept' as const, profileId, revision: remote.totpVersions[0]!.revision, expectedRegistrationId: previous.registrationId,
    });
    expect(interrupted.ok).toBe(false);
    expect((await status(b)).profiles.find((entry) => entry.id === profileId)?.totpState).toBe('pending');
    await b.command({ type: 'ui:totp-profile', profileId });
    const blocked = await b.page.evaluate((value) => window.shinano.totp.register(value.profileId, value.input), { profileId, input: publicBase32 });
    expect(blocked.ok).toBe(false);
    await b.command({ type: 'ui:panel', panel: 'sync' });
    expect((await status(b)).profiles.find((entry) => entry.id === profileId)?.totpState).toBe('pending');
    await sync(b, { type: 'lock' });
    await b.page.locator('#sync-profile').selectOption(profileId);
    await expect(b.page.locator('#sync-totp-cancel-import')).toBeEnabled();
    await b.page.locator('#sync-totp-cancel-import').click();
    await expect.poll(async () => (await status(b)).profiles.find((entry) => entry.id === profileId)?.totpState).not.toBe('pending');
    expect(await readFile(file)).toEqual(original);
    expect((await readdir(join(bData, 'totp'))).some((name) => name.endsWith('.bak'))).toBe(false);
    const restored = (await b.state()).totp.registrations.find((entry) => entry.profileId === profileId);
    expect(restored?.registrationId).toBe(previous.registrationId);
    await b.command({ type: 'ui:totp-profile', profileId });
    const code = await b.page.evaluate((value) => window.shinano.totp.getCode(value.profileId, value.registrationId), { profileId, registrationId: previous.registrationId });
    expect(code.ok).toBe(true);
  } finally {
    await b.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('the native sync picker rejects normal repositories and linked-worktree git files, including descendants', async ({ shinano }) => {
  const root = await mkdtemp(join(tmpdir(), 'shinano-picker-guard-'));
  const repository = join(root, 'synthetic-repository');
  const worktree = join(root, 'synthetic-linked-worktree');
  const ordinaryChild = join(repository, 'candidate');
  const linkedChild = join(worktree, 'candidate');
  const allowedFolder = join(root, 'not-a-repository');
  try {
    await Promise.all([
      mkdir(join(repository, '.git'), { recursive: true }),
      mkdir(ordinaryChild, { recursive: true }), mkdir(linkedChild, { recursive: true }), mkdir(allowedFolder),
    ]);
    await writeFile(join(worktree, '.git'), 'gitdir: ../synthetic-repository/.git/worktrees/synthetic-linked-worktree\n');
    await shinano.command({ type: 'ui:panel', panel: 'sync' });
    for (const folder of [repository, ordinaryChild, worktree, linkedChild]) {
      await shinano.app.evaluate(({ dialog }, folder) => {
        let calls = 0;
        dialog.showOpenDialog = async () => { calls++; return { canceled: false, filePaths: [folder] }; };
        Object.defineProperty(dialog, '__syntheticPickerCalls', { get: () => calls, configurable: true });
      }, folder);
      const result = await shinano.page.evaluate(() => window.shinano.sync.chooseFolder());
      expect(await shinano.app.evaluate(({ dialog }) => Reflect.get(dialog, '__syntheticPickerCalls'))).toBe(1);
      expect(result.ok).toBe(false);
      expect((await readdir(folder)).includes('Shinano Sync')).toBe(false);
      expect((await status(shinano)).vaultId).toBeNull();
    }
    const accepted = await choose(shinano, allowedFolder);
    expect(accepted.vaultIds).toEqual([]);
    expect(await readdir(allowedFolder)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('all new data channels reject real foreign WebContents before parsing or displaying a native picker', async ({ shinano }) => {
  const profileId = (await shinano.state()).profiles[0]!.id;
  await shinano.command({ type: 'ui:panel', panel: 'sync' });
  const results = await shinano.app.evaluate(({ ipcMain, WebContentsView }, args) => new Promise<unknown>((resolve, reject) => {
    const view = new WebContentsView({ webPreferences: {
      preload: args.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      additionalArguments: [`--fixture-profile=${args.profileId}`],
    } });
    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.removeListener('shinano-test:data-denied', receive);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    };
    const receive = (event: Electron.IpcMainEvent, value: unknown) => {
      if (event.sender !== view.webContents) return;
      cleanup();
      resolve(value);
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Synthetic foreign data IPC fixture timed out.')); }, 8000);
    ipcMain.on('shinano-test:data-denied', receive);
    void view.webContents.loadURL(args.url).catch(() => { cleanup(); reject(new Error('Synthetic foreign fixture failed to load.')); });
  }), { preload: fileURLToPath(new URL('./data-probe.cjs', import.meta.url)), profileId, url: `${fixture.origin}/data-probe-${randomUUID()}` });
  expect(results).toEqual(Array.from({ length: 10 }, () => true));
  expect((await status(shinano)).vaultId).toBeNull();
});

test('the real Japanese setup form clears secret fields and one-time recovery nodes and requires explicit completion', async ({ shinano }) => {
  await protection(shinano);
  const folder = await mkdtemp(join(tmpdir(), 'shinano-ui-vault-'));
  try {
    await shinano.dialogChoice(1);
    await shinano.app.evaluate(({ dialog, BrowserWindow }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      const window = BrowserWindow.getAllWindows()[0];
      window?.show();
      window?.focus();
    }, folder);
    await shinano.command({ type: 'ui:panel', panel: 'sync' });
    await shinano.page.locator('#sync-choose-folder').click();
    await shinano.page.locator('#sync-new-vault').click();
    await shinano.page.locator('#sync-create-passphrase').fill(syntheticPassphrase);
    await shinano.page.locator('#sync-create-confirmation').fill(syntheticPassphrase);
    await shinano.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(shinano.page.locator('#sync-create-passphrase')).toHaveValue('');
    await expect(shinano.page.locator('#sync-create-confirmation')).toHaveValue('');
    await shinano.page.locator('#sync-create-passphrase').fill(syntheticPassphrase);
    await shinano.page.locator('#sync-create-confirmation').fill(syntheticPassphrase);
    const oldField = await shinano.page.locator('#sync-create-passphrase').evaluateHandle((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('Synthetic passphrase field missing.');
      return element;
    });
    await shinano.page.locator('#sync-create-submit').click();
    await expect(shinano.page.locator('#sync-recovery-key')).not.toBeEmpty();
    expect(await oldField.evaluate((field) => field.value)).toBe('');
    expect((await status(shinano)).vaultId).toBeNull();
    await expect(shinano.page.locator('#sync-finish-create')).toBeDisabled();
    const oldRecovery = await shinano.page.locator('#sync-recovery-key').evaluateHandle((element) => element);
    await shinano.page.locator('#sync-recovery-acknowledged').check();
    await shinano.page.locator('#sync-finish-create').click();
    await expect(shinano.page.locator('#sync-lock')).toBeVisible();
    expect(await oldRecovery.evaluate((element) => element.textContent)).toBe('');
    const created = await status(shinano);
    expect(created.phase).toBe('ready');
    expect(created.vaultId).not.toBeNull();
    await expect(shinano.page.locator('#sync-recovery-key')).toHaveCount(0);
    await shinano.page.locator('#sync-lock').click();
    await expect(shinano.page.locator('#sync-unlock-input')).toBeVisible();
    expect((await status(shinano)).phase).toBe('locked');
    await oldField.dispose();
    await oldRecovery.dispose();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
