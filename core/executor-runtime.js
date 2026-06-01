export function recoverInterruptedRunningJobs(db, input = {}) {
  const reason = input.reason || 'executor_interrupted';
  const actor = input.actor || 'executor-runtime';
  const rows = db.prepare(`
    SELECT id, candidate_id
    FROM like_jobs
    WHERE status = 'running'
    ORDER BY id ASC
  `).all();

  if (!rows.length) {
    return { recovered: 0, jobs: [] };
  }

  const tx = db.transaction(() => {
    for (const row of rows) {
      db.prepare(`
        UPDATE like_jobs
        SET status='stopped',
            error_code='EXECUTOR_INTERRUPTED',
            error_message=?,
            finished_at=datetime('now'),
            updated_at=datetime('now')
        WHERE id=? AND status='running'
      `).run(`Recovered after ${reason}`, row.id);

      db.prepare(`
        INSERT INTO run_events(job_id, level, event_type, payload_json)
        VALUES (?, 'warn', 'job_interrupted_recovered', json(?))
      `).run(row.id, JSON.stringify({ actor, reason, candidateId: row.candidate_id }));
    }
  });
  tx();
  return { recovered: rows.length, jobs: rows.map((r) => ({ jobId: r.id, candidateId: r.candidate_id })) };
}
