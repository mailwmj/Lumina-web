use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const CANVAS_AGENT_BINARY_NAME: &str = "lumina-canvas-agent";
const CANVAS_AGENT_CONFIG_FILE: &str = "canvas-agent.json";
const CANVAS_AGENT_URL: &str = "http://127.0.0.1:17372";

#[derive(Clone, Deserialize, Serialize)]
struct CanvasAgentConfig {
    url: String,
    token: String,
    #[serde(default)]
    origins: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasAgentRuntimeInfo {
    available: bool,
    running: bool,
    url: Option<String>,
    token: Option<String>,
    registration_command: Option<String>,
    error: Option<String>,
}

struct CanvasAgentProcess {
    binary_path: Option<PathBuf>,
    config_path: Option<PathBuf>,
    config: Option<CanvasAgentConfig>,
    child: Option<Child>,
    last_error: Option<String>,
}

impl CanvasAgentProcess {
    fn new(app: &AppHandle) -> Self {
        let (binary_path, binary_error) = match resolve_canvas_agent_binary() {
            Ok(path) => (Some(path), None),
            Err(error) => (None, Some(error)),
        };
        let (config_path, config_error) = match app
            .path()
            .app_config_dir()
            .map(|directory| directory.join(CANVAS_AGENT_CONFIG_FILE))
        {
            Ok(path) => (Some(path), None),
            Err(error) => (None, Some(error.to_string())),
        };

        let mut process = Self {
            binary_path,
            config_path,
            config: None,
            child: None,
            last_error: binary_error.or(config_error),
        };

        if process.last_error.is_none() {
            match process.config_path.as_deref().map(load_or_create_config) {
                Some(Ok(config)) => process.config = Some(config),
                Some(Err(error)) => process.last_error = Some(error),
                None => {
                    process.last_error =
                        Some("Canvas Agent config path is unavailable.".to_string())
                }
            }
        }
        process.ensure_running();
        process
    }

    fn ensure_running(&mut self) {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return,
                Ok(Some(status)) => {
                    self.last_error = Some(format!(
                        "Canvas Agent exited before it was needed ({status})."
                    ));
                    self.child = None;
                }
                Err(error) => {
                    self.last_error = Some(format!("Failed to inspect Canvas Agent: {error}"));
                    self.child = None;
                }
            }
        }

        let (Some(binary_path), Some(config_path), Some(_config)) = (
            self.binary_path.as_deref(),
            self.config_path.as_deref(),
            self.config.as_ref(),
        ) else {
            return;
        };
        if !binary_path.is_file() {
            self.last_error = Some(format!(
                "Canvas Agent executable is missing: {}",
                binary_path.display()
            ));
            return;
        }

        let mut command = Command::new(binary_path);
        command
            .arg("serve")
            .arg("--config")
            .arg(config_path)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_process(&mut command);

        match command.spawn() {
            Ok(child) => {
                self.child = Some(child);
                self.last_error = None;
            }
            Err(error) => {
                self.last_error = Some(format!("Failed to start Canvas Agent: {error}"));
            }
        }
    }

    fn runtime_info(&mut self) -> CanvasAgentRuntimeInfo {
        self.ensure_running();
        let running = self
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .is_some_and(|status| status.is_none());
        if !running && self.last_error.is_none() && self.child.is_some() {
            self.last_error = Some("Canvas Agent process is unavailable.".to_string());
        }

        let available = self.binary_path.as_deref().is_some_and(Path::is_file)
            && self.config.is_some()
            && self.config_path.is_some();
        let registration_command = if available {
            self.registration_command()
        } else {
            None
        };

        CanvasAgentRuntimeInfo {
            available,
            running,
            url: self.config.as_ref().map(|config| config.url.clone()),
            token: self.config.as_ref().map(|config| config.token.clone()),
            registration_command,
            error: self.last_error.clone(),
        }
    }

    fn registration_command(&self) -> Option<String> {
        let binary_path = self.binary_path.as_deref()?.to_string_lossy();
        let config_path = self.config_path.as_deref()?.to_string_lossy();
        Some(format!(
            "codex mcp add lumina -- {} mcp --config {}",
            quote_command_argument(&binary_path),
            quote_command_argument(&config_path)
        ))
    }

    fn stop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

impl Drop for CanvasAgentProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct CanvasAgentManager {
    process: Mutex<CanvasAgentProcess>,
}

impl CanvasAgentManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            process: Mutex::new(CanvasAgentProcess::new(app)),
        }
    }

    pub fn startup_error(&self) -> Option<String> {
        self.process
            .lock()
            .ok()
            .and_then(|process| process.last_error.clone())
    }

    fn runtime_info(&self) -> CanvasAgentRuntimeInfo {
        match self.process.lock() {
            Ok(mut process) => process.runtime_info(),
            Err(_) => CanvasAgentRuntimeInfo {
                available: false,
                running: false,
                url: None,
                token: None,
                registration_command: None,
                error: Some("Canvas Agent process state is unavailable.".to_string()),
            },
        }
    }
}

#[tauri::command]
pub fn get_canvas_agent_runtime(manager: State<'_, CanvasAgentManager>) -> CanvasAgentRuntimeInfo {
    manager.runtime_info()
}

fn load_or_create_config(path: &Path) -> Result<CanvasAgentConfig, String> {
    if let Ok(contents) = fs::read_to_string(path) {
        if let Ok(config) = serde_json::from_str::<CanvasAgentConfig>(&contents) {
            if let Some(normalized) = normalize_config(config) {
                if let Some(directory) = path.parent() {
                    secure_directory(directory)?;
                }
                secure_file(path)?;
                return Ok(normalized);
            }
        }
    }

    let config = CanvasAgentConfig {
        url: CANVAS_AGENT_URL.to_string(),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        origins: default_origins(),
    };
    write_config(path, &config)?;
    Ok(config)
}

fn normalize_config(mut config: CanvasAgentConfig) -> Option<CanvasAgentConfig> {
    let parsed = reqwest::Url::parse(config.url.trim()).ok()?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || config.token.trim().len() < 32
    {
        return None;
    }
    config.url = config.url.trim().trim_end_matches('/').to_string();
    config.token = config.token.trim().to_string();
    for origin in default_origins() {
        if !config.origins.contains(&origin) {
            config.origins.push(origin);
        }
    }
    Some(config)
}

fn write_config(path: &Path, config: &CanvasAgentConfig) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Canvas Agent config directory is unavailable.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create Canvas Agent config directory: {error}"))?;
    secure_directory(directory)?;

    let contents = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Failed to encode Canvas Agent config: {error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open Canvas Agent config: {error}"))?;
    file.write_all(&contents)
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("Failed to write Canvas Agent config: {error}"))?;
    secure_file(path)?;
    Ok(())
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to protect Canvas Agent config directory: {error}"))
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to protect Canvas Agent config: {error}"))
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn default_origins() -> Vec<String> {
    [
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn resolve_canvas_agent_binary() -> Result<PathBuf, String> {
    let executable_name = platform_binary_name(CANVAS_AGENT_BINARY_NAME);
    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(directory) = current_executable.parent() {
            let bundled_path = directory.join(&executable_name);
            if bundled_path.is_file() {
                return Ok(bundled_path);
            }
        }
    }

    let target_name = platform_binary_name(&format!(
        "{CANVAS_AGENT_BINARY_NAME}-{}",
        env!("LUMINA_TARGET_TRIPLE")
    ));
    let development_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(target_name);
    if development_path.is_file() {
        return Ok(development_path);
    }

    Err(format!(
        "Canvas Agent executable is not bundled and no development binary exists at {}.",
        development_path.display()
    ))
}

#[cfg(target_os = "windows")]
fn platform_binary_name(base: &str) -> String {
    format!("{base}.exe")
}

#[cfg(not(target_os = "windows"))]
fn platform_binary_name(base: &str) -> String {
    base.to_string()
}

#[cfg(target_os = "windows")]
fn configure_background_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_background_process(_command: &mut Command) {}

#[cfg(target_os = "windows")]
fn quote_command_argument(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

#[cfg(not(target_os = "windows"))]
fn quote_command_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_loopback_config() {
        assert!(normalize_config(CanvasAgentConfig {
            url: "http://0.0.0.0:17372".to_string(),
            token: "a".repeat(64),
            origins: vec![],
        })
        .is_none());
    }

    #[test]
    fn keeps_a_valid_owner_local_config() {
        let config = normalize_config(CanvasAgentConfig {
            url: "http://127.0.0.1:17372/".to_string(),
            token: "a".repeat(64),
            origins: vec![],
        })
        .expect("valid config");

        assert_eq!(config.url, CANVAS_AGENT_URL);
        assert!(config.origins.contains(&"tauri://localhost".to_string()));
    }
}
