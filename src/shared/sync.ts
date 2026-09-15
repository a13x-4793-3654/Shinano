import type { ProfileColor, Result } from './model.ts';
import type { DataMutation } from './library.ts';

export type SyncPhase = 'unconfigured' | 'locked' | 'ready' | 'busy' | 'unavailable' | 'error';

export interface DataIndicator {
  revision: number;
  error: string | null;
  syncPhase: SyncPhase;
  generation: number;
}

export interface SyncProfile {
  id: string;
  name: string;
  color: ProfileColor;
  installed: boolean;
  suppressed: boolean;
  linked: boolean;
  bookmarks: boolean;
  history: boolean;
  localRegistrationId: string | null;
  sharedRegistrationId: string | null;
  totpState: 'none' | 'available' | 'linked' | 'conflict' | 'unreadable' | 'pending';
  versions: { revision: string; name: string; color: ProfileColor }[];
  totpVersions: { revision: string; registrationId: string; issuer: string | null; account: string | null }[];
}

export interface SyncStatus {
  phase: SyncPhase;
  vaultId: string | null;
  folder: string | null;
  hasDeviceKey: boolean;
  generation: number;
  pending: number;
  lastReadAt: number | null;
  lastWriteAt: number | null;
  message: string | null;
  wrappingConflict: boolean;
  profiles: SyncProfile[];
}

export interface FolderSelection {
  selectionId: string;
  displayPath: string;
  vaultIds: string[];
}

export interface CreateVaultRequest {
  selectionId: string;
  passphrase: string;
  confirmation: string;
  remember: boolean;
}

export interface VaultSetup {
  setupId: string;
  recoveryKey: string;
}

export interface JoinVaultRequest {
  selectionId: string;
  vaultId: string;
  method: 'passphrase' | 'recovery';
  input: string;
  remember: boolean;
}

export interface UnlockVaultRequest {
  method: 'passphrase' | 'recovery' | 'device';
  input: string;
}

export type SyncCommand =
  | { type: 'refresh' | 'lock' | 'forget' | 'unlink' | 'cancel-setup' }
  | { type: 'finish-create'; setupId: string; recoveryAcknowledged: boolean }
  | { type: 'profile:link'; profileId: string; bookmarks: boolean; history: boolean }
  | { type: 'profile:unlink' | 'profile:restore' | 'profile:delete'; profileId: string }
  | { type: 'profile:resolve'; profileId: string; revision: string }
  | { type: 'totp:share'; profileId: string; registrationId: string }
  | { type: 'totp:accept'; profileId: string; revision: string; expectedRegistrationId: string | null }
  | { type: 'totp:cancel-import'; profileId: string }
  | { type: 'totp:delete'; profileId: string; registrationId: string };

export interface ChangePassphraseRequest {
  passphrase: string;
  confirmation: string;
}

export interface SyncAPI {
  status(): Promise<Result<SyncStatus>>;
  chooseFolder(): Promise<Result<FolderSelection | null>>;
  create(request: CreateVaultRequest): Promise<Result<VaultSetup>>;
  join(request: JoinVaultRequest): Promise<Result<SyncStatus>>;
  unlock(request: UnlockVaultRequest): Promise<Result<SyncStatus>>;
  changePassphrase(request: ChangePassphraseRequest): Promise<Result<DataMutation>>;
  command(command: SyncCommand): Promise<Result<DataMutation>>;
}

export const SYNC_CHANNELS = {
  status: 'shinano:sync:status',
  choose: 'shinano:sync:choose',
  create: 'shinano:sync:create',
  join: 'shinano:sync:join',
  unlock: 'shinano:sync:unlock',
  changePassphrase: 'shinano:sync:passphrase',
  command: 'shinano:sync:command',
} as const;
