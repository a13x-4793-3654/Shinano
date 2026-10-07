import {
  app, desktopCapturer, dialog, session,
  type BrowserWindow, type DownloadItem, type Session, type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Download, Profile, SitePermission, SitePermissionName } from '../shared/model.ts';
import { displayOrigin } from '../shared/validation.ts';
import { partitionName } from './store.ts';
import { safeDownloadName } from './security.ts';

interface SessionCallbacks {
  window: BrowserWindow;
  profile: (id: string) => Profile | undefined;
  ownsContents: (id: string, contents: WebContents) => boolean;
  notice: (message: string) => void;
  changed: () => void;
  persistDownloads: (downloads: Download[]) => boolean;
  persistPermissions: (permissions: SitePermission[]) => boolean;
}

export class ProfileSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingDownloads = new Map<string, { profileId: string; item: DownloadItem }>();
  readonly downloads: Download[];
  readonly permissions: SitePermission[];

  constructor(
    private readonly callbacks: SessionCallbacks,
    downloads: Download[],
    permissions: SitePermission[],
  ) {
    this.downloads = downloads.map((download) => ({
      ...download,
      status: download.status === 'progressing' ? 'interrupted' : download.status,
    }));
    this.permissions = permissions.map((permission) => ({ ...permission }));
  }

  get(profileId: string): Session {
    const existing = this.sessions.get(profileId);
    if (existing) return existing;
    const profileSession = session.fromPartition(partitionName(profileId), { cache: true });
    profileSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (!contents || !this.callbacks.ownsContents(profileId, contents)) return false;
      const origin = this.origin(requestingOrigin || details.securityOrigin || details.requestingUrl || '');
      const names = this.permissionNames(permission, details.mediaType ? [details.mediaType] : []);
      return Boolean(origin && names.length && names.every((name) => this.decision(profileId, origin, name) !== 'deny'));
    });
    profileSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (!this.callbacks.ownsContents(profileId, contents) || !details.isMainFrame) {
        callback(false);
        return;
      }
      const origin = this.origin('securityOrigin' in details ? details.securityOrigin ?? details.requestingUrl : details.requestingUrl);
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
      const names = this.permissionNames(permission, mediaTypes);
      if (!origin || !names.length) {
        callback(false);
        this.callbacks.notice(`サイトの権限「${permission}」は安全な確認方法がないため拒否しました。`);
        return;
      }
      void this.resolvePermission(profileId, origin, names).then(callback, () => callback(false));
    });
    profileSession.setDevicePermissionHandler(() => false);
    profileSession.setDisplayMediaRequestHandler((request, callback) => {
      const origin = this.origin(request.securityOrigin);
      if (!origin || !request.userGesture) {
        callback({});
        this.callbacks.notice('画面共有はページ上の明示的な操作からのみ開始できます。');
        return;
      }
      void this.resolveDisplayCapture(profileId, origin, request.audioRequested, callback);
    });
    profileSession.on('will-download', (event, item, contents) => {
      if (!contents || !this.callbacks.ownsContents(profileId, contents) || this.pendingDownloads.size >= 3) {
        event.preventDefault();
        this.callbacks.notice('ダウンロードを拒否しました。元のタブが存在しないか、同時ダウンロード数の上限（3 件）に達しています。');
        return;
      }

      const profile = this.callbacks.profile(profileId);
      const fileName = safeDownloadName(item.getFilename());
      const path = dialog.showSaveDialogSync(this.callbacks.window, {
        title: `${profile?.name ?? 'Shinano'} — ${displayOrigin(contents.getURL())} から保存`,
        buttonLabel: '保存',
        defaultPath: join(app.getPath('downloads'), fileName),
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (!path) {
        event.preventDefault();
        this.callbacks.notice('ダウンロードをキャンセルしました。');
        return;
      }
      item.setSavePath(path);
      const download: Download = {
        id: randomUUID(), profileId, fileName,
        status: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes(),
      };
      if (this.downloads.length >= 30) {
        const finished = this.downloads.findIndex((entry) => entry.status !== 'progressing');
        if (finished >= 0) this.downloads.splice(finished, 1);
      }
      this.downloads.push(download);
      const historySaved = this.callbacks.persistDownloads(this.downloads);
      this.pendingDownloads.set(download.id, { profileId, item });
      item.on('updated', (_event, status) => {
        download.status = status;
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        this.callbacks.changed();
      });
      item.once('done', (_event, status) => {
        download.status = status;
        download.receivedBytes = item.getReceivedBytes();
        this.pendingDownloads.delete(download.id);
        const completedHistorySaved = this.callbacks.persistDownloads(this.downloads);
        const message = status === 'completed'
          ? 'ダウンロードが完了しました。ファイルは自動では開きません。'
          : status === 'cancelled' ? 'ダウンロードがキャンセルされました。' : 'ダウンロードが中断されました。元のページから再試行してください。';
        this.callbacks.notice(completedHistorySaved ? message : `${message} ダウンロード履歴は保存できませんでした。`);
      });
      this.callbacks.notice(historySaved
        ? '保存先を指定したファイルをダウンロードしています。'
        : 'ファイルをダウンロードしていますが、ダウンロード履歴は保存できませんでした。');
    });
    this.sessions.set(profileId, profileSession);
    return profileSession;
  }

  private origin(value: string): string | null {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
    } catch {
      return null;
    }
  }

  private permissionNames(permission: string, mediaTypes: readonly string[]): SitePermissionName[] {
    if (permission === 'media') {
      const names: SitePermissionName[] = [];
      if (mediaTypes.includes('video')) names.push('camera');
      if (mediaTypes.includes('audio')) names.push('microphone');
      return names;
    }
    if (permission === 'notifications' || permission === 'geolocation') return [permission];
    return [];
  }

  private decision(profileId: string, origin: string, permission: SitePermissionName): 'allow' | 'deny' | undefined {
    return this.permissions.find((entry) =>
      entry.profileId === profileId && entry.origin === origin && entry.permission === permission)?.decision;
  }

  private permissionLabel(permission: SitePermissionName): string {
    return {
      camera: 'カメラ',
      microphone: 'マイク',
      notifications: '通知',
      geolocation: '位置情報',
      'display-capture': '画面共有',
    }[permission];
  }

  private saveDecisions(
    profileId: string,
    origin: string,
    names: SitePermissionName[],
    decision: 'allow' | 'deny',
  ): boolean {
    const replaced = new Set(names);
    const next = this.permissions.filter((entry) =>
      entry.profileId !== profileId || entry.origin !== origin || !replaced.has(entry.permission));
    for (const permission of names) {
      next.push({ id: randomUUID(), profileId, origin, permission, decision });
    }
    if (!this.callbacks.persistPermissions(next)) return false;
    this.permissions.splice(0, this.permissions.length, ...next);
    this.callbacks.changed();
    return true;
  }

  private async resolvePermission(profileId: string, origin: string, names: SitePermissionName[]): Promise<boolean> {
    const decisions = names.map((name) => this.decision(profileId, origin, name));
    if (decisions.every((decision) => decision === 'allow')) return true;
    if (decisions.some((decision) => decision === 'deny')) return false;
    const profile = this.callbacks.profile(profileId);
    const labels = names.map((name) => this.permissionLabel(name)).join('・');
    const result = await dialog.showMessageBox(this.callbacks.window, {
      type: 'question',
      title: 'サイト権限',
      message: `${origin} に ${labels} を許可しますか？`,
      detail: `プロファイル「${profile?.name ?? '削除済み'}」だけに適用します。「常に」を選ぶと、このサイトとプロファイルの組み合わせに保存します。`,
      buttons: ['今回拒否', '常に拒否', '今回許可', '常に許可'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response === 1 || result.response === 3) {
      const decision = result.response === 3 ? 'allow' : 'deny';
      if (!this.saveDecisions(profileId, origin, names, decision)) {
        this.callbacks.notice('サイト権限を保存できなかったため、要求を拒否しました。');
        return false;
      }
    }
    return result.response === 2 || result.response === 3;
  }

  private async resolveDisplayCapture(
    profileId: string,
    origin: string,
    audioRequested: boolean,
    callback: (streams: Electron.Streams) => void,
  ): Promise<void> {
    try {
      if (!await this.resolvePermission(profileId, origin, ['display-capture'])) {
        callback({});
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const visible = sources.slice(0, 8);
      if (!visible.length) {
        callback({});
        this.callbacks.notice('共有できる画面またはウィンドウが見つかりませんでした。');
        return;
      }
      const result = await dialog.showMessageBox(this.callbacks.window, {
        type: 'question',
        title: '共有する画面を選択',
        message: `${origin} と共有する画面またはウィンドウを選択してください。`,
        buttons: ['キャンセル', ...visible.map((source) => source.name.slice(0, 60))],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      const source = visible[result.response - 1];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, ...(audioRequested && process.platform === 'win32' ? { audio: 'loopbackWithMute' as const } : {}) });
    } catch {
      callback({});
      this.callbacks.notice('画面共有を開始できませんでした。OS の画面収録権限を確認してください。');
    }
  }

  clearPermission(permissionId: string): boolean {
    const next = this.permissions.filter((permission) => permission.id !== permissionId);
    if (next.length === this.permissions.length) return true;
    if (!this.callbacks.persistPermissions(next)) return false;
    this.permissions.splice(0, this.permissions.length, ...next);
    this.callbacks.changed();
    return true;
  }

  clearProfilePermissions(profileId: string): boolean {
    const next = this.permissions.filter((permission) => permission.profileId !== profileId);
    if (next.length === this.permissions.length) return true;
    if (!this.callbacks.persistPermissions(next)) return false;
    this.permissions.splice(0, this.permissions.length, ...next);
    this.callbacks.changed();
    return true;
  }

  async clear(profileId: string): Promise<void> {
    for (const download of this.pendingDownloads.values()) {
      if (download.profileId === profileId) download.item.cancel();
    }
    const profileSession = this.get(profileId);
    await profileSession.clearData();
    await profileSession.clearAuthCache();
    await profileSession.closeAllConnections();
    profileSession.flushStorageData();
    await profileSession.cookies.flushStore();
  }

  async flush(): Promise<void> {
    for (const profileSession of this.sessions.values()) {
      profileSession.flushStorageData();
      await profileSession.cookies.flushStore();
    }
  }

  cancelDownloads(): void {
    for (const download of this.pendingDownloads.values()) download.item.cancel();
  }
}
