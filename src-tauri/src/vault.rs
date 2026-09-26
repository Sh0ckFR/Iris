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

#[cfg(desktop)]
mod imp {
    use super::*;

    pub fn get_or_create(_app: &AppHandle) -> Result<String, String> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(password) => Ok(password),
            Err(keyring::Error::NoEntry) => {
                let password = random_secret()?;
                entry.set_password(&password).map_err(|e| e.to_string())?;
                Ok(password)
            }
            Err(e) => Err(format!("OS credential store unavailable: {e}")),
        }
    }
}

/// Mobile has no `keyring` backend here: fall back to a file in the app's private sandbox,
/// which the OS already isolates from other apps.
#[cfg(mobile)]
mod imp {
    use super::*;

    pub fn get_or_create(app: &AppHandle) -> Result<String, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let path = dir.join(format!("{ACCOUNT}.key"));
        if let Ok(password) = std::fs::read_to_string(&path) {
            return Ok(password);
        }
        let _ = SERVICE;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let password = random_secret()?;
        std::fs::write(&path, &password).map_err(|e| e.to_string())?;
        Ok(password)
    }
}
