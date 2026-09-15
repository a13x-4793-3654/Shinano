import {
  MAX_LIBRARY_TITLE, MAX_LIBRARY_URL,
  type HistoryMode, type LibraryCommand, type LibraryKind, type LibraryQuery, type RemovalScope,
} from './library.ts';
import { exactKeys, id, isWebUrl, record, UserError } from './validation.ts';

export function boundedInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new UserError('数値の形式または上限が正しくありません。');
  }
  return value;
}

export function boundedIds(value: unknown, maximum = 32): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new UserError('ID の件数が上限を超えています。');
  const ids = value.map(id);
  if (new Set(ids).size !== ids.length) throw new UserError('ID が重複しています。');
  return ids.sort();
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new UserError('選択の形式が正しくありません。');
  return value;
}

export function libraryTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_LIBRARY_TITLE
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new UserError(`タイトルは 1〜${MAX_LIBRARY_TITLE} 文字のテキストにしてください。`);
  }
  return value.trim();
}

export function pageTitle(value: string, fallback: string): string {
  const title = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, MAX_LIBRARY_TITLE);
  return title || fallback.slice(0, MAX_LIBRARY_TITLE);
}

export function bookmarkUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_LIBRARY_URL
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value) || !isWebUrl(value)) {
    throw new UserError('認証情報を含まない HTTP / HTTPS の URL を入力してください。認証キー URI やファイルは保存できません。');
  }
  const result = new URL(value).href;
  if (result.length > MAX_LIBRARY_URL) throw new UserError('URL が保存上限を超えています。');
  return result;
}

export function sensitiveHistoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (['login.microsoftonline.com', 'login.live.com', 'accounts.google.com', 'appleid.apple.com']
      .some((entry) => host === entry || host.endsWith(`.${entry}`))) return true;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (/(?:^|[/_.-])(oauth2?|oidc|saml2?|authorize|authorization|callback|signin|signout|login|logout|token|reset-password|magic-link)(?:[/_.-]|$)/u.test(path)) return true;
    const sensitive = /^(?:code|token|access_token|id_token|refresh_token|assertion|samlresponse|samlrequest|secret|password|passwd|otp|session_state|client_secret|authorization)$/iu;
    for (const key of url.searchParams.keys()) if (sensitive.test(key)) return true;
    for (const key of new URLSearchParams(url.hash.slice(1)).keys()) if (sensitive.test(key)) return true;
    return false;
  } catch {
    return true;
  }
}

export function historyLocation(value: string, mode: Exclude<HistoryMode, 'off'>): string | null {
  if (!isWebUrl(value) || value.length > MAX_LIBRARY_URL || sensitiveHistoryUrl(value)) return null;
  const url = new URL(value);
  const result = mode === 'origins' ? `${url.origin}/` : `${url.origin}${url.pathname}`;
  return result.length <= MAX_LIBRARY_URL ? result : null;
}

export function historyMode(value: unknown): HistoryMode {
  if (value !== 'detailed' && value !== 'origins' && value !== 'off') throw new UserError('履歴の記録方法を選択してください。');
  return value;
}

function kind(value: unknown): LibraryKind {
  if (value !== 'bookmarks' && value !== 'history') throw new UserError('ライブラリーの種類が正しくありません。');
  return value;
}

export function removalScope(value: unknown): RemovalScope {
  if (value !== 'local' && value !== 'vault') throw new UserError('削除する範囲を選択してください。');
  return value;
}

export function parseLibraryQuery(input: unknown): LibraryQuery {
  const value = record(input);
  exactKeys(value, ['kind', 'profileId', 'query', 'cursor']);
  if (typeof value.query !== 'string' || value.query.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.query)) {
    throw new UserError('検索文字列は 256 文字以内にしてください。');
  }
  let cursor = null;
  if (value.cursor !== null) {
    const item = record(value.cursor);
    exactKeys(item, ['revision', 'offset']);
    cursor = { revision: boundedInteger(item.revision), offset: boundedInteger(item.offset, 100_000) };
  }
  return { kind: kind(value.kind), profileId: value.profileId === null ? null : id(value.profileId), query: value.query, cursor };
}

export function parseLibraryCommand(input: unknown): LibraryCommand {
  const value = record(input);
  switch (value.type) {
    case 'bookmark:save':
      exactKeys(value, ['type', 'profileId', 'recordId', 'parents', 'title', 'url']);
      return {
        type: value.type, profileId: id(value.profileId), recordId: value.recordId === null ? null : id(value.recordId),
        parents: boundedIds(value.parents), title: libraryTitle(value.title), url: bookmarkUrl(value.url),
      };
    case 'entry:open':
      exactKeys(value, ['type', 'kind', 'profileId', 'recordId', 'revision']);
      return { type: value.type, kind: kind(value.kind), profileId: id(value.profileId), recordId: id(value.recordId), revision: id(value.revision) };
    case 'entry:remove':
      exactKeys(value, ['type', 'kind', 'profileId', 'recordId', 'scope']);
      return { type: value.type, kind: kind(value.kind), profileId: id(value.profileId), recordId: id(value.recordId), scope: removalScope(value.scope) };
    case 'history:clear':
      exactKeys(value, ['type', 'profileId', 'scope']);
      return { type: value.type, profileId: id(value.profileId), scope: removalScope(value.scope) };
    case 'history:mode':
      exactKeys(value, ['type', 'profileId', 'mode']);
      return { type: value.type, profileId: id(value.profileId), mode: historyMode(value.mode) };
    default:
      throw new UserError('対応していないライブラリー操作です。');
  }
}
