import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CHROME_HEIGHT, type Profile } from '../../src/shared/model.ts';
import { literalDownloadName, startFixture } from './fixture.ts';
import { test, expect, type Harness } from './harness.ts';

let fixture: Awaited<ReturnType<typeof startFixture>>;
let otherOrigin: Awaited<ReturnType<typeof startFixture>>;

test.beforeAll(async () => {
  fixture = await startFixture();
  otherOrigin = await startFixture();
});
test.afterAll(async () => {
  await fixture.close();
  await otherOrigin.close();
});

async function profiles(harness: Harness): Promise<[Profile, Profile]> {
  const first = (await harness.state()).profiles[0];
  if (!first) throw new Error('Default fixture profile missing.');
  await harness.command({ type: 'profile:update', profileId: first.id, name: 'Fixture A', color: 'blue' });
  const result = await harness.command({ type: 'profile:create', name: 'Fixture B', color: 'rose' });
  const second = result.profiles.find((profile) => profile.id !== first.id);
  if (!second) throw new Error('Second fixture profile missing.');
  return [{ ...first, name: 'Fixture A' }, second];
}

async function expectNoInjectedMarkup(harness: Harness): Promise<void> {
  await expect(harness.page.locator('#tabs, #workspace')
    .locator('img, svg, script, iframe, [onerror], [onload], [autofocus]')).toHaveCount(0);
  expect(await harness.page.evaluate(() => Object.hasOwn(window, 'fixtureXss'))).toBe(false);
}

test('Japanese UI requires a profile and edits labels without changing identities', async ({ shinano }) => {
  await expect(shinano.page.getByRole('heading', { name: '役割をひとつのウィンドウに。' })).toBeVisible();
  await shinano.page.screenshot({ path: test.info().outputPath('start-page.png') });
  await shinano.page.getByRole('button', { name: '空のタブを開く', exact: true }).click();
  await expect(shinano.page.getByRole('status')).toContainText('プロファイルを選択');
  expect((await shinano.state()).tabs).toHaveLength(0);
  await shinano.page.getByRole('button', { name: 'プロファイル', exact: true }).click();
  await shinano.page.getByLabel('新しいプロファイル名').fill('営業デモ');
  await shinano.page.getByLabel('新しいプロファイルの色').selectOption('teal');
  await shinano.page.getByRole('button', { name: '作成', exact: true }).click();
  await expect.poll(async () => (await shinano.state()).profiles.length).toBe(2);
  const profile = (await shinano.state()).profiles.find((entry) => entry.name === '営業デモ')!;
  await shinano.page.getByLabel('営業デモ の表示名').fill('管理者デモ');
  await shinano.page.locator(`[data-edit-profile="${profile.id}"]`).getByRole('button', { name: '保存', exact: true }).click();
  expect((await shinano.state()).profiles.find((entry) => entry.id === profile.id)).toMatchObject({ name: '管理者デモ', color: 'teal' });
  await shinano.page.getByRole('button', { name: '新しいタブ', exact: true }).click();
  await shinano.page.getByLabel('タブのプロファイル', { exact: true }).selectOption(profile.id);
  await shinano.page.getByLabel('新しいタブの URL', { exact: true }).fill(`${fixture.origin}/ui`);
  await shinano.page.getByRole('button', { name: 'タブを開く', exact: true }).click();
  await expect(shinano.page.getByRole('tab', { name: '管理者デモ Fixture /ui' })).toBeVisible();
  await expect(shinano.page.locator('#active-profile')).toHaveText('管理者デモ');
});

test('hostile profile names, page titles and pending URLs remain literal in the actual UI DOM', async ({ shinano }) => {
  const pendingUrl = 'https://example.invalid/?q="><img src=x onerror=fixtureXss=1>&amp;';
  const address = shinano.page.getByRole('textbox', { name: 'アドレス', exact: true });
  await address.fill(pendingUrl);
  await address.press('Enter');
  await expect(shinano.page.getByLabel('新しいタブの URL', { exact: true })).toHaveValue(pendingUrl);
  await expectNoInjectedMarkup(shinano);

  const name = `"><svg onload=fixtureXss=1>&'`;
  await shinano.page.getByRole('button', { name: 'プロファイル', exact: true }).click();
  await shinano.page.getByLabel('新しいプロファイル名').fill(name);
  await shinano.page.getByLabel('新しいプロファイルの色').selectOption('teal');
  await shinano.page.getByRole('button', { name: '作成', exact: true }).click();
  await expect.poll(async () => (await shinano.state()).profiles.some((profile) => profile.name === name)).toBe(true);
  const profile = (await shinano.state()).profiles.find((entry) => entry.name === name)!;
  await expect(shinano.page.getByLabel(`${name} の表示名`, { exact: true })).toHaveValue(name);
  await expect(shinano.page.getByLabel(`${name} の色`, { exact: true })).toHaveValue('teal');
  await expectNoInjectedMarkup(shinano);

  await shinano.page.getByRole('button', { name: '新しいタブ', exact: true }).click();
  const picker = shinano.page.getByLabel('タブのプロファイル', { exact: true });
  await expect(picker.locator(`option[value="${profile.id}"]`)).toHaveText(`${name} · ${profile.id.slice(0, 8)}`);
  await picker.selectOption(profile.id);
  await expect(shinano.page.getByLabel('新しいタブの URL', { exact: true })).toHaveValue(pendingUrl);
  const fixtureUrl = `${fixture.origin}/literal-rendering`;
  await shinano.page.getByLabel('新しいタブの URL', { exact: true }).fill(fixtureUrl);
  await shinano.page.getByRole('button', { name: 'タブを開く', exact: true }).click();
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(1);
  const tab = (await shinano.state()).tabs[0]!;
  await shinano.waitForTab(tab.id);
  const title = `Fixture "</span><img src=x onerror=fixtureXss=1>&lt;svg&gt;'`;
  await shinano.remote(fixtureUrl, `document.title = ${JSON.stringify(title)}`);
  const tabElement = shinano.page.locator(`[data-tab-id="${tab.id}"]`);
  await expect(tabElement.locator('.tab-title')).toHaveText(title);
  await expect(tabElement.locator('.profile-badge')).toHaveText(name);
  await expect(tabElement.locator('.tab-select')).toHaveAttribute('title', `${name} | ${title}`);
  await expect(tabElement.locator('.tab-select')).toHaveAttribute('aria-selected', 'true');
  await expect(tabElement.locator('.tab-close')).toHaveAttribute('aria-label', `${name} | ${title} を閉じる`);
  await expect(shinano.page.locator('#active-profile')).toHaveText(name);
  await expectNoInjectedMarkup(shinano);

  await shinano.page.getByRole('button', { name: '新しいタブ', exact: true }).click();
  const draft = 'https://example.invalid/?unsubmitted=">&amp;';
  await shinano.page.getByLabel('新しいタブの URL', { exact: true }).fill(draft);
  await shinano.remote(fixtureUrl, `document.title = ${JSON.stringify(`${title} updated`)}`);
  await expect(tabElement.locator('.tab-title')).toHaveText(`${title} updated`);
  await expect(shinano.page.getByLabel('新しいタブの URL', { exact: true })).toHaveValue(draft);
  await expect(picker).toHaveValue(profile.id);
  await expectNoInjectedMarkup(shinano);
  await tabElement.locator('.tab-select').click();
  expect((await shinano.state()).activeTabId).toBe(tab.id);
  await tabElement.locator('.tab-close').click();
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(0);
});

test('real same-origin cookies, localStorage and IndexedDB share only within a profile in ONE window', async ({ shinano }) => {
  const [a, b] = await profiles(shinano);
  const a1 = await shinano.createTab(a.id, `${fixture.origin}/a1`);
  const b1 = await shinano.createTab(b.id, `${fixture.origin}/b1`);
  const a2 = await shinano.createTab(a.id, `${fixture.origin}/a2`);
  await shinano.remote(`${fixture.origin}/a1`, `window.fixtureWrite('A'); sessionStorage.setItem('fixture-tab', 'A1'); window.fixtureDatabase('A-database')`);
  expect(await shinano.remote(`${fixture.origin}/a2`, 'window.fixtureRead()')).toEqual({
    cookie: 'shinano_fixture=A', local: 'A', session: null,
  });
  expect(await shinano.remote(`${fixture.origin}/a2`, 'window.fixtureDatabase()')).toBe('A-database');
  expect(await shinano.remote(`${fixture.origin}/b1`, 'window.fixtureRead()')).toEqual({ cookie: '', local: null, session: null });
  expect(await shinano.remote(`${fixture.origin}/b1`, 'window.fixtureDatabase()')).toBeNull();
  await shinano.remote(`${fixture.origin}/b1`, `window.fixtureWrite('B'); window.fixtureDatabase('B-database')`);
  expect(await shinano.remote(`${fixture.origin}/a2`, 'window.fixtureRead()')).toMatchObject({ cookie: 'shinano_fixture=A', local: 'A' });
  expect((await shinano.state()).tabs.map((tab) => [tab.id, tab.profileId])).toEqual([[a1.id, a.id], [b1.id, b.id], [a2.id, a.id]]);
  expect(await shinano.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
  const remotePolicy = await shinano.app.evaluate(({ webContents }, origin) => webContents.getAllWebContents()
    .filter((contents) => contents.getURL().startsWith(origin))
    .map((contents) => {
      if (!('getLastWebPreferences' in contents) || typeof contents.getLastWebPreferences !== 'function') {
        throw new Error('Electron preference inspection is unavailable.');
      }
      const prefs: unknown = contents.getLastWebPreferences();
      if (!prefs || typeof prefs !== 'object' || !('nodeIntegration' in prefs) || !('contextIsolation' in prefs)
        || !('sandbox' in prefs) || !('webSecurity' in prefs)) {
        throw new Error('Electron did not report its security preferences.');
      }
      return {
        node: prefs.nodeIntegration, isolation: prefs.contextIsolation,
        sandbox: prefs.sandbox, security: prefs.webSecurity,
        preload: 'preload' in prefs ? prefs.preload : undefined,
      };
    }), fixture.origin);
  expect(remotePolicy).toHaveLength(3);
  for (const policy of remotePolicy) expect(policy).toMatchObject({ node: false, isolation: true, sandbox: true, security: true, preload: undefined });
  expect(await shinano.remote(`${fixture.origin}/a1`, `({ require: typeof require, process: typeof process, api: typeof window.shinano })`)).toEqual({
    require: 'undefined', process: 'undefined', api: 'undefined',
  });
});

test('native window.open preserves opener, profile, named-window reuse and window.close', async ({ shinano }) => {
  const [a, b] = await profiles(shinano);
  await shinano.createTab(a.id, `${fixture.origin}/opener`);
  await shinano.createTab(b.id, `${fixture.origin}/other-profile`);
  await shinano.remote(`${fixture.origin}/opener`, `window.fixtureWrite('A'); window.fixtureChild = window.open('/popup', 'fixture-named'); Boolean(window.fixtureChild)`);
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(3);
  let popup = (await shinano.state()).tabs.find((tab) => tab.url === `${fixture.origin}/popup`)!;
  await shinano.waitForTab(popup.id);
  expect(popup.profileId).toBe(a.id);
  expect(await shinano.remote(`${fixture.origin}/popup`, 'window.opener.location.pathname')).toBe('/opener');
  expect(await shinano.remote(`${fixture.origin}/popup`, 'window.fixtureRead()')).toMatchObject({ cookie: 'shinano_fixture=A', local: 'A' });
  expect(await shinano.remote(`${fixture.origin}/opener`, `window.open('/popup-reused', 'fixture-named') === window.fixtureChild`)).toBe(true);
  await expect.poll(async () => (await shinano.state()).tabs.some((tab) => tab.url === `${fixture.origin}/popup-reused`)).toBe(true);
  expect((await shinano.state()).tabs).toHaveLength(3);
  popup = (await shinano.state()).tabs.find((tab) => tab.id === popup.id)!;
  await shinano.waitForTab(popup.id);
  await shinano.remote(`${fixture.origin}/popup-reused`, `window.opener.postMessage('fixture-reply', location.origin); window.close()`);
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(2);
  expect(await shinano.remote(`${fixture.origin}/opener`, 'window.fixtureChild.closed')).toBe(true);
  expect(await shinano.remote(`${fixture.origin}/opener`, 'window.fixtureMessages')).toContainEqual({
    data: 'fixture-reply', origin: fixture.origin,
  });
  expect(await shinano.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
  expect(await shinano.app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(3);
});

test('target=_blank, POST forms and background links retain their originating profile', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  const opener = await shinano.createTab(a.id, `${fixture.origin}/links`);
  await shinano.remote(`${fixture.origin}/links`, `window.fixtureWrite('A'); document.getElementById('blank-link').click()`);
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(2);
  const linked = (await shinano.state()).tabs.find((tab) => tab.id !== opener.id)!;
  await shinano.waitForTab(linked.id);
  expect(linked.profileId).toBe(a.id);
  expect(await shinano.remote(`${fixture.origin}/linked`, 'document.cookie')).toBe('shinano_fixture=A');
  const beforePost = fixture.requests.length;
  await shinano.remote(`${fixture.origin}/links`, `document.getElementById('post-form').requestSubmit()`);
  await expect.poll(() => fixture.requests.slice(beforePost).some((request) =>
    request.path === '/post' && request.method === 'POST' && request.body === 'sample=local-fixture')).toBe(true);
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(3);
  const post = (await shinano.state()).tabs.find((tab) => tab.url === `${fixture.origin}/post`)!;
  await shinano.waitForTab(post.id);
  expect(fixture.requests.slice(beforePost).filter((request) => request.path === '/post')).toHaveLength(1);
  expect(post.profileId).toBe(a.id);
  expect(await shinano.remote(`${fixture.origin}/post`, 'document.cookie')).toBe('shinano_fixture=A');
  await shinano.command({ type: 'tab:activate', tabId: opener.id });
  const remotePage = shinano.app.context().pages().find((page) => page.url() === `${fixture.origin}/links`);
  expect(remotePage).toBeDefined();
  await remotePage!.locator('#background-link').click({ button: 'middle' });
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(4);
  const background = (await shinano.state()).tabs.find((tab) => tab.url === `${fixture.origin}/background`)!;
  await shinano.waitForTab(background.id);
  expect(background.profileId).toBe(a.id);
  expect((await shinano.state()).activeTabId).toBe(opener.id);
  expect(await shinano.remote(`${fixture.origin}/background`, 'document.cookie')).toBe('shinano_fixture=A');
  expect(await shinano.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
});

test('about:blank popup content is visible and cross-origin postMessage/close works without extra windows', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  await shinano.createTab(a.id, `${fixture.origin}/blank-opener`);
  await shinano.remote(`${fixture.origin}/blank-opener`, `(() => {
    window.blankChild = window.open('about:blank', 'blank-demo');
    blankChild.document.write('<title>Blank fixture popup</title><h1 id="blank-content">Popup content</h1>');
    blankChild.document.close();
  })()`);
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(2);
  const blank = (await shinano.state()).tabs.find((tab) => tab.url === 'about:blank')!;
  expect(blank.isStartPage).toBe(false);
  expect(blank.profileId).toBe(a.id);
  expect(await shinano.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const main = BrowserWindow.getAllWindows()[0]!;
    return main.contentView.children.filter((view) => view instanceof WebContentsView && view.webContents !== main.webContents).length;
  })).toBe(1);
  await shinano.remote(`${fixture.origin}/blank-opener`, 'window.blankChild.close()');
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(1);
  const popupUrl = `${otherOrigin.origin}/auth-popup?target=${encodeURIComponent(fixture.origin)}`;
  await shinano.remote(`${fixture.origin}/blank-opener`, `window.crossChild = window.open(${JSON.stringify(popupUrl)}, 'cross-origin-auth'); Boolean(window.crossChild)`);
  await expect.poll(async () => shinano.remote(`${fixture.origin}/blank-opener`, 'window.fixtureMessages')).toContainEqual({
    data: 'fixture-auth-complete', origin: otherOrigin.origin,
  });
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(1);
  expect(await shinano.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
});

test('profiles, tab identities, cookies and site storage persist across an actual process restart', async ({ shinano }) => {
  const [a, b] = await profiles(shinano);
  const a1 = await shinano.createTab(a.id, `${fixture.origin}/persist-a?code=fixture-secret#token=fixture-fragment`);
  const b1 = await shinano.createTab(b.id, `${fixture.origin}/persist-b`);
  const a2 = await shinano.createTab(a.id, `${fixture.origin}/persist-a2`);
  await shinano.remote(a1.url, `window.fixtureWrite('A'); window.fixtureDatabase('A-persistent')`);
  await shinano.remote(b1.url, `window.fixtureWrite('B'); window.fixtureDatabase('B-persistent')`);
  await shinano.command({ type: 'tab:activate', tabId: b1.id });
  const initialPid = shinano.app.process().pid;
  await shinano.restart();
  expect(shinano.app.process().pid).not.toBe(initialPid);
  await expect.poll(async () => (await shinano.state()).tabs.every((tab) => !tab.loading && tab.title.startsWith('Restored'))).toBe(true);
  const restored = await shinano.state();
  expect(restored.profiles).toEqual([{ ...a, name: 'Fixture A', color: 'blue' }, b]);
  expect(restored.tabs.map((tab) => [tab.id, tab.profileId, tab.url])).toEqual([
    [a1.id, a.id, `${fixture.origin}/`], [b1.id, b.id, `${fixture.origin}/`], [a2.id, a.id, `${fixture.origin}/`],
  ]);
  expect(restored.activeTabId).toBe(b1.id);
  const storage = await shinano.app.evaluate(async ({ webContents }, origin) => Promise.all(
    webContents.getAllWebContents().filter((contents) => contents.getURL() === `${origin}/`)
      .map((contents) => contents.executeJavaScript(`(async () => ({...window.fixtureRead(), database: await window.fixtureDatabase()}))()`)),
  ), fixture.origin);
  expect(storage).toEqual(expect.arrayContaining([
    { cookie: 'shinano_fixture=A', local: 'A', session: null, database: 'A-persistent' },
    { cookie: 'shinano_fixture=B', local: 'B', session: null, database: 'B-persistent' },
  ]));
  expect(storage.filter((item) => item.local === 'A')).toHaveLength(2);
  const metadata = await readFile(join(shinano.userData, 'state.json'), 'utf8');
  for (const sensitive of ['fixture-secret', 'fixture-fragment', 'persist-a', 'A-persistent', 'shinano_fixture']) {
    expect(metadata).not.toContain(sensitive);
  }
  expect(await shinano.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
});

test('profile deletion requires confirmation, clears real local cookies and preserves the other profile', async ({ shinano }) => {
  const [a, b] = await profiles(shinano);
  await shinano.createTab(a.id, `${fixture.origin}/delete-a`);
  await shinano.createTab(b.id, `${fixture.origin}/keep-b`);
  await shinano.remote(`${fixture.origin}/delete-a`, `window.fixtureWrite('A')`);
  await shinano.remote(`${fixture.origin}/keep-b`, `window.fixtureWrite('B')`);
  await shinano.dialogChoice(0);
  await shinano.command({ type: 'profile:delete', profileId: a.id });
  expect((await shinano.state()).profiles).toHaveLength(2);
  expect((await shinano.state()).tabs).toHaveLength(2);
  await shinano.dialogChoice(1);
  await shinano.command({ type: 'profile:delete', profileId: a.id });
  expect((await shinano.state()).profiles.map((profile) => profile.id)).toEqual([b.id]);
  expect((await shinano.state()).tabs.map((tab) => tab.profileId)).toEqual([b.id]);
  expect(await shinano.remote(`${fixture.origin}/keep-b`, 'window.fixtureRead()')).toMatchObject({ cookie: 'shinano_fixture=B', local: 'B' });
  expect(await shinano.app.evaluate(async ({ session }, data) =>
    session.fromPartition(`persist:shinano-${data.id}`).cookies.get({ url: data.origin }), { id: a.id, origin: fixture.origin })).toEqual([]);
  await shinano.restart();
  await expect(access(join(shinano.userData, 'sessions', 'Partitions', `shinano-${a.id}`))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(shinano.userData, 'state.json'), 'utf8')).deletedProfileIds).toEqual([]);
  await expect.poll(async () => (await shinano.state()).tabs[0]?.title).toBe('Restored B');
  expect(await shinano.remote(`${fixture.origin}/`, 'window.fixtureRead()')).toMatchObject({ cookie: 'shinano_fixture=B', local: 'B' });
});

test('view resizing, local panels, activation and closing do not cover chrome or leak WebContents', async ({ shinano }) => {
  const [a, b] = await profiles(shinano);
  const a1 = await shinano.createTab(a.id, `${fixture.origin}/view-a`);
  const b1 = await shinano.createTab(b.id, `${fixture.origin}/view-b`);
  await shinano.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 700));
  const viewBounds = () => shinano.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return window.contentView.children.filter((view) => view instanceof WebContentsView && view.webContents !== window.webContents).map((view) => view.getBounds());
  });
  await expect.poll(viewBounds).toEqual([{ x: 0, y: CHROME_HEIGHT, width: 960, height: 700 - CHROME_HEIGHT }]);
  const contentsBefore = await shinano.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.id).sort());
  await shinano.command({ type: 'ui:panel', panel: 'profiles' });
  expect(await viewBounds()).toEqual([]);
  await expect(shinano.page.getByRole('heading', { name: 'プロファイル', exact: true })).toBeVisible();
  await shinano.command({ type: 'tab:activate', tabId: a1.id });
  await shinano.remote(`${fixture.origin}/view-a`, 'window.resizeTo(200, 200); window.moveTo(0, 0)');
  await expect.poll(viewBounds).toEqual([{ x: 0, y: CHROME_HEIGHT, width: 960, height: 700 - CHROME_HEIGHT }]);
  await shinano.command({ type: 'tab:activate', tabId: b1.id });
  expect(await shinano.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.id).sort())).toEqual(contentsBefore);
  await shinano.command({ type: 'tab:close', tabId: b1.id });
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(1);
  expect((await shinano.state()).activeTabId).toBe(a1.id);
  expect(await shinano.app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(2);
  await shinano.command({ type: 'tab:close', tabId: a1.id });
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(0);
  expect(await viewBounds()).toEqual([]);
  expect(await shinano.app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(1);
});

test('navigation, errors, IPC validation, denied permissions and blocked external handoffs are visible', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  const tab = await shinano.createTab(a.id, `${fixture.origin}/navigation-one`);
  await shinano.command({ type: 'tab:navigate', tabId: tab.id, input: `${fixture.origin}/navigation-two` });
  await expect.poll(async () => (await shinano.state()).tabs[0]?.title).toBe('Fixture /navigation-two');
  await shinano.command({ type: 'tab:back', tabId: tab.id });
  await expect.poll(async () => (await shinano.state()).tabs[0]?.url).toBe(`${fixture.origin}/navigation-one`);
  await shinano.command({ type: 'tab:forward', tabId: tab.id });
  await expect.poll(async () => (await shinano.state()).tabs[0]?.url).toBe(`${fixture.origin}/navigation-two`);
  const invalid = await shinano.page.evaluate(async (tabId) =>
    window.shinano.dispatch({ type: 'tab:navigate', tabId, input: 'file:///fixture-must-not-open.txt' }), tab.id);
  expect(invalid.ok).toBe(false);
  expect((await shinano.state()).notice).toContain('HTTP / HTTPS');
  expect(await shinano.remote(`${fixture.origin}/navigation-two`, `Notification.requestPermission()`)).toBe('denied');
  await expect.poll(async () => (await shinano.state()).notice).toContain('拒否');
  await shinano.remote(`${fixture.origin}/navigation-two`, `window.open('msteams://fixture-only')`);
  await expect.poll(async () => (await shinano.state()).notice).toContain('未対応');
  expect((await shinano.state()).tabs).toHaveLength(1);
  await shinano.command({ type: 'tab:navigate', tabId: tab.id, input: `${fixture.origin}/network-error` });
  await expect(shinano.page.getByRole('heading', { name: 'ページを開けませんでした', exact: true })).toBeVisible();
  expect((await shinano.state()).tabs[0]?.error).toContain('エラー');
  await shinano.command({ type: 'tab:navigate', tabId: tab.id, input: `${fixture.origin}/recovered` });
  await expect.poll(async () => (await shinano.state()).tabs[0]?.title).toBe('Fixture /recovered');
  expect((await shinano.state()).tabs[0]?.error).toBeNull();
});

test('downloads only write to a chosen destination and are never auto-opened', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  await shinano.createTab(a.id, `${fixture.origin}/downloads`);
  const destination = join(shinano.userData, 'fixture-download.txt');
  await shinano.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialogSync = () => path;
  }, destination);
  await shinano.remote(`${fixture.origin}/downloads`, `document.getElementById('download-link').click()`);
  await expect.poll(async () => (await shinano.state()).downloads[0]?.status).toBe('completed');
  expect(await readFile(destination, 'utf8')).toBe('Local Shinano fixture. No credentials.');
  expect((await shinano.state()).downloads[0]?.profileId).toBe(a.id);
  await shinano.command({ type: 'ui:panel', panel: 'downloads' });
  await expect(shinano.page.getByText('shinano-fixture.txt', { exact: true })).toBeVisible();
  await shinano.app.evaluate(({ dialog }) => {
    dialog.showSaveDialogSync = () => '';
  });
  await shinano.command({ type: 'ui:panel', panel: 'none' });
  await shinano.remote(`${fixture.origin}/downloads`, `document.getElementById('download-link').click()`);
  await expect.poll(async () => (await shinano.state()).notice).toContain('キャンセル');
  expect((await shinano.state()).downloads).toHaveLength(1);
});

test('HTML-like download names are displayed literally without entity decoding or element creation', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  const fixtureUrl = `${fixture.origin}/download-label`;
  await shinano.createTab(a.id, fixtureUrl);
  const destination = join(shinano.userData, 'literal-download.txt');
  await shinano.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialogSync = () => path;
  }, destination);
  await shinano.remote(fixtureUrl, `(() => {
    const link = document.getElementById('download-link');
    link.href = '/download-literal';
    link.click();
  })()`);
  await expect.poll(async () => (await shinano.state()).downloads[0]?.status).toBe('completed');
  expect((await shinano.state()).downloads[0]?.fileName).toBe(literalDownloadName);
  await shinano.page.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  const label = shinano.page.locator('.download strong');
  await expect(label).toHaveText(literalDownloadName);
  expect(await label.evaluate((node) => node.childElementCount)).toBe(0);
  await expect(shinano.page.locator('.download p')).toContainText('完了');
  await expectNoInjectedMarkup(shinano);
  expect(await readFile(destination, 'utf8')).toBe('Local Shinano fixture. No credentials.');
});

test('stopping navigation restores the committed URL instead of relabeling the previous page', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  const tab = await shinano.createTab(a.id, `${fixture.origin}/committed`);
  const before = fixture.requests.length;
  await shinano.command({ type: 'tab:navigate', tabId: tab.id, input: `${fixture.origin}/slow` });
  await expect.poll(() => fixture.requests.slice(before).some((request) => request.path === '/slow')).toBe(true);
  await shinano.command({ type: 'tab:stop', tabId: tab.id });
  await expect.poll(async () => (await shinano.state()).tabs[0]?.url).toBe(`${fixture.origin}/committed`);
  expect((await shinano.state()).tabs[0]?.error).toBeNull();
  expect(await shinano.remote(`${fixture.origin}/committed`, 'document.getElementById("path").textContent')).toBe('/committed');
});

test('address submissions follow redirects while genuinely unsubmitted edits are preserved', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  await shinano.createTab(a.id, `${fixture.origin}/redirect-start`);
  const destination = `${otherOrigin.origin}/fixture-redirected`;
  const address = shinano.page.getByRole('textbox', { name: 'アドレス', exact: true });
  await address.fill(`${fixture.origin}/redirect?target=${encodeURIComponent(destination)}`);
  await address.press('Enter');
  await expect.poll(async () => (await shinano.state()).tabs[0]?.url).toBe(destination);
  await expect(address).toHaveValue(destination);
  await address.fill('https://not-submitted.example/');
  await shinano.remote(destination, `location.hash = 'fixture-update'`);
  await expect.poll(async () => (await shinano.state()).tabs[0]?.url).toBe(`${destination}#fixture-update`);
  await expect(address).toHaveValue('https://not-submitted.example/');
});

test('familiar shortcuts reach the trusted chrome from a remote view', async ({ shinano }) => {
  const [a] = await profiles(shinano);
  const tab = await shinano.createTab(a.id, `${fixture.origin}/keyboard`);
  const press = async (url: string, keyCode: string) => {
    // CDP's keyboard API bypasses Electron's before-input-event and native menu routing.
    await shinano.app.evaluate(({ BrowserWindow, webContents, app }, input) => {
      if (process.platform === 'darwin') app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]!.focus();
      const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === input.url);
      if (!contents) throw new Error('Fixture keyboard target missing.');
      const modifiers: Array<'meta' | 'control'> = [process.platform === 'darwin' ? 'meta' : 'control'];
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: input.keyCode, modifiers });
      if (!contents.isDestroyed()) contents.sendInputEvent({ type: 'keyUp', keyCode: input.keyCode, modifiers });
    }, { url, keyCode });
  };
  await press(`${fixture.origin}/keyboard`, 'L');
  await expect(shinano.page.locator('#address')).toBeFocused();
  await press('shinano://app/', 'T');
  await expect.poll(async () => (await shinano.state()).panel).toBe('new-tab');
  expect((await shinano.state()).tabs).toHaveLength(1);
  await shinano.command({ type: 'tab:activate', tabId: tab.id });
  await press(`${fixture.origin}/keyboard`, 'W');
  await expect.poll(async () => (await shinano.state()).tabs.length).toBe(0);
});
