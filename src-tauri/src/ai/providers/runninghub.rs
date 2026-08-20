use base64::{engine::general_purpose::STANDARD, Engine};
use image::GenericImageView;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;
use uuid::Uuid;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

const RUNNINGHUB_BASE_URL: &str = "https://www.runninghub.cn/openapi/v2";
const UPLOAD_ENDPOINT: &str = "/media/upload/binary";
const POLL_INTERVAL_MS: u64 = 3000;
const UPLOAD_MAX_RETRIES: u32 = 3;
const UPLOAD_RETRY_DELAY_MS: u64 = 2000;
/// Max longest side in pixels when resizing images for RunningHub.
const RESIZE_MAX_DIMENSION: u32 = 2048;
/// JPEG quality for resized images (0-100).
const JPEG_QUALITY: u8 = 90;
/// If the final encoded image is under this size, inline as Base64 Data URI.
const INLINE_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct RunningHubSubmitResponse {
    taskId: String,
    #[allow(dead_code)]
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    errorCode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    errorMessage: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct RunningHubQueryResponse {
    #[allow(dead_code)]
    taskId: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    errorCode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    errorMessage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    results: Option<Vec<RunningHubResultItem>>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct RunningHubResultItem {
    url: String,
    #[allow(dead_code)]
    nodeId: Option<String>,
    #[allow(dead_code)]
    outputType: Option<String>,
    #[allow(dead_code)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RunningHubUploadResponse {
    code: i64,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    message: String,
    data: Option<RunningHubUploadData>,
}

#[derive(Debug, Deserialize)]
struct RunningHubUploadData {
    #[serde(rename = "download_url")]
    download_url: String,
}

pub struct RunningHubProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl RunningHubProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
        }
    }

    fn sanitize_model(model: &str) -> String {
        model
            .split_once('/')
            .map(|(_, bare)| bare.to_string())
            .unwrap_or_else(|| model.to_string())
    }

    fn resolve_endpoint(&self, model: &str) -> String {
        let sanitized = Self::sanitize_model(model);
        // V1 API 端点为 /edit（/image-to-image 返回 1001 Invalid URL）
        // G31 Flash API 端点为 /image-to-image
        let endpoint = if sanitized == "rhart-image-v1" {
            "edit"
        } else {
            "image-to-image"
        };
        format!("{}/{}/{}", RUNNINGHUB_BASE_URL, sanitized, endpoint)
    }

    fn decode_file_url_path(value: &str) -> String {
        let raw = value.trim_start_matches("file://");
        let decoded = urlencoding::decode(raw)
            .map(|result| result.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        let normalized = if decoded.starts_with('/')
            && decoded.len() > 2
            && decoded.as_bytes().get(2) == Some(&b':')
        {
            &decoded[1..]
        } else {
            &decoded
        };
        normalized.to_string()
    }

    fn source_to_bytes(source: &str) -> Result<Vec<u8>, String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("source is empty".to_string());
        }

        if let Some((meta, payload)) = trimmed.split_once(',') {
            if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
                return STANDARD
                    .decode(payload)
                    .map_err(|err| format!("invalid data-url base64 payload: {}", err));
            }
        }

        let likely_base64 = trimmed.len() > 256
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
        if likely_base64 {
            return STANDARD
                .decode(trimmed)
                .map_err(|err| format!("invalid base64 payload: {}", err));
        }

        if trimmed.starts_with("asset://")
            || trimmed.starts_with("tauri://")
            || trimmed.starts_with("app://")
        {
            return Err(format!("unsupported local protocol source: {}", trimmed));
        }

        let path = if trimmed.starts_with("file://") {
            PathBuf::from(Self::decode_file_url_path(trimmed))
        } else {
            PathBuf::from(trimmed)
        };

        // 检查文件是否存在
        if !path.exists() {
            let parent = path.parent();
            let parent_exists = parent.map(|p| p.exists()).unwrap_or(false);
            let parent_readable = parent_exists && std::fs::read_dir(parent.unwrap()).is_ok();

            return Err(format!(
                "file not found: \"{}\"; parent_exists={}, parent_readable={}",
                path.to_string_lossy(),
                parent_exists,
                parent_readable
            ));
        }

        std::fs::read(&path).map_err(|err| {
            format!(
                "failed to read path \"{}\": {}",
                path.to_string_lossy(),
                err
            )
        })
    }

    /// Decode raw image bytes, resize if needed, and re-encode as JPEG.
    /// Returns (encoded_bytes, mime_type). Images exceeding RESIZE_MAX_DIMENSION
    /// on the longest side are scaled down; all images are re-encoded as JPEG
    /// to ensure reasonable payload size for the RunningHub API.
    fn resize_and_encode(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
        let img = image::load_from_memory(bytes)
            .map_err(|e| format!("failed to decode image: {}", e))?;

        let (w, h) = img.dimensions();
        let max_dim = w.max(h);

        let resized = if max_dim > RESIZE_MAX_DIMENSION {
            let scale = RESIZE_MAX_DIMENSION as f64 / max_dim as f64;
            let nw = (w as f64 * scale).round() as u32;
            let nh = (h as f64 * scale).round() as u32;
            info!(
                "[RunningHub] Resizing image from {}x{} to {}x{}",
                w, h, nw, nh
            );
            img.resize(nw, nh, image::imageops::FilterType::Triangle)
        } else {
            img
        };

        let mut buf = Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
        resized
            .write_with_encoder(encoder)
            .map_err(|e| format!("failed to encode JPEG: {}", e))?;

        Ok((buf.into_inner(), "image/jpeg"))
    }

    /// Prepare a reference image for RunningHub: resize, encode, then either
    /// inline as Base64 Data URI (small) or upload via multipart (large).
    async fn prepare_reference_image(
        &self,
        api_key: &str,
        source: &str,
        index: usize,
    ) -> Result<String, AIError> {
        if source.starts_with("http://") || source.starts_with("https://") {
            return Ok(source.to_string());
        }

        let raw_bytes = Self::source_to_bytes(source).map_err(|err| {
            // 提供更友好的错误提示
            let hint = if err.contains("file not found") {
                "请确保图片已正确上传到项目中。如果图片是从旧项目恢复的，请重新上传。"
            } else {
                ""
            };
            let full_err = if hint.is_empty() {
                format!(
                    "Failed to read reference image {} for RunningHub: {}; source={}",
                    index,
                    err,
                    &source[..source.len().min(100)]
                )
            } else {
                format!(
                    "Failed to read reference image {} for RunningHub: {}. {}\n\nSource path: {}",
                    index,
                    err,
                    hint,
                    &source[..source.len().min(100)]
                )
            };
            AIError::InvalidRequest(full_err)
        })?;

        let (encoded_bytes, mime) = Self::resize_and_encode(&raw_bytes).map_err(|err| {
            AIError::InvalidRequest(format!(
                "Failed to resize reference image {} for RunningHub: {}",
                index, err
            ))
        })?;

        info!(
            "[RunningHub] Image {} prepared: {} -> {} bytes ({})",
            index,
            raw_bytes.len(),
            encoded_bytes.len(),
            mime
        );

        // Small enough to inline
        if encoded_bytes.len() <= INLINE_MAX_BYTES {
            info!(
                "[RunningHub] Image {} inline as Base64 Data URI ({} bytes)",
                index,
                encoded_bytes.len()
            );
            return Ok(format!(
                "data:{};base64,{}",
                mime,
                STANDARD.encode(&encoded_bytes)
            ));
        }

        // Large: upload via multipart with retry
        let file_name = format!("ref-{}-{}.jpg", index + 1, Uuid::new_v4());
        let endpoint = format!("{}{}", RUNNINGHUB_BASE_URL, UPLOAD_ENDPOINT);

        for attempt in 1..=UPLOAD_MAX_RETRIES {
            info!(
                "[RunningHub] Uploading image {} ({} bytes, attempt {}/{})",
                index,
                encoded_bytes.len(),
                attempt,
                UPLOAD_MAX_RETRIES
            );

            let file_part = Part::bytes(encoded_bytes.clone())
                .file_name(file_name.clone())
                .mime_str(mime)?;
            let form = Form::new().part("file", file_part);

            let response = self
                .client
                .post(&endpoint)
                .header("Authorization", format!("Bearer {}", api_key))
                .multipart(form)
                .send()
                .await;

            match response {
                Ok(resp) => {
                    let status = resp.status();
                    let raw_response = resp.text().await.unwrap_or_default();

                    if !status.is_success() {
                        if status.as_u16() >= 500 {
                            info!(
                                "[RunningHub] Upload attempt {} server error {}, retrying...",
                                attempt, status
                            );
                            if attempt < UPLOAD_MAX_RETRIES {
                                sleep(Duration::from_millis(UPLOAD_RETRY_DELAY_MS)).await;
                            }
                            continue;
                        }
                        return Err(AIError::Provider(format!(
                            "RunningHub upload failed {}: {}",
                            status, raw_response
                        )));
                    }

                    let body: RunningHubUploadResponse =
                        serde_json::from_str(&raw_response).map_err(|err| {
                            AIError::Provider(format!(
                                "RunningHub upload invalid JSON: {}; raw={}",
                                err, raw_response
                            ))
                        })?;

                    if body.code != 0 {
                        let err_msg = if !body.message.is_empty() {
                            &body.message
                        } else {
                            &body.msg
                        };
                        return Err(AIError::Provider(format!(
                            "RunningHub upload rejected (code {}): {}",
                            body.code, err_msg
                        )));
                    }

                    let download_url = body
                        .data
                        .map(|d| d.download_url)
                        .filter(|u| !u.trim().is_empty())
                        .ok_or_else(|| {
                            AIError::Provider(format!(
                                "RunningHub upload missing download_url, raw: {}",
                                raw_response
                            ))
                        })?;

                    let resolved_url =
                        if download_url.starts_with("http://") || download_url.starts_with("https://")
                        {
                            download_url
                        } else {
                            format!(
                                "https://www.runninghub.cn/{}",
                                download_url.trim_start_matches('/')
                            )
                        };

                    info!(
                        "[RunningHub] Uploaded image {} -> {}",
                        index,
                        &resolved_url[..resolved_url.len().min(80)]
                    );
                    return Ok(resolved_url);
                }
                Err(err) => {
                    info!(
                        "[RunningHub] Upload attempt {} network error: {}, retrying...",
                        attempt, err
                    );
                    if attempt < UPLOAD_MAX_RETRIES {
                        sleep(Duration::from_millis(UPLOAD_RETRY_DELAY_MS)).await;
                    }
                }
            }
        }

        // All retries exhausted — fall back to inline Base64 even if large
        info!(
            "[RunningHub] Upload failed after {} retries for image {}, falling back to Base64 ({} bytes)",
            UPLOAD_MAX_RETRIES, index, encoded_bytes.len()
        );
        Ok(format!(
            "data:{};base64,{}",
            mime,
            STANDARD.encode(&encoded_bytes)
        ))
    }

    async fn upload_reference_images(
        &self,
        api_key: &str,
        reference_images: &[String],
    ) -> Result<Vec<String>, AIError> {
        let mut urls = Vec::with_capacity(reference_images.len());
        for (index, source) in reference_images.iter().enumerate() {
            urls.push(self.prepare_reference_image(api_key, source, index).await?);
        }
        Ok(urls)
    }
}

impl Default for RunningHubProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for RunningHubProvider {
    fn name(&self) -> &str {
        "runninghub"
    }

    fn supports_model(&self, model: &str) -> bool {
        matches!(
            Self::sanitize_model(model).as_str(),
            "rhart-image-v1" | "rhart-image-n-g31-flash"
        )
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "runninghub/rhart-image-v1".to_string(),
            "runninghub/rhart-image-n-g31-flash".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn submit_task(&self, request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        let endpoint = self.resolve_endpoint(&request.model);

        let mut image_urls: Option<Vec<String>> = None;
        if let Some(ref_images) = request.reference_images.as_ref() {
            if !ref_images.is_empty() {
                let uploaded = self.upload_reference_images(&api_key, ref_images).await?;
                image_urls = Some(uploaded);
            }
        }

        let sanitized = Self::sanitize_model(&request.model);
        let is_v1 = sanitized == "rhart-image-v1";

        let mut body_map = serde_json::Map::new();
        body_map.insert("prompt".to_string(), serde_json::json!(request.prompt));

        // V1 支持 "auto" aspectRatio；G31 Flash 不支持 "auto"，此时省略该字段（API 标记为可选）
        if !request.aspect_ratio.is_empty() && request.aspect_ratio != "auto" {
            body_map.insert("aspectRatio".to_string(), serde_json::json!(request.aspect_ratio));
        } else if is_v1 && request.aspect_ratio == "auto" {
            body_map.insert("aspectRatio".to_string(), serde_json::json!("auto"));
        }

        // G31 Flash resolution 值需小写（API 要求 1k/2k/4k，前端传 1K/2K/4K）；V1 不需要 resolution
        if !request.size.is_empty() && !is_v1 {
            body_map.insert("resolution".to_string(), serde_json::json!(request.size.to_lowercase()));
        }

        // V1 /edit 和 G31 Flash /image-to-image 都要求 imageUrls 字段
        body_map.insert("imageUrls".to_string(), serde_json::json!(image_urls.unwrap_or_default()));
        let body = serde_json::Value::Object(body_map);

        info!(
            "[RunningHub Request] endpoint: {}, model: {}, body: {}",
            endpoint, request.model, body
        );

        let submit_response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !submit_response.status().is_success() {
            let status = submit_response.status();
            let error_text = submit_response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "RunningHub submit failed {}: {}",
                status, error_text
            )));
        }

        let submit_raw = submit_response.text().await.unwrap_or_default();
        let submit_body: RunningHubSubmitResponse =
            serde_json::from_str(&submit_raw).map_err(|err| {
                AIError::Provider(format!(
                    "RunningHub submit invalid JSON: {}; raw={}",
                    err, submit_raw
                ))
            })?;

        if let Some(error_code) = submit_body.errorCode.as_ref() {
            if !error_code.is_empty() {
                let error_msg = submit_body.errorMessage.clone().unwrap_or_default();
                return Err(AIError::Provider(format!(
                    "RunningHub submit error {}: {}; raw_response={}",
                    error_code, error_msg, submit_raw
                )));
            }
        }

        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id: submit_body.taskId,
            metadata: None,
        }))
    }

    async fn poll_task(&self, handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        let query_endpoint = format!("{}/query", RUNNINGHUB_BASE_URL);
        let query_body = json!({ "taskId": handle.task_id });

        let query_response = self
            .client
            .post(&query_endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&query_body)
            .send()
            .await?;

        if !query_response.status().is_success() {
            let status = query_response.status();
            let error_text = query_response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "RunningHub query failed {}: {}",
                status, error_text
            )));
        }

        let query_raw = query_response.text().await.unwrap_or_default();
        let query_body: RunningHubQueryResponse =
            serde_json::from_str(&query_raw).map_err(|err| {
                AIError::Provider(format!(
                    "RunningHub query invalid JSON: {}; raw={}",
                    err, query_raw
                ))
            })?;

        if let Some(error_code) = query_body.errorCode.as_ref() {
            if !error_code.is_empty() {
                let error_msg = query_body.errorMessage.clone().unwrap_or_default();
                return Ok(ProviderTaskPollResult::Failed(format!(
                    "RunningHub error {}: {}",
                    error_code, error_msg
                )));
            }
        }

        match query_body.status.as_str() {
            "QUEUED" | "RUNNING" => Ok(ProviderTaskPollResult::Running),
            "SUCCESS" => {
                if let Some(results) = query_body.results {
                    if let Some(first_result) = results.first() {
                        return Ok(ProviderTaskPollResult::Succeeded(first_result.url.clone()));
                    }
                }
                Ok(ProviderTaskPollResult::Failed("No results in response".to_string()))
            }
            "FAILED" => {
                let error_msg = query_body
                    .errorMessage
                    .clone()
                    .unwrap_or_else(|| "Task failed".to_string());
                Ok(ProviderTaskPollResult::Failed(error_msg))
            }
            other => Err(AIError::Provider(format!(
                "RunningHub unexpected status: {}",
                other
            ))),
        }
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let submitted = self.submit_task(request).await?;
        let handle = match submitted {
            ProviderTaskSubmission::Succeeded(result) => return Ok(result),
            ProviderTaskSubmission::Queued(handle) => handle,
        };
        loop {
            match self.poll_task(handle.clone()).await? {
                ProviderTaskPollResult::Running => {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                }
                ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                ProviderTaskPollResult::SucceededWithMeta { url, .. } => return Ok(url),
                ProviderTaskPollResult::Failed(message) => return Err(AIError::TaskFailed(message)),
            }
        }
    }
}
