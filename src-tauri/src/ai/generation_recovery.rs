pub const MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES: u32 = 5;

const RETRY_BASE_DELAY_MS: i64 = 1_000;
const RETRY_MAX_DELAY_MS: i64 = 30_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PollRecovery {
    pub retry_count: u32,
    pub next_poll_at: Option<i64>,
    pub requires_manual_requery: bool,
    pub last_error: Option<String>,
}

pub fn clear_poll_recovery() -> PollRecovery {
    PollRecovery {
        retry_count: 0,
        next_poll_at: None,
        requires_manual_requery: false,
        last_error: None,
    }
}

pub fn is_retryable_poll_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 425 | 429) || status.is_server_error()
}

pub fn schedule_transient_poll_retry(
    task_id: &str,
    previous_retry_count: u32,
    now_ms: i64,
    error: &str,
) -> PollRecovery {
    let retry_count = previous_retry_count.saturating_add(1);
    let requires_manual_requery = retry_count >= MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES;
    let next_poll_at = (!requires_manual_requery)
        .then(|| now_ms.saturating_add(retry_delay_ms(task_id, retry_count)));

    PollRecovery {
        retry_count,
        next_poll_at,
        requires_manual_requery,
        last_error: Some(error.to_string()),
    }
}

fn retry_delay_ms(task_id: &str, retry_count: u32) -> i64 {
    let exponent = retry_count.saturating_sub(1).min(5);
    let exponential_delay = RETRY_BASE_DELAY_MS
        .saturating_mul(1_i64 << exponent)
        .min(RETRY_MAX_DELAY_MS);
    let jitter_window = (exponential_delay / 2).max(1);
    let jitter = stable_retry_jitter(task_id, retry_count) % jitter_window as u64;

    exponential_delay.saturating_add(jitter as i64)
}

fn stable_retry_jitter(task_id: &str, retry_count: u32) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in task_id.bytes().chain(retry_count.to_le_bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::{
        is_retryable_poll_status, schedule_transient_poll_retry,
        MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES,
    };
    use reqwest::StatusCode;

    #[test]
    fn schedules_a_requery_without_losing_the_supplier_task_after_the_first_network_error() {
        let now_ms = 1_000_i64;
        let recovery = schedule_transient_poll_retry(
            "imgtask_795e3255-352c-420d-9785-91e167b416a3",
            0,
            now_ms,
            "Network error: error sending request",
        );

        assert_eq!(recovery.retry_count, 1);
        assert!(!recovery.requires_manual_requery);
        assert!(recovery.next_poll_at.is_some_and(|value| value > now_ms));
        assert_eq!(
            recovery.last_error.as_deref(),
            Some("Network error: error sending request")
        );
    }

    #[test]
    fn requires_manual_requery_after_the_transient_failure_budget_is_exhausted() {
        let recovery = schedule_transient_poll_retry(
            "imgtask_795e3255-352c-420d-9785-91e167b416a3",
            MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES - 1,
            1_000,
            "Network error: timed out",
        );

        assert_eq!(
            recovery.retry_count,
            MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES
        );
        assert!(recovery.requires_manual_requery);
        assert_eq!(recovery.next_poll_at, None);
    }

    #[test]
    fn recognizes_transient_http_poll_responses_without_retrying_configuration_errors() {
        assert!(is_retryable_poll_status(StatusCode::REQUEST_TIMEOUT));
        assert!(is_retryable_poll_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_poll_status(StatusCode::BAD_GATEWAY));
        assert!(!is_retryable_poll_status(StatusCode::BAD_REQUEST));
        assert!(!is_retryable_poll_status(StatusCode::UNAUTHORIZED));
    }
}
