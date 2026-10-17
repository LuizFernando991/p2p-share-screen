// libwebrtc's Wayland screen capture (xdg-desktop-portal over D-Bus) calls
// GLib/GIO, but webrtc-sys only uses their headers and leaves linking to the
// app. A Tauri app links them anyway through GTK; this standalone spike must.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        for lib in ["gio-2.0", "gobject-2.0", "glib-2.0"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }
}
