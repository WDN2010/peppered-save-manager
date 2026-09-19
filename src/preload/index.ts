import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/ipc';

const api: RendererApi = {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseSavePath: () => ipcRenderer.invoke('app:choose-save-path'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
  capture: (title) => ipcRenderer.invoke('app:capture', { title }),
  rename: (id, title) => ipcRenderer.invoke('app:rename', { id, title }),
  delete: (id) => ipcRenderer.invoke('app:delete', { id }),
  restore: (id) => ipcRenderer.invoke('app:restore', { id }),
  restoreAndLaunch: (id) => ipcRenderer.invoke('app:restore-and-launch', { id }),
  exportCatalog: () => ipcRenderer.invoke('app:export'),
  importCatalog: () => ipcRenderer.invoke('app:import'),
};

contextBridge.exposeInMainWorld('peppered', api);
