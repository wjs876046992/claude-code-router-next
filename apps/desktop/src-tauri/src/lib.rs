use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};

/// The CCR server base URL. Port must match the server's config (default 3456).
const SERVER_BASE: &str = "http://127.0.0.1:3456";
const SERVER_HEALTH: &str = "http://127.0.0.1:3456/health";
const SERVER_UI: &str = "http://127.0.0.1:3456/ui/";

/// Holds the spawned ccr server child process so we can kill it on exit.
struct ServerState {
    child: Mutex<Option<Child>>,
}

/// Check if the ccr server is already running.
async fn is_server_running() -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build();
    match client {
        Ok(c) => c
            .get(SERVER_HEALTH)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Resolve the ccr binary. GUI apps on macOS don't inherit the terminal PATH,
/// so probe the common install locations (npm global prefixes) before giving
/// up. The CCR_BIN env var overrides for custom setups.
fn resolve_ccr_bin() -> String {
    if let Ok(custom) = std::env::var("CCR_BIN") {
        if !custom.is_empty() {
            return custom;
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/ccr".to_string(),
        "/usr/local/bin/ccr".to_string(),
        format!("{home}/.npm-global/bin/ccr"),
        format!("{home}/.local/bin/ccr"),
        "ccr".to_string(), // last resort: PATH lookup
    ];
    for path in &candidates {
        if path == "ccr" {
            return path.clone();
        }
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    "ccr".to_string()
}

/// Spawn the ccr server as a sidecar (user's globally-installed ccr).
/// stdout/stderr go to null: piped-but-never-drained would fill the OS pipe
/// buffer (~64KB) and freeze the server once CCR's request logs exceed it.
fn spawn_ccr_server() -> Result<Child, String> {
    let bin = resolve_ccr_bin();
    Command::new(&bin)
        .arg("start")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn '{bin} start': {e}"))
}

/// Poll http://127.0.0.1:3456/health until it returns 200 or timeout (15s).
async fn wait_for_server() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() >= deadline {
            return Err("ccr server did not become healthy within 15s".into());
        }
        match client.get(SERVER_HEALTH).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
}

/// Kill the spawned server child, if we own one. The ccr PID file + `ccr stop`
/// remain as belt-and-braces for external launches.
fn kill_server_child(state: &ServerState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerState { child: Mutex::new(None) })
        .setup(|app| {
            // If ccr is already running, connect to it; otherwise spawn a sidecar.
            // This avoids EADDRINUSE panic when the user already started ccr.
            let already_running = tauri::async_runtime::block_on(async { is_server_running().await });
            if !already_running {
                match spawn_ccr_server() {
                    Ok(child) => {
                        let state: State<ServerState> = app.state();
                        *state.child.lock().unwrap() = Some(child);
                    }
                    Err(e) => {
                        eprintln!("Warning: could not spawn ccr server: {e}");
                        // Continue anyway — the window will show a connection error
                        // page if the server truly isn't available.
                    }
                }
            }

            // Build the main window (hidden, shown after server is ready)
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(SERVER_UI.parse().unwrap()),
            )
            .title("Claude Code Router")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .visible(false)
            .build()?;

            // Async: wait for server, then show window
            tauri::async_runtime::spawn(async move {
                match wait_for_server().await {
                    Ok(()) => {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    Err(e) => {
                        eprintln!("ccr server health check failed: {e}");
                        // Show window anyway so the user sees the error page
                        let _ = window.show();
                    }
                }
            });

            // Tray icon (minimal: just quit for now; full menu in step 2)
            let quit_item = MenuItem::with_id(app, "quit", "Quit CCR", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_item])?;

            TrayIconBuilder::with_id("ccr-tray")
                .tooltip("Claude Code Router")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Single-click toggles the main window (menu bar app convention).
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept close: hide instead of destroy so the app stays in tray
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill the spawned server child on every exit path (tray quit,
            // Cmd+Q, window close that passes the guard). Without this the
            // child would be orphaned (Tauri issue #14443 upstream).
            if let RunEvent::Exit = event {
                let state: State<ServerState> = app_handle.state();
                kill_server_child(&state);
            }
        });
}
