import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type BrowserState, type ShinanoAPI } from '../shared/model.ts';

const api: ShinanoAPI = {
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
