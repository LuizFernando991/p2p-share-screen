import {
  AudioTrack,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
  type TrackReference
} from '@livekit/components-react'
import {
  AudioPresets,
  RoomEvent,
  Track,
  VideoQuality,
  type LocalTrackPublication,
  type RemoteTrackPublication
} from 'livekit-client'
import {
  Activity,
  AudioLines,
  AudioLinesOff,
  Eye,
  LayoutGrid,
  Maximize2,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  Volume1,
  Volume2,
  VolumeX
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

import { SYSTEM_AUDIO_DEVICE_LABEL } from '../../../shared/api'
import {
  DEFAULT_QUALITY,
  publishTestPattern,
  qualityLabel,
  screenCapture,
  screenPublish,
  SHARE_FPS,
  SHARE_MODES,
  SHARE_RESOLUTIONS,
  type ShareMode,
  type ShareQuality
} from '../lib/share'
import { limitationLabel, statsSampler, type InboundStats, type OutboundStats, type TrackStats } from '../lib/stats'
import { SourcePicker } from './SourcePicker'

const isLinux = window.api.platform === 'linux'
const SHARE_MODE_KEY = 'shareMode'
const SHARE_QUALITY_KEY = 'shareQuality'

function trackKey(t: TrackReference): string {
  return `${t.participant.identity}:${t.publication.trackSid}`
}

function loadShareMode(): ShareMode {
  try {
    return localStorage.getItem(SHARE_MODE_KEY) === 'sharp' ? 'sharp' : 'smooth'
  } catch {
    return 'smooth'
  }
}

function loadShareQuality(): ShareQuality {
  try {
    const [height, fps] = (localStorage.getItem(SHARE_QUALITY_KEY) ?? '').split('@').map(Number)
    if (SHARE_RESOLUTIONS.some((r) => r.height === height) && SHARE_FPS.includes(fps as ShareQuality['fps'])) {
      return { height, fps } as ShareQuality
    }
  } catch {
    // Preference only; fall back to the default.
  }
  return DEFAULT_QUALITY
}

/** Waits for venmic's virtual microphone to show up as an input device. */
async function findSystemAudioDevice(): Promise<MediaDeviceInfo> {
  for (let i = 0; i < 30; i++) {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const device = devices.find((d) => d.kind === 'audioinput' && d.label === SYSTEM_AUDIO_DEVICE_LABEL)
    if (device) return device
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('O dispositivo de áudio do sistema não apareceu.')
}

/** Polls a track's WebRTC stats once a second while enabled. */
function useTrackStats(
  track: { getRTCStatsReport(): Promise<RTCStatsReport | undefined> } | undefined,
  enabled: boolean
): TrackStats | null {
  const [stats, setStats] = useState<TrackStats | null>(null)
  useEffect(() => {
    if (!enabled || !track) {
      setStats(null)
      return
    }
    const sample = statsSampler(track)
    let alive = true
    const tick = async () => {
      const s = await sample().catch(() => null)
      if (alive) setStats(s)
    }
    void tick()
    const timer = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [track, enabled])
  return stats
}

const mbps = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`)

/**
 * The screens being shared in the room, Discord-style. The viewer picks one
 * screen to watch: it gets the high simulcast layer and is the only one whose
 * audio plays (other screens' audio is unsubscribed). The rest are thumbnails
 * on the low layer.
 */
export function Stage({
  roomName,
  canPublish,
  audioVolume,
  audioMuted,
  onAudioVolumeChange,
  onAudioMutedChange
}: {
  roomName: string
  canPublish: boolean
  audioVolume: number
  audioMuted: boolean
  onAudioVolumeChange: (volume: number) => void
  onAudioMutedChange: (muted: boolean) => void
}) {
  const room = useRoomContext()
  const participants = useParticipants()
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant()
  const screens = useTracks([Track.Source.ScreenShare], { onlySubscribed: false }).filter(
    (t): t is TrackReference => t.publication !== undefined
  )
  const screenAudio = useTracks([Track.Source.ScreenShareAudio], { onlySubscribed: false }).filter(
    (t): t is TrackReference => t.publication !== undefined
  )
  // Watching is by participant (stable), not track sid (changes on re-share).
  const [watching, setWatching] = useState<string | null>(null)
  const [gridChosen, setGridChosen] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [withAudio, setWithAudio] = useState(true)
  const [shareMode, setShareMode] = useState<ShareMode>(loadShareMode)
  const [shareQuality, setShareQuality] = useState<ShareQuality>(loadShareQuality)
  // Read by the dev test pattern without re-creating window.__share.
  const shareQualityRef = useRef(shareQuality)
  shareQualityRef.current = shareQuality
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const systemAudio = useRef<MediaStreamTrack | null>(null)
  const systemAudioCleanup = useRef<(() => void) | null>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  useFitLevels(controlsRef)

  const watched =
    screens.find((t) => t.participant.identity === watching) ??
    (!gridChosen && screens.length === 1 ? screens[0] : undefined)
  const watchedId = watched?.participant.identity ?? null
  const others = watched ? screens.filter((t) => t !== watched) : screens
  const hasAudio = (identity: string) => screenAudio.some((t) => t.participant.identity === identity)
  const watchedAudio = screenAudio.find(
    (t) => !t.participant.isLocal && t.participant.identity === watchedId && t.publication.track
  )

  function watch(t: TrackReference) {
    setWatching(t.participant.identity)
    setGridChosen(false)
  }

  function backToGrid() {
    setWatching(null)
    setGridChosen(true)
  }

  // Watched screen: high layer + its audio subscribed; others: low layer, no audio.
  const screensKey = screens.map(trackKey).join(',')
  const audioKey = screenAudio.map(trackKey).join(',')
  useEffect(() => {
    for (const t of screens) {
      if (t.participant.isLocal) continue
      ;(t.publication as RemoteTrackPublication).setVideoQuality(
        t.participant.identity === watchedId ? VideoQuality.HIGH : VideoQuality.LOW
      )
    }
    for (const t of screenAudio) {
      if (t.participant.isLocal) continue
      ;(t.publication as RemoteTrackPublication).setSubscribed(t.participant.identity === watchedId)
    }
    // screens/screenAudio are covered by their keys.
  }, [screensKey, audioKey, watchedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const outbound = useTrackStats(localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track, isScreenShareEnabled)
  const inbound = useTrackStats(
    watched && !watched.participant.isLocal ? watched.publication.track : undefined,
    showStats
  )

  async function stopSystemAudio() {
    const track = systemAudio.current
    systemAudio.current = null
    if (track) {
      await localParticipant.unpublishTrack(track, true).catch(() => undefined)
      track.stop()
    }
    systemAudioCleanup.current?.()
    systemAudioCleanup.current = null
    await window.api.screen.stopSystemAudio()
  }

  // Stopping the share from the OS (portal/indicator) unpublishes the video;
  // take the system audio down with it.
  useEffect(() => {
    const onUnpublished = (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) void stopSystemAudio()
    }
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished)
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished)
    }
  })

  async function publishSystemAudio() {
    let track: MediaStreamTrack
    let cleanup: () => void
    if (isLinux) {
      if (!(await window.api.screen.startSystemAudio())) {
        throw new Error('Áudio do sistema indisponível: PipeWire não encontrado.')
      }
      ;({ track, cleanup } = await createLinuxAudioTrack())
    } else {
      ;({ track, cleanup } = await createWindowsAudioTrack())
      if (!(await window.api.screen.startSystemAudio())) {
        cleanup()
        throw new Error('Áudio do sistema indisponível.')
      }
    }
    systemAudio.current = track
    systemAudioCleanup.current = cleanup
    await localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShareAudio,
      name: 'screen-audio',
      dtx: false,
      red: false,
      forceStereo: true,
      audioPreset: AudioPresets.musicHighQualityStereo
    })
  }

  async function createLinuxAudioTrack(): Promise<{ track: MediaStreamTrack; cleanup: () => void }> {
    const device = await findSystemAudioDevice()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: device.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000
      }
    })
    return { track: stream.getAudioTracks()[0], cleanup: () => stream.getTracks().forEach((track) => track.stop()) }
  }

  async function createWindowsAudioTrack(): Promise<{ track: MediaStreamTrack; cleanup: () => void }> {
    const context = new AudioContext({ sampleRate: 48000 })
    const destination = context.createMediaStreamDestination()
    const processor = context.createScriptProcessor(4096, 0, 2)
    const chunks: Float32Array[] = []
    let offset = 0

    const unsubscribe = window.api.screen.onAudioData((data) => {
      const samples = new Float32Array(data.byteLength / 2)
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
      chunks.push(samples)
    })
    processor.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0)
      const right = event.outputBuffer.getChannelData(1)
      left.fill(0)
      right.fill(0)
      let written = 0
      while (written < left.length && chunks.length > 0) {
        const chunk = chunks[0]
        const availableFrames = Math.floor((chunk.length - offset) / 2)
        const frames = Math.min(left.length - written, availableFrames)
        for (let i = 0; i < frames; i++) {
          left[written + i] = chunk[offset + i * 2]
          right[written + i] = chunk[offset + i * 2 + 1]
        }
        written += frames
        offset += frames * 2
        if (offset >= chunk.length) {
          chunks.shift()
          offset = 0
        }
      }
    }
    processor.connect(destination)
    await context.resume()
    const [track] = destination.stream.getAudioTracks()
    return {
      track,
      cleanup: () => {
        unsubscribe()
        processor.disconnect()
        track.stop()
        void context.close()
      }
    }
  }


  async function start(sourceId: string | null) {
    setPicking(false)
    setBusy(true)
    setError('')
    try {
      if (!isLinux) await window.api.screen.select(sourceId, withAudio)
      await localParticipant.setScreenShareEnabled(
        true,
        screenCapture(shareMode, shareQuality),
        screenPublish(shareMode, shareQuality)
      )
      if (withAudio) {
        try {
          await publishSystemAudio()
        } catch (err) {
          setError(`A tela está sendo compartilhada, mas sem áudio: ${err instanceof Error ? err.message : err}`)
        }
      }
    } catch (err) {
      // The user cancelled the picker: NotAllowedError (permission) or AbortError
      // (Electron answers a cancelled request with no source).
      if (!(err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError'))) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    await stopSystemAudio()
    await localParticipant.setScreenShareEnabled(false)
    setBusy(false)
    // Re-sync the tray even if React state did not change (e.g. it was stale).
    window.api.tray.setState({ room: roomName, sharing: false })
  }

  function chooseShareMode(mode: ShareMode) {
    setShareMode(mode)
    try {
      localStorage.setItem(SHARE_MODE_KEY, mode)
    } catch {
      // Preference only; ignore storage errors.
    }
  }

  function chooseShareQuality(quality: ShareQuality) {
    setShareQuality(quality)
    try {
      localStorage.setItem(SHARE_QUALITY_KEY, `${quality.height}@${quality.fps}`)
    } catch {
      // Preference only; ignore storage errors.
    }
  }

  // Keep the tray icon/menu in sync; back to idle when leaving the call.
  useEffect(() => {
    window.api.tray.setState({ room: roomName, sharing: isScreenShareEnabled })
  }, [roomName, isScreenShareEnabled])
  useEffect(() => () => window.api.tray.setState({ room: null, sharing: false }), [])

  // "Parar de compartilhar" in the tray menu.
  useEffect(() => window.api.tray.onStopShare(() => void stop()))

  // Dev-only diagnostics hook (window.__share): publish a test pattern and read stats.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const samplers = new Map<string, () => Promise<TrackStats | null>>()
    let stopPattern: (() => void) | null = null
    const sample = async (track: { sid?: string; getRTCStatsReport(): Promise<RTCStatsReport | undefined> } | undefined) => {
      if (!track?.sid) return null
      if (!samplers.has(track.sid)) samplers.set(track.sid, statsSampler(track))
      return samplers.get(track.sid)!()
    }
    const hook = {
      async testPattern(motion: boolean, toneHz?: number) {
        stopPattern?.()
        stopPattern = await publishTestPattern(localParticipant, motion, shareQualityRef.current, toneHz)
      },
      stopTestPattern() {
        stopPattern?.()
        stopPattern = null
      },
      audioSubscriptions() {
        return [...room.remoteParticipants.values()].map((p) => ({
          name: p.name || p.identity,
          subscribed: p.getTrackPublication(Track.Source.ScreenShareAudio)?.isSubscribed ?? null
        }))
      },
      async stats() {
        const out: Record<string, TrackStats | null> = {
          local: await sample(localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track)
        }
        for (const p of room.remoteParticipants.values()) {
          out[p.name || p.identity] = await sample(p.getTrackPublication(Track.Source.ScreenShare)?.track)
        }
        return out
      }
    }
    Object.assign(window, { __share: hook })
    return () => {
      stopPattern?.()
      Reflect.deleteProperty(window, '__share')
    }
  }, [localParticipant, room])

  return (
    <div className="stage">
      <div className="stage-area">
        {screens.length === 0 ? (
          <div className="empty">
            <p className="muted">Ninguém está compartilhando a tela.</p>
            {canPublish && <p className="muted small">Use “Compartilhar” para começar.</p>}
          </div>
        ) : watched ? (
          <div className="watch-layout">
            <div className="watch-main">
              <ScreenTile
                track={watched}
                variant="main"
                hasAudio={hasAudio(watched.participant.identity)}
                stats={showStats ? inbound : null}
                statsOpen={showStats}
                onToggleStats={watched.participant.isLocal ? undefined : () => setShowStats(!showStats)}
                onBack={backToGrid}
              />
            </div>
            {others.length > 0 && (
              <div className="strip" aria-label="Outras telas na sala">
                {others.map((t) => (
                  <ScreenTile
                    key={trackKey(t)}
                    track={t}
                    variant="thumb"
                    hasAudio={hasAudio(t.participant.identity)}
                    onWatch={() => watch(t)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="grid" aria-label="Telas na sala">
            {screens.map((t) => (
              <ScreenTile
                key={trackKey(t)}
                track={t}
                variant="grid"
                hasAudio={hasAudio(t.participant.identity)}
                onWatch={() => watch(t)}
              />
            ))}
          </div>
        )}
      </div>

      {watchedAudio && <AudioTrack trackRef={watchedAudio} volume={audioVolume} muted={audioMuted} />}

      {error && <p className="error pad">{error}</p>}
      <div className="controls" ref={controlsRef}>
        <div className="controls-group">
          <span className="muted small presence">
            {participants.length} {participants.length === 1 ? 'pessoa' : 'pessoas'}
          </span>
          <VolumeControl
            volume={audioVolume}
            muted={audioMuted}
            active={Boolean(watchedAudio)}
            onVolumeChange={onAudioVolumeChange}
            onMutedChange={onAudioMutedChange}
          />
          {isScreenShareEnabled && outbound?.kind === 'outbound' && <OutboundBadge stats={outbound} />}
        </div>

        <div className="controls-group end">
          {canPublish && (
            <>
              <div className="segmented" role="radiogroup" aria-label="Modo da transmissão">
                {(Object.keys(SHARE_MODES) as ShareMode[]).map((mode) => (
                  <button
                    key={mode}
                    role="radio"
                    aria-checked={shareMode === mode}
                    className={shareMode === mode ? 'selected' : ''}
                    title={SHARE_MODES[mode].hint}
                    disabled={isScreenShareEnabled}
                    onClick={() => chooseShareMode(mode)}
                  >
                    {SHARE_MODES[mode].label}
                  </button>
                ))}
              </div>
              <select
                className="quality-select"
                aria-label="Resolução e fps da transmissão"
                title="Resolução e fps da transmissão (a tela nunca é ampliada)"
                value={qualityLabel(shareQuality)}
                disabled={isScreenShareEnabled}
                onChange={(e) => {
                  const [height, fps] = e.target.value.split('p').map(Number)
                  chooseShareQuality({ height, fps } as ShareQuality)
                }}
              >
                {SHARE_RESOLUTIONS.flatMap((r) =>
                  SHARE_FPS.map((fps) => (
                    <option key={`${r.height}-${fps}`} value={qualityLabel({ height: r.height, fps })}>
                      {r.label} · {fps} fps
                    </option>
                  ))
                )}
              </select>
              <label
                className={`chip ${withAudio ? 'on' : ''} ${isScreenShareEnabled ? 'locked' : ''}`}
                title={withAudio ? 'Áudio do sistema: ligado' : 'Áudio do sistema: desligado'}
              >
                <input
                  type="checkbox"
                  checked={withAudio}
                  disabled={isScreenShareEnabled}
                  onChange={(e) => setWithAudio(e.target.checked)}
                />
                {withAudio ? <AudioLines size={15} /> : <AudioLinesOff size={15} />}
                <span className="label">Áudio do sistema</span>
              </label>
              {isScreenShareEnabled ? (
                <button className="danger" disabled={busy} onClick={stop} title="Parar de compartilhar">
                  <MonitorOff size={16} /> <span className="label">Parar</span>
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => (isLinux ? start(null) : setPicking(true))}
                  title="Compartilhar tela"
                >
                  <MonitorUp size={16} /> <span className="label">{busy ? 'Iniciando…' : 'Compartilhar'}</span>
                </button>
              )}
            </>
          )}
          <button className="ghost danger" onClick={() => room.disconnect()} title="Desconectar da sala">
            <PhoneOff size={16} /> <span className="label">Sair</span>
          </button>
        </div>
      </div>

      {picking && <SourcePicker onPick={start} onClose={() => setPicking(false)} />}
    </div>
  )
}

/** What your share is sending: resolution (strong) and fps; warns when limited. */
function OutboundBadge({ stats }: { stats: OutboundStats }) {
  const top = stats.layers[0]
  const limited = stats.layers.find((l) => l.limitation !== 'none')?.limitation
  if (!top) return null
  return (
    <span
      className={`out-badge ${limited ? 'warn' : ''}`}
      title={`Você está transmitindo: ${stats.layers
        .map((l) => `${l.height}p ${Math.round(l.fps)} fps ${mbps(l.kbps)}`)
        .join(' · ')}${limited ? ` — ${limitationLabel[limited]}` : ''}`}
    >
      <span className="live-dot" />
      <strong>{top.height}p</strong>
      <span className="out-fps">{Math.round(top.fps)} fps</span>
      {limited && <span className="out-limit">{limitationLabel[limited]}</span>}
    </span>
  )
}

/**
 * Keeps the controls bar on one row: on every render and resize it measures
 * whether the content fits and, if not, applies compact levels one by one
 * (data-c1: drop secondary info; data-c2: icon-only; data-c3: allow a second
 * row). Measuring works whatever the font, zoom or translation.
 */
function useFitLevels(ref: React.RefObject<HTMLDivElement | null>) {
  // scrollWidth ignores overflow on overflow:visible boxes, so compare edges:
  // groups don't shrink, so content that doesn't fit runs past the padding.
  const fits = (el: HTMLElement) => {
    const groups = [...el.children] as HTMLElement[]
    if (groups.length === 0) return true
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const right = box.right - parseFloat(style.paddingRight)
    const gap = parseFloat(style.columnGap) || 0
    const needed = groups.reduce((sum, g) => sum + g.getBoundingClientRect().width, 0) + gap * (groups.length - 1)
    return needed <= right - (box.left + parseFloat(style.paddingLeft)) + 1
  }
  const fit = () => {
    const el = ref.current
    if (!el) return
    for (const level of ['c1', 'c2', 'c3']) delete el.dataset[level]
    for (const level of ['c1', 'c2', 'c3']) {
      if (fits(el)) return
      el.dataset[level] = ''
    }
  }
  useLayoutEffect(fit)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

function StatsPanel({ stats }: { stats: InboundStats | null }) {
  if (!stats) return <div className="stats-panel">Medindo…</div>
  return (
    <div className="stats-panel">
      <div>
        {stats.width}×{stats.height} · {Math.round(stats.fps)} fps · {mbps(stats.kbps)}
      </div>
      <div>
        Perda {stats.lossPct.toFixed(1)}% · jitter {Math.round(stats.jitterMs)} ms
      </div>
      <div className={stats.freezes > 0 || stats.framesDropped > 0 ? 'warn' : ''}>
        Congelamentos {stats.freezes} · quadros perdidos {stats.framesDropped}
      </div>
    </div>
  )
}

function ScreenTile({
  track,
  variant,
  hasAudio,
  stats,
  statsOpen,
  onWatch,
  onBack,
  onToggleStats
}: {
  track: TrackReference
  variant: 'main' | 'thumb' | 'grid'
  hasAudio: boolean
  stats?: TrackStats | null
  statsOpen?: boolean
  onWatch?: () => void
  onBack?: () => void
  onToggleStats?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const name = track.participant.name || track.participant.identity
  const main = variant === 'main'
  return (
    <div
      ref={ref}
      className={`tile ${variant}`}
      onClick={onWatch}
      onDoubleClick={() => void ref.current?.requestFullscreen()}
      role={onWatch ? 'button' : undefined}
      aria-label={onWatch ? `Assistir a tela de ${name}` : undefined}
    >
      <VideoTrack trackRef={track} />
      <span className="tile-name">
        {main && !track.participant.isLocal && hasAudio && <Volume2 size={12} />}
        {name}
        {track.participant.isLocal && ' (você)'}
      </span>
      {onWatch && (
        <span className="tile-watch">
          <Eye size={14} /> Assistir{hasAudio && !track.participant.isLocal ? ' com áudio' : ''}
        </span>
      )}
      <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
        {onToggleStats && (
          <button
            className={`icon ${statsOpen ? 'active' : ''}`}
            title="Qualidade da conexão"
            aria-label="Qualidade da conexão"
            onClick={onToggleStats}
          >
            <Activity size={14} />
          </button>
        )}
        {onBack && (
          <button className="icon" title="Ver todas as telas" aria-label="Ver todas as telas" onClick={onBack}>
            <LayoutGrid size={14} />
          </button>
        )}
        {variant !== 'thumb' && (
          <button
            className="icon"
            title="Tela cheia"
            aria-label="Tela cheia"
            onClick={() => void ref.current?.requestFullscreen()}
          >
            <Maximize2 size={14} />
          </button>
        )}
      </div>
      {main && statsOpen && <StatsPanel stats={stats?.kind === 'inbound' ? stats : null} />}
    </div>
  )
}

/** Volume of the watched screen's audio: icon (mute), filled slider, value; wheel adjusts. */
function VolumeControl({
  volume,
  muted,
  active,
  onVolumeChange,
  onMutedChange
}: {
  volume: number
  muted: boolean
  /** Whether a watched screen with audio is playing. */
  active: boolean
  onVolumeChange: (volume: number) => void
  onMutedChange: (muted: boolean) => void
}) {
  const level = muted ? 0 : volume
  const pct = Math.round(level * 100)
  const set = (v: number) => {
    const next = Math.min(1, Math.max(0, Math.round(v * 100) / 100))
    onVolumeChange(next)
    if (next > 0 && muted) onMutedChange(false)
  }
  const toggleMute = () => {
    if (!muted && volume > 0) return onMutedChange(true)
    onMutedChange(false)
    if (volume === 0) onVolumeChange(0.5) // unmuting at 0 would stay silent
  }
  const Icon = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2
  return (
    <div
      className={`volume ${active ? '' : 'idle'}`}
      title={active ? 'Volume da tela que você está assistindo' : 'Nenhuma tela com áudio sendo assistida'}
      onWheel={(e) => set(level + (e.deltaY < 0 ? 0.05 : -0.05))}
    >
      <button
        className="icon volume-icon"
        title={muted ? 'Ativar áudio' : 'Silenciar áudio'}
        aria-label={muted ? 'Ativar áudio' : 'Silenciar áudio'}
        onClick={toggleMute}
      >
        <Icon size={16} />
      </button>
      <input
        className="volume-range"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={level}
        aria-label="Volume da tela assistida"
        aria-valuetext={`${pct}%`}
        style={{ '--level': level } as CSSProperties}
        onChange={(e) => set(Number(e.target.value))}
      />
      <span className="volume-value">{pct}%</span>
    </div>
  )
}
