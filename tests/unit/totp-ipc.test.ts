import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { trustedSender } from '../../src/main/security.ts';
import { parseTotpCodeRequest, parseTotpProfile, parseTotpRegistration } from '../../src/shared/totp-validation.ts';
import { parseCommand } from '../../src/shared/validation.ts';

test('all sensitive IPC shapes reject extra fields, invalid IDs and oversized input', () => {
  const profileId = randomUUID();
  const registrationId = randomUUID();
  assert.deepEqual(parseTotpProfile({ profileId }), { profileId });
  assert.deepEqual(parseTotpCodeRequest({ profileId, registrationId }), { profileId, registrationId });
  assert.equal(parseTotpRegistration({ profileId, input: 'A'.repeat(4096) }).input.length, 4096);
  for (const value of [null, [], { profileId: '../outside' }, { profileId, path: '/tmp/not-authorized' }]) {
    assert.throws(() => parseTotpProfile(value));
  }
  for (const value of [
    { profileId, registrationId, time: 0 },
    { profileId, registrationId, code: '000000' },
    { profileId, registrationId: 'invalid' },
  ]) assert.throws(() => parseTotpCodeRequest(value));
  for (const input of ['', null, {}, 123, 'A'.repeat(4097)]) {
    assert.throws(() => parseTotpRegistration({ profileId, input }));
  }
  assert.throws(() => parseCommand({ type: 'totp:register', profileId, input: 'Synthetic fixture' }));
  assert.deepEqual(parseCommand({ type: 'ui:totp-profile', profileId }), { type: 'ui:totp-profile', profileId });
});

test('trusted IPC requires exact WebContents identity, live main frame and complete document URL', () => {
  const mainFrame = { url: 'shinano://app/' };
  let destroyed = false;
  const chrome = { isDestroyed: () => destroyed, mainFrame };
  assert.equal(trustedSender({ sender: chrome, senderFrame: mainFrame }, chrome, 'shinano://app/'), true);
  assert.equal(trustedSender({ sender: { ...chrome }, senderFrame: mainFrame }, chrome, 'shinano://app/'), false);
  assert.equal(trustedSender({ sender: chrome, senderFrame: { ...mainFrame } }, chrome, 'shinano://app/'), false);
  assert.equal(trustedSender({ sender: chrome, senderFrame: null }, chrome, 'shinano://app/'), false);
  mainFrame.url = 'shinano://app/?untrusted=1';
  assert.equal(trustedSender({ sender: chrome, senderFrame: mainFrame }, chrome, 'shinano://app/'), false);
  mainFrame.url = 'shinano://app/';
  destroyed = true;
  assert.equal(trustedSender({ sender: chrome, senderFrame: mainFrame }, chrome, 'shinano://app/'), false);
});
