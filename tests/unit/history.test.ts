import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryCapture } from '../../src/main/history.ts';
import { UserError } from '../../src/shared/validation.ts';

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('history captures only the settled candidate at the quiet boundary and ignores query-only in-page changes', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const visits: { profile: string; url: string; title: string; at: number }[] = [];
  const errors: string[] = [];
  const capture = new HistoryCapture(async (profile, url, title, at, _mode, current) => {
    if (current()) visits.push({ profile, url, title, at });
  }, (error) => errors.push(error), () => 1234);
  context.after(() => capture.dispose());
  capture.committed('tab', 'profile', 'https://example.invalid/intermediate', 'detailed', false, () => 'Synthetic intermediate', () => true);
  capture.completed('tab');
  context.mock.timers.tick(100);
  capture.committed('tab', 'profile', 'https://example.invalid/settled?remove=query#remove', 'detailed', false, () => 'Synthetic settled', () => true);
  capture.completed('tab');
  context.mock.timers.tick(1499);
  await drain();
  assert.equal(visits.length, 0);
  context.mock.timers.tick(1);
  await drain();
  assert.deepEqual(visits, [{ profile: 'profile', url: 'https://example.invalid/settled', title: 'Synthetic settled', at: 1234 }]);
  capture.committed('tab', 'profile', 'https://example.invalid/settled?other=query#other', 'detailed', true, () => 'Do not recapture', () => true);
  context.mock.timers.tick(1500);
  await drain();
  assert.equal(visits.length, 1);
  assert.deepEqual(errors, []);
});

test('off, sensitive URLs, closed profiles and disposed captures cannot write pending visits', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  const capture = new HistoryCapture(async () => { writes++; }, () => {});
  context.after(() => capture.dispose());
  capture.committed('off', 'profile', 'https://example.invalid/private', 'off', true, () => 'Synthetic', () => true);
  capture.committed('auth', 'profile', 'https://example.invalid/callback?code=synthetic', 'detailed', true, () => 'Synthetic', () => true);
  capture.committed('closed', 'profile', 'https://example.invalid/closed', 'detailed', true, () => 'Synthetic', () => true);
  capture.closed('closed');
  capture.committed('removed', 'removed-profile', 'https://example.invalid/removed', 'detailed', true, () => 'Synthetic', () => true);
  capture.profileRemoved('removed-profile');
  context.mock.timers.tick(2000);
  await drain();
  assert.equal(writes, 0);
  capture.committed('dispose', 'profile', 'https://example.invalid/dispose', 'detailed', true, () => 'Synthetic', () => true);
  capture.dispose();
  context.mock.timers.tick(2000);
  await drain();
  assert.equal(writes, 0);
});

test('synchronous queue/shutdown errors and title read failures are contained without leaking native error text', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const errors: string[] = [];
  const capture = new HistoryCapture(() => { throw new UserError('終了の確認中です。'); }, (error) => errors.push(error));
  context.after(() => capture.dispose());
  capture.committed('queue', 'profile', 'https://example.invalid/queue', 'detailed', true, () => 'Synthetic', () => true);
  context.mock.timers.tick(1500);
  await drain();
  assert.deepEqual(errors, ['終了の確認中です。']);
  capture.committed('title', 'profile', 'https://example.invalid/title', 'detailed', true,
    () => { throw new Error('Synthetic sensitive native error must not escape'); }, () => true);
  context.mock.timers.tick(1500);
  await drain();
  assert.equal(errors.length, 2);
  assert.equal(errors[1]?.includes('Synthetic sensitive'), false);
});
