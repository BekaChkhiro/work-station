//! Persistent scrollback buffer for PTY sessions.
//!
//! Stores output chunks in a ring-buffer capped at a configurable byte limit.
//! When the limit is exceeded, oldest chunks are evicted from the front.

use bytes::Bytes;
use std::collections::VecDeque;

/// Default maximum scrollback size in bytes (1 MiB).
pub const DEFAULT_MAX_SCROLLBACK_BYTES: usize = 1024 * 1024;

/// A ring-buffer of PTY output chunks with a byte-size cap.
///
/// Chunks are stored as [`Bytes`] to allow cheap cloning when serving
/// historical data to multiple consumers.
#[derive(Debug, Clone)]
pub struct ScrollbackBuffer {
    buffer: VecDeque<Bytes>,
    max_bytes: usize,
    current_bytes: usize,
}

impl ScrollbackBuffer {
    /// Create a new empty buffer with the given byte limit.
    pub fn new(max_bytes: usize) -> Self {
        Self {
            buffer: VecDeque::new(),
            max_bytes,
            current_bytes: 0,
        }
    }

    /// Append a chunk of output to the buffer.
    ///
    /// If the new chunk pushes the total over `max_bytes`, oldest chunks are
    /// dropped from the front until the total is within the limit.
    pub fn push(&mut self, data: Bytes) {
        if data.is_empty() {
            return;
        }
        self.current_bytes += data.len();
        self.buffer.push_back(data);
        self.evict_if_needed();
    }

    /// Total bytes currently stored.
    pub fn total_bytes(&self) -> usize {
        self.current_bytes
    }

    /// Maximum byte limit for this buffer.
    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    /// Number of chunks stored.
    pub fn len_chunks(&self) -> usize {
        self.buffer.len()
    }

    /// Whether the buffer contains no data.
    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Retrieve chunks overlapping the byte range `[offset, offset + limit)`.
    ///
    /// Returns sliced [`Bytes`] so callers get exactly the bytes they asked
    /// for without copying the underlying data.
    ///
    /// # Arguments
    /// * `offset` – byte offset from the start of the buffer
    /// * `limit`  – maximum number of bytes to return
    pub fn get_range(&self, offset: usize, limit: usize) -> Vec<Bytes> {
        let mut result = Vec::new();
        let mut current_offset = 0usize;
        let end = offset.saturating_add(limit);

        for chunk in &self.buffer {
            let chunk_len = chunk.len();
            let chunk_start = current_offset;
            let chunk_end = current_offset + chunk_len;

            // Check overlap with requested range.
            if chunk_end > offset && chunk_start < end {
                let start_in_chunk = offset.saturating_sub(chunk_start);
                let end_in_chunk = (chunk_len).min(end.saturating_sub(chunk_start));

                if start_in_chunk < end_in_chunk {
                    result.push(chunk.slice(start_in_chunk..end_in_chunk));
                }
            }

            current_offset += chunk_len;

            // Early exit if we've passed the requested range.
            if current_offset >= end {
                break;
            }
        }

        result
    }

    /// Evict oldest chunks until the total byte count is within the limit.
    ///
    /// Always keeps at least the newest chunk, even if it alone exceeds
    /// `max_bytes`. This prevents a single oversized chunk from causing
    /// total data loss.
    fn evict_if_needed(&mut self) {
        while self.current_bytes > self.max_bytes && self.buffer.len() > 1 {
            if let Some(front) = self.buffer.pop_front() {
                self.current_bytes -= front.len();
            }
        }
    }
}

impl Default for ScrollbackBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_SCROLLBACK_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_and_total_bytes() {
        let mut buf = ScrollbackBuffer::new(100);
        buf.push(Bytes::from_static(b"hello"));
        buf.push(Bytes::from_static(b"world"));
        assert_eq!(buf.total_bytes(), 10);
        assert_eq!(buf.len_chunks(), 2);
    }

    #[test]
    fn test_eviction_oldest_first() {
        let mut buf = ScrollbackBuffer::new(10);
        buf.push(Bytes::from_static(b"12345"));
        buf.push(Bytes::from_static(b"67890"));
        assert_eq!(buf.total_bytes(), 10);

        // This should evict the first chunk.
        buf.push(Bytes::from_static(b"ABCDE"));
        assert_eq!(buf.total_bytes(), 10);
        assert_eq!(buf.len_chunks(), 2);

        let range = buf.get_range(0, 10);
        let combined: Vec<u8> = range.iter().flat_map(|b| b.iter().copied()).collect();
        assert_eq!(&combined, b"67890ABCDE");
    }

    #[test]
    fn test_get_range_basic() {
        let mut buf = ScrollbackBuffer::new(100);
        buf.push(Bytes::from_static(b"hello"));
        buf.push(Bytes::from_static(b"world"));

        let range = buf.get_range(0, 8);
        let combined: Vec<u8> = range.iter().flat_map(|b| b.iter().copied()).collect();
        assert_eq!(&combined, b"hellowor");
    }

    #[test]
    fn test_get_range_across_chunks() {
        let mut buf = ScrollbackBuffer::new(100);
        buf.push(Bytes::from_static(b"abc"));
        buf.push(Bytes::from_static(b"def"));
        buf.push(Bytes::from_static(b"ghi"));

        let range = buf.get_range(2, 5);
        let combined: Vec<u8> = range.iter().flat_map(|b| b.iter().copied()).collect();
        assert_eq!(&combined, b"cdefg");
    }

    #[test]
    fn test_get_range_empty() {
        let buf = ScrollbackBuffer::new(100);
        let range = buf.get_range(0, 10);
        assert!(range.is_empty());
    }

    #[test]
    fn test_get_range_offset_past_end() {
        let mut buf = ScrollbackBuffer::new(100);
        buf.push(Bytes::from_static(b"hello"));
        let range = buf.get_range(100, 10);
        assert!(range.is_empty());
    }

    #[test]
    fn test_default_max_size() {
        let buf = ScrollbackBuffer::default();
        assert_eq!(buf.max_bytes, DEFAULT_MAX_SCROLLBACK_BYTES);
    }

    #[test]
    fn test_eviction_partial_chunk() {
        // When a single chunk is larger than max_bytes, it should still be
        // stored (the buffer always keeps at least the newest chunk).
        let mut buf = ScrollbackBuffer::new(5);
        buf.push(Bytes::from_static(b"this is a long chunk"));
        assert_eq!(buf.total_bytes(), 20);
        assert_eq!(buf.len_chunks(), 1);
    }

    #[test]
    fn test_large_chunk_then_eviction() {
        let mut buf = ScrollbackBuffer::new(5);
        buf.push(Bytes::from_static(b"12345"));
        buf.push(Bytes::from_static(b"67890"));
        assert_eq!(buf.total_bytes(), 5);
        assert_eq!(buf.len_chunks(), 1);
        assert_eq!(buf.get_range(0, 5)[0].as_ref(), b"67890");
    }
}
