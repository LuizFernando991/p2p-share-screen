import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, Notification, session, shell } from 'electron'

import type { HttpMethod, MediaState } from '../shared/api'
import { Backend } from './backend'
import { listSources, registerDisplayMediaHandler, selectSource, startSystemAudio, stopSystemAudio } from './screen'
import { Settings } from './settings'
import { AppTray, resource } from './tray'

const DEFAULT_SERVER = process.env.SHARESCREEN_SERVER ?? 'http://localhost:8080'
const METHODS: HttpMethod[] = ['GET', 'POST', 'PATCH', 'DELETE']
const ALLOWED_PERMISSIONS = ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']

// Separate profiles let several instances (users) run side by side in dev.
if (process.env.SHARESCREEN_PROFILE) {
  app.setPath('userData', join(app.getPath('appData'), `ShareScreen-${process.env.SHARESCREEN_PROFILE}`))
}

// Chromium's WebRTC may set the OS microphone volume on its own (it pushed it
// to 100% on Linux when joining a room). We never send a microphone, so the
// app must not touch the system input volume. Must run before app ready.
app.commandLine.appendSwitch('disable-features', 'WebRtcAllowInputVolumeAdjustment')

let mainWindow: BrowserWindow | null = null
let quitting = false

const tray = new AppTray(
  () => mainWindow,
  () => {
    quitting = true
    app.quit()
  }
)

function createWindow(settings: Settings): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 540,
    show: false,
    title: 'ShareScreen',
    icon: resource('icon.png'),
    backgroundColor: '#24273a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('show', () => tray.refresh())
  win.on('hide', () => tray.refresh())

  // Closing hides to the tray (calls and shares keep running); quit from the tray menu.
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
    if (!settings.trayHintShown && Notification.isSupported()) {
      settings.trayHintShown = true
      new Notification({
        title: 'O ShareScreen continua aberto',
        body: 'Ele fica na bandeja do sistema. Use o ícone para voltar, controlar o compartilhamento ou sair.',
        icon: resource('icon.png')
      }).show()
    }
  })
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(backend: Backend, settings: Settings): void {
  ipcMain.handle('auth:session', () => backend.restore())
  ipcMain.handle('auth:login', (_e, username: string, password: string) =>
    backend.login(String(username), String(password))
  )
  ipcMain.handle('settings:server', () => backend.configuredServer)
  ipcMain.handle('settings:set-server', (_e, url: string) => backend.setServer(String(url)))
  ipcMain.handle('settings:audio-excluded-apps', () => settings.audioExcludedApps)
  ipcMain.handle('settings:set-audio-excluded-apps', (_e, apps: unknown) => {
    if (!Array.isArray(apps)) throw new Error('invalid audio app list')
    settings.audioExcludedApps = apps
      .filter((appName): appName is string => typeof appName === 'string')
      .map((appName) => appName.trim())
      .filter(Boolean)
      .slice(0, 50)
    return undefined
  })
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
  ipcMain.handle('screen:start-system-audio', (event) =>
    startSystemAudio(settings.audioExcludedApps, (chunk) => event.sender.send('screen:audio-data', chunk))
  )
  ipcMain.handle('screen:stop-system-audio', () => stopSystemAudio())
  ipcMain.on('tray:state', (_e, state: MediaState) => {
    tray.setState({ room: typeof state?.room === 'string' ? state.room : null, sharing: Boolean(state?.sharing) })
  })
}

// Windows: ties the taskbar/Start menu entry to the installed shortcut and its icon.
if (process.platform === 'win32') app.setAppUserModelId('com.sharescreen.app')

// One instance per profile: opening the app again brings the hidden window back.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => tray.showWindow())

  app.whenReady().then(() => {
    const settings = new Settings()
    const backend = new Backend(settings, DEFAULT_SERVER, () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('auth:expired')
    })
    registerIpc(backend, settings)

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.includes(permission))
    )
    // Lets enumerateDevices return labels (needed to find the system audio device).
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.includes(permission))
    registerDisplayMediaHandler(session.defaultSession)

    createWindow(settings)
    tray.create()
    app.on('activate', () => {
      if (mainWindow) tray.showWindow()
      else createWindow(settings)
    })
  })
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  void stopSystemAudio()
  if (process.platform !== 'darwin') app.quit()
})
