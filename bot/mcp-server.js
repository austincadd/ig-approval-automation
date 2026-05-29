#!/usr/bin/env node
/**
 * IG Approval MCP Server Skeleton (HTTP transport, persistent daemon)
 *
 * Start:
 *   node bot/mcp-server.js
 *
 * Register with mcporter/OpenClaw (project-scoped):
 *   mcporter config add ig-approval-mcp --url http://127.0.0.1:8789/mcp --transport http --scope project
 *
 * Then verify tool discovery:
 *   mcporter --config ./config/mcporter.json list ig-approval-mcp --schema
 */

import * as z from 'zod/v4';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { buildCandidates, buildCandidatesFromComments, buildCandidatesFused, getCandidatesSource, getCandidatesTop } from '../core/candidates.js';
import { readReviewPending, readReviewQueue, readReviewHistory } from '../core/review.js';
import { getPipelineHealth } from '../core/pipeline.js';
import { runCommand } from '../core/command-runner.js';
import { getOperatorAutomationStatus } from '../core/automation-status.js';

const PORT = Number(process.env.IG_APPROVAL_MCP_PORT || 8789);
const HOST = String(process.env.IG_APPROVAL_MCP_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
const AUTH_HEADER = String(process.env.IG_APPROVAL_MCP_AUTH_HEADER || 'x-ig-approval-mcp-token').trim().toLowerCase();
const AUTH_TOKEN = String(process.env.IG_APPROVAL_MCP_AUTH_TOKEN || '').trim();
const TRUST_LOCAL_NO_AUTH = /^(1|true|yes|on)$/i.test(String(process.env.IG_APPROVAL_MCP_TRUST_LOCAL_NO_AUTH || ''));
const db = new Database(path.resolve('data/ig_automation.db'));
const repoCwd = path.resolve('.');

function runRepoCommand(cmd, args, timeout = 90000) {
  return runCommand(cmd, args, { cwd: repoCwd, encoding: 'utf8', timeout });
}

function notImplemented(message = 'core function pending') {
  return {
    status: 'error',
    code: 'NOT_IMPLEMENTED',
    message
  };
}

function normalizeLongRunTimeout(result, suggestedMs = 120000) {
  if (!result || result.status !== 'error' || result.code !== 'BUILD_FAILED') return result;
  const detail = String(result.detail || '');
  if (!/ETIMEDOUT|timed out|spawnSync .*ETIMEDOUT/i.test(detail)) return result;
  return {
    ...result,
    code: 'CLIENT_TIMEOUT_TOO_LOW',
    message: `This operation is long-running; set client timeout >= ${suggestedMs}ms`,
    detail
  };
}

function requestIsLoopback(req) {
  const remote = String(req.ip || req.socket?.remoteAddress || '').trim();
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function isAuthorizedMcpRequest(req) {
  if (TRUST_LOCAL_NO_AUTH && requestIsLoopback(req)) return { ok: true, mode: 'trusted-local' };
  if (!AUTH_TOKEN) return { ok: false, code: 'MCP_AUTH_TOKEN_REQUIRED', message: 'MCP auth token is not configured' };

  const presented = String(req.get(AUTH_HEADER) || '').trim();
  if (!presented || presented !== AUTH_TOKEN) {
    return {
      ok: false,
      code: 'UNAUTHORIZED',
      message: `Missing or invalid ${AUTH_HEADER} header`
    };
  }

  return { ok: true, mode: 'token' };
}

const StatusSchema = z.enum(['ok', 'degraded', 'error']);
const ErrorResultSchema = z.object({
  status: z.literal('error'),
  code: z.string(),
  message: z.string(),
  detail: z.string().optional()
});

const TierSchema = z.enum(['A', 'B', 'C']);
const TierCountsSchema = z.object({
  A: z.number(),
  B: z.number(),
  C: z.number()
});

const CandidatesTopItemSchema = z.object({
  rank: z.number(),
  key: z.string(),
  username: z.string(),
  tier: z.string(),
  likeTier: z.string(),
  commentTier: z.string(),
  score: z.number()
});

const ReviewQueueItemSchema = z.object({
  jobId: z.number(),
  candidateId: z.number(),
  status: z.string(),
  postUrl: z.string(),
  createdAt: z.string()
});

const ReviewHistoryItemSchema = z.object({
  approvalId: z.number(),
  candidateId: z.number(),
  decision: z.enum(['approved', 'skipped']),
  decidedBy: z.string(),
  decidedAt: z.string()
});

const ReviewPendingItemSchema = z.object({
  candidateId: z.number(),
  postUrl: z.string()
});

const OperatorProcessSchema = z.object({
  configured: z.boolean(),
  health: z.string(),
  pid: z.number().nullable(),
  alive: z.boolean(),
  detail: z.string().nullable().optional()
});

const RecentTerminalFailureSchema = z.object({
  eventId: z.number(),
  jobId: z.number().nullable(),
  candidateId: z.number().nullable(),
  eventType: z.enum(['job_failed', 'job_blocked']),
  createdAt: z.string(),
  postUrl: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  failureClass: z.string().nullable().optional(),
  failurePolicy: z.string().nullable().optional(),
  evidenceBundlePath: z.string().nullable().optional()
});

const server = new McpServer(
  {
    name: 'ig-approval-mcp',
    version: '0.1.0'
  },
  {
    capabilities: { logging: {} }
  }
);

server.registerTool(
  'candidates_build',
  {
    description: 'Build candidates from username/user id seed. Long-running (70-85s typical): callers should set timeout >= 120000ms.',
    inputSchema: {
      ref: z.string().describe('Username or numeric user ID seed'),
      limit: z.number().int().positive().optional().describe('Maximum candidates to build')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        ref: z.string(),
        limit: z.number(),
        generatedFile: z.string(),
        count: z.number(),
        source: z.string(),
        stateReset: z.boolean()
      }),
      z.object({
        status: z.literal('degraded'),
        ref: z.string(),
        limit: z.number(),
        generatedFile: z.string(),
        stateReset: z.boolean(),
        reason: z.enum(['RESULT_UNREADABLE', 'RESULT_MISSING']),
        detail: z.string()
      }),
      ErrorResultSchema.extend({
        ref: z.string(),
        limit: z.number()
      })
    ])
  },
  async ({ ref, limit }) => {
    const result = await buildCandidates(
      { ref, limit },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 90000),
        resetState: () => {
          db.prepare(`DELETE FROM candidate_review_labels`).run();
          db.prepare(`UPDATE system_flags SET value='0', updated_at=datetime('now') WHERE key='CANDIDATE_REVIEW_INDEX'`).run();
        },
        candidatesFile: new URL('../data/ig-candidates.json', import.meta.url).pathname,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    );
    return { structuredContent: normalizeLongRunTimeout(result, 120000) };
  }
);

server.registerTool(
  'candidates_top',
  {
    description: 'Return top ranked candidates from current candidates document.',
    inputSchema: {
      tier: TierSchema.optional().describe('Optional tier filter: A, B, or C'),
      limit: z.number().int().positive().optional().describe('Maximum rows to return')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        limit: z.number(),
        tierFilter: z.string().nullable(),
        total: z.number(),
        filteredTotal: z.number(),
        items: z.array(CandidatesTopItemSchema)
      }),
      z.object({
        status: z.literal('degraded'),
        limit: z.number(),
        tierFilter: z.string().nullable(),
        reason: z.string(),
        detail: z.string(),
        total: z.number(),
        filteredTotal: z.number(),
        items: z.array(CandidatesTopItemSchema)
      }),
      ErrorResultSchema
    ])
  },
  async ({ tier, limit }) => {
    const result = getCandidatesTop(
      { tier, limit },
      {
        candidatesFile: new URL('../data/ig-candidates.json', import.meta.url).pathname,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    );
    return { structuredContent: result };
  }
);

server.registerTool(
  'pipeline_health',
  {
    description: 'Run read-only provider checks for candidate pipeline health.',
    inputSchema: {
      seedUsername: z.string().describe('Username seed for provider health checks')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        seedUsername: z.string(),
        checks: z.array(
          z.object({
            check: z.enum(['flash_user_posts_username', 'ig_looter_search_users']),
            status: z.enum(['ok', 'fail']),
            summary: z.string()
          })
        )
      }),
      z.object({
        status: z.literal('degraded'),
        seedUsername: z.string(),
        checks: z.array(
          z.object({
            check: z.enum(['flash_user_posts_username', 'ig_looter_search_users']),
            status: z.enum(['ok', 'fail']),
            summary: z.string()
          })
        ),
        reason: z.literal('PARTIAL_CHECK_FAILURE'),
        detail: z.string()
      }),
      ErrorResultSchema
    ])
  },
  async ({ seedUsername }) => {
    const result = await getPipelineHealth(
      { seedUsername },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 30000)
      }
    );
    return { structuredContent: result };
  }
);

server.registerTool(
  'candidates_source',
  {
    description: 'Read metadata/source details from current candidates document.',
    inputSchema: {},
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        data: z.object({
          inputRef: z.string().nullable(),
          sourceUserId: z.string().nullable(),
          sourceUsername: z.string().nullable(),
          candidateSource: z.string().nullable(),
          count: z.number(),
          tierCounts: TierCountsSchema.optional(),
          likeTierCounts: TierCountsSchema.optional(),
          commentTierCounts: TierCountsSchema.optional(),
          generatedAt: z.string().nullable()
        })
      }),
      z.object({
        status: z.literal('degraded'),
        reason: z.literal('MISSING_OPTIONAL_FIELDS'),
        detail: z.string(),
        data: z.object({
          inputRef: z.string().nullable(),
          sourceUserId: z.string().nullable(),
          sourceUsername: z.string().nullable(),
          candidateSource: z.string().nullable(),
          count: z.number(),
          generatedAt: z.string().nullable()
        })
      }),
      ErrorResultSchema
    ])
  },
  async () => {
    const result = getCandidatesSource(
      {},
      {
        candidatesFile: new URL('../data/ig-candidates.json', import.meta.url).pathname,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    );
    return { structuredContent: result };
  }
);

server.registerTool(
  'candidates_from_comments',
  {
    description: 'Build candidate set from recent post commenters. Long-running and currently upstream-fragile: callers should set timeout >= 120000ms.',
    inputSchema: {
      username: z.string().describe('Instagram username seed'),
      candidateLimit: z.number().int().positive().optional().describe('Maximum candidates to build'),
      postCount: z.number().int().positive().optional().describe('How many recent posts to inspect')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        username: z.string(),
        candidateLimit: z.number(),
        postCount: z.number(),
        stateReset: z.boolean(),
        generatedFile: z.string(),
        count: z.number(),
        source: z.string()
      }),
      z.object({
        status: z.literal('degraded'),
        username: z.string(),
        candidateLimit: z.number(),
        postCount: z.number(),
        stateReset: z.boolean(),
        generatedFile: z.string(),
        reason: z.enum(['RESULT_UNREADABLE', 'RESULT_MISSING']),
        detail: z.string()
      }),
      ErrorResultSchema.extend({
        username: z.string(),
        candidateLimit: z.number(),
        postCount: z.number()
      })
    ])
  },
  async ({ username, candidateLimit, postCount }) => {
    const result = await buildCandidatesFromComments(
      { username, candidateLimit, postCount },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 90000),
        resetState: () => {
          db.prepare(`DELETE FROM candidate_review_labels`).run();
          db.prepare(`UPDATE system_flags SET value='0', updated_at=datetime('now') WHERE key='CANDIDATE_REVIEW_INDEX'`).run();
        },
        candidatesFile: new URL('../data/ig-candidates.json', import.meta.url).pathname,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    );
    return { structuredContent: normalizeLongRunTimeout(result, 120000) };
  }
);

server.registerTool(
  'candidates_fuse',
  {
    description: 'Build fused candidate set from likes/comments/search sources. Long-running and currently upstream-fragile: callers should set timeout >= 120000ms.',
    inputSchema: {
      username: z.string().describe('Instagram username seed'),
      candidateLimit: z.number().int().positive().optional().describe('Maximum candidates to build'),
      postCount: z.number().int().positive().optional().describe('How many recent posts to inspect')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        username: z.string(),
        candidateLimit: z.number(),
        postCount: z.number(),
        stateReset: z.boolean(),
        generatedFile: z.string(),
        count: z.number(),
        source: z.string(),
        tierCounts: TierCountsSchema.optional(),
        likeTierCounts: TierCountsSchema.optional(),
        commentTierCounts: TierCountsSchema.optional()
      }),
      z.object({
        status: z.literal('degraded'),
        username: z.string(),
        candidateLimit: z.number(),
        postCount: z.number(),
        stateReset: z.boolean(),
        generatedFile: z.string(),
        reason: z.enum(['RESULT_UNREADABLE', 'RESULT_MISSING']),
        detail: z.string()
      }),
      ErrorResultSchema.extend({
        username: z.string(),
        candidateLimit: z.number(),
        postCount: z.number()
      })
    ])
  },
  async ({ username, candidateLimit, postCount }) => {
    const result = await buildCandidatesFused(
      { username, candidateLimit, postCount },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 90000),
        resetState: () => {
          db.prepare(`DELETE FROM candidate_review_labels`).run();
          db.prepare(`UPDATE system_flags SET value='0', updated_at=datetime('now') WHERE key='CANDIDATE_REVIEW_INDEX'`).run();
        },
        candidatesFile: new URL('../data/ig-candidates.json', import.meta.url).pathname,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    );
    return { structuredContent: normalizeLongRunTimeout(result, 120000) };
  }
);

server.registerTool(
  'review_read_queue',
  {
    description: 'Read queued like-jobs for approval workflow.',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Maximum queued jobs to return')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        limit: z.number(),
        items: z.array(ReviewQueueItemSchema)
      }),
      z.object({
        status: z.literal('degraded'),
        reason: z.literal('ROW_SHAPE_MISMATCH'),
        detail: z.string(),
        limit: z.number(),
        items: z.array(ReviewQueueItemSchema)
      }),
      ErrorResultSchema
    ])
  },
  async ({ limit }) => {
    const result = readReviewQueue(
      { limit },
      {
        runReadQuery: (sql, params = []) => db.prepare(sql).all(...params)
      }
    );
    return { structuredContent: result };
  }
);

server.registerTool(
  'review_read_history',
  {
    description: 'Read recent approval decisions history.',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Maximum history rows to return')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        limit: z.number(),
        items: z.array(ReviewHistoryItemSchema)
      }),
      z.object({
        status: z.literal('degraded'),
        reason: z.literal('ROW_SHAPE_MISMATCH'),
        detail: z.string(),
        limit: z.number(),
        items: z.array(ReviewHistoryItemSchema)
      }),
      ErrorResultSchema
    ])
  },
  async ({ limit }) => {
    const result = readReviewHistory(
      { limit },
      {
        runReadQuery: (sql, params = []) => db.prepare(sql).all(...params)
      }
    );
    return { structuredContent: result };
  }
);

server.registerTool(
  'review_read_pending',
  {
    description: 'Read pending candidates not yet approved/skipped.',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Maximum pending rows to return')
    },
    outputSchema: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ok'),
        limit: z.number(),
        items: z.array(ReviewPendingItemSchema)
      }),
      z.object({
        status: z.literal('degraded'),
        reason: z.literal('ROW_SHAPE_MISMATCH'),
        detail: z.string(),
        limit: z.number(),
        items: z.array(ReviewPendingItemSchema)
      }),
      ErrorResultSchema
    ])
  },
  async ({ limit }) => {
    const result = readReviewPending(
      { limit },
      {
        runReadQuery: (sql, params = []) => db.prepare(sql).all(...params)
      }
    );
    return { structuredContent: result };
  }
);

server.registerTool(
  'automation_status',
  {
    description: 'Read the authoritative operator health/status summary for the approval bot + worker.',
    inputSchema: {},
    outputSchema: z.object({
      status: z.literal('ok'),
      automationEnabled: z.boolean(),
      pendingApprovals: z.number(),
      approvedWithoutActive: z.number(),
      recoverySuppressedCount: z.number(),
      activeBlockerCount: z.number(),
      historicalBlockedCount: z.number(),
      counts: z.object({
        queued: z.number(),
        running: z.number(),
        success: z.number(),
        failed: z.number(),
        blocked: z.number(),
        stopped: z.number()
      }),
      bot: OperatorProcessSchema.extend({
        lockPath: z.string(),
        lockExists: z.boolean(),
        startedAt: z.string().nullable(),
        label: z.string().nullable(),
        bindHost: z.string().nullable(),
        cwd: z.string().nullable(),
        stale: z.boolean()
      }),
      worker: OperatorProcessSchema.extend({
        label: z.string().nullable(),
        loaded: z.boolean(),
        lastExitCode: z.number().nullable(),
        rawState: z.string().nullable(),
        lastStartedAt: z.string().nullable(),
        lastFinishedAt: z.string().nullable(),
        lastSuccessAt: z.string().nullable(),
        lastTerminalFailureAt: z.string().nullable(),
        lastRunningUpdateAt: z.string().nullable(),
        activeJob: z.object({
          jobId: z.number(),
          candidateId: z.number(),
          startedAt: z.string().nullable(),
          updatedAt: z.string().nullable()
        }).nullable(),
        stdoutLog: z.object({ path: z.string(), exists: z.boolean(), lastLine: z.string().nullable() }),
        stderrLog: z.object({ path: z.string(), exists: z.boolean(), lastLine: z.string().nullable() })
      }),
      telegramTransport: z.object({
        status: z.string(),
        restartAttempts: z.number(),
        duplicatePollerDetected: z.boolean(),
        sendFailures: z.number(),
        pollingErrors: z.number(),
        lastError: z.string().nullable(),
        updatedAt: z.string().nullable()
      }),
      health: z.object({
        state: z.string(),
        controlPlane: z.string(),
        executor: z.string(),
        delivery: z.string(),
        account: z.string(),
        queue: z.string(),
        canary: z.any().nullable()
      }),
      currentBlocked: z.array(z.any()),
      historicalBlocked: z.array(z.any()),
      recentTerminalFailures: z.array(RecentTerminalFailureSchema)
    })
  },
  async () => ({ structuredContent: getOperatorAutomationStatus(db) })
);

const app = createMcpExpressApp();

app.post('/mcp', async (req, res) => {
  const auth = isAuthorizedMcpRequest(req);
  if (!auth.ok) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: auth.message, data: { code: auth.code } },
      id: null
    });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close().catch(() => {});
    });
  } catch (error) {
    console.error('[mcp-server] request handling failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'ig-approval-mcp',
    host: HOST,
    port: PORT,
    auth: {
      header: AUTH_HEADER,
      required: !TRUST_LOCAL_NO_AUTH,
      trustedLocalNoAuth: TRUST_LOCAL_NO_AUTH,
      tokenConfigured: Boolean(AUTH_TOKEN)
    },
    status: StatusSchema.options
  });
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null
  });
});

app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error('[mcp-server] failed to start:', err);
    process.exit(1);
  }
  console.log(`[mcp-server] listening on http://${HOST}:${PORT}/mcp`);
});
