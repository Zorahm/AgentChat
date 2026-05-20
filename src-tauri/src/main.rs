// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// Windows process flag: prevent the child from opening a console window.
// Without this every Command::spawn for backend.exe / python.exe pops a black
// console alongside the Tauri webview, which scares users and steals focus.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply CREATE_NO_WINDOW on Windows. No-op on other platforms.
fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_backend_url() -> String {
    "http://127.0.0.1:8787".to_string()
}

// ---------------------------------------------------------------------------
// Backend process management
// ---------------------------------------------------------------------------

struct BackendProcess {
    child: Mutex<Option<Child>>,
}

/// Find the pre-built backend.exe sidecar (production).
fn find_sidecar_exe() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))?;
    let sidecar = exe_dir.join("backend.exe");
    if sidecar.exists() { Some(sidecar) } else { None }
}

/// Fallback: locate system Python (development mode).
fn find_python() -> Option<String> {
    for cmd in &["python", "python3"] {
        let mut probe = Command::new(cmd);
        probe.arg("--version");
        hide_console(&mut probe);
        if probe.output().is_ok() {
            return Some(cmd.to_string());
        }
    }
    None
}

/// Fallback: resolve backend source directory (development mode).
fn find_backend_dir() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        let dev_path = cwd.join("../backend");
        if dev_path.join("main.py").exists() {
            return dev_path;
        }
    }
    std::env::current_dir().unwrap_or_default().join("../backend")
}

fn spawn_sidecar(path: &PathBuf) -> Option<Child> {
    let mut cmd = Command::new(path);
    hide_console(&mut cmd);
    cmd.spawn().ok()
}

fn spawn_python_backend(backend_dir: &std::path::Path) -> Option<Child> {
    let python = find_python()?;
    let mut cmd = Command::new(&python);
    cmd.args(["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8787"])
        .current_dir(backend_dir);
    hide_console(&mut cmd);
    cmd.spawn().ok()
}

/// Block until the backend health-check responds (max ~15 s).
fn wait_for_backend() {
    let client = reqwest::blocking::Client::new();
    for _ in 0..30 {
        if backend_is_healthy(&client) {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// One-shot health probe. Used both to wait for our spawned backend and to
/// detect a leftover instance on 8787 before we try to bind a new one.
fn backend_is_healthy(client: &reqwest::blocking::Client) -> bool {
    client
        .get("http://127.0.0.1:8787/api/health")
        .timeout(Duration::from_secs(1))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    // If a previous backend (zombie sidecar or dev uvicorn) is already serving
    // 8787, reuse it instead of trying to bind a second one and crashing with
    // OSError 10048.
    let probe_client = reqwest::blocking::Client::new();
    let already_running = backend_is_healthy(&probe_client);

    let mut backend_child: Option<Child> = if already_running {
        None
    } else if let Some(sidecar) = find_sidecar_exe() {
        spawn_sidecar(&sidecar)
    } else {
        spawn_python_backend(&find_backend_dir())
    };

    if backend_child.is_some() {
        wait_for_backend();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(BackendProcess {
            child: Mutex::new(backend_child.take()),
        })
        .invoke_handler(tauri::generate_handler![get_backend_url])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
