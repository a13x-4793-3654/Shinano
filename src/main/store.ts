import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedState } from '../shared/model.ts';
import { id, parseSavedState, UserError } from '../shared/validation.ts';

export function partitionName(profileId: string): string {
  return `persist:shinano-${id(profileId)}`;
}

export function partitionDirectory(sessionRoot: string, profileId: string): string {
  return join(sessionRoot, 'Partitions', `shinano-${id(profileId)}`);
}

export class StateStore {
  readonly file: string;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'state.json');
  }

  load(): SavedState {
    if (!existsSync(this.file)) {
      const initial: SavedState = {
        version: 1,
        profiles: [{ id: randomUUID(), name: 'デモ A', color: 'blue' }],
        tabs: [],
        activeTabId: null,
        deletedProfileIds: [],
      };
      this.save(initial);
      return initial;
    }
    try {
      return parseSavedState(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      throw new UserError('保存データ state.json を読み込めませんでした。既存データは上書きしていません。バックアップを取って形式とファイル権限を確認してください。');
    }
  }

  save(state: SavedState): void {
    const checked = parseSavedState(state);
    const temporary = `${this.file}.tmp`;
    const descriptor = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(checked, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.file);
  }

  finishDeletions(state: SavedState, sessionRoot: string): SavedState {
    // Runs before any profile session is opened, including on Windows where files stay locked.
    for (const profileId of state.deletedProfileIds) {
      rmSync(partitionDirectory(sessionRoot, profileId), { recursive: true, force: true });
    }
    if (!state.deletedProfileIds.length) return state;
    const completed = { ...state, deletedProfileIds: [] };
    this.save(completed);
    return completed;
  }
}
