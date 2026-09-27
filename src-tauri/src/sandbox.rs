//! Flatpak: Iris runs in a sandbox that holds only her own files and libraries. The programs she
//! starts for the user — apps, shell commands and skills, volume tools, MCP servers — belong to
//! the user's system, so inside Flatpak they are started there, through `flatpak-spawn --host`
//! (the manifest grants `--talk-name=org.freedesktop.Flatpak` for this). Everywhere else these
//! helpers are plain `Command::new`.

use std::{collections::HashMap, ffi::OsStr, path::Path};

/// Iris runs inside a Flatpak sandbox.
pub fn in_flatpak() -> bool {
    cfg!(target_os = "linux") && Path::new("/.flatpak-info").exists()
}

/// Arguments that make `flatpak-spawn` run `program` on the host, with these environment
/// variables and working folder (the sandbox's own are not passed through).
#[cfg_attr(windows, allow(dead_code))]
fn host_args(program: &OsStr, env: &HashMap<String, String>, dir: Option<&Path>) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["--host".into()];
    if let Some(dir) = dir {
        let mut arg = std::ffi::OsString::from("--directory=");
        arg.push(dir);
        args.push(arg);
    }
    for (key, value) in env {
        args.push(format!("--env={key}={value}").into());
    }
    args.push(program.to_os_string());
    args
}

/// A program of the user's system (see the module notes).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn command(program: impl AsRef<OsStr>) -> std::process::Command {
    let program = program.as_ref();
    if in_flatpak() {
        let mut c = std::process::Command::new("flatpak-spawn");
        c.args(host_args(program, &HashMap::new(), None));
        c
    } else {
        std::process::Command::new(program)
    }
}

/// The same, as a Tokio process, with environment variables and a working folder that reach
/// the program itself.
#[cfg_attr(windows, allow(dead_code))]
pub fn tokio_command(program: impl AsRef<OsStr>, env: &HashMap<String, String>, dir: Option<&Path>) -> tokio::process::Command {
    let program = program.as_ref();
    if in_flatpak() {
        let mut c = tokio::process::Command::new("flatpak-spawn");
        c.args(host_args(program, env, dir));
        c
    } else {
        let mut c = tokio::process::Command::new(program);
        c.envs(env);
        if let Some(dir) = dir {
            c.current_dir(dir);
        }
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_args_put_options_before_the_program() {
        let env = HashMap::from([("IRIS_CITY".to_string(), "Paris".to_string())]);
        let args = host_args(OsStr::new("sh"), &env, Some(Path::new("/home/me")));
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["--host", "--directory=/home/me", "--env=IRIS_CITY=Paris", "sh"]);
    }
}
