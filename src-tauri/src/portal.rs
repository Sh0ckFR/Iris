//! Wayland: global shortcuts belong to the compositor, and an X11 key grab (what the
//! global-shortcut plugin does) only fires while an XWayland window has the focus. The desktop
//! portal's GlobalShortcuts interface (GNOME 48+, KDE Plasma 5.27+, Hyprland…) lets Iris ask
//! for Ctrl+Shift+J properly; the desktop may show the user a dialog to confirm or change it.
//! Without the portal, Iris keeps the X11 registration and the tray.

use futures_util::StreamExt;
use tauri::AppHandle;

use ashpd::desktop::{
    global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut},
    CreateSessionOptions,
};

const TOGGLE: &str = "toggle-iris";

/// A Wayland session (where the portal is the only way to a global shortcut).
pub fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.eq_ignore_ascii_case("wayland"))
}

/// Binds Ctrl+Shift+J through the portal and calls `on_toggle` each time it is pressed.
/// Runs for as long as Iris does; returns only if the portal is missing or refuses.
pub fn listen(app: AppHandle, on_toggle: fn(&AppHandle)) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = bind_and_listen(&app, on_toggle).await {
            log::warn!("Wayland global shortcut portal unavailable ({e}); Ctrl+Shift+J only works over XWayland windows, the tray still does");
        }
    });
}

async fn bind_and_listen(app: &AppHandle, on_toggle: fn(&AppHandle)) -> ashpd::Result<()> {
    let portal = GlobalShortcuts::new().await?;
    let session = portal.create_session(CreateSessionOptions::default()).await?;
    let shortcut = NewShortcut::new(TOGGLE, "Show or hide Iris").preferred_trigger("CTRL+SHIFT+j");
    let bound = portal
        .bind_shortcuts(&session, &[shortcut], None, BindShortcutsOptions::default())
        .await?
        .response()?;
    for s in bound.shortcuts() {
        log::info!("Wayland global shortcut \"{}\": {}", s.id(), s.trigger_description());
    }
    let mut activations = std::pin::pin!(portal.receive_activated().await?);
    while let Some(event) = activations.next().await {
        if event.shortcut_id() == TOGGLE {
            on_toggle(app);
        }
    }
    // Keep the session (and so the binding) alive until the stream ends.
    drop(session);
    Ok(())
}
