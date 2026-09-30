type OpsExpiryCleanupStatement = {
  tableName: string;
  indexName: string;
  limit: number;
  sql: string;
};

export const OPS_EXPIRY_CLEANUP_STATEMENTS = {
  miNoteAuthSessions: {
    tableName: 'mi_note_auth_sessions',
    indexName: 'mi_note_auth_sessions_expires_at_ms',
    limit: 500,
    sql: `DELETE FROM mi_note_auth_sessions
      WHERE session_id IN (
        SELECT session_id FROM mi_note_auth_sessions
        WHERE expires_at_ms <= ? ORDER BY expires_at_ms, session_id LIMIT ?
      )`,
  },
  miNoteAuthChallenges: {
    tableName: 'mi_note_auth_challenges',
    indexName: 'mi_note_auth_challenges_expires_at_ms',
    limit: 500,
    sql: `DELETE FROM mi_note_auth_challenges
      WHERE challenge_id IN (
        SELECT challenge_id FROM mi_note_auth_challenges
        WHERE expires_at_ms <= ? ORDER BY expires_at_ms, challenge_id LIMIT ?
      )`,
  },
  anonymousAuthSessions: {
    tableName: 'anonymous_auth_sessions',
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
    tableName: 'staff_auth_sessions',
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
    tableName: 'staff_auth_challenges',
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
    tableName: 'rate_limit_buckets',
    indexName: 'rate_limit_buckets_expires_at_ms',
    limit: 1_000,
    sql: `DELETE FROM rate_limit_buckets
      WHERE (scope, subject_hash) IN (
        SELECT scope, subject_hash
        FROM rate_limit_buckets
        WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms, scope, subject_hash
        LIMIT ?
      )`,
  },
} as const satisfies Record<string, OpsExpiryCleanupStatement>;

export type OpsExpiryCleanupKey = keyof typeof OPS_EXPIRY_CLEANUP_STATEMENTS;
