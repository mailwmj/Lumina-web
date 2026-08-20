use std::sync::Arc;

use super::AIProvider;

pub mod bltcy;
pub mod codingplan;
pub mod fal;
pub mod gemini;
pub mod grsai;
pub(crate) mod image_input;
pub mod kie;
pub mod openai;
pub mod ppio;
pub mod runninghub;
pub mod volcvideo;

pub use bltcy::BltcyProvider;
pub use codingplan::CodingPlanProvider;
pub use fal::FalProvider;
pub use gemini::GeminiNativeImageProvider;
pub use grsai::GrsaiProvider;
pub use kie::KieProvider;
pub use openai::OpenAiProvider;
pub use ppio::PPIOProvider;
pub use runninghub::RunningHubProvider;
pub use volcvideo::VolcVideoProvider;

pub fn build_default_providers() -> Vec<Arc<dyn AIProvider>> {
    vec![
        Arc::new(OpenAiProvider::legacy()),
        Arc::new(OpenAiProvider::ai_media()),
        Arc::new(OpenAiProvider::chaomo()),
        Arc::new(OpenAiProvider::fhl()),
        Arc::new(GeminiNativeImageProvider::new()),
        Arc::new(CodingPlanProvider::new()),
        Arc::new(VolcVideoProvider::new()),
    ]
}

#[cfg(test)]
mod tests {
    use super::build_default_providers;

    #[test]
    fn default_provider_task_resume_capabilities_remain_explicit() {
        let capabilities = build_default_providers()
            .into_iter()
            .map(|provider| (provider.name().to_string(), provider.supports_task_resume()))
            .collect::<Vec<_>>();

        assert_eq!(
            capabilities,
            vec![
                ("openai".to_string(), false),
                ("ai-media".to_string(), true),
                ("chaomo".to_string(), true),
                ("fhl".to_string(), false),
                ("gemini".to_string(), true),
                ("codingplan".to_string(), false),
                ("volcvideo".to_string(), true),
            ]
        );
    }
}
