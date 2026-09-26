//! OS control: the actions Iris can perform on the computer.
//!
//! Human-in-the-loop: the model only *proposes* actions (tool calls). The React UI shows each
//! mutating action to the user, and only calls these commands once the user has approved it.
//! The checks below are a second line of defence (absolute paths, no system folders, no
//! overwriting, deletions go to the Recycle Bin), not a substitute for that approval.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Expands `~` and requires an absolute path, so the model can't act relative to some
/// unknown working directory.
fn resolve(app: &AppHandle, raw: &str) -> CmdResult<PathBuf> {
    let raw = normalize_separators(raw.trim().trim_matches('"'));
    let raw = raw.as_str();
    let path = if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        app.path().home_dir().map_err(err)?.join(raw[1..].trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() {
        return Err(format!("\"{raw}\" is not an absolute path"));
    }
    Ok(path)
}

/// Models sometimes over-escape paths ("C:\\\\Users\\\\yann"): collapse repeated separators
/// (keeping a leading `\\` UNC prefix) and use the platform's separator.
fn normalize_separators(raw: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR;
    let unc = cfg!(windows) && (raw.starts_with("\\\\") || raw.starts_with("//")) && !raw.contains(':');
    let mut out = String::with_capacity(raw.len());
    let mut prev_sep = false;
    for c in raw.chars() {
        let is_sep = c == '/' || (cfg!(windows) && c == '\\');
        if is_sep {
            if !prev_sep {
                out.push(sep);
            }
            prev_sep = true;
        } else {
            out.push(c);
            prev_sep = false;
        }
    }
    if unc {
        out.insert(0, sep);
    }
    out
}

/// Refuses to modify the filesystem root, the home folder itself, or OS/program folders.
fn guard_mutation(app: &AppHandle, path: &Path) -> CmdResult<()> {
    let home = app.path().home_dir().map_err(err)?;
    if path.parent().is_none() || path == home {
        return Err(format!("refusing to modify {}", path.display()));
    }
    let lower = path.to_string_lossy().to_lowercase().replace('\\', "/");
    const PROTECTED: &[&str] = &[
        "c:/windows",
        "c:/program files",
        "c:/programdata",
        "/system",
        "/library",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/boot",
        "/applications",
    ];
    if PROTECTED.iter().any(|p| lower == *p || lower.starts_with(&format!("{p}/"))) {
        return Err(format!("{} is a system location; Iris won't modify it", path.display()));
    }
    Ok(())
}

// ------------------------------------------------------------------ open things

#[tauri::command]
pub async fn os_open_path(app: AppHandle, path: String) -> CmdResult<String> {
    let path = resolve(&app, &path)?;
    app.opener().open_path(path.to_string_lossy(), None::<String>).map_err(err)?;
    Ok(format!("Opened {}", path.display()))
}

#[tauri::command]
pub async fn os_open_url(app: AppHandle, url: String) -> CmdResult<String> {
    let url = url.trim();
    let url = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    app.opener().open_url(&url, None::<String>).map_err(err)?;
    Ok(format!("Opened {url}"))
}

/// Lower-case, accents folded, alphanumerics only: "Bloc-notes" and "bloc notes" match.
fn normalize(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' | 'À' | 'Â' | 'Ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'î' | 'ï' | 'í' | 'Î' | 'Ï' => 'i',
            'ô' | 'ö' | 'ó' | 'Ô' | 'Ö' => 'o',
            'ù' | 'û' | 'ü' | 'ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            c => c.to_ascii_lowercase(),
        })
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// Built-in tools users ask for by their French or English name.
fn builtin_alias(name: &str) -> Option<&'static str> {
    let n = normalize(name);
    let pairs: &[(&[&str], &str)] = if cfg!(windows) {
        &[
            (&["calculatrice", "calculator", "calc"], "calc"),
            (&["blocnotes", "notepad"], "notepad"),
            (&["parametres", "settings", "reglages"], "ms-settings:"),
            (&["explorateur", "explorer", "fileexplorer", "explorateurdefichiers"], "explorer"),
            (&["gestionnairedestaches", "taskmanager", "taskmgr"], "taskmgr"),
            (&["paint"], "mspaint"),
            (&["terminal", "windowsterminal"], "wt"),
            (&["invitedecommandes", "cmd", "commandprompt"], "cmd"),
            (&["powershell"], "powershell"),
        ]
    } else if cfg!(target_os = "macos") {
        &[
            (&["calculatrice", "calculator"], "Calculator"),
            (&["blocnotes", "notes"], "Notes"),
            (&["parametres", "settings", "reglages", "preferencessysteme"], "System Settings"),
            (&["explorateur", "finder"], "Finder"),
            (&["terminal"], "Terminal"),
        ]
    } else {
        &[]
    };
    pairs.iter().find(|(names, _)| names.contains(&n.as_str())).map(|(_, target)| *target)
}

/// Finds a Start Menu shortcut (Windows) or .desktop entry (Linux) whose name matches.
#[cfg(any(windows, target_os = "linux"))]
fn find_installed_app(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let wanted = normalize(name);
    if wanted.is_empty() {
        return None;
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            roots.push(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        if let Some(pd) = std::env::var_os("ProgramData") {
            roots.push(PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        if let Ok(desktop) = app.path().desktop_dir() {
            roots.push(desktop);
        }
    }
    #[cfg(target_os = "linux")]
    {
        roots.push(PathBuf::from("/usr/share/applications"));
        if let Ok(home) = app.path().home_dir() {
            roots.push(home.join(".local/share/applications"));
        }
    }
    #[cfg(not(windows))]
    let _ = app;

    // Score: exact name 3, starts with 2, contains 1. Shorter names win ties ("Word" over "Word Viewer").
    let mut best: Option<(u8, usize, PathBuf)> = None;
    let mut stack = roots;
    let mut visited = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 5000 {
                break;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !matches!(ext.as_str(), "lnk" | "url" | "appref-ms" | "desktop") {
                continue;
            }
            let stem = normalize(path.file_stem().and_then(|s| s.to_str()).unwrap_or(""));
            if stem.contains("uninstall") || stem.contains("desinstall") {
                continue;
            }
            let score = if stem == wanted {
                3
            } else if stem.starts_with(&wanted) {
                2
            } else if stem.contains(&wanted) {
                1
            } else {
                0
            };
            if score == 0 {
                continue;
            }
            let better = match &best {
                None => true,
                Some((s, len, _)) => score > *s || (score == *s && stem.len() < *len),
            };
            if better {
                best = Some((score, stem.len(), path));
            }
        }
    }
    best.map(|(_, _, p)| p)
}

#[tauri::command]
pub async fn os_open_app(app: AppHandle, name: String) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err("invalid application name".into());
    }

    #[cfg(windows)]
    {
        if let Some(target) = builtin_alias(name) {
            launch_windows(target)?;
            return Ok(format!("Launched {target}"));
        }
        if let Some(shortcut) = find_installed_app(&app, name) {
            app.opener().open_path(shortcut.to_string_lossy(), None::<String>).map_err(err)?;
            let label = shortcut.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            return Ok(format!("Launched {label}"));
        }
        // Last resort: let Windows resolve it (App Paths registry, PATH, URI schemes).
        launch_windows(name)?;
        Ok(format!("Launched {name}"))
    }

    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        let target = builtin_alias(name).unwrap_or(name);
        let status = std::process::Command::new("open").args(["-a", target]).status().map_err(err)?;
        if status.success() {
            Ok(format!("Launched {target}"))
        } else {
            Err(format!("no application named \"{target}\" was found"))
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = builtin_alias;
        if let Some(entry) = find_installed_app(&app, name) {
            let id = entry.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            std::process::Command::new("gtk-launch").arg(&id).spawn().map_err(err)?;
            return Ok(format!("Launched {id}"));
        }
        std::process::Command::new(name).spawn().map_err(|_| format!("no application named \"{name}\" was found"))?;
        Ok(format!("Launched {name}"))
    }

    #[cfg(mobile)]
    {
        let _ = (&app, builtin_alias);
        Err("launching apps is not supported on this platform".into())
    }
}

/// `cmd /C start "" <name>` — only for names made of safe characters (no shell injection).
#[cfg(windows)]
fn launch_windows(name: &str) -> CmdResult<()> {
    use std::os::windows::process::CommandExt;
    if !name.chars().all(|c| c.is_alphanumeric() || " ._-:+".contains(c)) {
        return Err(format!("\"{name}\" is not a valid application name"));
    }
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", name])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(err)?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("no application named \"{name}\" was found"))
    }
}

// ------------------------------------------------------------------ volume

/// System volume: `up` / `down` by `steps` (≈2 % each on Windows), or `mute` (toggles).
#[tauri::command]
pub async fn os_volume(action: String, steps: u32) -> CmdResult<String> {
    let steps = steps.clamp(1, 50);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Media keys through WScript.Shell: VK_VOLUME_MUTE 173, DOWN 174, UP 175.
        let (key, count) = match action.as_str() {
            "up" => (175, steps),
            "down" => (174, steps),
            "mute" => (173, 1),
            _ => return Err(format!("unknown volume action \"{action}\"")),
        };
        let script = format!("$w = New-Object -ComObject WScript.Shell; 1..{count} | ForEach-Object {{ $w.SendKeys([char]{key}) }}");
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(err)?;
        if !status.success() {
            return Err("could not change the volume".into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let script = match action.as_str() {
            "up" => format!("set volume output volume ((output volume of (get volume settings)) + {})", steps * 2),
            "down" => format!("set volume output volume ((output volume of (get volume settings)) - {})", steps * 2),
            "mute" => "set volume output muted not (output muted of (get volume settings))".to_string(),
            _ => return Err(format!("unknown volume action \"{action}\"")),
        };
        std::process::Command::new("osascript").args(["-e", &script]).status().map_err(err)?;
    }
    #[cfg(target_os = "linux")]
    {
        let args: Vec<String> = match action.as_str() {
            "up" => vec!["set-sink-volume".into(), "@DEFAULT_SINK@".into(), format!("+{}%", steps * 2)],
            "down" => vec!["set-sink-volume".into(), "@DEFAULT_SINK@".into(), format!("-{}%", steps * 2)],
            "mute" => vec!["set-sink-mute".into(), "@DEFAULT_SINK@".into(), "toggle".into()],
            _ => return Err(format!("unknown volume action \"{action}\"")),
        };
        std::process::Command::new("pactl").args(&args).status().map_err(err)?;
    }
    #[cfg(mobile)]
    {
        let _ = (&action, steps);
        return Err("volume control is not supported on this platform".into());
    }
    Ok(match action.as_str() {
        "mute" => "Toggled mute".to_string(),
        _ => format!("Volume {action} by about {} %", steps * 2),
    })
}

// ------------------------------------------------------------------ files

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    is_dir: bool,
    size: u64,
    /// Unix milliseconds.
    modified: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    path: String,
    entries: Vec<DirEntry>,
    truncated: bool,
}

const MAX_ENTRIES: usize = 300;

#[tauri::command]
pub async fn os_list_dir(app: AppHandle, path: String) -> CmdResult<DirListing> {
    let path = resolve(&app, &path)?;
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    for entry in std::fs::read_dir(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") {
            continue; // hidden / system files
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let meta = entry.metadata().ok();
        entries.push(DirEntry {
            name,
            is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
            size: meta.as_ref().map_or(0, |m| m.len()),
            modified: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
        });
    }
    // Folders first, then alphabetical.
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(DirListing { path: path.to_string_lossy().into_owned(), entries, truncated })
}

#[tauri::command]
pub async fn os_create_dir(app: AppHandle, path: String) -> CmdResult<String> {
    let path = resolve(&app, &path)?;
    guard_mutation(&app, &path)?;
    std::fs::create_dir_all(&path).map_err(err)?;
    Ok(format!("Created folder {}", path.display()))
}

#[tauri::command]
pub async fn os_write_file(app: AppHandle, path: String, content: String, overwrite: bool) -> CmdResult<String> {
    let path = resolve(&app, &path)?;
    guard_mutation(&app, &path)?;
    if path.exists() && !overwrite {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&path, content).map_err(err)?;
    Ok(format!("Wrote {}", path.display()))
}

#[tauri::command]
pub async fn os_move(app: AppHandle, from: String, to: String) -> CmdResult<String> {
    let from = resolve(&app, &from)?;
    let mut to = resolve(&app, &to)?;
    guard_mutation(&app, &from)?;
    guard_mutation(&app, &to)?;
    if !from.exists() {
        return Err(format!("{} does not exist", from.display()));
    }
    // Moving into an existing folder keeps the original name.
    if to.is_dir() {
        if let Some(name) = from.file_name() {
            to = to.join(name);
        }
    }
    if to.exists() {
        return Err(format!("{} already exists; Iris won't overwrite it", to.display()));
    }
    std::fs::rename(&from, &to).map_err(err)?;
    Ok(format!("Moved {} to {}", from.display(), to.display()))
}

#[tauri::command]
pub async fn os_trash(app: AppHandle, path: String) -> CmdResult<String> {
    let path = resolve(&app, &path)?;
    guard_mutation(&app, &path)?;
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    #[cfg(desktop)]
    {
        trash::delete(&path).map_err(err)?;
        Ok(format!("Moved {} to the Recycle Bin", path.display()))
    }
    #[cfg(mobile)]
    Err("deleting files is not supported on this platform".into())
}

// ------------------------------------------------------------------ shell

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT: usize = 8000;

fn clip(text: &[u8]) -> String {
    let s = String::from_utf8_lossy(text);
    let s = s.trim();
    if s.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n… (output truncated)", &s[..cut])
    } else {
        s.to_string()
    }
}

/// Runs a shell command (PowerShell on Windows, sh elsewhere) in the user's home folder.
#[tauri::command]
pub async fn os_run_command(app: AppHandle, command: String) -> CmdResult<CommandOutput> {
    run_shell(&app, &command, &HashMap::new()).await
}

/// Runs an installed skill's script. Arguments are passed as environment variables
/// (`IRIS_<NAME>`, read as `$env:IRIS_CITY` / `$IRIS_CITY`), never pasted into the script
/// text, so a value like `"; rm -rf ~` can't inject commands.
#[tauri::command]
pub async fn run_skill_script(app: AppHandle, script: String, args: HashMap<String, String>) -> CmdResult<CommandOutput> {
    let mut env = HashMap::new();
    for (name, value) in args {
        let key: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect::<String>().to_uppercase();
        if !key.is_empty() {
            env.insert(format!("IRIS_{key}"), value);
        }
    }
    run_shell(&app, &script, &env).await
}

async fn run_shell(app: &AppHandle, command: &str, env: &HashMap<String, String>) -> CmdResult<CommandOutput> {
    let home = app.path().home_dir().map_err(err)?;

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = tokio::process::Command::new("powershell.exe");
        // UTF-8 output so accented file names survive.
        let script = format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8; {command}");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script]);
        c.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.envs(env).current_dir(home).stdin(std::process::Stdio::null()).kill_on_drop(true);
    match tokio::time::timeout(COMMAND_TIMEOUT, cmd.output()).await {
        Ok(output) => {
            let output = output.map_err(err)?;
            Ok(CommandOutput {
                exit_code: output.status.code(),
                stdout: clip(&output.stdout),
                stderr: clip(&output.stderr),
                timed_out: false,
            })
        }
        Err(_) => Ok(CommandOutput { exit_code: None, stdout: String::new(), stderr: String::new(), timed_out: true }),
    }
}

// ------------------------------------------------------------------ skills: web API calls

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResult {
    status: u16,
    content_type: String,
    body: String,
}

/// HTTP request of a user-approved "http" skill. Runs in Rust so skills can reach any public
/// API (the webview is limited to an allowlist); only http(s), 20 s timeout, body clipped.
#[tauri::command]
pub async fn skill_http(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> CmdResult<HttpResult> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("skills can only call http(s) URLs".into());
    }
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(err)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("Iris-Assistant/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(err)?;
    let mut request = client.request(method, &url);
    for (k, v) in headers {
        request = request.header(k, v);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(err)?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().await.map_err(err)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() > 20_000 {
        let mut cut = 20_000;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… (truncated)");
    }
    Ok(HttpResult { status, content_type, body: text })
}

// ------------------------------------------------------------------ web pages

/// Browser user agent: search engines and many sites serve a stripped or blocked page otherwise.
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
/// Pages are parsed in the webview; anything bigger is cut (the text is at the top anyway).
const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    status: u16,
    content_type: String,
    /// Address after redirects.
    url: String,
    body: String,
}

/// Read-only GET of any public web page (web search results, articles the user asks about).
/// Runs in Rust: the webview's HTTP client is limited to an allowlist of APIs.
#[tauri::command]
pub async fn web_get(url: String, language: Option<String>) -> CmdResult<WebPage> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) pages can be read".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(err)?;
    let lang = language.unwrap_or_else(|| "en".into());
    let mut response = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
        .header(reqwest::header::ACCEPT_LANGUAGE, format!("{lang},en;q=0.7"))
        .send()
        .await
        .map_err(err)?;
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(err)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= MAX_PAGE_BYTES {
            bytes.truncate(MAX_PAGE_BYTES);
            break;
        }
    }
    Ok(WebPage { status, content_type, url: final_url, body: String::from_utf8_lossy(&bytes).into_owned() })
}

// ------------------------------------------------------------------ generated images

/// Saves a generated image (base64) as `Pictures/Iris/iris-<timestamp>.<ext>`; returns the path.
#[tauri::command]
pub async fn save_image(app: AppHandle, base64_data: String, extension: String) -> CmdResult<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64_data.trim()).map_err(err)?;
    let ext = match extension.as_str() {
        "jpeg" | "jpg" => "jpg",
        "webp" => "webp",
        _ => "png",
    };
    let dir = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(err)?
        .join("Iris");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("iris-{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Saves a visual Iris created (web page, SVG, document, code) as `Documents/Iris/<name>.<ext>`
/// and returns the path; an existing file of the same name gets a numbered suffix.
#[tauri::command]
pub async fn save_visual(app: AppHandle, name: String, extension: String, content: String) -> CmdResult<String> {
    let ext: String = extension.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let ext = if ext.is_empty() { "txt".to_string() } else { ext.to_lowercase() };
    // File-name safe on every OS: letters/digits (accents included), spaces, dashes, underscores.
    let mut stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim()
        .chars()
        .take(60)
        .collect();
    if stem.is_empty() {
        stem = "iris".into();
    }
    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(err)?
        .join("Iris");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    std::fs::write(&path, content).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ telemetry (HUD readouts)

/// Kept between polls: CPU usage is computed from the difference between two refreshes.
pub struct TelemetryState(std::sync::Mutex<sysinfo::System>);

impl Default for TelemetryState {
    fn default() -> Self {
        Self(std::sync::Mutex::new(sysinfo::System::new()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// 0..100, all cores.
    cpu: f32,
    memory_used: u64,
    memory_total: u64,
    uptime_secs: u64,
}

/// When this Iris process started.
static APP_START: std::sync::LazyLock<std::time::Instant> = std::sync::LazyLock::new(std::time::Instant::now);

/// Starts the uptime clock (called first thing at launch).
pub fn mark_app_start() {
    std::sync::LazyLock::force(&APP_START);
}

#[tauri::command]
pub async fn system_stats(state: tauri::State<'_, TelemetryState>) -> CmdResult<SystemStats> {
    let mut sys = state.0.lock().map_err(err)?;
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    Ok(SystemStats {
        cpu: sys.global_cpu_usage(),
        memory_used: sys.used_memory(),
        memory_total: sys.total_memory(),
        // Since Iris started (the PC's own uptime spans days with Windows' fast startup).
        uptime_secs: APP_START.elapsed().as_secs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_over_escaped_separators() {
        if cfg!(windows) {
            assert_eq!(normalize_separators(r"C:\\Users\\yann\\Downloads"), r"C:\Users\yann\Downloads");
            assert_eq!(normalize_separators("C:/Users/yann/Desktop/Projets"), r"C:\Users\yann\Desktop\Projets");
            assert_eq!(normalize_separators(r"\\server\share\file.txt"), r"\\server\share\file.txt");
        } else {
            assert_eq!(normalize_separators("/home//yann///Desktop"), "/home/yann/Desktop");
        }
    }

    #[test]
    fn app_names_match_regardless_of_accents_and_punctuation() {
        assert_eq!(normalize("Bloc-notes"), "blocnotes");
        assert_eq!(normalize("Paramètres"), "parametres");
        assert_eq!(normalize("Visual Studio Code"), "visualstudiocode");
        if cfg!(windows) {
            assert_eq!(builtin_alias("calculatrice"), Some("calc"));
            assert_eq!(builtin_alias("Gestionnaire des tâches"), Some("taskmgr"));
            assert_eq!(builtin_alias("Zephyr Player"), None);
        }
    }

    /// The free search engines answer Iris's own HTTP client with real results (needs internet):
    /// `cargo test free_search_engines -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn free_search_engines_answer() {
        let engines = [
            ("DuckDuckGo", "https://html.duckduckgo.com/html/?q=derni%C3%A8re%20version%20Tauri&kl=fr-fr", "result__a"),
            ("Brave", "https://search.brave.com/search?q=derni%C3%A8re%20version%20Tauri&source=web", "data-type=\"web\""),
            ("Google News", "https://news.google.com/rss/search?q=Tauri&hl=fr&gl=FR&ceid=FR:fr", "<item>"),
        ];
        for (name, url, marker) in engines {
            let page = tauri::async_runtime::block_on(web_get(url.into(), Some("fr".into()))).expect(name);
            let hits = page.body.matches(marker).count();
            println!("{name}: HTTP {} · {hits} results", page.status);
            assert!(page.status < 400 && hits > 0, "{name} gave no results (HTTP {})", page.status);
        }
    }
}

/// Folders the model needs to turn "my desktop" into a real path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemContext {
    os: String,
    user: String,
    home: String,
    desktop: Option<String>,
    documents: Option<String>,
    downloads: Option<String>,
    pictures: Option<String>,
    music: Option<String>,
    videos: Option<String>,
    now_ms: u64,
}

#[tauri::command]
pub async fn os_context(app: AppHandle) -> CmdResult<SystemContext> {
    let p = app.path();
    let s = |r: tauri::Result<PathBuf>| r.ok().map(|p| p.to_string_lossy().into_owned());
    Ok(SystemContext {
        os: std::env::consts::OS.to_string(),
        user: std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(),
        home: p.home_dir().map_err(err)?.to_string_lossy().into_owned(),
        desktop: s(p.desktop_dir()),
        documents: s(p.document_dir()),
        downloads: s(p.download_dir()),
        pictures: s(p.picture_dir()),
        music: s(p.audio_dir()),
        videos: s(p.video_dir()),
        now_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
    })
}
