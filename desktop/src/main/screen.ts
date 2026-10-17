import { app, desktopCapturer, type Session } from 'electron'

import type { ScreenSource } from '../shared/api'

// Minimal shape of @vencord/venmic's PatchBay (optional, Linux only).
interface PatchBay {
  link(data: {
    include?: Record<string, string>[]
    exclude?: Record<string, string>[]
    only_speakers?: boolean
    only_default_speakers?: boolean
    ignore_devices?: boolean
  }): boolean
  unlink(): void
}

let pending: { sourceId: string | null; audio: boolean } = { sourceId: null, audio: false }

/**
 * Answers getDisplayMedia calls from the renderer. On Linux (Wayland) the
 * xdg-desktop-portal shows its own picker when sources are listed and
 * returns only the chosen one; elsewhere the renderer picks first and calls
 * select().
 */
export function registerDisplayMediaHandler(session: Session): void {
  session.setDisplayMediaRequestHandler(async (_request, callback) => {
    const { sourceId, audio } = pending
    pending = { sourceId: null, audio: false }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      })
      const source = sourceId ? sources.find((s) => s.id === sourceId) : sources[0]
      if (!source) {
        callback({})
        return
      }
      // System audio: loopback on Windows; Linux uses venmic instead.
      callback(process.platform === 'win32' && audio ? { video: source, audio: 'loopback' } : { video: source })
    } catch {
      callback({})
    }
  })
}

export function selectSource(sourceId: string | null, audio: boolean): void {
  pending = { sourceId, audio }
}

export async function listSources(): Promise<ScreenSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 }
  })
  return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
}

let patchBay: PatchBay | null | undefined

async function getPatchBay(): Promise<PatchBay | null> {
  if (patchBay !== undefined) return patchBay
  patchBay = null
  if (process.platform !== 'linux') return null
  try {
    // A native CommonJS module: once bundled, its exports may sit under `default`.
    const venmic = await import('@vencord/venmic')
    const PatchBayClass = venmic.PatchBay ?? (venmic as unknown as { default: typeof venmic }).default.PatchBay
    if (PatchBayClass.hasPipeWire()) patchBay = new PatchBayClass()
  } catch (err) {
    console.warn('venmic unavailable:', err)
  }
  return patchBay
}

/**
 * Linux: links the audio of every app except ours into venmic's virtual
 * microphone, so viewers do not hear other rooms we are watching.
 */
export async function startSystemAudio(): Promise<boolean> {
  const bay = await getPatchBay()
  if (!bay) return false
  const ownAudio = app.getAppMetrics().find((m) => m.name === 'Audio Service')?.pid
  return bay.link({
    exclude: ownAudio ? [{ 'application.process.id': String(ownAudio) }] : [],
    ignore_devices: true,
    only_speakers: true,
    only_default_speakers: true
  })
}

export async function stopSystemAudio(): Promise<void> {
  ;(await getPatchBay())?.unlink()
}
