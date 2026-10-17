//! Spike: native screen + system audio capture published to LiveKit, end to
//! end through the p2p-share-screen backend.
//!
//!   spike share         capture a screen/window (system picker on Wayland) and
//!                       the system audio, and publish both
//!   spike watch         subscribe to the screen share in the room: save a video
//!                       frame as PNG and report the received audio level/pitch
//!   spike view          like watch, but inside a WebView (WebKitGTK/WebView2)
//!                       running livekit-client, as the Tauri UI would
//!   spike tone <file>   write a 440 Hz test tone WAV
//!
//! Configuration via env: SPIKE_API (default http://localhost:8080), SPIKE_USER,
//! SPIKE_PASSWORD, SPIKE_ROOM, SPIKE_OUT (watch, default frame.png),
//! SPIKE_SOURCE (share: screen | window | generic; default generic on Linux),
//! SPIKE_AUDIO (share/watch: 0 disables audio).

mod audio;
mod view;

use std::env;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use livekit::options::{TrackPublishOptions, VideoCodec};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::desktop_capturer::{
    CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::native::VideoFrameBufferExt;
use livekit::webrtc::video_frame::{I420Buffer, VideoBuffer, VideoFormatType, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use serde::Deserialize;

const FPS: u64 = 30;

#[derive(Deserialize)]
struct LoginResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct JoinResponse {
    livekit_url: String,
    token: String,
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_req(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("{key} must be set"))
}

fn audio_enabled() -> bool {
    env_or("SPIKE_AUDIO", "1") != "0"
}

/// Logs into the backend and asks it for a LiveKit token for the room.
async fn join_token() -> Result<JoinResponse> {
    let api = env_or("SPIKE_API", "http://localhost:8080");
    let http = reqwest::Client::new();
    let login: LoginResponse = http
        .post(format!("{api}/api/auth/login"))
        .json(&serde_json::json!({"username": env_req("SPIKE_USER")?, "password": env_req("SPIKE_PASSWORD")?}))
        .send()
        .await?
        .error_for_status()
        .context("login failed")?
        .json()
        .await?;
    let join = http
        .post(format!("{api}/api/rooms/{}/join-token", env_req("SPIKE_ROOM")?))
        .bearer_auth(&login.access_token)
        .send()
        .await?
        .error_for_status()
        .context("join-token failed")?
        .json()
        .await?;
    Ok(join)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("share") => share().await,
        Some("watch") => watch().await,
        Some("view") => {
            let join = join_token().await?;
            view::run(&join.livekit_url, &join.token, env_or("SPIKE_OUT", "view.png"))
        }
        Some("tone") => {
            let path = args.get(2).map(String::as_str).unwrap_or("tone.wav");
            audio::write_tone(path, 440.0, 10, 0.25)?;
            println!("wrote 10 s 440 Hz tone to {path}");
            Ok(())
        }
        _ => bail!("usage: spike share|watch|tone (see the doc comment for env vars)"),
    }
}

fn source_type() -> Result<DesktopCaptureSourceType> {
    let default = if cfg!(target_os = "linux") { "generic" } else { "screen" };
    Ok(match env_or("SPIKE_SOURCE", default).as_str() {
        "screen" => DesktopCaptureSourceType::Screen,
        "window" => DesktopCaptureSourceType::Window,
        #[cfg(target_os = "linux")]
        "generic" => DesktopCaptureSourceType::Generic,
        other => bail!("unknown SPIKE_SOURCE {other:?}"),
    })
}

async fn share() -> Result<()> {
    let join = join_token().await?;
    let (room, mut events) = Room::connect(&join.livekit_url, &join.token, RoomOptions::default()).await?;
    println!("connected to room {} as {}", room.name(), room.local_participant().identity());

    if audio_enabled() {
        // System audio, not a microphone: no echo cancellation, noise
        // suppression or gain control.
        let options = AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false };
        let source = NativeAudioSource::new(options, audio::SAMPLE_RATE, audio::CHANNELS, 100);
        audio::spawn_system_audio(source.clone(), tokio::runtime::Handle::current())?;
        let track = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(source));
        room.local_participant()
            .publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions { source: TrackSource::ScreenshareAudio, dtx: false, ..Default::default() },
            )
            .await?;
        println!("system audio track published");
    }

    // The resolution is only a hint; frames of any size can be pushed.
    let source = NativeVideoSource::new(VideoResolution { width: 1920, height: 1080 }, true);
    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: VideoCodec::VP8,
                simulcast: true,
                ..Default::default()
            },
        )
        .await?;
    println!("screen track published; pick a screen or window in the system dialog");

    let source_type = source_type()?;
    // The capturer lives on its own thread and is polled at FPS.
    std::thread::spawn(move || {
        let mut options = DesktopCapturerOptions::new(source_type);
        options.set_include_cursor(true);
        let Some(mut capturer) = DesktopCapturer::new(options) else {
            eprintln!("could not create a desktop capturer on this platform");
            std::process::exit(1);
        };
        // Screen/Window: take the first source. Generic (Wayland): the portal picks.
        let first = capturer.get_source_list().into_iter().next();
        if let Some(s) = &first {
            println!("capturing source: {s}");
        }
        let start = Instant::now();
        let mut frames: u64 = 0;
        capturer.start_capture(first, move |result| match result {
            Ok(frame) => {
                let (w, h) = (frame.width(), frame.height());
                let mut buffer = I420Buffer::new(w as u32, h as u32);
                let (sy, su, sv) = buffer.strides();
                let (y, u, v) = buffer.data_mut();
                // DesktopFrame is BGRA in memory, which libyuv calls ARGB.
                yuv_helper::argb_to_i420(frame.data(), frame.stride(), y, sy, u, su, v, sv, w, h);
                let video_frame = VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: start.elapsed().as_micros() as i64,
                    frame_metadata: None,
                    buffer,
                };
                source.capture_frame(&video_frame);
                frames += 1;
                if frames == 1 || frames % (FPS * 5) == 0 {
                    println!("captured {frames} frames ({w}x{h})");
                }
            }
            Err(CaptureError::Temporary) => {}
            Err(CaptureError::Permanent) => {
                eprintln!("capture failed permanently (dialog cancelled or source gone)");
                std::process::exit(1);
            }
        });
        loop {
            capturer.capture_frame();
            std::thread::sleep(Duration::from_millis(1000 / FPS));
        }
    });

    // Keep the session alive until Ctrl+C or the server ends it.
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            ev = events.recv() => match ev {
                Some(RoomEvent::Disconnected { reason }) => {
                    println!("disconnected by server: {reason:?}");
                    break;
                }
                Some(_) => {}
                None => break,
            },
        }
    }
    room.close().await?;
    Ok(())
}

async fn watch() -> Result<()> {
    let join = join_token().await?;
    let (room, mut events) = Room::connect(&join.livekit_url, &join.token, RoomOptions::default()).await?;
    println!("connected to room {}; waiting for a screen share", room.name());

    let expected = if audio_enabled() { 2 } else { 1 };
    let mut tasks = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(45));
    tokio::pin!(deadline);
    while tasks.len() < expected {
        tokio::select! {
            _ = &mut deadline => bail!("timed out with {} of {expected} screen share tracks", tasks.len()),
            ev = events.recv() => match ev {
                Some(RoomEvent::TrackSubscribed { track, publication, participant }) => {
                    match (track, publication.source()) {
                        (RemoteTrack::Video(t), TrackSource::Screenshare) => {
                            println!("subscribed to {}'s screen", participant.identity());
                            tasks.push(tokio::spawn(save_video_frame(t, env_or("SPIKE_OUT", "frame.png"))));
                        }
                        (RemoteTrack::Audio(t), TrackSource::ScreenshareAudio) => {
                            println!("subscribed to {}'s screen audio", participant.identity());
                            tasks.push(tokio::spawn(measure_audio(t)));
                        }
                        _ => {}
                    }
                }
                Some(_) => {}
                None => bail!("room closed before the screen share arrived"),
            },
        }
    }
    for task in tasks {
        task.await??;
    }
    room.close().await?;
    Ok(())
}

async fn save_video_frame(track: RemoteVideoTrack, out: String) -> Result<()> {
    let mut stream = NativeVideoStream::new(track.rtc_track());
    let start = Instant::now();
    let mut count = 0;
    while let Some(frame) = stream.next().await {
        count += 1;
        // Skip the first frames so the encoder has ramped up quality.
        if start.elapsed() < Duration::from_secs(3) {
            continue;
        }
        let i420 = frame.buffer.to_i420();
        let (w, h) = (i420.width(), i420.height());
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        // libyuv "ABGR" is RGBA in memory.
        i420.to_argb(VideoFormatType::ABGR, &mut rgba, w * 4, w as i32, h as i32);
        image::save_buffer(&out, &rgba, w, h, image::ColorType::Rgba8)?;
        println!("video: received {count} frames; saved {w}x{h} frame to {out}");
        return Ok(());
    }
    bail!("video stream ended early")
}

async fn measure_audio(track: RemoteAudioTrack) -> Result<()> {
    let mut stream = NativeAudioStream::new(track.rtc_track(), audio::SAMPLE_RATE as i32, audio::CHANNELS as i32);
    let start = Instant::now();
    let mut left = Vec::new();
    while let Some(frame) = stream.next().await {
        if start.elapsed() < Duration::from_secs(2) {
            continue;
        }
        left.extend(frame.data.iter().step_by(frame.num_channels as usize));
        if left.len() >= (audio::SAMPLE_RATE * 3) as usize {
            let (rms, share) = audio::analyze(&left, 440.0);
            println!("audio: 3.0 s received, RMS {rms:.0}, {:.0}% of the power at 440 Hz", share * 100.0);
            return Ok(());
        }
    }
    bail!("audio stream ended early")
}
