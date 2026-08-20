use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::header::CONTENT_TYPE;
use reqwest::Client;
use std::path::{Path, PathBuf};

use crate::ai::error::AIError;

pub(crate) struct ReferenceImage {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime_type: String,
    pub(crate) extension: &'static str,
}

fn image_mime_type_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }

    None
}

fn image_mime_type_from_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        _ => None,
    }
}

fn normalize_image_mime_type(
    bytes: &[u8],
    declared_mime_type: Option<&str>,
    path: Option<&Path>,
) -> String {
    image_mime_type_from_bytes(bytes)
        .or_else(|| {
            declared_mime_type
                .and_then(|value| value.split(';').next())
                .map(str::trim)
                .filter(|value| value.starts_with("image/"))
        })
        .or_else(|| path.and_then(image_mime_type_from_path))
        .unwrap_or("image/png")
        .to_string()
}

fn image_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

pub(crate) fn reference_image(
    bytes: Vec<u8>,
    declared_mime_type: Option<&str>,
    path: Option<&Path>,
) -> ReferenceImage {
    let mime_type = normalize_image_mime_type(&bytes, declared_mime_type, path);
    let extension = image_extension(&mime_type);
    ReferenceImage {
        bytes,
        mime_type,
        extension,
    }
}

fn decode_data_url(source: &str) -> Option<Result<(Vec<u8>, String), AIError>> {
    let (meta, payload) = source.split_once(',')?;
    if !meta.starts_with("data:") || !meta.ends_with(";base64") {
        return None;
    }

    let mime_type = meta
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| !value.is_empty())
        .unwrap_or("image/png")
        .to_string();
    Some(
        STANDARD
            .decode(payload)
            .map(|bytes| (bytes, mime_type))
            .map_err(|error| {
                AIError::InvalidRequest(format!("Invalid reference image data URL: {}", error))
            }),
    )
}

pub(crate) async fn load_reference_image(
    client: &Client,
    source: &str,
) -> Result<ReferenceImage, AIError> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(AIError::InvalidRequest(
            "Reference image source cannot be empty".to_string(),
        ));
    }

    if let Some(decoded) = decode_data_url(trimmed) {
        let (bytes, mime_type) = decoded?;
        return Ok(reference_image(bytes, Some(&mime_type), None));
    }

    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        let response = client.get(trimmed).send().await?;
        let status = response.status();
        if !status.is_success() {
            let details = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "Failed to download reference image {}: {} {}",
                trimmed, status, details
            )));
        }
        let declared_mime_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response.bytes().await?.to_vec();
        return Ok(reference_image(
            bytes,
            declared_mime_type.as_deref(),
            None,
        ));
    }

    let likely_base64 = trimmed.len() > 256
        && trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '+'
                || character == '/'
                || character == '='
        });
    if likely_base64 {
        let bytes = STANDARD.decode(trimmed).map_err(|error| {
            AIError::InvalidRequest(format!("Invalid reference image base64: {}", error))
        })?;
        return Ok(reference_image(bytes, None, None));
    }

    if trimmed.starts_with("asset://")
        || trimmed.starts_with("tauri://")
        || trimmed.starts_with("app://")
    {
        return Err(AIError::InvalidRequest(format!(
            "Unsupported reference image source: {}",
            trimmed
        )));
    }

    let raw_path = trimmed.trim_start_matches("file://");
    let decoded_path = urlencoding::decode(raw_path)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| raw_path.to_string());
    let path = PathBuf::from(decoded_path);
    let bytes = std::fs::read(&path).map_err(|error| {
        AIError::InvalidRequest(format!(
            "Unable to read reference image '{}': {}",
            path.to_string_lossy(),
            error
        ))
    })?;
    Ok(reference_image(bytes, None, Some(&path)))
}
