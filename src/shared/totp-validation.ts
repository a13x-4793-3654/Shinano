import { MAX_TOTP_INPUT_LENGTH } from './totp.ts';
import { exactKeys, id, record, UserError } from './validation.ts';

export function parseTotpProfile(value: unknown): { profileId: string } {
  const request = record(value);
  exactKeys(request, ['profileId']);
  return { profileId: id(request.profileId) };
}

export function parseTotpCodeRequest(value: unknown): { profileId: string; registrationId: string } {
  const request = record(value);
  exactKeys(request, ['profileId', 'registrationId']);
  return { profileId: id(request.profileId), registrationId: id(request.registrationId) };
}

export function parseTotpRegistration(value: unknown): { profileId: string; input: string } {
  const request = record(value);
  exactKeys(request, ['profileId', 'input']);
  if (typeof request.input !== 'string' || !request.input || request.input.length > MAX_TOTP_INPUT_LENGTH) {
    throw new UserError('共有秘密鍵または TOTP URI を 1〜4,096 文字で入力してください。');
  }
  return { profileId: id(request.profileId), input: request.input };
}
