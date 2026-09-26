//! Long-term memory files (facts about the user, conversation, journal), as JSON documents in
//! the app data folder: `<app data>/memory/<name>.json`. The content is managed by the HUD.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn file(app: &AppHandle, name: &str) -> CmdResult<PathBuf> {
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(format!("invalid memory file name \"{name}\""));
    }
    let dir = app.path().app_data_dir().map_err(err)?.join("memory");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(format!("{name}.json")))
}

#[tauri::command]
pub async fn memory_read(app: AppHandle, name: String) -> CmdResult<Option<String>> {
    let path = file(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// Written to a temporary file first, then renamed: a crash never leaves a half-written memory.
#[tauri::command]
pub async fn memory_write(app: AppHandle, name: String, content: String) -> CmdResult<()> {
    let path = file(&app, &name)?;
    // One temporary file per write: two quick saves of the same memory must not share it.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{seq}.tmp"));
    std::fs::write(&tmp, content).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)
}
