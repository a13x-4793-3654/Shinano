import type { Session, WebPreferences } from 'electron';
import { isTabUrl } from '../shared/validation.ts';

const EXTERNAL_PROTOCOLS: Readonly<Record<string, string>> = {
  'mailto:': 'メール アプリ',
  'msteams:': 'Microsoft Teams',
  'ms-teams:': 'Microsoft Teams',
  'ms-word:': 'Microsoft Word',
  'ms-excel:': 'Microsoft Excel',
  'ms-powerpoint:': 'Microsoft PowerPoint',
  'ms-outlook:': 'Microsoft Outlook',
  'ms-onenote:': 'Microsoft OneNote',
  'onenote:': 'Microsoft OneNote',
  'ms-visio:': 'Microsoft Visio',
  'ms-access:': 'Microsoft Access',
  'ms-publisher:': 'Microsoft Publisher',
  'ms-officeapp:': 'Microsoft 365',
};

export interface ExternalProtocol {
  url: string;
  label: string;
}

export function externalProtocol(value: string): ExternalProtocol | null {
  if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const label = EXTERNAL_PROTOCOLS[url.protocol.toLowerCase()];
    return label ? { url: url.href, label } : null;
  } catch {
    return null;
  }
}

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
