import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  externalProtocol, frameNavigationAllowed, safeDownloadName,
} from '../../src/main/security.ts';
import {
  id, isTabUrl, navigationUrl, parseCommand, parseDownloadHistory, parseSavedPermissions,
  parseSavedState, restoreUrl, UserError,
} from '../../src/shared/validation.ts';
import type { SavedState } from '../../src/shared/model.ts';

const profileId = randomUUID();
const tabId = randomUUID();

function saved(): SavedState {
  return {
    version: 1,
    profiles: [{ id: profileId, name: 'Fixture A', color: 'blue' }],
    tabs: [{ id: tabId, profileId, restoreUrl: 'https://example.com/' }],
    activeTabId: tabId,
    deletedProfileIds: [],
  };
}

test('navigation accepts web URLs, blank pages and loopback development servers', () => {
  for (const [input, expected] of [
    [' example.com/demo ', 'https://example.com/demo'],
    ['https://example.com/path?q=fixture#part', 'https://example.com/path?q=fixture#part'],
    ['http://127.0.0.1:3000/page', 'http://127.0.0.1:3000/page'],
    ['localhost:3000/page', 'http://localhost:3000/page'],
    ['example.com:8443/page', 'https://example.com:8443/page'],
    ['[::1]:3000/', 'http://[::1]:3000/'],
    ['', 'about:blank'],
    ['about:blank', 'about:blank'],
  ]) {
    assert.equal(navigationUrl(input ?? ''), expected);
  }
});

test('navigation sends whitespace queries to Bing without treating explicit schemes as searches', () => {
  assert.equal(navigationUrl('Microsoft 365 管理センター'), 'https://www.bing.com/search?q=Microsoft+365+%E7%AE%A1%E7%90%86%E3%82%BB%E3%83%B3%E3%82%BF%E3%83%BC');
  assert.equal(navigationUrl('contoso'), 'https://contoso/');
  assert.throws(() => navigationUrl('file: fixture'), UserError);
});

test('navigation rejects privileged schemes, external handlers and embedded credentials', () => {
  for (const input of [
    'file:///fixture.txt', 'javascript:alert(1)', 'data:text/html,hello', 'shinano://app/',
    'msteams://fixture', 'mailto:fixture@example.com', 'chrome://settings',
    'https://user:fixture@example.com/', 'https://example.com/\nfile:', 'https://',
  ]) {
    assert.throws(() => navigationUrl(input), UserError, input);
  }
  assert.equal(isTabUrl('about:blank'), true);
  assert.equal(isTabUrl('about:config'), false);
  assert.equal(frameNavigationAllowed('data:text/html,fixture', false), true);
  assert.equal(frameNavigationAllowed('data:text/html,fixture', true), false);
  assert.equal(frameNavigationAllowed('shinano://app/', false), false);
  assert.equal(frameNavigationAllowed('file:///fixture.txt', false), false);
});

test('external app handoff accepts only explicit mail, Teams and Microsoft 365 protocols', () => {
  assert.deepEqual(externalProtocol('mailto:fixture@example.com?subject=Shinano'), {
    url: 'mailto:fixture@example.com?subject=Shinano',
    label: 'メール アプリ',
  });
  assert.deepEqual(externalProtocol('msteams://fixture/path'), {
    url: 'msteams://fixture/path',
    label: 'Microsoft Teams',
  });
  assert.equal(externalProtocol('ms-word:ofe|u|https://example.com/fixture.docx')?.label, 'Microsoft Word');
  assert.equal(externalProtocol('ms-excel:ofe|u|https://example.com/fixture.xlsx')?.label, 'Microsoft Excel');
  for (const value of [
    'https://example.com/', 'file:///fixture.txt', 'javascript:alert(1)', 'ms-settings:privacy',
    'custom-app://fixture', 'msteams:\nfile:///fixture',
  ]) {
    assert.equal(externalProtocol(value), null, value);
  }
});

test('restoration never serializes URL credentials, paths, queries or fragments', () => {
  assert.equal(restoreUrl('https://example.com/fixture-token-path?code=fixture-code#access_token=fixture-token'), 'https://example.com/');
  assert.equal(restoreUrl('https://user:fixture-password@example.com/'), 'about:blank');
  assert.equal(restoreUrl('https://example.com:8443/anything'), 'https://example.com:8443/');
  assert.equal(restoreUrl('shinano://app/'), 'about:blank');
});

test('IPC command validation is exact and does not allow changing a tab profile', () => {
  assert.deepEqual(parseCommand({ type: 'profile:create', name: '  営業 A  ', color: 'teal' }), {
    type: 'profile:create', name: '営業 A', color: 'teal',
  });
  assert.deepEqual(parseCommand({ type: 'tab:create', profileId, url: 'about:blank' }), {
    type: 'tab:create', profileId, url: 'about:blank',
  });
  assert.deepEqual(parseCommand({ type: 'tab:move', tabId, toIndex: 2 }), {
    type: 'tab:move', tabId, toIndex: 2,
  });
  assert.deepEqual(parseCommand({ type: 'tab:save-pdf', tabId }), { type: 'tab:save-pdf', tabId });
  for (const command of [
    null, [], {}, { type: 'run', code: 'fixture' },
    { type: 'profile:create', name: '', color: 'blue' },
    { type: 'profile:create', name: 'x'.repeat(41), color: 'blue' },
    { type: 'profile:create', name: 'Fixture', color: 'url(https://example.com)' },
    { type: 'tab:activate', tabId, profileId },
    { type: 'tab:create', profileId: '../../outside', url: 'https://example.com' },
    { type: 'profile:delete', profileId, confirmed: true },
    { type: 'tab:navigate', tabId, input: 'x'.repeat(8193) },
    { type: 'tab:move', tabId, toIndex: -1 },
    { type: 'tab:move', tabId, toIndex: 1.5 },
    { type: 'ui:panel', panel: 'arbitrary-path' },
    { type: 'ui:dismiss-notice', extra: true },
  ]) {
    assert.throws(() => parseCommand(command), UserError);
  }
});

test('download history validation accepts bounded metadata and rejects paths, duplicates and invalid counters', () => {
  const download = {
    id: randomUUID(), profileId, fileName: 'fixture.txt', status: 'completed' as const,
    receivedBytes: 10, totalBytes: 10,
  };
  assert.deepEqual(parseDownloadHistory({ version: 1, downloads: [download] }), { version: 1, downloads: [download] });
  assert.throws(() => parseDownloadHistory({ version: 1, downloads: [download, download] }), UserError);
  assert.throws(() => parseDownloadHistory({ version: 1, downloads: [{ ...download, fileName: '../fixture.txt' }] }), UserError);
  assert.throws(() => parseDownloadHistory({ version: 1, downloads: [{ ...download, receivedBytes: -1 }] }), UserError);
});

test('site permission validation binds unique decisions to a profile and web origin', () => {
  const permission = {
    id: randomUUID(), profileId, origin: 'https://example.com',
    permission: 'camera' as const, decision: 'allow' as const,
  };
  assert.deepEqual(parseSavedPermissions({ version: 1, permissions: [permission] }), {
    version: 1, permissions: [permission],
  });
  assert.throws(() => parseSavedPermissions({ version: 1, permissions: [permission, { ...permission, id: randomUUID() }] }), UserError);
  assert.throws(() => parseSavedPermissions({ version: 1, permissions: [{ ...permission, origin: 'file://' }] }), UserError);
  assert.throws(() => parseSavedPermissions({ version: 1, permissions: [{ ...permission, permission: 'usb' }] }), UserError);
});

test('restored state rejects ambiguous IDs, orphans, unknown fields and unsanitized URLs', () => {
  assert.deepEqual(parseSavedState(saved()), saved());
  assert.throws(() => id('../../partitions'), UserError);
  const duplicate = saved();
  duplicate.profiles.push({ ...duplicate.profiles[0]! });
  const orphan = saved();
  orphan.profiles = [];
  const unsafe = saved();
  unsafe.tabs[0]!.restoreUrl = 'https://example.com/callback?code=fixture';
  const missingActive = saved();
  missingActive.activeTabId = null;
  const reused = saved();
  reused.deletedProfileIds = [profileId];
  for (const value of [duplicate, orphan, unsafe, missingActive, reused, { ...saved(), password: 'fixture' }, { ...saved(), version: 2 }]) {
    assert.throws(() => parseSavedState(value), UserError);
  }
});

test('download names cannot select a directory or a Windows device', () => {
  assert.equal(safeDownloadName('../../fixture.txt'), '.._.._fixture.txt');
  assert.equal(safeDownloadName('CON.txt'), 'download');
  assert.equal(safeDownloadName(''), 'download');
  assert.equal(safeDownloadName('report.pdf'), 'report.pdf');
  assert.ok(safeDownloadName('a'.repeat(200)).length <= 120);
});
