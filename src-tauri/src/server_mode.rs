//! Server mode — the desktop shell running as a thin client.
//!
//! When the user points the app at a backend elsewhere (a VDS, another PC), the
//! shell must not spawn its bundled sidecar: it would squat on 8787, burn a few
//! hundred MB, and serve a working directory nobody is looking at.
//!
//! That decision happens *before* the webview exists, so localStorage — where
//! the frontend keeps the backend URL — is unreadable at the time it is needed.
//! Hence this small file in the app config dir, written by the frontend through
//! `set_server_mode` and read back at startup.
//!
//! `resolve_path` is the only place the file's location is computed. The read
//! path and the write path both go through it, so a change to one can't silently
//! leave the other looking somewhere else.

use std::path::PathBuf;

const FILE_NAME: &str = "server-mode.json";

#[cfg(windows)]
fn config_root() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn config_root() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn config_root() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
}

/// Where the flag lives, under the app's own config directory.
fn resolve_path(identifier: &str) -> Option<PathBuf> {
    Some(config_root()?.join(identifier).join(FILE_NAME))
}

/// True when the user has pointed this client at a backend elsewhere.
///
/// Every failure — no config dir, no file, unparsable contents — answers
/// `false`. Guessing "server mode" from a broken file would leave the user with
/// no backend at all and no obvious way to tell why.
pub fn is_enabled(identifier: &str) -> bool {
    let Some(path) = resolve_path(identifier) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| value.get("enabled").and_then(|flag| flag.as_bool()))
        .unwrap_or(false)
}

/// Record whether this client talks to a remote backend. Called by the frontend
/// whenever the setting changes, and once at startup to re-assert it.
#[tauri::command]
pub fn set_server_mode(app: tauri::AppHandle, enabled: bool, url: String) -> Result<(), String> {
    let path = resolve_path(&app.config().identifier)
        .ok_or_else(|| "no config directory available".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // `url` is stored for diagnostics only — the frontend reads its own copy
    // from localStorage; only `enabled` is ever acted on here.
    let body = serde_json::json!({ "enabled": enabled, "url": url });
    std::fs::write(&path, body.to_string()).map_err(|e| e.to_string())
}
