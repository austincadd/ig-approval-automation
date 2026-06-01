import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dbPath = path.join(root, 'data', 'ig_automation.db');
const schemaPath = path.join(root, 'db', 'schema.sql');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
const sql = fs.readFileSync(schemaPath, 'utf8');
db.exec(sql);

function ensureColumn(tableName, columnName, definitionSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
}

ensureColumn('like_jobs', 'failure_class', 'TEXT');
ensureColumn('like_jobs', 'failure_policy', 'TEXT');
ensureColumn('like_jobs', 'evidence_bundle_path', 'TEXT');

if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='self_test_results'`).get()) {
  db.exec(`
    CREATE TABLE self_test_results (
      test_key TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('ok','degraded','error','skipped')),
      summary TEXT,
      details_json TEXT,
      checked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

ensureColumn('account_session_state', 'last_login_confirmed_at', 'TEXT');
ensureColumn('account_session_state', 'last_challenge_at', 'TEXT');
ensureColumn('account_session_state', 'last_successful_action_at', 'TEXT');
ensureColumn('account_session_state', 'quarantine_state', "TEXT NOT NULL DEFAULT 'clear'");
ensureColumn('account_session_state', 'quarantine_reason', 'TEXT');
ensureColumn('account_session_state', 'trust_state', "TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn('account_session_state', 'trust_reason', 'TEXT');
ensureColumn('account_session_state', 'challenge_acknowledged_at', 'TEXT');
ensureColumn('account_session_state', 'recovery_acknowledged_at', 'TEXT');
ensureColumn('account_session_state', 'revalidated_at', 'TEXT');
ensureColumn('account_session_state', 'last_observed_at', 'TEXT');
ensureColumn('account_session_state', 'metadata_json', 'TEXT');
db.prepare(`
  INSERT INTO account_session_state(account_key, session_health, quarantine_state, created_at, updated_at)
  VALUES ('primary', 'unknown', 'clear', datetime('now'), datetime('now'))
  ON CONFLICT(account_key) DO NOTHING
`).run();

if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='active_incidents'`).get()) {
  db.exec(`
    CREATE TABLE active_incidents (
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
    )
  `);
}
ensureColumn('active_incidents', 'details_json', 'TEXT');
ensureColumn('active_incidents', 'source_event_id', 'INTEGER');
ensureColumn('active_incidents', 'auto_recovery_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('active_incidents', 'last_recovery_attempt_at', 'TEXT');
ensureColumn('active_incidents', 'resolved_at', 'TEXT');
ensureColumn('active_incidents', 'updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
db.exec(`CREATE INDEX IF NOT EXISTS idx_active_incidents_status_severity ON active_incidents(status, severity, last_seen_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_active_incidents_kind_status ON active_incidents(kind, status, last_seen_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_active_incidents_dedupe ON active_incidents(dedupe_key, status, last_seen_at DESC)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_active_incidents_dedupe_active_unique ON active_incidents(dedupe_key) WHERE status IN ('open','monitoring')`);

if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='incident_notifications'`).get()) {
  db.exec(`
    CREATE TABLE incident_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_key TEXT NOT NULL,
      transition_type TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      payload_json TEXT,
      UNIQUE(incident_key, transition_type)
    )
  `);
}
ensureColumn('incident_notifications', 'payload_json', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_incident_notifications_incident_sent_at ON incident_notifications(incident_key, sent_at DESC)`);

if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='executor_owners'`).get()) {
  db.exec(`
    CREATE TABLE executor_owners (
      owner_key TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      pid INTEGER,
      profile_dir TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','released','stale','reclaimed','blocked')) DEFAULT 'active',
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      released_at TEXT,
      reclaimed_at TEXT,
      details_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
ensureColumn('executor_owners', 'pid', 'INTEGER');
ensureColumn('executor_owners', 'profile_dir', "TEXT NOT NULL DEFAULT '.browser-profile'");
ensureColumn('executor_owners', 'state', "TEXT NOT NULL DEFAULT 'active'");
ensureColumn('executor_owners', 'started_at', 'TEXT');
ensureColumn('executor_owners', 'heartbeat_at', 'TEXT');
ensureColumn('executor_owners', 'released_at', 'TEXT');
ensureColumn('executor_owners', 'reclaimed_at', 'TEXT');
ensureColumn('executor_owners', 'details_json', 'TEXT');
ensureColumn('executor_owners', 'updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
db.exec(`CREATE INDEX IF NOT EXISTS idx_executor_owners_state_heartbeat ON executor_owners(state, heartbeat_at DESC)`);

const dedupeApprovalsTx = db.transaction(() => {
  const duplicates = db.prepare(`
    SELECT candidate_id, COUNT(*) AS count
    FROM approvals
    GROUP BY candidate_id
    HAVING COUNT(*) > 1
  `).all();

  const selectRows = db.prepare(`
    SELECT id, candidate_id, decision, decided_by, decided_at
    FROM approvals
    WHERE candidate_id = ?
    ORDER BY datetime(decided_at) ASC, id ASC
  `);
  const deleteRow = db.prepare(`DELETE FROM approvals WHERE id = ?`);

  for (const duplicate of duplicates) {
    const rows = selectRows.all(duplicate.candidate_id);
    const keeper = rows[0];
    const conflicting = rows.filter((row) => row.decision !== keeper.decision);
    if (conflicting.length) {
      console.warn(`Approval dedupe conflict for candidate ${duplicate.candidate_id}: keeping earliest ${keeper.id}:${keeper.decision}, dropping ${conflicting.map((row) => `${row.id}:${row.decision}`).join(', ')}`);
    }
    for (const row of rows.slice(1)) deleteRow.run(row.id);
  }
});

dedupeApprovalsTx();
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_candidate_unique ON approvals(candidate_id)`);

const legacyStatePath = path.join(root, 'data', 'candidate-review-state.json');
if (fs.existsSync(legacyStatePath)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8'));
    const labels = legacy?.labels && typeof legacy.labels === 'object' ? legacy.labels : {};
    const index = Number.isFinite(Number(legacy?.index)) ? Math.max(0, Math.trunc(Number(legacy.index))) : 0;

    const upsertLabel = db.prepare(`
      INSERT INTO candidate_review_labels(candidate_key, label, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(candidate_key) DO UPDATE SET
        label=excluded.label,
        updated_at=datetime('now')
    `);
    const setIndex = db.prepare(`
      INSERT INTO system_flags(key, value, updated_at)
      VALUES ('CANDIDATE_REVIEW_INDEX', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=datetime('now')
    `);

    for (const [candidateKey, label] of Object.entries(labels)) {
      if (['good', 'bad', 'skip'].includes(label)) upsertLabel.run(candidateKey, label);
    }
    setIndex.run(String(index));
  } catch (err) {
    console.warn(`Legacy candidate-review-state import skipped: ${err?.message || err}`);
  }
}

console.log(`Migrated database: ${dbPath}`);
