import { net } from 'electron'

import type { HttpMethod, Result, Session, User } from '../shared/api'
import type { Settings } from './settings'

interface TokenPair {
  access_token: string
  refresh_token: string
  expires_in: number
}

interface LoginResponse extends TokenPair {
  user: User
}

const notLoggedIn: Result<never> = {
  ok: false,
  error: { status: 401, code: 'not_logged_in', message: 'not logged in' }
}

/**
 * Talks to the backend on behalf of the renderer, which never sees the
 * tokens. Refreshes are serialized: the backend treats two concurrent uses
 * of the same refresh token as theft and revokes the session.
 */
export class Backend {
  private server = ''
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<Result<null>> | null = null

  constructor(
    private readonly settings: Settings,
    private readonly defaultServer: string,
    private readonly onExpired: () => void
  ) {}

  get configuredServer(): string {
    return this.settings.server ?? this.defaultServer
  }

  /** Saves a new server URL. A different server invalidates the session. */
  setServer(input: string): Result<string> {
    const base = normalizeServer(input)
    if (!base) {
      return { ok: false, error: { status: 0, code: 'invalid_server', message: 'invalid server URL' } }
    }
    if (base !== this.configuredServer) {
      this.clear()
      this.server = ''
    }
    this.settings.server = base
    return { ok: true, data: base }
  }

  async restore(): Promise<Session | null> {
    this.server = this.settings.server ?? ''
    if (!this.server || !this.settings.refreshToken) return null
    const me = await this.call<User>('GET', '/api/me')
    return me.ok ? { user: me.data, server: this.server } : null
  }

  async login(username: string, password: string): Promise<Result<Session>> {
    const base = this.configuredServer
    const res = await send<LoginResponse>('POST', `${base}/api/auth/login`, { username, password })
    if (!res.ok) return res
    this.server = base
    this.setTokens(res.data)
    return { ok: true, data: { user: res.data.user, server: base } }
  }

  async logout(): Promise<void> {
    const refreshToken = this.settings.refreshToken
    if (this.server && refreshToken) {
      await send('POST', `${this.server}/api/auth/logout`, { refresh_token: refreshToken })
    }
    this.clear()
  }

  async changePassword(current: string, next: string): Promise<Result<null>> {
    const res = await this.call<TokenPair>('PATCH', '/api/me/password', {
      current_password: current,
      new_password: next
    })
    if (!res.ok) return res
    // Changing the password ends every session and returns a new pair.
    this.setTokens(res.data)
    return { ok: true, data: null }
  }

  async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<Result<T>> {
    if (!this.server) return notLoggedIn
    if (!this.access || Date.now() > this.access.expiresAt - 30_000) {
      const refreshed = await this.refresh()
      if (!refreshed.ok) return refreshed
    }
    let res = await send<T>(method, this.server + path, body, this.access?.token)
    if (!res.ok && res.error.status === 401) {
      const refreshed = await this.refresh()
      if (!refreshed.ok) return refreshed
      res = await send<T>(method, this.server + path, body, this.access?.token)
    }
    return res
  }

  private refresh(): Promise<Result<null>> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<Result<null>> {
    const refreshToken = this.settings.refreshToken
    if (!refreshToken) {
      this.expire()
      return notLoggedIn
    }
    const res = await send<TokenPair>('POST', `${this.server}/api/auth/refresh`, {
      refresh_token: refreshToken
    })
    if (res.ok) {
      this.setTokens(res.data)
      return { ok: true, data: null }
    }
    // Network errors keep the session; rejected tokens end it.
    if (res.error.status === 401 || res.error.status === 403) this.expire()
    return res
  }

  private setTokens(pair: TokenPair): void {
    this.access = { token: pair.access_token, expiresAt: Date.now() + pair.expires_in * 1000 }
    this.settings.refreshToken = pair.refresh_token
  }

  private clear(): void {
    this.access = null
    this.settings.refreshToken = null
  }

  private expire(): void {
    this.clear()
    this.onExpired()
  }
}

function normalizeServer(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

async function send<T>(method: HttpMethod, url: string, body?: unknown, token?: string): Promise<Result<T>> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const res = await net.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (res.status === 204) return { ok: true, data: null as T }
    const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    if (res.ok) return { ok: true, data: json as T }
    return {
      ok: false,
      error: {
        status: res.status,
        code: json?.error?.code ?? 'http_error',
        message: json?.error?.message ?? res.statusText
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: { status: 0, code: 'network_error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}
