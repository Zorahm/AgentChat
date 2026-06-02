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

/// File/process name of the bundled backend sidecar. Kept unique (not a generic
/// "backend.exe") so taskkill / pkill / installer hooks only ever hit our own
/// process. ``.exe`` on Windows; bare name on Linux/macOS.
#[cfg(windows)]
const SIDECAR_EXE: &str = "agentchat-backend.exe";
#[cfg(not(windows))]
const SIDECAR_EXE: &str = "agentchat-backend";

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

/// Force-kill whatever process tree is LISTENING on `port`. Unlike
/// kill_sidecar_by_image (which only matches our current image name), this also
/// clears a *legacy* sidecar: older versions ran a generically-named
/// `backend.exe` that taskkill-by-image never hits. Windows-only.
#[cfg(windows)]
fn kill_port_owner(port: u16) {
    let mut cmd = Command::new("netstat");
    cmd.args(["-ano", "-p", "TCP"]);
    hide_console(&mut cmd);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(_) => return,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!(":{}", port);
    for line in text.lines() {
        // Listening rows carry the port only in the local-address column and a
        // remote address of 0.0.0.0:0, so a state check avoids false matches.
        if !line.to_uppercase().contains("LISTENING") || !line.contains(&needle) {
            continue;
        }
        if let Some(pid) = line.split_whitespace().last().and_then(|s| s.parse::<u32>().ok()) {
            kill_process_tree(pid);
        }
    }
}

// --- POSIX (Linux/macOS) equivalents -------------------------------------
// The sidecar is spawned as its own process-group leader (see spawn_sidecar),
// so killing the negative PID reaps the PyInstaller bootloader together with the
// interpreter it forks — the same orphan-avoidance the Windows /T flag gives us.

/// Force-kill every sidecar process by name (parent + children).
#[cfg(not(windows))]
fn kill_sidecar_by_image() {
    // -KILL by exact process name. psmisc's pkill is present on essentially
    // every desktop Linux; best-effort if it isn't.
    let _ = Command::new("pkill").args(["-KILL", "-x", SIDECAR_EXE]).output();
}

/// Force-kill a process group by its leader PID.
#[cfg(not(windows))]
fn kill_process_tree(pid: u32) {
    // Negative target = process group. The sidecar leads its own group, so this
    // takes down the PyInstaller child interpreter too.
    let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).output();
}

/// Force-kill whatever owns `port` (best-effort). Mirrors the Windows netstat
/// path; `fuser` clears a stray sidecar still holding the socket.
#[cfg(not(windows))]
fn kill_port_owner(port: u16) {
    let _ = Command::new("fuser")
        .args(["-k", &format!("{port}/tcp")])
        .output();
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_backend_url() -> String {
    "http://127.0.0.1:8787".to_string()
}

/// Open a URL in the user's real browser instead of navigating the app
/// webview. The frontend intercepts every external link click and routes it
/// here so users never get stranded inside the app with no back button.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// Restart the backend so a changed bind host (remote-access toggle) takes
/// effect. run.py re-reads settings.json on start and re-picks 127.0.0.1 vs
/// 0.0.0.0. Loopback-only concern, invoked from Settings.
#[tauri::command]
fn restart_backend(state: tauri::State<'_, BackendProcess>) -> Result<(), String> {
    // Stop the tracked child (and its tree).
    if let Ok(mut guard) = state.child.lock() {
        if let Some(ref mut child) = *guard {
            kill_process_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    // Catch any stray sidecar still holding the port before we rebind —
    // by image name, then by whoever owns 8787 (covers a legacy backend.exe).
    kill_sidecar_by_image();
    kill_port_owner(8787);

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
    // On Unix, lead a new process group so kill_process_tree(-pid) reaps the
    // PyInstaller bootloader and the interpreter it forks in one shot.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
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

/// Version the backend on 8787 reports via /api/health, if any. Lets us tell
/// our freshly-bundled backend apart from a leftover sidecar of a previous
/// version. Returns None when nothing answers, the route 404s, or the response
/// carries no `version` (a backend predating that field).
fn running_backend_version(client: &reqwest::blocking::Client) -> Option<String> {
    let resp = client
        .get("http://127.0.0.1:8787/api/health")
        .timeout(Duration::from_secs(1))
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    json.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    // Generate the Tauri context once so we can read our own version *before*
    // the builder consumes it, then hand the same context to .build().
    let ctx = tauri::generate_context!();
    let expected_version = ctx.package_info().version.to_string();

    let probe_client = reqwest::blocking::Client::new();

    // Decide which backend serves 8787.
    //
    // Dev (debug build): reuse a hand-run uvicorn if one is already healthy, so
    // a developer's own backend is never killed; otherwise spawn.
    //
    // Release build: insist on a backend reporting OUR version. A leftover
    // sidecar from a previous version keeps serving 8787 after an update (the
    // new sidecar can't bind a second time, and an older generically-named
    // `backend.exe` slips past taskkill-by-image), so the new UI would talk to
    // a stale backend missing newer settings fields. Force-clear the port and
    // run the freshly-bundled backend instead.
    let mut backend_child: Option<Child> = if cfg!(debug_assertions) {
        if backend_is_healthy(&probe_client) {
            None
        } else {
            start_backend()
        }
    } else {
        match find_sidecar_exe() {
            Some(sidecar) => {
                let running = running_backend_version(&probe_client);
                if running.as_deref() == Some(expected_version.as_str()) {
                    None // our backend is already up — reuse it
                } else {
                    kill_sidecar_by_image();
                    kill_port_owner(8787);
                    spawn_sidecar(&sidecar)
                }
            }
            // No bundled sidecar next to the exe (unusual for a release) — fall
            // back to reuse-or-python rather than leaving 8787 empty.
            None => {
                if backend_is_healthy(&probe_client) {
                    None
                } else {
                    spawn_python_backend(&find_backend_dir())
                }
            }
        }
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
        .invoke_handler(tauri::generate_handler![get_backend_url, restart_backend, open_external])
        .build(ctx)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(ref mut child) = *guard {
                            // Tear down the whole tree first: child.kill() only
                            // reaps the PyInstaller bootloader and would orphan the
                            // interpreter it spawned, leaking a backend on 8787.
                            kill_process_tree(child.id());
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
