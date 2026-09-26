//! Computer use: Iris moves windows, and clicks / types in other applications.
//!
//! - Windows (the OS windows): listed and managed with the Win32 API — precise, instant, no
//!   screenshot needed (focus, minimize, maximize, restore, close, move to a half / corner /
//!   the centre / the next monitor).
//! - Mouse and keyboard, driven by the vision model step by step (see computerAgent.ts):
//!   `computer_observe` gives a screenshot of the active window's monitor plus the accessible
//!   elements of that window (buttons, fields, links… with exact positions, from Windows UI
//!   Automation), `computer_act` performs one action. Coordinates are physical screen pixels.
//! - Safety: `computer_begin` registers Esc as a global shortcut that aborts the task
//!   (event `computer://abort`); the HUD also stops when the user moves the mouse.

use std::{fmt::Display, time::Duration};

use enigo::{Axis, Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

type CmdResult<T> = Result<T, String>;

fn err(e: impl Display) -> String {
    e.to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// Native handle, to act on the window later.
    id: i64,
    title: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    /// "normal", "minimized" or "maximized".
    state: &'static str,
    focused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiElement {
    name: String,
    kind: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// JPEG, base64, of the monitor showing the active window.
    image: String,
    image_width: u32,
    image_height: u32,
    /// Screen position of the image's top-left corner, and screen pixels per image pixel.
    origin_x: i32,
    origin_y: i32,
    scale: f64,
    cursor_x: i32,
    cursor_y: i32,
    active_window: Option<WindowInfo>,
    /// Accessible elements of the active window (screen coordinates), in reading order.
    elements: Vec<UiElement>,
}

/// Longest side of the screenshot sent to the model (image tokens grow with the pixels).
const MAX_SIDE: u32 = 1600;
/// Elements listed for the model (the most useful are the interactive ones on screen).
const MAX_ELEMENTS: usize = 150;

// ------------------------------------------------------------------ windows

#[tauri::command]
pub async fn computer_windows() -> CmdResult<Vec<WindowInfo>> {
    tauri::async_runtime::spawn_blocking(platform::list_windows).await.map_err(err)?
}

/// `action`: focus, minimize, maximize, restore, close, or move with `position`
/// (left, right, top, bottom, top-left, top-right, bottom-left, bottom-right, center, next-monitor).
#[tauri::command]
pub async fn computer_window(id: i64, action: String, position: Option<String>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || platform::window_action(id, &action, position.as_deref())).await.map_err(err)?
}

// ------------------------------------------------------------------ observe / act

#[tauri::command]
pub async fn computer_observe() -> CmdResult<Observation> {
    let active = tauri::async_runtime::spawn_blocking(platform::active_window).await.map_err(err)?;
    let cursor = Enigo::new(&Settings::default()).map_err(err)?.location().map_err(err)?;
    // The monitor showing the active window (else the one under the mouse).
    let point = active.as_ref().map(|w| (w.x + w.width / 2, w.y + w.height / 2)).unwrap_or(cursor);
    let shot = tauri::async_runtime::spawn_blocking(move || grab(point)).await.map_err(err)??;

    // The accessibility tree can be slow on huge pages: never wait more than a few seconds.
    let elements = match &active {
        Some(w) => {
            let id = w.id;
            let task = tauri::async_runtime::spawn_blocking(move || platform::elements(id));
            match tokio::time::timeout(Duration::from_secs(4), task).await {
                Ok(Ok(Ok(list))) => list,
                _ => Vec::new(),
            }
        }
        None => Vec::new(),
    };
    Ok(Observation {
        image: shot.0,
        image_width: shot.1,
        image_height: shot.2,
        origin_x: shot.3,
        origin_y: shot.4,
        scale: shot.5,
        cursor_x: cursor.0,
        cursor_y: cursor.1,
        active_window: active,
        elements,
    })
}

/// (base64 JPEG, width, height, origin x, origin y, scale)
fn grab(point: (i32, i32)) -> CmdResult<(String, u32, u32, i32, i32, f64)> {
    use base64::Engine;
    use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage};

    let monitor = match xcap::Monitor::from_point(point.0, point.1) {
        Ok(m) => m,
        Err(_) => xcap::Monitor::all().map_err(err)?.into_iter().next().ok_or("no screen found")?,
    };
    let (ox, oy) = (monitor.x().map_err(err)?, monitor.y().map_err(err)?);
    let mut image = DynamicImage::ImageRgba8(monitor.capture_image().map_err(err)?);
    let full_width = image.width();
    if image.width().max(image.height()) > MAX_SIDE {
        image = image.resize(MAX_SIDE, MAX_SIDE, FilterType::Triangle);
    }
    let rgb = image.to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 80).encode_image(&rgb).map_err(err)?;
    let scale = full_width as f64 / rgb.width() as f64;
    Ok((base64::engine::general_purpose::STANDARD.encode(jpeg), rgb.width(), rgb.height(), ox, oy, scale))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Move { x: i32, y: i32 },
    Click { x: i32, y: i32, button: Option<String>, double: Option<bool> },
    Drag { x: i32, y: i32, to_x: i32, to_y: i32 },
    Scroll { x: i32, y: i32, amount: i32 },
    Type { text: String },
    Key { keys: String },
}

/// One mouse / keyboard action (screen pixels). Returns where the cursor now is.
#[tauri::command]
pub async fn computer_act(action: Action) -> CmdResult<(i32, i32)> {
    tauri::async_runtime::spawn_blocking(move || act(action)).await.map_err(err)?
}

fn act(action: Action) -> CmdResult<(i32, i32)> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(err)?;
    let pause = || std::thread::sleep(Duration::from_millis(60));
    match action {
        Action::Move { x, y } => platform::move_cursor(&mut enigo, x, y)?,
        Action::Click { x, y, button, double } => {
            platform::move_cursor(&mut enigo, x, y)?;
            pause();
            let button = match button.as_deref() {
                Some("right") => Button::Right,
                Some("middle") => Button::Middle,
                _ => Button::Left,
            };
            enigo.button(button, Direction::Click).map_err(err)?;
            if double.unwrap_or(false) {
                pause();
                enigo.button(button, Direction::Click).map_err(err)?;
            }
        }
        Action::Drag { x, y, to_x, to_y } => {
            platform::move_cursor(&mut enigo, x, y)?;
            pause();
            enigo.button(Button::Left, Direction::Press).map_err(err)?;
            // In steps: many apps only start a drag after seeing intermediate moves.
            for i in 1..=12 {
                let t = i as f64 / 12.0;
                platform::move_cursor(&mut enigo, x + ((to_x - x) as f64 * t) as i32, y + ((to_y - y) as f64 * t) as i32)?;
                std::thread::sleep(Duration::from_millis(25));
            }
            enigo.button(Button::Left, Direction::Release).map_err(err)?;
        }
        Action::Scroll { x, y, amount } => {
            platform::move_cursor(&mut enigo, x, y)?;
            pause();
            // Positive = down (like the wheel), in notches.
            enigo.scroll(amount.clamp(-20, 20), Axis::Vertical).map_err(err)?;
        }
        Action::Type { text } => enigo.text(&text).map_err(err)?,
        Action::Key { keys } => press_combo(&mut enigo, &keys)?,
    }
    enigo.location().map_err(err)
}

/// "ctrl+shift+s", "alt+tab", "enter", "win+d", "f5"…
fn press_combo(enigo: &mut Enigo, combo: &str) -> CmdResult<()> {
    let keys: Vec<Key> = combo
        .split('+')
        .map(|k| k.trim().to_lowercase())
        .filter(|k| !k.is_empty())
        .map(|k| parse_key(&k).ok_or_else(|| format!("unknown key \"{k}\"")))
        .collect::<CmdResult<_>>()?;
    let (last, modifiers) = keys.split_last().ok_or("no key")?;
    for m in modifiers {
        enigo.key(*m, Direction::Press).map_err(err)?;
    }
    let result = enigo.key(*last, Direction::Click).map_err(err);
    for m in modifiers.iter().rev() {
        let _ = enigo.key(*m, Direction::Release);
    }
    result
}

fn parse_key(name: &str) -> Option<Key> {
    Some(match name {
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" => Key::Alt,
        "win" | "windows" | "meta" | "super" | "cmd" | "command" => Key::Meta,
        "enter" | "return" => Key::Return,
        "esc" | "escape" => Key::Escape,
        "tab" => Key::Tab,
        "backspace" => Key::Backspace,
        "delete" | "del" | "suppr" => Key::Delete,
        "space" => Key::Space,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        f if f.len() >= 2 && f.starts_with('f') && f[1..].parse::<u8>().is_ok() => match &f[1..] {
            "1" => Key::F1, "2" => Key::F2, "3" => Key::F3, "4" => Key::F4, "5" => Key::F5, "6" => Key::F6,
            "7" => Key::F7, "8" => Key::F8, "9" => Key::F9, "10" => Key::F10, "11" => Key::F11, "12" => Key::F12,
            _ => return None,
        },
        c if c.chars().count() == 1 => Key::Unicode(c.chars().next()?),
        _ => return None,
    })
}

// ------------------------------------------------------------------ task lifetime

/// Start of a computer-use task: Iris's own windows get out of the way (they would hide what
/// she has to see and click), and Esc anywhere aborts the task.
#[tauri::command]
pub fn computer_begin(app: AppHandle) -> CmdResult<()> {
    for label in ["main", "mini"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().register(crate::windows::escape_shortcut());
    }
    Ok(())
}

/// End of the task: Esc is released and the mini window comes back.
#[tauri::command]
pub fn computer_end(app: AppHandle) -> CmdResult<()> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister(crate::windows::escape_shortcut());
    }
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.show();
    }
    Ok(())
}

// ------------------------------------------------------------------ platform

#[cfg(windows)]
mod platform {
    use super::*;
    use uiautomation::{
        types::{ControlType, Handle, TreeScope, UIProperty},
        variants::Variant,
        UIAutomation,
    };
    use windows::core::BOOL;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, RECT, WPARAM},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
            Gdi::{EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        UI::WindowsAndMessaging::*,
    };

    fn hwnd(id: i64) -> HWND {
        HWND(id as isize as *mut core::ffi::c_void)
    }

    fn title(h: HWND) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn info(h: HWND, foreground: HWND) -> Option<WindowInfo> {
        let mut r = RECT::default();
        unsafe { GetWindowRect(h, &mut r) }.ok()?;
        let state = if unsafe { IsIconic(h) }.as_bool() {
            "minimized"
        } else if unsafe { IsZoomed(h) }.as_bool() {
            "maximized"
        } else {
            "normal"
        };
        Some(WindowInfo {
            id: h.0 as isize as i64,
            title: title(h),
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
            state,
            focused: h == foreground,
        })
    }

    /// A real application window: visible, titled, not a tool window, not "cloaked" (UWP apps
    /// suspended in the background), not Iris's own.
    fn is_app_window(h: HWND) -> bool {
        unsafe {
            if !IsWindowVisible(h).as_bool() || GetWindowTextLengthW(h) == 0 {
                return false;
            }
            if (GetWindowLongW(h, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
                return false;
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0 {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == std::process::id() {
                return false;
            }
        }
        title(h) != "Program Manager"
    }

    unsafe extern "system" fn collect(h: HWND, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<HWND>) };
        list.push(h);
        true.into()
    }

    pub fn list_windows() -> CmdResult<Vec<WindowInfo>> {
        let mut handles: Vec<HWND> = Vec::new();
        unsafe { EnumWindows(Some(collect), LPARAM(&mut handles as *mut _ as isize)) }.map_err(err)?;
        let foreground = unsafe { GetForegroundWindow() };
        // EnumWindows lists them front to back.
        Ok(handles.into_iter().filter(|h| is_app_window(*h)).filter_map(|h| info(h, foreground)).collect())
    }

    pub fn active_window() -> Option<WindowInfo> {
        let h = unsafe { GetForegroundWindow() };
        if h.0.is_null() || !is_app_window(h) {
            return None;
        }
        info(h, h)
    }

    /// Windows only lets the foreground app give focus away: a tap on Alt (what a user
    /// switching windows would do) lifts that restriction.
    fn focus(h: HWND) {
        unsafe {
            if IsIconic(h).as_bool() {
                let _ = ShowWindow(h, SW_RESTORE);
            }
            if !SetForegroundWindow(h).as_bool() || GetForegroundWindow() != h {
                if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
                    let _ = enigo.key(Key::Alt, Direction::Click);
                }
                let _ = SetForegroundWindow(h);
            }
            let _ = BringWindowToTop(h);
        }
    }

    fn work_area(monitor: HMONITOR) -> Option<RECT> {
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        unsafe { GetMonitorInfoW(monitor, &mut mi) }.as_bool().then_some(mi.rcWork)
    }

    unsafe extern "system" fn collect_monitor(m: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<HMONITOR>) };
        list.push(m);
        true.into()
    }

    pub fn window_action(id: i64, action: &str, position: Option<&str>) -> CmdResult<String> {
        let h = hwnd(id);
        if !unsafe { IsWindow(Some(h)) }.as_bool() {
            return Err("this window no longer exists".into());
        }
        let name = title(h);
        match action {
            "focus" => focus(h),
            "minimize" => unsafe {
                let _ = ShowWindow(h, SW_MINIMIZE);
            },
            "maximize" => {
                unsafe {
                    let _ = ShowWindow(h, SW_MAXIMIZE);
                }
                focus(h);
            }
            "restore" => {
                unsafe {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                focus(h);
            }
            // Politely: the application may ask to save first.
            "close" => unsafe { PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(err)?,
            "move" => {
                let position = position.unwrap_or("center");
                unsafe {
                    if IsIconic(h).as_bool() || IsZoomed(h).as_bool() {
                        let _ = ShowWindow(h, SW_RESTORE);
                    }
                }
                let current = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
                let mut r = RECT::default();
                unsafe { GetWindowRect(h, &mut r) }.map_err(err)?;
                let (w, hgt) = (r.right - r.left, r.bottom - r.top);
                let area = work_area(current).ok_or("no screen found")?;
                let (ax, ay, aw, ah) = (area.left, area.top, area.right - area.left, area.bottom - area.top);
                let (x, y, cx, cy) = match position {
                    "left" => (ax, ay, aw / 2, ah),
                    "right" => (ax + aw / 2, ay, aw / 2, ah),
                    "top" => (ax, ay, aw, ah / 2),
                    "bottom" => (ax, ay + ah / 2, aw, ah / 2),
                    "top-left" => (ax, ay, aw / 2, ah / 2),
                    "top-right" => (ax + aw / 2, ay, aw / 2, ah / 2),
                    "bottom-left" => (ax, ay + ah / 2, aw / 2, ah / 2),
                    "bottom-right" => (ax + aw / 2, ay + ah / 2, aw / 2, ah / 2),
                    "next-monitor" => {
                        let mut monitors: Vec<HMONITOR> = Vec::new();
                        unsafe { EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut monitors as *mut _ as isize)) }
                            .ok()
                            .map_err(err)?;
                        let index = monitors.iter().position(|m| *m == current).unwrap_or(0);
                        let next = monitors.get((index + 1) % monitors.len().max(1)).copied().ok_or("no other screen")?;
                        let to = work_area(next).ok_or("no screen found")?;
                        // Same place relative to the new screen, same size (within it).
                        let nx = to.left + (r.left - ax) * (to.right - to.left) / aw.max(1);
                        let ny = to.top + (r.top - ay) * (to.bottom - to.top) / ah.max(1);
                        (nx, ny, w.min(to.right - to.left), hgt.min(to.bottom - to.top))
                    }
                    _ => (ax + (aw - w.min(aw)) / 2, ay + (ah - hgt.min(ah)) / 2, w.min(aw), hgt.min(ah)),
                };
                unsafe { SetWindowPos(h, None, x, y, cx, cy, SWP_NOZORDER | SWP_NOACTIVATE) }.map_err(err)?;
                focus(h);
            }
            other => return Err(format!("unknown window action \"{other}\"")),
        }
        Ok(format!("{action}: \"{name}\""))
    }

    /// Cursor to physical screen coordinates of the whole virtual desktop (every monitor).
    pub fn move_cursor(_: &mut Enigo, x: i32, y: i32) -> CmdResult<()> {
        unsafe { SetCursorPos(x, y) }.map_err(err)
    }

    /// Interactive elements of a window, in one cross-process call (cache request).
    pub fn elements(id: i64) -> CmdResult<Vec<UiElement>> {
        let automation = UIAutomation::new().map_err(err)?;
        let root = automation.element_from_handle(Handle::from(id as isize)).map_err(err)?;
        const KINDS: &[(ControlType, &str)] = &[
            (ControlType::Button, "button"),
            (ControlType::SplitButton, "button"),
            (ControlType::Edit, "field"),
            (ControlType::ComboBox, "dropdown"),
            (ControlType::Hyperlink, "link"),
            (ControlType::MenuItem, "menu item"),
            (ControlType::ListItem, "list item"),
            (ControlType::TreeItem, "tree item"),
            (ControlType::TabItem, "tab"),
            (ControlType::CheckBox, "checkbox"),
            (ControlType::RadioButton, "radio"),
            (ControlType::DataItem, "item"),
            (ControlType::Slider, "slider"),
        ];
        let mut kinds = automation
            .create_property_condition(UIProperty::ControlType, Variant::from(KINDS[0].0 as i32), None)
            .map_err(err)?;
        for (kind, _) in &KINDS[1..] {
            let c = automation.create_property_condition(UIProperty::ControlType, Variant::from(*kind as i32), None).map_err(err)?;
            kinds = automation.create_or_condition(kinds, c).map_err(err)?;
        }
        let visible = automation.create_property_condition(UIProperty::IsOffscreen, Variant::from(false), None).map_err(err)?;
        let condition = automation.create_and_condition(kinds, visible).map_err(err)?;
        let cache = automation.create_cache_request().map_err(err)?;
        for p in [UIProperty::Name, UIProperty::ControlType, UIProperty::BoundingRectangle] {
            cache.add_property(p).map_err(err)?;
        }
        let found = root.find_all_build_cache(TreeScope::Descendants, &condition, &cache).map_err(err)?;

        let mut list: Vec<UiElement> = found
            .iter()
            .filter_map(|e| {
                let r = e.get_cached_bounding_rectangle().ok()?;
                if r.get_width() < 4 || r.get_height() < 4 {
                    return None;
                }
                let kind = e.get_cached_control_type().ok()?;
                let label = KINDS.iter().find(|(k, _)| *k == kind).map(|(_, l)| *l).unwrap_or("element");
                let name: String = e.get_cached_name().unwrap_or_default().trim().chars().take(60).collect();
                // Unnamed buttons / items are rarely useful to the model (fields are: they can be typed into).
                if name.is_empty() && label != "field" {
                    return None;
                }
                Some(UiElement { name, kind: label.into(), x: r.get_left(), y: r.get_top(), width: r.get_width(), height: r.get_height() })
            })
            .collect();
        // Reading order: top to bottom, then left to right (rows of ~12 px).
        list.sort_by_key(|e| (e.y / 12, e.x));
        list.truncate(MAX_ELEMENTS);
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_combos_parse() {
        assert!(matches!(parse_key("ctrl"), Some(Key::Control)));
        assert!(matches!(parse_key("f5"), Some(Key::F5)));
        assert!(matches!(parse_key("a"), Some(Key::Unicode('a'))));
        assert!(parse_key("f99").is_none());
        assert!(parse_key("nope").is_none());
    }

    /// End to end on a throwaway form (never the user's apps): find the window, move it, find its
    /// field and button through accessibility, click, type (accents included), click the button,
    /// and check what the form received. Moves the mouse: `cargo test -- --ignored drives_a_form`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn drives_a_form() {
        let dir = std::env::temp_dir().join("iris-computer-test");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("received.txt");
        let _ = std::fs::remove_file(&out);
        let script = dir.join("form.ps1");
        std::fs::write(
            &script,
            format!(
                r#"Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = 'Iris computer test'; $f.Width = 520; $f.Height = 220
$t = New-Object Windows.Forms.TextBox; $t.Left = 20; $t.Top = 20; $t.Width = 460; $t.AccessibleName = 'Message'
$b = New-Object Windows.Forms.Button; $b.Left = 20; $b.Top = 70; $b.Width = 140; $b.Text = 'Valider'
$b.Add_Click({{ Set-Content -Path '{}' -Value $t.Text -Encoding UTF8; $f.Close() }})
$f.Controls.Add($t); $f.Controls.Add($b); [void]$f.ShowDialog()"#,
                out.display()
            ),
        )
        .unwrap();
        let mut form = std::process::Command::new("powershell")
            .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .spawn()
            .unwrap();

        let find = || platform::list_windows().unwrap().into_iter().find(|w| w.title == "Iris computer test");
        let mut window = None;
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(250));
            window = find();
            if window.is_some() {
                break;
            }
        }
        let window = window.expect("the test form did not appear");
        println!("form found: {}x{} at ({},{})", window.width, window.height, window.x, window.y);

        println!("{}", platform::window_action(window.id, "move", Some("left")).unwrap());
        std::thread::sleep(Duration::from_millis(400));
        let moved = find().unwrap();
        println!("after move: {}x{} at ({},{})", moved.width, moved.height, moved.x, moved.y);

        let elements = platform::elements(window.id).unwrap();
        for e in &elements {
            println!("  {} {:?} at ({},{}) {}x{}", e.kind, e.name, e.x, e.y, e.width, e.height);
        }
        let center = |e: &UiElement| (e.x + e.width / 2, e.y + e.height / 2);
        let field = elements.iter().find(|e| e.kind == "field").expect("no field found");
        let button = elements.iter().find(|e| e.name == "Valider").expect("no button found");
        let (fx, fy) = center(field);
        act(Action::Click { x: fx, y: fy, button: None, double: None }).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        act(Action::Type { text: "Bonjour d'Iris, ça marche à 100 % !".into() }).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let (bx, by) = center(button);
        let cursor = act(Action::Click { x: bx, y: by, button: None, double: None }).unwrap();
        println!("clicked the button, cursor now at {cursor:?} (button centre {bx},{by})");

        let _ = form.wait();
        let received = std::fs::read_to_string(&out).unwrap_or_default();
        println!("form received: {:?}", received.trim_start_matches('\u{feff}').trim());
        assert_eq!(received.trim_start_matches('\u{feff}').trim(), "Bonjour d'Iris, ça marche à 100 % !");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cursor lands exactly where asked, and reads back the same (the "user took the mouse"
    /// check compares them). Moves the mouse: `cargo test -- --ignored cursor_is_exact`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn cursor_is_exact() {
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        let start = enigo.location().unwrap();
        for (x, y) in [(100, 100), (1900, 500), (3000, 900), (98, 113)] {
            platform::move_cursor(&mut enigo, x, y).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            let read = enigo.location().unwrap();
            println!("asked ({x},{y}) → read {read:?}");
            assert_eq!(read, (x, y));
        }
        platform::move_cursor(&mut enigo, start.0, start.1).unwrap();
    }

    /// Read-only look at the real desktop (windows + accessible elements): `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn desktop_is_readable() {
        let windows = platform::list_windows().unwrap();
        println!("{} windows:", windows.len());
        for w in windows.iter().take(8) {
            println!("  [{}] {:?} {}x{} at ({},{}) {}{}", w.id, w.title, w.width, w.height, w.x, w.y, w.state, if w.focused { " (focused)" } else { "" });
        }
        let target = windows.iter().find(|w| w.state != "minimized").expect("a visible window");
        let t0 = std::time::Instant::now();
        let elements = platform::elements(target.id).unwrap();
        println!("{} elements in {:?} for {:?}:", elements.len(), t0.elapsed(), target.title);
        for e in elements.iter().take(10) {
            println!("  {} {:?} at ({},{}) {}x{}", e.kind, e.name, e.x, e.y, e.width, e.height);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn list_windows() -> CmdResult<Vec<WindowInfo>> {
        Err("window management is only available on Windows for now".into())
    }
    pub fn active_window() -> Option<WindowInfo> {
        None
    }
    pub fn window_action(_: i64, _: &str, _: Option<&str>) -> CmdResult<String> {
        Err("window management is only available on Windows for now".into())
    }
    pub fn move_cursor(enigo: &mut Enigo, x: i32, y: i32) -> CmdResult<()> {
        enigo.move_mouse(x, y, enigo::Coordinate::Abs).map_err(err)
    }
    pub fn elements(_: i64) -> CmdResult<Vec<UiElement>> {
        Ok(Vec::new())
    }
}
