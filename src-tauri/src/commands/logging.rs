use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::session::SessionId;

#[derive(Deserialize)]
pub struct FrontendLogEntry {
    pub level: String,
    pub target: String,
    pub message: String,
    pub fields: Option<serde_json::Value>,
    pub ts_ms: i64,
}

#[tauri::command]
pub async fn append_frontend_log(app: AppHandle, entry: FrontendLogEntry) -> Result<(), String> {
    let session_id = app
        .state::<SessionId>()
        .0
        .clone();
    let fields = entry.fields.unwrap_or(serde_json::json!({}));
    let enriched = serde_json::json!({
        "session": session_id,
        "client_ts_ms": entry.ts_ms,
        "fields": fields,
    });

    match entry.level.as_str() {
        "debug" => tracing::debug!(target: "frontend", ns = %entry.target, data = %enriched, "{}", entry.message),
        "info"  => tracing::info!(target:  "frontend", ns = %entry.target, data = %enriched, "{}", entry.message),
        "warn"  => tracing::warn!(target:  "frontend", ns = %entry.target, data = %enriched, "{}", entry.message),
        "error" => tracing::error!(target: "frontend", ns = %entry.target, data = %enriched, "{}", entry.message),
        _ => return Err(format!("invalid level: {}", entry.level)),
    }
    Ok(())
}

#[tauri::command]
pub async fn open_log_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::resolve_log_dir().ok_or_else(|| "no log dir".to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}