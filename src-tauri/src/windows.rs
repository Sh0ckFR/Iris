//! Background mode: Iris lives in the notification area (tray / menu bar).
//!
//! - Closing the main window only hides it: Iris keeps listening, and a small always-on-top
//!   "mini" window appears near the tray icon (it can be hidden too).
//! - The tray icon (click, or its menu on Linux) and Ctrl+Shift+J (from anywhere) bring the
//!   interface back; on macOS, clicking the Dock icon does too (see `lib.rs`).
//! - `window_control` lets Iris show, hide or move her windows when asked.
//!
//! On phones and tablets there is one full-screen window and no tray: the interface is always
//! the one on screen, and the OS decides when the app runs in the background.

use tauri::{App, AppHandle, WindowEvent};
#[cfg(desktop)]
use tauri::{
    Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

type CmdResult<T> = Result<T, String>;

#[cfg(desktop)]
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// WebView2 switches (Windows), the same for every window (they share one browser environment,
/// which must be created with identical arguments). Setting them replaces Tauri's defaults, so
/// these are repeated: the disabled features, and audio playing without a click (Iris speaks
/// first, at launch). Added: the microphone is granted without a prompt — Iris listens from
/// launch, and a dismissed prompt left her deaf ("Permission dismissed"); only the prompt is
/// skipped, the real microphone is used. Keep in sync with the main window's
/// `additionalBrowserArgs` in tauri.conf.json. macOS and Linux get the same behaviour from
/// `allow_media` below.
#[cfg(desktop)]
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream";

#[cfg(desktop)]
const MAIN: &str = "main";
#[cfg(desktop)]
const MINI: &str = "mini";
/// Size of the mini window (logical pixels): the eye, status and last reply, and the field to
/// write to Iris below them.
#[cfg(desktop)]
const MINI_SIZE: (f64, f64) = (340.0, 150.0);
/// Where the mini window starts: next to the tray icon — the menu bar is at the top on macOS.
#[cfg(desktop)]
const MINI_CORNER: &str = if cfg!(target_os = "macos") { "top-right" } else { "bottom-right" };

/// Shows and focuses the interface; the mini window is then redundant.
/// (Phones and tablets: the interface is always on screen.)
pub fn show_main(app: &AppHandle) {
    #[cfg(desktop)]
    {
        if let Some(main) = app.get_webview_window(MAIN) {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
        if let Some(mini) = app.get_webview_window(MINI) {
            let _ = mini.hide();
        }
    }
    #[cfg(mobile)]
    let _ = app;
}

/// Hides the interface (Iris keeps running) and shows the mini window.
#[cfg(desktop)]
pub fn hide_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.hide();
    }
    if let Some(mini) = app.get_webview_window(MINI) {
        let _ = mini.show();
    }
}

#[cfg(desktop)]
fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN)
        .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

#[cfg(desktop)]
fn toggle_main(app: &AppHandle) {
    if main_visible(app) {
        hide_main(app);
    } else {
        show_main(app);
    }
}

/// Moves a window to a corner / edge / the centre of its screen's work area (taskbar excluded).
/// `position`: combinations of top / bottom and left / right, or "center".
#[cfg(desktop)]
fn place(window: &WebviewWindow, position: &str) -> CmdResult<()> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("no screen found")?;
    let area = monitor.work_area();
    let _ = window.unmaximize();
    let size = window.outer_size().map_err(err)?;
    let margin = (16.0 * monitor.scale_factor()) as i32;
    let (w, h) = (size.width as i32, size.height as i32);
    let (ax, ay) = (area.position.x, area.position.y);
    let (aw, ah) = (area.size.width as i32, area.size.height as i32);
    let x = if position.contains("left") {
        ax + margin
    } else if position.contains("right") {
        ax + aw - w - margin
    } else {
        ax + (aw - w) / 2
    };
    let y = if position.contains("top") {
        ay + margin
    } else if position.contains("bottom") {
        ay + ah - h - margin
    } else {
        ay + (ah - h) / 2
    };
    window.set_position(PhysicalPosition::new(x, y)).map_err(err)
}

/// Iris's windows, driven by the HUD (mini window buttons) and by Iris herself.
/// `target`: "main", "mini", or "auto" (the interface if it is on screen, else the mini window).
/// `action`: "show", "hide", "toggle" or "move" (with `position`).
#[cfg(desktop)]
#[tauri::command]
pub fn window_control(app: AppHandle, target: String, action: String, position: Option<String>) -> CmdResult<String> {
    let target = match target.as_str() {
        "auto" => if main_visible(&app) { MAIN } else { MINI },
        MAIN => MAIN,
        MINI => MINI,
        other => return Err(format!("unknown window \"{other}\"")),
    };
    match (target, action.as_str()) {
        (MAIN, "show") => show_main(&app),
        (MAIN, "hide") => hide_main(&app),
        (MAIN, "toggle") => toggle_main(&app),
        (MINI, "show") => {
            let mini = app.get_webview_window(MINI).ok_or("no mini window")?;
            mini.show().map_err(err)?;
        }
        (MINI, "hide") => {
            let mini = app.get_webview_window(MINI).ok_or("no mini window")?;
            mini.hide().map_err(err)?;
        }
        (MINI, "toggle") => {
            let mini = app.get_webview_window(MINI).ok_or("no mini window")?;
            if mini.is_visible().unwrap_or(false) { mini.hide() } else { mini.show() }.map_err(err)?;
        }
        (_, "move") => {
            let window = app.get_webview_window(target).ok_or("no such window")?;
            if target == MAIN {
                show_main(&app);
            } else {
                window.show().map_err(err)?;
            }
            place(&window, position.as_deref().unwrap_or("center"))?;
        }
        (_, other) => return Err(format!("unknown action \"{other}\"")),
    }
    Ok(format!(
        "interface {}, mini window {}",
        if main_visible(&app) { "shown" } else { "hidden" },
        if app.get_webview_window(MINI).and_then(|w| w.is_visible().ok()).unwrap_or(false) { "shown" } else { "hidden" },
    ))
}

/// Phones and tablets: the interface is the only window and always fills the screen.
#[cfg(mobile)]
#[tauri::command]
pub fn window_control(app: AppHandle, target: String, action: String, position: Option<String>) -> CmdResult<String> {
    let _ = position;
    match (target.as_str(), action.as_str()) {
        ("main" | "auto", "show" | "toggle") => {
            show_main(&app);
            Ok("interface shown (full screen on this device)".into())
        }
        _ => Err("on a phone or tablet the interface always fills the screen: there is no mini window, and it can't be hidden or moved".into()),
    }
}

/// The tray menu's items, relabelled when the interface language changes.
#[cfg(desktop)]
pub struct TrayMenu {
    show: MenuItem<tauri::Wry>,
    mini: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// Labels of the tray menu, in the interface language.
#[cfg(desktop)]
#[tauri::command]
pub fn set_tray_labels(menu: tauri::State<'_, TrayMenu>, show: String, mini: String, quit: String) -> CmdResult<()> {
    menu.show.set_text(show).map_err(err)?;
    menu.mini.set_text(mini).map_err(err)?;
    menu.quit.set_text(quit).map_err(err)
}

/// No tray on phones and tablets.
#[cfg(mobile)]
#[tauri::command]
pub fn set_tray_labels(show: String, mini: String, quit: String) -> CmdResult<()> {
    let _ = (show, mini, quit);
    Ok(())
}

/// Tray icon, mini window, global shortcut and close-to-tray. Called from the app's setup.
#[cfg(desktop)]
pub fn setup(app: &mut App) -> tauri::Result<()> {
    if let Some(main) = app.get_webview_window(MAIN) {
        allow_media(&main);
    }

    // Mini window: same web app (it renders the mini HUD when its window label is "mini").
    let mini = WebviewWindowBuilder::new(app, MINI, WebviewUrl::App("index.html".into()))
        .title("I.R.I.S.")
        .inner_size(MINI_SIZE.0, MINI_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false) // double-clicking its drag area must not maximize it
        .focused(false)
        .visible(false)
        .additional_browser_args(BROWSER_ARGS)
        .build()?;
    allow_media(&mini);
    let _ = place(&mini, MINI_CORNER); // next to the tray icon

    // Tray icon: click = show / hide the interface; menu = the rest. English until the web app
    // sends the labels of the interface language (set_tray_labels). Linux tray icons only
    // have a menu (no click event): "Show Iris" is its first item.
    let show = MenuItem::with_id(app, "show", "Show Iris", true, None::<&str>)?;
    let mini_item = MenuItem::with_id(app, "mini", "Mini window (show / hide)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Iris", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &mini_item, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(TrayMenu { show: show.clone(), mini: mini_item.clone(), quit: quit.clone() });
    let mut tray = TrayIconBuilder::with_id("iris")
        .tooltip("I.R.I.S. — Ctrl+Shift+J")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "mini" => {
                let _ = window_control(app.clone(), MINI.into(), "toggle".into(), None);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    // Linux draws the tray icon from a file: in Flatpak, the default place ($XDG_RUNTIME_DIR)
    // is private to the sandbox and the desktop shows a generic icon; the app's cache folder
    // (~/.var/app/<id>/cache) has the same path outside.
    if crate::sandbox::in_flatpak() {
        if let Ok(cache) = app.path().app_cache_dir() {
            tray = tray.temp_dir_path(cache.join("tray-icon"));
        }
    }
    tray.build(app)?;

    // Ctrl+Shift+J, from any application. (Esc is only registered during computer-use tasks,
    // see computer.rs, and aborts them.)
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyJ);
    let escape = escape_shortcut();
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if shortcut == &toggle {
                    toggle_main(app);
                } else if shortcut == &escape {
                    let _ = app.emit("computer://abort", ());
                }
            })
            .build(),
    )?;
    if let Err(e) = app.global_shortcut().register(toggle) {
        // Another app may own the shortcut (or a Wayland session refuses global shortcuts):
        // Iris still works from the tray.
        log::warn!("could not register Ctrl+Shift+J: {e}");
    }
    // Wayland: the X11 grab above only works over XWayland windows; the desktop portal gives
    // a real global shortcut where the compositor supports it (see portal.rs).
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        crate::portal::listen(app.handle().clone(), toggle_main);
    }

    // Launch at login: registered only when the setting is on (the web app calls `autostart`
    // below). Started that way, Iris goes straight to the tray.
    app.handle().plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec![AUTOSTART_ARG]),
    ))?;
    if std::env::args().any(|a| a == AUTOSTART_ARG) {
        hide_main(app.handle());
    }

    // Updates: the signed latest.json of the newest GitHub Release (tauri.conf.json → plugins),
    // checked by the web app; process restarts Iris into the installed version.
    app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
    app.handle().plugin(tauri_plugin_process::init())?;
    Ok(())
}

/// Settings → "Start Iris with …": whether Iris starts at login, after setting it when
/// `enable` is given. The autostart plugin's entry runs Iris's own program file, which inside
/// Flatpak only exists in the sandbox: there the entry runs `flatpak run <app id>` instead
/// (the manifest grants access to ~/.config/autostart).
#[cfg(desktop)]
#[tauri::command]
pub fn autostart(app: AppHandle, enable: Option<bool>) -> CmdResult<bool> {
    if crate::sandbox::in_flatpak() {
        let id = app.config().identifier.clone();
        let dir = app.path().home_dir().map_err(err)?.join(".config/autostart");
        let entry = dir.join(format!("{id}.desktop"));
        match enable {
            Some(true) => {
                std::fs::create_dir_all(&dir).map_err(err)?;
                let text = format!("[Desktop Entry]\nType=Application\nName=Iris\nExec=flatpak run {id} {AUTOSTART_ARG}\nX-GNOME-Autostart-enabled=true\n");
                std::fs::write(&entry, text).map_err(err)?;
            }
            Some(false) if entry.exists() => std::fs::remove_file(&entry).map_err(err)?,
            _ => {}
        }
        return Ok(entry.exists());
    }
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if let Some(enable) = enable {
        if launcher.is_enabled().map_err(err)? != enable {
            if enable { launcher.enable() } else { launcher.disable() }.map_err(err)?;
        }
    }
    launcher.is_enabled().map_err(err)
}

/// Whether this copy of Iris can update itself (Settings → Updates): the Windows and macOS
/// installs can, and the Linux AppImage; .deb / .rpm packages and Flatpak are updated by the
/// system's own tools, and phones by their store.
#[tauri::command]
pub fn updates_supported() -> bool {
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        return true;
    }
    cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some() && !crate::sandbox::in_flatpak()
}

/// Phones and tablets: the system decides when apps start.
#[cfg(mobile)]
#[tauri::command]
pub fn autostart(enable: Option<bool>) -> CmdResult<bool> {
    let _ = enable;
    Ok(false)
}

/// Phones and tablets: one full-screen window, no tray, no mini window, no global shortcut.
#[cfg(mobile)]
pub fn setup(app: &mut App) -> tauri::Result<()> {
    let _ = app;
    Ok(())
}

/// Passed by the login entry, so a launch at startup can be told from a launch by the user.
#[cfg(desktop)]
const AUTOSTART_ARG: &str = "--autostart";

/// Esc, as a global shortcut while Iris controls the mouse: stops her at once.
#[cfg(desktop)]
pub fn escape_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    tauri_plugin_global_shortcut::Shortcut::new(None, tauri_plugin_global_shortcut::Code::Escape)
}

/// The microphone without a prompt, and sound without a click, like WebView2's switches above.
/// macOS: WKWebView already grants media capture and autoplay (wry), after the OS asks once
/// for the microphone (Info.plist). Linux: WebKitGTK refuses the microphone unless the page's
/// permission request is answered, and WebRTC (premium voice) is off by default.
#[cfg(desktop)]
fn allow_media(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        let result = window.with_webview(|webview| {
            use webkit2gtk::glib::prelude::*;
            use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};
            let view = webview.inner();
            if let Some(settings) = view.settings() {
                settings.set_enable_media_stream(true);
                settings.set_enable_mediasource(true);
                settings.set_enable_webrtc(true);
                settings.set_media_playback_requires_user_gesture(false);
            }
            view.connect_permission_request(|_, request| {
                if request.is::<UserMediaPermissionRequest>() {
                    request.allow();
                    true
                } else {
                    false
                }
            });
        });
        if let Err(e) = result {
            log::warn!("could not enable the microphone in the webview: {e}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// Closing the interface hides it instead: Iris stays in the tray, listening.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    #[cfg(desktop)]
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN {
            api.prevent_close();
            hide_main(window.app_handle());
        }
    }
    #[cfg(mobile)]
    let _ = (window, event);
}
