function parseTimestamp(value) {
  if (!value) return null;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageMs(value, now = new Date()) {
  const date = parseTimestamp(value);
  if (!date) return null;
  return Math.max(0, now.getTime() - date.getTime());
}

const DEFAULT_POLICY = Object.freeze({
  freshness: {
    control_plane_http: 10 * 60 * 1000,
    telegram_transport: 15 * 60 * 1000,
    db_integrity: 15 * 60 * 1000,
    session_canary_readonly: 15 * 60 * 1000,
    instagram_page_shape_probe: 60 * 60 * 1000,
    synthetic_operator_path: 15 * 60 * 1000,
    synthetic_event_path: 15 * 60 * 1000,
    synthetic_remediation_dry_run: 15 * 60 * 1000
  },
  blockingTests: [
    'control_plane_http',
    'db_integrity',
    'session_canary_readonly'
  ],
  warningOnlyTests: [
    'telegram_transport'
  ],
  optionalTests: [
    'instagram_page_shape_probe',
    'synthetic_operator_path',
    'synthetic_event_path',
    'synthetic_remediation_dry_run'
  ]
});

export function getSelfTestPolicy() {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY));
}

function classifyTest(policy, testKey) {
  if (policy.blockingTests.includes(testKey)) return 'blocking';
  if (policy.warningOnlyTests.includes(testKey)) return 'warning';
  if (policy.optionalTests.includes(testKey)) return 'optional';
  return 'warning';
}

export function evaluateSelfTestFreshness(results = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const policy = options.policy || getSelfTestPolicy();
  const entries = results.map((row) => {
    const maxAgeMs = policy.freshness[row.testKey] ?? 15 * 60 * 1000;
    const currentAgeMs = ageMs(row.checkedAt || row.updatedAt, now);
    const classification = classifyTest(policy, row.testKey);
    const stale = currentAgeMs == null || currentAgeMs > maxAgeMs;
    return {
      testKey: row.testKey,
      classification,
      stale,
      ageMs: currentAgeMs,
      maxAgeMs,
      checkedAt: row.checkedAt || row.updatedAt || null,
      status: row.status
    };
  });

  return {
    entries,
    blockingFresh: entries.filter((entry) => entry.classification === 'blocking').every((entry) => !entry.stale),
    warningFresh: entries.filter((entry) => entry.classification === 'warning').every((entry) => !entry.stale),
    optionalFresh: entries.filter((entry) => entry.classification === 'optional').every((entry) => !entry.stale)
  };
}

export function evaluateSelfTestSeverity(results = [], options = {}) {
  const policy = options.policy || getSelfTestPolicy();
  const freshness = evaluateSelfTestFreshness(results, options);
  const issues = [];

  for (const row of results) {
    const classification = classifyTest(policy, row.testKey);
    const fresh = freshness.entries.find((entry) => entry.testKey === row.testKey);
    if (fresh?.stale) {
      issues.push({
        testKey: row.testKey,
        classification,
        level: classification === 'blocking' ? 'blocking' : 'warning',
        reason: 'stale',
        summary: `${row.testKey} result is stale`
      });
    }

    if (row.status === 'error') {
      issues.push({
        testKey: row.testKey,
        classification,
        level: classification === 'optional' ? 'warning' : 'blocking',
        reason: 'error',
        summary: `${row.testKey} reported error`
      });
    } else if (row.status === 'degraded') {
      issues.push({
        testKey: row.testKey,
        classification,
        level: classification === 'blocking' ? 'blocking' : 'warning',
        reason: 'degraded',
        summary: `${row.testKey} reported degraded`
      });
    } else if (row.status === 'skipped' && classification !== 'optional') {
      issues.push({
        testKey: row.testKey,
        classification,
        level: classification === 'blocking' ? 'blocking' : 'warning',
        reason: 'skipped',
        summary: `${row.testKey} was skipped`
      });
    }
  }

  return {
    freshness,
    blockingIssues: issues.filter((issue) => issue.level === 'blocking'),
    warningIssues: issues.filter((issue) => issue.level === 'warning'),
    issues
  };
}
