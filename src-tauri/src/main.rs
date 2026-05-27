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
// Without this every Command::spawn for agentchat-backend.exe / python.exe pops
// a black console alongside the Tauri webview, which scares users and steals focus.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Image name of the bundled backend sidecar. Kept unique (not a generic
/// "backend.exe") so taskkill / installer hooks only ever hit our own process.
const SIDECAR_EXE: &str = "agentchat-backend.exe";

/// Apply CREATE_NO_WINDOW on Windows. No-op on other platforms.
fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Force-kill every sidecar process by image name, including child trees.
/// PyInstaller --onefile spawns the real interpreter as a child of the
/// bootloader, so a plain kill of the handle we hold would orphan it.
#[cfg(windows)]
fn kill_sidecar_by_image() {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/T", "/IM", SIDECAR_EXE]);
    hide_console(&mut cmd);
    let _ = cmd.output();
}

/// Force-kill a single process tree by PID (parent + children).
#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
    hide_console(&mut cmd);
    let _ = cmd.output();
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_backend_url() -> String {
    "http://127.0.0.1:8787".to_string()
}

/// Restart the backend so a changed bind host (remote-access toggle) takes
/// effect. run.py re-reads settings.json on start and re-picks 127.0.0.1 vs
/// 0.0.0.0. Loopback-only concern, invoked from Settings.
#[tauri::command]
fn restart_backend(state: tauri::State<'_, BackendProcess>) -> Result<(), String> {
    // Stop the tracked child (and its tree).
    if let Ok(mut guard) = state.child.lock() {
        if let Some(ref mut child) = *guard {
            #[cfg(windows)]
            kill_process_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    // Catch any stray sidecar still holding the port before we rebind.
    #[cfg(windows)]
    kill_sidecar_by_image();

    let child = start_backend().ok_or_else(|| "failed to spawn backend".to_string())?;
    wait_for_backend();
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Backend process management
// ---------------------------------------------------------------------------

struct BackendProcess {
    child: Mutex<Option<Child>>,
}

/// Find the pre-built sidecar (production).
fn find_sidecar_exe() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))?;
    let sidecar = exe_dir.join(SIDECAR_EXE);
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

/// Spawn the backend: bundled sidecar in production, dev python as fallback.
fn start_backend() -> Option<Child> {
    if let Some(sidecar) = find_sidecar_exe() {
        spawn_sidecar(&sidecar)
    } else {
        spawn_python_backend(&find_backend_dir())
    }
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
    // A previous session can leave an orphaned sidecar alive (crash, force-kill,
    // or an old version still serving 8787 after an update). Kill any leftover
    // by our unique image name first, so we always run the freshly-bundled
    // backend and never keep its .exe locked for the next installer. This only
    // matches our own process; a hand-run dev uvicorn (python.exe) is untouched.
    #[cfg(windows)]
    kill_sidecar_by_image();

    // If a backend (e.g. a dev uvicorn started by hand) is already serving 8787,
    // reuse it instead of trying to bind a second one and crashing with
    // OSError 10048.
    let probe_client = reqwest::blocking::Client::new();
    let already_running = backend_is_healthy(&probe_client);

    let mut backend_child: Option<Child> = if already_running {
        None
    } else {
        start_backend()
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
        .invoke_handler(tauri::generate_handler![get_backend_url, restart_backend])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(ref mut child) = *guard {
                            // Tear down the whole tree first: child.kill() only
                            // reaps the PyInstaller bootloader and would orphan the
                            // interpreter it spawned, leaking a backend on 8787.
                            #[cfg(windows)]
                            kill_process_tree(child.id());
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
