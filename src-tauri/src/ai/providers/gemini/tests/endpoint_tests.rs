use super::*;

#[tokio::test]
async fn retries_a_missing_html_v1_route_at_v1beta() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut first_socket, _) = listener.accept().await.unwrap();
        let first_request = read_http_request(&mut first_socket).await;
        write_html_response(
            &mut first_socket,
            "404 Not Found",
            "<html><body>not found</body></html>",
        )
        .await;
        drop(first_socket);

        let (mut second_socket, _) = listener.accept().await.unwrap();
        let second_request = read_http_request(&mut second_socket).await;
        let receipt = r#"{"object":"media_task","id":"imgtask-456","task_id":"imgtask-456","status":"queued","execution_mode":"async","status_url":"/v1/images/tasks/imgtask-456?view=summary"}"#;
        write_json_response(&mut second_socket, "202 Accepted", receipt).await;

        (first_request, second_request)
    });

    let provider = GeminiNativeImageProvider::new();
    let submission = provider
        .submit_task(generate_request(
            format!("http://{address}/v1").as_str(),
            None,
        ))
        .await
        .unwrap();

    let handle = match submission {
        ProviderTaskSubmission::Queued(handle) => handle,
        ProviderTaskSubmission::Succeeded(_) => panic!("expected queued task receipt"),
    };
    let expected_base_url = format!("http://{address}/v1beta");
    assert_eq!(
        handle
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("base_url"))
            .and_then(Value::as_str),
        Some(expected_base_url.as_str())
    );

    let (first_request, second_request) = server.await.unwrap();
    let first_request = String::from_utf8_lossy(&first_request);
    let second_request = String::from_utf8_lossy(&second_request);
    assert!(first_request
        .starts_with("POST /v1/models/gemini-3-pro-image-preview:generateContent HTTP/1.1"));
    assert!(second_request
        .starts_with("POST /v1beta/models/gemini-3-pro-image-preview:generateContent HTTP/1.1"));
}
