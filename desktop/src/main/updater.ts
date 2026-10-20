import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/**
 * Auto-update from the GitHub releases (see `publish` in electron-builder.yml).
 * Updates download in the background and install when the app quits, so a
 * share is never cut by a restart; onReady lets the user restart sooner.
 * Only in packaged builds. SHARESCREEN_UPDATE_URL points it to a plain HTTP
 * folder instead (for testing a release before publishing it).
 */
export function startAutoUpdate(onReady: (version: string) => void): void {
  if (!app.isPackaged) return
  if (process.env.SHARESCREEN_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.SHARESCREEN_UPDATE_URL })
  }
  autoUpdater.on('update-downloaded', (info) => onReady(info.version))
  autoUpdater.on('error', (err) => console.warn('auto-update:', err.message))
  const check = () => void autoUpdater.checkForUpdates().catch((err) => console.warn('auto-update check:', err))
  check()
  setInterval(check, CHECK_EVERY_MS)
}

/** Quits and installs the downloaded update, then reopens the app. */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
