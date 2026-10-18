import {
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
  type TrackReference
} from '@livekit/components-react'
import { AudioPresets, RoomEvent, ScreenSharePresets, Track, type LocalTrackPublication } from 'livekit-client'
import { Maximize2, MonitorOff, MonitorUp, PhoneOff, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { SYSTEM_AUDIO_DEVICE_LABEL } from '../../../shared/api'
import { SourcePicker } from './SourcePicker'

const isLinux = window.api.platform === 'linux'

function trackKey(t: TrackReference): string {
  return `${t.participant.identity}:${t.publication.trackSid}`
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

/** The screens being shared in the room, Discord-style, plus the share controls. */
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
  const [focus, setFocus] = useState<string | null>(null)
  const [withAudio, setWithAudio] = useState(true)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const systemAudio = useRef<MediaStreamTrack | null>(null)
  const systemAudioCleanup = useRef<(() => void) | null>(null)

  const focused = screens.find((t) => trackKey(t) === focus) ?? (screens.length === 1 ? screens[0] : undefined)
  const others = focused ? screens.filter((t) => t !== focused) : screens

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
        {
          audio: false,
          contentHint: 'detail',
          resolution: ScreenSharePresets.h1080fps30.resolution,
          selfBrowserSurface: 'exclude'
        },
        {
          screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
          // Low layers let viewers watch thumbnails cheaply (adaptiveStream).
          screenShareSimulcastLayers: [ScreenSharePresets.h360fps3, ScreenSharePresets.h720fps15]
        }
      )
      if (withAudio) {
        try {
          await publishSystemAudio()
        } catch (err) {
          setError(`A tela está sendo compartilhada, mas sem áudio: ${err instanceof Error ? err.message : err}`)
        }
      }
    } catch (err) {
      // NotAllowedError: the user cancelled the picker.
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
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

  // Keep the tray icon/menu in sync; back to idle when leaving the call.
  useEffect(() => {
    window.api.tray.setState({ room: roomName, sharing: isScreenShareEnabled })
  }, [roomName, isScreenShareEnabled])
  useEffect(() => () => window.api.tray.setState({ room: null, sharing: false }), [])

  // "Parar de compartilhar" in the tray menu.
  useEffect(() => window.api.tray.onStopShare(() => void stop()))

  function fullscreen(el: HTMLElement | null) {
    void el?.requestFullscreen()
  }

  return (
    <div className="stage">
      <div className="stage-area">
        {screens.length === 0 ? (
          <div className="empty">
            <p className="muted">Ninguém está compartilhando a tela.</p>
            {canPublish && <p className="muted small">Use “Compartilhar tela” para começar.</p>}
          </div>
        ) : focused ? (
          <div className="focus-layout">
            <ScreenTile track={focused} big onFullscreen={fullscreen} onClick={() => setFocus(null)} />
            {others.length > 0 && (
              <div className="strip">
                {others.map((t) => (
                  <ScreenTile key={trackKey(t)} track={t} onFullscreen={fullscreen} onClick={() => setFocus(trackKey(t))} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className={`grid grid-${Math.min(screens.length, 4)}`}>
            {screens.map((t) => (
              <ScreenTile key={trackKey(t)} track={t} onFullscreen={fullscreen} onClick={() => setFocus(trackKey(t))} />
            ))}
          </div>
        )}
      </div>

      {error && <p className="error pad">{error}</p>}
      <div className="controls">
        <span className="muted small">
          {participants.length} {participants.length === 1 ? 'pessoa' : 'pessoas'} na sala
        </span>
        <div className="audio-control" title="Volume do áudio recebido">
          <button
            className="icon"
            title={audioMuted ? 'Ativar áudio' : 'Silenciar áudio'}
            aria-label={audioMuted ? 'Ativar áudio' : 'Silenciar áudio'}
            onClick={() => onAudioMutedChange(!audioMuted)}
          >
            {audioMuted || audioVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={audioMuted ? 0 : audioVolume}
            aria-label="Volume do áudio recebido"
            onChange={(event) => {
              const volume = Number(event.target.value)
              onAudioVolumeChange(volume)
              if (volume > 0 && audioMuted) onAudioMutedChange(false)
            }}
          />
        </div>
        <div className="spacer" />
        {canPublish && (
          <>
            <label className="toggle" title="Compartilhar o áudio do computador junto com a tela">
              <input
                type="checkbox"
                checked={withAudio}
                disabled={isScreenShareEnabled}
                onChange={(e) => setWithAudio(e.target.checked)}
              />
              Áudio do sistema
            </label>
            {isScreenShareEnabled ? (
              <button className="danger" disabled={busy} onClick={stop}>
                <MonitorOff size={16} /> Parar de compartilhar
              </button>
            ) : (
              <button className="primary" disabled={busy} onClick={() => (isLinux ? start(null) : setPicking(true))}>
                <MonitorUp size={16} /> {busy ? 'Iniciando…' : 'Compartilhar tela'}
              </button>
            )}
          </>
        )}
        <button className="ghost danger" onClick={() => room.disconnect()}>
          <PhoneOff size={16} /> Desconectar
        </button>
      </div>

      {picking && <SourcePicker onPick={start} onClose={() => setPicking(false)} />}
    </div>
  )
}

function ScreenTile({
  track,
  big,
  onClick,
  onFullscreen
}: {
  track: TrackReference
  big?: boolean
  onClick: () => void
  onFullscreen: (el: HTMLElement | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const name = track.participant.name || track.participant.identity
  return (
    <div ref={ref} className={`tile ${big ? 'big' : ''}`} onClick={onClick} onDoubleClick={() => onFullscreen(ref.current)}>
      <VideoTrack trackRef={track} />
      <span className="tile-name">
        {name}
        {track.participant.isLocal && ' (você)'}
      </span>
      <button
        className="icon tile-fullscreen"
        title="Tela cheia"
        onClick={(e) => {
          e.stopPropagation()
          onFullscreen(ref.current)
        }}
      >
        <Maximize2 size={14} />
      </button>
    </div>
  )
}
