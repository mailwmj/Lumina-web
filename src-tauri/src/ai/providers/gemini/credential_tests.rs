use super::GeminiNativeImageProvider;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn generate_request(base_url: &str, api_key: &str) -> GenerateRequest {
    GenerateRequest {
        prompt: "design a character".to_string(),
        model: "gemini/gemini-3-pro-image-preview".to_string(),
        provider_id: None,
        size: "4K".to_string(),
        aspect_ratio: "4:3".to_string(),
        reference_images: None,
        video_content: None,
        extra_params: None,
        provider_config: Some(HashMap::from([
            ("base_url".to_string(), json!(base_url)),
            ("api_key".to_string(), json!(api_key)),
        ])),
        draft_task_id: None,
    }
}

async fn read_http_request(socket: &mut TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let (header_end, content_length) = loop {
        let bytes_read = socket.read(&mut buffer).await.unwrap();
        assert!(bytes_read > 0, "connection closed before request headers");
        request.extend_from_slice(&buffer[..bytes_read]);
        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            break (header_end + 4, content_length);
        }
    };
    while request.len() < header_end + content_length {
        let bytes_read = socket.read(&mut buffer).await.unwrap();
        assert!(bytes_read > 0, "connection closed before request body");
        request.extend_from_slice(&buffer[..bytes_read]);
    }
    request
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

async fn serve_queued_task(listener: TcpListener, task_id: &str) -> (Vec<u8>, Vec<u8>) {
    let (mut submit_socket, _) = listener.accept().await.unwrap();
    let submit_request = read_http_request(&mut submit_socket).await;
    let receipt = json!({
        "task_id": task_id,
        "status": "queued",
        "status_url": format!("/v1/images/tasks/{task_id}?view=summary"),
    })
    .to_string();
    write_json_response(&mut submit_socket, "202 Accepted", receipt.as_str()).await;
    drop(submit_socket);

    let (mut poll_socket, _) = listener.accept().await.unwrap();
    let poll_request = read_http_request(&mut poll_socket).await;
    let running = json!({ "id": task_id, "status": "running" }).to_string();
    write_json_response(&mut poll_socket, "200 OK", running.as_str()).await;
    (submit_request, poll_request)
}

async fn serve_two_queued_tasks(
    listener: TcpListener,
    task_id: &str,
) -> ([Vec<u8>; 2], [Vec<u8>; 2]) {
    let mut submit_requests = Vec::new();
    for _ in 0..2 {
        let (mut socket, _) = listener.accept().await.unwrap();
        submit_requests.push(read_http_request(&mut socket).await);
        let receipt = json!({
            "task_id": task_id,
            "status": "queued",
            "status_url": format!("/v1/images/tasks/{task_id}?view=summary"),
        })
        .to_string();
        write_json_response(&mut socket, "202 Accepted", receipt.as_str()).await;
    }

    let mut poll_requests = Vec::new();
    for _ in 0..2 {
        let (mut socket, _) = listener.accept().await.unwrap();
        poll_requests.push(read_http_request(&mut socket).await);
        let running = json!({ "id": task_id, "status": "running" }).to_string();
        write_json_response(&mut socket, "200 OK", running.as_str()).await;
    }

    (
        submit_requests.try_into().unwrap(),
        poll_requests.try_into().unwrap(),
    )
}

#[tokio::test]
async fn builds_native_request_with_inline_reference_images() {
    let provider = GeminiNativeImageProvider::new();
    let mut request = generate_request("https://gateway.example/v1beta", "test-key");
    request.reference_images = Some(vec!["data:image/png;base64,iVBORw0KGgo=".to_string()]);

    let body = provider.build_request_body(&request).await.unwrap();
    let parts = body
        .pointer("/contents/0/parts")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(parts[0], json!({ "text": "design a character" }));
    assert_eq!(
        parts[1],
        json!({ "inlineData": { "mimeType": "image/png", "data": "iVBORw0KGgo=" } })
    );
    assert_eq!(
        body.pointer("/generationConfig/imageConfig/aspectRatio")
            .and_then(Value::as_str),
        Some("4:3")
    );
    assert_eq!(
        body.pointer("/generationConfig/imageConfig/imageSize")
            .and_then(Value::as_str),
        Some("4K")
    );
}

#[tokio::test]
async fn polling_keeps_the_api_key_used_when_the_task_was_submitted() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve_queued_task(listener, "imgtask-bound-key"));
    let provider = GeminiNativeImageProvider::new();
    let submission = provider
        .submit_task(generate_request(
            format!("http://{address}/v1beta").as_str(),
            "submitted-task-key",
        ))
        .await
        .unwrap();
    let handle = match submission {
        ProviderTaskSubmission::Queued(handle) => handle,
        ProviderTaskSubmission::Succeeded(_) => panic!("expected queued task"),
    };
    provider
        .set_api_key("different-global-key".to_string())
        .await
        .unwrap();
    let changed_config = Some(HashMap::from([(
        "api_key".to_string(),
        json!("changed-provider-key"),
    )]));
    assert!(matches!(
        provider
            .poll_task_with_config(handle, changed_config)
            .await
            .unwrap(),
        ProviderTaskPollResult::Running
    ));

    let (submit_request, poll_request) = server.await.unwrap();
    let submit_headers = String::from_utf8_lossy(&submit_request).to_ascii_lowercase();
    let poll_headers = String::from_utf8_lossy(&poll_request).to_ascii_lowercase();
    assert!(submit_headers.contains("x-goog-api-key: submitted-task-key"));
    assert!(poll_headers.contains("x-goog-api-key: submitted-task-key"));
    assert!(!poll_headers.contains("different-global-key"));
    assert!(!poll_headers.contains("changed-provider-key"));
}

#[tokio::test]
async fn concurrent_tasks_with_the_same_remote_id_keep_separate_provider_credentials() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve_two_queued_tasks(listener, "shared-task-id"));
    let provider = GeminiNativeImageProvider::new();
    let first = provider
        .submit_task(generate_request(
            format!("http://{address}/v1beta").as_str(),
            "first-task-key",
        ))
        .await
        .unwrap();
    let second = provider
        .submit_task(generate_request(
            format!("http://{address}/v1beta").as_str(),
            "second-task-key",
        ))
        .await
        .unwrap();
    let ProviderTaskSubmission::Queued(first_handle) = first else {
        panic!("expected first queued task");
    };
    let ProviderTaskSubmission::Queued(second_handle) = second else {
        panic!("expected second queued task");
    };
    let changed_config = Some(HashMap::from([(
        "api_key".to_string(),
        json!("latest-provider-key"),
    )]));
    let (first_poll, second_poll) = tokio::join!(
        provider.poll_task_with_config(first_handle, changed_config.clone()),
        provider.poll_task_with_config(second_handle, changed_config),
    );
    assert!(matches!(
        first_poll.unwrap(),
        ProviderTaskPollResult::Running
    ));
    assert!(matches!(
        second_poll.unwrap(),
        ProviderTaskPollResult::Running
    ));

    let (submit_requests, poll_requests) = server.await.unwrap();
    let submit_headers =
        submit_requests.map(|request| String::from_utf8_lossy(&request).to_ascii_lowercase());
    let poll_headers =
        poll_requests.map(|request| String::from_utf8_lossy(&request).to_ascii_lowercase());
    assert!(submit_headers
        .iter()
        .any(|headers| headers.contains("x-goog-api-key: first-task-key")));
    assert!(submit_headers
        .iter()
        .any(|headers| headers.contains("x-goog-api-key: second-task-key")));
    assert!(poll_headers
        .iter()
        .any(|headers| headers.contains("x-goog-api-key: first-task-key")));
    assert!(poll_headers
        .iter()
        .any(|headers| headers.contains("x-goog-api-key: second-task-key")));
    assert!(poll_headers
        .iter()
        .all(|headers| !headers.contains("latest-provider-key")));
}

#[tokio::test]
async fn persisted_task_poll_uses_bound_config_without_storing_the_key() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut socket).await;
        write_json_response(&mut socket, "200 OK", r#"{"status":"running"}"#).await;
        request
    });
    let provider = GeminiNativeImageProvider::new();
    provider
        .set_api_key("different-global-key".to_string())
        .await
        .unwrap();
    let handle = ProviderTaskHandle {
        task_id: "imgtask-restored".to_string(),
        metadata: Some(json!({
            "base_url": format!("http://{address}/v1beta"),
            "status_url": "/v1/images/tasks/imgtask-restored?view=summary",
            "requires_bound_api_key": true,
            "credential_fingerprint": GeminiNativeImageProvider::api_key_fingerprint("restored-job-key"),
        })),
    };
    assert!(handle
        .metadata
        .as_ref()
        .is_some_and(|metadata| metadata.get("api_key").is_none()));
    let config = Some(HashMap::from([(
        "api_key".to_string(),
        json!("restored-job-key"),
    )]));
    assert!(matches!(
        provider
            .poll_task_with_config(handle, config)
            .await
            .unwrap(),
        ProviderTaskPollResult::Running
    ));
    let request = server.await.unwrap();
    let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
    assert!(headers.contains("x-goog-api-key: restored-job-key"));
    assert!(!headers.contains("different-global-key"));
}

#[tokio::test]
async fn persisted_task_rejects_a_different_provider_credential_fingerprint() {
    let provider = GeminiNativeImageProvider::new();
    let handle = ProviderTaskHandle {
        task_id: "imgtask-restored".to_string(),
        metadata: Some(json!({
            "base_url": "http://127.0.0.1:1/v1beta",
            "requires_bound_api_key": true,
            "credential_fingerprint": GeminiNativeImageProvider::api_key_fingerprint("original-key"),
        })),
    };
    let config = Some(HashMap::from([("api_key".to_string(), json!("other-key"))]));
    let error = provider
        .poll_task_with_config(handle, config)
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("does not match the submitted task"));
}
