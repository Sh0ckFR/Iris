mod computer;
mod mcp;
mod memory;
mod screen;
mod system;
mod vault;
mod windows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // "En service depuis": counted from this launch, not from the computer's boot.
    system::mark_app_start();
    // macOS / Linux: an app started from the Dock, Finder or a desktop menu gets a bare PATH;
    // take the user's own (Homebrew, nvm, ~/.local/bin…) so `npx`, `uvx`, `brew`… resolve
    // like in a terminal, for MCP servers, commands and skills.
    system::adopt_login_shell_path();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_stronghold::Builder::new(vault::hash_password).build())
        // Routes `log::*` to stdout + a rotating file in the app log dir.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(system::TelemetryState::default())
        .manage(mcp::McpState::default())
        // Tray icon, mini window, Ctrl+Shift+J; closing the window keeps Iris in the tray.
        .setup(|app| Ok(windows::setup(app)?))
        .on_window_event(windows::on_window_event)
        .invoke_handler(tauri::generate_handler![
            vault::vault_params,
            system::os_context,
            system::system_stats,
            system::os_open_app,
            system::os_volume,
            system::os_open_path,
            system::os_open_url,
            system::os_list_dir,
            system::os_create_dir,
            system::os_write_file,
            system::os_move,
            system::os_trash,
            system::os_run_command,
            system::run_skill_script,
            system::skill_http,
            system::web_get,
            system::save_visual,
            system::save_image,
            windows::window_control,
            windows::set_tray_labels,
            screen::capture_screen,
            memory::memory_read,
            memory::memory_write,
            computer::computer_windows,
            computer::computer_window,
            computer::computer_observe,
            computer::computer_act,
            computer::computer_begin,
            computer::computer_end,
            mcp::mcp_start,
            mcp::mcp_send,
            mcp::mcp_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building Iris");

    app.run(|app, event| {
        // macOS: the interface hidden in the menu bar comes back when the Dock icon is clicked.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            windows::show_main(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
