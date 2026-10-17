import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, safeStorage } from 'electron'

interface SettingsFile {
  server?: string
  /** Refresh token encrypted with safeStorage, base64. */
  refreshToken?: string
  /** The "still running in the tray" notice was shown once. */
  trayHintShown?: boolean
}

/**
 * Persists the server URL and the refresh token in userData. The refresh
 * token is only written to disk when the OS keyring can encrypt it;
 * otherwise it lives in memory and the user logs in again on next launch.
 */
export class Settings {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private data: SettingsFile = {}
  private memoryToken: string | null = null

  constructor() {
    try {
      if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      this.data = {}
    }
  }

  get server(): string | undefined {
    return this.data.server
  }

  set server(value: string | undefined) {
    this.data.server = value
    this.save()
  }

  get trayHintShown(): boolean {
    return this.data.trayHintShown ?? false
  }

  set trayHintShown(value: boolean) {
    this.data.trayHintShown = value
    this.save()
  }

  get refreshToken(): string | null {
    if (this.memoryToken) return this.memoryToken
    if (!this.data.refreshToken || !canEncrypt()) return null
    try {
      return safeStorage.decryptString(Buffer.from(this.data.refreshToken, 'base64'))
    } catch {
      return null
    }
  }

  set refreshToken(token: string | null) {
    this.memoryToken = token
    this.data.refreshToken =
      token && canEncrypt() ? safeStorage.encryptString(token).toString('base64') : undefined
    this.save()
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }
}

function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  // On Linux without a keyring, Chromium falls back to a hardcoded key.
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}
