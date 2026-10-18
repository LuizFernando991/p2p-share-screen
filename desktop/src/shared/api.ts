// Types shared by main, preload and renderer. Backend payloads mirror the
// JSON returned by backend/internal/httpapi.

export type Role = 'admin' | 'user'

export interface User {
  id: string
  username: string
  display_name: string
  role: Role
  disabled: boolean
  created_at: string
  updated_at: string
}

export type RoomType = 'restricted' | 'private'
export type MemberRole = 'owner' | 'member'

export interface Room {
  id: string
  name: string
  type: RoomType
  temporary: boolean
  owner: { id: string; username: string; display_name: string }
  join_code?: string
  my_role?: MemberRole
  can_manage: boolean
  can_publish: boolean
  member_count: number
  live?: { participants: number; publishers: number }
  created_at: string
  updated_at: string
}

export interface Member {
  user_id: string
  username: string
  display_name: string
  role: MemberRole
  can_publish: boolean
  disabled: boolean
  joined_at: string
}

export interface DirectoryUser {
  id: string
  username: string
  display_name: string
}

export interface JoinToken {
  livekit_url: string
  token: string
  room: Room
}

export interface ApiErrorBody {
  /** HTTP status; 0 when the server could not be reached. */
  status: number
  code: string
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody }

export interface Session {
  user: User
  server: string
}

export interface ScreenSource {
  id: string
  name: string
  /** PNG data URL. */
  thumbnail: string
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** What the renderer tells the tray about the current call. */
export interface MediaState {
  /** Name of the connected room, or null when not in a call. */
  room: string | null
  sharing: boolean
}

/** The API the preload script exposes to the renderer as `window.api`. */
export interface DesktopApi {
  platform: string
  auth: {
    /** Restores the saved session, if any. */
    session(): Promise<Session | null>
    /** Logs into the server configured in settings. */
    login(username: string, password: string): Promise<Result<Session>>
    logout(): Promise<void>
    changePassword(current: string, next: string): Promise<Result<null>>
    /** Called when the session can no longer be refreshed. Returns an unsubscribe function. */
    onExpired(callback: () => void): () => void
  }
  settings: {
    server(): Promise<string>
    /** Validates and saves the server URL; changing it ends the current session. */
    setServer(url: string): Promise<Result<string>>
    audioExcludedApps(): Promise<string[]>
    setAudioExcludedApps(apps: string[]): Promise<void>
  }
  /** Authenticated call to the backend. Paths start with /api/ (auth endpoints excluded). */
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<Result<T>>
  tray: {
    /** Keeps the tray icon and menu in sync with the call. */
    setState(state: MediaState): void
    /** Called when "Stop sharing" is chosen in the tray. Returns an unsubscribe function. */
    onStopShare(callback: () => void): () => void
  }
  screen: {
    /** Screens and windows with thumbnails (Windows/macOS; on Linux the system picker is used). */
    listSources(): Promise<ScreenSource[]>
    /** Chooses the source and audio for the next getDisplayMedia call. */
    select(sourceId: string | null, audio: boolean): Promise<void>
    /** Linux: links every app's audio except ours into a virtual microphone. */
    startSystemAudio(): Promise<boolean>
    stopSystemAudio(): Promise<void>
  }
}

/** Label of the virtual microphone created by venmic on Linux. */
export const SYSTEM_AUDIO_DEVICE_LABEL = 'vencord-screen-share'
