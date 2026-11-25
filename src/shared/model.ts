import type { TotpAPI, TotpState } from './totp.ts';
import type { BackupAPI } from './backup.ts';

export const CHROME_HEIGHT = 154;
export const MAX_PROFILES = 20;
export const MAX_TABS = 50;
export const MIN_ZOOM_LEVEL = -3;
export const MAX_ZOOM_LEVEL = 5;
export const PROFILE_COLORS = ['blue', 'teal', 'purple', 'orange', 'rose', 'slate'] as const;
export type ProfileColor = (typeof PROFILE_COLORS)[number];
export type Panel = 'none' | 'new-tab' | 'profiles' | 'downloads' | 'totp' | 'backup';

export interface Profile {
  id: string;
  name: string;
  color: ProfileColor;
}

export interface Tab {
  id: string;
  profileId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  isStartPage: boolean;
  zoomLevel: number;
}

export interface Download {
  id: string;
  profileId: string;
  fileName: string;
  status: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
}

export interface BrowserState {
  revision: number;
  profiles: Profile[];
  tabs: Tab[];
  activeTabId: string | null;
  panel: Panel;
  notice: string | null;
  downloads: Download[];
  totp: TotpState;
}

export interface SavedTab {
  id: string;
  profileId: string;
  restoreUrl: string;
}

export interface SavedState {
  version: 1;
  profiles: Profile[];
  tabs: SavedTab[];
  activeTabId: string | null;
  deletedProfileIds: string[];
}

export type Command =
  | { type: 'profile:create'; name: string; color: ProfileColor }
  | { type: 'profile:update'; profileId: string; name: string; color: ProfileColor }
  | { type: 'profile:delete'; profileId: string }
  | { type: 'tab:create'; profileId: string; url: string }
  | { type: 'tab:activate'; tabId: string }
  | { type: 'tab:close'; tabId: string }
  | { type: 'tab:navigate'; tabId: string; input: string }
  | { type: 'tab:back'; tabId: string }
  | { type: 'tab:forward'; tabId: string }
  | { type: 'tab:reload'; tabId: string }
  | { type: 'tab:stop'; tabId: string }
  | { type: 'tab:zoom'; tabId: string; delta: -1 | 1 | null }
  | { type: 'ui:panel'; panel: Panel }
  | { type: 'ui:totp-profile'; profileId: string | null }
  | { type: 'ui:dismiss-notice' };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ShinanoAPI {
  backup: BackupAPI;
  totp: TotpAPI;
  getState(): Promise<Result<BrowserState>>;
  dispatch(command: Command): Promise<Result<BrowserState>>;
  onState(listener: (state: BrowserState) => void): () => void;
  onFocusAddress(listener: () => void): () => void;
}

export const CHANNELS = {
  state: 'shinano:state',
  command: 'shinano:command',
  changed: 'shinano:changed',
  focusAddress: 'shinano:focus-address',
} as const;

export const SERVICES = [
  { name: 'Microsoft 365', description: 'アプリのホーム', url: 'https://www.microsoft365.com/', mark: 'M' },
  { name: 'Outlook', description: 'メール・予定表', url: 'https://outlook.office.com/', mark: 'O' },
  { name: 'Teams', description: 'チャット・チーム', url: 'https://teams.microsoft.com/', mark: 'T' },
  { name: 'Microsoft 365 管理センター', description: '管理者向けポータル', url: 'https://admin.microsoft.com/', mark: 'A' },
  { name: 'Microsoft Entra', description: 'ID の管理ポータル', url: 'https://entra.microsoft.com/', mark: 'E' },
  { name: 'Intune', description: 'デバイスの管理ポータル', url: 'https://intune.microsoft.com/', mark: 'I' },
] as const;
