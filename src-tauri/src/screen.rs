//! "What am I looking at?": a screenshot of the screen under the mouse, for the vision model.

#[cfg(desktop)]
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;

type CmdResult<T> = Result<T, String>;

#[cfg(desktop)]
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Longest side sent to the model: enough to read text, and image tokens grow with the pixels.
#[cfg(desktop)]
const MAX_SIDE: u32 = 1600;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(mobile, allow(dead_code))]
pub struct Screenshot {
    /// JPEG, base64.
    base64: String,
    width: u32,
    height: u32,
}

/// Phones and tablets don't let an app capture the screen of other apps.
#[cfg(mobile)]
#[tauri::command]
pub async fn capture_screen(app: AppHandle) -> CmdResult<Screenshot> {
    let _ = app;
    Err("this device doesn't let apps capture the screen of other apps".into())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn capture_screen(app: AppHandle) -> CmdResult<Screenshot> {
    // If Iris's own interface is in front, the user means what is behind it.
    let main = app.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if let Some(main) = &main {
        main.hide().map_err(err)?;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let cursor = app.cursor_position().ok();
    let shot = tauri::async_runtime::spawn_blocking(move || grab(cursor.map(|p| (p.x as i32, p.y as i32)))).await.map_err(err);
    if let Some(main) = &main {
        let _ = main.show();
        let _ = main.set_focus();
    }
    shot?
}

/// `cursor` is in the OS's physical pixels; on macOS xcap locates screens in points.
#[cfg(desktop)]
fn grab(cursor: Option<(i32, i32)>) -> CmdResult<Screenshot> {
    use base64::Engine;
    use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage};

    let monitor = match cursor.and_then(|(x, y)| monitor_at(x, y)) {
        Some(m) => m,
        None => {
            let all = xcap::Monitor::all().map_err(err)?;
            let primary = all.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0);
            all.into_iter().nth(primary).ok_or("no screen found")?
        }
    };
    let mut image = DynamicImage::ImageRgba8(monitor.capture_image().map_err(err)?);
    if image.width().max(image.height()) > MAX_SIDE {
        image = image.resize(MAX_SIDE, MAX_SIDE, FilterType::Triangle);
    }
    let rgb = image.to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 80).encode_image(&rgb).map_err(err)?;
    Ok(Screenshot {
        base64: base64::engine::general_purpose::STANDARD.encode(jpeg),
        width: rgb.width(),
        height: rgb.height(),
    })
}

/// The screen containing a point given in physical pixels (Tauri's cursor position).
#[cfg(desktop)]
fn monitor_at(x: i32, y: i32) -> Option<xcap::Monitor> {
    if cfg!(target_os = "macos") {
        // Screens are laid out in points there: find the one whose pixel box holds the point.
        return xcap::Monitor::all().ok()?.into_iter().find(|m| {
            let scale = m.scale_factor().unwrap_or(1.0) as f64;
            let (mx, my) = (m.x().unwrap_or(0) as f64 * scale, m.y().unwrap_or(0) as f64 * scale);
            let (mw, mh) = (m.width().unwrap_or(0) as f64 * scale, m.height().unwrap_or(0) as f64 * scale);
            (x as f64) >= mx && (x as f64) < mx + mw && (y as f64) >= my && (y as f64) < my + mh
        });
    }
    xcap::Monitor::from_point(x, y).ok()
}
