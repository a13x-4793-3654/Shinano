import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type BrowserState, type ShinanoAPI } from '../shared/model.ts';
import { TOTP_CHANNELS } from '../shared/totp.ts';
import { LIBRARY_CHANNELS } from '../shared/library.ts';
import { SYNC_CHANNELS } from '../shared/sync.ts';

const api: ShinanoAPI = {
  library: {
    query: (request) => ipcRenderer.invoke(LIBRARY_CHANNELS.query, request),
    currentBookmark: () => ipcRenderer.invoke(LIBRARY_CHANNELS.current, {}),
    command: (command) => ipcRenderer.invoke(LIBRARY_CHANNELS.command, command),
  },
  sync: {
    status: () => ipcRenderer.invoke(SYNC_CHANNELS.status, {}),
    chooseFolder: () => ipcRenderer.invoke(SYNC_CHANNELS.choose, {}),
    create: (request) => ipcRenderer.invoke(SYNC_CHANNELS.create, request),
    join: (request) => ipcRenderer.invoke(SYNC_CHANNELS.join, request),
    unlock: (request) => ipcRenderer.invoke(SYNC_CHANNELS.unlock, request),
    changePassphrase: (request) => ipcRenderer.invoke(SYNC_CHANNELS.changePassphrase, request),
    command: (command) => ipcRenderer.invoke(SYNC_CHANNELS.command, command),
  },
  totp: {
    register: (profileId, input) => ipcRenderer.invoke(TOTP_CHANNELS.register, { profileId, input }),
    remove: (profileId) => ipcRenderer.invoke(TOTP_CHANNELS.remove, { profileId }),
    getCode: (profileId, registrationId) => ipcRenderer.invoke(TOTP_CHANNELS.code, { profileId, registrationId }),
    copyCode: (profileId, registrationId) => ipcRenderer.invoke(TOTP_CHANNELS.copy, { profileId, registrationId }),
  },
  getState: () => ipcRenderer.invoke(CHANNELS.state),
  dispatch: (command) => ipcRenderer.invoke(CHANNELS.command, command),
  onState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserState) => listener(state);
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(CHANNELS.changed, handler);
  },
  onFocusAddress(listener) {
    const handler = () => listener();
    ipcRenderer.on(CHANNELS.focusAddress, handler);
    return () => ipcRenderer.removeListener(CHANNELS.focusAddress, handler);
  },
  onBookmark(listener) {
    const handler = () => listener();
    ipcRenderer.on(CHANNELS.bookmark, handler);
    return () => ipcRenderer.removeListener(CHANNELS.bookmark, handler);
  },
};

contextBridge.exposeInMainWorld('shinano', api);
