-- T11.9: persistent FIFO queue for integration writes that landed while
-- the user was offline (or while the integration was network-degraded).
-- The TypeScript httpClient enqueues here when navigator.onLine is false
-- or when a request raised IntegrationNetworkError/Timeout. A reconnect
-- worker drains in enqueued_at order, calling the original endpoint.
--
-- Hard cap: 50 rows. The enqueue command auto-evicts the oldest row
-- when count exceeds the cap and returns evicted=true so the UI can
-- surface a toast. We pick 50 because v0.2 ships read-heavy integration
-- tabs (T13–T17) — write bursts above 50 in a single offline window
-- would almost always indicate a stuck loop, not legitimate user intent.
--
-- Body is BLOB so we don't have to base64-encode in the DB layer; the
-- Tauri command boundary takes base64 strings (JSON can't hold raw
-- bytes) and converts.
CREATE TABLE integration_write_queue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    service          TEXT    NOT NULL,
    method           TEXT    NOT NULL,
    url              TEXT    NOT NULL,
    headers_json     TEXT    NOT NULL DEFAULT '{}',
    body             BLOB,
    enqueued_at      INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    last_attempt_at  INTEGER
);

CREATE INDEX idx_integration_write_queue_enqueued_at
    ON integration_write_queue (enqueued_at);
CREATE INDEX idx_integration_write_queue_service
    ON integration_write_queue (service);
