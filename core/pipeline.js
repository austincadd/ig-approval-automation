/**
 * @typedef {{seedUsername:string}} PipelineHealthInput
 * @typedef {{check:'flash_user_posts_username'|'ig_looter_search_users', status:'ok'|'fail', summary:string}} PipelineCheck
 * @typedef {{runCommand:(cmd:string,args:string[])=>({stdout:string}|Promise<{stdout:string}> )}} PipelineDeps
 */

/**
 * @param {PipelineHealthInput} input
 * @param {PipelineDeps} deps
 */
export async function getPipelineHealth(input = {}, deps) {
  if (typeof deps?.runCommand !== 'function') {
    return { status: 'error', code: 'INVALID_DEPS', message: 'runCommand dependency is required' };
  }

  const seedUsername = String(input.seedUsername || 'instagram').trim() || 'instagram';
  /** @type {PipelineCheck[]} */
  const checks = [];

  const run = async (check, cmd, args, label) => {
    try {
      const out = await deps.runCommand(cmd, args);
      const txt = String(out?.stdout ?? '').trim();
      if (!txt) {
        checks.push({ check, status: 'fail', summary: `${label}: EMPTY_STDOUT` });
        return;
      }
      checks.push({ check, status: 'ok', summary: `${label}: ${txt.replace(/\n/g, ' ')}` });
    } catch (err) {
      checks.push({ check, status: 'fail', summary: `${label}: FAIL` });
    }
  };

  await run('flash_user_posts_username', 'bash', ['-lc', `scripts/flash-mcp.sh user-posts-username ${seedUsername} | head -n 2`], 'flash user-posts-username');
  await run('ig_looter_search_users', 'bash', ['-lc', `scripts/ig-mcp.sh search-users ${seedUsername} users | head -n 2`], 'ig-looter search-users');

  const failed = checks.filter((c) => c.status === 'fail');
  if (!failed.length) return { status: 'ok', seedUsername, checks };
  return {
    status: 'degraded',
    seedUsername,
    checks,
    reason: 'PARTIAL_CHECK_FAILURE',
    detail: failed.map((f) => f.summary).join(' | ')
  };
}
