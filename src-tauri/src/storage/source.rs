use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::redirect::Policy;
use std::path::{Path, PathBuf};
use std::net::IpAddr;
use tokio::net::lookup_host;
use url::Url;
use urlencoding::decode;

const MAX_REMOTE_MEDIA_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub bytes: Vec<u8>,
    pub extension: String,
    pub content_type: String,
    pub file_name: String,
}

pub async fn resolve_media_source(source: &str) -> Result<ResolvedMedia, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("媒体源为空".to_string());
    }

    let (bytes, extension, file_name) = if let Some(payload) = trimmed.strip_prefix("data:") {
        let (metadata, encoded) = payload
            .split_once(',')
            .ok_or_else(|| "无效的 data URL 格式".to_string())?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|error| format!("data URL Base64 解码失败: {error}"))?;
        let extension = metadata
            .split(';')
            .next()
            .and_then(extension_from_content_type)
            .unwrap_or_else(|| "bin".to_string());
        (bytes, extension.clone(), format!("input.{extension}"))
    } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return resolve_remote_media_source(trimmed).await;
    } else {
        let path = resolve_local_path(trimmed)?;
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("读取媒体文件失败 {}: {error}", path.display()))?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("input.bin")
            .to_string();
        (bytes, extension, file_name)
    };

    if bytes.is_empty() {
        return Err("媒体数据为空".to_string());
    }

    let content_type = content_type_from_extension(&extension);
    Ok(ResolvedMedia {
        bytes,
        extension,
        content_type,
        file_name,
    })
}

async fn resolve_remote_media_source(source: &str) -> Result<ResolvedMedia, String> {
    let mut current = Url::parse(source).map_err(|error| format!("远程媒体 URL 无效: {error}"))?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| format!("创建远程媒体客户端失败: {error}"))?;

    for _ in 0..=5 {
        validate_remote_url(&current).await?;
        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(|error| format!("读取远程媒体失败: {error}"))?;

        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "远程媒体重定向缺少 Location".to_string())?;
            current = current
                .join(location)
                .map_err(|error| format!("远程媒体重定向地址无效: {error}"))?;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("读取远程媒体失败: HTTP {}", response.status()));
        }
        let content_length = response.content_length().unwrap_or_default();
        if content_length > MAX_REMOTE_MEDIA_BYTES {
            return Err("远程媒体文件超过 512 MiB 限制".to_string());
        }
        let content_type_header = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("读取远程媒体内容失败: {error}"))?;
        if bytes.len() as u64 > MAX_REMOTE_MEDIA_BYTES {
            return Err("远程媒体文件超过 512 MiB 限制".to_string());
        }

        let extension = current
            .path_segments()
            .and_then(|segments| segments.last())
            .and_then(|name| Path::new(name).extension())
            .and_then(|extension| extension.to_str())
            .filter(|extension| !extension.is_empty())
            .map(|extension| extension.to_ascii_lowercase())
            .or_else(|| extension_from_content_type(&content_type_header))
            .unwrap_or_else(|| "bin".to_string());
        let file_name = current
            .path_segments()
            .and_then(|segments| segments.last())
            .filter(|name| !name.is_empty())
            .unwrap_or("remote-input")
            .to_string();

        return Ok(ResolvedMedia {
            bytes: bytes.to_vec(),
            extension,
            content_type: if content_type_header.is_empty() {
                "application/octet-stream".to_string()
            } else {
                content_type_header
            },
            file_name,
        });
    }

    Err("远程媒体重定向次数过多".to_string())
}

async fn validate_remote_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("远程媒体只允许 HTTP(S) URL".to_string());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("远程媒体 URL 不允许包含用户名或密码".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "远程媒体 URL 缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![ip]
    } else {
        lookup_host((host, port))
            .await
            .map_err(|error| format!("解析远程媒体主机失败: {error}"))?
            .map(|address| address.ip())
            .collect()
    };
    if addresses.is_empty() || addresses.iter().any(is_private_or_local_ip) {
        return Err("远程媒体地址解析到本机或内网地址，已拒绝".to_string());
    }
    Ok(())
}

fn is_private_or_local_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => {
            let [first, second, _, _] = value.octets();
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_unspecified()
                || value.is_multicast()
                || (first == 100 && (64..=127).contains(&second))
        }
        IpAddr::V6(value) => value.is_loopback()
            || value.is_unspecified()
            || value.is_multicast()
            || value.is_unique_local()
            || value.segments()[0] == 0xfe80,
    }
}

fn resolve_local_path(source: &str) -> Result<PathBuf, String> {
    let path = if source.starts_with("file://") {
        PathBuf::from(decode_file_url_path(source))
    } else if source.starts_with("asset://") {
        decode_asset_url_path(source)?
    } else {
        PathBuf::from(source)
    };

    if !path.exists() {
        return Err(format!("媒体文件不存在: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("媒体源不是文件: {}", path.display()));
    }
    Ok(path)
}

fn decode_file_url_path(value: &str) -> String {
    let raw = value.strip_prefix("file://").unwrap_or(value);
    let decoded = decode(raw).unwrap_or_else(|_| raw.into());
    #[cfg(target_os = "windows")]
    {
        decoded.trim_start_matches('/').to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        decoded.to_string()
    }
}

fn decode_asset_url_path(value: &str) -> Result<PathBuf, String> {
    let raw = value
        .strip_prefix("asset://")
        .ok_or_else(|| "无效的 asset URL".to_string())?;
    let raw = raw.strip_prefix("localhost/").unwrap_or(raw);
    let decoded = decode(raw).map_err(|error| format!("asset URL 解码失败: {error}"))?;
    #[cfg(target_os = "windows")]
    let decoded = decoded.trim_start_matches('/').to_string();
    #[cfg(not(target_os = "windows"))]
    let decoded = decoded.to_string();
    Ok(PathBuf::from(decoded))
}

fn extension_from_content_type(content_type: &str) -> Option<String> {
    match content_type.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" => Some("jpg".to_string()),
        "image/png" => Some("png".to_string()),
        "image/webp" => Some("webp".to_string()),
        "image/gif" => Some("gif".to_string()),
        "video/mp4" => Some("mp4".to_string()),
        "video/quicktime" => Some("mov".to_string()),
        "audio/mpeg" => Some("mp3".to_string()),
        "audio/wav" => Some("wav".to_string()),
        _ => None,
    }
}

fn content_type_from_extension(extension: &str) -> String {
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[allow(dead_code)]
fn _path_file_name(path: &Path) -> &str {
    path.file_name().and_then(|value| value.to_str()).unwrap_or("input.bin")
}

#[cfg(test)]
mod tests {
    use super::{content_type_from_extension, extension_from_content_type, is_private_or_local_ip};
    use std::net::IpAddr;

    #[test]
    fn maps_common_media_types() {
        assert_eq!(extension_from_content_type("image/png"), Some("png".into()));
        assert_eq!(content_type_from_extension("mp4"), "video/mp4");
    }

    #[test]
    fn rejects_private_and_loopback_addresses() {
        assert!(is_private_or_local_ip(&"127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_private_or_local_ip(&"192.168.1.10".parse::<IpAddr>().unwrap()));
        assert!(!is_private_or_local_ip(&"8.8.8.8".parse::<IpAddr>().unwrap()));
    }
}
