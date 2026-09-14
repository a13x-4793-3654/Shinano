const { ipcRenderer } = require('electron');
const profileId = process.argv.find((value) => value.startsWith('--fixture-profile='))?.split('=')[1];
const registrationId = process.argv.find((value) => value.startsWith('--fixture-registration='))?.split('=')[1];
Promise.all([
  ipcRenderer.invoke('shinano:totp:register', { profileId, input: 'JBSWY3DPEHPK3PXP' }), // Public URI-format example.
  ipcRenderer.invoke('shinano:totp:remove', { profileId }),
  ipcRenderer.invoke('shinano:totp:code', { profileId, registrationId }),
  ipcRenderer.invoke('shinano:totp:copy', { profileId, registrationId }),
]).then((results) => {
  ipcRenderer.send('shinano-test:totp-denied', results.map((result) =>
    result.ok === false && result.error === 'アプリのメイン操作画面からのみ利用できます。'));
});
