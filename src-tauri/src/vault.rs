//! Master password for the Stronghold vault that holds the user's API keys.
//!
//! Zero-config: the password is a random 256-bit secret generated on first use and kept in the
//! OS credential store (Windows Credential Manager / macOS Keychain / Linux Secret Service), so
//! the user never types one and the vault file alone is useless to anyone who copies it.

use serde::Serialize;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "com.iris.assistant";
const ACCOUNT: &str = "stronghold-vault";

#[derive(Serialize)]
pub struct VaultParams {
    path: String,
    password: String,
}

/// Everything the frontend needs for `Stronghold.load(path, password)`.
/// Also makes sure the vault's parent directory exists (Stronghold won't create it).
#[tauri::command]
pub async fn vault_params(app: AppHandle) -> Result<VaultParams, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(VaultParams {
        path: dir.join("vault.hold").to_string_lossy().into_owned(),
        password: imp::get_or_create(&app)?,
    })
}

/// Stronghold derives its encryption key from the password with this function. Our password is
/// already 256 bits of randomness, so a slow KDF (argon2) — which exists to protect weak human
/// passwords — adds nothing but seconds of startup; SHA-256 is sufficient.
pub fn hash_password(password: &str) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(password.as_bytes()).to_vec()
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(hex::encode(bytes))
}

/// The password in a file of the app's private data folder, readable by the user only: on
/// phones (the OS isolates each app), and on a desktop without a credential store (a Linux
/// session without GNOME Keyring / KWallet). Created only when it doesn't exist yet.
fn file_secret(app: &AppHandle, create: bool) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join(format!("{ACCOUNT}.key"));
    if let Ok(password) = std::fs::read_to_string(&path) {
        return Ok(Some(password.trim().to_string()));
    }
    if !create {
        return Ok(None);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let password = random_secret()?;
    std::fs::write(&path, &password).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(Some(password))
}

#[cfg(desktop)]
mod imp {
    use super::*;

    pub fn get_or_create(app: &AppHandle) -> Result<String, String> {
        // Already on the fallback file (no credential store when the vault was created).
        if let Some(password) = file_secret(app, false)? {
            return Ok(password);
        }
        let store_error = match keyring::Entry::new(SERVICE, ACCOUNT) {
            Ok(entry) => match entry.get_password() {
                Ok(password) => return Ok(password),
                Err(keyring::Error::NoEntry) => {
                    let password = random_secret()?;
                    match entry.set_password(&password) {
                        Ok(()) => return Ok(password),
                        Err(e) => e.to_string(),
                    }
                }
                Err(e) => e.to_string(),
            },
            Err(e) => e.to_string(),
        };
        // No credential store. A vault already sealed with a stored password must not get a
        // new one (its keys would be lost): only a first vault falls back to the file.
        let vault = app.path().app_data_dir().map_err(|e| e.to_string())?.join("vault.hold");
        if vault.exists() {
            return Err(format!("OS credential store unavailable: {store_error}"));
        }
        log::warn!("OS credential store unavailable ({store_error}); keeping the vault password in a private file");
        file_secret(app, true)?.ok_or_else(|| "could not create the vault password".to_string())
    }
}

/// Mobile has no `keyring` backend here: the file in the app's private sandbox, which the OS
/// already isolates from other apps.
#[cfg(mobile)]
mod imp {
    use super::*;

    pub fn get_or_create(app: &AppHandle) -> Result<String, String> {
        let _ = SERVICE;
        file_secret(app, true)?.ok_or_else(|| "could not create the vault password".to_string())
    }
}
