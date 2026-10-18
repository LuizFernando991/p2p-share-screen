import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

interface LoopbackCapture {
  start(processId: number, includeProcessTree: boolean, callback: (chunk: Buffer) => void): void
  startSystemAudio(callback: (chunk: Buffer) => void): void
  stop(): void
}

const execFileAsync = promisify(execFile)
let windowsCapture: LoopbackCapture | null = null

let pending: { sourceId: string | null; audio: boolean } = { sourceId: null, audio: false }

/**
 * Answers getDisplayMedia calls from the renderer. On Linux (Wayland) the
 * xdg-desktop-portal shows its own picker when sources are listed and
 * returns only the chosen one; elsewhere the renderer picks first and calls
 * select().
 */
export function registerDisplayMediaHandler(session: Session): void {
  session.setDisplayMediaRequestHandler(async (_request, callback) => {
    const { sourceId } = pending
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
      // Linux publishes audio through venmic; Windows uses the native capture
      // path below so excluded applications do not enter the stream.
      callback({ video: source })
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
export async function startSystemAudio(excludedApps: string[], sendAudio?: (chunk: Buffer) => void): Promise<boolean> {
  if (process.platform === 'win32') return startWindowsSystemAudio(excludedApps, sendAudio)
  const bay = await getPatchBay()
  if (!bay) return false
  const ownAudio = app.getAppMetrics().find((m) => m.name === 'Audio Service')?.pid
  const appExcludes: Record<string, string>[] = excludedApps.flatMap((name) => [
    { 'application.name': name } as Record<string, string>,
    { 'application.process.binary': name } as Record<string, string>
  ])
  return bay.link({
    exclude: [
      ...appExcludes,
      ...(ownAudio ? [{ 'application.process.id': String(ownAudio) }] : [])
    ],
    ignore_devices: true,
    only_speakers: true,
    only_default_speakers: true
  })
}

export async function stopSystemAudio(): Promise<void> {
  windowsCapture?.stop()
  windowsCapture = null
  ;(await getPatchBay())?.unlink()
}

async function startWindowsSystemAudio(excludedApps: string[], sendAudio?: (chunk: Buffer) => void): Promise<boolean> {
  if (!sendAudio) return false
  const module = (await import('loopback-capture')) as unknown as {
    default?: { LoopbackCapture: new () => LoopbackCapture }
    LoopbackCapture?: new () => LoopbackCapture
  }
  const Capture = module.LoopbackCapture ?? module.default?.LoopbackCapture
  if (!Capture) return false

  const excluded = await findExcludedWindowsProcess(excludedApps)
  if (excludedApps.length > 0 && !excluded) return false
  const capture = new Capture()
  try {
    if (excluded) capture.start(excluded.pid, false, sendAudio)
    else capture.startSystemAudio(sendAudio)
    windowsCapture = capture
    return true
  } catch (err) {
    capture.stop()
    console.warn('Windows audio capture unavailable:', err)
    return false
  }
}

async function findExcludedWindowsProcess(appNames: string[]): Promise<{ pid: number } | null> {
  if (appNames.length === 0) return null
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true })
    const names = appNames.map(normalizeProcessName).filter(Boolean)
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)","(\d+)"/)
      if (!match) continue
      const processName = normalizeProcessName(match[1])
      if (names.includes(processName)) return { pid: Number(match[2]) }
    }
  } catch (err) {
    console.warn('Could not enumerate Windows processes:', err)
  }
  return null
}

function normalizeProcessName(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, '').replace(/\s+/g, '')
}
