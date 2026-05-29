# IG Approval Automation MCP Migration Audit (Detailed)

Date: 2026-05-01 (America/New_York)  
Workspace root: `/Users/austincaddell/.openclaw/workspace`  
Project root: `/Users/austincaddell/.openclaw/workspace/ig-approval-automation`

---

## 1) Executive Summary

This audit covers all work completed so far for:
- candidate command diagnostics (`/candidates_build`, `/candidates_top`),
- FlashAPI call-path failures in the agent execution environment,
- MCP execution model verification,
- agreed surface area / seam design,
- MCP daemon skeleton creation and cleanup,
- migration sequencing proposal.

### Current status
- MCP architecture is validated (host daemon, HTTP MCP endpoint, tool discovery working in your environment).
- Core seam signatures are fully approved/locked (9 tool-aligned functions).
- `flash-mcp.sh` silent-empty output mode was hardened to explicit failure (exit 70).
- MCP skeleton server exists with 9 tools + schemas and `NOT_IMPLEMENTED` stubs.
- Next implementation-ready step: migration PR #1 (`candidates_top`).

---

## 2) Scope and Goals

### Primary goal
Move API/network dependent logic into a persistent host-side MCP daemon (same network/runtime as `insta_bot009`) and keep Telegram + MCP as thin adapters over shared `core/` logic.

### Non-goals in this phase
- No approval write tools over MCP yet.
- No Playwright story browser tools over MCP.
- No full core implementation yet (skeleton + signatures only so far).

---

## 3) Environment + Constraints Observed

- Agent command runtime has sandbox differences from your interactive terminal.
- Direct network behaviors diverged between sandbox-path and host-path (escalated run).
- `gog` usage in agent path was blocked by keychain/no-tty at one point, while your host-side OAuth/write path was confirmed healthy.
- `npm install` from registry failed in-session due DNS/network (`ENOTFOUND registry.npmjs.org`).

---

## 4) Investigation Timeline (Detailed)

## 4.1 Candidate workflow verification

### Code locations reviewed
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/bot/telegram-callback-server.js`
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/scripts/build-ig-candidates.js`
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/scripts/flash-mcp.sh`

### Verified handler mappings
- `/candidates_build` executes `node scripts/build-ig-candidates.js <ref>` and resets candidate review state.
- `/candidates_top` reads `data/ig-candidates.json`, applies optional tier/limit filtering, emits ranked chat lines.
- `/candidates_source` reads source metadata from candidate doc.
- `/pipeline_health` runs external checks via script command calls.
- `/debug/queue` returns queued jobs + approval history (important for read-tool seams).

---

## 4.2 FlashAPI failure diagnosis

### Reproduced failures
- `node scripts/build-ig-candidates.js snoobz 25`
  - failed with `Could not parse user-id response as JSON. Raw output:`
- `node scripts/build-ig-candidates.js 10 25`
  - failed with `Could not parse followers response as JSON. Raw output:`

### Deep trace command requested and executed
- `bash -x ./scripts/flash-mcp.sh user-id snoobz 2>&1 | tee /tmp/flash-mcp-debug.log`

Observed trace reached:
- `mcporter --config ... call flashapi.User_ID user=snoobz`

But no payload printed after this in sandbox path.

### Key determination
- `RAPIDAPI_KEY` **was present** in environment (from `.env` sourcing), so this was not a simple missing-key path.
- The call path could return **empty output with exit 0**, causing downstream JSON parse failures.

---

## 4.3 DNS/process diagnostics requested by user

Commands were run and reported. Notable results:
- With escalation, `nslookup flashapi1.p.rapidapi.com` resolved to 3 IPs.
- `nslookup google.com` resolved.
- `ping` and `scutil` were not available in this tool runtime (`command not found`).
- `/etc/resolv.conf` showed nameservers including `100.100.100.100` (Tailscale DNS).

Result: runtime/path differences were confirmed, mechanism not fully reduced to one low-level root cause inside this session.

---

## 4.4 Empirical MCP model verification

### Evidence gathered
- `mcporter config add --help` shows support for:
  - `--url <https://host>`
  - `--transport <http|sse|stdio>`
- `mcporter call --help` shows:
  - `--http-url <url>` ad-hoc calls
  - stdio spawn options (`--stdio`, `--stdio-arg`, `--env`, `--cwd`)
- Existing `config/mcporter.json` for flash/ig looter uses stdio spawn of `npx mcp-remote ...`.
- OpenClaw config/logs confirmed ACP backend process (`acpx`) registered/ready repeatedly in gateway logs.

### Architectural conclusion used
- Persistent daemon model is compatible if exposed over HTTP/SSE.
- STDIO is spawn-oriented and not suitable for "attach to already-running daemon" behavior.

---

## 4.5 Empirical API call contrast (critical gating evidence)

### Sandbox-path behavior
- `./scripts/flash-mcp.sh user-id instagram`
  - exit 0, no output (prior to hardening)

### Host-path (escalated) behavior
- Same command returned valid JSON:

```json
{
  "id": 25025320,
  "status": "ok"
}
```

This host success was used as operational validation for daemon-side architecture.

---

## 5) Implemented Fixes and Code Changes

## 5.1 Hardened wrapper behavior in `flash-mcp.sh`

File modified:
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/scripts/flash-mcp.sh`

### What changed
- Added `mcp_call()` wrapper for all `mcporter call` paths.
- New behavior:
  - nonzero mcporter exit => stderr surfaced + fail
  - zero exit + empty output => explicit diagnostic + exit code `70`

### Why
- Eliminates silent success/no-payload mode that broke candidate scripts with opaque parse errors.

### Validation
- Sandbox run now fails loudly with explicit reason + key-presence note.
- Host-path still returns valid JSON.

---

## 5.2 MCP skeleton server created

File added:
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/bot/mcp-server.js`

File modified:
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/package.json`
  - added `"mcp:server": "node bot/mcp-server.js"`

### Server properties
- Port default: `8789`
- Endpoint: `POST /mcp`
- Health: `GET /healthz`
- Transport: MCP SDK streamable HTTP transport
- Pattern: persistent daemon process

### Tool registration in skeleton (9)
1. `candidates_build`
2. `candidates_top`
3. `pipeline_health`
4. `candidates_source`
5. `candidates_from_comments`
6. `candidates_fuse`
7. `review_read_queue`
8. `review_read_history`
9. `review_read_pending`

### Handler behavior for now
- All are stubs returning structured error:

```json
{ "status": "error", "code": "NOT_IMPLEMENTED", "message": "core function pending" }
```

### Schema quality cleanup
- Added explicit `.describe(...)` text for input fields to clean discovery rendering/spacing.

### Syntax check
- `node --check bot/mcp-server.js` => passed.

---

## 6) Surface Area Decisions (Locked)

### Exposed via MCP
- Data ops: `candidates_build`, `candidates_from_comments`, `candidates_fuse`
- Read ops: `candidates_top`, `candidates_source`, `pipeline_health`
- Review reads: `review_read_queue`, `review_read_history`, `review_read_pending`

### Kept Telegram-only (for now)
- Story browser commands (`stories_*`)
- Approval/queue writes over MCP (deferred by design)

### Design rule locked
- "Both" means two thin frontends over one shared core function, no duplicated business logic.

---

## 7) Core Seam Signatures (Locked)

All signature contracts were designed/approved before implementation.

### Conventions locked
- Plain JavaScript + JSDoc (no TypeScript build pipeline introduced).
- Structured returns with discriminated `status`: `ok | degraded | error`.
- Read-side convention: empty valid result => `ok` with empty items.
- `degraded` reserved for partial/problem output cases.

### Dependency contract refinement
- Review reads switched from sqlite API-shape injection (`prepare().all()`) to flat adapter:
  - `runReadQuery(sql, params?) => rows`
- Keeps core decoupled from sqlite library internals.

### Approved function set
- `buildCandidates`
- `getCandidatesTop`
- `getPipelineHealth`
- `getCandidatesSource`
- `buildCandidatesFromComments`
- `buildCandidatesFused`
- `readReviewQueue`
- `readReviewHistory`
- `readReviewPending`

---

## 8) Mapping of Review Reads to Existing Code/Schema

### Existing code paths confirmed
- Pending review:
  - `getPendingCandidates()` in `telegram-callback-server.js`
- Queue/history:
  - `GET /debug/queue` query pair in `telegram-callback-server.js`

### Existing schema confirmed
- `db/schema.sql` includes:
  - `candidates`
  - `approvals`
  - `like_jobs`

No new table/model required for these MCP read tools.

---

## 9) Migration Plan (Proposed, Not Yet Executed)

One PR-sized migration per command, each including:
- extract command logic to `core/`
- Telegram handler switches to core call
- MCP handler switches from stub to same core call
- verification for both paths before next command

### Proposed order (risk-minimized)
1. `candidates_top`
2. `candidates_source`
3. `review_read_pending`
4. `review_read_queue`
5. `review_read_history`
6. `pipeline_health`
7. `candidates_build`
8. `candidates_from_comments`
9. `candidates_fuse`

### First-migration verification checklist drafted
For migration #1 (`candidates_top`):
- Telegram `/candidates_top` and `/candidates_top C 5` output text remains identical to pre-refactor.
- MCP `candidates_top` returns schema-valid structured output with matching row order/content.
- Cross-path parity: same candidate file => same ranked items.
- No new side effects introduced.

---

## 10) Commands / Evidence Highlights

Representative commands executed during this work:
- `bash -x ./scripts/flash-mcp.sh user-id snoobz`
- `node scripts/build-ig-candidates.js snoobz 25`
- `node scripts/build-ig-candidates.js 10 25`
- `mcporter --config ... list flashapi --schema`
- `mcporter --config ... --log-level debug call ...`
- `nslookup flashapi1.p.rapidapi.com`
- `./scripts/flash-mcp.sh user-id instagram` (sandbox and escalated variants)
- `node --check bot/mcp-server.js`

Observed patterns:
- Empty output mode from sandbox-path mcporter call (now hardened in wrapper).
- Host-path command returned valid JSON.
- MCP skeleton validated by user as working end-to-end in host environment.

---

## 11) Files Touched in This Effort

### Added
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/bot/mcp-server.js`
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/MCP-MIGRATION-AUDIT-2026-05-01.md`

### Modified
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/scripts/flash-mcp.sh`
- `/Users/austincaddell/.openclaw/workspace/ig-approval-automation/package.json`

---

## 12) Open Items / Deferred Decisions

- Approval write MCP surface remains deferred by your instruction.
- Unified status/error code constants object is parked for later cleanup.
- Data-op core implementations (`candidates_build`, `candidates_from_comments`, `candidates_fuse`) not yet wired.

---

## 13) Ready-to-Execute Next Action

Start migration PR #1 (`candidates_top`) with parity verification across:
- Telegram command path
- MCP tool path

Then proceed sequentially through the approved migration order.


## Update: Migration #1 MCP validation pitfall (2026-05-01)
- Observed: MCP SDK 1.29.0 + Zod 4.4.1 failed on `candidates_top` when handler returned both `structuredContent` and `content`.
- Error: `Cannot read properties of undefined (reading '_zod')`.
- Minimal fix applied: return `structuredContent` only for `candidates_top` handler.
- Result: MCP `candidates_top` calls return `status: 'ok'` again.
- Operational note for future migrations: until root cause is isolated, use `structuredContent`-only returns on core-wired MCP handlers.
