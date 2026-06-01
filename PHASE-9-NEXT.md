# Phase 9 — Remaining runtime-durability work

Status: Phase 9 is not complete yet.

What is already true:
- Browser profile locking prevents unsafe concurrent ownership.
- Worker readiness gates prevent stale/unsafe execution.
- Session trust, self-test freshness, soak reporting, and SLO surfacing are in place.
- Light live testing confirmed the real like outcome path can succeed.

What still needs to be built to make runtime behavior boring:

## 1. Explicit executor ownership model
- Add a first-class executor owner record instead of relying only on browser/profile lock presence.
- Track:
  - owner id
  - pid
  - started at
  - last heartbeat
  - mode (`worker-once`, `worker-loop`, `manual`, `canary`)
- Make worker-loop and worker-once coordinate through this owner record before opening Chromium.

## 2. Heartbeat + stale-owner reclaim
- Add executor heartbeats while a browser session is active.
- Distinguish:
  - live owner
  - stale owner
  - ambiguous owner
- Only auto-reclaim stale owners after a bounded timeout and explicit verification.
- Stop relying on “profile busy” alone as the operator-facing explanation.

## 3. Cleaner browser/profile lock diagnostics
- Surface exact lock owner + age in status/dashboard.
- Expose whether contention is:
  - expected live owner
  - stale leftover
  - external/manual browser session
- Add targeted operator action for safe stale-lock cleanup only.

## 4. Worker-loop / worker-once coordination
- Prevent confusing races where `worker:once` says profile busy while another loop silently drains the queue.
- Make queue ownership and executor ownership visible together.
- Add structured run events for:
  - executor_acquired
  - executor_heartbeat
  - executor_released
  - executor_reclaim_attempted
  - executor_reclaim_succeeded
  - executor_reclaim_blocked

## 5. Crash recovery semantics
- On unexpected worker/browser death:
  - preserve a clear last-known owner record
  - record whether the active job was claimed but unfinished
  - classify restart behavior deterministically
- Add explicit handling for interrupted jobs so they do not remain ambiguous.

## 6. Safer manual intervention path
- Add authenticated operator action to inspect and, if safe, clear stale executor ownership.
- Do not let this blindly kill live sessions.
- Prefer “inspect → verify stale → reclaim” over forceful default behavior.

## 7. Validation coverage
Need dedicated runtime-durability validations for:
- live owner blocks secondary worker correctly
- stale owner can be reclaimed safely
- heartbeats keep owner live
- interrupted active job is classified/recovered correctly
- dashboard/status show real executor-owner state

## Exit criteria for completing Phase 9
Phase 9 should only be called complete when:
1. executor ownership is explicit, not inferred
2. stale owner reclaim is safe and deterministic
3. worker-loop/worker-once coordination is visible and boring
4. interrupted runs leave clean, explainable state
5. runtime contention explains itself in status/dashboard
6. dedicated Phase 9 validations pass

## Recommended next implementation order
1. executor owner record + heartbeat
2. status/dashboard surfacing
3. stale-owner reclaim logic
4. interrupted-job recovery semantics
5. dedicated validations
