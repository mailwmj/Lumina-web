use async_trait::async_trait;
use chrono::Utc;
use serde::Serialize;
use std::time::Duration;
use tokio::runtime::Handle;
use tracing::info;
use uuid::Uuid;
use ve_tos_rust_sdk::asynchronous::auth::SignerAPI;
use ve_tos_rust_sdk::asynchronous::object::ObjectAPI;
use ve_tos_rust_sdk::asynchronous::tos::{self, AsyncRuntime, TosClient};
use ve_tos_rust_sdk::auth::PreSignedURLInput;
use ve_tos_rust_sdk::object::PutObjectFromBufferInput;

use super::source::ResolvedMedia;

const DEFAULT_REGION: &str = "cn-beijing";
const DEFAULT_ENDPOINT: &str = "https://tos-cn-beijing.volces.com";
const DEFAULT_URL_TTL_SECONDS: u64 = 3_600;
const MAX_URL_TTL_SECONDS: u64 = 86_400;
const BUNDLED_TOS_BUCKET: Option<&str> = option_env!("LUMINA_BUNDLED_TOS_BUCKET");
const BUNDLED_TOS_REGION: Option<&str> = option_env!("LUMINA_BUNDLED_TOS_REGION");
const BUNDLED_TOS_ENDPOINT: Option<&str> = option_env!("LUMINA_BUNDLED_TOS_ENDPOINT");
const BUNDLED_TOS_ACCESS_KEY: Option<&str> = option_env!("LUMINA_BUNDLED_TOS_ACCESS_KEY");
const BUNDLED_TOS_SECRET_KEY: Option<&str> = option_env!("LUMINA_BUNDLED_TOS_SECRET_KEY");
const BUNDLED_TOS_URL_TTL_SECONDS: Option<&str> = option_env!("LUMINA_BUNDLED_TOS_URL_TTL_SECONDS");

#[derive(Debug, Clone)]
pub struct TokioTosRuntime;

impl Default for TokioTosRuntime {
    fn default() -> Self {
        Self
    }
}

#[async_trait]
impl AsyncRuntime for TokioTosRuntime {
    type JoinError = tokio::task::JoinError;

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }

    fn spawn<'a, F>(
        &self,
        future: F,
    ) -> futures_core::future::BoxFuture<'a, Result<F::Output, Self::JoinError>>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        Box::pin(Handle::current().spawn(future))
    }

    fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        Handle::current().block_on(future)
    }
}

#[derive(Debug, Clone)]
pub struct TosConfig {
    pub bucket: String,
    pub region: String,
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    pub security_token: Option<String>,
    pub url_ttl_seconds: u64,
}

impl TosConfig {
    pub fn from_environment() -> Result<Self, String> {
        let bucket = required_config_value(
            BUNDLED_TOS_BUCKET,
            "LUMINA_TOS_BUCKET",
            "LUMINA_EMBEDDED_TOS_BUCKET",
        )?;
        let access_key = required_config_value(
            BUNDLED_TOS_ACCESS_KEY,
            "LUMINA_TOS_ACCESS_KEY",
            "LUMINA_EMBEDDED_TOS_ACCESS_KEY",
        )?;
        let secret_key = required_config_value(
            BUNDLED_TOS_SECRET_KEY,
            "LUMINA_TOS_SECRET_KEY",
            "LUMINA_EMBEDDED_TOS_SECRET_KEY",
        )?;
        let region = config_value(BUNDLED_TOS_REGION, "LUMINA_TOS_REGION")
            .unwrap_or_else(|| DEFAULT_REGION.to_string());
        let endpoint = config_value(BUNDLED_TOS_ENDPOINT, "LUMINA_TOS_ENDPOINT")
            .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
        let security_token = std::env::var("LUMINA_TOS_SECURITY_TOKEN")
            .ok()
            .filter(|value| !value.is_empty());
        let url_ttl_seconds =
            config_value(BUNDLED_TOS_URL_TTL_SECONDS, "LUMINA_TOS_URL_TTL_SECONDS")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(DEFAULT_URL_TTL_SECONDS)
                .clamp(60, MAX_URL_TTL_SECONDS);

        Ok(Self {
            bucket,
            region,
            endpoint,
            access_key,
            secret_key,
            security_token,
            url_ttl_seconds,
        })
    }
}

fn required_config_value(
    bundled: Option<&str>,
    runtime_variable: &str,
    build_variable: &str,
) -> Result<String, String> {
    config_value(bundled, runtime_variable).ok_or_else(|| {
        format!(
            "未配置 TOS 凭证：请在启动时设置 {runtime_variable}，或在打包前设置 {build_variable}"
        )
    })
}

fn config_value(bundled: Option<&str>, runtime_variable: &str) -> Option<String> {
    bundled
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            std::env::var(runtime_variable)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TosUploadResult {
    pub key: String,
    pub url: String,
    pub expires_at: i64,
    pub content_type: String,
    pub size_bytes: u64,
}

pub async fn upload_media(
    media: ResolvedMedia,
    project_id: Option<&str>,
) -> Result<TosUploadResult, String> {
    let config = TosConfig::from_environment()?;
    let key = build_object_key(project_id, &media.extension);
    let mut input = PutObjectFromBufferInput::new_with_content(&config.bucket, &key, &media.bytes);
    input.set_content_type(media.content_type.clone());
    input.set_cache_control("private, max-age=0, no-cache");

    let client = build_client(&config)?;
    client
        .put_object_from_buffer(&input)
        .await
        .map_err(|error| format!("TOS 上传失败: {error:?}"))?;

    let url = generate_get_url(&config, &key).await?;
    let expires_at = Utc::now().timestamp() + config.url_ttl_seconds as i64;
    info!(target: "lumina::storage", key = %key, bytes = media.bytes.len(), "uploaded media to TOS");

    Ok(TosUploadResult {
        key,
        url,
        expires_at,
        content_type: media.content_type,
        size_bytes: media.bytes.len() as u64,
    })
}

fn build_client(config: &TosConfig) -> Result<impl TosClient, String> {
    let mut builder = tos::builder::<TokioTosRuntime>()
        .connection_timeout(10_000)
        .request_timeout(120_000)
        .max_retry_count(3)
        .ak(config.access_key.clone())
        .sk(config.secret_key.clone())
        .region(config.region.clone())
        .endpoint(config.endpoint.clone());
    if let Some(token) = &config.security_token {
        builder = builder.security_token(token.clone());
    }
    builder
        .build()
        .map_err(|error| format!("TOS 客户端初始化失败: {error:?}"))
}

async fn generate_get_url(config: &TosConfig, key: &str) -> Result<String, String> {
    let mut input = PreSignedURLInput::new_with_key(&config.bucket, key);
    input.set_http_method(ve_tos_rust_sdk::enumeration::HttpMethodType::HttpMethodGet);
    input.set_expires(config.url_ttl_seconds as i64);
    let client = build_client(config)?;
    let output = client
        .pre_signed_url(&input)
        .await
        .map_err(|error| format!("TOS 预签名失败: {error:?}"))?;
    Ok(output.signed_url().to_string())
}

fn build_object_key(project_id: Option<&str>, extension: &str) -> String {
    let project = project_id
        .map(|value| sanitize_segment(value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unassigned".to_string());
    format!(
        "lumina/{project}/staging/{}/input.{}",
        Uuid::new_v4(),
        sanitize_segment(extension)
    )
}

fn sanitize_segment(value: &str) -> String {
    let normalized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    normalized.trim_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use super::{build_object_key, config_value};
    use ve_tos_rust_sdk::asynchronous::bucket::BucketAPI;
    use ve_tos_rust_sdk::bucket::HeadBucketInput;

    #[test]
    fn object_keys_are_scoped_and_do_not_use_original_names() {
        let key = build_object_key(Some("project/one"), "mp4");
        assert!(key.starts_with("lumina/project_one/staging/"));
        assert!(key.ends_with("/input.mp4"));
    }

    #[test]
    fn bundled_value_takes_priority_over_runtime_value() {
        assert_eq!(
            config_value(Some(" bundled-value "), "LUMINA_TEST_VALUE"),
            Some("bundled-value".to_string())
        );
    }

    #[tokio::test]
    #[ignore = "requires a real TOS bucket and LUMINA_TOS_* credentials"]
    async fn checks_live_tos_bucket_connection() {
        let config = super::TosConfig::from_environment().expect("TOS configuration is required");
        let client = super::build_client(&config).expect("TOS client should initialize");
        client
            .head_bucket(&HeadBucketInput::new(config.bucket))
            .await
            .expect("TOS HeadBucket should succeed");
    }

    #[tokio::test]
    #[ignore = "writes then removes a temporary TOS object using LUMINA_TOS_* credentials"]
    async fn checks_live_tos_upload_and_presigned_read() {
        use uuid::Uuid;
        use ve_tos_rust_sdk::asynchronous::object::ObjectAPI;
        use ve_tos_rust_sdk::object::{DeleteObjectInput, PutObjectFromBufferInput};

        let config = super::TosConfig::from_environment().expect("TOS configuration is required");
        let client = super::build_client(&config).expect("TOS client should initialize");
        let key = format!(
            "lumina/diagnostics/{}/connectivity-check.txt",
            Uuid::new_v4()
        );
        let payload = b"lumina-tos-connectivity-check";
        let mut put_input =
            PutObjectFromBufferInput::new_with_content(&config.bucket, &key, payload);
        put_input.set_content_type("text/plain");

        client
            .put_object_from_buffer(&put_input)
            .await
            .expect("TOS PutObject should succeed");

        let test_result: Result<(), String> = async {
            let url = super::generate_get_url(&config, &key).await?;
            let response = reqwest::get(url)
                .await
                .map_err(|error| format!("TOS 预签名 URL 无法访问: {error}"))?;
            if !response.status().is_success() {
                return Err(format!("TOS 预签名 GET 返回 HTTP {}", response.status()));
            }
            let body = response
                .bytes()
                .await
                .map_err(|error| format!("无法读取 TOS 响应内容: {error}"))?;
            if body.as_ref() != payload {
                return Err("TOS 预签名 GET 的响应内容不匹配".to_string());
            }
            Ok(())
        }
        .await;

        let cleanup_result = client
            .delete_object(&DeleteObjectInput::new(config.bucket.clone(), key.clone()))
            .await;

        test_result.expect("TOS upload and presigned read should succeed");
        cleanup_result.expect("temporary TOS connectivity object should be deleted");
    }
}
