import {
  ScreenSharePresets,
  Track,
  VideoPreset,
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

export type ShareResolution = 720 | 1080 | 1440
export type ShareFps = 30 | 60

/** Top layer of the share. The screen is never upscaled: a 1080p monitor
 * shared at 1440p goes out at 1080p. */
export interface ShareQuality {
  height: ShareResolution
  fps: ShareFps
}

export const DEFAULT_QUALITY: ShareQuality = { height: 1080, fps: 30 }

export const SHARE_RESOLUTIONS: { height: ShareResolution; label: string }[] = [
  { height: 720, label: '720p' },
  { height: 1080, label: '1080p' },
  { height: 1440, label: '1440p (2K)' }
]
export const SHARE_FPS: ShareFps[] = [30, 60]

const WIDTH: Record<ShareResolution, number> = { 720: 1280, 1080: 1920, 1440: 2560 }

/**
 * Bitrate ceiling of the top layer, in Mbps. VP8 drops frames to stay under
 * it, so a low ceiling shows up as lost fps, not blur. Measured with the
 * full-motion test pattern: 1080p30 needs ~8 Mbps (5 Mbps gave 22 fps);
 * 1440p60 got ~43 fps at 18 Mbps and ~55 fps at 30 Mbps. Text compresses
 * far better. Viewers whose downlink cannot take it fall to the 720p layer.
 */
const MAX_MBPS: Record<ShareMode, Record<ShareResolution, Record<ShareFps, number>>> = {
  smooth: { 720: { 30: 4, 60: 7 }, 1080: { 30: 8, 60: 15 }, 1440: { 30: 14, 60: 25 } },
  sharp: { 720: { 30: 2.5, 60: 4 }, 1080: { 30: 5, 60: 8 }, 1440: { 30: 8, 60: 12 } }
}

function topPreset(mode: ShareMode, q: ShareQuality): VideoPreset {
  return new VideoPreset(WIDTH[q.height], q.height, MAX_MBPS[mode][q.height][q.fps] * 1_000_000, q.fps)
}

export function qualityLabel(q: ShareQuality): string {
  return `${q.height}p${q.fps}`
}

/** Capture options for screen shares. */
export function screenCapture(mode: ShareMode, quality: ShareQuality): ScreenShareCaptureOptions {
  return {
    audio: false,
    contentHint: mode === 'smooth' ? 'motion' : 'detail',
    resolution: topPreset(mode, quality).resolution,
    selfBrowserSurface: 'exclude'
  }
}

/**
 * Publish options for screen shares: the chosen top layer plus simulcast
 * layers of 360p15 (thumbnails) and, above 720p, 720p30 (viewers whose
 * downlink cannot take the top layer). Every layer keeps a watchable frame
 * rate, because the viewer picks the layer by what they watch (high) vs.
 * thumbnails (low).
 *
 * The top layer's bitrate is only a ceiling: bandwidth estimation lowers it
 * on slow uplinks.
 */
export function screenPublish(mode: ShareMode, quality: ShareQuality): TrackPublishOptions {
  return {
    screenShareEncoding: topPreset(mode, quality).encoding,
    screenShareSimulcastLayers:
      quality.height > 720
        ? [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps30]
        : [ScreenSharePresets.h360fps15]
  }
}

/**
 * Dev only: publishes an animated canvas at the chosen quality as a screen
 * share with the same options as a real share, so encoding/decoding can be
 * measured without the system screen picker. `motion` fills the frame with changing blocks
 * (like video/games); otherwise it is mostly static text (like documents).
 */
export async function publishTestPattern(
  participant: LocalParticipant,
  motion: boolean,
  quality: ShareQuality,
  toneHz?: number
): Promise<() => void> {
  const W = WIDTH[quality.height]
  const H = quality.height
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  let frame = 0
  const draw = () => {
    frame++
    ctx.fillStyle = '#24273a'
    ctx.fillRect(0, 0, W, H)
    if (motion) {
      for (let y = 0; y < H; y += 60) {
        for (let x = 0; x < W; x += 60) {
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
    ctx.fillRect((frame * 12) % W, H - 80, 80, 60)
  }
  draw()
  const timer = setInterval(draw, 1000 / quality.fps)
  const [track] = canvas.captureStream(quality.fps).getVideoTracks()
  track.contentHint = motion ? 'motion' : 'detail'
  await participant.publishTrack(track, {
    source: Track.Source.ScreenShare,
    name: 'test-pattern',
    ...screenPublish(motion ? 'smooth' : 'sharp', quality)
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
