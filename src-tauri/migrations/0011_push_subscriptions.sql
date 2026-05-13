-- T18.19: Web Push subscriptions.
--
-- One row per browser/device that registered for push notifications. The
-- endpoint URL (e.g. https://fcm.googleapis.com/...) is the natural key
-- because the push-service provider issues a unique endpoint per
-- subscription and reusing one (re-subscribing the same SW) replaces the
-- prior row via INSERT ... ON CONFLICT DO UPDATE.
--
-- `p256dh` and `auth` are the per-subscription client public key + auth
-- secret (both base64-url-no-pad strings, per RFC 8291). `user_agent` is
-- optional metadata used by the Settings UI to show "your iPhone, your
-- iPad" — never read on the send path. `created_at` is unix seconds.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL
);
