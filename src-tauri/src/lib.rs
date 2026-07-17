//! Tauri shell entry point, shared by desktop (src/main.rs) and mobile
//! (the platform's generated native entry point, which calls `run()`).
//!
//! Desktop spawns and supervises the bundled Python backend sidecar (see
//! `desktop_backend`); mobile (Android/iOS) ships WITHOUT a backend — it's a
//! thin client that talks to a remote backend whose URL + token the user enters
//! in-app. So everything sidecar-related is `#[cfg(desktop)]`.

#[cfg(desktop)]
mod desktop_backend;

/// The local desktop backend URL. Mobile ignores this (it uses the in-app
/// configured remote backend), but the command stays registered on both so the
/// shared frontend can call it unconditionally.
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

/// Save bytes to a location the user picks in the native save dialog, and
/// return that path (`None` when they cancel).
///
/// The write goes through `std::fs` rather than plugin-fs on purpose: the fs
/// scope is deliberately narrowed to the Downloads folder (see the
/// `desktop-downloads` capability), and a "save anywhere" picker would
/// otherwise force that scope wide open. Doing it in Rust keeps the dialog the
/// only thing that decides where a file may land. Async so the blocking dialog
/// never runs on the main thread.
#[cfg(desktop)]
#[tauri::command]
async fn save_file_as(
    app: tauri::AppHandle,
    filename: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let Some(picked) = app.dialog().file().set_file_name(&filename).blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK on many Linux setups (Nvidia drivers, some Wayland/VM/compositor
    // combos) paints the webview as a blank WHITE SCREEN because of its DMA-BUF
    // renderer. Disabling it forces a path that actually composits, which is the
    // standard Tauri-v2-on-Linux white-screen fix. Must be set before the webview
    // is created, so it goes first. Linux-only: macOS uses WKWebView and Windows
    // uses WebView2, neither of which reads this. Respect an explicit override so
    // a user can re-enable it (set the var to "0") if their GPU is fine.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    // Generate the Tauri context once so we can read our own version *before*
    // the builder consumes it, then hand the same context to .build().
    let ctx = tauri::generate_context!();

    // Desktop: decide which backend serves 8787 and own the child if we spawned
    // one. Mobile has no local backend.
    #[cfg(desktop)]
    let backend_child = {
        let expected_version = ctx.package_info().version.to_string();
        desktop_backend::start_managed_backend(&expected_version)
    };

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init());

    // Process control + auto-updater are desktop-only concerns; on mobile the OS
    // owns the app lifecycle and updates come from the store / sideload.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_dialog::init())
            .manage(desktop_backend::BackendProcess::new(backend_child))
            .invoke_handler(tauri::generate_handler![
                get_backend_url,
                desktop_backend::restart_backend,
                open_external,
                save_file_as
            ]);
    }
    #[cfg(not(desktop))]
    {
        builder = builder
            .plugin(tauri_plugin_barcode_scanner::init())
            .invoke_handler(tauri::generate_handler![get_backend_url, open_external]);
    }

    builder
        .build(ctx)
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            #[cfg(desktop)]
            desktop_backend::on_run_event(_app_handle, &_event);
        });
}
