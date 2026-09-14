import type { Session, WebPreferences } from 'electron';
import { isTabUrl } from '../shared/validation.ts';

export function remotePreferences(profileSession: Session): WebPreferences {
  return {
    session: profileSession,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    safeDialogsMessage: 'このページからの追加ダイアログを抑制します。',
    disableHtmlFullscreenWindowResize: true,
  };
}

export function trustedSender(
  event: { sender: object; senderFrame: { readonly url: string } | null },
  chrome: { isDestroyed(): boolean; readonly mainFrame: { readonly url: string } },
  documentUrl: string,
): boolean {
  return !chrome.isDestroyed()
    && event.sender === chrome
    && event.senderFrame === chrome.mainFrame
    && event.senderFrame.url === documentUrl;
}

export function frameNavigationAllowed(url: string, isMainFrame: boolean): boolean {
  if (isTabUrl(url)) return true;
  if (isMainFrame) return false;
  // Web applications use these for unprivileged subframes; none has an app preload.
  try {
    return ['about:', 'blob:', 'data:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function safeDownloadName(value: string): string {
  const name = value.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 120);
  return !name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? 'download' : name;
}
