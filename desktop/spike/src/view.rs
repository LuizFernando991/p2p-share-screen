//! Watching a screen share inside the same WebView engine Tauri uses
//! (WebKitGTK on Linux, WebView2 on Windows) with livekit-client in JS.

use anyhow::Result;
use base64::Engine;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const PAGE: &str = include_str!("view.html");
const TIMEOUT_SECS: u64 = 45;

enum UserEvent {
    Exit(i32),
}

/// Opens a window that connects to the room and reports back over IPC. Exits
/// the process when the page is done (0), fails (1) or times out (2).
pub fn run(url: &str, token: &str, out: String) -> Result<()> {
    let html = PAGE
        .replace("__URL__", &serde_json::to_string(url)?)
        .replace("__TOKEN__", &serde_json::to_string(token)?);

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("spike view")
        .with_inner_size(tao::dpi::LogicalSize::new(960.0, 600.0))
        .build(&event_loop)?;

    let proxy = event_loop.create_proxy();
    let handler = move |req: wry::http::Request<String>| {
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
                    Ok(png) if std::fs::write(&out, &png).is_ok() => println!("webview: saved frame to {out}"),
                    _ => eprintln!("webview: could not save the frame"),
                }
            }
            "done" => {
                let _ = proxy.send_event(UserEvent::Exit(0));
            }
            _ => {}
        }
    };

    let builder = WebViewBuilder::new().with_ipc_handler(handler);
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().expect("tao window has a vbox"))?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window)?;

    // WebKitGTK ships with WebRTC disabled; it must be on before the page loads.
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{SettingsExt, WebViewExt};
        use wry::WebViewExtUnix;
        if let Some(settings) = WebViewExt::settings(&webview.webview()) {
            settings.set_enable_webrtc(true);
            settings.set_enable_media_stream(true);
            settings.set_media_playback_requires_user_gesture(false);
        }
    }
    webview.load_html(&html)?;

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
            Event::UserEvent(UserEvent::Exit(code)) => std::process::exit(code),
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => std::process::exit(0),
            _ => {}
        }
    })
}
