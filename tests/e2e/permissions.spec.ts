import { fileURLToPath } from 'node:url';
import { test, expect, type Harness } from './harness.ts';
import { startFixture } from './fixture.ts';

const probePath = fileURLToPath(new URL('./permission-probe.cjs', import.meta.url));
let fixture: Awaited<ReturnType<typeof startFixture>>;
test.beforeAll(async () => { fixture = await startFixture(); });
test.afterAll(async () => { await fixture.close(); });

async function probe<T>(harness: Harness, operation: string, input?: unknown): Promise<T> {
  return harness.app.evaluate((_electron, args) => {
    const module = process.getBuiltinModule('module').createRequire(args.path)(args.path);
    return module[args.operation](args.input);
  }, { path: probePath, operation, input });
}

async function setup(harness: Harness) {
  const profileId = (await harness.state()).profiles[0]!.id;
  await probe(harness, 'setup', profileId);
  const url = `${fixture.origin}/permissions`;
  const tab = await harness.createTab(profileId, url);
  return { profileId, url, tab };
}

test('real clipboard writing and notification requests use explicit profile and origin consent', async ({ shinano }) => {
  const { url, tab } = await setup(shinano);
  await probe(shinano, 'choice', { response: 0 });
  expect(await shinano.remote(url, 'Notification.requestPermission()')).toBe('denied');
  let prompts = await probe<Array<{ message: string; detail: string }>>(shinano, 'prompts');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.message).toContain(fixture.origin);
  expect(prompts[0]!.detail).toContain('デスクトップ通知');
  await shinano.command({ type: 'tab:reload', tabId: tab.id });
  await shinano.waitForTab(tab.id);
  await probe(shinano, 'choice', { response: 1 });
  expect(await shinano.remote(url, 'Notification.requestPermission()')).toBe('granted');
  expect(await shinano.remote(url, `navigator.clipboard.writeText('Synthetic Shinano permission fixture').then(() => 'written')`)).toBe('written');
  expect(await shinano.remote(url, 'navigator.clipboard.readText()')).toBe('Synthetic Shinano permission fixture');
  prompts = await probe(shinano, 'prompts');
  expect(prompts.some(prompt => prompt.detail.includes('クリップボードへの書き込み'))).toBe(true);
  expect(prompts.some(prompt => prompt.detail.includes('クリップボードの読み取り'))).toBe(true);
});

test('real media requests obtain fake camera and microphone tracks only after consent', async ({ shinano }) => {
  await shinano.stop();
  await shinano.start(['--use-fake-device-for-media-stream']);
  const { url } = await setup(shinano);
  await probe(shinano, 'choice', { response: 1 });
  expect(await shinano.remote(url, `(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const kinds = stream.getTracks().map(track => track.kind).sort();
    stream.getTracks().forEach(track => track.stop());
    return kinds;
  })()`)).toEqual(['audio', 'video']);
  const prompts = await probe<Array<{ detail: string }>>(shinano, 'prompts');
  expect(prompts.some(prompt => prompt.detail.includes('マイク'))).toBe(true);
  expect(prompts.some(prompt => prompt.detail.includes('カメラ'))).toBe(true);
});

test('each supported permission is document-scoped and media grants do not imply another device', async ({ shinano }) => {
  const { profileId, url, tab } = await setup(shinano);
  await probe(shinano, 'choice', { response: 1 });
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'geolocation', 'geolocation-approximate']) {
    expect(await probe(shinano, 'check', { profileId, url, permission })).toBe(false);
    expect(await probe(shinano, 'request', { profileId, url, permission })).toBe(true);
    expect(await probe(shinano, 'check', { profileId, url, permission })).toBe(true);
  }
  if (!process.env.GOOGLE_API_KEY) expect((await shinano.state()).notice).toContain('API キーが未設定');
  expect(await probe(shinano, 'request', {
    profileId, url, permission: 'media', details: { mediaTypes: ['audio'] },
  })).toBe(true);
  expect(await probe(shinano, 'check', { profileId, url, permission: 'media', details: { mediaType: 'audio' } })).toBe(true);
  expect(await probe(shinano, 'check', { profileId, url, permission: 'media', details: { mediaType: 'video' } })).toBe(false);
  expect(await probe(shinano, 'request', {
    profileId, url, permission: 'media', details: { mediaTypes: ['video'] },
  })).toBe(true);
  await shinano.command({ type: 'tab:reload', tabId: tab.id });
  await shinano.waitForTab(tab.id);
  expect(await probe(shinano, 'check', { profileId, url, permission: 'clipboard-read' })).toBe(false);
  expect(await probe(shinano, 'check', { profileId, url, permission: 'media', details: { mediaType: 'video' } })).toBe(false);
});

test('permission grants do not transfer to another tab or profile', async ({ shinano }) => {
  const { profileId, url } = await setup(shinano);
  await probe(shinano, 'choice', { response: 1 });
  expect(await probe(shinano, 'request', { profileId, url, permission: 'clipboard-read' })).toBe(true);
  const otherUrl = `${fixture.origin}/permissions-other-tab`;
  await shinano.createTab(profileId, otherUrl);
  expect(await probe(shinano, 'check', { profileId, url: otherUrl, permission: 'clipboard-read' })).toBe(false);
  const state = await shinano.command({ type: 'profile:create', name: 'Permissions B', color: 'rose' });
  const otherProfile = state.profiles.find(profile => profile.id !== profileId)!;
  await probe(shinano, 'setup', otherProfile.id);
  const profileUrl = `${fixture.origin}/permissions-other-profile`;
  await shinano.createTab(otherProfile.id, profileUrl);
  expect(await probe(shinano, 'check', { profileId: otherProfile.id, url: profileUrl, permission: 'clipboard-read' })).toBe(false);
  expect(await probe(shinano, 'request', { profileId, url: profileUrl, permission: 'clipboard-read' })).toBe(false);
});

test('preliminary and legacy desktop capture requests require fresh consent every time', async ({ shinano }) => {
  const { profileId, url } = await setup(shinano);
  const input = { profileId, url, permission: 'media', details: { mediaTypes: [] } };
  await probe(shinano, 'choice', { response: 0 });
  expect(await probe(shinano, 'request', input)).toBe(false);
  await probe(shinano, 'choice', { response: 1 });
  expect(await probe(shinano, 'request', input)).toBe(true);
  await probe(shinano, 'choice', { response: 0 });
  expect(await probe(shinano, 'request', input)).toBe(false);
  const prompts = await probe<Array<{ detail: string }>>(shinano, 'prompts');
  expect(prompts).toHaveLength(3);
  expect(prompts[0]!.detail).toContain('画面全体');
  expect(prompts[0]!.detail).toContain('システム全体の音声');
});

test('denial, foreign frames, background tabs, unsupported permissions and navigation races fail closed', async ({ shinano }) => {
  const { profileId, url, tab } = await setup(shinano);
  await probe(shinano, 'choice', { response: 0 });
  expect(await probe(shinano, 'request', { profileId, url, permission: 'clipboard-read' })).toBe(false);
  expect(await probe(shinano, 'check', { profileId, url, permission: 'clipboard-read' })).toBe(false);
  const before = (await probe<unknown[]>(shinano, 'prompts')).length;
  for (const details of [
    { isMainFrame: false }, { requestingUrl: 'https://other.invalid/' }, { requestingUrl: 'http://insecure.invalid/' },
  ]) {
    expect(await probe(shinano, 'request', { profileId, url, permission: 'notifications', details })).toBe(false);
  }
  expect(await probe(shinano, 'request', { profileId, url, permission: 'usb' })).toBe(false);
  const other = await shinano.createTab(profileId, `${fixture.origin}/background`);
  expect(await probe(shinano, 'request', { profileId, url, permission: 'notifications' })).toBe(false);
  expect((await probe<unknown[]>(shinano, 'prompts')).length).toBe(before);
  await shinano.command({ type: 'tab:activate', tabId: tab.id });
  await probe(shinano, 'choice', { response: 1, hold: true });
  await probe(shinano, 'begin', { profileId, url, permission: 'notifications' });
  await expect.poll(async () => (await probe<unknown[]>(shinano, 'prompts')).length).toBe(before + 1);
  await shinano.command({ type: 'tab:navigate', tabId: tab.id, input: `${fixture.origin}/navigated` });
  await shinano.waitForTab(tab.id);
  await probe(shinano, 'release', 1);
  expect(await probe(shinano, 'pending')).toBe(false);
  await shinano.command({ type: 'tab:activate', tabId: other.id });
  expect(await probe(shinano, 'check', { profileId, url: `${fixture.origin}/background`, permission: 'notifications' })).toBe(false);
});

test('screen sharing requires a user gesture and explicit source choice without implicit system audio', async ({ shinano }) => {
  const { profileId, url } = await setup(shinano);
  expect(await probe(shinano, 'display', { profileId, url, response: 1, gesture: false }))
    .toEqual({ video: null, audio: null });
  expect(await probe(shinano, 'display', { profileId, url, response: 0 }))
    .toEqual({ video: null, audio: null });
  expect(await probe(shinano, 'display', { profileId, url, response: 2 }))
    .toEqual({ video: 'window:fixture:0', audio: null });
  expect(await probe(shinano, 'display', { profileId, url, response: 2, checked: true }))
    .toEqual({ video: 'window:fixture:0', audio: process.platform === 'win32' ? 'loopback' : null });
  const prompts = await probe<Array<{ title: string; buttons: string[] }>>(shinano, 'prompts');
  expect(prompts.at(-1)!.title).toBe('画面共有する対象を選択');
  expect(prompts.at(-1)!.buttons).toContain('画面: Synthetic screen');
});

test('real screen capture requests reach the picker and cancellation starts no capture', async ({ shinano }) => {
  const { url } = await setup(shinano);
  await probe(shinano, 'choice', { response: 1, screenResponse: 0 });
  expect(['NotAllowedError', 'AbortError']).toContain(await shinano.remote(url, `navigator.mediaDevices.getDisplayMedia({ video: true })
    .then(stream => { stream.getTracks().forEach(track => track.stop()); return 'unexpected capture'; })
    .catch(error => error.name)`));
  const prompts = await probe<Array<{ title: string }>>(shinano, 'prompts');
  expect(prompts.some(prompt => prompt.title === '画面共有する対象を選択'),
    JSON.stringify({ calls: await probe(shinano, 'calls'), notice: (await shinano.state()).notice })).toBe(true);
});
