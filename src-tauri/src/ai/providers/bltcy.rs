use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest,
};

const TASK_BASE_URL: &str = "https://api.bltcy.ai";

// Edits endpoint
const EDITS_ENDPOINT: &str = "/v1/images/edits";

// OpenAI DALL-E style response format
#[derive(Debug, Deserialize)]
struct BltcyDataItem {
    url: Option<String>,
    #[allow(dead_code)]
    b64_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BltcyDallEResponse {
    #[allow(dead_code)]
    created: Option<u64>,
    data: Option<Vec<BltcyDataItem>>,
    error: Option<BltcyError>,
}

#[derive(Debug, Deserialize)]
struct BltcyError {
    message: Option<String>,
}

pub struct BltcyProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl BltcyProvider {
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

    /// Read image bytes from source
    fn source_to_bytes(source: &str) -> Result<Vec<u8>, String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("source is empty".to_string());
        }

        // Data URL with base64
        if let Some((meta, payload)) = trimmed.split_once(',') {
            if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
                return STANDARD
                    .decode(payload)
                    .map_err(|err| format!("invalid data-url base64 payload: {}", err));
            }
        }

        // HTTP URLs - return as-is (let the API handle it)
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Err("HTTP URLs not supported for BLTCY, use local files".to_string());
        }

        // Unsupported protocols
        if trimmed.contains("://") && !trimmed.starts_with("file://") {
            return Err(format!("unsupported protocol in source: {}", trimmed));
        }

        // Local file path - read actual bytes
        let path = if trimmed.starts_with("file://") {
            PathBuf::from(Self::decode_file_url_path(trimmed))
        } else {
            PathBuf::from(trimmed)
        };

        std::fs::read(&path).map_err(|err| {
            format!("failed to read path \"{}\": {}", path.to_string_lossy(), err)
        })
    }

    /// Convert source to file:// path string (for logging)
    fn source_to_file_url(source: &str) -> String {
        let trimmed = source.trim();
        if trimmed.starts_with("file://") {
            return trimmed.to_string();
        }
        if !trimmed.contains("://") {
            return format!("file://{}", trimmed);
        }
        trimmed.to_string()
    }

    /// Parse OpenAI DALL-E style response
    fn parse_response(raw: &str) -> Result<String, String> {
        let response: BltcyDallEResponse = serde_json::from_str(raw)
            .map_err(|err| format!("failed to parse JSON: {}", err))?;

        if let Some(error) = response.error {
            return Err(error.message.unwrap_or_else(|| "Unknown error".to_string()));
        }

        if let Some(data) = response.data {
            if let Some(item) = data.first() {
                // Prefer URL, fall back to base64
                if let Some(url) = &item.url {
                    return Ok(url.clone());
                }
                if let Some(b64) = &item.b64_json {
                    return Ok(format!("data:image/png;base64,{}", b64));
                }
            }
        }

        Err(format!("No image URL in response: {}", raw))
    }

    /// Generate using Edits endpoint
    /// API spec: model, prompt, image (binary), aspect_ratio, response_format
    /// nano-banana uses aspect_ratio only; gemini-3.1-flash-image-preview uses image_size
    async fn generate_edits(
        &self,
        api_key: &str,
        request: &GenerateRequest,
        model: &str,
        reference_images: Vec<Vec<u8>>,
    ) -> Result<String, AIError> {
        let endpoint = format!("{}{}", TASK_BASE_URL, EDITS_ENDPOINT);

        // Build multipart form data per OpenAPI spec
        let mut form = Form::new()
            .text("model", model.to_string())
            .text("prompt", request.prompt.clone())
            .text("aspect_ratio", request.aspect_ratio.clone())
            .text("response_format", "url".to_string());

        // gemini-3.1-flash-image-preview uses image_size parameter
        if model == "gemini-3.1-flash-image-preview" && !request.size.is_empty() {
            form = form.text("image_size", request.size.clone());
        }

        // Add reference images as binary data
        // API accepts multiple image parts or empty string for text-to-image
        if reference_images.is_empty() {
            // Text-to-image: send empty string for image field
            let part = Part::text("".to_string()).file_name("image.txt");
            form = form.part("image", part);
        } else {
            // Image-to-image: send each reference image as binary part
            for (i, image_bytes) in reference_images.iter().enumerate() {
                let file_name = format!("reference_{}.png", i);
                let part = Part::bytes(image_bytes.clone())
                    .file_name(file_name)
                    .mime_str("image/png").map_err(|e| {
                        AIError::InvalidRequest(format!("invalid mime type: {}", e))
                    })?;
                form = form.part("image", part);
            }
        }

        info!("[BLTCY Edits Request] model: {}, aspect_ratio: {}, size: {}, refs: {:?}",
            model,
            request.aspect_ratio,
            request.size,
            reference_images.len()
        );

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .multipart(form)
            .send()
            .await?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        info!("[BLTCY Edits Response] status: {}, body: {}", status, raw_response);

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "BLTCY Edits failed {}: {}",
                status, raw_response
            )));
        }

        Self::parse_response(&raw_response)
            .map_err(|err| AIError::Provider(format!("BLTCY Edits parse error: {}", err)))
    }
}

impl Default for BltcyProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for BltcyProvider {
    fn name(&self) -> &str {
        "bltcy"
    }

    fn supports_model(&self, model: &str) -> bool {
        matches!(
            Self::sanitize_model(model).as_str(),
            "nano-banana" | "gemini-3.1-flash-image-preview"
        )
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "bltcy/nano-banana".to_string(),
            "bltcy/gemini-3.1-flash-image-preview".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;
        let model = Self::sanitize_model(&request.model);

        // Log raw request info
        let raw_refs = request.reference_images.as_deref().unwrap_or(&[]);
        info!("[BLTCY Generate] model: {}, prompt: {}, raw_refs count: {}",
            model, request.prompt, raw_refs.len());
        if !raw_refs.is_empty() {
            info!("[BLTCY Generate] raw ref images: {:?}", raw_refs);
        }

        // Convert sources to image bytes
        let reference_images: Result<Vec<Vec<u8>>, _> = request
            .reference_images
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .take(10)
            .map(|source| Self::source_to_bytes(source))
            .collect();

        let reference_images = reference_images
            .map_err(|e| AIError::InvalidRequest(e))?;

        // Log file paths for debugging (not sent to API)
        let _ref_paths: Vec<String> = request
            .reference_images
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .take(10)
            .map(|source| Self::source_to_file_url(source))
            .collect();

        info!("[BLTCY Generate] processed_refs count: {}, bytes_total: {}",
            reference_images.len(),
            reference_images.iter().map(|b| b.len()).sum::<usize>());

        self.generate_edits(&api_key, &request, &model, reference_images)
            .await
    }
}
