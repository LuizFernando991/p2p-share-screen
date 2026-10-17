//! Watching a screen share inside the app window, Discord-style. WebKitGTK
//! has no WebRTC, so the video is received natively (LiveKit Rust SDK) and
//! served decoded (I420) to the page over a custom protocol; the page pulls
//! the next frame when it is ready (natural backpressure: slow pages drop
//! frames instead of queueing them) and draws it with WebGL.

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use base64::Engine;
use futures_util::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::video_frame::VideoBuffer;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::http::{Request, Response};
use wry::{RequestAsyncResponder, WebViewBuilder};

const PAGE: &str = include_str!("view.html");
const TIMEOUT_SECS: u64 = 60;

#[cfg(target_os = "windows")]
const START_URL: &str = "http://frames.localhost/";
#[cfg(not(target_os = "windows"))]
const START_URL: &str = "frames://localhost/";

enum UserEvent {
    NewFrame,
    Exit(i32),
}

/// Latest decoded frame: 12-byte header (width, height, seq as u32 LE)
/// followed by tightly packed Y, U and V planes.
#[derive(Default)]
struct Latest {
    seq: u32,
    data: Arc<Vec<u8>>,
}

thread_local! {
    // The responder is not Send, so a request waiting for a newer frame is
    // parked here on the main thread until the next NewFrame event.
    static PENDING: RefCell<Option<(u32, RequestAsyncResponder)>> = const { RefCell::new(None) };
}

fn frame_response(data: &[u8]) -> Response<Vec<u8>> {
    Response::builder()
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "no-store")
        .body(data.to_vec())
        .expect("valid response")
}

/// Connects to the room, receives the first screen share and keeps `latest`
/// updated, waking the event loop for each frame.
async fn receive(url: String, token: String, latest: Arc<Mutex<Latest>>, proxy: EventLoopProxy<UserEvent>) -> Result<()> {
    let (room, mut events) = Room::connect(&url, &token, RoomOptions::default()).await?;
    println!("connected to room {}", room.name());
    while let Some(ev) = events.recv().await {
        let RoomEvent::TrackSubscribed { track: RemoteTrack::Video(track), publication, .. } = ev else {
            continue;
        };
        if publication.source() != TrackSource::Screenshare {
            continue;
        }
        let mut stream = NativeVideoStream::new(track.rtc_track());
        let mut seq: u32 = 0;
        while let Some(frame) = stream.next().await {
            let i420 = frame.buffer.to_i420();
            let (w, h) = (i420.width(), i420.height());
            let (cw, ch) = (i420.chroma_width(), i420.chroma_height());
            let (sy, su, sv) = i420.strides();
            let (y, u, v) = i420.data();
            seq += 1;
            let mut out = Vec::with_capacity(12 + (w * h + 2 * cw * ch) as usize);
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&h.to_le_bytes());
            out.extend_from_slice(&seq.to_le_bytes());
            for (plane, stride, pw, ph) in [(y, sy, w, h), (u, su, cw, ch), (v, sv, cw, ch)] {
                for row in 0..ph {
                    let start = (row * stride) as usize;
                    out.extend_from_slice(&plane[start..start + pw as usize]);
                }
            }
            *latest.lock().unwrap() = Latest { seq, data: Arc::new(out) };
            let _ = proxy.send_event(UserEvent::NewFrame);
        }
    }
    Ok(())
}

/// Opens the app-like window and reports back over IPC. Exits the process
/// when the page is done (0), fails (1) or times out (2).
pub fn run(url: &str, token: &str, out: String) -> Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("spike view")
        .with_inner_size(tao::dpi::LogicalSize::new(1280.0, 760.0))
        .build(&event_loop)?;

    let latest = Arc::new(Mutex::new(Latest::default()));
    tokio::spawn({
        let (url, token, latest, proxy) = (url.to_string(), token.to_string(), latest.clone(), event_loop.create_proxy());
        async move {
            if let Err(e) = receive(url, token, latest, proxy.clone()).await {
                eprintln!("receive failed: {e:#}");
                let _ = proxy.send_event(UserEvent::Exit(1));
            }
        }
    });

    let protocol_latest = latest.clone();
    let protocol = move |_id: wry::WebViewId, req: Request<Vec<u8>>, responder: RequestAsyncResponder| {
        let path = req.uri().path();
        if path != "/next" {
            responder.respond(
                Response::builder().header("Content-Type", "text/html").body(PAGE.as_bytes().to_vec()).unwrap(),
            );
            return;
        }
        let after: u32 = req
            .uri()
            .query()
            .and_then(|q| q.strip_prefix("after="))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let current = protocol_latest.lock().unwrap();
        if current.seq > after {
            responder.respond(frame_response(&current.data));
        } else {
            PENDING.with(|p| *p.borrow_mut() = Some((after, responder)));
        }
    };

    let proxy = event_loop.create_proxy();
    let ipc = move |req: Request<String>| {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(req.body()) else { return };
        let data = msg["data"].as_str().unwrap_or_default();
        match msg["kind"].as_str().unwrap_or_default() {
            "log" => println!("webview: {data}"),
            "error" => {
                eprintln!("webview error: {data}");
                let _ = proxy.send_event(UserEvent::Exit(1));
            }
            "frame" => {
                let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or_default();
                match base64::engine::general_purpose::STANDARD.decode(b64) {
                    Ok(png) if std::fs::write(&out, &png).is_ok() => println!("webview: saved canvas to {out}"),
                    _ => eprintln!("webview: could not save the canvas"),
                }
            }
            "done" => {
                let _ = proxy.send_event(UserEvent::Exit(0));
            }
            _ => {}
        }
    };

    let builder = WebViewBuilder::new()
        .with_asynchronous_custom_protocol("frames".into(), protocol)
        .with_ipc_handler(ipc)
        .with_url(START_URL);
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().expect("tao window has a vbox"))?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window)?;

    let timeout = event_loop.create_proxy();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(TIMEOUT_SECS));
        eprintln!("webview: timed out after {TIMEOUT_SECS}s");
        let _ = timeout.send_event(UserEvent::Exit(2));
    });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _keep_alive = &webview;
        match event {
            Event::UserEvent(UserEvent::NewFrame) => {
                let current = latest.lock().unwrap();
                PENDING.with(|p| {
                    let mut pending = p.borrow_mut();
                    if matches!(*pending, Some((after, _)) if current.seq > after) {
                        let (_, responder) = pending.take().unwrap();
                        responder.respond(frame_response(&current.data));
                    }
                });
            }
            Event::UserEvent(UserEvent::Exit(code)) => std::process::exit(code),
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => std::process::exit(0),
            _ => {}
        }
    })
}
