-- T11.4: Generic HTTP client + cache layer.
-- One row per cached (method, url, auth-fingerprint) tuple. Only successful
-- GETs land here. TTL is enforced via `expires_at` in the read query, not by
-- a background sweeper — `Cache::purge_expired` is a manual hook callers can
-- invoke when they want to compact, and we keep expired rows around in the
-- meantime so a future stale-on-error feature can serve them without a
-- schema change.
CREATE TABLE http_cache (
    key          TEXT    PRIMARY KEY NOT NULL,
    service      TEXT    NOT NULL,
    status       INTEGER NOT NULL,
    headers_json TEXT    NOT NULL,
    body         BLOB    NOT NULL,
    fetched_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
);

CREATE INDEX idx_http_cache_service ON http_cache(service);
CREATE INDEX idx_http_cache_expires ON http_cache(expires_at);
