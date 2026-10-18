import { contextBridge, ipcRenderer } from 'electron'

import type { DesktopApi } from '../shared/api'

const api: DesktopApi = {
  platform: process.platform,
  auth: {
    session: () => ipcRenderer.invoke('auth:session'),
    login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
    logout: () => ipcRenderer.invoke('auth:logout'),
    changePassword: (current, next) => ipcRenderer.invoke('auth:change-password', current, next),
    onExpired: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('auth:expired', listener)
      return () => ipcRenderer.removeListener('auth:expired', listener)
    }
  },
  settings: {
    server: () => ipcRenderer.invoke('settings:server'),
    setServer: (url) => ipcRenderer.invoke('settings:set-server', url),
    audioExcludedApps: () => ipcRenderer.invoke('settings:audio-excluded-apps'),
    setAudioExcludedApps: (apps) => ipcRenderer.invoke('settings:set-audio-excluded-apps', apps)
  },
  request: (method, path, body) => ipcRenderer.invoke('api:request', method, path, body),
  tray: {
    setState: (state) => ipcRenderer.send('tray:state', state),
    onStopShare: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('tray:stop-share', listener)
      return () => ipcRenderer.removeListener('tray:stop-share', listener)
    }
  },
  screen: {
    listSources: () => ipcRenderer.invoke('screen:list-sources'),
    select: (sourceId, audio) => ipcRenderer.invoke('screen:select', sourceId, audio),
    startSystemAudio: () => ipcRenderer.invoke('screen:start-system-audio'),
    stopSystemAudio: () => ipcRenderer.invoke('screen:stop-system-audio')
  }
}

contextBridge.exposeInMainWorld('api', api)
