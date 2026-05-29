import { getPolicyVersions } from './policy-versions.js';

const FAILURE_CLASS_TO_POLICY = Object.freeze({
  transient_network: 'retry_later_with_backoff',
  page_readiness_failure: 'retry_now',
  selector_drift: 'retry_now',
  state_verification_failure: 'retry_now',
  candidate_dead: 'suppress_candidate',
  account_challenge: 'require_operator_action',
  account_logged_out: 'require_operator_action',
  system_integrity_failure: 'pause_whole_system',
  unsupported_page_shape: 'pause_executor'
});

const CODE_TO_CLASS = Object.freeze({
  BROWSER_PROFILE_LOCKED: 'system_integrity_failure',
  BROWSER_SESSION_NOT_READY: 'account_logged_out',
  CANARY_PROFILE_LOCK_FAILED: 'system_integrity_failure',
  CANARY_HOME_LOAD_FAILED: 'transient_network',
  CANARY_PROFILE_LOAD_FAILED: 'page_readiness_failure',
  CANARY_NOT_LOGGED_IN: 'account_logged_out',
  CANARY_CHALLENGE_DETECTED: 'account_challenge',
  CANARY_ACTION_SURFACE_MISSING: 'page_readiness_failure',
  LIKE_BUTTON_NOT_FOUND: 'selector_drift',
  LIKE_STATE_NOT_CONFIRMED: 'state_verification_failure',
  LIKE_VERIFICATION_ACTION_SURFACE_LOST: 'state_verification_failure',
  LIKE_VERIFICATION_STATE_STILL_UNLIKED: 'state_verification_failure',
  LIKE_VERIFICATION_AMBIGUOUS: 'state_verification_failure',
  LIKE_VERIFICATION_NO_SIGNAL: 'state_verification_failure',
  CHECKPOINT_DETECTED: 'account_challenge',
  TARGET_UNAVAILABLE: 'candidate_dead',
  TARGET_REMOVED: 'candidate_dead',
  TARGET_NOT_FOUND: 'candidate_dead',
  TARGET_UNSUPPORTED_SHAPE: 'unsupported_page_shape',
  NETWORK_IDLE_TIMEOUT: 'transient_network',
  NAVIGATION_TIMEOUT: 'transient_network',
  TELEGRAM_DUPLICATE_POLLER: 'system_integrity_failure',
  TELEGRAM_SEND_FAILED: 'transient_network'
});

export function getFailurePolicyForClass(failureClass) {
  const policy = FAILURE_CLASS_TO_POLICY[failureClass];
  if (!policy) {
    throw new Error(`No failure policy mapping exists for failure class: ${failureClass}`);
  }
  return policy;
}

export function classifyFailure(input = {}) {
  const code = String(input.code || '').trim() || 'UNKNOWN_FAILURE';
  const failureClass = input.failureClass || CODE_TO_CLASS[code] || 'system_integrity_failure';
  const policy = getFailurePolicyForClass(failureClass);
  return {
    code,
    failureClass,
    policy,
    terminal: input.terminal !== false,
    reason: input.reason || null,
    detail: input.detail || null
  };
}

export function applyFailurePolicy(db, classified, context = {}) {
  const actions = [];
  const actor = context.actor || 'system';
  const jobId = Number(context.jobId) || null;
  const candidateId = Number(context.candidateId) || null;

  if (classified.policy === 'suppress_candidate' && candidateId) {
    db.prepare(`
      INSERT INTO recovery_suppressions(candidate_id, reason, created_by, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(candidate_id) DO UPDATE SET
        reason = excluded.reason,
        created_by = excluded.created_by,
        created_at = excluded.created_at
    `).run(candidateId, classified.code, actor);
    actions.push('candidate_suppressed');
  }

  if (jobId) {
    db.prepare(`
      INSERT INTO run_events(job_id, level, event_type, payload_json)
      VALUES (?, 'warn', 'failure_policy_applied', json(?))
    `).run(jobId, JSON.stringify({
      actor,
      code: classified.code,
      failureClass: classified.failureClass,
      policy: classified.policy,
      actions,
      policyVersions: getPolicyVersions()
    }));
  }

  return { ...classified, actions };
}

export { FAILURE_CLASS_TO_POLICY, CODE_TO_CLASS };
