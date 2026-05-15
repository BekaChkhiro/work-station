//! Bounded ring-buffer scrollback for a PTY session (T2.9).
//!
//! The same `Bytes` frames the reader (T2.4) broadcasts to live
//! subscribers also land here, capped by total byte size. When the cap
//! is exceeded, the oldest frames are evicted whole — frame boundaries
//! are preserved so T2.10's `pty_get_scrollback` can walk frames
//! front-to-back without splitting a UTF-8 codepoint inside a frame.
//!
//! Eviction is per-frame, so memory tracks `cap_bytes` ± one frame
//! (~4KB at the reader's default flush size). With a 4MB default cap
//! that's a ~0.1% overshoot — fine for personal-use scope.

// Several inspectors (`cap_bytes`, `frame_count`, `is_empty`,
// `with_capacity`) are only exercised from tests today; future tasks
// (T3.4 user-configurable cap, telemetry) will pull them into prod
// paths. Allowing dead_code here keeps the read API discoverable
// without per-fn churn each phase.
#![allow(dead_code)]

use std::collections::VecDeque;

use bytes::Bytes;

/// Default per-session scrollback cap — 4 MiB, per `PROJECT_PLAN` T2.9.
pub const DEFAULT_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;

/// Bounded byte ring whose elements are reader-coalesced frames.
///
/// Storing whole `Bytes` frames keeps push cheap (refcounted clone, no
/// copy) and lets the future range-read walk frames directly. The
/// total-byte counter is kept in lockstep with the deque so `push`
/// never has to re-sum the queue to decide when to evict.
pub struct Scrollback {
    chunks: VecDeque<Bytes>,
    total_bytes: usize,
    cap_bytes: usize,
    /// T2.16 — running tally of how many frames were dropped to honour
    /// the cap. Surfaced through the backpressure stats command so the
    /// debug panel can show "X frames evicted under load."
    evicted_frames: u64,
    evicted_bytes: u64,
}

impl Scrollback {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_SCROLLBACK_BYTES)
    }

    pub fn with_capacity(cap_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_bytes: 0,
            cap_bytes,
            evicted_frames: 0,
            evicted_bytes: 0,
        }
    }

    /// Append a frame, evicting oldest frames until total ≤ cap.
    ///
    /// Empty frames are no-ops — keeps the EOF-tail flush from
    /// pushing a phantom zero-length entry when the buf is already
    /// drained.
    pub fn push(&mut self, frame: Bytes) {
        if frame.is_empty() {
            return;
        }
        self.total_bytes += frame.len();
        self.chunks.push_back(frame);
        while self.total_bytes > self.cap_bytes {
            // The accounting invariant guarantees a chunk to pop
            // whenever total_bytes > 0; the `else break` is a
            // belt-and-braces guard against a future bug from
            // drifting accounting.
            let Some(oldest) = self.chunks.pop_front() else {
                break;
            };
            self.total_bytes -= oldest.len();
            self.evicted_frames += 1;
            self.evicted_bytes += oldest.len() as u64;
        }
    }

    /// Number of frames dropped to keep `total_bytes` ≤ `cap_bytes`. Counts
    /// over the lifetime of this `Scrollback`; never resets.
    pub fn evicted_frames(&self) -> u64 {
        self.evicted_frames
    }

    /// Total bytes dropped via eviction. See `evicted_frames`.
    pub fn evicted_bytes(&self) -> u64 {
        self.evicted_bytes
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn cap_bytes(&self) -> usize {
        self.cap_bytes
    }

    pub fn frame_count(&self) -> usize {
        self.chunks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    /// Iterate frames oldest → newest. Cheap — `Bytes` is refcounted.
    pub fn iter(&self) -> impl Iterator<Item = &Bytes> {
        self.chunks.iter()
    }

    /// Copy the byte range `[offset, offset + limit)` into a fresh `Vec`.
    ///
    /// Offsets are into the *current* ring snapshot (oldest retained
    /// byte = 0). Out-of-range offsets and zero limits return an empty
    /// vec; the upper bound clamps to `total_bytes`, so callers can
    /// pass a generous `limit` (e.g. `usize::MAX`) to mean "until end".
    pub fn slice(&self, offset: usize, limit: usize) -> Vec<u8> {
        if limit == 0 || offset >= self.total_bytes {
            return Vec::new();
        }
        let end = offset.saturating_add(limit).min(self.total_bytes);
        let mut out = Vec::with_capacity(end - offset);
        let mut cursor: usize = 0;
        for frame in &self.chunks {
            let frame_start = cursor;
            let frame_end = frame_start + frame.len();
            cursor = frame_end;

            if frame_end <= offset {
                continue;
            }
            if frame_start >= end {
                break;
            }
            let lo = offset.saturating_sub(frame_start);
            let hi = (end - frame_start).min(frame.len());
            out.extend_from_slice(&frame[lo..hi]);
        }
        out
    }
}

impl Default for Scrollback {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(bytes: &[u8]) -> Bytes {
        Bytes::copy_from_slice(bytes)
    }

    #[test]
    fn push_within_cap_keeps_all_frames() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"abc"));
        sb.push(frame(b"defg"));
        assert_eq!(sb.frame_count(), 2);
        assert_eq!(sb.total_bytes(), 7);
        let collected: Vec<&[u8]> = sb.iter().map(AsRef::as_ref).collect();
        assert_eq!(collected, vec![b"abc".as_ref(), b"defg".as_ref()]);
    }

    #[test]
    fn empty_frame_is_noop() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(Bytes::new());
        assert_eq!(sb.frame_count(), 0);
        assert_eq!(sb.total_bytes(), 0);
        assert!(sb.is_empty());
    }

    #[test]
    fn push_over_cap_evicts_oldest_first() {
        let mut sb = Scrollback::with_capacity(10);
        sb.push(frame(b"AAAA")); // 4
        sb.push(frame(b"BBBB")); // 8
        sb.push(frame(b"CCCC")); // 12 → evict A
        assert_eq!(sb.total_bytes(), 8);
        let order: Vec<&[u8]> = sb.iter().map(AsRef::as_ref).collect();
        assert_eq!(order, vec![b"BBBB".as_ref(), b"CCCC".as_ref()]);
    }

    #[test]
    fn push_evicts_until_under_cap() {
        // One large frame should evict every smaller frame ahead of it.
        let mut sb = Scrollback::with_capacity(8);
        sb.push(frame(b"AA"));
        sb.push(frame(b"BB"));
        sb.push(frame(b"CC"));
        sb.push(frame(b"DD"));
        assert_eq!(sb.total_bytes(), 8);
        sb.push(frame(b"ZZZZZZZZ")); // 8 — must evict all four prior
        assert_eq!(sb.frame_count(), 1);
        assert_eq!(sb.total_bytes(), 8);
        let only: Vec<&[u8]> = sb.iter().map(AsRef::as_ref).collect();
        assert_eq!(only, vec![b"ZZZZZZZZ".as_ref()]);
    }

    #[test]
    fn single_oversized_frame_evicts_itself() {
        // A frame larger than the cap should leave the buffer empty —
        // consistent with "drop oldest until under cap" when the
        // oversized frame happens to also be the oldest.
        let mut sb = Scrollback::with_capacity(4);
        sb.push(frame(b"123456789"));
        assert!(sb.is_empty());
        assert_eq!(sb.total_bytes(), 0);
    }

    #[test]
    fn zero_cap_drops_every_frame() {
        let mut sb = Scrollback::with_capacity(0);
        sb.push(frame(b"x"));
        sb.push(frame(b"y"));
        assert!(sb.is_empty());
        assert_eq!(sb.total_bytes(), 0);
    }

    #[test]
    fn many_pushes_stay_bounded_by_cap() {
        // Fuzz-style: push 10K random-ish frames at a 64KB cap and
        // confirm total_bytes never exceeds cap after each push.
        let mut sb = Scrollback::with_capacity(64 * 1024);
        for i in 0..10_000u32 {
            let len = (i % 257) as usize + 1; // 1..=257
            let buf = vec![(i & 0xff) as u8; len];
            sb.push(Bytes::from(buf));
            assert!(
                sb.total_bytes() <= sb.cap_bytes(),
                "iter {i}: total {} > cap {}",
                sb.total_bytes(),
                sb.cap_bytes(),
            );
        }
    }

    #[test]
    fn default_uses_4mib_cap() {
        let sb = Scrollback::new();
        assert_eq!(sb.cap_bytes(), 4 * 1024 * 1024);
    }

    #[test]
    fn slice_empty_is_empty() {
        let sb = Scrollback::with_capacity(1024);
        assert!(sb.slice(0, 16).is_empty());
        assert!(sb.slice(0, 0).is_empty());
        assert!(sb.slice(99, 16).is_empty());
    }

    #[test]
    fn slice_zero_limit_is_empty() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"hello"));
        assert!(sb.slice(0, 0).is_empty());
        assert!(sb.slice(2, 0).is_empty());
    }

    #[test]
    fn slice_full_range_returns_concatenated_bytes() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"abc"));
        sb.push(frame(b"defg"));
        sb.push(frame(b"hi"));
        assert_eq!(sb.slice(0, usize::MAX), b"abcdefghi".to_vec());
    }

    #[test]
    fn slice_inside_single_frame() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"abcdefghij"));
        assert_eq!(sb.slice(2, 4), b"cdef".to_vec());
    }

    #[test]
    fn slice_spans_frame_boundaries() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"abc")); //   0..3
        sb.push(frame(b"defg")); //  3..7
        sb.push(frame(b"hi")); //    7..9
                               // 1..8 → "bcdefgh"
        assert_eq!(sb.slice(1, 7), b"bcdefgh".to_vec());
    }

    #[test]
    fn slice_clamps_when_limit_exceeds_total() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"abc"));
        sb.push(frame(b"defg"));
        // total = 7; ask for 50 — get the remaining 5 from offset 2.
        assert_eq!(sb.slice(2, 50), b"cdefg".to_vec());
    }

    #[test]
    fn slice_offset_at_total_returns_empty() {
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"abc"));
        assert!(sb.slice(3, 10).is_empty());
        assert!(sb.slice(99, 10).is_empty());
    }

    #[test]
    fn slice_pagination_round_trip_matches_full() {
        // Walk the buffer in 5-byte windows and confirm the
        // concatenation equals slice(0, total).
        let mut sb = Scrollback::with_capacity(1024);
        sb.push(frame(b"alpha"));
        sb.push(frame(b"beta"));
        sb.push(frame(b"gamma"));
        sb.push(frame(b"delta"));
        let total = sb.total_bytes();

        let full = sb.slice(0, total);
        let mut pieced = Vec::with_capacity(total);
        let mut offset = 0;
        while offset < total {
            let chunk = sb.slice(offset, 5);
            assert!(!chunk.is_empty(), "non-empty buffer must yield bytes");
            pieced.extend_from_slice(&chunk);
            offset += chunk.len();
        }
        assert_eq!(pieced, full);
    }

    #[test]
    fn slice_after_eviction_reads_retained_tail() {
        let mut sb = Scrollback::with_capacity(6);
        sb.push(frame(b"AAA")); // 3 bytes
        sb.push(frame(b"BBB")); // 6 bytes — at cap
        sb.push(frame(b"CCC")); // 9 → evict A, total = 6
        assert_eq!(sb.total_bytes(), 6);
        assert_eq!(sb.slice(0, usize::MAX), b"BBBCCC".to_vec());
    }

    /// T2.16: eviction counters must track every dropped frame so the
    /// debug panel can show "X frames evicted under load."
    #[test]
    fn eviction_counters_track_dropped_frames_and_bytes() {
        let mut sb = Scrollback::with_capacity(6);
        assert_eq!(sb.evicted_frames(), 0);
        assert_eq!(sb.evicted_bytes(), 0);

        sb.push(frame(b"AAA")); // total 3, no eviction
        sb.push(frame(b"BBB")); // total 6, no eviction
        assert_eq!(sb.evicted_frames(), 0);
        assert_eq!(sb.evicted_bytes(), 0);

        sb.push(frame(b"CCC")); // total 9 → evict AAA → total 6
        assert_eq!(sb.evicted_frames(), 1);
        assert_eq!(sb.evicted_bytes(), 3);

        // One large push evicts every prior frame.
        sb.push(frame(b"ZZZZZZ")); // 6 bytes — must evict BBB and CCC
        assert_eq!(sb.evicted_frames(), 3, "AAA + BBB + CCC must be counted");
        assert_eq!(sb.evicted_bytes(), 9);
    }

    /// T2.16: when a single frame is itself larger than cap, it evicts
    /// itself — and that self-eviction must show up in the counters so
    /// the UI can surface "frame too big" rather than silently lose it.
    #[test]
    fn eviction_counters_include_oversized_self_eviction() {
        let mut sb = Scrollback::with_capacity(4);
        sb.push(frame(b"123456789")); // 9 bytes, cap 4 → frame evicts itself
        assert!(sb.is_empty());
        assert_eq!(sb.evicted_frames(), 1);
        assert_eq!(sb.evicted_bytes(), 9);
    }

    /// T2.16: pushes that fit must not bump eviction counters even if
    /// `total_bytes` hits the cap exactly.
    #[test]
    fn eviction_counters_stable_at_cap() {
        let mut sb = Scrollback::with_capacity(8);
        sb.push(frame(b"AAAA"));
        sb.push(frame(b"BBBB"));
        assert_eq!(sb.total_bytes(), 8);
        assert_eq!(sb.evicted_frames(), 0);
        assert_eq!(sb.evicted_bytes(), 0);
    }
}
