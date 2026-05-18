// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

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
/// Located next to the main executable after Tauri bundles it.
fn find_sidecar_exe() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))?;
    let sidecar = exe_dir.join("backend.exe");
    if sidecar.exists() {
        Some(sidecar)
    } else {
        None
    }
}

/// Fallback: locate system Python (development mode).
fn find_python() -> Option<String> {
    for cmd in &["python", "python3"] {
        if Command::new(cmd).arg("--version").output().is_ok() {
            return Some(cmd.to_string());
        }
    }
    None
}

/// Fallback: resolve backend source directory (development mode).
fn find_backend_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();

    if let Ok(cwd) = std::env::current_dir() {
        let dev_path = cwd.join("../backend");
        if dev_path.join("main.py").exists() {
            return dev_path;
        }
    }

    let prod_path = exe_dir.join("backend");
    if prod_path.join("main.py").exists() {
        return prod_path;
    }

    std::env::current_dir()
        .unwrap_or_default()
        .join("../backend")
}

/// Spawn the bundled backend.exe sidecar.
fn spawn_sidecar(path: &PathBuf) -> Option<Child> {
    Command::new(path).spawn().ok()
}

/// Dev fallback: spawn python -m uvicorn.
fn spawn_python_backend(backend_dir: &std::path::Path) -> Option<Child> {
    let python = find_python()?;
    Command::new(&python)
        .args(["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8787"])
        .current_dir(backend_dir)
        .spawn()
        .ok()
}

/// Block until the backend health-check responds (max ~15 s).
fn wait_for_backend() {
    let client = reqwest::blocking::Client::new();
    for _ in 0..30 {
        if client
            .get("http://127.0.0.1:8787/api/health")
            .timeout(Duration::from_secs(2))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    // Try sidecar first (production), fall back to dev python
    let mut backend_child: Option<Child> = if let Some(sidecar) = find_sidecar_exe() {
        spawn_sidecar(&sidecar)
    } else {
        spawn_python_backend(&find_backend_dir())
    };

    if backend_child.is_some() {
        wait_for_backend();
    }

    tauri::Builder::default()
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
