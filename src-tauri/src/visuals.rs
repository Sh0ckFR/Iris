//! The pages Iris creates (create_visual) are shown from their own origin, `visual://` —
//! not as an `<iframe srcdoc>`: a srcdoc frame inherits the HUD's Content-Security-Policy, which
//! forbids what generated pages need (inline scripts, libraries from a CDN). Here they keep the
//! freedom they had, while the HUD itself runs under a strict policy (tauri.conf.json). The
//! frame stays sandboxed without same-origin, so a page still can't reach Iris or her data.
//!
//! The webview asks for `visual://localhost/<key>` (`http://visual.localhost/<key>` on Windows
//! and Android); the HUD publishes each page's HTML under its key first (`visual_publish`).

use std::{borrow::Cow, collections::VecDeque, sync::Mutex};

use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "visual";

/// Pages kept: each visual card holds one key; the oldest are forgotten.
const MAX_PAGES: usize = 48;
/// A generated page is a few hundred kB at most; anything bigger is refused.
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

static PAGES: Mutex<VecDeque<(String, String)>> = Mutex::new(VecDeque::new());

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Stores (or replaces) the page shown under `key`.
#[tauri::command]
pub fn visual_publish(key: String, html: String) -> Result<(), String> {
    if !valid_key(&key) {
        return Err(format!("invalid visual key \"{key}\""));
    }
    if html.len() > MAX_PAGE_BYTES {
        return Err("this page is too big to show".into());
    }
    let mut pages = PAGES.lock().map_err(|e| e.to_string())?;
    pages.retain(|(k, _)| *k != key);
    pages.push_back((key, html));
    while pages.len() > MAX_PAGES {
        pages.pop_front();
    }
    Ok(())
}

/// The `visual://` protocol: the page published under the path's key.
pub fn serve(request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let key = request.uri().path().trim_start_matches('/');
    let page = PAGES
        .lock()
        .ok()
        .and_then(|pages| pages.iter().find(|(k, _)| k == key).map(|(_, html)| html.clone()));
    let builder = Response::builder().header(header::CACHE_CONTROL, "no-store");
    match page {
        Some(html) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Cow::Owned(html.into_bytes())),
        None => builder
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Cow::Borrowed(&b"This visual is no longer available."[..])),
    }
    .unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_the_published_page() {
        visual_publish("test-card_1".into(), "<p>hello</p>".into()).unwrap();
        let request = Request::builder().uri("visual://localhost/test-card_1?v=3").body(Vec::new()).unwrap();
        let response = serve(&request);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(&response.body()[..], b"<p>hello</p>");
        let missing = Request::builder().uri("http://visual.localhost/nothing").body(Vec::new()).unwrap();
        assert_eq!(serve(&missing).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn refuses_odd_keys() {
        assert!(visual_publish("../etc".into(), String::new()).is_err());
        assert!(visual_publish(String::new(), String::new()).is_err());
    }
}
