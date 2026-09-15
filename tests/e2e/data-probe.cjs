const { ipcRenderer } = require('electron');
const profileId = process.argv.find((value) => value.startsWith('--fixture-profile='))?.slice('--fixture-profile='.length);
const calls = [
  ['shinano:library:query', { kind: 'bookmarks', profileId, query: '', cursor: null }],
  ['shinano:library:current', {}],
  ['shinano:library:command', { type: 'history:mode', profileId, mode: 'off' }],
  ['shinano:sync:status', {}],
  ['shinano:sync:choose', {}],
  ['shinano:sync:create', { selectionId: profileId, passphrase: 'Public synthetic fixture passphrase', confirmation: 'Public synthetic fixture passphrase', remember: false }],
  ['shinano:sync:join', { selectionId: profileId, vaultId: profileId, method: 'passphrase', input: 'Public synthetic fixture passphrase', remember: false }],
  ['shinano:sync:unlock', { method: 'device', input: '' }],
  ['shinano:sync:passphrase', { passphrase: 'Public synthetic fixture passphrase', confirmation: 'Public synthetic fixture passphrase' }],
  ['shinano:sync:command', { type: 'lock' }],
];
Promise.all(calls.map(async ([channel, value]) => {
  const result = await ipcRenderer.invoke(channel, value);
  return !result.ok && result.error === 'アプリのメイン操作画面からのみ利用できます。';
})).then((results) => ipcRenderer.send('shinano-test:data-denied', results));
