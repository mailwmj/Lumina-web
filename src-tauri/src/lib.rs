pub mod ai;
pub mod canvas_agent;
pub mod commands;
pub mod session;
pub mod storage;

use std::path::PathBuf;
use std::time::Duration;

use commands::ai as ai_commands;
use commands::batch_image_crop;
use commands::batch_image_composition;
use commands::image;
use commands::logging;
use commands::project_state;
use commands::system;
use commands::storage as storage_commands;
use commands::update;
use tauri::Manager;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const MAIN_WINDOW_LABEL: &str = "main";
const FRONTEND_READY_TIMEOUT_MS: u64 = 3_500;

pub(crate) fn resolve_log_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join("Library/Logs/storyboard-copilot"));
    }

    candidates.push(std::env::temp_dir().join("storyboard-copilot/logs"));

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("logs"));
    }

    for directory in candidates {
        if std::fs::create_dir_all(&directory).is_ok() {
            return Some(directory);
        }
    }

    None
}

fn setup_logging() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,lumina_lib=debug".into());

    if let Some(log_dir) = resolve_log_dir() {
        let file_appender = tracing_appender::rolling::daily(log_dir, "storyboard.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
        std::mem::forget(_guard);

        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
    }

    info!("Lumina (流光) starting...");

    if let Some(log_dir) = resolve_log_dir() {
        commands::cleanup::cleanup_old_logs(&log_dir);
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(err) = main_window.show() {
            warn!("failed to show main window: {err}");
        }
        if let Err(err) = main_window.set_focus() {
            warn!("failed to focus main window: {err}");
        }
    } else {
        warn!("main window not found while trying to reveal UI");
    }
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    info!("frontend_ready received, revealing main window");
    show_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_logging();

    tauri::Builder::default()
        .on_page_load(|window, _payload| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            info!("main page loaded, revealing main window");
            show_main_window(&window.app_handle());
        })
        .setup(|app| {
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == MAIN_WINDOW_LABEL)
                .cloned()
                .ok_or_else(|| "missing main window config".to_string())?;

            #[cfg(not(target_os = "macos"))]
            let main_window = tauri::WebviewWindowBuilder::from_config(app, &window_config)?.build()?;

            #[cfg(not(target_os = "macos"))]
            {
                if let Err(err) = main_window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }
            }

            #[cfg(target_os = "macos")]
            {
                let mut mac_window_config = window_config;
                // Window effects radius only works for transparent windows on macOS.
                mac_window_config.transparent = true;

                let window = tauri::WebviewWindowBuilder::from_config(app, &mac_window_config)?.build()?;

                if let Err(err) = window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }

                if let Err(err) = window.set_effects(Some(
                    tauri::window::EffectsBuilder::new()
                        .effect(tauri::window::Effect::Titlebar)
                        .radius(10.0)
                        .build(),
                )) {
                    warn!("failed to apply macOS window effects: {err}");
                }
            }

            let app_handle = app.handle().clone();
            let session_id = session::SessionId::new();
            info!("session_id = {}", session_id.0);
            app.manage(session_id);
            let canvas_agent_manager = canvas_agent::CanvasAgentManager::new(app.handle());
            if let Some(error) = canvas_agent_manager.startup_error() {
                warn!("Canvas Agent unavailable: {error}");
            }
            app.manage(canvas_agent_manager);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(FRONTEND_READY_TIMEOUT_MS)).await;

                let is_main_visible = app_handle
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);

                if !is_main_visible {
                    warn!(
                        "frontend_ready timeout after {}ms, forcing main window reveal",
                        FRONTEND_READY_TIMEOUT_MS
                    );
                    show_main_window(&app_handle);
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            canvas_agent::get_canvas_agent_runtime,
            image::split_image,
            image::split_image_source,
            image::prepare_node_image_source,
            image::prepare_node_image_binary,
            image::create_image_preview,
            image::crop_image_source,
            image::merge_storyboard_images,
            image::read_storyboard_image_metadata,
            image::embed_storyboard_image_metadata,
            image::load_image,
            image::persist_image_source,
            image::persist_image_binary,
            image::save_image_source_to_downloads,
            image::save_image_source_to_path,
            image::save_video_source_to_path,
            image::save_image_source_to_directory,
            image::save_image_source_to_app_debug_dir,
            image::copy_image_source_to_clipboard,
            image::upload_image_to_volc_vod,
            image::upload_media_to_public_url,
            storage_commands::upload_media_to_tos,
            commands::media::persist_media_bytes_to_project,
            commands::media::convert_video_to_mp4,
            commands::media::convert_audio_to_mp3,
            image::convert_image_to_data_url,
            image::auto_save_video_to_project,
            image::auto_save_image_to_project,
            image::delete_project_upload_file,
            batch_image_crop::prepare_batch_crop_image,
            batch_image_crop::suggest_batch_crop,
            batch_image_crop::export_batch_crop_image,
            batch_image_crop::cleanup_batch_crop_cache,
            batch_image_composition::render_batch_fixed_canvas,
            batch_image_composition::export_batch_fixed_canvas,
            ai_commands::set_api_key,
            ai_commands::discover_image_models,
            ai_commands::discover_text_models,
            ai_commands::submit_generate_image_job,
            ai_commands::get_generate_image_job,
            ai_commands::retry_generate_image_job,
            ai_commands::cancel_video_generation_task,
            ai_commands::generate_image,
            ai_commands::list_models,
            ai_commands::polish_text,
            ai_commands::generate_text,
            ai_commands::test_text_api,
            project_state::list_project_summaries,
            project_state::get_project_record,
            project_state::upsert_project_record,
            project_state::update_project_viewport_record,
            project_state::rename_project_record,
            project_state::delete_project_record,
            project_state::create_project_dirs,
            system::get_runtime_system_info,
            update::check_latest_release_tag,
            logging::append_frontend_log,
            logging::open_log_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
