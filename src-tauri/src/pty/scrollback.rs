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

#![allow(dead_code)] // T2.10 (pty_get_scrollback) consumes the read API.

use std::collections::VecDeque;

use bytes::Bytes;

/// Default per-session scrollback cap — 4 MiB, per `PROJECT_PLAN` T2.9.
pub(crate) const DEFAULT_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;

/// Bounded byte ring whose elements are reader-coalesced frames.
///
/// Storing whole `Bytes` frames keeps push cheap (refcounted clone, no
/// copy) and lets the future range-read walk frames directly. The
/// total-byte counter is kept in lockstep with the deque so `push`
/// never has to re-sum the queue to decide when to evict.
pub(crate) struct Scrollback {
    chunks: VecDeque<Bytes>,
    total_bytes: usize,
    cap_bytes: usize,
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
        }
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
}
