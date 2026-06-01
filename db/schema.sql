PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','skipped')),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_candidate_unique
ON approvals(candidate_id);

CREATE TABLE IF NOT EXISTS recovery_suppressions (
  candidate_id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);

CREATE TABLE IF NOT EXISTS like_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','success','failed','blocked','stopped')) DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  failure_class TEXT,
  failure_policy TEXT,
  evidence_bundle_path TEXT,
  screenshot_path TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_like_jobs_candidate_active_unique
ON like_jobs(candidate_id)
WHERE status IN ('queued','running');


CREATE TABLE IF NOT EXISTS account_session_state (
  account_key TEXT PRIMARY KEY,
  session_health TEXT NOT NULL DEFAULT 'unknown',
  last_login_confirmed_at TEXT,
  last_challenge_at TEXT,
  last_successful_action_at TEXT,
  quarantine_state TEXT NOT NULL DEFAULT 'clear',
  quarantine_reason TEXT,
  trust_state TEXT NOT NULL DEFAULT 'unknown',
  trust_reason TEXT,
  challenge_acknowledged_at TEXT,
  recovery_acknowledged_at TEXT,
  revalidated_at TEXT,
  last_observed_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(job_id) REFERENCES like_jobs(id)
);

CREATE TABLE IF NOT EXISTS candidate_review_labels (
  candidate_key TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK(label IN ('good','bad','skip')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS review_card_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','resolved','superseded')) DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id),
  UNIQUE(chat_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_card_messages_candidate_open_unique
ON review_card_messages(candidate_id)
WHERE status = 'open';

CREATE TABLE IF NOT EXISTS self_test_results (
  test_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('ok','degraded','error','skipped')),
  summary TEXT,
  details_json TEXT,
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS active_incidents (
  incident_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warn','critical')),
  status TEXT NOT NULL CHECK(status IN ('open','monitoring','resolved','suppressed')),
  dedupe_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT,
  source_event_id INTEGER,
  auto_recovery_attempts INTEGER NOT NULL DEFAULT 0,
  last_recovery_attempt_at TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_active_incidents_status_severity
ON active_incidents(status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_incidents_kind_status
ON active_incidents(kind, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_incidents_dedupe
ON active_incidents(dedupe_key, status, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_incidents_dedupe_active_unique
ON active_incidents(dedupe_key)
WHERE status IN ('open','monitoring');

CREATE TABLE IF NOT EXISTS incident_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL,
  transition_type TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT,
  UNIQUE(incident_key, transition_type)
);
CREATE INDEX IF NOT EXISTS idx_incident_notifications_incident_sent_at
ON incident_notifications(incident_key, sent_at DESC);

INSERT OR IGNORE INTO system_flags(key, value) VALUES
('AUTOMATION_ENABLED', 'true'),
('DAILY_LIMIT', '10'),
('HOURLY_LIMIT', '3'),
('CANDIDATE_REVIEW_INDEX', '0');
