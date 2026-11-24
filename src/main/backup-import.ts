import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_PROFILES, type SavedState } from '../shared/model.ts';
import { exactKeys, id, parseSavedState, record, UserError } from '../shared/validation.ts';
import { assertRegularFile, writeAtomic } from './atomic-file.ts';
import type { PortableBackup } from './backup.ts';
import type { StateStore } from './store.ts';
import type { TotpStore } from './totp-store.ts';

const RECOVERY_ERROR = 'バックアップ復元の未完了データを処理できません。既存データを保護するため操作を中止しました。保存先の権限を確認して再起動してください。';

function journalFile(store: StateStore): string {
  return join(dirname(store.file), 'backup-import.json');
}

function stateHash(state: SavedState): string {
  return createHash('sha256').update(JSON.stringify(parseSavedState(state))).digest('hex');
}

export function mergeBackup(current: SavedState, backup: PortableBackup): SavedState {
  const existing = new Set([...current.profiles.map((profile) => profile.id), ...current.deletedProfileIds]);
  const tabs = new Set(current.tabs.map((tab) => tab.id));
  if (backup.state.profiles.some((profile) => existing.has(profile.id))
    || backup.state.tabs.some((tab) => tabs.has(tab.id))) {
    throw new UserError('同じ ID のプロファイルまたはタブが既にあります。上書きせず復元を中止しました。別端末の新しい環境で復元してください。');
  }
  try {
    return parseSavedState({
      ...current, profiles: [...current.profiles, ...backup.state.profiles],
      tabs: [...current.tabs, ...backup.state.tabs],
      activeTabId: current.activeTabId ?? backup.state.activeTabId,
    });
  } catch {
    throw new UserError('復元後のプロファイル数・タブ数が上限を超えるか、データの対応が正しくありません。既存データは変更していません。');
  }
}

export function recoverBackupImport(store: StateStore, totpStore: TotpStore): void {
  const file = journalFile(store);
  try {
    if (!assertRegularFile(file)) return;
    if (lstatSync(file).size > 4096) throw new UserError(RECOVERY_ERROR);
    const journal = record(JSON.parse(readFileSync(file, 'utf8')));
    exactKeys(journal, ['version', 'profileIds', 'baseHash', 'targetHash']);
    if (journal.version !== 1 || !Array.isArray(journal.profileIds) || journal.profileIds.length > MAX_PROFILES
      || !journal.profileIds.length || typeof journal.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(journal.baseHash)
      || typeof journal.targetHash !== 'string' || !/^[a-f0-9]{64}$/.test(journal.targetHash)) throw new UserError(RECOVERY_ERROR);
    const profileIds = journal.profileIds.map(id);
    if (new Set(profileIds).size !== profileIds.length) throw new UserError(RECOVERY_ERROR);
    const state = parseSavedState(JSON.parse(readFileSync(store.file, 'utf8')));
    const hash = stateHash(state);
    if (hash === journal.baseHash) {
      if (profileIds.some((profileId) => state.profiles.some((profile) => profile.id === profileId)
        || state.deletedProfileIds.includes(profileId))) throw new UserError(RECOVERY_ERROR);
      for (const profileId of profileIds) totpStore.remove(profileId);
    } else if (hash !== journal.targetHash || profileIds.some((profileId) =>
      !state.profiles.some((profile) => profile.id === profileId))) {
      throw new UserError(RECOVERY_ERROR);
    }
    unlinkSync(file);
  } catch {
    throw new UserError(RECOVERY_ERROR);
  }
}

export function commitBackupImport(
  store: StateStore, totpStore: TotpStore, current: SavedState, backup: PortableBackup,
): SavedState {
  const candidate = mergeBackup(current, backup);
  if (assertRegularFile(journalFile(store))) throw new UserError(RECOVERY_ERROR);
  if (totpStore.error) throw new UserError('関連付けできない TOTP データがあります。解消してからバックアップを復元してください。');
  for (const profile of backup.state.profiles) {
    if (totpStore.registration(profile.id, true).status !== 'none') {
      throw new UserError('復元対象の ID に既存の TOTP データがあります。上書きせず中止しました。');
    }
  }
  store.save(current);
  writeAtomic(journalFile(store), `${JSON.stringify({
    version: 1, profileIds: backup.state.profiles.map((profile) => profile.id),
    baseHash: stateHash(current), targetHash: stateHash(candidate),
  })}\n`);
  try {
    for (const entry of backup.totp) totpStore.save(entry.profileId, entry);
    store.save(candidate);
  } catch {
    recoverBackupImport(store, totpStore);
    throw new UserError('バックアップを復元できませんでした。保存先の権限・空き容量と OS の鍵を確認してください。復元前のデータを保持しています。');
  }
  // Keep the journal until restart, so an interrupted commit is recoverable.
  return candidate;
}
