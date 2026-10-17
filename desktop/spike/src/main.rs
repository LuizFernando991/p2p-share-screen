//! Spike: native screen capture published to LiveKit, end to end through the
//! p2p-share-screen backend.
//!
//!   spike share   capture a screen/window (system picker on Wayland) and publish it
//!   spike watch   subscribe to the first screen share in the room and save a PNG
//!
//! Configuration via env: SPIKE_API (default http://localhost:8080), SPIKE_USER,
//! SPIKE_PASSWORD, SPIKE_ROOM, SPIKE_OUT (watch, default frame.png),
//! SPIKE_SOURCE (share: screen | window | generic; default generic on Linux).

use std::env;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use livekit::options::{TrackPublishOptions, VideoCodec};
use livekit::prelude::*;
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
    match env::args().nth(1).as_deref() {
        Some("share") => share().await,
        Some("watch") => watch().await,
        _ => bail!("usage: spike share|watch (see the doc comment for env vars)"),
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
    let out = env_or("SPIKE_OUT", "frame.png");
    let join = join_token().await?;
    let (room, mut events) = Room::connect(&join.livekit_url, &join.token, RoomOptions::default()).await?;
    println!("connected to room {}; waiting for a screen share", room.name());

    while let Some(ev) = events.recv().await {
        let RoomEvent::TrackSubscribed { track: RemoteTrack::Video(track), publication, participant } = ev else {
            continue;
        };
        if publication.source() != TrackSource::Screenshare {
            continue;
        }
        println!("subscribed to {}'s screen", participant.identity());
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
            println!("received {count} frames; saved {w}x{h} frame to {out}");
            room.close().await?;
            return Ok(());
        }
    }
    bail!("room closed before a screen share frame arrived")
}
