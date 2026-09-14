import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { partitionDirectory, partitionName, StateStore } from '../../src/main/store.ts';

test('profile identity and sanitized tab restoration survive an atomic save/load', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'shinano-store-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const state = store.load();
  assert.equal(state.profiles.length, 1);
  const profileId = state.profiles[0]!.id;
  const tabId = randomUUID();
  state.tabs = [{ id: tabId, profileId, restoreUrl: 'http://127.0.0.1:4000/' }];
  state.activeTabId = tabId;
  store.save(state);
  assert.deepEqual(new StateStore(directory).load(), state);
  assert.equal(partitionName(profileId), `persist:shinano-${profileId}`);
  if (process.platform !== 'win32') assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.equal(existsSync(`${store.file}.tmp`), false);
});

test('corrupt or incompatible metadata is not silently reset or overwritten', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'shinano-corrupt-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  writeFileSync(store.file, '{broken fixture');
  assert.throws(() => store.load(), /上書きしていません/);
  assert.equal(readFileSync(store.file, 'utf8'), '{broken fixture');
});

test('startup deletion only removes a validated Shinano partition and commits completion', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'shinano-deletion-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const state = store.load();
  const deletedId = randomUUID();
  const sessionRoot = join(directory, 'sessions');
  const deletedDirectory = partitionDirectory(sessionRoot, deletedId);
  const keptDirectory = partitionDirectory(sessionRoot, state.profiles[0]!.id);
  const outside = join(directory, 'unrelated-fixture');
  for (const path of [deletedDirectory, keptDirectory, outside]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'fixture'), 'not a real browser profile');
  }
  state.deletedProfileIds = [deletedId];
  store.save(state);
  const result = store.finishDeletions(state, sessionRoot);
  assert.equal(existsSync(deletedDirectory), false);
  assert.equal(existsSync(keptDirectory), true);
  assert.equal(existsSync(outside), true);
  assert.deepEqual(result.deletedProfileIds, []);
  assert.deepEqual(store.load(), result);
  assert.throws(() => partitionDirectory(sessionRoot, '../../../unrelated-fixture'));
});
