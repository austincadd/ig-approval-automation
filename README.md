# IG Approval Automation (Experimental)

Approval-first local Instagram automation with a Telegram operator loop, a single-worker execution model, persisted run history, and Phase 5 incident management.

## What this repo does

- Queues Instagram post candidates for human review.
- Sends approval/recovery/operator controls through Telegram.
- Runs a bounded single-worker pipeline with safety stops.
- Surfaces operator health through JSON, Telegram, MCP, and an HTML dashboard.
- Tracks incidents, stall detection, auto-remediation attempts, and escalation state.

## Quick start

```bash
cp .env.example .env
npm install
npx playwright install
npm run db:migrate
npm run bot:start
```

`npm run bot:start` is now single-instance protected. A second start exits immediately with a clear message instead of colliding on Telegram polling / port `8788`. Default lock file: `data/telegram-bot.lock` (override with `TELEGRAM_BOT_LOCK_PATH`).

In another terminal:

```bash
npm run enqueue -- "https://www.instagram.com/p/POST_CODE/"
npm run worker:once
```

For a persistent local worker instead of one-off runs:

```bash
cp run/com.austincaddell.ig-approval-worker.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.austincaddell.ig-approval-worker.plist
launchctl enable gui/$(id -u)/com.austincaddell.ig-approval-worker
launchctl kickstart -k gui/$(id -u)/com.austincaddell.ig-approval-worker
```

## Recovery / ops commands

```bash
npm run pause -- "optional reason"
npm run resume -- "optional reason"
npm run requeue:blocked -- "optional reason"
npm run reconcile:approved -- "optional reason"
npm run self-tests:run
npm run validate:recovery
```

Telegram ops commands:
- Send a raw Instagram post/reel/tv link directly to the bot to create/reuse a candidate and immediately send the review card.
- `/automation_status` — authoritative operator status snapshot (bot health, worker health/last run, automation flag, queue counts, drift, recent terminal failures, self-test summary, policy versions)
- `/pause_automation [reason]`
- `/resume_automation [reason]`
- `/requeue_blocked [reason]`
- `/reconcile_queue [reason]`

Phase 4 additions:
- Dashboard actions are available via `POST /automation/action` for pause/resume/requeue/reconcile/suppress.
- Self-tests persist latest structured results into `self_test_results` and expose them through status/dashboard surfaces.
- Active selector/failure/retry/suppression/canary policy versions are surfaced in status, dashboard, run events, and evidence manifests.

Phase 5 additions:
- Incidents are persisted in `active_incidents` with deduped refresh, recovery-attempt counters, and transition run events.
- Queue stall detection auto-opens/resolves `queue_stalled` incidents during operator status generation.
- Auto-remediation stays injectable: core logic decides *when* to try recovery, while runtime-specific restart/test actions are provided from the outside.
- Escalation decisions are deduped and persisted in `incident_notifications` so critical transitions only notify once.

Read-only status surfaces:
- Telegram: `/automation_status`
- Callback server JSON: `GET /automation/status`
- Operator dashboard HTML: `GET /automation/dashboard`
- Self-test JSON: `GET /automation/self-tests`
- Incident JSON: `GET /automation/incidents` (control-plane auth required)
- MCP: `automation_status`

## Validation

Core Phase 5 validation sweep:

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

## Incidents

- Active incidents are visible in operator status text, the dashboard, and `GET /automation/incidents`.
- Supported transitions: open/refresh, monitoring, resolved, suppressed.
- Queue stalls, degraded delivery, stale control-plane states, and account issues can share one operator-facing registry instead of scattered ad hoc flags.

## Queue stall detection

- A queue stall is raised when queued jobs exist and the worker is dead, active progress is stale, or the last successful completion is too old with no recent useful progress.
- Defaults are intentionally simple and bounded: `queueStallMinutes=15`, `workerStaleMinutes=10`, `progressStaleMinutes=10`.

## Auto-remediation

- Retryable Phase 5 kinds: `control_plane_stale`, `worker_stale`, `telegram_delivery_degraded`, `queue_stalled`.
- Non-retryable Phase 5 kinds: `account_challenge`, `account_logged_out`.
- Recovery remains deployment-agnostic: inject `restartControlPlane`, `restartWorker`, `runSelfTests`, or probe actions instead of burying shell commands in core modules.

## Escalation behavior

- Notify-worthy transitions are deduped: first critical open, account challenge/logout open, escalation to critical, final failed auto-remediation, and resolution of a previously-notified critical incident.
- Repeated refreshes of the same degraded incident do not create new notifications.

Telegram result reporting:
- After approval/queueing, the bot now proactively reports terminal job outcomes back to the operator chat.
- Covered outcomes: success, failed, blocked.
- Messages include candidate/job ids, post URL, and a compact reason/guidance summary.
- Multiple fresh terminal results from the same poll cycle are coalesced into as few Telegram messages as possible to avoid noisy spam.
- Reporter is intentionally non-backfilling on first start; it initializes its cursor at the latest existing job-result event and only reports new ones.

## LaunchAgent worker

Repo artifact: `run/com.austincaddell.ig-approval-worker.plist`

Useful commands:

```bash
# Install / update from the repo copy
cp run/com.austincaddell.ig-approval-worker.plist ~/Library/LaunchAgents/

# Load and start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.austincaddell.ig-approval-worker.plist
launchctl enable gui/$(id -u)/com.austincaddell.ig-approval-worker
launchctl kickstart -k gui/$(id -u)/com.austincaddell.ig-approval-worker

# Check status
launchctl print gui/$(id -u)/com.austincaddell.ig-approval-worker

# Restart after edits
launchctl bootout gui/$(id -u)/com.austincaddell.ig-approval-worker || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.austincaddell.ig-approval-worker.plist
launchctl kickstart -k gui/$(id -u)/com.austincaddell.ig-approval-worker
```

Logs:
- `logs/worker.launchd.out.log`
- `logs/worker.launchd.err.log`

Notes about worker behavior:
- LaunchAgent now runs `node scripts/run-worker-loop.js` directly instead of `npm run ...`, which keeps the log stream cleaner and lets every worker line carry a timestamp.
- The loop uses `fs.watch` when available, but also polls SQLite file metadata as a cross-platform fallback/backup so new DB writes can still wake the worker on platforms where file watching is weaker.
- Cooldown is intentional policy between already-queued jobs. Fresh DB writes can wake the worker early, but a backlog that was already present still drains at the configured cooldown pace.

## Notes
- Use burner/test account only.
- System auto-pauses on checkpoint/challenge markers.
- Recovery requeues create fresh queued jobs; blocked job history is preserved.
- `/resume_automation` only flips the DB flag back on; the persistent LaunchAgent is what keeps the local worker running between sessions.
