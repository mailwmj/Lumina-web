use serde::Serialize;

use crate::storage::{source::resolve_media_source, tos};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUploadResponse {
    pub key: String,
    pub url: String,
    pub expires_at: i64,
    pub content_type: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn upload_media_to_tos(
    source: String,
    project_id: Option<String>,
) -> Result<MediaUploadResponse, String> {
    let media = resolve_media_source(&source).await?;
    let result = tos::upload_media(media, project_id.as_deref()).await?;
    Ok(MediaUploadResponse {
        key: result.key,
        url: result.url,
        expires_at: result.expires_at,
        content_type: result.content_type,
        size_bytes: result.size_bytes,
    })
}
