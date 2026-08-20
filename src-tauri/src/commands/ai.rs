use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;
use tracing::info;
use uuid::Uuid;

use crate::ai::error::AIError;
use crate::ai::generation_recovery::{
    clear_poll_recovery, schedule_transient_poll_retry, PollRecovery,
};
use crate::ai::providers::build_default_providers;
use crate::ai::{
    GenerateRequest, ProviderRegistry, ProviderTaskHandle, ProviderTaskPollResult,
    ProviderTaskSubmission, VideoContentInput,
};

static REGISTRY: std::sync::OnceLock<ProviderRegistry> = std::sync::OnceLock::new();
static ACTIVE_NON_RESUMABLE_JOB_IDS: std::sync::OnceLock<Arc<RwLock<HashSet<String>>>> =
    std::sync::OnceLock::new();

fn get_registry() -> &'static ProviderRegistry {
    REGISTRY.get_or_init(|| {
        let mut registry = ProviderRegistry::new();
        for provider in build_default_providers() {
            registry.register_provider(provider);
        }
        registry
    })
}

fn active_non_resumable_job_ids() -> &'static Arc<RwLock<HashSet<String>>> {
    ACTIVE_NON_RESUMABLE_JOB_IDS.get_or_init(|| Arc::new(RwLock::new(HashSet::new())))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRequestDto {
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    pub size: String,
    pub aspect_ratio: String,
    pub reference_images: Option<Vec<String>>,
    #[serde(default)]
    pub video_content: Option<Vec<VideoContentInput>>,
    pub extra_params: Option<HashMap<String, Value>>,
    #[serde(default)]
    pub provider_config: Option<HashMap<String, Value>>,
    /// Draft task ID - when set, generates final video from this draft
    #[serde(rename = "draftTaskId", default)]
    pub draft_task_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobStatusDto {
    pub job_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub seed: Option<i64>,
    /// External task ID from the provider (e.g., volcvideo task ID like "cgt-xxx")
    /// Used for draft video final generation
    pub external_task_id: Option<String>,
    pub recovery: Option<GenerationJobRecoveryDto>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobRecoveryDto {
    pub retry_count: u32,
    pub next_retry_at: Option<i64>,
    pub requires_manual_requery: bool,
    pub last_error: Option<String>,
}

#[derive(Debug)]
struct GenerationJobRecord {
    job_id: String,
    provider_id: String,
    status: String,
    resumable: bool,
    external_task_id: Option<String>,
    external_task_meta_json: Option<String>,
    result: Option<String>,
    error: Option<String>,
    poll_retry_count: u32,
    next_poll_at: Option<i64>,
    recovery_requires_manual_requery: bool,
    recovery_error: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("projects.db"))
}

fn ensure_generation_jobs_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_generation_jobs (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          status TEXT NOT NULL,
          resumable INTEGER NOT NULL DEFAULT 0,
          external_task_id TEXT,
          external_task_meta_json TEXT,
          result TEXT,
          error TEXT,
          poll_retry_count INTEGER NOT NULL DEFAULT 0,
          next_poll_at INTEGER,
          recovery_requires_manual_requery INTEGER NOT NULL DEFAULT 0,
          recovery_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_status ON ai_generation_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_updated_at ON ai_generation_jobs(updated_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_generation_jobs table: {}", e))?;

    let mut stmt = conn
        .prepare("PRAGMA table_info(ai_generation_jobs)")
        .map_err(|e| format!("Failed to inspect ai_generation_jobs schema: {}", e))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to read ai_generation_jobs schema: {}", e))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| format!("Failed to collect ai_generation_jobs schema: {}", e))?;

    for (name, definition) in [
        ("poll_retry_count", "INTEGER NOT NULL DEFAULT 0"),
        ("next_poll_at", "INTEGER"),
        (
            "recovery_requires_manual_requery",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        ("recovery_error", "TEXT"),
    ] {
        if !columns.contains(name) {
            conn.execute_batch(&format!(
                "ALTER TABLE ai_generation_jobs ADD COLUMN {name} {definition}"
            ))
            .map_err(|e| format!("Failed to migrate ai_generation_jobs.{name}: {}", e))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod generation_job_recovery_storage_tests {
    use rusqlite::Connection;

    use super::ensure_generation_jobs_table;

    #[test]
    fn upgrades_existing_job_table_with_poll_recovery_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE ai_generation_jobs (
              job_id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL,
              status TEXT NOT NULL,
              resumable INTEGER NOT NULL DEFAULT 0,
              external_task_id TEXT,
              external_task_meta_json TEXT,
              result TEXT,
              error TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();

        ensure_generation_jobs_table(&conn).unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(ai_generation_jobs)").unwrap();
        let column_names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(column_names.contains(&"poll_retry_count".to_string()));
        assert!(column_names.contains(&"next_poll_at".to_string()));
        assert!(column_names.contains(&"recovery_requires_manual_requery".to_string()));
        assert!(column_names.contains(&"recovery_error".to_string()));
    }
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open SQLite DB: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set journal_mode=WAL: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| format!("Failed to set temp_store=MEMORY: {}", e))?;
    conn.busy_timeout(Duration::from_millis(3000))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;

    ensure_generation_jobs_table(&conn)?;
    Ok(conn)
}

fn insert_generation_job(
    app: &AppHandle,
    job_id: &str,
    provider_id: &str,
    status: &str,
    resumable: bool,
    external_task_id: Option<&str>,
    external_task_meta_json: Option<&str>,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO ai_generation_jobs (
          job_id,
          provider_id,
          status,
          resumable,
          external_task_id,
          external_task_meta_json,
          result,
          error,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            job_id,
            provider_id,
            status,
            if resumable { 1_i64 } else { 0_i64 },
            external_task_id,
            external_task_meta_json,
            result,
            error,
            now,
            now
        ],
    )
    .map_err(|e| format!("Failed to insert generation job: {}", e))?;
    Ok(())
}

fn update_generation_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          error = ?3,
          poll_retry_count = 0,
          next_poll_at = NULL,
          recovery_requires_manual_requery = 0,
          recovery_error = NULL,
          updated_at = ?4
        WHERE job_id = ?5
        "#,
        params![status, result, error, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job: {}", e))?;
    Ok(())
}

fn update_generation_job_with_seed(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    seed: Option<i64>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    // Build metadata JSON with seed if provided
    let meta_json = seed.map(|s| {
        serde_json::json!({ "seed": s }).to_string()
    });
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          external_task_meta_json = ?3,
          poll_retry_count = 0,
          next_poll_at = NULL,
          recovery_requires_manual_requery = 0,
          recovery_error = NULL,
          updated_at = ?4
        WHERE job_id = ?5
        "#,
        params![status, result, meta_json, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job with seed: {}", e))?;
    Ok(())
}

fn update_generation_job_poll_recovery(
    app: &AppHandle,
    job_id: &str,
    recovery: &PollRecovery,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          poll_retry_count = ?1,
          next_poll_at = ?2,
          recovery_requires_manual_requery = ?3,
          recovery_error = ?4,
          updated_at = ?5
        WHERE job_id = ?6
        "#,
        params![
            i64::from(recovery.retry_count),
            recovery.next_poll_at,
            if recovery.requires_manual_requery {
                1_i64
            } else {
                0_i64
            },
            recovery.last_error,
            now_ms(),
            job_id,
        ],
    )
    .map_err(|e| format!("Failed to update generation job poll recovery: {}", e))?;
    Ok(())
}

fn clear_generation_job_poll_recovery(app: &AppHandle, job_id: &str) -> Result<(), String> {
    update_generation_job_poll_recovery(app, job_id, &clear_poll_recovery())
}

fn recover_generation_job_after_transient_poll_failure(
    app: &AppHandle,
    record: &mut GenerationJobRecord,
    task_id: &str,
    error_message: &str,
) -> Result<GenerationJobStatusDto, String> {
    let recovery = schedule_transient_poll_retry(
        task_id,
        record.poll_retry_count,
        now_ms(),
        error_message,
    );
    info!(
        "[GenerationJob] retryable poll error for job {} (attempt {}): {}",
        record.job_id, recovery.retry_count, error_message
    );
    update_generation_job_poll_recovery(app, record.job_id.as_str(), &recovery)?;
    record.poll_retry_count = recovery.retry_count;
    record.next_poll_at = recovery.next_poll_at;
    record.recovery_requires_manual_requery = recovery.requires_manual_requery;
    record.recovery_error = recovery.last_error;
    Ok(dto_from_record(record))
}

fn touch_generation_job(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET updated_at = ?1 WHERE job_id = ?2",
        params![now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to touch generation job: {}", e))?;
    Ok(())
}

fn get_generation_job(app: &AppHandle, job_id: &str) -> Result<Option<GenerationJobRecord>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              job_id,
              provider_id,
              status,
              resumable,
              external_task_id,
              external_task_meta_json,
              result,
              error,
              poll_retry_count,
              next_poll_at,
              recovery_requires_manual_requery,
              recovery_error
            FROM ai_generation_jobs
            WHERE job_id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare generation job query: {}", e))?;

    let result = stmt.query_row(params![job_id], |row| {
        Ok(GenerationJobRecord {
            job_id: row.get(0)?,
            provider_id: row.get(1)?,
            status: row.get(2)?,
            resumable: row.get::<_, i64>(3)? != 0,
            external_task_id: row.get(4)?,
            external_task_meta_json: row.get(5)?,
            result: row.get(6)?,
            error: row.get(7)?,
            poll_retry_count: row.get::<_, i64>(8)?.clamp(0, i64::from(u32::MAX)) as u32,
            next_poll_at: row.get(9)?,
            recovery_requires_manual_requery: row.get::<_, i64>(10)? != 0,
            recovery_error: row.get(11)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load generation job: {}", error)),
    }
}

fn dto_from_record(record: &GenerationJobRecord) -> GenerationJobStatusDto {
    // Extract seed from external_task_meta_json if present
    let seed = record
        .external_task_meta_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|val| val.get("seed").and_then(|v| v.as_i64()));
    GenerationJobStatusDto {
        job_id: record.job_id.clone(),
        status: record.status.clone(),
        result: record.result.clone(),
        error: record.error.clone(),
        seed,
        external_task_id: record.external_task_id.clone(),
        recovery: (record.poll_retry_count > 0
            || record.next_poll_at.is_some()
            || record.recovery_requires_manual_requery
            || record.recovery_error.is_some())
        .then(|| GenerationJobRecoveryDto {
            retry_count: record.poll_retry_count,
            next_retry_at: record.next_poll_at,
            requires_manual_requery: record.recovery_requires_manual_requery,
            last_error: record.recovery_error.clone(),
        }),
    }
}

#[cfg(test)]
mod generation_job_recovery_dto_tests {
    use super::{dto_from_record, GenerationJobRecord};

    #[test]
    fn exposes_network_poll_recovery_without_marking_the_job_failed() {
        let dto = dto_from_record(&GenerationJobRecord {
            job_id: "local-job-id".to_string(),
            provider_id: "ai-media".to_string(),
            status: "running".to_string(),
            resumable: true,
            external_task_id: Some("imgtask_795e3255-352c-420d-9785-91e167b416a3".to_string()),
            external_task_meta_json: None,
            result: None,
            error: None,
            poll_retry_count: 1,
            next_poll_at: Some(2_000),
            recovery_requires_manual_requery: false,
            recovery_error: Some("Network error: error sending request".to_string()),
        });

        assert_eq!(dto.status, "running");
        let recovery = dto.recovery.expect("retryable jobs expose recovery state");
        assert_eq!(recovery.retry_count, 1);
        assert_eq!(recovery.next_retry_at, Some(2_000));
        assert!(!recovery.requires_manual_requery);
        assert_eq!(
            recovery.last_error.as_deref(),
            Some("Network error: error sending request")
        );
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    info!("Setting API key for provider: {}", provider);

    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    resolved_provider
        .set_api_key(api_key)
        .await
        .map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
pub struct DiscoverImageModelsRequest {
    pub provider_id: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub protocol: CustomImageProtocol,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CustomImageProtocol {
    #[serde(rename = "openai-images")]
    OpenAiImages,
    #[serde(rename = "fhl-images", alias = "fhl")]
    FhlImages,
    GeminiNative,
}

impl Default for CustomImageProtocol {
    fn default() -> Self {
        Self::OpenAiImages
    }
}

#[derive(Debug, Deserialize)]
pub struct DiscoverTextModelsRequest {
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct DiscoveredImageModelDto {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn resolve_models_endpoint(base_url: &str) -> Result<String, String> {
    let normalized = base_url.trim();
    if normalized.is_empty() {
        return Err("请填写 Base URL".to_string());
    }

    let mut url = reqwest::Url::parse(normalized)
        .map_err(|error| format!("Base URL 无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 仅支持 HTTP(S)".to_string());
    }

    let base_path = url.path().trim_end_matches('/');
    let endpoint_path = if base_path.ends_with("/models") {
        base_path.to_string()
    } else if base_path.is_empty() {
        "/v1/models".to_string()
    } else {
        format!("{base_path}/models")
    };

    url.set_path(&endpoint_path);
    Ok(url.to_string())
}

fn resolve_gemini_models_endpoint(base_url: &str) -> Result<String, String> {
    let normalized = base_url.trim();
    if normalized.is_empty() {
        return Err("请填写 Base URL".to_string());
    }

    let mut url = reqwest::Url::parse(normalized)
        .map_err(|error| format!("Base URL 无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 仅支持 HTTP(S)".to_string());
    }

    let base_path = url.path().trim_end_matches('/');
    let endpoint_path = if base_path.ends_with("/models") {
        base_path.to_string()
    } else if base_path.is_empty() {
        "/v1beta/models".to_string()
    } else {
        format!("{base_path}/models")
    };

    url.set_path(&endpoint_path);
    Ok(url.to_string())
}

fn resolve_gemini_compatible_models_endpoint(base_url: &str) -> Result<String, String> {
    let normalized = base_url.trim();
    if normalized.is_empty() {
        return Err("请填写 Base URL".to_string());
    }

    let mut url = reqwest::Url::parse(normalized)
        .map_err(|error| format!("Base URL 无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 仅支持 HTTP(S)".to_string());
    }

    let base_path = url.path().trim_end_matches('/');
    let native_api_path = base_path.strip_suffix("/models").unwrap_or(base_path);
    let gateway_root = native_api_path
        .strip_suffix("/v1beta")
        .unwrap_or(native_api_path);
    let endpoint_path = if gateway_root.is_empty() {
        "/v1/models".to_string()
    } else {
        format!("{gateway_root}/v1/models")
    };

    url.set_path(&endpoint_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn resolve_chat_completions_endpoint(base_url: &str) -> Result<String, String> {
    let normalized = base_url.trim();
    if normalized.is_empty() {
        return Err("请填写 Base URL".to_string());
    }

    let mut url = reqwest::Url::parse(normalized)
        .map_err(|error| format!("Base URL 无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 仅支持 HTTP(S)".to_string());
    }

    let base_path = url.path().trim_end_matches('/');
    let endpoint_path = if base_path.ends_with("/chat/completions") {
        base_path.to_string()
    } else if base_path.ends_with("/api/coding") {
        format!("{base_path}/v3/chat/completions")
    } else if base_path.is_empty() {
        "/v1/chat/completions".to_string()
    } else {
        format!("{base_path}/chat/completions")
    };

    url.set_path(&endpoint_path);
    Ok(url.to_string())
}

#[cfg(test)]
mod text_api_endpoint_tests {
    use serde_json::{json, Value};

    use super::{
        build_generate_text_chat_request, build_generate_text_responses_request,
        extract_generated_text, resolve_chat_completions_endpoint, resolve_gemini_models_endpoint,
        resolve_models_endpoint, ChatContent, ChatMessage, ChatRequest, CustomImageProtocol,
        DiscoverImageModelsRequest, GenerateTextRequest, ResponsesReasoning, ResponsesRequest,
    };

    #[test]
    fn resolves_models_from_standard_openai_versioned_base_url() {
        assert_eq!(
            resolve_models_endpoint("https://gateway.example/openai/v1/").unwrap(),
            "https://gateway.example/openai/v1/models"
        );
    }

    #[test]
    fn accepts_full_models_endpoint() {
        assert_eq!(
            resolve_models_endpoint("https://gateway.example/openai/v1/models").unwrap(),
            "https://gateway.example/openai/v1/models"
        );
    }

    #[test]
    fn adds_openai_v1_models_path_to_origin_only_url() {
        assert_eq!(
            resolve_models_endpoint("https://gateway.example").unwrap(),
            "https://gateway.example/v1/models"
        );
    }

    #[test]
    fn rejects_non_http_models_base_url() {
        assert_eq!(
            resolve_models_endpoint("file:///tmp/models").unwrap_err(),
            "Base URL 仅支持 HTTP(S)"
        );
    }

    #[test]
    fn resolves_models_from_gemini_native_base_url() {
        assert_eq!(
            resolve_gemini_models_endpoint("https://gateway.example/v1beta/").unwrap(),
            "https://gateway.example/v1beta/models"
        );
    }

    #[test]
    fn adds_gemini_v1beta_models_path_to_origin_only_url() {
        assert_eq!(
            resolve_gemini_models_endpoint("https://gateway.example").unwrap(),
            "https://gateway.example/v1beta/models"
        );
    }

    #[test]
    fn accepts_frontend_custom_image_protocol_values() {
        let openai_request: DiscoverImageModelsRequest = serde_json::from_value(json!({
            "provider_id": "custom-openai:gateway",
            "base_url": "https://gateway.example/v1",
            "api_key": "test-key",
            "protocol": "openai-images"
        }))
        .unwrap();
        let gemini_request: DiscoverImageModelsRequest = serde_json::from_value(json!({
            "provider_id": "custom-openai:gateway",
            "base_url": "https://gateway.example/v1beta",
            "api_key": "test-key",
            "protocol": "gemini-native"
        }))
        .unwrap();
        let fhl_request: DiscoverImageModelsRequest = serde_json::from_value(json!({
            "provider_id": "custom-openai:fhl",
            "base_url": "https://www.fhl.mom",
            "api_key": "test-key",
            "protocol": "fhl-images"
        }))
        .unwrap();

        assert_eq!(openai_request.protocol, CustomImageProtocol::OpenAiImages);
        assert_eq!(gemini_request.protocol, CustomImageProtocol::GeminiNative);
        assert_eq!(fhl_request.protocol, CustomImageProtocol::FhlImages);
    }

    #[test]
    fn resolves_standard_openai_versioned_base_url() {
        assert_eq!(
            resolve_chat_completions_endpoint("https://gateway.example/v1").unwrap(),
            "https://gateway.example/v1/chat/completions"
        );
    }

    #[test]
    fn accepts_full_chat_completions_endpoint() {
        assert_eq!(
            resolve_chat_completions_endpoint(
                "https://gateway.example/openai/v1/chat/completions/"
            )
            .unwrap(),
            "https://gateway.example/openai/v1/chat/completions"
        );
    }

    #[test]
    fn adds_openai_v1_path_to_origin_only_url() {
        assert_eq!(
            resolve_chat_completions_endpoint("https://gateway.example").unwrap(),
            "https://gateway.example/v1/chat/completions"
        );
    }

    #[test]
    fn preserves_volc_coding_plan_chat_path() {
        assert_eq!(
            resolve_chat_completions_endpoint(
                "https://ark.cn-beijing.volces.com/api/coding"
            )
            .unwrap(),
            "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
        );
    }

    #[test]
    fn rejects_empty_base_url() {
        assert_eq!(
            resolve_chat_completions_endpoint("  ").unwrap_err(),
            "请填写 Base URL"
        );
    }

    #[test]
    fn serializes_reasoning_effort_for_openai_compatible_requests() {
        let chat = serde_json::to_value(ChatRequest {
            model: "test-model".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hello".to_string()),
            }],
            stream: Some(false),
            reasoning_effort: Some("high".to_string()),
        })
        .unwrap();
        assert_eq!(chat.get("reasoning_effort").and_then(Value::as_str), Some("high"));

        let responses = serde_json::to_value(ResponsesRequest {
            model: "test-model".to_string(),
            input: Vec::new(),
            reasoning: Some(ResponsesReasoning {
                effort: "high".to_string(),
            }),
        })
        .unwrap();
        assert_eq!(
            responses
                .get("reasoning")
                .and_then(|reasoning| reasoning.get("effort"))
                .and_then(Value::as_str),
            Some("high")
        );
    }

    #[test]
    fn omits_reasoning_effort_when_node_uses_provider_default() {
        let chat = serde_json::to_value(ChatRequest {
            model: "test-model".to_string(),
            messages: Vec::new(),
            stream: Some(false),
            reasoning_effort: None,
        })
        .unwrap();
        assert!(chat.get("reasoning_effort").is_none());
    }

    #[test]
    fn generic_text_request_has_only_one_user_message_and_no_hidden_template() {
        let request = GenerateTextRequest {
            text: "用户原文".to_string(),
            model: "vision-model".to_string(),
            api_key: "secret".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            reference_images: Some(vec!["data:image/png;base64,AAAA".to_string()]),
            reasoning_effort: Some("high".to_string()),
        };

        let body = serde_json::to_value(build_generate_text_chat_request(&request).unwrap()).unwrap();
        let messages = body.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].get("role").and_then(Value::as_str), Some("user"));
        let serialized = serde_json::to_string(&body).unwrap();
        assert!(serialized.contains("用户原文"));
        assert!(!serialized.contains("system"));
        assert_eq!(body.get("reasoning_effort").and_then(Value::as_str), Some("high"));
    }

    #[test]
    fn generic_text_requests_interleave_numbered_labels_and_images_in_reference_order() {
        let request = GenerateTextRequest {
            text: "衣服参考图片 1；帽子参考图片 2。".to_string(),
            model: "vision-model".to_string(),
            api_key: "secret".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            reference_images: Some(vec![
                "https://images.example/red-clothes.png".to_string(),
                "https://images.example/yellow-hat.png".to_string(),
            ]),
            reasoning_effort: None,
        };

        let chat = serde_json::to_value(build_generate_text_chat_request(&request).unwrap())
            .unwrap();
        let chat_content = chat
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| messages.first())
            .and_then(|message| message.get("content"));
        assert_eq!(
            chat_content,
            Some(&serde_json::json!([
                { "type": "text", "text": "图片 1：" },
                {
                    "type": "image_url",
                    "image_url": { "url": "https://images.example/red-clothes.png" }
                },
                { "type": "text", "text": "图片 2：" },
                {
                    "type": "image_url",
                    "image_url": { "url": "https://images.example/yellow-hat.png" }
                },
                {
                    "type": "text",
                    "text": "衣服参考图片 1；帽子参考图片 2。"
                }
            ]))
        );

        let responses =
            serde_json::to_value(build_generate_text_responses_request(&request).unwrap()).unwrap();
        let responses_content = responses
            .get("input")
            .and_then(Value::as_array)
            .and_then(|input| input.first())
            .and_then(|message| message.get("content"));
        assert_eq!(
            responses_content,
            Some(&serde_json::json!([
                { "type": "input_text", "text": "图片 1：" },
                {
                    "type": "input_image",
                    "image_url": "https://images.example/red-clothes.png"
                },
                { "type": "input_text", "text": "图片 2：" },
                {
                    "type": "input_image",
                    "image_url": "https://images.example/yellow-hat.png"
                },
                {
                    "type": "input_text",
                    "text": "衣服参考图片 1；帽子参考图片 2。"
                }
            ]))
        );
    }

    #[test]
    fn generic_text_request_rejects_an_unreadable_image_reference() {
        let request = GenerateTextRequest {
            text: "describe".to_string(),
            model: "vision-model".to_string(),
            api_key: "secret".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            reference_images: Some(vec!["/missing/local/image.png".to_string()]),
            reasoning_effort: None,
        };

        assert!(build_generate_text_chat_request(&request).is_err());
    }

    #[test]
    fn image_only_text_generation_omits_an_empty_user_prompt_part() {
        let request = GenerateTextRequest {
            text: "   ".to_string(),
            model: "vision-model".to_string(),
            api_key: "secret".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            reference_images: Some(vec!["data:image/png;base64,AAAA".to_string()]),
            reasoning_effort: None,
        };

        let body = serde_json::to_value(build_generate_text_chat_request(&request).unwrap()).unwrap();
        let content = body
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| messages.first())
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .unwrap();

        assert_eq!(content.len(), 2);
        assert_eq!(content[0].get("type").and_then(Value::as_str), Some("text"));
        assert_eq!(content[0].get("text").and_then(Value::as_str), Some("图片 1："));
        assert_eq!(content[1].get("type").and_then(Value::as_str), Some("image_url"));
    }

    #[test]
    fn extracts_text_from_chat_and_responses_api_payloads() {
        let chat = serde_json::json!({"choices": [{"message": {"content": " chat result "}}]});
        let responses = serde_json::json!({
            "output": [{"content": [{"type": "output_text", "text": " response result "}]}]
        });

        assert_eq!(extract_generated_text(&chat).unwrap(), " chat result ");
        assert_eq!(extract_generated_text(&responses).unwrap(), " response result ");
    }

    #[test]
    fn concatenates_all_responses_output_text_parts_and_ignores_reasoning() {
        let responses = serde_json::json!({
            "output": [
                {"type": "reasoning", "text": "hidden chain of thought"},
                {
                    "type": "message",
                    "content": [
                        {"type": "output_text", "text": "first "},
                        {"type": "output_text", "text": "second"},
                        {"type": "refusal", "text": "not result text"}
                    ]
                }
            ]
        });

        assert_eq!(extract_generated_text(&responses).unwrap(), "first second");
    }
}

fn model_list_from_response(payload: &Value) -> Vec<DiscoveredImageModelDto> {
    let models = payload
        .get("data")
        .or_else(|| payload.get("models"))
        .and_then(Value::as_array)
        .or_else(|| payload.as_array());
    let Some(models) = models else {
        return Vec::new();
    };

    let mut unique_models = HashSet::new();
    models
        .iter()
        .filter_map(|entry| {
            let id = entry
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    entry.as_object().and_then(|record| {
                        ["id", "model", "name"]
                            .iter()
                            .find_map(|key| record.get(*key).and_then(Value::as_str))
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                    })
                })?;

            if !unique_models.insert(id.clone()) {
                return None;
            }

            let label = entry.as_object().and_then(|record| {
                ["display_name", "displayName", "label", "name"]
                    .iter()
                    .find_map(|key| record.get(*key).and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && *value != id)
                    .map(str::to_string)
            });

            Some(DiscoveredImageModelDto { id, label })
        })
        .collect()
}

fn normalize_gemini_model_resource_id(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .strip_prefix("models/")
        .unwrap_or(value.trim())
        .trim();
    (!normalized.is_empty()).then(|| normalized.to_string())
}

fn gemini_model_list_from_response(payload: &Value) -> Vec<DiscoveredImageModelDto> {
    let Some(models) = payload.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut unique_models = HashSet::new();
    models
        .iter()
        .filter_map(|entry| {
            let record = entry.as_object()?;
            let supports_generate_content = record
                .get("supportedGenerationMethods")
                .or_else(|| record.get("supported_generation_methods"))
                .and_then(Value::as_array)
                .map(|methods| {
                    methods
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|method| method.trim() == "generateContent")
                })
                .unwrap_or(true);
            if !supports_generate_content {
                return None;
            }

            let id = ["name", "id", "model"]
                .iter()
                .find_map(|key| record.get(*key).and_then(Value::as_str))
                .and_then(normalize_gemini_model_resource_id)?;
            if !unique_models.insert(id.clone()) {
                return None;
            }

            let label = ["displayName", "display_name", "label", "name"]
                .iter()
                .find_map(|key| record.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .filter(|value| {
                    normalize_gemini_model_resource_id(value).as_deref() != Some(id.as_str())
                });

            Some(DiscoveredImageModelDto { id, label })
        })
        .collect()
}

fn gemini_discovery_model_list_from_response(payload: &Value) -> Vec<DiscoveredImageModelDto> {
    if payload.get("models").and_then(Value::as_array).is_some() {
        gemini_model_list_from_response(payload)
    } else {
        model_list_from_response(payload)
    }
}

fn model_list_error_message(payload: &Value, status: reqwest::StatusCode) -> String {
    payload
        .get("error")
        .and_then(|error| {
            error
                .as_str()
                .map(str::to_string)
                .or_else(|| error.get("message").and_then(Value::as_str).map(str::to_string))
        })
        .unwrap_or_else(|| format!("HTTP {status}"))
}

async fn fetch_openai_compatible_models(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DiscoveredImageModelDto>, String> {
    if api_key.trim().is_empty() {
        return Err("请填写 API Key".to_string());
    }

    let endpoint = resolve_models_endpoint(base_url)?;
    let response = Client::new()
        .get(&endpoint)
        .bearer_auth(api_key.trim())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("获取模型列表失败：{error}"))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("模型列表返回的数据无法解析：{error}"))?;

    if !status.is_success() {
        return Err(format!(
            "获取模型列表失败：{}",
            model_list_error_message(&payload, status)
        ));
    }

    Ok(model_list_from_response(&payload))
}

async fn fetch_gemini_native_models(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DiscoveredImageModelDto>, String> {
    if api_key.trim().is_empty() {
        return Err("请填写 API Key".to_string());
    }

    let client = Client::new();
    let endpoint = resolve_gemini_models_endpoint(base_url)?;
    let response = client
        .get(&endpoint)
        .header("x-goog-api-key", api_key.trim())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("获取模型列表失败：{error}"))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("模型列表返回的数据无法解析：{error}"))?;

    if status.is_success() {
        return Ok(gemini_discovery_model_list_from_response(&payload));
    }

    if status != reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "获取模型列表失败：{}",
            model_list_error_message(&payload, status)
        ));
    }

    let fallback_endpoint = resolve_gemini_compatible_models_endpoint(base_url)?;
    let fallback_response = client
        .get(&fallback_endpoint)
        .header("x-goog-api-key", api_key.trim())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("获取模型列表失败：{error}"))?;
    let fallback_status = fallback_response.status();
    let fallback_payload = fallback_response
        .json::<Value>()
        .await
        .map_err(|error| format!("模型列表返回的数据无法解析：{error}"))?;

    if !fallback_status.is_success() {
        return Err(format!(
            "获取模型列表失败：{}",
            model_list_error_message(&fallback_payload, fallback_status)
        ));
    }

    Ok(gemini_discovery_model_list_from_response(&fallback_payload))
}

#[cfg(test)]
mod image_model_discovery_tests {
    use super::{fetch_gemini_native_models, gemini_model_list_from_response};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    async fn read_http_request(socket: &mut TcpStream) -> Vec<u8> {
        let mut request_bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let bytes_read = socket.read(&mut buffer).await.unwrap();
            assert!(bytes_read > 0, "connection closed before request headers");
            request_bytes.extend_from_slice(&buffer[..bytes_read]);
            if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                return request_bytes;
            }
        }
    }

    async fn write_json_response(socket: &mut TcpStream, status: &str, body: &str) {
        socket
            .write_all(
                format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    #[test]
    fn gemini_model_list_normalizes_resources_and_filters_unsupported_models() {
        let models = gemini_model_list_from_response(&json!({
            "models": [
                {
                    "name": "models/gemini-3-pro-image-preview",
                    "displayName": "Gemini 3 Pro Image Preview",
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/text-embedding-004",
                    "supportedGenerationMethods": ["embedContent"]
                },
                {
                    "name": "models/gemini-3-pro-image-preview",
                    "supportedGenerationMethods": ["generateContent"]
                }
            ]
        }));

        let models = models
            .into_iter()
            .map(|model| (model.id, model.label))
            .collect::<Vec<_>>();
        assert_eq!(
            models,
            vec![(
                "gemini-3-pro-image-preview".to_string(),
                Some("Gemini 3 Pro Image Preview".to_string())
            )]
        );
    }

    #[tokio::test]
    async fn gemini_model_discovery_uses_native_endpoint_and_header() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request_bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                assert!(bytes_read > 0, "connection closed before request headers");
                request_bytes.extend_from_slice(&buffer[..bytes_read]);
                if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }

            let response = r#"{"models":[{"name":"models/gemini-3-pro-image-preview","supportedGenerationMethods":["generateContent"]}]}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        response.len(),
                        response
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request_bytes
        });

        let base_url = format!("http://{address}/v1beta");
        let models = fetch_gemini_native_models(&base_url, "test-key")
            .await
            .unwrap();

        assert_eq!(models[0].id, "gemini-3-pro-image-preview");
        let request_bytes = server.await.unwrap();
        let request = String::from_utf8_lossy(&request_bytes);
        let normalized_headers = request.to_ascii_lowercase();
        assert!(request.starts_with("GET /v1beta/models HTTP/1.1"));
        assert!(normalized_headers.contains("x-goog-api-key: test-key"));
        assert!(!normalized_headers.contains("authorization:"));
    }

    #[tokio::test]
    async fn gemini_model_discovery_falls_back_to_compatible_catalog_after_native_404() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut native_socket, _) = listener.accept().await.unwrap();
            let native_request = read_http_request(&mut native_socket).await;
            write_json_response(
                &mut native_socket,
                "404 Not Found",
                r#"{"error":{"message":"native catalog unavailable"}}"#,
            )
            .await;
            drop(native_socket);

            let (mut compatible_socket, _) = listener.accept().await.unwrap();
            let compatible_request = read_http_request(&mut compatible_socket).await;
            write_json_response(
                &mut compatible_socket,
                "200 OK",
                r#"{"data":[{"id":"gemini-3-pro-image-preview"}]}"#,
            )
            .await;

            (native_request, compatible_request)
        });

        let base_url = format!("http://{address}/v1beta");
        let models = fetch_gemini_native_models(&base_url, "test-key")
            .await
            .unwrap();

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-3-pro-image-preview");
        let (native_request, compatible_request) = server.await.unwrap();
        let native_request = String::from_utf8_lossy(&native_request);
        let compatible_request = String::from_utf8_lossy(&compatible_request);
        let native_headers = native_request.to_ascii_lowercase();
        let compatible_headers = compatible_request.to_ascii_lowercase();
        assert!(native_request.starts_with("GET /v1beta/models HTTP/1.1"));
        assert!(compatible_request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(native_headers.contains("x-goog-api-key: test-key"));
        assert!(compatible_headers.contains("x-goog-api-key: test-key"));
        assert!(!native_headers.contains("authorization:"));
        assert!(!compatible_headers.contains("authorization:"));
    }
}

#[tauri::command]
pub async fn discover_image_models(
    request: DiscoverImageModelsRequest,
) -> Result<Vec<DiscoveredImageModelDto>, String> {
    let is_custom_openai_provider = request
        .provider_id
        .strip_prefix("custom-openai:")
        .is_some_and(|suffix| !suffix.trim().is_empty());
    if request.provider_id != "ai-media"
        && request.provider_id != "chaomo"
        && !is_custom_openai_provider
    {
        return Err("不支持该生图 Provider 的模型发现".to_string());
    }

    if !is_custom_openai_provider && request.protocol == CustomImageProtocol::GeminiNative {
        return Err("Gemini Native 协议仅支持自定义图片 Provider".to_string());
    }
    if !is_custom_openai_provider && request.protocol == CustomImageProtocol::FhlImages {
        return Err("FHL Images 协议仅支持自定义图片 Provider".to_string());
    }

    let use_gemini_native = is_custom_openai_provider
        && request.protocol == CustomImageProtocol::GeminiNative;
    let endpoint = if use_gemini_native {
        resolve_gemini_models_endpoint(&request.base_url)?
    } else {
        resolve_models_endpoint(&request.base_url)?
    };
    info!(
        "Discovering image models for provider {} with protocol {:?} at {}",
        request.provider_id, request.protocol, endpoint
    );
    if use_gemini_native {
        fetch_gemini_native_models(&request.base_url, &request.api_key).await
    } else {
        fetch_openai_compatible_models(&request.base_url, &request.api_key).await
    }
}

#[tauri::command]
pub async fn discover_text_models(
    request: DiscoverTextModelsRequest,
) -> Result<Vec<DiscoveredImageModelDto>, String> {
    let endpoint = resolve_models_endpoint(&request.base_url)?;
    info!("Discovering text models at {}", endpoint);
    fetch_openai_compatible_models(&request.base_url, &request.api_key).await
}

#[tauri::command]
pub async fn submit_generate_image_job(
    app: AppHandle,
    request: GenerateRequestDto,
) -> Result<String, String> {
    info!("[submit_generate_image_job] COMMAND INVOKED - model: {}", request.model);
    info!("[Job Request] model: {}, size: {}, aspect_ratio: {}, refs: {:?}",
        request.model,
        request.size,
        request.aspect_ratio,
        request.reference_images);

    let registry = get_registry();
    let provider = if let Some(provider_id) = request.provider_id.as_deref() {
        registry
            .get_provider(provider_id)
            .cloned()
            .ok_or_else(|| format!("Provider not found: {}", provider_id))?
    } else {
        registry
            .resolve_provider_for_model(&request.model)
            .or_else(|| registry.get_default_provider())
            .cloned()
            .ok_or_else(|| "Provider not found".to_string())?
    };

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        provider_id: request.provider_id,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        video_content: request.video_content,
        extra_params: request.extra_params,
        provider_config: request.provider_config,
        draft_task_id: request.draft_task_id,
    };

    info!("[Job Request Full] prompt: {}, reference_images: {:?}",
        req.prompt, req.reference_images);

    let job_id = Uuid::new_v4().to_string();
    let provider_id = provider.name().to_string();

    if provider.supports_task_resume() {
        match provider.submit_task(req).await.map_err(|e| e.to_string())? {
            ProviderTaskSubmission::Succeeded(image_source) => {
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "succeeded",
                    true,
                    None,
                    None,
                    Some(image_source.as_str()),
                    None,
                )?;
            }
            ProviderTaskSubmission::Queued(handle) => {
                let meta_json = handle
                    .metadata
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok());
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "running",
                    true,
                    Some(handle.task_id.as_str()),
                    meta_json.as_deref(),
                    None,
                    None,
                )?;
            }
        }
        return Ok(job_id);
    }

    insert_generation_job(
        &app,
        job_id.as_str(),
        provider_id.as_str(),
        "running",
        false,
        None,
        None,
        None,
        None,
    )?;
    {
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.insert(job_id.clone());
    }

    let app_handle = app.clone();
    let spawned_job_id = job_id.clone();
    let spawned_provider = provider.clone();
    tauri::async_runtime::spawn(async move {
        let result = spawned_provider.generate(req).await;
        let update_result = match result {
            Ok(image_source) => update_generation_job(
                &app_handle,
                spawned_job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            ),
            Err(error) => {
                let message = error.to_string();
                update_generation_job(
                    &app_handle,
                    spawned_job_id.as_str(),
                    "failed",
                    None,
                    Some(message.as_str()),
                )
            }
        };
        if let Err(error) = update_result {
            info!("Failed to update non-resumable generation job: {}", error);
        }
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.remove(spawned_job_id.as_str());
    });

    Ok(job_id)
}

#[tauri::command]
pub async fn cancel_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<(), String> {
    info!("[cancel_generate_image_job] called with job_id: {}", job_id);

    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(record) = maybe_record else {
        info!("[cancel_generate_image_job] job not found in DB: {}", job_id);
        return Err("Job not found".to_string());
    };

    info!("[cancel_generate_image_job] found job: id={}, provider={}, status={}, external_task_id={:?}",
        record.job_id, record.provider_id, record.status, record.external_task_id);

    // Only allow cancelling non-terminal jobs
    if record.status == "succeeded" || record.status == "failed" || record.status == "cancelled" {
        return Err(format!("Job already in terminal state: {}", record.status));
    }

    // If the job has an external task ID and is for volcvideo, try to cancel via API
    // Note: Full API cancellation requires access to settings which is handled by frontend
    if let Some(external_task_id) = &record.external_task_id {
        if record.provider_id == "volcvideo" {
            info!("[cancel_generate_image_job] volcvideo task {} - frontend should call cancel API", external_task_id);
        }
    }

    // Update job status to cancelled
    update_generation_job(
        &app,
        job_id.as_str(),
        "cancelled",
        None,
        Some("Cancelled by user"),
    )?;

    // Remove from active jobs if present
    {
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.remove(job_id.as_str());
    }

    info!("[cancel_generate_image_job] job {} cancelled successfully", job_id);
    Ok(())
}

#[tauri::command]
pub async fn cancel_video_generation_task(
    api_key: String,
    base_url: String,
    task_id: String,
) -> Result<(), String> {
    info!("[cancel_video_generation_task] cancelling task: {}", task_id);

    use crate::ai::providers::volcvideo::cancel_volcvideo_task;

    cancel_volcvideo_task(&api_key, &base_url, &task_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
    provider_config: Option<HashMap<String, Value>>,
) -> Result<GenerationJobStatusDto, String> {
    get_generate_image_job_inner(app, job_id, provider_config, false).await
}

#[tauri::command]
pub async fn retry_generate_image_job(
    app: AppHandle,
    job_id: String,
    provider_config: Option<HashMap<String, Value>>,
) -> Result<GenerationJobStatusDto, String> {
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(record) = maybe_record else {
        return Ok(GenerationJobStatusDto {
            job_id,
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
            seed: None,
            external_task_id: None,
            recovery: None,
        });
    };

    if !record.resumable {
        return Err("This generation job does not support task re-query".to_string());
    }
    if record.status == "succeeded" || record.status == "failed" || record.status == "cancelled" {
        return Ok(dto_from_record(&record));
    }
    if !record.recovery_requires_manual_requery {
        return Ok(dto_from_record(&record));
    }

    get_generate_image_job_inner(app, job_id, provider_config, true).await
}

async fn get_generate_image_job_inner(
    app: AppHandle,
    job_id: String,
    provider_config: Option<HashMap<String, Value>>,
    force_poll_after_manual_requery: bool,
) -> Result<GenerationJobStatusDto, String> {
    info!("[get_generate_image_job] called with job_id: {}", job_id);
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(mut record) = maybe_record else {
        info!("[get_generate_image_job] job not found in DB: {}", job_id);
        return Ok(GenerationJobStatusDto {
            job_id,
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
            seed: None,
            external_task_id: None,
            recovery: None,
        });
    };

    info!("[get_generate_image_job] found job: id={}, provider={}, status={}, external_task_id={:?}",
        record.job_id, record.provider_id, record.status, record.external_task_id);

    if record.status == "succeeded" || record.status == "failed" {
        info!("[get_generate_image_job] job {} already terminal, returning: {}", job_id, record.status);
        return Ok(dto_from_record(&record));
    }

    if !record.resumable {
        let is_active = {
            let active_set = active_non_resumable_job_ids().read().await;
            active_set.contains(record.job_id.as_str())
        };
        if is_active {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            return Ok(dto_from_record(&record));
        }

        let interrupted_message = "job interrupted by app restart".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(interrupted_message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(interrupted_message);
        return Ok(dto_from_record(&record));
    }

    let provider = get_registry()
        .get_provider(record.provider_id.as_str())
        .cloned()
        .ok_or_else(|| format!("Provider not found for job: {}", record.provider_id))?;

    let Some(task_id) = record.external_task_id.clone() else {
        let message = "missing external task id".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(message);
        return Ok(dto_from_record(&record));
    };

    if record.recovery_requires_manual_requery && !force_poll_after_manual_requery {
        info!(
            "[GenerationJob] waiting for manual task re-query: job={}, retries={}",
            job_id, record.poll_retry_count
        );
        return Ok(dto_from_record(&record));
    }
    if record.next_poll_at.is_some_and(|next_poll_at| next_poll_at > now_ms()) {
        return Ok(dto_from_record(&record));
    }

    let task_meta = record
        .external_task_meta_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let task_id_for_recovery = task_id.clone();

    info!("[get_generate_image_job] calling provider.poll_task for job: {}, task_id: {}", job_id, task_id);
    match provider
        .poll_task_with_config(
            ProviderTaskHandle {
                task_id,
                metadata: task_meta,
            },
            provider_config,
        )
        .await
    {
        Ok(ProviderTaskPollResult::Running) => {
            clear_generation_job_poll_recovery(&app, record.job_id.as_str())?;
            record.poll_retry_count = 0;
            record.next_poll_at = None;
            record.recovery_requires_manual_requery = false;
            record.recovery_error = None;
            Ok(dto_from_record(&record))
        }
        Ok(ProviderTaskPollResult::Succeeded(image_source)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "succeeded".to_string(),
                result: Some(image_source),
                error: None,
                seed: None,
                external_task_id: record.external_task_id.clone(),
                recovery: None,
            })
        }
        Ok(ProviderTaskPollResult::SucceededWithMeta { url, seed }) => {
            info!("[get_generate_image_job] SucceededWithMeta: url={}, seed={:?}", url, seed);
            update_generation_job_with_seed(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(url.as_str()),
                seed,
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "succeeded".to_string(),
                result: Some(url),
                error: None,
                seed,
                external_task_id: record.external_task_id.clone(),
                recovery: None,
            })
        }
        Ok(ProviderTaskPollResult::Failed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(message),
                seed: None,
                external_task_id: record.external_task_id.clone(),
                recovery: None,
            })
        }
        Err(AIError::TaskFailed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(message),
                seed: None,
                external_task_id: record.external_task_id.clone(),
                recovery: None,
            })
        }
        Err(AIError::Network(error)) => {
            let error_msg = error.to_string();
            recover_generation_job_after_transient_poll_failure(
                &app,
                &mut record,
                task_id_for_recovery.as_str(),
                error_msg.as_str(),
            )
        }
        Err(AIError::Transient(error_msg)) => {
            recover_generation_job_after_transient_poll_failure(
                &app,
                &mut record,
                task_id_for_recovery.as_str(),
                error_msg.as_str(),
            )
        }
        Err(error) => {
            let error_msg = error.to_string();
            info!("[VideoJob] poll_task error for job {}: {}", job_id, error_msg);
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(error_msg.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(error_msg),
                seed: None,
                external_task_id: record.external_task_id.clone(),
                recovery: None,
            })
        }
    }
}

#[tauri::command]
pub async fn generate_image(request: GenerateRequestDto) -> Result<String, String> {
    info!("Generating image with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .ok_or_else(|| "Provider not found".to_string())?;

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        provider_id: request.provider_id,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        video_content: request.video_content,
        extra_params: request.extra_params,
        provider_config: request.provider_config,
        draft_task_id: request.draft_task_id,
    };

    provider.generate(req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<String>, String> {
    Ok(get_registry().list_models())
}

#[derive(Debug, serde::Deserialize)]
pub struct PolishTextRequest {
    pub text: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub reference_images: Option<Vec<String>>,
    #[serde(default)]
    pub custom_prompt: Option<String>,
    // 视频元信息字段
    #[serde(default)]
    pub video_duration: Option<String>,
    #[serde(default)]
    pub video_resolution: Option<String>,
    #[serde(default)]
    pub video_aspect_ratio: Option<String>,
    #[serde(default)]
    pub video_shot_type: Option<String>,
    #[serde(default)]
    pub video_shot_size: Option<String>,
    #[serde(default)]
    pub video_angle: Option<String>,
    #[serde(default)]
    pub video_camera_movement: Option<String>,
    #[serde(default)]
    pub video_camera_speed: Option<String>,
    // 是否为首尾帧模式
    #[serde(default)]
    pub is_video_frame: Option<bool>,
    // 提示词模板类型：image、text 或 video，用于选择对应的默认模板
    #[serde(default)]
    pub prompt_type: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct GenerateTextRequest {
    pub text: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    #[serde(default)]
    pub reference_images: Option<Vec<String>>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

// 图片润色提示词模板的备用默认值（当用户未设置自定义模板时使用）
const BACKUP_TEXT_POLISH_TEMPLATE: &str = "你是专业的AI绘画提示词润色专家。我将为你提供待优化的原始AI绘画提示词（可能包含参考图片的@引用标记），请按照以下要求进行深度优化：
核心任务：深度理解原始提示词的核心语义和用户期望的视觉目标
视觉增强：从画面构图、风格流派、色彩调性、光影效果、主体元素、质感表现、氛围情绪等维度进行专业增强
AI适配：结合AI绘画工具的生成逻辑进行优化补充
输出要求：直接输出润色后的提示词，不需要任何解释或前缀说明
请直接输出优化后的提示词文本。";

// 文本节点润色提示词模板的备用默认值（当用户未设置自定义模板时使用）
const BACKUP_TEXT_NODE_POLISH_TEMPLATE: &str = "你是专业的文本提示词润色助手。我将为你提供一段需要交给文本模型处理的提示词，请按照以下要求优化：
保留原始任务、事实、限制条件、语气和输出要求，不擅自改变用户意图。
消除歧义与重复，补全必要的上下文、对象、步骤与验收条件，使指令清晰可执行。
使用结构化、自然且简洁的表达；只有原始内容确实需要时才补充合理细节。
只输出润色后的提示词，不解释修改过程，不添加前缀或结语。";

// 视频润色提示词模板的备用默认值（当用户未设置自定义模板时使用）
const BACKUP_VIDEO_POLISH_TEMPLATE: &str = "你是专业的 AI 视频生成提示词润色专家，具备丰富的镜头语言、视觉美学和 AI 生成适配经验。我将为你提供参考图片和待优化的原始 AI 视频提示词（可能为空），请严格遵循以下要求，完成深度优化，确保优化后的提示词精准适配 AI 视频生成工具，能直接生成符合预期的视觉效果：
核心前提：深度拆解原始提示词的核心语义、镜头逻辑、动态需求和视觉预期，不偏离用户核心诉求，不添加无关元素，同时弥补原始提示词的细节缺失。
优化核心维度（按需精准融入，不冗余，贴合 AI 生成特性）：
场景：明确环境、具体地点、背景细节（如天气、植被、建筑风格、空间层次），补充环境动态变化（如风吹，光影流动、烟雾飘动）；
时长：根据视频总时长，可拆分关键镜头时长分配；
景别：精准标注每段镜头景别（远景 / 全景 / 中景 / 近景 / 特写），明确景别切换逻辑，贴合内容节奏；
运镜：适配 AI 工具可实现的运镜方式（固定镜头、缓慢推进 / 拉远、平稳跟随、缓慢环绕、柔和摇镜等），标注运镜速度和幅度，避免复杂难实现的运镜；
角色 / 主体：详细描述外观细节、色彩、纹理、状态，明确表情、连贯动作及运动轨迹，突出主体辨识度；
情绪基调：精准定位整体情绪（紧张、压抑、温馨、科幻、惊悚等），并通过光影、色彩、动作强化情绪表达；
光影：明确光源类型（自然光 / 人工光 / 特殊光源）、光线方向、明暗对比，补充光影动态效果（如光斑移动、反光变化），增强画面层次感；
动作：细化主体及环境的连贯动作，标注动作速度、幅度，确保动态流畅自然，符合逻辑；
氛围：强化整体视觉氛围（写实、科幻、复古、梦幻、末日等），通过色彩、光影、环境细节统一氛围基调；
台词 / 旁白（按需）：简洁适配视频时长，贴合内容节奏，语言自然，符合整体情绪；
音效 / 配乐（按需）：明确背景音乐风格、环境音细节、特效音，贴合画面节奏和情绪，增强沉浸感。
AI 适配优化：结合主流 AI 视频生成工具的特性（时长限制、运镜兼容性、动态效果上限、细节渲染能力），优化提示词表述，避免模糊化描述，确保 AI 能精准解析，减少生成偏差；优先选择 AI 易实现的动态和光影效果，同时保留核心视觉诉求。
输出规范：仅输出润色后的完整视频提示词，无任何多余解释、前缀或后缀，语言简洁精准、逻辑清晰，镜头和动态描述连贯，可直接复制用于 AI 视频生成。";

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ChatMessage {
    role: String,
    content: ChatContent,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum ChatContent {
    Text(String),
    Array(Vec<ContentPart>),
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ContentPart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<ImageUrl>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ImageUrl {
    url: String,
}

#[derive(Debug, serde::Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

// Responses API 格式 - 用于图片输入
#[derive(Debug, serde::Serialize)]
struct ResponsesInputContent {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct ResponsesInput {
    role: String,
    content: Vec<ResponsesInputContent>,
}

#[derive(Debug, serde::Serialize)]
struct ResponsesRequest {
    model: String,
    input: Vec<ResponsesInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ResponsesReasoning>,
}

#[derive(Debug, serde::Serialize)]
struct ResponsesReasoning {
    effort: String,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesResponse {
    output: Option<ResponsesOutput>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesOutput {
    choices: Option<Vec<ResponsesChoice>>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesChoice {
    message: Option<ResponsesMessage>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesMessage {
    content: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ChatResponse {
    choices: Option<Vec<Choice>>,
}

#[derive(Debug, serde::Deserialize)]
struct Choice {
    message: Option<ResponseMessage>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponseMessage {
    content: Option<String>,
}

fn validate_generate_text_request(request: &GenerateTextRequest) -> Result<(), String> {
    if request.model.trim().is_empty() {
        return Err("请选择文本模型".to_string());
    }
    if request.api_key.trim().is_empty() {
        return Err("请先配置 API 密钥".to_string());
    }
    if request.text.trim().is_empty()
        && request.reference_images.as_ref().map_or(true, Vec::is_empty)
    {
        return Err("请输入文本或连接图片".to_string());
    }
    Ok(())
}

fn validate_text_reference_image(image_url: &str) -> Result<(), String> {
    if image_url.starts_with("http://")
        || image_url.starts_with("https://")
        || image_url.starts_with("data:image/")
    {
        return Ok(());
    }
    Err("参考图片无法读取，请重新连接或上传图片".to_string())
}

fn reference_image_label(index: usize) -> String {
    format!("图片 {}：", index + 1)
}

fn build_generate_text_chat_request(request: &GenerateTextRequest) -> Result<ChatRequest, String> {
    validate_generate_text_request(request)?;
    let images = request.reference_images.as_deref().unwrap_or(&[]);
    for image_url in images {
        validate_text_reference_image(image_url)?;
    }

    let content = if images.is_empty() {
        ChatContent::Text(request.text.clone())
    } else {
        let mut parts = Vec::with_capacity(images.len() * 2 + 1);
        for (index, image_url) in images.iter().enumerate() {
            parts.push(ContentPart {
                part_type: "text".to_string(),
                text: Some(reference_image_label(index)),
                image_url: None,
            });
            parts.push(ContentPart {
                part_type: "image_url".to_string(),
                text: None,
                image_url: Some(ImageUrl {
                    url: image_url.clone(),
                }),
            });
        }
        if !request.text.trim().is_empty() {
            parts.push(ContentPart {
                part_type: "text".to_string(),
                text: Some(request.text.clone()),
                image_url: None,
            });
        }
        ChatContent::Array(parts)
    };

    Ok(ChatRequest {
        model: request.model.clone(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content,
        }],
        stream: Some(false),
        reasoning_effort: request.reasoning_effort.clone(),
    })
}

fn build_generate_text_responses_request(
    request: &GenerateTextRequest,
) -> Result<ResponsesRequest, String> {
    validate_generate_text_request(request)?;
    let images = request.reference_images.as_deref().unwrap_or(&[]);
    let mut content = Vec::with_capacity(images.len() * 2 + 1);
    for (index, image_url) in images.iter().enumerate() {
        validate_text_reference_image(image_url)?;
        content.push(ResponsesInputContent {
            part_type: "input_text".to_string(),
            image_url: None,
            text: Some(reference_image_label(index)),
        });
        content.push(ResponsesInputContent {
            part_type: "input_image".to_string(),
            image_url: Some(image_url.clone()),
            text: None,
        });
    }
    if !request.text.trim().is_empty() {
        content.push(ResponsesInputContent {
            part_type: "input_text".to_string(),
            image_url: None,
            text: Some(request.text.clone()),
        });
    }

    Ok(ResponsesRequest {
        model: request.model.clone(),
        input: vec![ResponsesInput {
            role: "user".to_string(),
            content,
        }],
        reasoning: request
            .reasoning_effort
            .clone()
            .map(|effort| ResponsesReasoning { effort }),
    })
}

fn non_empty_json_text(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?;
    (!text.trim().is_empty()).then(|| text.to_string())
}

fn extract_generated_text(payload: &Value) -> Result<String, String> {
    if let Some(text) = non_empty_json_text(payload.get("output_text")) {
        return Ok(text);
    }
    if let Some(text) = non_empty_json_text(
        payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content")),
    ) {
        return Ok(text);
    }

    if let Some(output) = payload.get("output") {
        if let Some(text) = non_empty_json_text(
            output
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|message| message.get("content")),
        ) {
            return Ok(text);
        }

        if let Some(items) = output.as_array() {
            let mut text_parts = Vec::new();
            for item in items {
                let item_type = item.get("type").and_then(Value::as_str);
                if matches!(item_type, None | Some("output_text")) {
                    if let Some(text) = non_empty_json_text(item.get("text")) {
                        text_parts.push(text);
                        continue;
                    }
                }
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        let part_type = part.get("type").and_then(Value::as_str);
                        if matches!(part_type, None | Some("output_text")) {
                            if let Some(text) = non_empty_json_text(part.get("text")) {
                                text_parts.push(text);
                            }
                        }
                    }
                }
            }
            if !text_parts.is_empty() {
                return Ok(text_parts.concat());
            }
        }
    }

    Err("API 返回内容为空".to_string())
}

fn resolve_responses_endpoint(base_url: &str) -> Result<String, String> {
    let normalized = base_url.trim();
    if normalized.is_empty() {
        return Err("请填写 Base URL".to_string());
    }
    let mut url = reqwest::Url::parse(normalized)
        .map_err(|error| format!("Base URL 无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 仅支持 HTTP(S)".to_string());
    }
    let base_path = url.path().trim_end_matches('/');
    let endpoint_path = if base_path.ends_with("/responses") {
        base_path.to_string()
    } else if base_path.is_empty() {
        "/v1/responses".to_string()
    } else {
        format!("{base_path}/responses")
    };
    url.set_path(&endpoint_path);
    Ok(url.to_string())
}

fn text_api_error(status: reqwest::StatusCode, raw_response: &str) -> String {
    let summary = if status.is_server_error() {
        "服务器内部错误，请稍后重试"
    } else if status.as_u16() == 401 {
        "API 密钥无效或已过期"
    } else if status.as_u16() == 403 {
        "API 访问被拒绝，请检查密钥权限"
    } else if status.as_u16() == 429 {
        "请求过于频繁，请稍后重试"
    } else {
        "请求参数有误"
    };
    format!("API 调用失败 [{}]: {} | 错误详情: {}", status, summary, raw_response)
}

#[tauri::command]
pub async fn generate_text(request: GenerateTextRequest) -> Result<String, String> {
    info!(
        "Generating text with model: {}, base_url: {}, reference_images: {}",
        request.model,
        request.base_url,
        request.reference_images.as_ref().map_or(0, Vec::len)
    );

    let client = reqwest::Client::new();
    let use_responses_api =
        request.base_url.contains("/api/v3") && !request.base_url.contains("/coding");
    let response = if use_responses_api {
        let endpoint = resolve_responses_endpoint(&request.base_url)?;
        let body = build_generate_text_responses_request(&request)?;
        client
            .post(endpoint)
            .bearer_auth(&request.api_key)
            .json(&body)
            .send()
            .await
    } else {
        let endpoint = resolve_chat_completions_endpoint(&request.base_url)?;
        let body = build_generate_text_chat_request(&request)?;
        client
            .post(endpoint)
            .bearer_auth(&request.api_key)
            .json(&body)
            .send()
            .await
    }
    .map_err(|error| format!("网络请求失败，请检查网络连接: {error}"))?;

    let status = response.status();
    let raw_response = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(text_api_error(status, &raw_response));
    }
    let payload = serde_json::from_str::<Value>(&raw_response)
        .map_err(|error| format!("响应格式解析失败: {error}"))?;
    extract_generated_text(&payload)
}

// 构建视频元信息前缀提示词（仅包含必须由用户选择的固定参数）
fn build_video_metadata_prefix(
    duration: Option<&str>,
    resolution: Option<&str>,
    aspect_ratio: Option<&str>,
    is_video_frame: bool,
) -> String {
    let mut parts = Vec::new();
    parts.push("当前视频生成固定参数（由用户选择，AI需遵循）：".to_string());

    if let Some(d) = duration {
        if !d.is_empty() {
            parts.push(format!("- 时长：{}秒", d));
        }
    }
    if let Some(r) = resolution {
        if !r.is_empty() {
            parts.push(format!("- 分辨率：{}", r));
        }
    }
    if let Some(a) = aspect_ratio {
        if !a.is_empty() {
            parts.push(format!("- 画面宽高比：{}", a));
        }
    }
    // 添加首尾帧模式说明
    if is_video_frame {
        parts.push("- 模式：首尾帧视频（图1为首帧，图2为尾帧）".to_string());
    }

    if parts.len() == 1 {
        // 只有标题，没有实际参数
        String::new()
    } else {
        parts.push("以上为用户已选择的固定参数，AI在优化提示词时必须遵循。".to_string());
        parts.join("\n")
    }
}

#[tauri::command]
pub async fn polish_text(request: PolishTextRequest) -> Result<String, String> {
    info!("Polishing text with model: {}, base_url: {}", request.model, request.base_url);

    let model = request.model.clone();
    let has_reference = request.reference_images.as_ref().map(|r| !r.is_empty()).unwrap_or(false);

    let client = reqwest::Client::new();

    // 判断使用 Responses API 还是 Chat API
    // Responses API 使用 /api/v3 基础路径，Chat API 使用 /api/coding
    let is_responses_api = request.base_url.contains("/api/v3") && !request.base_url.contains("/coding");

    // 构建视频元信息前缀
    let video_metadata_prefix = build_video_metadata_prefix(
        request.video_duration.as_deref(),
        request.video_resolution.as_deref(),
        request.video_aspect_ratio.as_deref(),
        request.is_video_frame.unwrap_or(false),
    );

    if is_responses_api {
        // 使用 Responses API 格式
        let endpoint = format!("{}/responses", request.base_url.trim_end_matches('/'));
        info!("[PolishText] using Responses API format, endpoint: {}", endpoint);

        // 如果有视频元信息，构建增强版提示词
        let enhanced_text = if !video_metadata_prefix.is_empty() {
            format!("{}\n\n{}", video_metadata_prefix, request.text)
        } else {
            request.text.clone()
        };

        // 构建用户提示词 - 根据 prompt_type 选择默认模板
        let default_template = match request.prompt_type.as_deref() {
            Some("image") => BACKUP_TEXT_POLISH_TEMPLATE,
            Some("text") => BACKUP_TEXT_NODE_POLISH_TEMPLATE,
            Some("video") | None => BACKUP_VIDEO_POLISH_TEMPLATE,
            _ => BACKUP_VIDEO_POLISH_TEMPLATE,
        };

        let user_text = if let Some(ref custom) = request.custom_prompt {
            if custom.trim().is_empty() {
                // 使用默认模板
                if has_reference {
                    format!("{}\n\n请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", default_template, enhanced_text)
                } else {
                    format!("{}\n\n请润色这个提示词：{}", default_template, enhanced_text)
                }
            } else {
                // 使用用户自定义模板
                if has_reference {
                    format!("{}\n\n请润色这个提示词：{}\n\n参考图片已提供。", custom, enhanced_text)
                } else {
                    format!("{}\n\n请润色这个提示词：{}", custom, enhanced_text)
                }
            }
        } else {
            // 使用默认模板
            if has_reference {
                format!("{}\n\n请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", default_template, enhanced_text)
            } else {
                format!("{}\n\n请润色这个提示词：{}", default_template, enhanced_text)
            }
        };

        // 构建 Responses API 格式的 input
        let mut content_parts = Vec::new();

        // 添加参考图片
        if has_reference {
            for img_url in request.reference_images.as_ref().unwrap_or(&vec![]).iter() {
                content_parts.push(ResponsesInputContent {
                    part_type: "input_image".to_string(),
                    image_url: Some(img_url.clone()),
                    text: None,
                });
            }
        }

        // 添加文本
        content_parts.push(ResponsesInputContent {
            part_type: "input_text".to_string(),
            image_url: None,
            text: Some(user_text),
        });

        let body = ResponsesRequest {
            model: model.clone(),
            input: vec![ResponsesInput {
                role: "user".to_string(),
                content: content_parts,
            }],
            reasoning: request.reasoning_effort.clone().map(|effort| ResponsesReasoning { effort }),
        };

        info!("[PolishText] calling Responses API endpoint: {}", endpoint);

        let response = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", request.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            let error_detail = if status.as_u16() >= 500 {
                "服务器内部错误，请稍后重试"
            } else if status.as_u16() == 401 {
                "API密钥无效或已过期"
            } else if status.as_u16() == 403 {
                "API访问被拒绝，请检查密钥权限"
            } else if status.as_u16() == 429 {
                "请求过于频繁，请稍后重试"
            } else {
                "请求参数有误"
            };
            return Err(format!("API调用失败 [{}]: {} | 错误详情: {}", status, error_detail, raw_response));
        }

        let resp: ResponsesResponse = serde_json::from_str(&raw_response)
            .map_err(|e| format!("响应格式解析失败: {}", e))?;

        if let Some(output) = resp.output {
            if let Some(choices) = output.choices {
                if let Some(choice) = choices.first() {
                    if let Some(msg) = &choice.message {
                        if let Some(content) = &msg.content {
                            return Ok(content.clone());
                        }
                    }
                }
            }

            return Err("API返回内容为空".to_string());
        } else {
            return Err("API返回内容为空".to_string());
        }
    } else {
        // 使用 Chat API 格式（OpenAI兼容）
        let endpoint = resolve_chat_completions_endpoint(&request.base_url)?;

        info!("[PolishText] using Chat API format, endpoint: {}", endpoint);

        // 如果有视频元信息，构建增强版提示词
        let enhanced_text = if !video_metadata_prefix.is_empty() {
            format!("{}\n\n{}", video_metadata_prefix, request.text)
        } else {
            request.text.clone()
        };

        // 构建消息
        let mut messages = Vec::new();

        // 如果有自定义提示词模板，使用它；否则根据 prompt_type 选择默认模板
        let default_template = match request.prompt_type.as_deref() {
            Some("image") => BACKUP_TEXT_POLISH_TEMPLATE,
            Some("text") => BACKUP_TEXT_NODE_POLISH_TEMPLATE,
            Some("video") | None => BACKUP_VIDEO_POLISH_TEMPLATE, // 默认用视频模板
            _ => BACKUP_VIDEO_POLISH_TEMPLATE,
        };

        let (system_content, user_text) = if let Some(ref custom) = request.custom_prompt {
            if custom.trim().is_empty() {
                // 空模板，使用默认模板
                let usr_default = if has_reference {
                    format!("请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", enhanced_text)
                } else {
                    format!("请润色这个提示词：{}", enhanced_text)
                };
                (default_template.to_string(), usr_default)
            } else {
                // 使用自定义模板
                let sys = custom.trim();
                let usr = if has_reference {
                    format!("请润色这个提示词：{}\n\n参考图片已提供。", enhanced_text)
                } else {
                    format!("请润色这个提示词：{}", enhanced_text)
                };
                (sys.to_string(), usr)
            }
        } else {
            // 使用默认模板
            let usr_content = if has_reference {
                format!("请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", enhanced_text)
            } else {
                format!("请润色这个提示词：{}", enhanced_text)
            };
            (default_template.to_string(), usr_content)
        };

        messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(system_content),
        });

    // 构建用户消息
    let user_content = if has_reference {
        let mut parts = Vec::new();

        // 添加参考图片 - 支持 http/https URL 和 data:image base64
        let mut valid_image_count = 0;
        for img_url in request.reference_images.as_ref().unwrap_or(&vec![]).iter() {
            if img_url.starts_with("http://") || img_url.starts_with("https://") || img_url.starts_with("data:") {
                parts.push(ContentPart {
                    part_type: "image_url".to_string(),
                    text: None,
                    image_url: Some(ImageUrl { url: img_url.clone() }),
                });
                valid_image_count += 1;
            }
        }
        info!("[PolishText] valid images added: {}", valid_image_count);

        let text_part = user_text;
        parts.push(ContentPart {
            part_type: "text".to_string(),
            text: Some(text_part),
            image_url: None,
        });

        ChatContent::Array(parts)
    } else {
        ChatContent::Text(user_text)
    };

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_content,
    });

    let body = ChatRequest {
        model: model.clone(),
        messages,
        stream: Some(false),
        reasoning_effort: request.reasoning_effort.clone(),
    };

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    let status = response.status();
    let raw_response = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error_detail = if status.as_u16() >= 500 {
            "服务器内部错误，请稍后重试"
        } else if status.as_u16() == 401 {
            "API密钥无效或已过期"
        } else if status.as_u16() == 403 {
            "API访问被拒绝，请检查密钥权限"
        } else if status.as_u16() == 429 {
            "请求过于频繁，请稍后重试"
        } else {
            "请求参数有误"
        };
        return Err(format!("API调用失败 [{}]: {} | 错误详情: {}", status, error_detail, raw_response));
    }

    let resp: ChatResponse = serde_json::from_str(&raw_response)
        .map_err(|e| format!("响应格式解析失败: {}", e))?;

    if let Some(choices) = resp.choices {
        if let Some(choice) = choices.first() {
            if let Some(msg) = &choice.message {
                if let Some(content) = &msg.content {
                    return Ok(content.clone());
                }
            }
        }

        return Err("API返回内容为空".to_string());
        } else {
            return Err("API返回内容为空".to_string());
        }
    }
}

#[tauri::command]
pub async fn test_text_api(
    request: PolishTextRequest,
) -> Result<String, String> {
    info!("Testing text API with model: {}, base_url: {}", request.model, request.base_url);

    let model = request.model.clone();
    let client = reqwest::Client::new();

    let endpoint = resolve_chat_completions_endpoint(&request.base_url)?;

    let messages = vec![
        ChatMessage {
            role: "user".to_string(),
            content: ChatContent::Text("你是什么模型？请简单介绍一下你自己。".to_string()),
        },
    ];

    let body = ChatRequest {
        model: model.clone(),
        messages,
        stream: Some(false),
        reasoning_effort: request.reasoning_effort.clone(),
    };

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    let status = response.status();
    let raw_response = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error_detail = if status.as_u16() >= 500 {
            "服务器内部错误，请稍后重试"
        } else if status.as_u16() == 401 {
            "API密钥无效或已过期"
        } else if status.as_u16() == 403 {
            "API访问被拒绝，请检查密钥权限"
        } else if status.as_u16() == 429 {
            "请求过于频繁，请稍后重试"
        } else {
            "请求参数有误"
        };
        return Err(format!("API调用失败 [{}]: {} | 错误详情: {}", status, error_detail, raw_response));
    }

    let resp: ChatResponse = serde_json::from_str(&raw_response)
        .map_err(|e| format!("响应格式解析失败: {}", e))?;

    if let Some(choices) = resp.choices {
        if let Some(choice) = choices.first() {
            if let Some(msg) = &choice.message {
                if let Some(content) = &msg.content {
                    return Ok(format!("API连接成功！测试回复: {}", content));
                }
            }
        }
    }

    Err("API返回内容为空".to_string())
}
