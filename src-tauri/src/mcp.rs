//! MCP servers (Model Context Protocol) run as child processes speaking JSON-RPC over
//! stdin/stdout. The webview can't start processes, so Rust starts them and relays the lines:
//! stdout → event `mcp://message/<id>` (one JSON message per line), `mcp_send` → stdin.
//! Servers are only started from the user's own configuration (Settings), never by the model.

use std::collections::HashMap;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

struct Server {
    stdin: ChildStdin,
    child: Child,
}

#[derive(Default)]
pub struct McpState(Mutex<HashMap<String, Server>>);

fn valid_id(id: &str) -> CmdResult<()> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("invalid MCP server id \"{id}\""));
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_start(
    app: AppHandle,
    state: State<'_, McpState>,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> CmdResult<()> {
    valid_id(&id)?;
    if let Some(mut old) = state.0.lock().await.remove(&id) {
        let _ = old.child.kill().await;
    }

    // Windows: through cmd so that `npx`, `uvx`… (.cmd scripts) resolve like in a terminal.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command).args(&args);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new(&command);
        c.args(&args);
        c
    };
    if let Ok(home) = app.path().home_dir() {
        cmd.current_dir(home);
    }
    cmd.envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("could not start \"{command}\": {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let events = app.clone();
    let server = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                let _ = events.emit(&format!("mcp://message/{server}"), line);
            }
        }
        let _ = events.emit(&format!("mcp://closed/{server}"), ());
    });
    let server = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::info!("[mcp {server}] {line}");
        }
    });

    state.0.lock().await.insert(id, Server { stdin, child });
    Ok(())
}

#[tauri::command]
pub async fn mcp_send(state: State<'_, McpState>, id: String, message: String) -> CmdResult<()> {
    let mut servers = state.0.lock().await;
    let server = servers.get_mut(&id).ok_or_else(|| format!("MCP server \"{id}\" is not running"))?;
    server.stdin.write_all(message.as_bytes()).await.map_err(err)?;
    server.stdin.write_all(b"\n").await.map_err(err)?;
    server.stdin.flush().await.map_err(err)
}

#[tauri::command]
pub async fn mcp_stop(state: State<'_, McpState>, id: String) -> CmdResult<()> {
    if let Some(mut server) = state.0.lock().await.remove(&id) {
        let _ = server.child.kill().await;
    }
    Ok(())
}
