# OPERATIONS

Concise operator runbook for the local IG approval automation system.

## Core model

- Telegram is the operator control surface.
- SQLite is the source of truth for queue, incident, and self-test state.
- The worker is single-instance and should process approved jobs one at a time.
- Safety signals win over throughput: challenge/logout/block indicators should stop or pause automation.

## Daily operator checks

1. Read `/automation_status` in Telegram or `GET /automation/status`.
2. Confirm queue counts, worker freshness, and latest self-test result look sane.
3. Check active incidents in the dashboard or `GET /automation/incidents`.
4. If incidents are present, determine whether they are informational, degraded, or require immediate intervention.

## Main status surfaces

- Telegram: `/automation_status`
- HTML dashboard: `GET /automation/dashboard`
- JSON status: `GET /automation/status`
- Self-tests: `GET /automation/self-tests`
- Incidents: `GET /automation/incidents` (authenticated)
- MCP: `automation_status`

## Common operator actions

### Pause automation

```bash
npm run pause -- "optional reason"
```

Telegram:

- `/pause_automation [reason]`

### Resume automation

```bash
npm run resume -- "optional reason"
```

Telegram:

- `/resume_automation [reason]`

### Requeue blocked work

```bash
npm run requeue:blocked -- "optional reason"
```

Telegram:

- `/requeue_blocked [reason]`

### Reconcile approved queue

```bash
npm run reconcile:approved -- "optional reason"
```

Telegram:

- `/reconcile_queue [reason]`

### Run self-tests

```bash
npm run self-tests:run
```

## Incident handling

Phase 5 incidents are persisted in `active_incidents` and surfaced across status, dashboard, and authenticated JSON.

Key behaviors:

- repeated issue refreshes dedupe on `dedupe_key`
- open incidents can move to monitoring, resolved, or suppressed
- transitions emit `run_events`
- notification-worthy transitions are deduped in `incident_notifications`

Typical incident kinds include:

- `queue_stalled`
- `worker_stale`
- `control_plane_stale`
- `telegram_delivery_degraded`
- `account_challenge`
- `account_logged_out`

## Queue stall signals

A queue stall is raised when queued work exists and one of these is true:

- the worker is not alive
- useful progress has gone stale
- the last successful completion is too old and there is no active recent progress

Default thresholds:

- `queueStallMinutes = 15`
- `workerStaleMinutes = 10`
- `progressStaleMinutes = 10`

## Auto-remediation

Auto-remediation is intentionally bounded and runtime-injected.

Retryable Phase 5 incident kinds:

- `control_plane_stale`
- `worker_stale`
- `telegram_delivery_degraded`
- `queue_stalled`

Non-retryable kinds:

- `account_challenge`
- `account_logged_out`

The core policy decides whether to try recovery; deployment-specific actions such as restarting the worker or rerunning self-tests are injected externally.

## When operator action is required

Treat these as operator-required unless quickly resolved:

- any critical incident
- `account_challenge`
- `account_logged_out`
- repeated failed remediation on a retryable incident
- stale queue with user-visible backlog that does not clear after recovery

## Validation commands

Core validation sweep:

```bash
npm run validate:incidents
npm run validate:stall-detection
npm run validate:auto-remediation
npm run validate:escalation
npm run validate:automation-status
npm run validate:operator-dashboard
npm run validate:self-tests
npm run validate:control-plane-seams
```

## Local worker notes

Install and run the LaunchAgent worker:

```bash
cp run/com.austincaddell.ig-approval-worker.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.austincaddell.ig-approval-worker.plist
launchctl enable gui/$(id -u)/com.austincaddell.ig-approval-worker
launchctl kickstart -k gui/$(id -u)/com.austincaddell.ig-approval-worker
```

Useful checks:

```bash
launchctl print gui/$(id -u)/com.austincaddell.ig-approval-worker
npm run worker:once
```

Logs:

- `logs/worker.launchd.out.log`
- `logs/worker.launchd.err.log`
