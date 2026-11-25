import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, Harness } from './harness.ts';
import { startFixture } from './fixture.ts';
import { totpAt } from '../../src/main/totp.ts';

const passphrase = 'Synthetic portable test passphrase';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // Public RFC test key.
let fixture: Awaited<ReturnType<typeof startFixture>>;
test.beforeAll(async () => { fixture = await startFixture(); });
test.afterAll(async () => { await fixture.close(); });

test('OneDrive-folder backup restores profiles and TOTP into independent userData without browser credentials', async ({ shinano }) => {
  test.skip(!await shinano.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()), 'Real OS protection is unavailable.');
  const path = await mkdtemp(join(tmpdir(), 'shinano-portable-e2e-'));
  const destination = new Harness(join(path, 'destination'));
  const file = join(path, 'Synthetic.shinano-backup');
  try {
    const profile = (await shinano.state()).profiles[0]!;
    await shinano.command({ type: 'profile:update', profileId: profile.id, name: 'Portable synthetic', color: 'purple' });
    const tab = await shinano.createTab(profile.id, `${fixture.origin}/portable?token=synthetic-not-exported`);
    await shinano.remote(tab.url, `window.fixtureWrite('synthetic-source-cookie')`);
    await shinano.command({ type: 'ui:totp-profile', profileId: profile.id });
    const registered = await shinano.page.evaluate(async ({ profileId, secret }) =>
      window.shinano.totp.register(profileId, secret), { profileId: profile.id, secret });
    expect(registered.ok).toBe(true);
    await shinano.command({ type: 'ui:panel', panel: 'backup' });
    await shinano.app.evaluate(({ dialog }, file) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await shinano.page.locator('#backup-export-passphrase').fill(passphrase);
    await shinano.page.locator('#backup-export-confirm').fill(passphrase);
    await shinano.page.locator('#backup-export').click();
    await expect(shinano.page.locator('#backup-feedback')).toContainText('保存しました');
    await expect(shinano.page.locator('#backup-export-passphrase')).toHaveValue('');
    const encrypted = await readFile(file, 'utf8');
    for (const value of [profile.id, secret, passphrase, 'Portable synthetic', 'synthetic-source-cookie', 'synthetic-not-exported']) {
      expect(encrypted).not.toContain(value);
    }
    await destination.start();
    await destination.command({ type: 'ui:panel', panel: 'backup' });
    const before = await destination.state();
    await destination.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, file);
    await destination.page.locator('#backup-import-passphrase').fill('Wrong synthetic passphrase');
    await destination.page.locator('#backup-import').click();
    await expect(destination.page.locator('#backup-feedback')).toContainText('パスフレーズが違う');
    expect((await destination.state()).profiles).toEqual(before.profiles);
    const tampered = JSON.parse(encrypted);
    const tag = Buffer.from(tampered.tag, 'base64');
    tag[0] = tag[0]! ^ 1;
    tampered.tag = tag.toString('base64');
    await writeFile(file, JSON.stringify(tampered));
    await destination.page.locator('#backup-import-passphrase').fill(passphrase);
    await destination.page.locator('#backup-import').click();
    await expect(destination.page.locator('#backup-feedback')).toContainText('パスフレーズが違う');
    expect((await destination.state()).profiles).toEqual(before.profiles);
    await writeFile(file, encrypted);
    await destination.page.locator('#backup-import-passphrase').fill(passphrase);
    await destination.page.locator('#backup-import').click();
    await expect(destination.page.locator('#backup-feedback')).toContainText('再起動してください');
    await expect(destination.page.locator('#backup-import-passphrase')).toHaveValue('');
    expect((await destination.page.evaluate(async () =>
      window.shinano.dispatch({ type: 'profile:create', name: 'Blocked until restart', color: 'blue' }))).ok).toBe(false);
    await destination.restart();
    const restored = await destination.state();
    await destination.waitForTab(tab.id);
    expect(restored.profiles).toContainEqual({ id: profile.id, name: 'Portable synthetic', color: 'purple' });
    expect(restored.profiles).toHaveLength(before.profiles.length + 1);
    expect(restored.tabs.find((entry) => entry.id === tab.id)?.url).toBe(`${fixture.origin}/`);
    expect(await destination.remote(`${fixture.origin}/`, 'window.fixtureRead()')).toEqual({
      cookie: '', local: null, session: null,
    });
    await destination.command({ type: 'ui:totp-profile', profileId: profile.id });
    const registration = (await destination.state()).totp.registrations.find((entry) => entry.profileId === profile.id)!;
    expect(registration.status).toBe('registered');
    const result = await destination.page.evaluate(async ({ profileId, registrationId }) =>
      window.shinano.totp.getCode(profileId, registrationId), {
      profileId: profile.id, registrationId: registration.registrationId!,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.code).toBe(totpAt(Buffer.from('12345678901234567890'), 'SHA1', result.value.generatedAt).code);
    expect(await readFile(join(destination.userData, 'totp', `${profile.id}.json`), 'utf8')).not.toContain(secret);
    await destination.command({ type: 'ui:panel', panel: 'backup' });
    await destination.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    const conflict = await destination.page.evaluate(async (passphrase) => window.shinano.backup.import(passphrase), passphrase);
    expect(JSON.stringify(conflict)).toContain('同じ ID');
    expect((await destination.state()).profiles).toHaveLength(restored.profiles.length);
  } finally {
    await destination.stop();
    await rm(path, { recursive: true, force: true });
  }
});

test('backup input is cleared on mismatch, blur and panel changes; cancellation leaves registrations unchanged', async ({ shinano }) => {
  await shinano.command({ type: 'ui:panel', panel: 'backup' });
  await shinano.page.locator('#backup-export-passphrase').fill(passphrase);
  await shinano.page.locator('#backup-export-confirm').fill('Different synthetic passphrase');
  await shinano.page.locator('#backup-export').click();
  await expect(shinano.page.locator('#backup-feedback')).toContainText('一致しません');
  await expect(shinano.page.locator('#backup-export-passphrase')).toHaveValue('');
  await shinano.page.locator('#backup-import-passphrase').fill(passphrase);
  await shinano.page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(shinano.page.locator('#backup-import-passphrase')).toHaveValue('');
  await shinano.dialogChoice(0);
  const before = await shinano.state();
  const cancelled = await shinano.page.evaluate(async (passphrase) => window.shinano.backup.export(passphrase), passphrase);
  expect(cancelled).toEqual({ ok: true, value: { outcome: 'cancelled' } });
  expect((await shinano.state()).totp).toEqual(before.totp);
  await shinano.page.locator('#backup-import-passphrase').fill(passphrase);
  const input = await shinano.page.locator('#backup-import-passphrase').evaluateHandle((node) => node);
  await shinano.command({ type: 'ui:panel', panel: 'profiles' });
  expect(await input.evaluate((node) => {
    if (!(node instanceof HTMLInputElement)) throw new Error('Backup input missing.');
    return node.value;
  })).toBe('');
  const denied = await shinano.page.evaluate(async (passphrase) => window.shinano.backup.import(passphrase), passphrase);
  expect(denied.ok).toBe(false);
  await input.dispose();
});
