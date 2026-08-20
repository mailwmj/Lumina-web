use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::generation_recovery::is_retryable_poll_status;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
    VideoContentInput,
};

const DEFAULT_API_BASE_URL: &str = "https://ark.cn-beijing.volces.com";
const SUBMIT_PATH: &str = "/api/v3/contents/generations/tasks";
const QUERY_PATH: &str = "/api/v3/contents/generations/tasks";
const POLL_INTERVAL_MS: u64 = 5000;
const MAX_DURATION_SECONDS: u64 = 300; // 5 minutes max

fn map_poll_network_error(error: reqwest::Error) -> AIError {
    info!("[VolcVideo Poll] HTTP request failed: {}", error);
    AIError::Network(error)
}

#[derive(Debug, Clone)]
struct VolcVideoRuntimeConfig {
    base_url: String,
    api_key: String,
}

fn normalize_base_url(raw: &str) -> Result<String, AIError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AIError::InvalidRequest(
            "VolcVideo base_url is required".to_string(),
        ));
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(AIError::InvalidRequest(
            "VolcVideo base_url must start with http:// or https://".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn build_endpoint(base_url: &str, path: &str) -> Result<String, AIError> {
    let base = normalize_base_url(base_url)?;
    if base.ends_with("/api/v3") && path.starts_with("/api/v3") {
        return Ok(format!("{}{}", base, &path["/api/v3".len()..]));
    }
    Ok(format!("{}{}", base, path))
}

fn runtime_config_from_map(
    provider_config: Option<&HashMap<String, Value>>,
    fallback_api_key: Option<String>,
) -> Result<VolcVideoRuntimeConfig, AIError> {
    let base_url = provider_config
        .and_then(|config| config.get("base_url"))
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_API_BASE_URL);
    let api_key = provider_config
        .and_then(|config| config.get("api_key"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(fallback_api_key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AIError::InvalidRequest("VolcVideo API key is required".to_string()))?;

    Ok(VolcVideoRuntimeConfig {
        base_url: normalize_base_url(base_url)?,
        api_key,
    })
}

#[derive(Debug, Serialize)]
struct VideoSubmitContent {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<ImageUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    video_url: Option<VideoUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_url: Option<AudioUrl>,
    /// Draft task reference - used when generating final video from a draft
    #[serde(skip_serializing_if = "Option::is_none")]
    draft_task: Option<DraftTaskRef>,
}

#[derive(Debug, Serialize)]
struct DraftTaskRef {
    id: String,
}

#[derive(Debug, Serialize)]
struct ImageUrl {
    url: String,
}

#[derive(Debug, Serialize)]
struct VideoUrl {
    url: String,
}

#[derive(Debug, Serialize)]
struct AudioUrl {
    url: String,
}

#[derive(Debug, Serialize)]
struct VideoSubmitRequest {
    model: String,
    content: Vec<VideoSubmitContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generate_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    camera_fixed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    watermark: Option<bool>,
    // SD 2.0 new params
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Tool>>,
}

#[derive(Debug, Serialize)]
struct Tool {
    #[serde(rename = "type")]
    tool_type: String,
}

#[derive(Debug, Deserialize)]
struct VideoSubmitResponse {
    // API returns "id" field, not "task_id"
    id: Option<String>,
    #[serde(rename = "task_id")]
    task_id: Option<String>,
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct VideoQueryResponse {
    id: Option<String>,
    #[serde(rename = "task_id")]
    task_id: Option<String>,
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    #[serde(rename = "output_url")]
    output_url: Option<String>,
    // Handle nested data structure from some API versions
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<VideoQueryData>,
    // Handle content.video_url structure from Volc engine
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<VideoContentPayload>,
    #[serde(default)]
    deleted: bool,
    // Seed returned by the API (if supported)
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct VideoContentItem {
    #[serde(rename = "type")]
    content_type: Option<String>,
    #[serde(rename = "video_url")]
    video_url: Option<String>,
    #[serde(rename = "output_url")]
    output_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum VideoContentPayload {
    Items(Vec<VideoContentItem>),
    Single(VideoContentItem),
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum VideoQueryData {
    WithUrl(VideoDataUrl),
    Raw(Value),
}

#[derive(Debug, Deserialize)]
struct VideoDataUrl {
    #[serde(rename = "video_url")]
    video_url: Option<String>,
    #[serde(rename = "output_url")]
    output_url: Option<String>,
}

fn sanitize_model(model: &str) -> String {
    model
        .split_once('/')
        .map(|(_, bare)| bare.to_string())
        .unwrap_or_else(|| model.to_string())
}

fn extract_content_video_url(content: Option<&VideoContentPayload>) -> Option<String> {
    let items = match content? {
        VideoContentPayload::Items(items) => items,
        VideoContentPayload::Single(item) => std::slice::from_ref(item),
    };
    items.iter().find_map(|item| {
        let is_video = item
            .content_type
            .as_deref()
            .map(|value| value == "video")
            .unwrap_or(true);
        is_video.then(|| item.video_url.clone().or(item.output_url.clone()))?
    })
}

fn classify_query_status(
    status: Option<&str>,
    deleted: bool,
    video_url: Option<String>,
    seed: Option<i64>,
) -> Result<ProviderTaskPollResult, AIError> {
    if deleted {
        return Ok(ProviderTaskPollResult::Failed(
            "Video task was deleted".to_string(),
        ));
    }

    match status {
        Some("succeeded") | Some("success") => video_url
            .filter(|url| !url.is_empty())
            .map(|url| ProviderTaskPollResult::SucceededWithMeta { url, seed })
            .ok_or_else(|| {
                AIError::Provider(
                    "VolcVideo task succeeded but response has no video URL".to_string(),
                )
            }),
        Some("failed") => Ok(ProviderTaskPollResult::Failed(
            "Video generation failed".to_string(),
        )),
        Some("cancelled") | Some("canceled") => Ok(ProviderTaskPollResult::Failed(
            "Video generation was cancelled".to_string(),
        )),
        Some("expired") => Ok(ProviderTaskPollResult::Failed(
            "Video generation task expired".to_string(),
        )),
        Some("creating") | Some("submitted") | Some("queued") | Some("running")
        | Some("processing") | None => Ok(ProviderTaskPollResult::Running),
        Some(other) => Err(AIError::Provider(format!(
            "VolcVideo unexpected status: {}",
            other
        ))),
    }
}

pub struct VolcVideoProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl VolcVideoProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
        }
    }

    /// Convert local file path or blob URL to HTTP URL if possible
    /// For now, we only support HTTP URLs directly
    fn source_to_url(source: &str) -> Result<String, String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("source is empty".to_string());
        }

        // Data URL - pass through directly, let the API handle it
        if trimmed.starts_with("data:") {
            return Ok(trimmed.to_string());
        }

        // HTTP URLs - pass through directly
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Ok(trimmed.to_string());
        }

        // Blob URLs - can't be used directly
        if trimmed.starts_with("blob:") {
            return Err("blob URLs not supported, please use HTTP URLs".to_string());
        }

        // Local file paths need to be converted - but we don't have a good way to serve them
        if !trimmed.contains("://") {
            return Err("local file paths not supported, please use HTTP URLs".to_string());
        }

        Err(format!("unsupported protocol: {}", trimmed))
    }

    fn typed_source_to_public_url(source: &str) -> Result<String, AIError> {
        let url = source.trim();
        if url.starts_with("http://") || url.starts_with("https://") {
            return Ok(url.to_string());
        }

        Err(AIError::InvalidRequest(
            "Seedance typed media requires a public HTTP(S) URL".to_string(),
        ))
    }

    fn build_typed_video_content(
        inputs: &[VideoContentInput],
    ) -> Result<Vec<VideoSubmitContent>, AIError> {
        if inputs.is_empty() {
            return Err(AIError::InvalidRequest(
                "Seedance typed content cannot be empty".to_string(),
            ));
        }

        let mut has_text = false;
        let mut content = Vec::with_capacity(inputs.len());
        for input in inputs {
            let part_type = input.content_type.trim();
            let role = input.role.as_deref();
            let next = match part_type {
                "text" => {
                    let text = input.text.as_deref().map(str::trim).filter(|value| !value.is_empty())
                        .ok_or_else(|| AIError::InvalidRequest(
                            "Seedance text content requires non-empty text".to_string(),
                        ))?;
                    if role.is_some() || input.url.is_some() {
                        return Err(AIError::InvalidRequest(
                            "Seedance text content must not include a role or URL".to_string(),
                        ));
                    }
                    has_text = true;
                    VideoSubmitContent {
                        part_type: "text".to_string(),
                        role: None,
                        text: Some(text.to_string()),
                        image_url: None,
                        video_url: None,
                        audio_url: None,
                        draft_task: None,
                    }
                }
                "image_url" => {
                    let role = match role {
                        Some("first_frame") | Some("last_frame") | Some("reference_image") => {
                            role.unwrap().to_string()
                        }
                        _ => return Err(AIError::InvalidRequest(
                            "Seedance image content has an unsupported role".to_string(),
                        )),
                    };
                    let url = input.url.as_deref().ok_or_else(|| AIError::InvalidRequest(
                        "Seedance image content requires a URL".to_string(),
                    ))?;
                    VideoSubmitContent {
                        part_type: "image_url".to_string(),
                        role: Some(role),
                        text: None,
                        image_url: Some(ImageUrl { url: Self::typed_source_to_public_url(url)? }),
                        video_url: None,
                        audio_url: None,
                        draft_task: None,
                    }
                }
                "video_url" => {
                    if role != Some("reference_video") {
                        return Err(AIError::InvalidRequest(
                            "Seedance video content must use the reference_video role".to_string(),
                        ));
                    }
                    let url = input.url.as_deref().ok_or_else(|| AIError::InvalidRequest(
                        "Seedance video content requires a URL".to_string(),
                    ))?;
                    VideoSubmitContent {
                        part_type: "video_url".to_string(),
                        role: Some("reference_video".to_string()),
                        text: None,
                        image_url: None,
                        video_url: Some(VideoUrl { url: Self::typed_source_to_public_url(url)? }),
                        audio_url: None,
                        draft_task: None,
                    }
                }
                "audio_url" => {
                    if role != Some("reference_audio") {
                        return Err(AIError::InvalidRequest(
                            "Seedance audio content must use the reference_audio role".to_string(),
                        ));
                    }
                    let url = input.url.as_deref().ok_or_else(|| AIError::InvalidRequest(
                        "Seedance audio content requires a URL".to_string(),
                    ))?;
                    VideoSubmitContent {
                        part_type: "audio_url".to_string(),
                        role: Some("reference_audio".to_string()),
                        text: None,
                        image_url: None,
                        video_url: None,
                        audio_url: Some(AudioUrl { url: Self::typed_source_to_public_url(url)? }),
                        draft_task: None,
                    }
                }
                _ => return Err(AIError::InvalidRequest(format!(
                    "Seedance typed content has an unsupported type: {}",
                    input.content_type
                ))),
            };
            content.push(next);
        }

        if !has_text {
            return Err(AIError::InvalidRequest(
                "Seedance typed content requires a text entry".to_string(),
            ));
        }
        Ok(content)
    }

    async fn submit_task_internal(
        &self,
        runtime: &VolcVideoRuntimeConfig,
        request: &GenerateRequest,
    ) -> Result<String, AIError> {
        let model = sanitize_model(&request.model);
        let has_legacy_reference = request
            .reference_images
            .as_deref()
            .map(|r| !r.is_empty())
            .unwrap_or(false);
        let typed_video_content = request.video_content.as_deref();
        let has_typed_content = typed_video_content.map(|items| !items.is_empty()).unwrap_or(false);
        let has_reference = has_legacy_reference || has_typed_content;
        let draft_task_id = request.draft_task_id.clone();

        // Build content array
        let mut content = Vec::new();

        // Draft mode: generate final video from draft task
        // Content should only contain draft_task reference, no images or text needed
        if let Some(ref draft_id) = draft_task_id {
            info!("[VolcVideo] Draft mode: generating final video from draft task {}", draft_id);
            content.push(VideoSubmitContent {
                part_type: "draft_task".to_string(),
                role: None,
                text: None,
                image_url: None,
                video_url: None,
                audio_url: None,
                draft_task: Some(DraftTaskRef { id: draft_id.clone() }),
            });
        } else if let Some(typed_content) = typed_video_content {
            content = Self::build_typed_video_content(typed_content)?;
        } else if has_legacy_reference {
            let images_count = request.reference_images.as_deref().unwrap_or(&[]).len();
            info!("[VolcVideo] processing {} reference images", images_count);
            // Log all received reference images with their full content for debugging
            if let Some(refs) = request.reference_images.as_deref() {
                for (i, ref_img) in refs.iter().enumerate() {
                    info!("[VolcVideo] INPUT reference_image[{}]: {}", i, ref_img);
                }
            }
            let mut valid_images_count = 0;
            for (i, img_source) in request
                .reference_images
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .enumerate()
            {
                let url_preview = if img_source.len() > 100 { &img_source[..100] } else { img_source };
                info!("[VolcVideo] reference_image[{}] source: {}...", i, url_preview);
                match Self::source_to_url(img_source) {
                    Ok(url) => {
                        let url_display = if url.len() > 100 { &url[..100] } else { &url };
                        info!("[VolcVideo] reference_image[{}] converted successfully: {}...", i, url_display);
                        // Determine role based on position in CONTENT (not original index)
                        // For first/last frame mode (2 images): use "first_frame" or "last_frame"
                        // For single image mode: API doesn't require role for image content
                        // Bug fix: if some images fail source_to_url, we still want first valid image
                        // to get "first_frame" and second valid image to get "last_frame"
                        let role = if images_count == 2 {
                            if content.is_empty() {
                                Some("first_frame".to_string())
                            } else {
                                Some("last_frame".to_string())
                            }
                        } else {
                            None
                        };
                        info!("[VolcVideo] reference_image[{}] role: {:?}", i, role);
                        content.push(VideoSubmitContent {
                            part_type: "image_url".to_string(),
                            role,
                            text: None,
                            image_url: Some(ImageUrl { url }),
                            video_url: None,
                            audio_url: None,
                            draft_task: None,
                        });
                        valid_images_count += 1;
                    }
                    Err(e) => {
                        info!("[VolcVideo] skip invalid reference image[{}]: {}", i, e);
                    }
                }
            }
            info!("[VolcVideo] valid images processed: {}/{}", valid_images_count, images_count);
            if valid_images_count < images_count {
                info!("[VolcVideo] WARNING: Some images were skipped!");
            }
            // Log the final content array with roles
            for (idx, item) in content.iter().enumerate() {
                let img_url_display = item.image_url.as_ref().map(|u| if u.url.len() > 80 { &u.url[..80] } else { &u.url }).unwrap_or("(none)");
                info!("[VolcVideo] content[{}]: type={}, role={:?}, image_url={}...", idx, item.part_type, item.role, img_url_display);
            }
        } else {
            info!("[VolcVideo] no reference images to process");
        }

        // Text prompt - keep clean without appended parameters
        let text_prompt = request.prompt.clone();

        // Extract parameters for request body
        let mut generate_audio = None;
        let mut resolution = None;
        let mut ratio = None;
        let mut duration = None;
        let mut seed = None;
        let mut camera_fixed = None;
        let mut watermark = None;
        // SD 2.0 new params
        let mut draft = None;
        let mut tools = None;

        // Map size to resolution
        // For draft_task mode, do not set resolution - it's inherited from draft video
        if !request.size.is_empty() && draft_task_id.is_none() {
            resolution = Some(request.size.clone());
        }

        // Map aspect_ratio to ratio
        // For draft_task mode, do not set ratio - it's inherited from draft video
        if !request.aspect_ratio.is_empty() && draft_task_id.is_none() {
            ratio = Some(request.aspect_ratio.clone());
        }

        // Extract from extra_params
        if let Some(extra) = &request.extra_params {
            if let Some(v) = extra.get("duration").and_then(|v| v.as_i64()) {
                duration = Some(v);
            }
            if let Some(v) = extra.get("camerafixed").and_then(|v| v.as_bool()) {
                camera_fixed = Some(v);
            }
            if let Some(v) = extra.get("watermark").and_then(|v| v.as_bool()) {
                watermark = Some(v);
            }
            if let Some(v) = extra.get("seed").and_then(|v| v.as_u64()) {
                seed = Some(v as i64);
            }
            // hasaudio: only set for non-draft mode (draft inherits audio from draft video)
            if draft_task_id.is_none() {
                if let Some(v) = extra.get("hasaudio").and_then(|v| v.as_bool()) {
                    generate_audio = Some(v);
                } else {
                    // Seedance 2.0 default: generate synchronized audio.
                    generate_audio = Some(true);
                }
            }
            // SD 2.0: draft mode
            if let Some(v) = extra.get("draft").and_then(|v| v.as_bool()) {
                draft = Some(v);
            }
            // SD 2.0: web search
            if let Some(v) = extra.get("enable_web_search").and_then(|v| v.as_bool()) {
                if v {
                    tools = Some(vec![Tool { tool_type: "web_search".to_string() }]);
                }
            }
        } else if draft_task_id.is_none() {
            // Seedance 2.0 default: generate synchronized audio.
            generate_audio = Some(true);
        }

        // Add text content (text content should NOT have role field)
        // Skip text for draft_task mode - the draft already has all the prompt info
        if draft_task_id.is_none() && typed_video_content.is_none() {
            content.push(VideoSubmitContent {
                part_type: "text".to_string(),
                role: None,
                text: Some(text_prompt),
                image_url: None,
                video_url: None,
                audio_url: None,
                draft_task: None,
            });
        }

        let body = VideoSubmitRequest {
            model: model.clone(),
            content,
            generate_audio,
            resolution,
            ratio,
            duration,
            seed,
            camera_fixed,
            watermark,
            draft,
            tools,
        };

        let endpoint = build_endpoint(&runtime.base_url, SUBMIT_PATH)?;

        info!(
            "[VolcVideo Submit] model: {}, has_ref: {}, prompt_len: {}, endpoint: {}, request_body: {}",
            model,
            has_reference,
            request.prompt.len(),
            endpoint,
            serde_json::to_string(&body).unwrap_or_default()
        );

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", runtime.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AIError::Provider(format!("VolcVideo request failed: {}", e)))?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "VolcVideo submit failed [{}]: {}",
                status, raw_response
            )));
        }

        let body: VideoSubmitResponse = serde_json::from_str(&raw_response)
            .map_err(|err| AIError::Provider(format!("VolcVideo parse error: {}, raw: {}", err, raw_response)))?;

        info!("[VolcVideo Submit] response: id={:?}, task_id={:?}, status={:?}, error={:?}",
              body.id, body.task_id, body.status, body.error);

        if let Some(error) = body.error {
            // Extract detailed error info from API response
            let msg = error.get("message").and_then(|v| v.as_str()).unwrap_or("Unknown error");
            let code = error.get("code").and_then(|v| v.as_str()).unwrap_or("");
            let param = error.get("param").and_then(|v| v.as_str()).unwrap_or("");
            let err_type = error.get("type").and_then(|v| v.as_str()).unwrap_or("");

            // Build detailed error message
            let detailed_msg = if !code.is_empty() {
                format!("[{}] {}", code, msg)
            } else {
                msg.to_string()
            };

            let final_msg = if !param.is_empty() || !err_type.is_empty() {
                format!("{} | param: {}, type: {}", detailed_msg, param, err_type)
            } else {
                detailed_msg
            };

            info!("[VolcVideo] API error detailed: code={}, message={}, param={}, type={}", code, msg, param, err_type);
            return Err(AIError::Provider(format!("VolcVideo API error: {}, raw: {}", final_msg, raw_response)));
        }

        // Use id if task_id is not present (API returns "id" field)
        body.task_id
            .or(body.id)
            .ok_or_else(|| {
                // Both task_id and id missing - log full response for debugging
                info!("[VolcVideo] Response missing both task_id and id. Full response: {}", raw_response);
                AIError::Provider(format!(
                    "VolcVideo API 返回缺少 task_id/id，可能原因：1) API地址错误；2) 模型ID无效；3) 请求格式错误。API返回: {}",
                    raw_response
                ))
            })
    }

    async fn poll_task_once(
        &self,
        runtime: &VolcVideoRuntimeConfig,
        task_id: &str,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let endpoint = format!("{}/{}", build_endpoint(&runtime.base_url, QUERY_PATH)?, task_id);
        info!("[VolcVideo Poll] querying task: {}, endpoint: {}, api_key present: {}",
              task_id, endpoint, !runtime.api_key.is_empty());

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", runtime.api_key))
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(map_poll_network_error)?;

        let status = response.status();
        let raw_response = response.text().await?;
        info!("[VolcVideo Poll] response status: {}, body: {}", status, raw_response);

        if is_retryable_poll_status(status) {
            return Err(AIError::Transient(format!(
                "VolcVideo task query temporarily unavailable [{}]",
                status
            )));
        }

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "VolcVideo query failed [{}]: {}",
                status, raw_response
            )));
        }

        let body: VideoQueryResponse = serde_json::from_str(&raw_response)
            .map_err(|err| {
                info!("[VolcVideo Poll] JSON parse failed: {}, raw: {}", err, raw_response);
                AIError::Provider(format!("VolcVideo parse error: {}", err))
            })?;

        // Cloud-compatible Seedance responses use content: [{ type: "video", video_url }].
        let content_video_url = extract_content_video_url(body.content.as_ref());

        // Check for URL in nested data structure if top-level output_url is missing
        let nested_video_url = body.data.as_ref().and_then(|d| {
            match d {
                VideoQueryData::WithUrl(url_obj) => {
                    url_obj.video_url.clone().or(url_obj.output_url.clone())
                }
                VideoQueryData::Raw(val) => {
                    val.get("video_url").and_then(|v| v.as_str()).map(String::from)
                    .or(val.get("output_url").and_then(|v| v.as_str()).map(String::from))
                }
            }
        });

        info!("[VolcVideo Poll] parsed response: id={:?}, task_id={:?}, status={:?}, output_url={:?}, content_video_url={:?}, nested_video_url={:?}, deleted={}, error={:?}",
              body.id, body.task_id, body.status, body.output_url, content_video_url, nested_video_url, body.deleted, body.error);

        if let Some(error) = body.error {
            let msg = error
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            info!("[VolcVideo Poll] API returned error: {}", msg);
            return Err(AIError::Provider(format!("VolcVideo error: {}", msg)));
        }

        let video_url = body
            .output_url
            .clone()
            .or(content_video_url)
            .or(nested_video_url);
        classify_query_status(body.status.as_deref(), body.deleted, video_url, body.seed)
    }

    async fn poll_task_until_complete(
        &self,
        runtime: &VolcVideoRuntimeConfig,
        task_id: &str,
    ) -> Result<String, AIError> {
        let mut elapsed_ms: u64 = 0;
        loop {
            if elapsed_ms >= MAX_DURATION_SECONDS * 1000 {
                return Err(AIError::TaskFailed("Video generation timeout".to_string()));
            }

            match self.poll_task_once(runtime, task_id).await? {
                ProviderTaskPollResult::Running => {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                    elapsed_ms += POLL_INTERVAL_MS;
                }
                ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                ProviderTaskPollResult::SucceededWithMeta { url, .. } => return Ok(url),
                ProviderTaskPollResult::Failed(message) => {
                    return Err(AIError::TaskFailed(message))
                }
            }
        }
    }
}

impl Default for VolcVideoProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for VolcVideoProvider {
    fn name(&self) -> &str {
        "volcvideo"
    }

    fn supports_model(&self, model: &str) -> bool {
        let model = sanitize_model(model);
        // Support all doubao-seedance variants (including user-configured ones)
        // Also accept explicit volcvideo/ prefix
        model == "doubao-seedance-1-5-pro-251215"
            || model.starts_with("doubao-seedance-")
            || model.starts_with("volcvideo/")
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "volcvideo/doubao-seedance-1-5-pro-251215".to_string(),
            "volcvideo/doubao-seedance-1-0-pro-250528".to_string(),
            "doubao-seedance-1-5-pro-251215".to_string(),
            "doubao-seedance-1-0-pro-250528".to_string(),
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

    async fn submit_task(
        &self,
        request: GenerateRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        let fallback_api_key = self
            .api_key
            .read()
            .await
            .clone();
        let runtime = runtime_config_from_map(request.provider_config.as_ref(), fallback_api_key)?;

        let task_id = self.submit_task_internal(&runtime, &request).await?;
        info!("[VolcVideo] submit_task succeeded, returning task_id: {}", task_id);
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: None,
        }))
    }

    async fn poll_task(&self, handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        let fallback_api_key = self
            .api_key
            .read()
            .await
            .clone();
        let runtime = runtime_config_from_map(None, fallback_api_key)?;

        self.poll_task_once(&runtime, handle.task_id.as_str())
            .await
    }

    async fn poll_task_with_config(
        &self,
        handle: ProviderTaskHandle,
        provider_config: Option<HashMap<String, Value>>,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let fallback_api_key = self.api_key.read().await.clone();
        let runtime = runtime_config_from_map(provider_config.as_ref(), fallback_api_key)?;
        self.poll_task_once(&runtime, handle.task_id.as_str()).await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let fallback_api_key = self
            .api_key
            .read()
            .await
            .clone();
        let runtime = runtime_config_from_map(request.provider_config.as_ref(), fallback_api_key)?;

        let task_id = self.submit_task_internal(&runtime, &request).await?;
        self.poll_task_until_complete(&runtime, &task_id)
            .await
    }
}

/// Cancel a video generation task by calling DELETE endpoint
pub async fn cancel_volcvideo_task(
    api_key: &str,
    base_url: &str,
    task_id: &str,
) -> Result<(), AIError> {
    let endpoint = format!("{}/{}", build_endpoint(base_url, QUERY_PATH)?, task_id);
    info!("[VolcVideo Cancel] cancelling task: {}, endpoint: {}", task_id, endpoint);

    let client = Client::new();
    let response = client
        .delete(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| AIError::Provider(format!("VolcVideo cancel request failed: {}", e)))?;

    let status = response.status();
    let raw_response = response.text().await.unwrap_or_default();

    info!("[VolcVideo Cancel] response status: {}, body: {}", status, raw_response);

    if status.is_success() || status.as_u16() == 404 {
        // 204 No Content or 404 means success (task cancelled or already gone)
        Ok(())
    } else {
        Err(AIError::Provider(format!(
            "VolcVideo cancel failed [{}]: {}",
            status, raw_response
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_endpoint, classify_query_status, extract_content_video_url, map_poll_network_error,
        VideoQueryResponse, VolcVideoProvider,
    };
    use crate::ai::{
        error::AIError, AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult,
        ProviderTaskSubmission, VideoContentInput,
    };
    use reqwest::Client;
    use serde_json::json;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let size = socket.read(&mut buffer).await.unwrap();
            assert!(size > 0, "connection closed before request headers");
            request.extend_from_slice(&buffer[..size]);
            if let Some(header_end) = request
                .windows(4)
                .position(|chunk| chunk == b"\r\n\r\n")
            {
                break header_end + 4;
            }
        };
        let headers = std::str::from_utf8(&request[..header_end]).unwrap();
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
            })
            .unwrap_or(0);

        while request.len() < header_end + content_length {
            let size = socket.read(&mut buffer).await.unwrap();
            assert!(size > 0, "connection closed before request body");
            request.extend_from_slice(&buffer[..size]);
        }
        request
    }

    async fn write_json_response(socket: &mut tokio::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    #[test]
    fn joins_cloud_compatible_base_urls_without_duplicate_api_versions() {
        assert_eq!(
            build_endpoint(
                "https://ai.yunxinapi.com/hub/volcengine",
                "/api/v3/contents/generations/tasks"
            )
            .unwrap(),
            "https://ai.yunxinapi.com/hub/volcengine/api/v3/contents/generations/tasks"
        );
        assert_eq!(
            build_endpoint(
                "https://ark.cn-beijing.volces.com/api/v3/",
                "/api/v3/contents/generations/tasks"
            )
            .unwrap(),
            "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks"
        );
    }

    #[test]
    fn extracts_yunxin_video_url_from_content_array() {
        let response: VideoQueryResponse = serde_json::from_value(json!({
            "id": "tsk_123",
            "status": "succeeded",
            "content": [
                { "type": "text", "text": "ignored" },
                { "type": "video", "video_url": "https://example.com/video.mp4" }
            ]
        }))
        .unwrap();

        assert_eq!(
            extract_content_video_url(response.content.as_ref()),
            Some("https://example.com/video.mp4".to_string())
        );
    }

    #[test]
    fn treats_yunxin_pending_and_terminal_statuses_correctly() {
        for status in ["creating", "submitted", "queued", "running", "processing"] {
            assert!(matches!(
                classify_query_status(Some(status), false, None, None).unwrap(),
                ProviderTaskPollResult::Running
            ));
        }
        assert!(matches!(
            classify_query_status(
                Some("succeeded"),
                false,
                Some("https://example.com/video.mp4".to_string()),
                Some(42)
            )
            .unwrap(),
            ProviderTaskPollResult::SucceededWithMeta { url, seed: Some(42) }
                if url == "https://example.com/video.mp4"
        ));
        assert!(matches!(
            classify_query_status(Some("cancelled"), false, None, None).unwrap(),
            ProviderTaskPollResult::Failed(message) if message.contains("cancelled")
        ));
    }

    #[tokio::test]
    async fn sends_yunxin_compatible_submit_and_poll_requests_with_the_selected_runtime_config() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut submit_socket, _) = listener.accept().await.unwrap();
            let submit_request = read_http_request(&mut submit_socket).await;
            write_json_response(&mut submit_socket, r#"{"id":"tsk_yunxin_123"}"#).await;

            let (mut poll_socket, _) = listener.accept().await.unwrap();
            let poll_request = read_http_request(&mut poll_socket).await;
            write_json_response(
                &mut poll_socket,
                r#"{"id":"tsk_yunxin_123","status":"succeeded","content":[{"type":"video","video_url":"https://example.com/result.mp4"}]}"#,
            )
            .await;

            (submit_request, poll_request)
        });
        let base_url = format!("http://{address}/hub/volcengine");
        let provider_config = HashMap::from([
            ("base_url".to_string(), json!(base_url)),
            ("api_key".to_string(), json!("yunxin-key")),
        ]);
        let provider = VolcVideoProvider::new();
        let submission = provider
            .submit_task(GenerateRequest {
                prompt: "A rainy city at night".to_string(),
                model: "doubao-seedance-2-0-260128".to_string(),
                provider_id: Some("volcvideo".to_string()),
                size: "720p".to_string(),
                aspect_ratio: "16:9".to_string(),
                reference_images: None,
                video_content: None,
                extra_params: None,
                provider_config: Some(provider_config.clone()),
                draft_task_id: None,
            })
            .await
            .unwrap();
        let task_id = match submission {
            ProviderTaskSubmission::Queued(handle) => handle.task_id,
            ProviderTaskSubmission::Succeeded(_) => panic!("Seedance tasks must be polled"),
        };

        let poll_result = provider
            .poll_task_with_config(
                ProviderTaskHandle {
                    task_id,
                    metadata: None,
                },
                Some(provider_config),
            )
            .await
            .unwrap();
        let (submit_request, poll_request) = server.await.unwrap();
        let submit_request = String::from_utf8(submit_request).unwrap();
        let poll_request = String::from_utf8(poll_request).unwrap();

        assert!(submit_request.starts_with(
            "POST /hub/volcengine/api/v3/contents/generations/tasks HTTP/1.1"
        ));
        assert!(submit_request.to_ascii_lowercase().contains("authorization: bearer yunxin-key"));
        assert!(submit_request.to_ascii_lowercase().contains("content-type: application/json"));
        let submit_body_start = submit_request.find("\r\n\r\n").unwrap() + 4;
        let submit_body: serde_json::Value =
            serde_json::from_str(&submit_request[submit_body_start..]).unwrap();
        assert_eq!(submit_body["model"], json!("doubao-seedance-2-0-260128"));
        assert_eq!(submit_body["content"], json!([
            { "type": "text", "text": "A rainy city at night" }
        ]));
        assert_eq!(submit_body["resolution"], json!("720p"));
        assert_eq!(submit_body["ratio"], json!("16:9"));
        assert_eq!(submit_body["generate_audio"], json!(true));
        assert!(poll_request.starts_with(
            "GET /hub/volcengine/api/v3/contents/generations/tasks/tsk_yunxin_123 HTTP/1.1"
        ));
        assert!(poll_request.to_ascii_lowercase().contains("authorization: bearer yunxin-key"));
        assert!(matches!(
            poll_result,
            ProviderTaskPollResult::SucceededWithMeta { url, seed: None }
                if url == "https://example.com/result.mp4"
        ));
    }

    #[tokio::test]
    async fn serializes_typed_seedance_content_without_omni_reference_task_type() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            write_json_response(&mut socket, r#"{"id":"tsk_typed_123"}"#).await;
            request
        });
        let provider = VolcVideoProvider::new();
        let provider_config = HashMap::from([
            ("base_url".to_string(), json!(format!("http://{address}"))),
            ("api_key".to_string(), json!("typed-key")),
        ]);

        provider
            .submit_task(GenerateRequest {
                prompt: "legacy prompt field is not serialized as duplicate content".to_string(),
                model: "doubao-seedance-2-0-260128".to_string(),
                provider_id: Some("volcvideo".to_string()),
                size: "720p".to_string(),
                aspect_ratio: "16:9".to_string(),
                reference_images: None,
                video_content: Some(vec![
                    VideoContentInput {
                        content_type: "image_url".to_string(),
                        role: Some("first_frame".to_string()),
                        url: Some("https://media.example/first.png".to_string()),
                        text: None,
                    },
                    VideoContentInput {
                        content_type: "image_url".to_string(),
                        role: Some("last_frame".to_string()),
                        url: Some("https://media.example/last.png".to_string()),
                        text: None,
                    },
                    VideoContentInput {
                        content_type: "image_url".to_string(),
                        role: Some("reference_image".to_string()),
                        url: Some("https://media.example/reference.png".to_string()),
                        text: None,
                    },
                    VideoContentInput {
                        content_type: "video_url".to_string(),
                        role: Some("reference_video".to_string()),
                        url: Some("https://media.example/source.mp4".to_string()),
                        text: None,
                    },
                    VideoContentInput {
                        content_type: "audio_url".to_string(),
                        role: Some("reference_audio".to_string()),
                        url: Some("https://media.example/music.mp3".to_string()),
                        text: None,
                    },
                    VideoContentInput {
                        content_type: "text".to_string(),
                        role: None,
                        url: None,
                        text: Some("Make the subject dance to the beat".to_string()),
                    },
                ]),
                extra_params: None,
                provider_config: Some(provider_config),
                draft_task_id: None,
            })
            .await
            .unwrap();

        let request = String::from_utf8(server.await.unwrap()).unwrap();
        let body_start = request.find("\r\n\r\n").unwrap() + 4;
        let body: serde_json::Value = serde_json::from_str(&request[body_start..]).unwrap();
        assert_eq!(body["content"], json!([
            {
                "type": "image_url",
                "role": "first_frame",
                "image_url": { "url": "https://media.example/first.png" }
            },
            {
                "type": "image_url",
                "role": "last_frame",
                "image_url": { "url": "https://media.example/last.png" }
            },
            {
                "type": "image_url",
                "role": "reference_image",
                "image_url": { "url": "https://media.example/reference.png" }
            },
            {
                "type": "video_url",
                "role": "reference_video",
                "video_url": { "url": "https://media.example/source.mp4" }
            },
            {
                "type": "audio_url",
                "role": "reference_audio",
                "audio_url": { "url": "https://media.example/music.mp3" }
            },
            { "type": "text", "text": "Make the subject dance to the beat" }
        ]));
        assert!(body.get("omni_reference_task_type").is_none());
    }

    #[tokio::test]
    async fn rejects_non_public_typed_seedance_media_urls() {
        let provider = VolcVideoProvider::new();
        let provider_config = HashMap::from([
            ("base_url".to_string(), json!("https://ark.example")),
            ("api_key".to_string(), json!("typed-key")),
        ]);

        let error = provider
            .submit_task(GenerateRequest {
                prompt: "The typed content is validated before submission".to_string(),
                model: "doubao-seedance-2-0-260128".to_string(),
                provider_id: Some("volcvideo".to_string()),
                size: "720p".to_string(),
                aspect_ratio: "16:9".to_string(),
                reference_images: None,
                video_content: Some(vec![
                    VideoContentInput {
                        content_type: "image_url".to_string(),
                        role: Some("reference_image".to_string()),
                        url: Some("/project/uploads/reference.png".to_string()),
                        text: None,
                    },
                    VideoContentInput {
                        content_type: "text".to_string(),
                        role: None,
                        url: None,
                        text: Some("Keep the subject centered".to_string()),
                    },
                ]),
                extra_params: None,
                provider_config: Some(provider_config),
                draft_task_id: None,
            })
            .await
            .expect_err("non-public typed media must not reach the provider");

        assert!(matches!(error, AIError::InvalidRequest(message)
            if message.contains("public HTTP(S) URL")));
    }

    #[tokio::test]
    async fn preserves_transport_failures_as_network_errors_for_task_recovery() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            drop(socket);
        });

        let error = Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(endpoint)
            .send()
            .await
            .expect_err("a dropped TCP connection must fail the HTTP request");

        assert!(matches!(map_poll_network_error(error), AIError::Network(_)));
    }
}
