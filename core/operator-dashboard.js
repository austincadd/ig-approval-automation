function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function code(value) {
  return `<code>${escapeHtml(value ?? '—')}</code>`;
}

function badge(value, tone = 'neutral') {
  return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`;
}

function toneForHealth(value) {
  switch (value) {
    case 'healthy':
    case 'ok':
    case 'running':
    case 'ready':
      return 'good';
    case 'paused':
    case 'idle':
    case 'empty':
      return 'neutral';
    case 'degraded':
    case 'stale':
    case 'busy':
    case 'backlog_present':
    case 'quarantined':
    case 'operator_required':
      return 'warn';
    case 'unsafe':
    case 'fatal':
    case 'challenge':
    case 'logged_out':
    case 'not_running':
      return 'bad';
    default:
      return 'neutral';
  }
}

function toneForIncidentSeverity(value) {
  if (value === 'critical') return 'bad';
  if (value === 'warn') return 'warn';
  if (value === 'info') return 'neutral';
  return 'neutral';
}

function renderHealthList(status) {
  const items = [
    ['overall', status.health?.state],
    ['control plane', status.health?.controlPlane],
    ['executor', status.health?.executor],
    ['delivery', status.health?.delivery],
    ['account', status.health?.account],
    ['queue', status.health?.queue]
  ];

  return `<div class="health-grid">${items.map(([label, value]) => `
    <div class="health-card">
      <div class="health-label">${escapeHtml(label)}</div>
      <div class="health-value">${badge(value || 'unknown', toneForHealth(value))}</div>
    </div>
  `).join('')}</div>`;
}

function renderFailureRows(rows = []) {
  if (!rows.length) return '<p class="empty">No recent terminal failures.</p>';
  return `<table><thead><tr><th>when</th><th>job</th><th>candidate</th><th>code</th><th>class</th><th>policy</th><th>evidence</th></tr></thead><tbody>${rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.createdAt || '—')}</td>
      <td>${escapeHtml(row.jobId ?? '—')}</td>
      <td>${escapeHtml(row.candidateId ?? '—')}</td>
      <td>${code(row.errorCode || '—')}</td>
      <td>${escapeHtml(row.failureClass || '—')}</td>
      <td>${escapeHtml(row.failurePolicy || '—')}</td>
      <td>${row.evidenceBundlePath ? code(row.evidenceBundlePath) : '—'}</td>
    </tr>
  `).join('')}</tbody></table>`;
}

function renderBlockerRows(rows = []) {
  if (!rows.length) return '<p class="empty">None.</p>';
  return `<table><thead><tr><th>candidate</th><th>job</th><th>status</th><th>code</th><th>policy</th><th>post</th></tr></thead><tbody>${rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.candidateId ?? '—')}</td>
      <td>${escapeHtml(row.jobId ?? '—')}</td>
      <td>${escapeHtml(row.status || '—')}</td>
      <td>${code(row.errorCode || '—')}</td>
      <td>${escapeHtml(row.failurePolicy || '—')}</td>
      <td>${code(row.postUrl || '—')}</td>
    </tr>
  `).join('')}</tbody></table>`;
}

function renderCanary(canary) {
  if (!canary) return '<p class="empty">No canary result recorded.</p>';
  return `
    <div class="stack compact">
      <div>state: ${badge(canary.state || 'unknown', toneForHealth(canary.state))}</div>
      <div>ok: ${escapeHtml(canary.ok)}</div>
      <div>code: ${code(canary.code || '—')}</div>
      <div>reason: ${code(canary.reason || '—')}</div>
      <div>finalUrl: ${code(canary.finalUrl || '—')}</div>
      <div>startedAt: ${escapeHtml(canary.startedAt || '—')}</div>
    </div>
  `;
}

function renderSelfTests(selfTests) {
  const rows = selfTests?.results || [];
  if (!rows.length) return '<p class="empty">No self-test results recorded yet.</p>';
  return `<div class="subtle">overall: ${escapeHtml(selfTests.summary?.overall || 'unknown')} · total: ${escapeHtml(selfTests.summary?.total || 0)}</div><table><thead><tr><th>test</th><th>status</th><th>summary</th><th>checked</th></tr></thead><tbody>${rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.testKey)}</td>
      <td>${badge(row.status || 'unknown', toneForHealth(row.status))}</td>
      <td>${escapeHtml(row.summary || '—')}</td>
      <td>${escapeHtml(row.checkedAt || '—')}</td>
    </tr>
  `).join('')}</tbody></table>`;
}

function renderReadiness(readiness) {
  if (!readiness) return '<p class="empty">No readiness evaluation yet.</p>';
  const renderList = (items = []) => items.length
    ? `<ul>${items.map((item) => `<li><strong>${escapeHtml(item.code)}</strong> — ${escapeHtml(item.summary)}</li>`).join('')}</ul>`
    : '<p class="empty">None.</p>';
  return `
    <div class="card stack compact">
      <div>state: ${badge(readiness.state || 'unknown', toneForHealth(readiness.state))}</div>
      <div>ok: ${escapeHtml(readiness.ok)}</div>
      <div>evaluated: ${escapeHtml(readiness.evaluatedAt || '—')}</div>
      <div>freshness: self-tests=${escapeHtml(readiness.freshness?.selfTestsFresh)} · canary=${escapeHtml(readiness.freshness?.canaryFresh)} · session=${escapeHtml(readiness.freshness?.sessionFresh)}</div>
      <div><strong>Blocking reasons</strong>${renderList(readiness.blockingReasons)}</div>
      <div><strong>Warnings</strong>${renderList(readiness.warnings)}</div>
    </div>
  `;
}

function renderIncidents(incidents = []) {
  if (!incidents.length) return '<p class="empty">No active incidents.</p>';
  return `<table><thead><tr><th>kind</th><th>severity</th><th>status</th><th>summary</th><th>started</th><th>last seen</th><th>auto recovery attempts</th></tr></thead><tbody>${incidents.map((incident) => `
    <tr>
      <td>${escapeHtml(incident.kind)}</td>
      <td>${badge(incident.severity, toneForIncidentSeverity(incident.severity))}</td>
      <td>${escapeHtml(incident.status)}</td>
      <td>${escapeHtml(incident.summary)}</td>
      <td>${escapeHtml(incident.startedAt || '—')}</td>
      <td>${escapeHtml(incident.lastSeenAt || '—')}</td>
      <td>${escapeHtml(incident.autoRecoveryAttempts ?? 0)}</td>
    </tr>
  `).join('')}</tbody></table>`;
}

function renderPolicyVersions(policyVersions) {
  if (!policyVersions) return '<p class="empty">No policy version data.</p>';
  return `<table><thead><tr><th>surface</th><th>version</th></tr></thead><tbody>${Object.entries(policyVersions).map(([key, value]) => `
    <tr><td>${escapeHtml(key)}</td><td>${code(value)}</td></tr>
  `).join('')}</tbody></table>`;
}

function renderSlo(slo) {
  if (!slo) return '<p class="empty">No SLO evaluation yet.</p>';
  return `<div class="card stack compact"><div>state: ${badge(slo.state || 'unknown', toneForHealth(slo.state))}</div><div>violations: ${escapeHtml(slo.violations?.length ?? 0)}</div>${slo.violations?.length ? `<ul>${slo.violations.map((v) => `<li><strong>${escapeHtml(v.key)}</strong> actual=${escapeHtml(v.actual)} target=${escapeHtml(v.target)}</li>`).join('')}</ul>` : '<p class="empty">No current violations.</p>'}</div>`;
}

function renderSoak(soak) {
  if (!soak) return '<p class="empty">No soak report yet.</p>';
  const summary = soak.summary || {};
  return `<div class="card stack compact">
    <div>window days: ${escapeHtml(soak.windowDays)}</div>
    <div>success rate: ${escapeHtml(summary.successRate ?? 'n/a')}</div>
    <div>auto recovery success rate: ${escapeHtml(summary.autoRecoverySuccessRate ?? 'n/a')}</div>
    <div>critical incidents: ${escapeHtml(summary.criticalIncidents ?? 0)}</div>
    <div>operator-required incidents: ${escapeHtml(summary.operatorRequiredIncidents ?? 0)}</div>
    <div>readiness blocks: ${escapeHtml(summary.readinessBlocks ?? 0)}</div>
    <div>max queued age (min): ${escapeHtml(summary.maxQueuedAgeMinutes ?? 0)}</div>
    <div>degraded minutes: ${escapeHtml(summary.degradedMinutes ?? 0)}</div>
    <div>control-plane stale minutes: ${escapeHtml(summary.controlPlaneStaleMinutes ?? 0)}</div>
  </div>`;
}

export function renderOperatorDashboard(status, options = {}) {
  const title = options.title || 'IG Automation Operator Dashboard';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #0b0d10; color: #eef2f7; margin: 0; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
    h1,h2,h3 { margin: 0 0 12px; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; margin-top: 28px; }
    p, li, td, th, input, button { font-size: 14px; }
    .subtle, .empty { color: #9aa4b2; }
    .health-grid, .stats-grid, .action-grid { display: grid; gap: 12px; }
    .health-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .stats-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .action-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .card, .health-card { background: #131821; border: 1px solid #273142; border-radius: 12px; padding: 14px; }
    .health-label, .stat-label { color: #8da0b8; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; margin-bottom: 8px; }
    .stat-value { font-size: 24px; font-weight: 700; }
    .health-value { font-size: 16px; font-weight: 600; }
    .badge { display:inline-block; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .badge-good { background:#0f5132; color:#d1fae5; }
    .badge-warn { background:#5b4113; color:#fde68a; }
    .badge-bad { background:#5b1a1a; color:#fecaca; }
    .badge-neutral { background:#263445; color:#dbe7f3; }
    .stack { display:flex; flex-direction:column; gap:8px; }
    .compact { gap:4px; }
    table { width:100%; border-collapse: collapse; background: #131821; border: 1px solid #273142; border-radius: 12px; overflow: hidden; }
    th, td { text-align:left; padding: 10px 12px; border-bottom: 1px solid #202a38; vertical-align: top; }
    th { color:#93a5bd; font-weight: 600; background:#10151d; }
    tr:last-child td { border-bottom: none; }
    code { white-space: pre-wrap; word-break: break-word; color: #d7e3f1; }
    form { display:flex; flex-direction:column; gap:8px; }
    input { background:#0f141c; color:#eef2f7; border:1px solid #314055; border-radius:8px; padding:10px; }
    button { background:#2563eb; color:white; border:none; border-radius:8px; padding:10px 12px; font-weight:600; cursor:pointer; }
    button:hover { background:#1d4ed8; }
    .action-note { color:#93a5bd; min-height: 32px; }
    .topbar { display:flex; justify-content:space-between; gap:16px; align-items:flex-end; flex-wrap:wrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="subtle">Automation enabled: ${escapeHtml(status.automationEnabled)} · pending approvals: ${escapeHtml(status.pendingApprovals)} · updated from live DB state</div>
      </div>
      <div>${badge(status.health?.state || 'unknown', toneForHealth(status.health?.state))}</div>
    </div>

    <h2>Health</h2>
    ${renderHealthList(status)}

    <h2>Queue + throughput</h2>
    <div class="stats-grid">
      ${[
        ['queued', status.counts?.queued],
        ['running', status.counts?.running],
        ['success', status.counts?.success],
        ['failed', status.counts?.failed],
        ['blocked', status.counts?.blocked],
        ['stopped', status.counts?.stopped],
        ['approved drift', status.approvedWithoutActive],
        ['recovery suppressed', status.recoverySuppressedCount]
      ].map(([label, value]) => `
        <div class="card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value ?? 0)}</div></div>
      `).join('')}
    </div>

    <h2>Canary</h2>
    <div class="card">${renderCanary(status.health?.canary)}</div>

    <h2>Readiness</h2>
    ${renderReadiness(status.readiness)}

    <h2>Operator actions</h2>
    <div class="action-grid">
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="pause" /><input name="reason" placeholder="reason (optional)" /><button type="submit">Pause automation</button><div class="action-note">Stops new worker execution by flipping the DB flag off.</div></form></div>
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="resume" /><input name="reason" placeholder="reason (optional)" /><button type="submit">Resume automation</button><div class="action-note">Re-enables normal processing.</div></form></div>
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="requeue_blocked" /><input name="reason" placeholder="reason (optional)" /><button type="submit">Requeue blocked</button><div class="action-note">Fresh queued jobs for currently blocked candidates, preserving history.</div></form></div>
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="reconcile_approved" /><input name="reason" placeholder="reason (optional)" /><button type="submit">Reconcile approved</button><div class="action-note">Queues approved candidates that drifted out of active/success states.</div></form></div>
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="suppress_candidate" /><input name="candidateId" placeholder="candidate id" required /><input name="reason" placeholder="suppression reason" /><button type="submit">Suppress candidate</button><div class="action-note">Prevents recovery/requeue for one candidate.</div></form></div>
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="ack_session_challenge" /><input name="reason" placeholder="reason (optional)" /><button type="submit">Acknowledge challenge</button><div class="action-note">Marks the challenge as seen and puts session trust into pending revalidation.</div></form></div>
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="ack_session_recovery" /><input name="reason" placeholder="reason (optional)" /><button type="submit">Acknowledge recovery</button><div class="action-note">Records that you completed recovery steps, but keeps the session quarantined until revalidation succeeds.</div></form></div>
      <div class="card"><form method="post" action="/automation/action"><input type="hidden" name="action" value="mark_session_revalidated" /><input name="reason" placeholder="reason (optional)" /><button type="submit">Mark session revalidated</button><div class="action-note">Clears quarantine only after you’ve verified the session is genuinely healthy again.</div></form></div>
    </div>

    <h2>Current blockers</h2>
    ${renderBlockerRows(status.currentBlocked)}

    <h2>Historical blocked</h2>
    ${renderBlockerRows(status.historicalBlocked)}

    <h2>Recent failures</h2>
    ${renderFailureRows(status.recentTerminalFailures)}

    <h2>Active incidents</h2>
    ${renderIncidents(status.incidents?.active || [])}

    <h2>Session state</h2>
    <div class="card stack compact">
      <div>session health: ${badge(status.sessionState?.sessionHealth || 'unknown', toneForHealth(status.sessionState?.sessionHealth))}</div>
      <div>quarantine: ${badge(status.sessionState?.quarantineState || 'unknown', toneForHealth(status.sessionState?.quarantineState))}</div>
      <div>trust: ${badge(status.sessionState?.trustState || 'unknown', toneForHealth(status.sessionState?.trustState))}</div>
      <div>trust reason: ${escapeHtml(status.sessionState?.trustReason || '—')}</div>
      <div>last login confirmed: ${escapeHtml(status.sessionState?.lastLoginConfirmedAt || '—')}</div>
      <div>last challenge: ${escapeHtml(status.sessionState?.lastChallengeAt || '—')}</div>
      <div>last successful action: ${escapeHtml(status.sessionState?.lastSuccessfulActionAt || '—')}</div>
      <div>challenge acknowledged: ${escapeHtml(status.sessionState?.challengeAcknowledgedAt || '—')}</div>
      <div>recovery acknowledged: ${escapeHtml(status.sessionState?.recoveryAcknowledgedAt || '—')}</div>
      <div>revalidated: ${escapeHtml(status.sessionState?.revalidatedAt || '—')}</div>
    </div>

    <h2>SLO summary</h2>
    <div class="card stack compact">
      <div>success rate: ${escapeHtml(status.metrics?.summary?.successRate ?? 'n/a')}</div>
      <div>selector failure rate: ${escapeHtml(status.metrics?.summary?.selectorFailureRate ?? 'n/a')}</div>
      <div>verification failure rate: ${escapeHtml(status.metrics?.summary?.verificationFailureRate ?? 'n/a')}</div>
      <div>challenge incidence rate: ${escapeHtml(status.metrics?.summary?.challengeIncidenceRate ?? 'n/a')}</div>
      <div>telegram delivery degradation rate: ${escapeHtml(status.metrics?.summary?.telegramDeliveryDegradationRate ?? 'n/a')}</div>
      <div>mean time to operator intervention (min): ${escapeHtml(status.metrics?.summary?.meanTimeToOperatorInterventionMinutes ?? 'n/a')}</div>
    </div>

    <h2>Self-tests</h2>
    ${renderSelfTests(status.selfTests)}

    <h2>Run self-tests</h2>
    <div class="action-grid">
      <div class="card"><form method="post" action="/automation/self-tests/run"><button type="submit">Run self-tests now</button><div class="action-note">Runs the non-mutating control-plane, transport, DB, session, and safe page-shape checks.</div></form></div>
    </div>

    <h2>Policy versions</h2>
    ${renderPolicyVersions(status.policyVersions)}
  </div>
</body>
</html>`;
}
