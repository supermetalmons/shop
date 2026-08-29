DROP INDEX anonymous_auth_sessions_expires_at_ms;

CREATE INDEX anonymous_auth_sessions_expires_at_ms
ON anonymous_auth_sessions (expires_at_ms, session_id);

DROP INDEX staff_auth_sessions_expires_at_ms;

CREATE INDEX staff_auth_sessions_expires_at_ms
ON staff_auth_sessions (expires_at_ms, session_id);

DROP INDEX staff_auth_challenges_expires_at_ms;

CREATE INDEX staff_auth_challenges_expires_at_ms
ON staff_auth_challenges (expires_at_ms, challenge_id);

DROP INDEX rate_limit_buckets_expires_at_ms;

CREATE INDEX rate_limit_buckets_expires_at_ms
ON rate_limit_buckets (expires_at_ms, scope, subject_hash);

PRAGMA optimize;
