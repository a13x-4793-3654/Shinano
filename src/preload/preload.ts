import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type BrowserState, type ShinanoAPI } from '../shared/model.ts';
import { TOTP_CHANNELS } from '../shared/totp.ts';

const api: ShinanoAPI = {
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
};

contextBridge.exposeInMainWorld('shinano', api);
