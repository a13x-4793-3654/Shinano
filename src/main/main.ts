import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, session, type MenuItemConstructorOptions } from 'electron';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BrowserController } from './browser.ts';
import { StateStore } from './store.ts';
import { CHANNELS, type BrowserState, type Result } from '../shared/model.ts';
import { parseCommand, UserError } from '../shared/validation.ts';
import { trustedSender } from './security.ts';
import { assertExternalTotpDirectory, TotpStore } from './totp-store.ts';
import { TOTP_CHANNELS } from '../shared/totp.ts';
import { parseTotpCodeRequest, parseTotpProfile, parseTotpRegistration } from '../shared/totp-validation.ts';

app.setName('Shinano');
app.enableSandbox();
const customData = process.env.SHINANO_USER_DATA_DIR;
if (customData && !isAbsolute(customData)) throw new Error('SHINANO_USER_DATA_DIR must be an absolute path.');
const dataRoot = customData ?? join(app.getPath('appData'), 'Shinano');
const sessionRoot = join(dataRoot, 'sessions');
mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
app.setPath('userData', dataRoot);
app.setPath('sessionData', sessionRoot);
protocol.registerSchemesAsPrivileged([{
  scheme: 'shinano',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let controller: BrowserController | undefined;
let shutdownDone = false;
let shutdownPending = false;

function fail(message: string): void {
  dialog.showErrorBox('Shinano', message);
}

async function quit(): Promise<void> {
  if (shutdownPending || shutdownDone) return;
  shutdownPending = true;
  try {
    if (!controller || await controller.prepareShutdown()) {
      shutdownDone = true;
      app.quit();
    }
  } catch {
    fail('終了前のデータ保存に失敗しました。空き容量とファイル権限を確認してから、もう一度終了してください。');
  } finally {
    shutdownPending = false;
  }
}

function menu(browser: BrowserController): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: 'Shinano',
      submenu: [
        { role: 'about' as const }, { type: 'separator' as const },
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const },
        { type: 'separator' as const }, { label: 'Shinano を終了', accelerator: 'Cmd+Q', click: () => void quit() },
      ],
    }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: 'プロファイルを選んで新しいタブ', accelerator: 'CmdOrCtrl+T', click: () => browser.menuCommand({ type: 'ui:panel', panel: 'new-tab' }) },
        { label: 'タブを閉じる', accelerator: 'CmdOrCtrl+W', click: () => browser.activeCommand('tab:close') },
        { label: 'プロファイルを管理', click: () => browser.menuCommand({ type: 'ui:panel', panel: 'profiles' }) },
        { label: '認証コード', click: () => browser.menuCommand({ type: 'ui:panel', panel: 'totp' }) },
        { type: 'separator' },
        { label: '終了', click: () => void quit() },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' }, { role: 'redo', label: 'やり直す' },
        { type: 'separator' }, { role: 'cut', label: '切り取り' }, { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' }, { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { label: 'アドレスを入力', accelerator: 'CmdOrCtrl+L', click: () => browser.focusAddress() },
        { label: '再読み込み', accelerator: 'CmdOrCtrl+R', click: () => browser.activeCommand('tab:reload') },
        { label: '戻る', accelerator: 'Alt+Left', click: () => browser.activeCommand('tab:back') },
        { label: '進む', accelerator: 'Alt+Right', click: () => browser.activeCommand('tab:forward') },
        { type: 'separator' },
        { label: '拡大', accelerator: 'CmdOrCtrl+Plus', click: () => browser.zoom(1) },
        { label: '縮小', accelerator: 'CmdOrCtrl+-', click: () => browser.zoom(-1) },
        { label: '実際のサイズ', accelerator: 'CmdOrCtrl+0', click: () => browser.zoom(null) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, index) => ({
          label: index === 8 ? '最後のタブ' : `タブ ${index + 1}`,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: () => browser.selectTab(index),
        })),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start(): Promise<void> {
  assertExternalTotpDirectory(dataRoot, app.getAppPath());
  const store = new StateStore(dataRoot);
  const totpStore = new TotpStore(dataRoot, safeStorage);
  const saved = store.finishDeletions(store.load(totpStore.hasData()), sessionRoot, (profileId) => totpStore.remove(profileId));
  const uiSession = session.fromPartition('shinano-ui');
  uiSession.setPermissionCheckHandler(() => false);
  uiSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  uiSession.on('will-download', (event) => event.preventDefault());
  const rendererRoot = join(app.getAppPath(), 'dist', 'renderer');
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";
  await uiSession.protocol.handle('shinano', async (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (url.hostname !== 'app' || (pathname !== '/index.html' && !/^\/assets\/[\w-]+\.(js|css)$/.test(pathname))) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const data = await readFile(join(rendererRoot, pathname.slice(1)));
      const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
      return new Response(data, {
        headers: {
          'Content-Type': `${contentType}; charset=utf-8`,
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Application asset unavailable', { status: 404 });
    }
  });
  let documentUrl = 'shinano://app/';
  if (!app.isPackaged && process.env.SHINANO_DEV_URL) {
    const dev = new URL(process.env.SHINANO_DEV_URL);
    if (dev.protocol !== 'http:' || dev.hostname !== '127.0.0.1' || dev.pathname !== '/' || dev.search || dev.hash || dev.username || dev.password) {
      throw new UserError('開発サーバーには 127.0.0.1 の HTTP オリジンのみ指定できます。');
    }
    documentUrl = dev.href;
  }
  const window = new BrowserWindow({
    title: 'Shinano', width: 1280, height: 860, minWidth: 780, minHeight: 580,
    show: false, backgroundColor: '#f5f6fa', autoHideMenuBar: true,
    webPreferences: {
      session: uiSession, preload: join(app.getAppPath(), 'dist', 'main', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, navigateOnDragDrop: false,
    },
  });
  controller = new BrowserController(window, store, saved, totpStore);
  const browser = controller;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => browser.handleInput(event, input));
  window.webContents.on('render-process-gone', () => {
    fail('アプリの操作画面が停止しました。Shinano を再起動してください。');
  });
  window.on('close', (event) => {
    if (!shutdownDone) {
      event.preventDefault();
      void quit();
    }
  });
  menu(browser);
  ipcMain.handle(CHANNELS.state, (event): Result<BrowserState> => {
    if (!trustedSender(event, window.webContents, documentUrl)) {
      return { ok: false, error: 'アプリのメイン操作画面からのみ利用できます。' };
    }
    return { ok: true, value: browser.state() };
  });
  ipcMain.handle(CHANNELS.command, async (event, value: unknown): Promise<Result<BrowserState>> => {
    if (!trustedSender(event, window.webContents, documentUrl)) {
      return { ok: false, error: 'アプリのメイン操作画面からのみ利用できます。' };
    }
    try {
      const command = parseCommand(value);
      if (shutdownPending) throw new UserError('終了の確認中です。操作は確認を閉じてから再試行してください。');
      return { ok: true, value: await browser.dispatch(command) };
    } catch (error) {
      const message = error instanceof UserError ? error.message : '操作を完了できませんでした。ローカルデータの権限と空き容量を確認してください。';
      browser.notify(message);
      return { ok: false, error: message };
    }
  });
  function handleTotp<Request, Response>(
    channel: string,
    parse: (value: unknown) => Request,
    operation: (request: Request, authorized: () => boolean) => Promise<Response>,
  ): void {
    ipcMain.handle(channel, async (event, value: unknown): Promise<Result<Response>> => {
      const authorized = () => trustedSender(event, window.webContents, documentUrl);
      if (!authorized()) return { ok: false, error: 'アプリのメイン操作画面からのみ利用できます。' };
      try {
        if (shutdownPending) throw new UserError('終了の確認中です。操作は確認を閉じてから再試行してください。');
        return { ok: true, value: await operation(parse(value), authorized) };
      } catch (error) {
        const message = error instanceof UserError ? error.message : 'TOTP の操作を完了できませんでした。保存先の権限と OS の鍵へのアクセスを確認してください。';
        browser.notify(message);
        return { ok: false, error: message };
      }
    });
  }
  handleTotp(TOTP_CHANNELS.register, parseTotpRegistration,
    (request, authorized) => browser.registerTotp(request.profileId, request.input, authorized));
  handleTotp(TOTP_CHANNELS.remove, parseTotpProfile,
    (request, authorized) => browser.removeTotp(request.profileId, authorized));
  handleTotp(TOTP_CHANNELS.code, parseTotpCodeRequest,
    (request, authorized) => browser.getTotpCode(request.profileId, request.registrationId, false, authorized));
  handleTotp(TOTP_CHANNELS.copy, parseTotpCodeRequest,
    (request, authorized) => browser.getTotpCode(request.profileId, request.registrationId, true, authorized));
  await window.loadURL(documentUrl);
  window.show();
}

app.on('login', (event, contents, _details, _authInfo, callback) => {
  event.preventDefault();
  callback();
  controller?.reportForContents(contents, 'HTTP / プロキシの資格情報ダイアログには対応していません。Microsoft の Web サインインとは別の認証経路です。');
});
app.on('select-client-certificate', (event, contents, _url, _certificates, callback) => {
  event.preventDefault();
  callback();
  controller?.reportForContents(contents, 'クライアント証明書による認証は未対応です。証明書を自動選択していません。');
});
app.on('before-quit', (event) => {
  if (!shutdownDone) {
    event.preventDefault();
    void quit();
  }
});
app.on('second-instance', () => {
  const window = controller?.window;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
app.on('activate', () => controller?.window.show());

if (!app.requestSingleInstanceLock()) {
  shutdownDone = true;
  app.quit();
} else {
  void app.whenReady().then(start).catch((error: unknown) => {
    fail(error instanceof UserError ? error.message : 'Shinano を起動できませんでした。ビルド結果とローカルデータの権限を確認してください。既存データは自動初期化しません。');
    shutdownDone = true;
    app.quit();
  });
}
