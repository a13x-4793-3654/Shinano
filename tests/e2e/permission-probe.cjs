const { session, webContents, dialog, desktopCapturer } = require('electron');
const handlers = new Map();
const prompts = [];
const calls = [];
const waiting = [];
let choice = 0;
let hold = false;
let screenResponse;
let checkboxChecked = false;
let pending;

exports.setup = profileId => {
  const target = session.fromPartition(`persist:shinano-${profileId}`, { cache: true });
  const captured = {};
  for (const [method, key] of [
    ['setPermissionCheckHandler', 'check'],
    ['setPermissionRequestHandler', 'request'],
    ['setDisplayMediaRequestHandler', 'display'],
  ]) {
    const original = target[method].bind(target);
    target[method] = handler => {
      captured[key] = handler;
      original((...args) => {
        calls.push({ kind: key, permission: key === 'display' ? 'display' : args[1], details: key === 'request' ? args[3] : undefined });
        return handler(...args);
      });
    };
  }
  handlers.set(profileId, captured);
  dialog.showMessageBox = async (_window, options) => {
    prompts.push({ title: options.title, message: options.message, detail: options.detail, buttons: options.buttons });
    if (hold) return new Promise(resolve => waiting.push(resolve));
    return { response: options.title === '画面共有する対象を選択' ? screenResponse ?? choice : choice, checkboxChecked };
  };
};
exports.choice = options => { choice = options.response; hold = Boolean(options.hold); screenResponse = options.screenResponse; };
exports.prompts = () => prompts;
exports.calls = () => calls;
exports.release = response => { for (const resolve of waiting.splice(0)) resolve({ response, checkboxChecked: false }); };
exports.pending = () => pending;

function contents(url) {
  const target = webContents.getAllWebContents().find(entry => entry.getURL() === url);
  if (!target) throw new Error('Permission fixture contents missing.');
  return target;
}
exports.request = ({ profileId, url, permission, details = {} }) => new Promise(resolve => {
  handlers.get(profileId).request(contents(url), permission, resolve, { isMainFrame: true, requestingUrl: url, ...details });
});
exports.begin = args => { pending = exports.request(args); };
exports.check = ({ profileId, url, permission, origin, details = {} }) =>
  handlers.get(profileId).check(contents(url), permission, origin ?? new URL(url).origin, { isMainFrame: true, ...details });
exports.display = ({ profileId, url, response, gesture = true, checked = false }) => {
  choice = response;
  checkboxChecked = checked;
  const target = contents(url);
  const original = desktopCapturer.getSources;
  desktopCapturer.getSources = async () => [
    { id: 'screen:fixture:0', name: 'Synthetic screen' },
    { id: 'window:fixture:0', name: 'Synthetic window' },
  ];
  return new Promise(resolve => handlers.get(profileId).display({
    frame: target.mainFrame, securityOrigin: new URL(url).origin,
    videoRequested: true, audioRequested: true, userGesture: gesture,
  }, streams => {
    desktopCapturer.getSources = original;
    resolve({ video: streams.video?.id ?? null, audio: streams.audio ?? null });
  }));
};
