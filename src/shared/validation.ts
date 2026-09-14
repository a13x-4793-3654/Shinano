import {
  MAX_PROFILES, MAX_TABS, PROFILE_COLORS,
  type Command, type Panel, type Profile, type ProfileColor, type SavedState, type SavedTab,
} from './model.ts';

export class UserError extends Error {}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UserError('入力の形式が正しくありません。');
  }
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new UserError('入力の項目が正しくありません。');
  }
}

export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new UserError('ID が正しくありません。');
  }
  return value;
}

export function profileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new UserError('プロファイル名は 1〜40 文字で入力してください。');
  }
  return value.trim();
}

export function profileColor(value: unknown): ProfileColor {
  if (typeof value !== 'string' || !PROFILE_COLORS.some((color) => color === value)) {
    throw new UserError('プロファイルの色を選択してください。');
  }
  return value as ProfileColor;
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new UserError('アドレスの形式が正しくありません。');
  }
  return value.trim();
}

export function parseCommand(value: unknown): Command {
  const command = record(value);
  switch (command.type) {
    case 'profile:create':
      exactKeys(command, ['type', 'name', 'color']);
      return { type: command.type, name: profileName(command.name), color: profileColor(command.color) };
    case 'profile:update':
      exactKeys(command, ['type', 'profileId', 'name', 'color']);
      return { type: command.type, profileId: id(command.profileId), name: profileName(command.name), color: profileColor(command.color) };
    case 'profile:delete':
      exactKeys(command, ['type', 'profileId']);
      return { type: command.type, profileId: id(command.profileId) };
    case 'tab:create':
      exactKeys(command, ['type', 'profileId', 'url']);
      return { type: command.type, profileId: id(command.profileId), url: text(command.url) };
    case 'tab:navigate':
      exactKeys(command, ['type', 'tabId', 'input']);
      return { type: command.type, tabId: id(command.tabId), input: text(command.input) };
    case 'tab:activate':
    case 'tab:close':
    case 'tab:back':
    case 'tab:forward':
    case 'tab:reload':
    case 'tab:stop':
      exactKeys(command, ['type', 'tabId']);
      return { type: command.type, tabId: id(command.tabId) };
    case 'ui:panel': {
      exactKeys(command, ['type', 'panel']);
      const panels: Panel[] = ['none', 'new-tab', 'profiles', 'downloads', 'totp'];
      if (!panels.some((panel) => panel === command.panel)) throw new UserError('画面の指定が正しくありません。');
      return { type: command.type, panel: command.panel as Panel };
    }
    case 'ui:totp-profile':
      exactKeys(command, ['type', 'profileId']);
      return { type: command.type, profileId: command.profileId === null ? null : id(command.profileId) };
    case 'ui:dismiss-notice':
      exactKeys(command, ['type']);
      return { type: command.type };
    default:
      throw new UserError('対応していない操作です。');
  }
}

export function isWebUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isTabUrl(input: string): boolean {
  return input === 'about:blank' || isWebUrl(input);
}

export function navigationUrl(input: string): string {
  const value = text(input);
  if (!value || value === 'about:blank') return 'about:blank';
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
  const isHostPort = /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):\d+(?:[/?#]|$)/i.test(value);
  const candidate = isLocal && !value.includes('://')
    ? `http://${value}`
    : hasScheme && !isHostPort ? value : `https://${value}`;
  if (!isWebUrl(candidate)) {
    throw new UserError('HTTP / HTTPS の URL を入力してください。外部アプリ、ファイル、認証情報付き URL には対応していません。');
  }
  return new URL(candidate).href;
}

export function restoreUrl(input: string): string {
  // Authentication codes can occur in paths as well as queries and fragments.
  return isWebUrl(input) ? `${new URL(input).origin}/` : 'about:blank';
}

export function displayOrigin(input: string): string {
  return isWebUrl(input) ? new URL(input).origin : 'このページ';
}

export function parseSavedState(value: unknown): SavedState {
  const state = record(value);
  exactKeys(state, ['version', 'profiles', 'tabs', 'activeTabId', 'deletedProfileIds']);
  if (state.version !== 1 || !Array.isArray(state.profiles) || !Array.isArray(state.tabs)
    || !Array.isArray(state.deletedProfileIds) || state.profiles.length > MAX_PROFILES || state.tabs.length > MAX_TABS) {
    throw new UserError('保存データの形式またはバージョンが正しくありません。');
  }
  const profiles: Profile[] = state.profiles.map((value: unknown) => {
    const profile = record(value);
    exactKeys(profile, ['id', 'name', 'color']);
    return { id: id(profile.id), name: profileName(profile.name), color: profileColor(profile.color) };
  });
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const tabs: SavedTab[] = state.tabs.map((value: unknown) => {
    const tab = record(value);
    exactKeys(tab, ['id', 'profileId', 'restoreUrl']);
    const url = text(tab.restoreUrl);
    if (!isTabUrl(url) || restoreUrl(url) !== url || !profileIds.has(id(tab.profileId))) {
      throw new UserError('保存されたタブの情報が正しくありません。');
    }
    return { id: id(tab.id), profileId: id(tab.profileId), restoreUrl: url };
  });
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const activeTabId = state.activeTabId === null ? null : id(state.activeTabId);
  const deletedProfileIds = state.deletedProfileIds.map(id);
  if (profileIds.size !== profiles.length || tabIds.size !== tabs.length
    || (activeTabId !== null && !tabIds.has(activeTabId))
    || (tabs.length > 0 && activeTabId === null)
    || new Set(deletedProfileIds).size !== deletedProfileIds.length
    || deletedProfileIds.some((deleted) => profileIds.has(deleted))) {
    throw new UserError('保存データ内の ID の対応が正しくありません。');
  }
  return { version: 1, profiles, tabs, activeTabId, deletedProfileIds };
}
