import { contextBridge, ipcRenderer } from 'electron'

import type { DesktopApi } from '../shared/api'

const api: DesktopApi = {
  platform: process.platform,
  auth: {
    session: () => ipcRenderer.invoke('auth:session'),
    defaultServer: () => ipcRenderer.invoke('auth:default-server'),
    login: (server, username, password) => ipcRenderer.invoke('auth:login', server, username, password),
    logout: () => ipcRenderer.invoke('auth:logout'),
    changePassword: (current, next) => ipcRenderer.invoke('auth:change-password', current, next),
    onExpired: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('auth:expired', listener)
      return () => ipcRenderer.removeListener('auth:expired', listener)
    }
  },
  request: (method, path, body) => ipcRenderer.invoke('api:request', method, path, body),
  screen: {
    listSources: () => ipcRenderer.invoke('screen:list-sources'),
    select: (sourceId, audio) => ipcRenderer.invoke('screen:select', sourceId, audio),
    startSystemAudio: () => ipcRenderer.invoke('screen:start-system-audio'),
    stopSystemAudio: () => ipcRenderer.invoke('screen:stop-system-audio')
  }
}

contextBridge.exposeInMainWorld('api', api)
