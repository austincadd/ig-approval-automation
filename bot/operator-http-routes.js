import { getOperatorAutomationStatus } from '../core/automation-status.js';
import { getReliabilityMetrics } from '../core/metrics.js';
import { renderOperatorDashboard } from '../core/operator-dashboard.js';
import { listActiveIncidents, getIncidentSummary, suppressIncident, resolveIncident } from '../core/incidents.js';
import { evaluateAutoRemediation } from '../core/auto-remediation.js';
import { pauseAutomation, reconcileApprovedQueue, requeueBlockedJobs, resumeAutomation, suppressRecoveryCandidate } from '../core/recovery.js';
import { runSelfTests } from '../core/self-tests.js';

function readActionInput(req) {
  return {
    action: req.body?.action,
    reason: req.body?.reason,
    candidateId: req.body?.candidateId
  };
}

function prefersHtml(req) {
  const accept = String(req.get?.('accept') || '');
  return accept.includes('text/html');
}

function redirectDashboard(res, query = '') {
  const suffix = query ? `?${query}` : '';
  return res.redirect(303, `/automation/dashboard${suffix}`);
}

function runOperatorAction(db, input = {}) {
  const action = String(input.action || '').trim();
  const reason = String(input.reason || '').trim() || null;

  switch (action) {
    case 'pause':
      return pauseAutomation(db, { actor: 'http:dashboard', reason });
    case 'resume':
      return resumeAutomation(db, { actor: 'http:dashboard', reason });
    case 'requeue_blocked':
      return requeueBlockedJobs(db, { actor: 'http:dashboard', reason });
    case 'reconcile_approved':
      return reconcileApprovedQueue(db, { actor: 'http:dashboard', reason });
    case 'suppress_candidate':
      return suppressRecoveryCandidate(db, {
        actor: 'http:dashboard',
        reason,
        candidateId: Number(input.candidateId)
      });
    default:
      throw new Error(`Unsupported operator action: ${action}`);
  }
}

export function registerOperatorHttpRoutes({
  app,
  db,
  isAuthorizedControlRequest,
  rejectUnauthorizedControlRequest,
  sendReviewBatch,
  remediationContext = {}
}) {
  app.post('/review/push', async (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    const result = await sendReviewBatch();
    res.json({ ok: true, ...result });
  });

  app.get('/automation/status', (_req, res) => {
    const status = getOperatorAutomationStatus(db);
    res.json({ ok: true, status });
  });

  app.get('/automation/incidents', (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    res.json({
      ok: true,
      summary: getIncidentSummary(db),
      incidents: listActiveIncidents(db)
    });
  });

  app.get('/automation/dashboard', (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    const status = getOperatorAutomationStatus(db);
    res.type('html').send(renderOperatorDashboard(status));
  });

  app.post('/automation/action', (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    try {
      const result = runOperatorAction(db, readActionInput(req));
      if (prefersHtml(req)) return redirectDashboard(res, `action=${encodeURIComponent(readActionInput(req).action || 'unknown')}&ok=1`);
      res.json({ ok: true, result, status: getOperatorAutomationStatus(db) });
    } catch (error) {
      if (prefersHtml(req)) return redirectDashboard(res, `action_error=${encodeURIComponent(error?.message || String(error))}`);
      res.status(400).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.get('/automation/self-tests', (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    const status = getOperatorAutomationStatus(db);
    res.json({ ok: true, selfTests: status.selfTests, policyVersions: status.policyVersions });
  });

  app.post('/automation/self-tests/run', async (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    try {
      const result = await runSelfTests(db, {});
      if (prefersHtml(req)) return redirectDashboard(res, 'self_tests=ran');
      res.json({ ok: true, result, status: getOperatorAutomationStatus(db) });
    } catch (error) {
      if (prefersHtml(req)) return redirectDashboard(res, `self_tests_error=${encodeURIComponent(error?.message || String(error))}`);
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });


  app.post('/automation/remediation/run', async (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    try {
      const result = await evaluateAutoRemediation(db, remediationContext);
      res.json({ ok: true, result, status: getOperatorAutomationStatus(db) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/automation/incidents/:incidentKey/suppress', (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    const incident = suppressIncident(db, { incidentKey: req.params?.incidentKey });
    if (!incident) return res.status(404).json({ ok: false, error: 'incident_not_found' });
    res.json({ ok: true, incident, summary: getIncidentSummary(db), incidents: listActiveIncidents(db) });
  });

  app.post('/automation/incidents/:incidentKey/resolve', (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);
    const incident = resolveIncident(db, { incidentKey: req.params?.incidentKey });
    if (!incident) return res.status(404).json({ ok: false, error: 'incident_not_found' });
    res.json({ ok: true, incident, summary: getIncidentSummary(db), incidents: listActiveIncidents(db) });
  });

  app.get('/automation/metrics', (req, res) => {
    const days = Math.max(1, Math.trunc(Number(req.query?.days) || 7));
    res.json({ ok: true, metrics: getReliabilityMetrics(db, { days }) });
  });

  app.get('/debug/queue', (_req, res) => {
    const queued = db.prepare(`
      SELECT lj.id, lj.candidate_id, lj.status, c.post_url, lj.created_at
      FROM like_jobs lj
      JOIN candidates c ON c.id = lj.candidate_id
      WHERE lj.status = 'queued'
      ORDER BY lj.id DESC
      LIMIT 25
    `).all();

    const recentApprovals = db.prepare(`
      SELECT a.id, a.candidate_id, a.decision, a.decided_by, a.decided_at
      FROM approvals a
      ORDER BY a.id DESC
      LIMIT 25
    `).all();

    res.json({ ok: true, queued, recentApprovals });
  });
}
