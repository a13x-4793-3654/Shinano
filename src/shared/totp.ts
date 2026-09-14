import type { Result } from './model.ts';

export const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number];
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
export const MAX_TOTP_INPUT_LENGTH = 4096;
export const MAX_TOTP_SECRET_BYTES = 128;
export const MAX_TOTP_LABEL_LENGTH = 128;

export interface TotpMetadata {
  algorithm: TotpAlgorithm;
  digits: typeof TOTP_DIGITS;
  period: typeof TOTP_PERIOD;
  issuer: string | null;
  account: string | null;
}

export type TotpRegistration =
  | { profileId: string; status: 'none'; registrationId: null; error: null }
  | { profileId: string; status: 'registered'; registrationId: string; error: null }
  | { profileId: string; status: 'unreadable'; registrationId: null; error: string };

export interface TotpState {
  selectedProfileId: string | null;
  registrations: TotpRegistration[];
  error: string | null;
}

export interface TotpCode extends TotpMetadata {
  profileId: string;
  registrationId: string;
  code: string;
  generatedAt: number;
  validFrom: number;
  validUntil: number;
}

export interface TotpMutation {
  outcome: 'saved' | 'removed' | 'cancelled';
}

export interface TotpAPI {
  register(profileId: string, input: string): Promise<Result<TotpMutation>>;
  remove(profileId: string): Promise<Result<TotpMutation>>;
  getCode(profileId: string, registrationId: string): Promise<Result<TotpCode>>;
  copyCode(profileId: string, registrationId: string): Promise<Result<TotpCode>>;
}

export const TOTP_CHANNELS = {
  register: 'shinano:totp:register',
  remove: 'shinano:totp:remove',
  code: 'shinano:totp:code',
  copy: 'shinano:totp:copy',
} as const;
