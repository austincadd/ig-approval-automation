# IG Approval Automation — Reliability Roadmap

Last updated: 2026-05-28 22:24 America/New_York
Status: Draft for execution
Goal: Move from operator-assisted experimental automation to a boring, trustworthy, low-touch product.

## Outcome target

Current truth:
- Good experimental tool
- Not yet set-and-forget
- Control plane is much stronger than before
- Main remaining risk is runtime reliability, health truthfulness, and browser/UI fragility

Target truth:
- System can run unattended for normal operation
- System pauses itself safely on risky conditions
- Operator only intervenes for account trust/session problems or true product regressions
- Health/status surfaces accurately reflect reality

---

## Phase 1 — Stabilize the current product

Time horizon: immediate / next execution pass
Objective: Make the current single-account system honest, safer, and less fragile without changing product shape too much.

### 1. Executor canary gate before claiming jobs
**Problem:** Worker can be “running” while browser/session state is bad.

**Implement:**
- Add a pre-claim canary path that verifies:
  - browser profile lock acquired
  - Instagram home/profile loads
  - logged-in state confirmed
  - no challenge markers
  - primary action surface renders on a known-safe page shape
- If canary fails:
  - do not claim a queued job
  - set system state to degraded or operator_required
  - persist structured reason

**Done when:**
- Worker never claims jobs while session is unhealthy
- `/automation/status` shows explicit canary state/result

### 2. Failure taxonomy + policy engine
**Problem:** Failures are logged, but recovery behavior is still too ad hoc.

**Implement:**
Create explicit classes:
- transient_network
- page_readiness_failure
- selector_drift
- state_verification_failure
- candidate_dead
- account_challenge
- account_logged_out
- system_integrity_failure

Map each class to policy:
- retry now
- retry later with backoff
- suppress candidate
- pause executor
- pause whole system
- require operator action

**Done when:**
- every terminal job outcome carries a failure class
- no raw failure code exists without a policy mapping

### 3. Evidence bundle for every non-success
**Problem:** Failures still require too much guesswork.

**Implement:**
For every failed/blocked verification path, persist:
- screenshot
- final URL
- visible text excerpt
- selector diagnostics
- primary control candidate map
- challenge markers if any
- timestamp + job id + candidate id

Store in predictable structure, e.g.:
- `artifacts/failures/YYYY-MM-DD/job-<id>/...`

**Done when:**
- every non-success is inspectable without rerunning live

### 4. Truthful health/status model
**Problem:** “running” can still hide stale/no-op behavior.

**Implement:**
Expose explicit system states:
- healthy
- idle
- degraded
- paused
- operator_required
- unsafe

Status should separately report:
- control plane health
- executor health
- delivery/Telegram health
- account/session health
- queue health

**Done when:**
- `/automation/status` cannot report healthy if executor is stale, canary-failing, or transport-broken

### 5. Telegram transport hardening
**Problem:** Telegram polling noise is muddying runtime trust.

**Implement:**
- Distinguish transient provider/network issues from true bot-health issues
- Persist bot health summary separately from raw polling errors
- Add restart budget / backoff visibility
- Ensure duplicate poller detection is explicit and fatal, not just noisy
- Make notifications non-critical to queue correctness

**Done when:**
- Telegram issues no longer imply automation is broken
- operator can see “delivery degraded, execution okay” as a first-class state

### 6. Clean up known stale queue history
**Problem:** Historical failures/blocked rows still muddy trust.

**Implement:**
- preserve history
- but mark stale/reconciled legacy rows clearly
- separate “historical blocked” from “active blocker” in reporting

**Done when:**
- status surfaces only current blockers as actionable blockers

---

## Phase 2 — Harden execution reliability

Time horizon: near-term
Objective: Make browser action execution resilient enough that normal Instagram variance does not constantly create operator work.

### 7. Selector strategy redesign
**Problem:** `LIKE_BUTTON_NOT_FOUND` still happens too often.

**Implement layered detection:**
1. semantic labels (`Like`, `Unlike`, `Liked`)
2. role/button + aria grouping
3. action-row geometry clustering
4. modal/post/reel layout variants
5. fallback candidate scoring rather than hard single selector dependency

**Done when:**
- selector misses become rare and diagnosable by layout family

### 8. Post-click verification redesign
**Problem:** `LIKE_STATE_NOT_CONFIRMED` means click success and verification logic are still too loosely coupled.

**Implement:**
- multi-signal verification:
  - state label flips
  - DOM mutation near action group
  - post action control re-resolution
  - optional count/state delta if present
- classify ambiguity instead of collapsing to one generic failure

**Done when:**
- verification failures are either truly ambiguous or classified into a narrower cause bucket

### 9. Page-shape classifier
**Problem:** System treats all targets too similarly.

**Implement:**
Classify target before action:
- reel
- feed post
- modal overlay post
- unavailable/removed
- challenge/login
- unsupported shape

Then select action/verification strategy by page shape.

**Done when:**
- executor behavior is shape-aware, not one-flow-for-everything

### 10. Retry strategy by failure class
**Problem:** Current retry behavior is still too blunt.

**Implement:**
- transient page load: retry quickly
- selector drift: retry once with alternate strategy
- verification ambiguity: retry once after re-resolve
- dead candidate: suppress permanently
- account challenge: global pause

**Done when:**
- retries reduce toil instead of amplifying noise

---

## Phase 3 — Make the system operationally boring

Time horizon: medium-term
Objective: Reduce dependence on one long-lived process/blob and make failures local instead of systemic.

### 11. Split control plane from executor plane
**Problem:** too much system trust is concentrated in `bot/telegram-callback-server.js` and related process coupling.

**Implement:**
- Control plane:
  - approvals
  - queue
  - policy
  - health/status
  - notifications
- Executor plane:
  - browser work only
- Observation plane:
  - metrics, evidence, logs, artifacts

**Done when:**
- executor can crash/restart without threatening queue integrity or operator state

### 12. Refactor callback server monolith
**Problem:** callback server still holds too much responsibility.

**Break apart further into:**
- bot transport
- operator commands
- review-card delivery
- automation status API
- result reporter
- command task runner

**Done when:**
- each concern has a narrow seam and independent validation coverage

### 13. Session manager / account state service
**Problem:** browser profile/session trust is still too implicit.

**Implement:**
- explicit session health record
- last login-confirmed timestamp
- last challenge timestamp
- last successful action timestamp
- session quarantine state

**Done when:**
- account health is observable without inferring from worker logs

### 14. Metrics + SLOs
**Problem:** reliability is still qualitative.

**Track:**
- success rate by day
- success rate by page shape
- selector failure rate
- verification failure rate
- challenge incidence
- Telegram delivery degradation rate
- mean time to operator intervention

**Done when:**
- we can say whether reliability is improving with numbers, not vibes

---

## Phase 4 — Productize for low-touch operation

Time horizon: after core stabilization
Objective: Turn it from a strong internal automation tool into something closer to a product.

### 15. Operator dashboard
Include:
- current health state
- queue summary
- account/session health
- recent failures by class
- canary status
- artifact links
- clear resume/pause/retry/suppress controls

### 16. Scheduled self-tests
Run periodic synthetic checks that do **not** mutate live targets:
- transport test
- DB integrity test
- account/session test
- Instagram page-shape test

### 17. Config/policy versioning
Version:
- selector strategies
- failure policy mapping
- limits/backoffs
- suppression rules

So regressions can be correlated to config changes.

### 18. Multi-account or executor abstraction
Only after single-account reliability is boring.
Not before.

---

## Execution order

### Now
1. executor canary gate
2. failure taxonomy + policy engine
3. evidence bundle persistence
4. truthful health/status model
5. Telegram transport hardening
6. stale-history cleanup in reporting

### Next
7. selector redesign
8. post-click verification redesign
9. page-shape classifier
10. smarter retries

### Then
11. split control/executor planes
12. refactor callback monolith
13. session/account state service
14. metrics + SLOs

### Finally
15. operator dashboard
16. scheduled self-tests
17. config/policy versioning
18. multi-account abstraction

---

## Non-goals for now
- maximizing growth throughput
- multi-account orchestration
- aggressive concurrency
- fully autonomous candidate discovery/product expansion

Those are distractions until reliability is boring.

---

## Definition of “set-and-forget enough”

We should not call this set-and-forget until all are true:
- canary gate prevents bad claims
- health states are truthful
- failure classes map to deterministic policies
- every non-success has an evidence bundle
- stale/historical blockers no longer pollute current state
- selector + verification failures are rare and explainable
- Telegram degradation does not threaten queue correctness
- operator intervention is mostly limited to trust/challenge/login issues

---

## Recommended immediate implementation slice

If only one slice gets funded next, do this bundle together:
- canary gate
- failure taxonomy
- evidence bundles
- truthful status model

Why:
That bundle does the most to convert a fragile automation into a controllable product.
