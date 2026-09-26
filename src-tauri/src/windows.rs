//! Background mode: Iris lives in the notification area.
//!
//! - Closing the main window only hides it: Iris keeps listening, and a small always-on-top
//!   "mini" window appears above the tray icon (it can be hidden too).
//! - The tray icon (click) and Ctrl+Shift+J (from anywhere) bring the interface back.
//! - `window_control` lets Iris show, hide or move her windows when asked.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// WebView2 switches, the same for every window (they share one browser environment, which must
/// be created with identical arguments). Setting them replaces Tauri's defaults, so these are
/// repeated: the disabled features, and audio playing without a click (Iris speaks first, at
/// launch). Added: the microphone is granted without a prompt — Iris listens from launch, and a
/// dismissed prompt left her deaf ("Permission dismissed"); only the prompt is skipped, the real
/// microphone is used. Keep in sync with the main window's `additionalBrowserArgs` in tauri.conf.json.
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream";

const MAIN: &str = "main";
const MINI: &str = "mini";
/// Size of the mini window (logical pixels), just enough for the eye, status and last reply.
const MINI_SIZE: (f64, f64) = (340.0, 112.0);

/// Shows and focuses the interface; the mini window is then redundant.
pub fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(mini) = app.get_webview_window(MINI) {
        let _ = mini.hide();
    }
}

/// Hides the interface (Iris keeps running) and shows the mini window.
pub fn hide_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.hide();
    }
    if let Some(mini) = app.get_webview_window(MINI) {
        let _ = mini.show();
    }
}

fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN)
        .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

fn toggle_main(app: &AppHandle) {
    if main_visible(app) {
        hide_main(app);
    } else {
        show_main(app);
    }
}

/// Moves a window to a corner / edge / the centre of its screen's work area (taskbar excluded).
/// `position`: combinations of top / bottom and left / right, or "center".
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

/// The tray menu's items, relabelled when the interface language changes.
pub struct TrayMenu {
    show: MenuItem<tauri::Wry>,
    mini: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// Labels of the tray menu, in the interface language.
#[tauri::command]
pub fn set_tray_labels(menu: tauri::State<'_, TrayMenu>, show: String, mini: String, quit: String) -> CmdResult<()> {
    menu.show.set_text(show).map_err(err)?;
    menu.mini.set_text(mini).map_err(err)?;
    menu.quit.set_text(quit).map_err(err)
}

/// Tray icon, mini window, global shortcut and close-to-tray. Called from the app's setup.
pub fn setup(app: &mut App) -> tauri::Result<()> {
    // Mini window: same web app (it renders the mini HUD when its window label is "mini").
    let mini = WebviewWindowBuilder::new(app, MINI, WebviewUrl::App("index.html".into()))
        .title("I.R.I.S.")
        .inner_size(MINI_SIZE.0, MINI_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false) // double-clicking its drag area must not maximize it
        .focused(false)
        .visible(false)
        .additional_browser_args(BROWSER_ARGS)
        .build()?;
    let _ = place(&mini, "bottom-right"); // above the tray icon

    // Tray icon: click = show / hide the interface; menu = the rest. English until the web app
    // sends the labels of the interface language (set_tray_labels).
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
    tray.build(app)?;

    // Ctrl+Shift+J, from any application. (Esc is only registered during computer-use tasks,
    // see computer.rs, and aborts them.)
    #[cfg(desktop)]
    {
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
            // Another app may own the shortcut: Iris still works from the tray.
            log::warn!("could not register Ctrl+Shift+J: {e}");
        }

        // Launch at login: registered only when the setting is on (the web app calls
        // plugin:autostart|enable / disable). Started that way, Iris goes straight to the tray.
        app.handle().plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))?;
        if std::env::args().any(|a| a == AUTOSTART_ARG) {
            hide_main(app.handle());
        }
    }
    Ok(())
}

/// Passed by the login entry, so a launch at startup can be told from a launch by the user.
const AUTOSTART_ARG: &str = "--autostart";

/// Esc, as a global shortcut while Iris controls the mouse: stops her at once.
#[cfg(desktop)]
pub fn escape_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    tauri_plugin_global_shortcut::Shortcut::new(None, tauri_plugin_global_shortcut::Code::Escape)
}

/// Closing the interface hides it instead: Iris stays in the tray, listening.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN {
            api.prevent_close();
            hide_main(window.app_handle());
        }
    }
}
