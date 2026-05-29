export function formatRecoverySummary(command, result) {
  const actionMap = {
    pause: result.changed ? 'Automation paused.' : 'Automation was already paused.',
    resume: result.changed ? 'Automation resumed.' : 'Automation was already running.',
    requeueBlocked: result.createdCount ? `Requeued ${result.createdCount} blocked candidate${result.createdCount === 1 ? '' : 's'}.` : 'No blocked candidates needed requeueing.',
    reconcileQueue: result.createdCount ? `Queued ${result.createdCount} approved candidate${result.createdCount === 1 ? '' : 's'} missing an active/success job.` : 'Queue already reconciled. No new jobs created.',
    inlinePause: result.changed ? 'Automation paused from review controls.' : 'Automation was already paused.'
  };

  const followUpMap = {
    pause: 'Use /resume_automation when you want the worker live again.',
    resume: 'If the worker LaunchAgent is loaded, it will pick up queued jobs automatically.',
    requeueBlocked: 'Use /automation_status to confirm queued vs blocked counts.',
    reconcileQueue: 'Use /automation_status to confirm queued vs approved-missing counts.',
    inlinePause: 'Use /resume_automation when you want the worker live again.'
  };

  const lines = [actionMap[command] || 'Recovery command completed.'];
  if (typeof result.automationEnabled === 'boolean') lines.push(`Automation: ${result.automationEnabled ? 'enabled' : 'paused'}`);
  if (typeof result.createdCount === 'number') lines.push(`Created jobs: ${result.createdCount}`);
  if (typeof result.skippedCount === 'number') lines.push(`Skipped: ${result.skippedCount}`);
  if (typeof result.approvedWithoutActive === 'number') {
    lines.push(`Approved missing active/success job: ${result.approvedWithoutActive}`);
    if (result.approvedWithoutActive > 0) {
      lines.push('Resume only re-enables the worker; missing jobs still need /reconcile_queue if they should be retried.');
    }
  }
  if (typeof result.recoverySuppressedCount === 'number') {
    lines.push(`Recovery-suppressed candidates: ${result.recoverySuppressedCount}`);
  }
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (followUpMap[command]) lines.push(followUpMap[command]);
  return lines.join('\n');
}
