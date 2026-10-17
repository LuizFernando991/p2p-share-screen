import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, session, shell } from 'electron'

import type { HttpMethod } from '../shared/api'
import { Backend } from './backend'
import { listSources, registerDisplayMediaHandler, selectSource, startSystemAudio, stopSystemAudio } from './screen'
import { Settings } from './settings'

const DEFAULT_SERVER = process.env.SHARESCREEN_SERVER ?? 'http://localhost:8080'
const METHODS: HttpMethod[] = ['GET', 'POST', 'PATCH', 'DELETE']
const ALLOWED_PERMISSIONS = ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']

// Separate profiles let several instances (users) run side by side in dev.
if (process.env.SHARESCREEN_PROFILE) {
  app.setPath('userData', join(app.getPath('appData'), `ShareScreen-${process.env.SHARESCREEN_PROFILE}`))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'ShareScreen',
    backgroundColor: '#24273a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(backend: Backend): void {
  ipcMain.handle('auth:session', () => backend.restore())
  ipcMain.handle('auth:login', (_e, username: string, password: string) =>
    backend.login(String(username), String(password))
  )
  ipcMain.handle('settings:server', () => backend.configuredServer)
  ipcMain.handle('settings:set-server', (_e, url: string) => backend.setServer(String(url)))
  ipcMain.handle('auth:logout', () => backend.logout())
  ipcMain.handle('auth:change-password', (_e, current: string, next: string) =>
    backend.changePassword(String(current), String(next))
  )
  ipcMain.handle('api:request', (_e, method: HttpMethod, path: string, body?: unknown) => {
    if (!METHODS.includes(method) || typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('/api/auth/')) {
      return { ok: false, error: { status: 400, code: 'invalid_request', message: 'invalid request' } }
    }
    return backend.call(method, path, body)
  })
  ipcMain.handle('screen:list-sources', () => listSources())
  ipcMain.handle('screen:select', (_e, sourceId: string | null, audio: boolean) =>
    selectSource(sourceId ? String(sourceId) : null, Boolean(audio))
  )
  ipcMain.handle('screen:start-system-audio', () => startSystemAudio())
  ipcMain.handle('screen:stop-system-audio', () => stopSystemAudio())
}

app.whenReady().then(() => {
  const settings = new Settings()
  const backend = new Backend(settings, DEFAULT_SERVER, () => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('auth:expired')
  })
  registerIpc(backend)

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.includes(permission))
  )
  // Lets enumerateDevices return labels (needed to find the system audio device).
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.includes(permission))
  registerDisplayMediaHandler(session.defaultSession)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void stopSystemAudio()
  if (process.platform !== 'darwin') app.quit()
})
