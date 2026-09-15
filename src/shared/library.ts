import type { Result } from './model.ts';

export const HISTORY_DAYS = 90;
export const HISTORY_RETENTION_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;
export const MAX_BOOKMARKS = 5000;
export const MAX_VISITS = 50_000;
export const MAX_LIBRARY_TITLE = 160;
export const MAX_LIBRARY_URL = 8192;
export const LIBRARY_PAGE_SIZE = 100;
export type LibraryKind = 'bookmarks' | 'history';
export type HistoryMode = 'detailed' | 'origins' | 'off';
export type RemovalScope = 'local' | 'vault';

export interface LibraryVersion {
  revision: string;
  title: string;
  url: string;
}

export interface LibraryEntry {
  id: string;
  profileId: string;
  title: string;
  url: string;
  at: number;
  revision: string;
  versions: LibraryVersion[];
}

export interface LibraryCursor {
  revision: number;
  offset: number;
}

export interface LibraryQuery {
  kind: LibraryKind;
  profileId: string | null;
  query: string;
  cursor: LibraryCursor | null;
}

export interface LibraryPage {
  revision: number;
  entries: LibraryEntry[];
  total: number;
  next: LibraryCursor | null;
  historyMode: HistoryMode | null;
}

export interface BookmarkDraft {
  profileId: string;
  title: string;
  url: string;
}

export type LibraryCommand =
  | { type: 'bookmark:save'; profileId: string; recordId: string | null; parents: string[]; title: string; url: string }
  | { type: 'entry:open'; kind: LibraryKind; profileId: string; recordId: string; revision: string }
  | { type: 'entry:remove'; kind: LibraryKind; profileId: string; recordId: string; scope: RemovalScope }
  | { type: 'history:clear'; profileId: string; scope: RemovalScope }
  | { type: 'history:mode'; profileId: string; mode: HistoryMode };

export interface DataMutation {
  outcome: 'saved' | 'removed' | 'cancelled' | 'opened' | 'updated';
}

export interface LibraryAPI {
  query(request: LibraryQuery): Promise<Result<LibraryPage>>;
  currentBookmark(): Promise<Result<BookmarkDraft>>;
  command(command: LibraryCommand): Promise<Result<DataMutation>>;
}

export const LIBRARY_CHANNELS = {
  query: 'shinano:library:query',
  current: 'shinano:library:current',
  command: 'shinano:library:command',
} as const;
