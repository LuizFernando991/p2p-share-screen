//! System audio ("what the computer is playing") for screen shares.

use anyhow::Result;
use livekit::webrtc::audio_source::native::NativeAudioSource;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// WebRTC consumes audio in 10 ms frames.
pub const SAMPLES_PER_FRAME: u32 = SAMPLE_RATE / 100;

/// Captures the default output's monitor through the PulseAudio API (served
/// by pipewire-pulse on modern desktops) and pushes 10 ms frames into source
/// from a dedicated thread. Returns once capture has started.
#[cfg(target_os = "linux")]
pub fn spawn_system_audio(source: NativeAudioSource, rt: tokio::runtime::Handle) -> Result<()> {
    use libpulse_binding::def::BufferAttr;
    use libpulse_binding::sample::{Format, Spec};
    use libpulse_binding::stream::Direction;
    use libpulse_simple_binding::Simple;
    use livekit::webrtc::audio_frame::AudioFrame;

    let frame_bytes = (SAMPLES_PER_FRAME * CHANNELS * 2) as usize;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let spec = Spec { format: Format::S16NE, channels: CHANNELS as u8, rate: SAMPLE_RATE };
        // Small fragments keep capture latency near one frame.
        let attr = BufferAttr {
            maxlength: u32::MAX,
            tlength: u32::MAX,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: frame_bytes as u32,
        };
        let simple = match Simple::new(
            None,
            "p2p-share-screen",
            Direction::Record,
            Some("@DEFAULT_MONITOR@"),
            "screen share audio",
            &spec,
            None,
            Some(&attr),
        ) {
            Ok(s) => {
                let _ = ready_tx.send(Ok(()));
                s
            }
            Err(e) => {
                let _ = ready_tx.send(Err(anyhow::anyhow!("open default monitor: {e}")));
                return;
            }
        };
        let mut bytes = vec![0u8; frame_bytes];
        loop {
            if let Err(e) = simple.read(&mut bytes) {
                eprintln!("system audio capture stopped: {e}");
                return;
            }
            let samples: Vec<i16> = bytes.chunks_exact(2).map(|b| i16::from_ne_bytes([b[0], b[1]])).collect();
            let frame = AudioFrame {
                data: samples.into(),
                sample_rate: SAMPLE_RATE,
                num_channels: CHANNELS,
                samples_per_channel: SAMPLES_PER_FRAME,
            };
            if let Err(e) = rt.block_on(source.capture_frame(&frame)) {
                eprintln!("push audio frame: {e}");
            }
        }
    });
    ready_rx.recv()?
}

#[cfg(not(target_os = "linux"))]
pub fn spawn_system_audio(_source: NativeAudioSource, _rt: tokio::runtime::Handle) -> Result<()> {
    // Windows: WASAPI loopback on the default render device (not written yet).
    anyhow::bail!("system audio capture is not implemented on this platform yet")
}

/// Writes a 16-bit stereo WAV with a sine tone, used to test audio end to end.
pub fn write_tone(path: &str, freq: f32, seconds: u32, amplitude: f32) -> Result<()> {
    let frames = SAMPLE_RATE * seconds;
    let data_len = frames * CHANNELS * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&(CHANNELS as u16).to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * CHANNELS * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&((CHANNELS * 2) as u16).to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..frames {
        let t = i as f32 / SAMPLE_RATE as f32;
        let s = ((t * freq * std::f32::consts::TAU).sin() * amplitude * i16::MAX as f32) as i16;
        for _ in 0..CHANNELS {
            out.extend_from_slice(&s.to_le_bytes());
        }
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Level (RMS) of mono samples and the fraction of their power at freq
/// (Goertzel), so a test tone can be told apart from other audio playing.
pub fn analyze(samples: &[i16], freq: f64) -> (f64, f64) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let n = samples.len() as f64;
    let mean_square = samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / n;
    let coeff = 2.0 * (std::f64::consts::TAU * freq / SAMPLE_RATE as f64).cos();
    let (mut s1, mut s2) = (0.0, 0.0);
    for &x in samples {
        let s0 = x as f64 + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    let magnitude_sq = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    // A sine of amplitude A gives |X|^2 = (A*N/2)^2 and mean square A^2/2.
    let tone_power = 2.0 * magnitude_sq / (n * n);
    (mean_square.sqrt(), if mean_square > 0.0 { tone_power / mean_square } else { 0.0 })
}
