import type { Result } from './model.ts';
import { exactKeys, record, UserError } from './validation.ts';

export const BACKUP_CHANNELS = {
  export: 'shinano:backup:export',
  import: 'shinano:backup:import',
} as const;
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;
export const MAX_BACKUP_PASSPHRASE_LENGTH = 1024;

export interface BackupResult {
  outcome: 'saved' | 'restored' | 'cancelled';
}

export interface BackupAPI {
  export(passphrase: string): Promise<Result<BackupResult>>;
  import(passphrase: string): Promise<Result<BackupResult>>;
}

export function parseBackupRequest(value: unknown): { passphrase: string } {
  const request = record(value);
  exactKeys(request, ['passphrase']);
  if (typeof request.passphrase !== 'string' || request.passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH
    || request.passphrase.length > MAX_BACKUP_PASSPHRASE_LENGTH || !request.passphrase.trim()) {
    throw new UserError('バックアップのパスフレーズは 12〜1,024 文字で入力してください。');
  }
  return { passphrase: request.passphrase };
}
