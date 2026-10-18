// Summaries of WebRTC stats for one track, computed between two samples so
// rates (fps, kbps, loss) reflect the last interval.

export type Limitation = 'none' | 'cpu' | 'bandwidth' | 'other'

export interface LayerStats {
  rid: string
  width: number
  height: number
  fps: number
  kbps: number
  limitation: Limitation
}

export interface OutboundStats {
  kind: 'outbound'
  /** Active simulcast layers, highest first. */
  layers: LayerStats[]
  /** Average encode time per frame in the interval, ms. */
  encodeMs: number
  encoder: string
  rttMs: number
  /** Packets the receiver (SFU) reported lost in the interval, %. */
  lossPct: number
}

export interface InboundStats {
  kind: 'inbound'
  width: number
  height: number
  fps: number
  kbps: number
  /** Frames dropped / freezes in the interval. */
  framesDropped: number
  freezes: number
  freezeMs: number
  jitterMs: number
  lossPct: number
  decoder: string
}

export type TrackStats = OutboundStats | InboundStats

interface StatsSource {
  getRTCStatsReport(): Promise<RTCStatsReport | undefined>
}

type Entry = Record<string, number | string | undefined>

function byType(report: RTCStatsReport, type: string): Entry[] {
  const out: Entry[] = []
  report.forEach((s: Entry) => {
    if (s.type === type) out.push(s)
  })
  return out
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

function limitation(v: unknown): Limitation {
  return v === 'cpu' || v === 'bandwidth' ? v : v === 'none' || v === undefined ? 'none' : 'other'
}

/** Returns a function that, on each call, samples the track and diffs with the previous sample. */
export function statsSampler(source: StatsSource): () => Promise<TrackStats | null> {
  let prev = new Map<string, Entry>()
  let prevAt = 0

  return async () => {
    const report = await source.getRTCStatsReport()
    if (!report) return null
    const now = performance.now()
    const seconds = prevAt ? (now - prevAt) / 1000 : 0
    const delta = (s: Entry, key: string) => num(s[key]) - num(prev.get(String(s.id))?.[key])
    const rate = (s: Entry, key: string) => (seconds > 0 ? delta(s, key) / seconds : 0)

    let result: TrackStats | null = null
    const outbound = byType(report, 'outbound-rtp').filter((s) => s.kind === 'video')
    const inbound = byType(report, 'inbound-rtp').filter((s) => s.kind === 'video')

    if (outbound.length > 0) {
      const active = outbound.filter((s) => num(s.frameWidth) > 0)
      const frames = active.reduce((n, s) => n + delta(s, 'framesEncoded'), 0)
      const encodeSec = active.reduce((n, s) => n + delta(s, 'totalEncodeTime'), 0)
      const remote = byType(report, 'remote-inbound-rtp').filter((s) => s.kind === 'video')
      const lost = remote.reduce((n, s) => n + delta(s, 'packetsLost'), 0)
      const sent = active.reduce((n, s) => n + delta(s, 'packetsSent'), 0)
      result = {
        kind: 'outbound',
        layers: active
          .map((s) => ({
            rid: String(s.rid ?? ''),
            width: num(s.frameWidth),
            height: num(s.frameHeight),
            fps: num(s.framesPerSecond),
            kbps: (rate(s, 'bytesSent') * 8) / 1000,
            limitation: limitation(s.qualityLimitationReason)
          }))
          .sort((a, b) => b.width - a.width),
        encodeMs: frames > 0 ? (encodeSec / frames) * 1000 : 0,
        encoder: String(active[0]?.encoderImplementation ?? ''),
        rttMs: remote.length ? Math.max(...remote.map((s) => num(s.roundTripTime))) * 1000 : 0,
        lossPct: sent > 0 ? Math.max(0, (lost / (sent + lost)) * 100) : 0
      }
    } else if (inbound.length > 0) {
      const s = inbound[0]
      const received = delta(s, 'packetsReceived')
      const lost = delta(s, 'packetsLost')
      result = {
        kind: 'inbound',
        width: num(s.frameWidth),
        height: num(s.frameHeight),
        fps: num(s.framesPerSecond),
        kbps: (rate(s, 'bytesReceived') * 8) / 1000,
        framesDropped: Math.max(0, delta(s, 'framesDropped')),
        freezes: Math.max(0, delta(s, 'freezeCount')),
        freezeMs: Math.max(0, delta(s, 'totalFreezesDuration')) * 1000,
        jitterMs: num(s.jitter) * 1000,
        lossPct: received + lost > 0 ? Math.max(0, (lost / (received + lost)) * 100) : 0,
        decoder: String(s.decoderImplementation ?? '')
      }
    }

    const next = new Map<string, Entry>()
    report.forEach((s: Entry) => next.set(String(s.id), s))
    prev = next
    prevAt = now
    return result
  }
}

export const limitationLabel: Record<Limitation, string> = {
  none: 'sem limitação',
  cpu: 'limitado pela CPU',
  bandwidth: 'limitado pela banda',
  other: 'limitado'
}
