import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedState } from '../shared/model.ts';
import { id, parseSavedState, UserError } from '../shared/validation.ts';
import { writeAtomic } from './atomic-file.ts';

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

  load(hasProtectedData = false): SavedState {
    if (!existsSync(this.file)) {
      if (hasProtectedData) {
        throw new UserError('認証キーまたはライブラリーの保存データはありますが、プロファイル情報 state.json がありません。既存データの上書きや再割り当てをせず起動を中断しました。');
      }
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
    writeAtomic(this.file, `${JSON.stringify(checked, null, 2)}\n`);
  }

  finishDeletions(state: SavedState, sessionRoot: string, removeSecret?: (profileId: string) => void): SavedState {
    // Runs before any profile session is opened, including on Windows where files stay locked.
    for (const profileId of state.deletedProfileIds.map(id)) {
      removeSecret?.(profileId);
      rmSync(partitionDirectory(sessionRoot, profileId), { recursive: true, force: true });
    }
    if (!state.deletedProfileIds.length) return state;
    const completed = { ...state, deletedProfileIds: [] };
    this.save(completed);
    return completed;
  }
}
