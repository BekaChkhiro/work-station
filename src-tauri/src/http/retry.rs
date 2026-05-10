//! T11.4: retry policy for the generic HTTP client.
//!
//! Acceptance: a 503 is retried 3× with exponential backoff. We retry on
//! 5xx and on transient transport errors (network/timeout). We do NOT retry
//! 4xx — including 429, which surfaces as a typed [`crate::http::HttpError::RateLimit`]
//! so the caller can decide its own back-off (often longer than ours).

use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Maximum number of *retry* attempts, in addition to the initial request.
    /// `max_attempts = 3` means up to 4 total requests (1 + 3 retries).
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(5),
        }
    }
}

impl RetryPolicy {
    /// Compute the sleep before retry `attempt` (0-indexed: `attempt = 0` is
    /// the first retry, fired after the initial request fails).
    ///
    /// Schedule: `base * 2^attempt`, clamped to `max_delay`, plus up to 25%
    /// jitter so concurrent callers don't synchronise on the same
    /// retry tick. The jitter source is a `u32` supplied by the caller —
    /// using `SystemTime::now().subsec_nanos()` keeps us off the `rand`
    /// dependency for what is, essentially, anti-thundering-herd noise.
    pub fn delay(&self, attempt: u32, jitter_nanos: u32) -> Duration {
        let multiplier = 1u64 << attempt.min(10);
        let base_ms = u64::try_from(self.base_delay.as_millis()).unwrap_or(0);
        let max_ms = u64::try_from(self.max_delay.as_millis()).unwrap_or(u64::MAX);
        let exp_ms = base_ms.saturating_mul(multiplier);
        let capped_ms = exp_ms.min(max_ms);
        let max_jitter = capped_ms / 4;
        let jitter = if max_jitter == 0 {
            0
        } else {
            u64::from(jitter_nanos) % max_jitter
        };
        Duration::from_millis(capped_ms.saturating_add(jitter))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_grows_exponentially_until_max() {
        let policy = RetryPolicy {
            max_attempts: 5,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(2),
        };

        // No jitter for deterministic asserts.
        let d0 = policy.delay(0, 0);
        let d1 = policy.delay(1, 0);
        let d2 = policy.delay(2, 0);
        let d3 = policy.delay(3, 0);
        let d4 = policy.delay(4, 0);
        let d_huge = policy.delay(50, 0);

        assert_eq!(d0, Duration::from_millis(100));
        assert_eq!(d1, Duration::from_millis(200));
        assert_eq!(d2, Duration::from_millis(400));
        assert_eq!(d3, Duration::from_millis(800));
        // 1600 < 2000 cap
        assert_eq!(d4, Duration::from_millis(1600));
        // saturates at max_delay
        assert_eq!(d_huge, Duration::from_secs(2));
    }

    #[test]
    fn jitter_stays_within_quarter_of_capped_delay() {
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(400),
            max_delay: Duration::from_secs(10),
        };
        // capped = 400ms, max jitter = 100ms.
        for jitter in [0u32, 1, 99, u32::MAX] {
            let d = policy.delay(0, jitter);
            assert!(d >= Duration::from_millis(400), "no negative jitter");
            assert!(
                d < Duration::from_millis(500),
                "jitter must stay below 25%: got {d:?}",
            );
        }
    }
}
