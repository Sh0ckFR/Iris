//! Transport of the memory sync (lib/sync.ts): one HTTP request to the storage the user chose —
//! a WebDAV server (Nextcloud, kDrive, Koofr…) or a secret GitHub Gist. The content is already
//! encrypted by the web app with the user's passphrase: the storage only ever sees ciphertext.
//!
//! Unlike web_get / skill_http (public internet only, see netguard.rs), this may reach the local
//! network: a Nextcloud at home is a normal place to sync. Plain http is only accepted there.

use std::{collections::HashMap, net::IpAddr, time::Duration};

use serde::Serialize;

type CmdResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    status: u16,
    etag: Option<String>,
    body: String,
}

/// Plain http only to this computer or the local network (nothing readable leaves it anyway).
fn allowed(url: &reqwest::Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => match url.host() {
            Some(url::Host::Ipv4(ip)) => !crate::netguard::is_public(IpAddr::V4(ip)),
            Some(url::Host::Ipv6(ip)) => !crate::netguard::is_public(IpAddr::V6(ip)),
            Some(url::Host::Domain(name)) => {
                let name = name.to_ascii_lowercase();
                name == "localhost" || name.ends_with(".local") || name.ends_with(".lan") || name.ends_with(".home.arpa") || !name.contains('.')
            }
            None => false,
        },
        _ => false,
    }
}

#[tauri::command]
pub async fn sync_http(method: String, url: String, headers: HashMap<String, String>, body: Option<String>) -> CmdResult<SyncResponse> {
    let url = reqwest::Url::parse(&url).map_err(|e| format!("invalid sync address: {e}"))?;
    if !allowed(&url) {
        return Err("the sync address must use https (plain http only on the local network)".into());
    }
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("Iris-Assistant/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.request(method, url);
    for (k, v) in headers {
        request = request.header(k, v);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(crate::netguard::describe)?;
    let status = response.status().as_u16();
    let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(String::from);
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(SyncResponse { status, etag, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_only_on_the_local_network() {
        let ok = |u: &str| allowed(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://cloud.example.com/remote.php/dav/files/me/iris.sync"));
        assert!(ok("http://192.168.1.20/dav/iris.sync"));
        assert!(ok("http://nextcloud.local/dav/iris.sync"));
        assert!(ok("http://nas/dav/iris.sync"));
        assert!(!ok("http://cloud.example.com/iris.sync"));
        assert!(!ok("http://8.8.8.8/iris.sync"));
        assert!(!ok("ftp://nas/iris.sync"));
    }
}
