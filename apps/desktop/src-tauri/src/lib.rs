mod api;
mod lifecycle;
mod settings;
mod tray;

use std::sync::Arc;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be first so a second launch never starts another desktop/gateway.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || tray::open_window(&handle));
        }))
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Claude Code Router")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .visible(false)
                .build()?;
            match settings::ConnectionSettings::from_environment().and_then(|settings| {
                api::AdminClient::new(settings.clone()).map(|client| (settings, client))
            }) {
                Ok((settings, client)) => {
                    let controller = tray::Controller::install(app.handle(), settings, client)?;
                    app.manage(Arc::clone(&controller));
                    controller.start();
                }
                Err(e) => {
                    eprintln!("Invalid CCR connection settings: {e}");
                    tray::install_offline(app.handle(), e.clone())?;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ =
                            window.set_title(&format!("CCR Desktop — configuration error: {e}"));
                        let _ = window.show();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().tray_by_id("ccr-tray").is_some() && window.hide().is_ok() {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(controller) = app.try_state::<Arc<tray::Controller>>() {
                    controller.stop();
                }
            }
        }),
        Err(e) => eprintln!("Could not start CCR Desktop: {e}"),
    }
}
