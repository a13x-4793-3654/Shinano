import type { ChangePassphraseRequest, CreateVaultRequest, JoinVaultRequest, SyncCommand, UnlockVaultRequest } from './sync.ts';
import { boolean } from './library-validation.ts';
import { exactKeys, id, record, UserError } from './validation.ts';

function secretInput(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) throw new UserError('入力の長さまたは形式が正しくありません。');
  return value;
}

function method(value: unknown): 'passphrase' | 'recovery' {
  if (value !== 'passphrase' && value !== 'recovery') throw new UserError('解除方法を選択してください。');
  return value;
}

export function parseNoInput(value: unknown): void {
  exactKeys(record(value), []);
}

export function parseCreateVault(input: unknown): CreateVaultRequest {
  const value = record(input);
  exactKeys(value, ['selectionId', 'passphrase', 'confirmation', 'remember']);
  return { selectionId: id(value.selectionId), passphrase: secretInput(value.passphrase), confirmation: secretInput(value.confirmation), remember: boolean(value.remember) };
}

export function parseJoinVault(input: unknown): JoinVaultRequest {
  const value = record(input);
  exactKeys(value, ['selectionId', 'vaultId', 'method', 'input', 'remember']);
  return { selectionId: id(value.selectionId), vaultId: id(value.vaultId), method: method(value.method), input: secretInput(value.input), remember: boolean(value.remember) };
}

export function parseUnlockVault(input: unknown): UnlockVaultRequest {
  const value = record(input);
  exactKeys(value, ['method', 'input']);
  return { method: value.method === 'device' ? 'device' : method(value.method), input: secretInput(value.input) };
}

export function parseChangePassphrase(input: unknown): ChangePassphraseRequest {
  const value = record(input);
  exactKeys(value, ['passphrase', 'confirmation']);
  return { passphrase: secretInput(value.passphrase), confirmation: secretInput(value.confirmation) };
}

export function parseSyncCommand(input: unknown): SyncCommand {
  const value = record(input);
  switch (value.type) {
    case 'refresh':
    case 'lock':
    case 'forget':
    case 'unlink':
    case 'cancel-setup':
      exactKeys(value, ['type']);
      return { type: value.type };
    case 'finish-create':
      exactKeys(value, ['type', 'setupId', 'recoveryAcknowledged']);
      return { type: value.type, setupId: id(value.setupId), recoveryAcknowledged: boolean(value.recoveryAcknowledged) };
    case 'profile:link':
      exactKeys(value, ['type', 'profileId', 'bookmarks', 'history']);
      return { type: value.type, profileId: id(value.profileId), bookmarks: boolean(value.bookmarks), history: boolean(value.history) };
    case 'profile:unlink':
    case 'profile:restore':
    case 'profile:delete':
    case 'totp:cancel-import':
      exactKeys(value, ['type', 'profileId']);
      return { type: value.type, profileId: id(value.profileId) };
    case 'profile:resolve':
      exactKeys(value, ['type', 'profileId', 'revision']);
      return { type: value.type, profileId: id(value.profileId), revision: id(value.revision) };
    case 'totp:share':
    case 'totp:delete':
      exactKeys(value, ['type', 'profileId', 'registrationId']);
      return { type: value.type, profileId: id(value.profileId), registrationId: id(value.registrationId) };
    case 'totp:accept':
      exactKeys(value, ['type', 'profileId', 'revision', 'expectedRegistrationId']);
      return { type: value.type, profileId: id(value.profileId), revision: id(value.revision), expectedRegistrationId: value.expectedRegistrationId === null ? null : id(value.expectedRegistrationId) };
    default:
      throw new UserError('対応していない同期操作です。');
  }
}
