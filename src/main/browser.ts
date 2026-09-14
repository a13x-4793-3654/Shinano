import {
  dialog, WebContentsView,
  type BrowserWindow, type LoadURLOptions, type WebContents, type WindowOpenHandlerResponse,
} from 'electron';
import { randomUUID } from 'node:crypto';
import {
  CHANNELS, CHROME_HEIGHT, MAX_PROFILES, MAX_TABS,
  type BrowserState, type Command, type Panel, type Profile, type SavedState, type Tab,
} from '../shared/model.ts';
import { isTabUrl, navigationUrl, restoreUrl, UserError } from '../shared/validation.ts';
import { frameNavigationAllowed, remotePreferences } from './security.ts';
import { ProfileSessions } from './sessions.ts';
import { StateStore } from './store.ts';

interface LiveTab {
  state: Tab;
  view: WebContentsView;
  loadAttempt: number;
  localBlank: boolean;
  committedUrl: string;
}

// The documented createWindow payload includes a guest that Electron's callback type omits.
type NativeWindowOptions = Parameters<NonNullable<WindowOpenHandlerResponse['createWindow']>>[0]
  & { webContents?: WebContents };

export class BrowserController {
  private profiles: Profile[];
  private readonly tabs = new Map<string, LiveTab>();
  private order: string[] = [];
  private activeTabId: string | null = null;
  private panel: Panel = 'new-tab';
  private notice: string | null = null;
  private deletedProfileIds: string[];
  private attached: WebContentsView | null = null;
  private stopping = false;
  private quitting = false;
  private notificationPending = false;
  private revision = 0;
  private commands: Promise<void> = Promise.resolve();
  readonly sessions: ProfileSessions;

  constructor(readonly window: BrowserWindow, private readonly store: StateStore, saved: SavedState) {
    this.profiles = saved.profiles;
    this.deletedProfileIds = saved.deletedProfileIds;
    this.sessions = new ProfileSessions({
      window,
      profile: (profileId) => this.profiles.find((profile) => profile.id === profileId),
      ownsContents: (profileId, contents) => [...this.tabs.values()]
        .some((tab) => tab.state.profileId === profileId && tab.view.webContents === contents),
      notice: (message) => this.notify(message),
      changed: () => this.changed(),
    });
    for (const tab of saved.tabs) {
      this.addTab(tab.profileId, tab.restoreUrl, { id: tab.id, activate: false, persist: false });
    }
    this.activeTabId = saved.activeTabId;
    this.panel = saved.activeTabId ? 'none' : 'new-tab';
    window.on('resize', () => this.layout());
    window.on('closed', () => {
      this.stopping = true;
      this.destroyContents();
    });
    this.changed();
  }

  state(): BrowserState {
    return {
      revision: this.revision,
      profiles: this.profiles.map((profile) => ({ ...profile })),
      tabs: this.order.flatMap((tabId) => {
        const tab = this.tabs.get(tabId);
        return tab ? [{ ...tab.state }] : [];
      }),
      activeTabId: this.activeTabId,
      panel: this.panel,
      notice: this.notice,
      downloads: this.sessions.downloads.map((download) => ({ ...download })),
    };
  }

  private savedState(): SavedState {
    return {
      version: 1,
      profiles: this.profiles.map((profile) => ({ ...profile })),
      tabs: this.state().tabs.map((tab) => ({
        id: tab.id, profileId: tab.profileId, restoreUrl: restoreUrl(tab.url),
      })),
      activeTabId: this.activeTabId,
      deletedProfileIds: [...this.deletedProfileIds],
    };
  }

  private persist(): void {
    try {
      this.store.save(this.savedState());
    } catch {
      throw new UserError('変更をディスクに保存できませんでした。空き容量と userData の権限を確認してください。保存できない変更は再起動時に失われます。');
    }
  }

  private persistFromEvent(): void {
    if (this.stopping) return;
    try {
      this.persist();
    } catch (error) {
      this.notify(error instanceof UserError ? error.message : 'タブの状態を保存できませんでした。');
    }
  }

  notify(message: string): void {
    this.notice = message;
    this.changed();
  }

  private changed(): void {
    this.revision++;
    this.layout();
    if (this.notificationPending || this.stopping) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
        this.window.webContents.send(CHANNELS.changed, this.state());
      }
    });
  }

  private layout(): void {
    if (this.window.isDestroyed()) return;
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    const visible = !this.stopping && this.panel === 'none' && active
      && !active.state.isStartPage && !active.state.error && !active.view.webContents.isDestroyed()
      ? active.view : null;
    if (this.attached !== visible) {
      if (this.attached) this.window.contentView.removeChildView(this.attached);
      this.attached = visible;
      if (visible) this.window.contentView.addChildView(visible);
    }
    if (visible) {
      const { width, height } = this.window.getContentBounds();
      visible.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) });
    }
  }

  private profile(profileId: string): Profile {
    const profile = this.profiles.find((entry) => entry.id === profileId);
    if (!profile) throw new UserError('プロファイルが見つかりません。');
    return profile;
  }

  private tab(tabId: string): LiveTab {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) throw new UserError('タブはすでに閉じられています。');
    return tab;
  }

  private addTab(
    profileId: string,
    url: string,
    options: {
      id?: string;
      activate?: boolean;
      persist?: boolean;
      nativeWindow?: NativeWindowOptions;
      loadOptions?: LoadURLOptions;
    } = {},
  ): LiveTab {
    this.profile(profileId);
    if (this.tabs.size >= MAX_TABS) throw new UserError(`タブは最大 ${MAX_TABS} 個です。不要なタブを閉じてください。`);
    const profileSession = this.sessions.get(profileId);
    const nativeContents = options.nativeWindow?.webContents;
    if (nativeContents && nativeContents.session !== profileSession) {
      throw new UserError('ポップアップのセッションが一致しないため、開けませんでした。');
    }
    const view = new WebContentsView(nativeContents
      ? { webContents: nativeContents }
      : { webPreferences: { ...options.nativeWindow?.webPreferences, ...remotePreferences(profileSession) } });
    const live: LiveTab = {
      view,
      loadAttempt: 0,
      localBlank: !options.nativeWindow,
      committedUrl: 'about:blank',
      state: {
        id: options.id ?? randomUUID(), profileId, url,
        title: '新しいタブ', loading: false, canGoBack: false, canGoForward: false, error: null,
        isStartPage: !options.nativeWindow && url === 'about:blank',
      },
    };
    this.tabs.set(live.state.id, live);
    this.order.push(live.state.id);
    this.wireTab(live);
    if (options.activate !== false) {
      this.activeTabId = live.state.id;
      this.panel = 'none';
    }
    this.changed();
    // Native guests already have their opener, navigation and POST body. Never reload them.
    if (!nativeContents) this.load(live, url, options.loadOptions);
    if (options.persist !== false) {
      if (options.nativeWindow) this.persistFromEvent();
      else this.persist();
    }
    if (options.activate !== false && this.attached === view) view.webContents.focus();
    return live;
  }

  private load(tab: LiveTab, url: string, options?: LoadURLOptions): void {
    const attempt = ++tab.loadAttempt;
    tab.state.error = null;
    tab.state.url = url;
    void tab.view.webContents.loadURL(url, options).catch((error: unknown) => {
      if (tab.view.webContents.isDestroyed() || attempt !== tab.loadAttempt) return;
      const aborted = error && typeof error === 'object'
        && (('code' in error && error.code === 'ERR_ABORTED') || ('errno' in error && error.errno === -3));
      if (aborted) {
        // A cancelled navigation must not leave the old page under a new URL.
        tab.state.url = tab.committedUrl;
        tab.state.isStartPage = tab.state.url === 'about:blank' && tab.localBlank;
        tab.state.loading = false;
        this.persistFromEvent();
        this.changed();
        return;
      }
      // Never include Electron's error message: it can contain an authentication URL.
      tab.state.error ??= 'ページの読み込みを開始できませんでした。接続先を確認して再試行してください。';
      tab.state.loading = false;
      this.changed();
    });
  }

  private wireTab(tab: LiveTab): void {
    const contents = tab.view.webContents;
    const updateNavigation = (url: string) => {
      if (!this.tabs.has(tab.state.id)) return;
      tab.state.url = url;
      tab.committedUrl = url;
      tab.state.isStartPage = url === 'about:blank' && tab.localBlank;
      tab.state.canGoBack = contents.navigationHistory.canGoBack();
      tab.state.canGoForward = contents.navigationHistory.canGoForward();
      this.persistFromEvent();
      this.changed();
    };
    contents.on('did-navigate', (_event, url) => updateNavigation(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) updateNavigation(url);
    });
    contents.on('did-start-loading', () => {
      tab.state.loading = true;
      this.changed();
    });
    contents.on('did-stop-loading', () => {
      tab.state.loading = false;
      if (!contents.isDestroyed()) {
        tab.state.canGoBack = contents.navigationHistory.canGoBack();
        tab.state.canGoForward = contents.navigationHistory.canGoForward();
      }
      this.changed();
    });
    contents.on('page-title-updated', (_event, title) => {
      tab.state.title = title.slice(0, 160) || '無題のページ';
      this.changed();
    });
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      if (isTabUrl(url)) tab.state.url = url;
      tab.state.loading = false;
      tab.state.error = `ページを読み込めませんでした（Chromium エラー ${code}）。接続先、ネットワーク、証明書を確認してください。TLS エラーは回避しません。`;
      this.changed();
    });
    contents.on('render-process-gone', (_event, details) => {
      if (this.stopping) return;
      tab.state.loading = false;
      tab.state.error = `ページのプロセスが停止しました（${details.reason}）。再読み込みしてください。`;
      this.changed();
    });
    contents.on('will-frame-navigate', (event) => {
      if (!frameNavigationAllowed(event.url, event.isMainFrame)) {
        event.preventDefault();
        this.unsupportedNavigation();
      }
    });
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      if (!frameNavigationAllowed(url, isMainFrame)) {
        event.preventDefault();
        this.unsupportedNavigation();
      }
    });
    contents.on('content-bounds-updated', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-prevent-unload', (event) => {
      const choice = dialog.showMessageBoxSync(this.window, {
        type: 'warning',
        title: 'ページを離れる',
        message: 'ページに未保存の変更がある可能性があります。',
        detail: '離れると入力内容が失われる場合があります。',
        buttons: ['戻る', 'ページを離れる'],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (choice === 1) event.preventDefault();
    });
    contents.on('before-input-event', (event, input) => this.handleInput(event, input));
    contents.setWindowOpenHandler((details) => {
      if (this.stopping || this.quitting || !isTabUrl(details.url) || !this.profiles.some((profile) => profile.id === tab.state.profileId)) {
        this.unsupportedNavigation();
        return { action: 'deny' };
      }
      if (this.tabs.size >= MAX_TABS) {
        this.notify(`新しいタブを開けません。タブ数の上限は ${MAX_TABS} 個です。`);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: remotePreferences(contents.session) },
        createWindow: (options) => {
          const loadOptions: LoadURLOptions = { httpReferrer: details.referrer };
          if (details.postBody) {
            loadOptions.postData = details.postBody.data;
            const boundary = details.postBody.boundary ? `; boundary=${details.postBody.boundary}` : '';
            loadOptions.extraHeaders = `Content-Type: ${details.postBody.contentType}${boundary}`;
          }
          // Background/noopener links can arrive without a native guest. Retain the
          // supplied preferences, referrer and POST data for that supported API path.
          return this.addTab(tab.state.profileId, details.url, {
            nativeWindow: options,
            activate: details.disposition !== 'background-tab',
            loadOptions,
          }).view.webContents;
        },
      };
    });
    contents.once('destroyed', () => this.removeTab(tab.state.id));
  }

  private unsupportedNavigation(): void {
    this.notify('このリンクは開けません。HTTP / HTTPS と空のポップアップに対応しています。外部アプリ、ファイル、その他の認証ハンドオフは未対応で、自動転送しません。');
  }

  private removeTab(tabId: string, persist = true): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const index = this.order.indexOf(tabId);
    if (this.attached === tab.view) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      this.attached = null;
    }
    this.tabs.delete(tabId);
    this.order = this.order.filter((entry) => entry !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.order[Math.min(index, this.order.length - 1)] ?? null;
      if (!this.activeTabId && this.panel === 'none') this.panel = 'new-tab';
    }
    if (!this.stopping) {
      if (persist) this.persistFromEvent();
      this.changed();
    }
  }

  private activate(tabId: string): void {
    const tab = this.tab(tabId);
    this.activeTabId = tabId;
    this.panel = 'none';
    this.persist();
    this.changed();
    if (this.attached === tab.view) tab.view.webContents.focus();
  }

  async dispatch(command: Command): Promise<BrowserState> {
    if (this.quitting || this.stopping) throw new UserError('終了の確認中です。操作は確認を閉じてから再試行してください。');
    const operation = this.commands.then(() => this.executeCommand(command));
    // Rejections reach the caller without poisoning subsequent commands.
    this.commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async executeCommand(command: Command): Promise<BrowserState> {
    if (this.stopping) throw new UserError('Shinano を終了しています。');
    switch (command.type) {
      case 'profile:create':
        if (this.profiles.length >= MAX_PROFILES) throw new UserError(`プロファイルは最大 ${MAX_PROFILES} 個です。`);
        this.profiles.push({ id: randomUUID(), name: command.name, color: command.color });
        this.persist();
        break;
      case 'profile:update':
        Object.assign(this.profile(command.profileId), { name: command.name, color: command.color });
        this.persist();
        break;
      case 'profile:delete':
        await this.deleteProfile(command.profileId);
        break;
      case 'tab:create':
        this.addTab(command.profileId, navigationUrl(command.url));
        break;
      case 'tab:activate':
        this.activate(command.tabId);
        break;
      case 'tab:close':
        this.tab(command.tabId).view.webContents.close({ waitForBeforeUnload: true });
        break;
      case 'tab:navigate': {
        const tab = this.tab(command.tabId);
        const url = navigationUrl(command.input);
        tab.localBlank = true;
        tab.state.isStartPage = url === 'about:blank';
        this.panel = 'none';
        this.load(tab, url);
        this.persist();
        break;
      }
      case 'tab:back': {
        const tab = this.tab(command.tabId);
        if (tab.view.webContents.navigationHistory.canGoBack()) {
          tab.state.error = null;
          tab.view.webContents.navigationHistory.goBack();
        }
        break;
      }
      case 'tab:forward': {
        const tab = this.tab(command.tabId);
        if (tab.view.webContents.navigationHistory.canGoForward()) {
          tab.state.error = null;
          tab.view.webContents.navigationHistory.goForward();
        }
        break;
      }
      case 'tab:reload': {
        const tab = this.tab(command.tabId);
        if (tab.state.error) this.load(tab, tab.state.url);
        else tab.view.webContents.reload();
        break;
      }
      case 'tab:stop': {
        const tab = this.tab(command.tabId);
        tab.loadAttempt++;
        tab.view.webContents.stop();
        tab.state.url = tab.committedUrl;
        tab.state.isStartPage = tab.state.url === 'about:blank' && tab.localBlank;
        tab.state.loading = false;
        this.persist();
        break;
      }
      case 'ui:panel':
        this.panel = command.panel;
        if (command.panel !== 'none') this.window.webContents.focus();
        break;
      case 'ui:dismiss-notice':
        this.notice = null;
        break;
    }
    this.changed();
    if (command.type === 'tab:navigate' && command.tabId === this.activeTabId) {
      this.attached?.webContents.focus();
    }
    return this.state();
  }

  private async deleteProfile(profileId: string): Promise<void> {
    const profile = this.profile(profileId);
    const result = await dialog.showMessageBox(this.window, {
      type: 'warning',
      title: 'ローカル プロファイルの削除',
      message: `「${profile.name}」を Shinano から削除しますか？`,
      detail: 'このプロファイルの全タブを閉じ、Shinano 内の Cookie・サイトデータを削除します。未保存の入力は失われます。残存ファイルは次回起動時に除去します。\nEntra ユーザー、クラウドのアカウント、Edge / Chrome のプロファイル、保存済みダウンロードは削除しません。',
      buttons: ['キャンセル', 'ローカルデータを削除'],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return;
    const candidate = this.savedState();
    candidate.profiles = candidate.profiles.filter((entry) => entry.id !== profileId);
    candidate.tabs = candidate.tabs.filter((entry) => entry.profileId !== profileId);
    if (!candidate.tabs.some((tab) => tab.id === candidate.activeTabId)) {
      candidate.activeTabId = candidate.tabs[0]?.id ?? null;
    }
    candidate.deletedProfileIds.push(profileId);
    // Commit the deletion intent before touching sessions, so a crash cannot resurrect it.
    this.store.save(candidate);
    this.profiles = candidate.profiles;
    this.deletedProfileIds = candidate.deletedProfileIds;
    this.activeTabId = candidate.activeTabId;
    for (const tab of [...this.tabs.values()]) {
      if (tab.state.profileId === profileId) {
        this.removeTab(tab.state.id, false);
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
    }
    this.changed();
    try {
      await this.sessions.clear(profileId);
    } catch {
      throw new UserError('削除は記録されましたが、サイトデータの消去が完了しませんでした。Shinano を再起動すると、残存データの除去を再試行します。');
    }
    this.notify('ローカル プロファイルを削除しました。残存ファイルは次回起動時に除去します。クラウドのアカウントには変更していません。');
  }

  cycleTabs(direction: number): void {
    if (!this.order.length) return;
    const index = this.activeTabId ? this.order.indexOf(this.activeTabId) : 0;
    const tabId = this.order[(index + direction + this.order.length) % this.order.length];
    if (tabId) this.menuCommand({ type: 'tab:activate', tabId });
  }

  handleInput(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown') return;
    const primary = process.platform === 'darwin' ? input.meta : input.control;
    const key = input.key.toLowerCase();
    let action: (() => void) | undefined;
    if (input.control && key === 'tab') action = () => this.cycleTabs(input.shift ? -1 : 1);
    else if (primary && !input.alt) {
      switch (key) {
        case 'l': action = () => this.focusAddress(); break;
        case 't': action = () => this.menuCommand({ type: 'ui:panel', panel: 'new-tab' }); break;
        case 'w': action = () => this.activeCommand('tab:close'); break;
        case 'r': action = () => this.activeCommand('tab:reload'); break;
        case '+':
        case '=': action = () => this.zoom(1); break;
        case '-': action = () => this.zoom(-1); break;
        case '0': action = () => this.zoom(null); break;
        default:
          if (/^[1-9]$/.test(key)) action = () => this.selectTab(Number(key) - 1);
      }
    } else if (input.alt && !primary) {
      if (key === 'arrowleft') action = () => this.activeCommand('tab:back');
      if (key === 'arrowright') action = () => this.activeCommand('tab:forward');
    }
    if (action) {
      // WebContentsView keyboard routing must work even without a native menu accelerator.
      event.preventDefault();
      action();
    }
  }

  selectTab(index: number): void {
    const tabId = index === 8 ? this.order.at(-1) : this.order[index];
    if (tabId) this.menuCommand({ type: 'tab:activate', tabId });
  }

  menuCommand(command: Command): void {
    void this.dispatch(command).catch((error: unknown) => {
      this.notify(error instanceof UserError ? error.message : '操作を完了できませんでした。');
    });
  }

  activeCommand(type: 'tab:close' | 'tab:reload' | 'tab:back' | 'tab:forward'): void {
    if (this.activeTabId) this.menuCommand({ type, tabId: this.activeTabId });
  }

  focusAddress(): void {
    this.window.webContents.focus();
    this.window.webContents.send(CHANNELS.focusAddress);
  }

  zoom(delta: number | null): void {
    const contents = this.activeTabId ? this.tabs.get(this.activeTabId)?.view.webContents : undefined;
    if (contents && !contents.isDestroyed()) {
      contents.setZoomLevel(delta === null ? 0 : Math.max(-3, Math.min(5, contents.getZoomLevel() + delta)));
    }
  }

  reportForContents(contents: WebContents | null, message: string): void {
    if ([...this.tabs.values()].some((tab) => tab.view.webContents === contents)) this.notify(message);
  }

  async prepareShutdown(): Promise<boolean> {
    this.quitting = true;
    try {
      await this.commands;
      return await this.finishShutdown();
    } finally {
      this.quitting = false;
    }
  }

  private async finishShutdown(): Promise<boolean> {
    if (this.tabs.size || this.sessions.downloads.some((download) => download.status === 'progressing')) {
      const result = await dialog.showMessageBox(this.window, {
        type: 'question',
        title: 'Shinano を終了',
        message: 'タブを保存して Shinano を終了しますか？',
        detail: 'プロファイルとタブの接続先オリジンを保存します。未保存の入力、ページ内の一時状態、進行中のダウンロードは保持しません。',
        buttons: ['キャンセル', '保存して終了'],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) return false;
    }
    this.persist();
    await this.sessions.flush();
    this.stopping = true;
    this.sessions.cancelDownloads();
    this.destroyContents();
    return true;
  }

  private destroyContents(): void {
    for (const tab of [...this.tabs.values()]) {
      if (this.attached === tab.view && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(tab.view);
        this.attached = null;
      }
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
  }
}
