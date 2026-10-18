import {
  ScreenSharePresets,
  Track,
  type LocalParticipant,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions
} from 'livekit-client'

/**
 * How a share degrades when CPU or bandwidth runs short:
 * - smooth: keeps 30 fps and lowers resolution (video, games, lives);
 * - sharp: keeps resolution and lowers fps (documents, code, text).
 */
export type ShareMode = 'smooth' | 'sharp'

export const SHARE_MODES: Record<ShareMode, { label: string; hint: string }> = {
  smooth: { label: 'Fluidez', hint: 'Vídeo, jogos e lives: mantém 30 fps' },
  sharp: { label: 'Nitidez', hint: 'Texto e código: mantém a resolução' }
}

/** Capture options for screen shares. */
export function screenCapture(mode: ShareMode): ScreenShareCaptureOptions {
  return {
    audio: false,
    contentHint: mode === 'smooth' ? 'motion' : 'detail',
    resolution: ScreenSharePresets.h1080fps30.resolution,
    selfBrowserSurface: 'exclude'
  }
}

/**
 * Publish options for screen shares: 1080p30 plus 720p30 and 360p15 simulcast
 * layers. Every layer keeps a watchable frame rate, because the viewer picks
 * the layer by what they watch (high) vs. thumbnails (low).
 *
 * The top layer's bitrate is only a ceiling: bandwidth estimation lowers it
 * on slow uplinks. Motion needs more (5 Mbps drops frames on busy 1080p30
 * content); text compresses well.
 */
export function screenPublish(mode: ShareMode): TrackPublishOptions {
  return {
    screenShareEncoding:
      mode === 'smooth'
        ? { ...ScreenSharePresets.h1080fps30.encoding, maxBitrate: 8_000_000 }
        : ScreenSharePresets.h1080fps30.encoding,
    screenShareSimulcastLayers: [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps30]
  }
}

/**
 * Dev only: publishes an animated 1920x1080 canvas as a screen share with the
 * same options as a real share, so encoding/decoding can be measured without
 * the system screen picker. `motion` fills the frame with changing blocks
 * (like video/games); otherwise it is mostly static text (like documents).
 */
export async function publishTestPattern(
  participant: LocalParticipant,
  motion: boolean,
  toneHz?: number
): Promise<() => void> {
  const canvas = document.createElement('canvas')
  canvas.width = 1920
  canvas.height = 1080
  const ctx = canvas.getContext('2d')!
  let frame = 0
  const draw = () => {
    frame++
    ctx.fillStyle = '#24273a'
    ctx.fillRect(0, 0, 1920, 1080)
    if (motion) {
      for (let y = 0; y < 1080; y += 60) {
        for (let x = 0; x < 1920; x += 60) {
          const v = (x * 7 + y * 13 + frame * 17) % 255
          ctx.fillStyle = `rgb(${v}, ${(v * 3 + frame) % 255}, ${(255 - v + frame * 2) % 255})`
          ctx.fillRect(x, y, 60, 60)
        }
      }
    } else {
      ctx.fillStyle = '#cad3f5'
      ctx.font = '22px monospace'
      for (let line = 0; line < 40; line++) ctx.fillText(`linha ${line} — texto estático de um documento compartilhado`, 40, 40 + line * 25)
    }
    ctx.fillStyle = '#ed8796'
    ctx.fillRect((frame * 12) % 1920, 1000, 80, 60)
  }
  draw()
  const timer = setInterval(draw, 1000 / 30)
  const [track] = canvas.captureStream(30).getVideoTracks()
  track.contentHint = motion ? 'motion' : 'detail'
  await participant.publishTrack(track, {
    source: Track.Source.ScreenShare,
    name: 'test-pattern',
    ...screenPublish(motion ? 'smooth' : 'sharp')
  })
  // Optional test tone as the share's audio, to tell apart whose audio plays.
  let audio: { ctx: AudioContext; track: MediaStreamTrack } | null = null
  if (toneHz) {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const dest = ctx.createMediaStreamDestination()
    osc.frequency.value = toneHz
    gain.gain.value = 0.2
    osc.connect(gain).connect(dest)
    osc.start()
    const [tone] = dest.stream.getAudioTracks()
    audio = { ctx, track: tone }
    await participant.publishTrack(tone, { source: Track.Source.ScreenShareAudio, name: 'test-tone', dtx: false, red: false })
  }
  return () => {
    clearInterval(timer)
    void participant.unpublishTrack(track, true)
    if (audio) {
      void participant.unpublishTrack(audio.track, true)
      void audio.ctx.close()
    }
  }
}
