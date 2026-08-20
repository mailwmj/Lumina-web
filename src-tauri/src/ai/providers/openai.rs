use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::header::CONTENT_TYPE;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;
use uuid::Uuid;

use super::image_input::{load_reference_image, ReferenceImage};
use crate::ai::error::AIError;
use crate::ai::generation_recovery::is_retryable_poll_status;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

const AI_MEDIA_PROVIDER_ID: &str = "ai-media";
const AI_MEDIA_MODEL_ID: &str = "ai-media/gpt-image-2";
const AI_MEDIA_DEFAULT_BASE_URL: &str = "https://api.ai-media.vip/v1";
const AI_MEDIA_DEFAULT_MODEL: &str = "gpt-image-2";
const CHAOMO_PROVIDER_ID: &str = "chaomo";
const CHAOMO_GPT_IMAGE2_1K_MODEL_ID: &str = "chaomo/gpt-image2-1K";
const CHAOMO_GPT_IMAGE2_1K_HIGHT_MODEL_ID: &str = "chaomo/gpt-image2-1K-Hight";
const CHAOMO_GPT_IMAGE2_2K_HIGHT_MODEL_ID: &str = "chaomo/gpt-image2-2K-Hight";
const CHAOMO_GPT_IMAGE2_4K_HIGHT_MODEL_ID: &str = "chaomo/gpt-image2-4K-Hight";
const CHAOMO_GPT_IMAGE2_2K_DIRECT_MODEL_ID: &str = "chaomo/gpt-image2-2K-Direct";
const CHAOMO_GPT_IMAGE2_4K_STABLE_MODEL_ID: &str = "chaomo/gpt-image2-4K-Stable";
const CHAOMO_GPT_IMAGE2_4K_DIRECT_MODEL_ID: &str = "chaomo/gpt-image2-4K-Direct";
const CHAOMO_GPT_IMAGE2_4K_MODEL_ID: &str = "chaomo/gpt-image2-4K";
const CHAOMO_NANO_BANANA_2_MODEL_ID: &str = "chaomo/nano-banana-2";
const CHAOMO_NANO_BANANA_PRO_MODEL_ID: &str = "chaomo/nano-banana-pro";
const CHAOMO_LEGACY_DIRECT_MODEL_ID: &str = "chaomo/gpt-image-2-direct";
const CHAOMO_LEGACY_NATIVE_4K_MODEL_ID: &str = "chaomo/gpt-image-2-4k-native";
const CHAOMO_DEFAULT_BASE_URL: &str = "https://www.chaomoapi.com/v1";
const LEGACY_PROVIDER_ID: &str = "openai";
const LEGACY_MODEL_ID: &str = "openai/custom";
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL: &str = "gpt-image-1";
const FHL_PROVIDER_ID: &str = "fhl";
const FHL_MODEL_ID: &str = "fhl/gpt-image-2";
const FHL_DEFAULT_BASE_URL: &str = "https://www.fhl.mom/v1";
const FHL_DEFAULT_MODEL: &str = "gpt-image-2";
const POLL_INTERVAL_MS: u64 = 2_000;
const MAX_SYNC_POLL_ATTEMPTS: usize = 180;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenAiImageProtocol {
    Standard,
    AiMedia,
    Chaomo,
    Fhl,
}

pub struct OpenAiProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
    provider_id: &'static str,
    protocol: OpenAiImageProtocol,
    supported_models: &'static [&'static str],
}

impl OpenAiProvider {
    pub fn new() -> Self {
        Self::ai_media()
    }

    pub fn ai_media() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            provider_id: AI_MEDIA_PROVIDER_ID,
            protocol: OpenAiImageProtocol::AiMedia,
            supported_models: &[AI_MEDIA_MODEL_ID],
        }
    }

    pub fn chaomo() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            provider_id: CHAOMO_PROVIDER_ID,
            protocol: OpenAiImageProtocol::Chaomo,
            supported_models: &[
                CHAOMO_GPT_IMAGE2_1K_MODEL_ID,
                CHAOMO_GPT_IMAGE2_1K_HIGHT_MODEL_ID,
                CHAOMO_GPT_IMAGE2_2K_HIGHT_MODEL_ID,
                CHAOMO_GPT_IMAGE2_4K_HIGHT_MODEL_ID,
                CHAOMO_GPT_IMAGE2_2K_DIRECT_MODEL_ID,
                CHAOMO_GPT_IMAGE2_4K_STABLE_MODEL_ID,
                CHAOMO_GPT_IMAGE2_4K_DIRECT_MODEL_ID,
                CHAOMO_GPT_IMAGE2_4K_MODEL_ID,
                CHAOMO_NANO_BANANA_2_MODEL_ID,
                CHAOMO_NANO_BANANA_PRO_MODEL_ID,
            ],
        }
    }

    pub fn legacy() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            provider_id: LEGACY_PROVIDER_ID,
            protocol: OpenAiImageProtocol::Standard,
            supported_models: &[LEGACY_MODEL_ID],
        }
    }

    pub fn fhl() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            provider_id: FHL_PROVIDER_ID,
            protocol: OpenAiImageProtocol::Fhl,
            supported_models: &[FHL_MODEL_ID],
        }
    }

    fn config_value(request: &GenerateRequest, key: &str) -> Option<String> {
        request
            .provider_config
            .as_ref()
            .and_then(|config| config.get(key))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn normalize_base_url(&self, input: Option<String>) -> String {
        let base_url = input
            .unwrap_or_else(|| match self.protocol {
                OpenAiImageProtocol::Standard => OPENAI_DEFAULT_BASE_URL.to_string(),
                OpenAiImageProtocol::AiMedia => AI_MEDIA_DEFAULT_BASE_URL.to_string(),
                OpenAiImageProtocol::Chaomo => CHAOMO_DEFAULT_BASE_URL.to_string(),
                OpenAiImageProtocol::Fhl => FHL_DEFAULT_BASE_URL.to_string(),
            })
            .trim_end_matches('/')
            .to_string();

        if self.protocol == OpenAiImageProtocol::Fhl && !base_url.ends_with("/v1") {
            return format!("{}/v1", base_url);
        }

        base_url
    }

    fn resolve_model(&self, request: &GenerateRequest) -> String {
        match self.protocol {
            OpenAiImageProtocol::Standard => request
                .model
                .strip_prefix("openai/")
                .filter(|model| !model.trim().is_empty() && *model != "custom")
                .unwrap_or(OPENAI_DEFAULT_MODEL)
                .to_string(),
            OpenAiImageProtocol::AiMedia => {
                if self.provider_id == AI_MEDIA_PROVIDER_ID {
                    request
                        .model
                        .strip_prefix("ai-media/")
                        .filter(|model| !model.trim().is_empty())
                        .unwrap_or(AI_MEDIA_DEFAULT_MODEL)
                        .to_string()
                } else {
                    AI_MEDIA_DEFAULT_MODEL.to_string()
                }
            }
            OpenAiImageProtocol::Chaomo => match request.model.as_str() {
                CHAOMO_LEGACY_NATIVE_4K_MODEL_ID => "gpt-image2-4K".to_string(),
                // The old Direct option was a resolution switch. Preserve that behavior for
                // existing canvas documents while sending the new options verbatim.
                CHAOMO_LEGACY_DIRECT_MODEL_ID => {
                    match request.size.trim().to_ascii_uppercase().as_str() {
                        "1K" => "gpt-image2-1K".to_string(),
                        "4K" => "gpt-image2-4K-Direct".to_string(),
                        _ => "gpt-image2-2K-Direct".to_string(),
                    }
                }
                model => model.strip_prefix("chaomo/").unwrap_or(model).to_string(),
            },
            OpenAiImageProtocol::Fhl => request
                .model
                .strip_prefix("fhl/")
                .filter(|model| !model.trim().is_empty())
                .unwrap_or(FHL_DEFAULT_MODEL)
                .to_string(),
        }
    }

    fn chaomo_uses_quality(&self, request: &GenerateRequest) -> bool {
        if self.protocol != OpenAiImageProtocol::Chaomo {
            return false;
        }

        !matches!(
            request
                .model
                .strip_prefix("chaomo/")
                .unwrap_or(request.model.as_str()),
            "gpt-image2-1K-Hight"
                | "gpt-image2-2K-Hight"
                | "gpt-image2-4K-Hight"
                | "gpt-image2-4K"
                | "gpt-image-2-4k-native"
        )
    }

    fn chaomo_supports_reference_images(model: &str) -> bool {
        !matches!(
            model.strip_prefix("chaomo/").unwrap_or(model),
            "gpt-image2-1K-Hight" | "gpt-image2-2K-Hight" | "gpt-image2-4K-Hight"
        )
    }

    fn request_quality(&self, request: &GenerateRequest) -> Option<String> {
        match self.protocol {
            OpenAiImageProtocol::Standard => {
                Self::resolve_image_quality(&request.size).map(str::to_string)
            }
            OpenAiImageProtocol::AiMedia => {
                Self::resolve_image_quality(&request.size).map(str::to_string)
            }
            OpenAiImageProtocol::Chaomo if self.chaomo_uses_quality(request) => {
                Some("medium".to_string())
            }
            OpenAiImageProtocol::Chaomo => None,
            OpenAiImageProtocol::Fhl => Some("auto".to_string()),
        }
    }

    fn resolve_image_size(resolution: &str, aspect_ratio: &str) -> String {
        let normalized_resolution = resolution.trim().to_ascii_lowercase();
        if let Some((width, height)) = normalized_resolution.split_once('x') {
            if width.parse::<u32>().is_ok_and(|value| value > 0)
                && height.parse::<u32>().is_ok_and(|value| value > 0)
            {
                return normalized_resolution;
            }
        }

        let long_edge = match normalized_resolution.as_str() {
            "2k" => 2_048_u32,
            "4k" => 4_096_u32,
            _ => 1_024_u32,
        };
        let mut parts = aspect_ratio.split(':');
        let width_ratio = parts.next().and_then(|value| value.parse::<f64>().ok());
        let height_ratio = parts.next().and_then(|value| value.parse::<f64>().ok());

        match (width_ratio, height_ratio) {
            (Some(width), Some(height)) if width > 0.0 && height > 0.0 && width > height => {
                let output_height = (f64::from(long_edge) * height / width).round() as u32;
                format!("{}x{}", long_edge, output_height.max(1))
            }
            (Some(width), Some(height)) if width > 0.0 && height > 0.0 && width < height => {
                let output_width = (f64::from(long_edge) * width / height).round() as u32;
                format!("{}x{}", output_width.max(1), long_edge)
            }
            _ => format!("{}x{}", long_edge, long_edge),
        }
    }

    fn resolve_standard_image_size(aspect_ratio: &str) -> &'static str {
        let mut parts = aspect_ratio.split(':');
        let width = parts.next().and_then(|value| value.parse::<f64>().ok());
        let height = parts.next().and_then(|value| value.parse::<f64>().ok());

        match (width, height) {
            (Some(width), Some(height)) if width > height => "1536x1024",
            (Some(width), Some(height)) if width < height => "1024x1536",
            _ => "1024x1024",
        }
    }

    fn resolve_fhl_image_size(resolution: &str, aspect_ratio: &str) -> String {
        let normalized_resolution = resolution.trim().to_ascii_uppercase();
        if normalized_resolution.contains('X') {
            return Self::resolve_image_size(resolution, aspect_ratio);
        }

        let ratio = aspect_ratio.trim().to_ascii_lowercase();
        let size = match (normalized_resolution.as_str(), ratio.as_str()) {
            ("1K", "1:1") => Some("1024x1024"),
            ("1K", "3:2") => Some("1536x1024"),
            ("1K", "2:3") => Some("1024x1536"),
            ("1K", "4:3") => Some("1536x1152"),
            ("1K", "3:4") => Some("1152x1536"),
            ("1K", "5:4") => Some("1520x1216"),
            ("1K", "4:5") => Some("1216x1520"),
            ("1K", "16:9") => Some("1536x864"),
            ("1K", "9:16") => Some("864x1536"),
            ("1K", "2:1") => Some("1536x768"),
            ("1K", "1:2") => Some("768x1536"),
            ("1K", "3:1") => Some("1536x512"),
            ("1K", "1:3") => Some("512x1536"),
            ("1K", "7:4") => Some("1664x944"),
            ("1K", "4:7") => Some("944x1664"),
            ("2K", "1:1") => Some("2048x2048"),
            ("2K", "3:2") => Some("2048x1360"),
            ("2K", "2:3") => Some("1360x2048"),
            ("2K", "4:3") => Some("2048x1536"),
            ("2K", "3:4") => Some("1536x2048"),
            ("2K", "5:4") => Some("2048x1632"),
            ("2K", "4:5") => Some("1632x2048"),
            ("2K", "16:9") => Some("2048x1152"),
            ("2K", "9:16") => Some("1152x2048"),
            ("2K", "2:1") => Some("2048x1024"),
            ("2K", "1:2") => Some("1024x2048"),
            ("2K", "3:1") => Some("2048x688"),
            ("2K", "1:3") => Some("688x2048"),
            ("2K", "7:4") => Some("2208x1264"),
            ("2K", "4:7") => Some("1264x2208"),
            ("4K", "1:1") => Some("2880x2880"),
            ("4K", "3:2") => Some("3520x2352"),
            ("4K", "2:3") => Some("2352x3520"),
            ("4K", "4:3") => Some("3840x2880"),
            ("4K", "3:4") => Some("2880x3840"),
            ("4K", "5:4") => Some("3840x3072"),
            ("4K", "4:5") => Some("3072x3840"),
            ("4K", "16:9") => Some("3840x2160"),
            ("4K", "9:16") => Some("2160x3840"),
            ("4K", "2:1") => Some("3840x1920"),
            ("4K", "1:2") => Some("1920x3840"),
            ("4K", "3:1") => Some("3840x1280"),
            ("4K", "1:3") => Some("1280x3840"),
            ("4K", "7:4") => Some("3808x2176"),
            ("4K", "4:7") => Some("2176x3808"),
            _ => None,
        };

        size.map(str::to_string)
            .unwrap_or_else(|| Self::resolve_image_size(resolution, aspect_ratio))
    }

    fn resolve_image_quality(resolution: &str) -> Option<&'static str> {
        match resolution.trim().to_ascii_lowercase().as_str() {
            // The canvas labels these as output resolutions, while the OpenAI Images API expects
            // quality tiers. Keep that UI contract at the adapter boundary.
            "1k" | "low" => Some("low"),
            "2k" | "medium" => Some("medium"),
            "4k" | "high" => Some("high"),
            "auto" => Some("auto"),
            _ => None,
        }
    }

    fn response_error_message(body: &Value) -> String {
        body.pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| body.pointer("/error/type").and_then(Value::as_str))
            .or_else(|| body.get("message").and_then(Value::as_str))
            .or_else(|| body.get("error").and_then(Value::as_str))
            .unwrap_or("OpenAI-compatible image request failed")
            .to_string()
    }

    fn response_image_source(body: &Value) -> Option<String> {
        let mime_type = [
            "/data/0/media_type",
            "/data/0/mime_type",
            "/data/0/mimeType",
            "/data/0/image/media_type",
            "/data/0/image/mime_type",
        ]
        .into_iter()
        .filter_map(|pointer| body.pointer(pointer).and_then(Value::as_str))
        .find(|value| value.starts_with("image/"))
        .unwrap_or("image/png");
        for pointer in ["/data/0/b64_json", "/data/0/image/b64_json", "/data/0/base64"] {
            if let Some(base64_data) = body.pointer(pointer).and_then(Value::as_str) {
                return Some(format!("data:{};base64,{}", mime_type, base64_data));
            }
        }

        let url_pointers = [
            "/data/0/url",
            "/assets/0/signed_url",
            "/assets/0/url",
            "/output/url",
        ];
        for pointer in url_pointers {
            if let Some(url) = body.pointer(pointer).and_then(Value::as_str) {
                if !url.trim().is_empty() {
                    return Some(url.to_string());
                }
            }
        }

        None
    }

    fn response_task_id(body: &Value) -> Option<String> {
        ["task_id", "id", "request_id"]
            .into_iter()
            .filter_map(|key| body.get(key).and_then(Value::as_str))
            .map(str::trim)
            .find(|value| !value.is_empty())
            .map(str::to_string)
    }

    async fn build_edit_form(
        &self,
        request: &GenerateRequest,
        model: &str,
        async_mode: bool,
    ) -> Result<Form, AIError> {
        let is_fhl = self.protocol == OpenAiImageProtocol::Fhl;
        let mut form = if is_fhl {
            Form::new()
        } else {
            Form::new()
                .text("model", model.to_string())
                .text("prompt", request.prompt.clone())
                .text("n", "1")
        };

        form = match self.protocol {
            OpenAiImageProtocol::Standard => {
                let mut form = form.text(
                    "size",
                    Self::resolve_standard_image_size(&request.aspect_ratio),
                );
                if let Some(quality) = self.request_quality(request) {
                    form = form.text("quality", quality);
                }
                form
            }
            OpenAiImageProtocol::AiMedia => {
                let mut form = form
                    .text(
                        "size",
                        Self::resolve_image_size(&request.size, &request.aspect_ratio),
                    )
                    .text("response_format", "b64_json");
                if let Some(quality) = self.request_quality(request) {
                    form = form.text("quality", quality);
                }
                if async_mode {
                    form = form.text("async", "true");
                }
                form
            }
            OpenAiImageProtocol::Chaomo => {
                let mut form = form
                    .text("ratio", request.aspect_ratio.clone())
                    .text("response_format", "url")
                    .text("async", "true");
                if let Some(quality) = self.request_quality(request) {
                    form = form.text("quality", quality);
                }
                form
            }
            OpenAiImageProtocol::Fhl => form,
        };

        let reference_images = request.reference_images.as_deref().unwrap_or(&[]);
        for (index, source) in reference_images.iter().enumerate() {
            let image = load_reference_image(&self.client, source).await?;
            let part = Part::bytes(image.bytes)
                .file_name(format!("reference-{}.{}", index + 1, image.extension))
                .mime_str(&image.mime_type)?;
            let image_field = if self.protocol == OpenAiImageProtocol::Fhl {
                if index == 0 {
                    "image"
                } else {
                    "image[]"
                }
            } else if (self.protocol == OpenAiImageProtocol::Standard
                || self.protocol == OpenAiImageProtocol::Chaomo)
                && reference_images.len() > 1
            {
                "image[]"
            } else {
                "image"
            };
            form = form.part(image_field, part);
        }

        if is_fhl {
            form = form
                .text("prompt", request.prompt.clone())
                .text("model", model.to_string())
                .text("n", "1")
                .text(
                    "size",
                    Self::resolve_fhl_image_size(&request.size, &request.aspect_ratio),
                )
                .text("quality", "auto")
                .text("output_format", "png")
                .text("response_format", "b64_json");
        }

        Ok(form)
    }

    fn build_generation_body(
        &self,
        request: &GenerateRequest,
        model: &str,
        async_mode: bool,
    ) -> Value {
        match self.protocol {
            OpenAiImageProtocol::Standard => {
                let mut body = json!({
                    "model": model,
                    "prompt": request.prompt,
                    "size": Self::resolve_standard_image_size(&request.aspect_ratio),
                    "n": 1,
                });
                if let Some(quality) = self.request_quality(request) {
                    body["quality"] = Value::String(quality);
                }
                body
            }
            OpenAiImageProtocol::AiMedia => {
                let mut body = json!({
                    "model": model,
                    "prompt": request.prompt,
                    "size": Self::resolve_image_size(&request.size, &request.aspect_ratio),
                    "n": 1,
                    "response_format": "b64_json",
                });
                if let Some(quality) = Self::resolve_image_quality(&request.size) {
                    body["quality"] = Value::String(quality.to_string());
                }
                if async_mode {
                    body["async"] = Value::Bool(true);
                }
                body
            }
            OpenAiImageProtocol::Chaomo => {
                let mut body = json!({
                    "model": model,
                    "prompt": request.prompt,
                    "ratio": request.aspect_ratio,
                    "n": 1,
                    "response_format": "url",
                    "async": true,
                });
                if self.chaomo_uses_quality(request) {
                    body["quality"] = Value::String("medium".to_string());
                }
                body
            }
            OpenAiImageProtocol::Fhl => json!({
                "model": model,
                "prompt": request.prompt,
                "n": 1,
                "size": Self::resolve_fhl_image_size(&request.size, &request.aspect_ratio),
                "quality": "auto",
                "output_format": "png",
                "response_format": "b64_json",
            }),
        }
    }

    async fn submit_request(
        &self,
        request: &GenerateRequest,
        async_mode: bool,
    ) -> Result<(StatusCode, Value), AIError> {
        let api_key = match Self::config_value(request, "api_key") {
            Some(api_key) => api_key,
            None => self.api_key.read().await.clone().ok_or_else(|| {
                AIError::InvalidRequest("OpenAI image API key is not configured".to_string())
            })?,
        };
        let base_url = self.normalize_base_url(Self::config_value(request, "base_url"));
        let model = self.resolve_model(request);
        let has_reference_images = request
            .reference_images
            .as_ref()
            .is_some_and(|images| !images.is_empty());
        if has_reference_images
            && self.protocol == OpenAiImageProtocol::Chaomo
            && !Self::chaomo_supports_reference_images(&request.model)
        {
            return Err(AIError::InvalidRequest(format!(
                "Chaomo model '{}' only supports text-to-image generation and cannot edit reference images",
                self.resolve_model(request)
            )));
        }
        let endpoint = if has_reference_images {
            format!("{}/images/edits", base_url)
        } else {
            format!("{}/images/generations", base_url)
        };

        info!(
            "[OpenAI Image] request model={}, endpoint={}, refs={}, size={}, quality={:?}, aspect_ratio={}",
            model,
            endpoint,
            request.reference_images.as_ref().map(Vec::len).unwrap_or(0),
            request.size,
            self.request_quality(request),
            request.aspect_ratio
        );

        let response = if has_reference_images {
            let form = self.build_edit_form(request, &model, async_mode).await?;
            let builder = self.client.post(&endpoint).bearer_auth(api_key);
            let builder = if self.protocol == OpenAiImageProtocol::AiMedia {
                builder.header(
                    "Idempotency-Key",
                    format!("opencanvas-image-{}", Uuid::new_v4()),
                )
            } else {
                builder
            };
            builder.multipart(form).send().await?
        } else {
            let body = self.build_generation_body(request, &model, async_mode);
            let builder = self.client.post(&endpoint).bearer_auth(api_key);
            let builder = if self.protocol == OpenAiImageProtocol::AiMedia {
                builder.header(
                    "Idempotency-Key",
                    format!("opencanvas-image-{}", Uuid::new_v4()),
                )
            } else {
                builder
            };
            builder.json(&body).send().await?
        };

        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let body = serde_json::from_str::<Value>(&raw).map_err(|error| {
            AIError::Provider(format!(
                "OpenAI-compatible image API returned invalid JSON ({}): {}; body={}",
                status, error, raw
            ))
        })?;

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "OpenAI-compatible image API returned {}: {}",
                status,
                Self::response_error_message(&body)
            )));
        }

        Ok((status, body))
    }

    async fn download_asset(
        &self,
        api_key: &str,
        base_url: &str,
        source: &str,
    ) -> Result<String, AIError> {
        let endpoint = if source.starts_with("http://") || source.starts_with("https://") {
            source.to_string()
        } else {
            format!(
                "{}{}",
                base_url,
                if source.starts_with('/') {
                    source.to_string()
                } else {
                    format!("/{}", source)
                }
            )
        };
        let response = self
            .client
            .get(&endpoint)
            .bearer_auth(api_key)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let details = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "Failed to download generated image {}: {} {}",
                endpoint, status, details
            )));
        }
        let mime_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .filter(|value| value.starts_with("image/"))
            .unwrap_or("image/png")
            .to_string();
        let bytes = response.bytes().await?;
        Ok(format!(
            "data:{};base64,{}",
            mime_type,
            STANDARD.encode(bytes)
        ))
    }

    async fn image_from_task_body(
        &self,
        body: &Value,
        api_key: &str,
        base_url: &str,
    ) -> Result<Option<String>, AIError> {
        if let Some(source) = Self::response_image_source(body) {
            return Ok(Some(source));
        }

        let download_url = body
            .pointer("/assets/0/download_url")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        if let Some(download_url) = download_url {
            return self
                .download_asset(api_key, base_url, download_url)
                .await
                .map(Some);
        }

        Ok(None)
    }

    fn metadata_base_url(&self, handle: &ProviderTaskHandle) -> String {
        handle
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("base_url"))
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .unwrap_or_else(|| self.normalize_base_url(None))
    }

    fn metadata_status_url(handle: &ProviderTaskHandle) -> Option<String> {
        handle
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("status_url"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn task_status_url(body: &Value) -> Option<String> {
        body.get("status_url")
            .or_else(|| body.get("poll_url"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn resolve_endpoint(base_url: &str, endpoint: &str) -> String {
        if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
            endpoint.to_string()
        } else if endpoint.starts_with('/') {
            let base_origin = base_url.strip_suffix("/v1").unwrap_or(base_url);
            format!("{}{}", base_origin.trim_end_matches('/'), endpoint)
        } else {
            format!("{}/{}", base_url.trim_end_matches('/'), endpoint)
        }
    }
}

impl Default for OpenAiProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for OpenAiProvider {
    fn name(&self) -> &str {
        self.provider_id
    }

    fn supports_model(&self, model: &str) -> bool {
        self.supported_models.contains(&model)
            || (self.provider_id == AI_MEDIA_PROVIDER_ID
                && model
                    .strip_prefix("ai-media/")
                    .is_some_and(|value| !value.trim().is_empty()))
            || (self.provider_id == CHAOMO_PROVIDER_ID
                && model
                    .strip_prefix("chaomo/")
                    .is_some_and(|value| !value.trim().is_empty()))
            || (self.protocol == OpenAiImageProtocol::Chaomo
                && matches!(
                    model,
                    CHAOMO_LEGACY_DIRECT_MODEL_ID | CHAOMO_LEGACY_NATIVE_4K_MODEL_ID
                ))
            || (self.protocol == OpenAiImageProtocol::Fhl
                && model
                    .strip_prefix("fhl/")
                    .is_some_and(|value| !value.trim().is_empty()))
    }

    fn list_models(&self) -> Vec<String> {
        self.supported_models
            .iter()
            .map(|model| (*model).to_string())
            .collect()
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut stored_key = self.api_key.write().await;
        let trimmed = api_key.trim();
        *stored_key = (!trimmed.is_empty()).then(|| trimmed.to_string());
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        !matches!(
            self.protocol,
            OpenAiImageProtocol::Standard | OpenAiImageProtocol::Fhl
        )
    }

    async fn submit_task(
        &self,
        request: GenerateRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        let base_url = self.normalize_base_url(Self::config_value(&request, "base_url"));
        let async_mode = !matches!(
            self.protocol,
            OpenAiImageProtocol::Standard | OpenAiImageProtocol::Fhl
        );
        let (status, body) = self.submit_request(&request, async_mode).await?;

        if status == StatusCode::ACCEPTED {
            let task_id = Self::response_task_id(&body).ok_or_else(|| {
                AIError::Provider("Image task receipt is missing task_id".to_string())
            })?;
            let status_url = Self::task_status_url(&body);
            return Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
                task_id,
                metadata: Some(json!({
                    "base_url": base_url,
                    "status_url": status_url,
                })),
            }));
        }

        if let Some(image_source) = Self::response_image_source(&body) {
            return Ok(ProviderTaskSubmission::Succeeded(image_source));
        }

        if matches!(
            self.protocol,
            OpenAiImageProtocol::Standard | OpenAiImageProtocol::Fhl
        ) {
            return Err(AIError::Provider(
                "OpenAI-compatible image API response did not include data[0].b64_json or data[0].url"
                    .to_string(),
            ));
        }

        if let Some(task_id) = Self::response_task_id(&body) {
            let status_url = Self::task_status_url(&body);
            return Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
                task_id,
                metadata: Some(json!({
                    "base_url": base_url,
                    "status_url": status_url,
                })),
            }));
        }

        Err(AIError::Provider(
            "OpenAI-compatible image API response did not include an image or task id".to_string(),
        ))
    }

    async fn poll_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = self.api_key.read().await.clone().ok_or_else(|| {
            AIError::InvalidRequest("OpenAI image API key is not configured".to_string())
        })?;
        let base_url = self.normalize_base_url(Some(self.metadata_base_url(&handle)));
        let endpoint = match self.protocol {
            OpenAiImageProtocol::Standard | OpenAiImageProtocol::Fhl => {
                return Err(AIError::Provider(
                    "Standard OpenAI image requests do not support task polling".to_string(),
                ));
            }
            OpenAiImageProtocol::AiMedia => Self::metadata_status_url(&handle)
                .map(|value| Self::resolve_endpoint(&base_url, &value))
                .unwrap_or_else(|| {
                    format!(
                        "{}/images/tasks/{}?view=summary",
                        base_url,
                        urlencoding::encode(handle.task_id.as_str())
                    )
                }),
            OpenAiImageProtocol::Chaomo => format!(
                "{}/images/{}",
                base_url,
                urlencoding::encode(handle.task_id.as_str())
            ),
        };
        let response = self
            .client
            .get(&endpoint)
            .bearer_auth(&api_key)
            .send()
            .await?;
        let status = response.status();
        let raw = response.text().await?;
        if is_retryable_poll_status(status) {
            return Err(AIError::Transient(format!(
                "OpenAI-compatible image task poll temporarily unavailable ({})",
                status
            )));
        }
        let body = serde_json::from_str::<Value>(&raw).map_err(|error| {
            AIError::Provider(format!(
                "OpenAI-compatible image task poll returned invalid JSON ({}): {}; body={}",
                status, error, raw
            ))
        })?;
        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "OpenAI-compatible image task poll returned {}: {}",
                status,
                Self::response_error_message(&body)
            )));
        }

        let task_status = body
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        match task_status.as_str() {
            "queued" | "dispatching" | "running" | "pending_confirmation" => {
                Ok(ProviderTaskPollResult::Running)
            }
            "uncertain" => Ok(self
                .image_from_task_body(&body, &api_key, &base_url)
                .await?
                .map(ProviderTaskPollResult::Succeeded)
                .unwrap_or(ProviderTaskPollResult::Running)),
            "success" | "succeeded" | "completed" => self
                .image_from_task_body(&body, &api_key, &base_url)
                .await?
                .map(ProviderTaskPollResult::Succeeded)
                .ok_or_else(|| {
                    AIError::Provider(
                        "Completed image task did not include an image asset".to_string(),
                    )
                }),
            "failed" | "cancelled" | "canceled" => Ok(ProviderTaskPollResult::Failed(
                Self::response_error_message(&body),
            )),
            _ => Ok(ProviderTaskPollResult::Running),
        }
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        match self.submit_task(request).await? {
            ProviderTaskSubmission::Succeeded(image_source) => Ok(image_source),
            ProviderTaskSubmission::Queued(handle) => {
                for _ in 0..MAX_SYNC_POLL_ATTEMPTS {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                    match self.poll_task(handle.clone()).await? {
                        ProviderTaskPollResult::Running => continue,
                        ProviderTaskPollResult::Succeeded(image_source) => return Ok(image_source),
                        ProviderTaskPollResult::SucceededWithMeta { url, .. } => return Ok(url),
                        ProviderTaskPollResult::Failed(message) => {
                            return Err(AIError::TaskFailed(message));
                        }
                    }
                }
                Err(AIError::TaskFailed(
                    "Timed out waiting for OpenAI-compatible image task".to_string(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OpenAiProvider;
    use crate::ai::providers::image_input::reference_image;
    use crate::ai::{AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::path::Path;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn generate_request(model: &str, size: &str, aspect_ratio: &str) -> GenerateRequest {
        GenerateRequest {
            prompt: "generate an image".to_string(),
            model: model.to_string(),
            provider_id: None,
            size: size.to_string(),
            aspect_ratio: aspect_ratio.to_string(),
            reference_images: None,
            video_content: None,
            extra_params: None,
            provider_config: None,
            draft_task_id: None,
        }
    }

    async fn read_http_request(socket: &mut TcpStream) -> Vec<u8> {
        let mut request_bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let (header_end, content_length) = loop {
            let bytes_read = socket.read(&mut buffer).await.unwrap();
            assert!(bytes_read > 0, "connection closed before request headers");
            request_bytes.extend_from_slice(&buffer[..bytes_read]);

            if let Some(header_start) = request_bytes
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
            {
                let headers = String::from_utf8_lossy(&request_bytes[..header_start]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                break (header_start + 4, content_length);
            }
        };

        while request_bytes.len() < header_end + content_length {
            let bytes_read = socket.read(&mut buffer).await.unwrap();
            assert!(bytes_read > 0, "connection closed before request body");
            request_bytes.extend_from_slice(&buffer[..bytes_read]);
        }

        request_bytes
    }

    async fn write_json_response(socket: &mut TcpStream, status: &str, body: &str) {
        socket
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    #[test]
    fn reference_image_uses_detected_jpeg_type_over_incorrect_png_label() {
        let image = reference_image(
            vec![0xff, 0xd8, 0xff, 0xe0],
            Some("image/png"),
            Some(Path::new("reference.png")),
        );

        assert_eq!(image.mime_type, "image/jpeg");
        assert_eq!(image.extension, "jpg");
    }

    #[test]
    fn reference_image_uses_local_file_extension_when_content_is_unknown() {
        let image = reference_image(
            vec![0x00, 0x01],
            None,
            Some(Path::new("reference.webp")),
        );

        assert_eq!(image.mime_type, "image/webp");
        assert_eq!(image.extension, "webp");
    }

    #[test]
    fn maps_canvas_resolution_labels_to_ai_media_quality_tiers() {
        assert_eq!(OpenAiProvider::resolve_image_quality("1K"), Some("low"));
        assert_eq!(OpenAiProvider::resolve_image_quality("2K"), Some("medium"));
        assert_eq!(OpenAiProvider::resolve_image_quality("4K"), Some("high"));
        assert_eq!(OpenAiProvider::resolve_image_quality("auto"), Some("auto"));
        assert_eq!(OpenAiProvider::resolve_image_quality("1024x1024"), None);
    }

    #[test]
    fn maps_ai_media_resolution_and_ratio_to_pixel_size() {
        assert_eq!(OpenAiProvider::resolve_image_size("1K", "1:1"), "1024x1024");
        assert_eq!(
            OpenAiProvider::resolve_image_size("2K", "16:9"),
            "2048x1152"
        );
        assert_eq!(OpenAiProvider::resolve_image_size("4K", "4:3"), "4096x3072");
        assert_eq!(
            OpenAiProvider::resolve_image_size("2048x1536", "1:1"),
            "2048x1536"
        );
    }

    #[test]
    fn ai_media_generation_sends_pixel_size_and_mapped_quality() {
        let provider = OpenAiProvider::ai_media();
        let request = generate_request("ai-media/gpt-image-2", "4K", "4:3");
        let body = provider.build_generation_body(&request, "gpt-image-2", true);

        assert_eq!(body["size"], "4096x3072");
        assert_eq!(body["quality"], "high");
        assert!(body.get("ratio").is_none());
        assert_eq!(body["response_format"], "b64_json");
        assert_eq!(body["async"], true);
    }

    #[tokio::test]
    async fn ai_media_uncertain_task_uses_an_available_asset_without_resubmission() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut pending_socket, _) = listener.accept().await.unwrap();
            let pending_request = read_http_request(&mut pending_socket).await;
            write_json_response(
                &mut pending_socket,
                "200 OK",
                r#"{"task_id":"imgtask-123","status":"uncertain","image_succeeded":0,"assets":[]}"#,
            )
            .await;
            drop(pending_socket);

            let (mut asset_socket, _) = listener.accept().await.unwrap();
            let asset_request = read_http_request(&mut asset_socket).await;
            write_json_response(
                &mut asset_socket,
                "200 OK",
                r#"{"task_id":"imgtask-123","status":"uncertain","image_succeeded":1,"assets":[{"signed_url":"https://assets.example/generated.png"}]}"#,
            )
            .await;

            (pending_request, asset_request)
        });

        let provider = OpenAiProvider::ai_media();
        provider.set_api_key("test-key".to_string()).await.unwrap();
        let handle = ProviderTaskHandle {
            task_id: "imgtask-123".to_string(),
            metadata: Some(json!({
                "base_url": format!("http://{address}/v1"),
                "status_url": "/v1/images/tasks/imgtask-123?view=summary",
            })),
        };

        assert!(matches!(
            provider.poll_task(handle.clone()).await.unwrap(),
            ProviderTaskPollResult::Running
        ));
        assert!(matches!(
            provider.poll_task(handle).await.unwrap(),
            ProviderTaskPollResult::Succeeded(source)
                if source == "https://assets.example/generated.png"
        ));

        let (pending_request, asset_request) = server.await.unwrap();
        for request in [pending_request, asset_request] {
            let request_text = String::from_utf8_lossy(&request);
            assert!(
                request_text.starts_with("GET /v1/images/tasks/imgtask-123?view=summary HTTP/1.1")
            );
        }
    }

    #[test]
    fn standard_generation_uses_openai_fields_without_async_extensions() {
        let provider = OpenAiProvider::legacy();
        let request = generate_request("openai/vendor/image-model", "4K", "16:9");
        let body = provider.build_generation_body(&request, "vendor/image-model", false);

        assert_eq!(provider.resolve_model(&request), "vendor/image-model");
        assert_eq!(body["model"], "vendor/image-model");
        assert_eq!(body["size"], "1536x1024");
        assert_eq!(body["quality"], "high");
        assert!(body.get("async").is_none());
        assert!(body.get("response_format").is_none());
        assert!(!provider.supports_task_resume());
    }

    #[test]
    fn fhl_maps_canvas_resolution_to_its_tested_pixel_matrix() {
        assert_eq!(
            OpenAiProvider::resolve_fhl_image_size("4K", "1:1"),
            "2880x2880"
        );
        assert_eq!(
            OpenAiProvider::resolve_fhl_image_size("4K", "16:9"),
            "3840x2160"
        );
        assert_eq!(
            OpenAiProvider::resolve_fhl_image_size("2K", "4:3"),
            "2048x1536"
        );
        assert_eq!(
            OpenAiProvider::resolve_fhl_image_size("1152x2048", "9:16"),
            "1152x2048"
        );
    }

    #[test]
    fn fhl_generation_uses_images_api_fields_and_synchronous_mode() {
        let provider = OpenAiProvider::fhl();
        let request = generate_request("fhl/gpt-image-2", "4K", "16:9");
        let body = provider.build_generation_body(&request, "gpt-image-2", false);

        assert_eq!(body["model"], "gpt-image-2");
        assert_eq!(body["size"], "3840x2160");
        assert_eq!(body["quality"], "auto");
        assert_eq!(body["output_format"], "png");
        assert_eq!(body["response_format"], "b64_json");
        assert!(body.get("aspect_ratio").is_none());
        assert!(body.get("async").is_none());
        assert!(!provider.supports_task_resume());
        assert_eq!(provider.list_models(), vec!["fhl/gpt-image-2".to_string()]);
        assert_eq!(
            provider.normalize_base_url(Some("https://www.fhl.mom".to_string())),
            "https://www.fhl.mom/v1"
        );
    }

    #[tokio::test]
    async fn fhl_generation_posts_the_expected_images_api_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            write_json_response(
                &mut socket,
                "200 OK",
                r#"{"data":[{"b64_json":"AQID"}]}"#,
            )
            .await;
            request
        });

        let provider = OpenAiProvider::fhl();
        let mut request = generate_request("fhl/gpt-image-2", "4K", "16:9");
        request.provider_config = Some(HashMap::from([
            (
                "base_url".to_string(),
                json!(format!("http://{address}")),
            ),
            ("api_key".to_string(), json!("test-key")),
        ]));

        let submission = provider.submit_task(request).await.unwrap();
        assert!(matches!(
            submission,
            crate::ai::ProviderTaskSubmission::Succeeded(source)
                if source == "data:image/png;base64,AQID"
        ));

        let request = server.await.unwrap();
        let request_text = String::from_utf8_lossy(&request);
        assert!(request_text.starts_with("POST /v1/images/generations HTTP/1.1"));
        let body_start = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("JSON request should have a body separator")
            + 4;
        let body: Value = serde_json::from_slice(&request[body_start..]).unwrap();
        assert_eq!(body["model"], "gpt-image-2");
        assert_eq!(body["size"], "3840x2160");
        assert_eq!(body["quality"], "auto");
        assert_eq!(body["output_format"], "png");
        assert_eq!(body["response_format"], "b64_json");
        assert!(body.get("aspect_ratio").is_none());
        assert!(body.get("async").is_none());
    }

    #[tokio::test]
    async fn fhl_edit_uses_mixed_reference_field_names() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            write_json_response(
                &mut socket,
                "200 OK",
                r#"{"data":[{"b64_json":"AQID"}]}"#,
            )
            .await;
            request
        });

        let provider = OpenAiProvider::fhl();
        let mut request = generate_request("fhl/gpt-image-2", "4K", "1:1");
        request.provider_config = Some(HashMap::from([
            (
                "base_url".to_string(),
                json!(format!("http://{address}")),
            ),
            ("api_key".to_string(), json!("test-key")),
        ]));
        request.reference_images = Some(vec![
            "data:image/png;base64,AQID".to_string(),
            "data:image/jpeg;base64,BAUG".to_string(),
        ]);

        let submission = provider.submit_task(request).await.unwrap();
        assert!(matches!(
            submission,
            crate::ai::ProviderTaskSubmission::Succeeded(_)
        ));

        let request = server.await.unwrap();
        let request_text = String::from_utf8_lossy(&request);
        assert!(request_text.starts_with("POST /v1/images/edits HTTP/1.1"));
        assert!(request_text.contains("name=\"image\""));
        assert!(request_text.contains("name=\"image[]\""));
        assert!(request_text.contains("name=\"size\""));
        assert!(request_text.contains("2880x2880"));
        assert!(request_text.contains("name=\"quality\""));
        assert!(request_text.contains("\r\n\r\nauto\r\n"));
        assert!(request_text.contains("name=\"output_format\""));
        assert!(request_text.contains("\r\n\r\npng\r\n"));
        assert!(request_text.contains("name=\"response_format\""));
        assert!(request_text.contains("\r\n\r\nb64_json\r\n"));
    }

    #[test]
    fn chaomo_generation_uses_ratio_and_its_own_quality_rules() {
        let provider = OpenAiProvider::chaomo();
        let direct_request = generate_request("chaomo/gpt-image-2-direct", "4K", "4:3");
        let direct_body =
            provider.build_generation_body(&direct_request, "gpt-image2-4K-Direct", true);

        assert_eq!(direct_body["ratio"], "4:3");
        assert_eq!(direct_body["quality"], "medium");
        assert!(direct_body.get("size").is_none());
        assert_eq!(direct_body["response_format"], "url");

        let native_request = generate_request("chaomo/gpt-image-2-4k-native", "4K", "16:9");
        let native_body = provider.build_generation_body(&native_request, "gpt-image2-4K", true);

        assert_eq!(native_body["ratio"], "16:9");
        assert!(native_body.get("quality").is_none());
        assert!(native_body.get("size").is_none());
    }

    #[test]
    fn chaomo_lists_all_documented_image_models() {
        let provider = OpenAiProvider::chaomo();
        let models = provider.list_models();

        assert_eq!(models.len(), 10);
        for model in [
            "chaomo/gpt-image2-1K",
            "chaomo/gpt-image2-1K-Hight",
            "chaomo/gpt-image2-2K-Hight",
            "chaomo/gpt-image2-4K-Hight",
            "chaomo/gpt-image2-2K-Direct",
            "chaomo/gpt-image2-4K-Stable",
            "chaomo/gpt-image2-4K-Direct",
            "chaomo/gpt-image2-4K",
            "chaomo/nano-banana-2",
            "chaomo/nano-banana-pro",
        ] {
            assert!(
                models.iter().any(|candidate| candidate == model),
                "missing {model}"
            );
        }
    }

    #[test]
    fn chaomo_sends_new_model_ids_verbatim() {
        let provider = OpenAiProvider::chaomo();
        for (model, expected) in [
            ("chaomo/gpt-image2-1K", "gpt-image2-1K"),
            ("chaomo/gpt-image2-2K-Hight", "gpt-image2-2K-Hight"),
            ("chaomo/gpt-image2-4K-Stable", "gpt-image2-4K-Stable"),
            ("chaomo/gpt-image2-4K-Direct", "gpt-image2-4K-Direct"),
            ("chaomo/gpt-image2-4K", "gpt-image2-4K"),
            ("chaomo/nano-banana-pro", "nano-banana-pro"),
        ] {
            let request = generate_request(model, "4K", "16:9");
            assert_eq!(provider.resolve_model(&request), expected);
        }
    }

    #[test]
    fn chaomo_hight_models_do_not_send_quality() {
        let provider = OpenAiProvider::chaomo();
        let request = generate_request("chaomo/gpt-image2-2K-Hight", "2K", "1:1");
        let body = provider.build_generation_body(&request, "gpt-image2-2K-Hight", true);

        assert_eq!(body["model"], "gpt-image2-2K-Hight");
        assert_eq!(body["ratio"], "1:1");
        assert!(body.get("quality").is_none());
    }

    #[test]
    fn resolves_documented_relative_status_url_against_api_origin() {
        assert_eq!(
            OpenAiProvider::resolve_endpoint(
                "https://api.ai-media.vip/v1",
                "/v1/images/tasks/imgtask_123?view=summary",
            ),
            "https://api.ai-media.vip/v1/images/tasks/imgtask_123?view=summary"
        );
    }

    #[test]
    fn resolves_path_relative_status_url_against_configured_base_url() {
        assert_eq!(
            OpenAiProvider::resolve_endpoint(
                "https://example.com/v1",
                "images/tasks/imgtask_123?view=summary",
            ),
            "https://example.com/v1/images/tasks/imgtask_123?view=summary"
        );
    }

    #[tokio::test]
    async fn edit_form_serializes_detected_jpeg_metadata() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request_bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (header_end, content_length) = loop {
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                assert!(bytes_read > 0, "connection closed before request headers");
                request_bytes.extend_from_slice(&buffer[..bytes_read]);

                if let Some(header_end) = request_bytes
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&request_bytes[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .expect("multipart request should include content-length");
                    break (header_end + 4, content_length);
                }
            };

            while request_bytes.len() < header_end + content_length {
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                assert!(bytes_read > 0, "connection closed before request body");
                request_bytes.extend_from_slice(&buffer[..bytes_read]);
            }

            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
            request_bytes
        });

        let provider = OpenAiProvider::ai_media();
        let request = GenerateRequest {
            prompt: "edit the image".to_string(),
            model: "ai-media/gpt-image-2".to_string(),
            provider_id: None,
            size: "4K".to_string(),
            aspect_ratio: "3:2".to_string(),
            reference_images: Some(vec!["data:image/png;base64,/9j/4A==".to_string()]),
            video_content: None,
            extra_params: None,
            provider_config: None,
            draft_task_id: None,
        };
        let form = provider
            .build_edit_form(&request, "gpt-image-2", true)
            .await
            .unwrap();
        let response = provider
            .client
            .post(format!("http://{address}/v1/images/edits"))
            .multipart(form)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());

        let request_bytes = server.await.unwrap();
        let serialized_request = String::from_utf8_lossy(&request_bytes);
        assert!(serialized_request.contains("name=\"image\""));
        assert!(serialized_request.contains("filename=\"reference-1.jpg\""));
        assert!(serialized_request.contains("Content-Type: image/jpeg"));
        assert!(serialized_request.contains("name=\"size\""));
        assert!(serialized_request.contains("\r\n\r\n4096x2731\r\n"));
        assert!(serialized_request.contains("name=\"quality\""));
        assert!(serialized_request.contains("\r\n\r\nhigh\r\n"));
    }
}
