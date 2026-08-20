use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{AIProvider, GenerateRequest};

const API_BASE_URL: &str = "https://arker-8b16.open.bigx.cn";
const CHAT_PATH: &str = "/api/codingbot/chatv/chat/completions";
const IMAGE_CHAT_PATH: &str = "/api/codingbot/chatv/extensions/chat/completions";

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: ChatContent,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ChatContent {
    Text(String),
    Array(Vec<ContentPart>),
}

#[derive(Debug, Serialize)]
struct ContentPart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<ImageUrl>,
}

#[derive(Debug, Serialize)]
struct ImageUrl {
    url: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Option<Vec<Choice>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Option<ResponseMessage>,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ImageChatResponse {
    choices: Option<Vec<ImageChoice>>,
}

#[derive(Debug, Deserialize)]
struct ImageChoice {
    message: Option<ImageResponseMessage>,
}

#[derive(Debug, Deserialize)]
struct ImageResponseMessage {
    content: Option<String>,
}

fn sanitize_model(model: &str) -> String {
    model
        .split_once('/')
        .map(|(_, bare)| bare.to_string())
        .unwrap_or_else(|| model.to_string())
}

pub struct CodingPlanProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl CodingPlanProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
        }
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

    fn source_to_url(source: &str) -> Result<String, String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("source is empty".to_string());
        }

        // Data URL with base64
        if trimmed.starts_with("data:") {
            return Err("data URLs not supported, use HTTP URLs or local file paths".to_string());
        }

        // HTTP URLs - pass through directly
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Ok(trimmed.to_string());
        }

        // Local file path - convert to file:// URL
        if trimmed.contains("://") && !trimmed.starts_with("file://") {
            return Err(format!("unsupported protocol: {}", trimmed));
        }

        let path = if trimmed.starts_with("file://") {
            Self::decode_file_url_path(trimmed)
        } else {
            trimmed.to_string()
        };

        // Convert to absolute file URL
        let path_buf = std::path::PathBuf::from(&path);
        if path_buf.is_absolute() {
            Ok(format!("file://{}", path))
        } else {
            // Try to get absolute path
            std::fs::canonicalize(&path_buf)
                .map(|p| format!("file://{}", p.to_string_lossy()))
                .map_err(|_| format!("failed to resolve path: {}", path))
        }
    }

    async fn chat(
        &self,
        api_key: &str,
        request: &GenerateRequest,
    ) -> Result<String, AIError> {
        let model = sanitize_model(&request.model);
        let has_reference = request
            .reference_images
            .as_deref()
            .map(|r| !r.is_empty())
            .unwrap_or(false);

        let endpoint = if has_reference {
            format!("{}{}", API_BASE_URL, IMAGE_CHAT_PATH)
        } else {
            format!("{}{}", API_BASE_URL, CHAT_PATH)
        };

        // Build messages
        let mut messages = Vec::new();

        // System prompt for prompt polishing
        let system_content = if has_reference {
            "你是一个提示词润色专家。根据用户提供的图片和原始提示词，生成一个更好的提示词。直接返回润色后的提示词，不需要解释。"
        } else {
            "你是一个提示词润色专家。根据用户提供的原始提示词，生成一个更好的提示词。直接返回润色后的提示词，不需要解释。"
        };

        messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(system_content.to_string()),
        });

        // Build user content
        let user_content = if has_reference {
            let mut parts = Vec::new();

            // Add reference images
            for (i, img_source) in request.reference_images.as_ref().unwrap_or(&vec![]).iter().enumerate() {
                match Self::source_to_url(img_source) {
                    Ok(url) => {
                        parts.push(ContentPart {
                            part_type: "image_url".to_string(),
                            text: None,
                            image_url: Some(ImageUrl { url }),
                        });
                    }
                    Err(e) => {
                        info!("[CodingPlan] skip invalid image {}: {}", i, e);
                    }
                }
            }

            // Add text with prompt
            let text_part = format!("请润色这个提示词：{}", request.prompt);
            parts.push(ContentPart {
                part_type: "text".to_string(),
                text: Some(text_part),
                image_url: None,
            });

            ChatContent::Array(parts)
        } else {
            ChatContent::Text(format!("请润色这个提示词：{}", request.prompt))
        };

        messages.push(ChatMessage {
            role: "user".to_string(),
            content: user_content,
        });

        let body = ChatRequest {
            model: model.clone(),
            messages,
            stream: Some(false),
            max_tokens: Some(2048),
            temperature: Some(0.7),
        };

        info!(
            "[CodingPlan] request: model={}, has_ref={}, prompt_len={}",
            model,
            has_reference,
            request.prompt.len()
        );

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "CodingPlan API failed {}: {}",
                status, raw_response
            )));
        }

        // Parse response based on endpoint type
        if has_reference {
            let resp: ImageChatResponse = serde_json::from_str(&raw_response)
                .map_err(|err| AIError::Provider(format!("CodingPlan parse error: {}", err)))?;
            if let Some(choices) = resp.choices {
                if let Some(choice) = choices.first() {
                    if let Some(msg) = &choice.message {
                        if let Some(content) = &msg.content {
                            return Ok(content.clone());
                        }
                    }
                }
            }
            Err(AIError::Provider("CodingPlan response has no content".to_string()))
        } else {
            let resp: ChatResponse = serde_json::from_str(&raw_response)
                .map_err(|err| AIError::Provider(format!("CodingPlan parse error: {}", err)))?;
            if let Some(error) = resp.error {
                let msg = error.get("message").and_then(|v| v.as_str()).unwrap_or("Unknown error");
                return Err(AIError::Provider(format!("CodingPlan error: {}", msg)));
            }
            if let Some(choices) = resp.choices {
                if let Some(choice) = choices.first() {
                    if let Some(msg) = &choice.message {
                        if let Some(content) = &msg.content {
                            return Ok(content.clone());
                        }
                    }
                }
            }
            Err(AIError::Provider("CodingPlan response has no content".to_string()))
        }
    }
}

impl Default for CodingPlanProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for CodingPlanProvider {
    fn name(&self) -> &str {
        "codingplan"
    }

    fn supports_model(&self, model: &str) -> bool {
        matches!(
            sanitize_model(model).as_str(),
            "codingplan"
        )
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "codingplan/codingplan".to_string(),
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

        self.chat(&api_key, &request).await
    }
}
