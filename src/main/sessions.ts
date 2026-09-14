import { app, dialog, session, type BrowserWindow, type DownloadItem, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Download, Profile } from '../shared/model.ts';
import { displayOrigin } from '../shared/validation.ts';
import { partitionName } from './store.ts';
import { safeDownloadName } from './security.ts';

interface SessionCallbacks {
  window: BrowserWindow;
  profile: (id: string) => Profile | undefined;
  ownsContents: (id: string, contents: WebContents) => boolean;
  notice: (message: string) => void;
  changed: () => void;
}

export class ProfileSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingDownloads = new Map<string, { profileId: string; item: DownloadItem }>();
  readonly downloads: Download[] = [];

  constructor(private readonly callbacks: SessionCallbacks) {}

  get(profileId: string): Session {
    const existing = this.sessions.get(profileId);
    if (existing) return existing;
    const profileSession = session.fromPartition(partitionName(profileId), { cache: true });
    profileSession.setPermissionCheckHandler(() => false);
    profileSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(false);
      const name = this.callbacks.profile(profileId)?.name ?? '削除済みプロファイル';
      this.callbacks.notice(`${name}: サイトの権限「${permission}」を拒否しました。この版ではカメラ・マイク・通知などの権限は未対応です。`);
    });
    profileSession.setDevicePermissionHandler(() => false);
    profileSession.setDisplayMediaRequestHandler((_request, callback) => {
      callback({});
      this.callbacks.notice('画面共有はこの版では未対応です。権限を許可していません。');
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
      this.downloads.push(download);
      if (this.downloads.length > 30) {
        const finished = this.downloads.findIndex((entry) => entry.status !== 'progressing');
        if (finished >= 0) this.downloads.splice(finished, 1);
      }
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
        this.callbacks.notice(status === 'completed'
          ? 'ダウンロードが完了しました。ファイルは自動では開きません。'
          : status === 'cancelled' ? 'ダウンロードがキャンセルされました。' : 'ダウンロードが中断されました。元のページから再試行してください。');
      });
      this.callbacks.notice('保存先を指定したファイルをダウンロードしています。');
    });
    this.sessions.set(profileId, profileSession);
    return profileSession;
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
