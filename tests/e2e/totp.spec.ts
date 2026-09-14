import { createHmac, randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Harness } from './harness.ts';
import { startFixture } from './fixture.ts';
import type { TotpCode } from '../../src/shared/totp.ts';

const publicBase32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 public test key.
const publicKey = Buffer.from('12345678901234567890');
const syntheticUri = `otpauth://totp/Synthetic%3Afixture?secret=${publicBase32}&issuer=Synthetic&algorithm=SHA256&digits=6&period=30`;
let fixture: Awaited<ReturnType<typeof startFixture>>;
test.beforeAll(async () => { fixture = await startFixture(); });
test.afterAll(async () => { await fixture.close(); });

async function requireNativeProtection(harness: Harness): Promise<void> {
  const available = await harness.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  test.skip(!available, 'Real OS safeStorage is unavailable; encrypted persistence was NOT verified. No plaintext fallback is allowed.');
}

function captureOutput(harness: Harness): () => string {
  let output = '';
  const collect = (chunk: Buffer) => { output += chunk.toString(); };
  harness.app.process().stdout?.on('data', collect);
  harness.app.process().stderr?.on('data', collect);
  return () => output;
}

async function secretField(harness: Harness) {
  return harness.page.locator('#totp-input').evaluateHandle((node) => {
    if (!(node instanceof HTMLInputElement)) throw new Error('Synthetic secret field is missing.');
    return node;
  });
}

async function register(harness: Harness, profileId: string, input = publicBase32): Promise<string> {
  await harness.command({ type: 'ui:totp-profile', profileId });
  const result = await harness.page.evaluate(async ({ profileId, input }) =>
    window.shinano.totp.register(profileId, input), { profileId, input });
  expect(result).toEqual({ ok: true, value: { outcome: 'saved' } });
  const registration = (await harness.state()).totp.registrations.find((entry) => entry.profileId === profileId);
  if (registration?.status !== 'registered') throw new Error('Synthetic TOTP registration missing.');
  return registration.registrationId;
}

async function code(harness: Harness, profileId: string, registrationId: string): Promise<TotpCode> {
  const result = await harness.page.evaluate(async ({ profileId, registrationId }) =>
    window.shinano.totp.getCode(profileId, registrationId), { profileId, registrationId });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function expectedCode(snapshot: TotpCode): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(snapshot.validFrom / 30_000));
  const digest = createHmac(snapshot.algorithm.toLowerCase(), publicKey).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

test('real safeStorage keeps profile-bound TOTP across a real restart without general-state or disk plaintext', async ({ shinano }) => {
  await requireNativeProtection(shinano);
  const firstOutput = captureOutput(shinano);
  const a = (await shinano.state()).profiles[0]!;
  const created = await shinano.command({ type: 'profile:create', name: 'Synthetic B', color: 'teal' });
  const b = created.profiles.find((entry) => entry.id !== a.id)!;
  await shinano.createTab(a.id, `${fixture.origin}/totp-browser`);
  const aRegistration = await register(shinano, a.id);
  const bRegistration = await register(shinano, b.id, syntheticUri);
  const bCode = await code(shinano, b.id, bRegistration);
  expect(bCode.algorithm).toBe('SHA256');
  expect(bCode.code).toBe(expectedCode(bCode));
  const wrongProfile = await shinano.page.evaluate(async ({ a, aRegistration }) =>
    window.shinano.totp.getCode(a, aRegistration), { a: a.id, aRegistration });
  expect(wrongProfile.ok).toBe(false);
  const before = await shinano.state();
  const saved = await readFile(join(shinano.userData, 'state.json'), 'utf8');
  const encryptedA = await readFile(join(shinano.userData, 'totp', `${a.id}.json`), 'utf8');
  const encryptedB = await readFile(join(shinano.userData, 'totp', `${b.id}.json`), 'utf8');
  for (const sensitive of [publicBase32, publicKey.toString(), publicKey.toString('base64'), syntheticUri, 'otpauth://']) {
    for (const text of [JSON.stringify(before), saved, encryptedA, encryptedB]) expect(text).not.toContain(sensitive);
  }
  expect(Object.keys(before.totp.registrations[0]!).sort()).toEqual(['error', 'profileId', 'registrationId', 'status']);
  const pid = shinano.app.process().pid;
  await shinano.restart();
  const restartedOutput = captureOutput(shinano);
  expect(shinano.app.process().pid).not.toBe(pid);
  await shinano.command({ type: 'ui:totp-profile', profileId: a.id });
  const aCode = await code(shinano, a.id, aRegistration);
  expect(aCode.algorithm).toBe('SHA1');
  expect(aCode.code).toBe(expectedCode(aCode));
  expect(aCode.code).toMatch(/^\d{6}$/);
  expect(aCode.validUntil - aCode.validFrom).toBe(30_000);
  await shinano.command({ type: 'profile:update', profileId: a.id, name: 'Renamed fixture', color: 'rose' });
  expect((await code(shinano, a.id, aRegistration)).registrationId).toBe(aRegistration);
  await shinano.command({ type: 'ui:panel', panel: 'none' });
  expect((await shinano.page.evaluate(async ({ profileId, registrationId }) =>
    window.shinano.totp.getCode(profileId, registrationId), { profileId: a.id, registrationId: aRegistration })).ok).toBe(false);
  for (const sensitive of [publicBase32, publicKey.toString(), publicKey.toString('base64'), syntheticUri]) {
    expect(firstOutput()).not.toContain(sensitive);
    expect(restartedOutput()).not.toContain(sensitive);
  }
});

test('replacement, cancellation and profile deletion preserve the other real encrypted registration', async ({ shinano }) => {
  await requireNativeProtection(shinano);
  const a = (await shinano.state()).profiles[0]!;
  const b = (await shinano.command({ type: 'profile:create', name: 'Keep fixture B', color: 'purple' })).profiles[1]!;
  const aRegistration = await register(shinano, a.id);
  const bRegistration = await register(shinano, b.id);
  const bFile = join(shinano.userData, 'totp', `${b.id}.json`);
  const originalB = await readFile(bFile);
  await shinano.command({ type: 'ui:totp-profile', profileId: a.id });
  await shinano.dialogChoice(0);
  expect(await shinano.page.evaluate(async ({ profileId, input }) =>
    window.shinano.totp.register(profileId, input), { profileId: a.id, input: syntheticUri }))
    .toEqual({ ok: true, value: { outcome: 'cancelled' } });
  expect(await shinano.page.evaluate(async (profileId) => window.shinano.totp.remove(profileId), a.id))
    .toEqual({ ok: true, value: { outcome: 'cancelled' } });
  expect((await code(shinano, a.id, aRegistration)).registrationId).toBe(aRegistration);
  await shinano.dialogChoice(1);
  const replacement = await register(shinano, a.id, syntheticUri);
  expect(replacement).not.toBe(aRegistration);
  expect((await shinano.page.evaluate(async ({ profileId, registrationId }) =>
    window.shinano.totp.getCode(profileId, registrationId), { profileId: a.id, registrationId: aRegistration })).ok).toBe(false);
  await shinano.app.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = () => false; });
  await shinano.command({ type: 'profile:delete', profileId: a.id });
  await expect(access(join(shinano.userData, 'totp', `${a.id}.json`))).rejects.toThrow();
  expect(await readFile(bFile)).toEqual(originalB);
  await shinano.restart();
  expect((await shinano.state()).profiles.map((profile) => profile.id)).toEqual([b.id]);
  expect(JSON.parse(await readFile(join(shinano.userData, 'state.json'), 'utf8')).deletedProfileIds).toEqual([]);
  await shinano.command({ type: 'ui:totp-profile', profileId: b.id });
  expect((await code(shinano, b.id, bRegistration)).code).toMatch(/^\d{6}$/);
});

test('unavailable encryption, corrupt records, malformed import and nonexistent profiles fail visibly without overwriting', async ({ shinano }) => {
  await requireNativeProtection(shinano);
  const profile = (await shinano.state()).profiles[0]!;
  const registrationId = await register(shinano, profile.id);
  const file = join(shinano.userData, 'totp', `${profile.id}.json`);
  const original = await readFile(file);
  await shinano.dialogChoice(1);
  await shinano.app.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = () => false; });
  const unavailable = await shinano.page.evaluate(async ({ profileId, input }) =>
    window.shinano.totp.register(profileId, input), { profileId: profile.id, input: syntheticUri });
  expect(unavailable.ok).toBe(false);
  expect(JSON.stringify(unavailable)).toContain('OS');
  expect(JSON.stringify(unavailable)).not.toContain(syntheticUri);
  expect(await readFile(file)).toEqual(original);
  const malformed = await shinano.page.evaluate(async ({ profileId, input }) =>
    window.shinano.totp.register(profileId, input), { profileId: profile.id, input: `${syntheticUri}&secret=duplicate` });
  expect(malformed.ok).toBe(false);
  expect(await readFile(file)).toEqual(original);
  const missingId = randomUUID();
  expect((await shinano.page.evaluate(async ({ profileId, input }) =>
    window.shinano.totp.register(profileId, input), { profileId: missingId, input: publicBase32 })).ok).toBe(false);
  await expect(access(join(shinano.userData, 'totp', `${missingId}.json`))).rejects.toThrow();
  await writeFile(file, '{synthetic corrupt TOTP fixture');
  await shinano.restart();
  await shinano.command({ type: 'ui:totp-profile', profileId: profile.id });
  expect((await shinano.state()).totp.registrations[0]?.status).toBe('unreadable');
  expect((await shinano.page.evaluate(async ({ profileId, registrationId }) =>
    window.shinano.totp.getCode(profileId, registrationId), { profileId: profile.id, registrationId })).ok).toBe(false);
  expect(await readFile(file, 'utf8')).toBe('{synthetic corrupt TOTP fixture');
  await shinano.dialogChoice(1);
  expect(await shinano.page.evaluate(async (profileId) => window.shinano.totp.remove(profileId), profile.id))
    .toEqual({ ok: true, value: { outcome: 'removed' } });
  await expect(access(file)).rejects.toThrow();
});

test('real foreign WebContents cannot invoke any TOTP channel and remote pages have no privileged bridge', async ({ shinano }) => {
  await requireNativeProtection(shinano);
  const profile = (await shinano.state()).profiles[0]!;
  const registrationId = await register(shinano, profile.id);
  const remoteUrl = `${fixture.origin}/totp-untrusted`;
  await shinano.createTab(profile.id, remoteUrl);
  expect(await shinano.remote(remoteUrl, 'typeof window.shinano')).toBe('undefined');
  await shinano.command({ type: 'ui:totp-profile', profileId: profile.id });
  await shinano.dialogChoice(0);
  const results = await shinano.app.evaluate(({ ipcMain, WebContentsView }, args) => new Promise<unknown>((resolve, reject) => {
    const view = new WebContentsView({
      webPreferences: {
        preload: args.preload, nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true,
        additionalArguments: [`--fixture-profile=${args.profileId}`, `--fixture-registration=${args.registrationId}`],
      },
    });
    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.removeListener('shinano-test:totp-denied', receive);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    };
    const receive = (event: Electron.IpcMainEvent, value: unknown) => {
      if (event.sender !== view.webContents) return;
      cleanup();
      resolve(value);
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Foreign IPC fixture timed out.')); }, 8000);
    ipcMain.on('shinano-test:totp-denied', receive);
    void view.webContents.loadURL(args.url).catch(() => { cleanup(); reject(new Error('Foreign IPC fixture failed to load.')); });
  }), {
    preload: fileURLToPath(new URL('./totp-probe.cjs', import.meta.url)),
    profileId: profile.id, registrationId, url: `${fixture.origin}/totp-probe`,
  });
  expect(results).toEqual([true, true, true, true]);
  expect((await code(shinano, profile.id, registrationId)).registrationId).toBe(registrationId);
});

test('the real panel reveals explicitly, rolls over, copies fresh codes and clears on deactivation', async ({ shinano }) => {
  test.setTimeout(75_000);
  await requireNativeProtection(shinano);
  const profile = (await shinano.state()).profiles[0]!;
  const registrationId = await register(shinano, profile.id);
  await expect(shinano.page.locator('#totp-code')).not.toHaveText(/^\d{6}$/);
  await shinano.page.getByRole('button', { name: 'コードを表示', exact: true }).click();
  await expect(shinano.page.locator('#totp-code')).toHaveText(/^\d{6}$/);
  const first = await code(shinano, profile.id, registrationId);
  await expect(shinano.page.locator('#totp-remaining')).toContainText(/秒/);
  await expect.poll(async () => Date.now() >= first.validUntil + 350, { timeout: 35_000 }).toBe(true);
  const next = await code(shinano, profile.id, registrationId);
  expect(next.validFrom).toBeGreaterThanOrEqual(first.validUntil);
  await expect(shinano.page.locator('#totp-code')).toHaveText(expectedCode(next));
  await shinano.app.evaluate(({ clipboard }) => {
    let captured = { text: '', at: 0 };
    clipboard.writeText = async (text) => {
      if (!/^\d{6}$/.test(text)) throw new Error('Copy did not receive a six-digit synthetic code.');
      captured = { text, at: Date.now() };
    };
    clipboard.readText = async () => JSON.stringify(captured);
  });
  await shinano.page.getByRole('button', { name: 'コピー', exact: true }).click();
  await expect(shinano.page.locator('#totp-code')).toHaveText(/^\d{6}$/);
  await expect.poll(async () => JSON.parse(await shinano.app.evaluate(({ clipboard }) => clipboard.readText())).text)
    .toMatch(/^\d{6}$/);
  const captured = JSON.parse(await shinano.app.evaluate(({ clipboard }) => clipboard.readText()));
  expect(captured.text).toBe(expectedCode({ ...next, validFrom: Math.floor(captured.at / 30_000) * 30_000 }));
  await shinano.page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(shinano.page.locator('#totp-code')).not.toHaveText(/^\d{6}$/);
  await shinano.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(shinano.page.locator('#totp-code')).not.toHaveText(/^\d{6}$/);
  await shinano.command({ type: 'ui:panel', panel: 'profiles' });
  await expect(shinano.page.locator('#totp-code')).toHaveCount(0);
});

test('the local import form clears secrets on cancel, failure, save and profile change', async ({ shinano }) => {
  await requireNativeProtection(shinano);
  const a = (await shinano.state()).profiles[0]!;
  const b = (await shinano.command({ type: 'profile:create', name: 'Form fixture B', color: 'orange' })).profiles[1]!;
  await shinano.command({ type: 'ui:totp-profile', profileId: a.id });
  const input = shinano.page.locator('#totp-input');
  await shinano.page.locator('#totp-add').click();
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(publicBase32);
  const cancelled = await secretField(shinano);
  await shinano.page.locator('#totp-cancel').click();
  expect(await cancelled.evaluate((node) => node.value)).toBe('');
  await cancelled.dispose();
  await expect(input).toHaveCount(0);
  await shinano.page.locator('#totp-add').click();
  await input.fill(`${publicBase32}!`);
  const failed = await secretField(shinano);
  await shinano.page.locator('#totp-save').click();
  expect(await failed.evaluate((node) => node.value)).toBe('');
  await failed.dispose();
  await expect.poll(async () => (await shinano.state()).notice).toBeTruthy();
  expect((await shinano.state()).totp.registrations.find((entry) => entry.profileId === a.id)?.status).toBe('none');
  if (!(await input.isVisible())) await shinano.page.locator('#totp-add').click();
  await input.fill(publicBase32);
  const saved = await secretField(shinano);
  await shinano.page.locator('#totp-save').click();
  await expect.poll(async () => (await shinano.state()).totp.registrations.find((entry) => entry.profileId === a.id)?.status)
    .toBe('registered');
  expect(await saved.evaluate((node) => node.value)).toBe('');
  await saved.dispose();
  await shinano.page.locator('#totp-replace').click();
  await input.fill(publicBase32);
  const switched = await secretField(shinano);
  await shinano.page.locator('#totp-profile').selectOption(b.id);
  await expect.poll(async () => (await shinano.state()).totp.selectedProfileId).toBe(b.id);
  expect(await switched.evaluate((node) => node.value)).toBe('');
  await switched.dispose();
  await expect(shinano.page.locator('#totp-code')).toHaveCount(0);
  expect(await shinano.page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await shinano.page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
});

test('imported account labels stay literal and the TOTP panel preserves remote view layout', async ({ shinano }) => {
  await requireNativeProtection(shinano);
  const profile = (await shinano.state()).profiles[0]!;
  const remote = await shinano.createTab(profile.id, `${fixture.origin}/totp-layout`);
  const hostileAccount = '<img src=x onerror=fixtureXss=1>';
  const uri = `otpauth://totp/${encodeURIComponent(`Synthetic:${hostileAccount}`)}?secret=${publicBase32}&issuer=Synthetic`;
  await register(shinano, profile.id, uri);
  const remoteViewCount = () => shinano.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return window.contentView.children.filter((view) => view instanceof WebContentsView && view.webContents !== window.webContents).length;
  });
  expect(await remoteViewCount()).toBe(0);
  await shinano.page.locator('#totp-show').click();
  await expect(shinano.page.locator('#totp-account')).toContainText(hostileAccount);
  await expect(shinano.page.locator('#workspace').locator('img, svg, script, iframe, [onerror], [onload]')).toHaveCount(0);
  expect(await shinano.page.evaluate(() => Object.hasOwn(window, 'fixtureXss'))).toBe(false);
  await shinano.page.locator('#totp-back').click();
  await expect.poll(remoteViewCount).toBe(1);
  expect((await shinano.state()).activeTabId).toBe(remote.id);
  await expect(shinano.page.locator('#totp-code')).toHaveCount(0);
  expect(JSON.stringify(fixture.requests)).not.toContain(publicBase32);
});
