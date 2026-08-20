use std::env;

const TOS_BUILD_VARIABLES: [(&str, &str); 6] = [
    ("LUMINA_EMBEDDED_TOS_BUCKET", "LUMINA_BUNDLED_TOS_BUCKET"),
    ("LUMINA_EMBEDDED_TOS_REGION", "LUMINA_BUNDLED_TOS_REGION"),
    (
        "LUMINA_EMBEDDED_TOS_ENDPOINT",
        "LUMINA_BUNDLED_TOS_ENDPOINT",
    ),
    (
        "LUMINA_EMBEDDED_TOS_ACCESS_KEY",
        "LUMINA_BUNDLED_TOS_ACCESS_KEY",
    ),
    (
        "LUMINA_EMBEDDED_TOS_SECRET_KEY",
        "LUMINA_BUNDLED_TOS_SECRET_KEY",
    ),
    (
        "LUMINA_EMBEDDED_TOS_URL_TTL_SECONDS",
        "LUMINA_BUNDLED_TOS_URL_TTL_SECONDS",
    ),
];

fn main() {
    println!(
        "cargo:rustc-env=LUMINA_TARGET_TRIPLE={}",
        env::var("TARGET").expect("Cargo TARGET is unavailable")
    );
    embed_tos_configuration();
    tauri_build::build()
}

fn embed_tos_configuration() {
    let values: Vec<(&str, &str, Option<String>)> = TOS_BUILD_VARIABLES
        .iter()
        .map(|(source, target)| {
            println!("cargo:rerun-if-env-changed={source}");
            (
                *source,
                *target,
                env::var(source)
                    .ok()
                    .filter(|value| !value.trim().is_empty()),
            )
        })
        .collect();

    let credential_values = values
        .iter()
        .filter(|(source, _, _)| {
            matches!(
                *source,
                "LUMINA_EMBEDDED_TOS_BUCKET"
                    | "LUMINA_EMBEDDED_TOS_ACCESS_KEY"
                    | "LUMINA_EMBEDDED_TOS_SECRET_KEY"
            )
        })
        .collect::<Vec<_>>();
    let credential_count = credential_values
        .iter()
        .filter(|(_, _, value)| value.is_some())
        .count();

    if credential_count != 0 && credential_count != credential_values.len() {
        panic!(
            "嵌入 TOS 凭证时必须同时设置 LUMINA_EMBEDDED_TOS_BUCKET、LUMINA_EMBEDDED_TOS_ACCESS_KEY 和 LUMINA_EMBEDDED_TOS_SECRET_KEY"
        );
    }

    for (_, target, value) in values {
        if let Some(value) = value {
            if value.contains('\r') || value.contains('\n') {
                panic!("嵌入式 TOS 配置不能包含换行符");
            }
            println!("cargo:rustc-env={target}={value}");
        }
    }
}
