export function logEvent(db, { jobId = null, level = 'info', eventType, payload = {} }) {
  db.prepare(`
    INSERT INTO run_events(job_id, level, event_type, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(jobId, level, eventType, JSON.stringify(payload));
}
