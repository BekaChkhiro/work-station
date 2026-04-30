//! PTY session registry.
//!
//! Manages the lifecycle of all PTY sessions. The registry lives for the
//! lifetime of the application, independent of any window.

use std::collections::HashMap;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use super::session::PtySession;

/// Central registry for all active PTY sessions.
///
/// Clones of `PtyManager` share the same underlying registry.
#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<Uuid, PtySession>>>,
}

impl PtyManager {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Insert a session into the registry and return its ID.
    pub async fn insert(&self, session: PtySession) -> Uuid {
        let id = session.id;
        self.sessions.lock().await.insert(id, session);
        id
    }

    /// Remove a session from the registry.
    ///
    /// Dropping the returned `PtySession` kills the underlying child process.
    pub async fn remove(&self, id: &Uuid) -> Option<PtySession> {
        self.sessions.lock().await.remove(id)
    }

    /// Check whether a session exists in the registry.
    pub async fn contains(&self, id: &Uuid) -> bool {
        self.sessions.lock().await.contains_key(id)
    }

    /// List IDs of all active sessions.
    pub async fn list(&self) -> Vec<Uuid> {
        self.sessions.lock().await.keys().copied().collect()
    }

    /// Write raw bytes to a session's stdin.
    pub async fn write(&self, id: &Uuid, data: &[u8]) -> Option<std::io::Result<()>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.write(data).await)
    }

    /// Resize a session's PTY.
    pub async fn resize(&self, id: &Uuid, cols: u16, rows: u16) -> Option<anyhow::Result<()>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.resize(cols, rows))
    }

    /// Subscribe to a session's output broadcast channel.
    pub async fn subscribe(&self, id: &Uuid) -> Option<broadcast::Receiver<Bytes>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.subscribe())
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}
