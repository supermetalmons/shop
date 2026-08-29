type OpsExpiryCleanupStatement = {
  indexName: string;
  limit: number;
  sql: string;
};

export const OPS_EXPIRY_CLEANUP_STATEMENTS = {
  anonymousAuthSessions: {
    indexName: 'anonymous_auth_sessions_expires_at_ms',
    limit: 500,
    sql: `DELETE FROM anonymous_auth_sessions
      WHERE session_id IN (
        SELECT session_id
        FROM anonymous_auth_sessions
        WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms, session_id
        LIMIT ?
      )`,
  },
  staffAuthSessions: {
    indexName: 'staff_auth_sessions_expires_at_ms',
    limit: 500,
    sql: `DELETE FROM staff_auth_sessions
      WHERE session_id IN (
        SELECT session_id
        FROM staff_auth_sessions
        WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms, session_id
        LIMIT ?
      )`,
  },
  staffAuthChallenges: {
    indexName: 'staff_auth_challenges_expires_at_ms',
    limit: 500,
    sql: `DELETE FROM staff_auth_challenges
      WHERE challenge_id IN (
        SELECT challenge.challenge_id
        FROM staff_auth_challenges AS challenge
        WHERE challenge.expires_at_ms <= ?
        ORDER BY challenge.expires_at_ms, challenge.challenge_id
        LIMIT ?
      )`,
  },
  rateLimitBuckets: {
    indexName: 'rate_limit_buckets_expires_at_ms',
    limit: 1_000,
    sql: `DELETE FROM rate_limit_buckets
      WHERE (scope, subject_hash) IN (
        SELECT scope, subject_hash
        FROM rate_limit_buckets
        WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms, scope, subject_hash
        LIMIT ?
      )
      RETURNING subject_hash`,
  },
} as const satisfies Record<string, OpsExpiryCleanupStatement>;
