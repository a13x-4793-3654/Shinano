import {
  desktopCapturer, dialog, systemPreferences, webContents,
  type BrowserWindow, type Session, type WebContents,
} from 'electron';

interface PermissionCallbacks {
  window: BrowserWindow;
  name: () => string;
  owns: (contents: WebContents) => boolean;
  active: (contents: WebContents) => boolean;
  notice: (message: string) => void;
}

interface DocumentPermissions {
  revision: number;
  decisions: Map<string, boolean>;
  pending: boolean;
}

const labels: Readonly<Record<string, string>> = {
  'clipboard-sanitized-write': 'クリップボードへの書き込み',
  'clipboard-read': 'クリップボードの読み取り',
  'deprecated-sync-clipboard-read': 'クリップボードの読み取り',
  notifications: 'デスクトップ通知',
  'display-capture': '画面共有',
  geolocation: '位置情報',
  'geolocation-approximate': 'おおよその位置情報',
  audio: 'マイク',
  video: 'カメラ',
};

export function permissionOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      ? url.origin : null;
  } catch {
    return null;
  }
}

export class SitePermissions {
  private readonly documents = new WeakMap<WebContents, DocumentPermissions>();

  constructor(private readonly callbacks: PermissionCallbacks) {}

  private document(contents: WebContents): DocumentPermissions {
    let document = this.documents.get(contents);
    if (!document) {
      document = { revision: 0, decisions: new Map(), pending: false };
      this.documents.set(contents, document);
      const current = document;
      contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
          current.revision++;
          current.decisions.clear();
        }
      });
    }
    return document;
  }

  private valid(contents: WebContents | null, origin: string | null): contents is WebContents {
    return Boolean(contents && !contents.isDestroyed() && !this.callbacks.window.isDestroyed()
      && this.callbacks.owns(contents) && this.callbacks.active(contents)
      && origin && permissionOrigin(contents.getURL()) === origin);
  }

  install(profileSession: Session): void {
    profileSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const origin = permissionOrigin(requestingOrigin);
      if (!details.isMainFrame || !this.valid(contents, origin)) return false;
      // The standard display-media path still requires the separate source picker.
      if (permission === 'display-capture') return true;
      const document = this.document(contents);
      if (permission === 'media') {
        return Boolean(details.mediaType && document.decisions.get(details.mediaType));
      }
      return Boolean(labels[permission] && document.decisions.get(permission));
    });
    profileSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = permissionOrigin(details.requestingUrl);
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
      const keys = permission === 'media'
        ? mediaTypes?.filter(type => type === 'audio' || type === 'video') ?? []
        : labels[permission] ? [permission] : [];
      // Electron uses an empty mediaTypes array for getDisplayMedia's preliminary check.
      const captureRequest = permission === 'display-capture'
        || (permission === 'media' && mediaTypes?.length === 0);
      if (!origin || !details.isMainFrame || (!keys.length && !captureRequest) || !this.valid(contents, origin)) {
        callback(false);
        this.callbacks.notice(`サイトの権限「${labels[permission] ?? permission}」を拒否しました。未対応の権限、非表示のタブ、外部フレーム、または安全でない接続からは利用できません。`);
        return;
      }
      void this.request(contents, origin, captureRequest ? ['display-capture'] : keys, !captureRequest).then(callback, () => {
        callback(false);
        this.callbacks.notice('サイト権限の確認に失敗しました。許可していません。再試行してください。');
      });
    });
    profileSession.setDevicePermissionHandler(() => false);
    profileSession.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame;
      const contents = frame ? webContents.fromFrame(frame) : null;
      const origin = permissionOrigin(request.securityOrigin);
      if (!request.userGesture || !request.videoRequested || !frame || !contents
        || frame !== contents.mainFrame || !this.valid(contents, origin)) {
        callback({});
        this.callbacks.notice('画面共有を拒否しました。表示中の安全なページで、共有ボタンから操作してください。外部フレームからの共有は許可しません。');
        return;
      }
      const document = this.document(contents);
      const revision = document.revision;
      if (document.pending) {
        callback({});
        this.callbacks.notice('別の権限を確認中のため、画面共有を開始しませんでした。確認後に再試行してください。');
        return;
      }
      document.pending = true;
      const valid = () => this.valid(contents, origin) && document.revision === revision
        && request.frame === frame;
      void (async () => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 },
          });
          if (!valid()) {
            this.callbacks.notice('ページまたはタブが変わったため、画面共有を開始しませんでした。');
            return {};
          }
          if (!sources.length) {
            this.callbacks.notice('共有できる画面がありません。OS の画面収録権限を確認してください。');
            return {};
          }
          let offset = 0;
          while (valid()) {
            const page = sources.slice(offset, offset + 8);
            const buttons = ['キャンセル', ...page.map(source =>
              `${source.id.startsWith('screen:') ? '画面' : 'ウィンドウ'}: ${source.name.replace(/[\r\n]/g, ' ').slice(0, 100)}`)];
            const previous = offset > 0 ? buttons.push('前の候補') - 1 : -1;
            const next = offset + page.length < sources.length ? buttons.push('次の候補') - 1 : -1;
            const result = await dialog.showMessageBox(this.callbacks.window, {
              type: 'question', title: '画面共有する対象を選択',
              message: `${this.callbacks.name()}\n${origin}`,
              detail: `候補 ${offset + 1}〜${offset + page.length} / ${sources.length}\n選んだ画面またはウィンドウの内容がサイトに共有されます。終了時はサイトの共有停止操作を使用してください。`,
              buttons, defaultId: 0, cancelId: 0, noLink: true,
              ...(request.audioRequested && process.platform === 'win32'
                ? { checkboxLabel: 'システム全体の音声も共有する', checkboxChecked: false } : {}),
            });
            if (!valid() || result.response === 0) break;
            if (result.response === previous) { offset -= 8; continue; }
            if (result.response === next) { offset += 8; continue; }
            const source = page[result.response - 1];
            if (!source) break;
            this.callbacks.notice(`${this.callbacks.name()}: ${origin} に画面共有を許可しました。終了時はサイトの共有停止操作を使用してください。`);
            return {
              video: source,
              ...(request.audioRequested && process.platform === 'win32' && result.checkboxChecked
                ? { audio: 'loopback' as const } : {}),
            };
          }
          this.callbacks.notice('画面共有をキャンセルしました。共有は開始していません。');
          return {};
        } finally {
          document.pending = false;
        }
      })().then(callback, () => {
        callback({});
        this.callbacks.notice('画面共有を開始できませんでした。OS の画面収録権限を確認して再試行してください。');
      });
    });
  }

  private async request(contents: WebContents, origin: string, keys: string[], remember = true): Promise<boolean> {
    const document = this.document(contents);
    if (remember && keys.every(key => document.decisions.has(key))) {
      return keys.every(key => document.decisions.get(key));
    }
    if (document.pending) {
      this.callbacks.notice('別の権限を確認中です。確認後にもう一度操作してください。');
      return false;
    }
    document.pending = true;
    const revision = document.revision;
    const valid = () => this.valid(contents, origin) && document.revision === revision;
    try {
      const result = await dialog.showMessageBox(this.callbacks.window, {
        type: 'question', title: 'サイト権限の確認',
        message: `${this.callbacks.name()}\n${origin}`,
        detail: `${keys.map(key => labels[key]).join('・')}を許可しますか？\n${remember
          ? '許可・拒否はこのタブの現在のページだけに適用します。再読み込み・ページ移動・タブを閉じると解除します。'
          : '画面全体・他アプリ・機密情報がサイトに共有される可能性があります。旧式の API ではシステム全体の音声も共有され得ます。毎回確認します。標準の画面共有 API では、次に共有する対象と音声の有無を選択します。'}${keys.some(key => key.includes('clipboard') && key.includes('read'))
          ? '\n他アプリでコピーした機密情報もサイトに渡る可能性があります。' : ''}`,
        buttons: ['拒否', '許可'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (!valid()) {
        this.callbacks.notice('確認中にページまたはタブが変わったため、権限を許可しませんでした。');
        return false;
      }
      let granted = result.response === 1;
      if (granted && process.platform === 'darwin') {
        for (const key of keys) {
          if (!valid()) break;
          if (key === 'audio' || key === 'video') {
            granted = await systemPreferences.askForMediaAccess(key === 'audio' ? 'microphone' : 'camera') && granted;
          }
        }
      }
      if (!valid()) {
        this.callbacks.notice('確認中にページまたはタブが変わったため、権限を許可しませんでした。');
        return false;
      }
      if (remember) for (const key of keys) document.decisions.set(key, granted);
      const locationUnavailable = granted && keys.some(key => key.startsWith('geolocation')) && !process.env.GOOGLE_API_KEY;
      this.callbacks.notice(`${this.callbacks.name()}: ${origin} の${keys.map(key => labels[key]).join('・')}を${granted ? '許可' : '拒否'}しました。${locationUnavailable
        ? '位置情報サービスの API キーが未設定のため、位置取得は利用できません。起動前に GOOGLE_API_KEY の設定が必要です。'
        : granted ? 'OS の設定でも許可が必要な場合があります。' : '再確認するにはページを再読み込みしてください。'}`);
      return granted;
    } finally {
      document.pending = false;
    }
  }
}
