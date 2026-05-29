import { pauseAutomation } from '../core/recovery.js';
import { candidateCard } from './message-templates.js';
import { formatRecoverySummary } from './recovery-command-format.js';

export function createReviewCardService({ db, bot, chatId }) {
  function isValidCallbackAction(data) {
    if (data === 'pause_all') return true;
    const match = String(data || '').match(/^(approve|skip):(\d+)$/);
    if (!match) return false;
    const candidateId = Number(match[2]);
    return Number.isSafeInteger(candidateId) && candidateId > 0;
  }

  function closeOpenReviewCards(candidateId, status = 'resolved') {
    return db.prepare(`
      UPDATE review_card_messages
      SET status = ?, resolved_at = datetime('now')
      WHERE candidate_id = ? AND status = 'open'
    `).run(status, candidateId).changes;
  }

  function getOpenReviewCards(candidateId) {
    return db.prepare(`
      SELECT chat_id, message_id
      FROM review_card_messages
      WHERE candidate_id = ? AND status = 'open'
      ORDER BY id ASC
    `).all(candidateId);
  }

  function resolveAlreadyDecidedCards() {
    db.prepare(`
      UPDATE review_card_messages
      SET status = 'resolved', resolved_at = COALESCE(resolved_at, datetime('now'))
      WHERE status = 'open'
        AND EXISTS (
          SELECT 1 FROM approvals a WHERE a.candidate_id = review_card_messages.candidate_id
        )
    `).run();
  }

  function getPendingCandidatesForReviewPush() {
    resolveAlreadyDecidedCards();
    return db.prepare(`
      SELECT c.id, c.post_url
      FROM candidates c
      LEFT JOIN approvals a ON a.candidate_id = c.id
      LEFT JOIN review_card_messages r ON r.candidate_id = c.id AND r.status = 'open'
      WHERE a.id IS NULL
        AND r.id IS NULL
      ORDER BY c.created_at ASC, c.id ASC
    `).all();
  }

  function getCandidateForReview(candidateId) {
    return db.prepare('SELECT id, post_url FROM candidates WHERE id = ? LIMIT 1').get(candidateId);
  }

  async function sendReviewCard(candidate, targetChatId = chatId) {
    const sent = await bot.sendMessage(targetChatId, candidateCard(candidate), {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${candidate.id}` },
          { text: '❌ Skip', callback_data: `skip:${candidate.id}` },
          { text: '⏸ Pause', callback_data: 'pause_all' }
        ]]
      }
    });

    db.prepare(`
      INSERT OR IGNORE INTO review_card_messages(candidate_id, chat_id, message_id, status)
      VALUES (?, ?, ?, 'open')
    `).run(candidate.id, String(sent.chat.id), sent.message_id);

    return sent;
  }

  async function refreshReviewCardMessages(candidateId, decisionText) {
    const rows = db.prepare(`
      SELECT chat_id, message_id
      FROM review_card_messages
      WHERE candidate_id = ?
      ORDER BY id ASC
    `).all(candidateId);

    for (const row of rows) {
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: row.chat_id,
          message_id: row.message_id
        });
      } catch {}
      try {
        await bot.editMessageText(`${candidateCard({ id: candidateId, post_url: db.prepare('SELECT post_url FROM candidates WHERE id = ?').get(candidateId)?.post_url || '' })}\n\n${decisionText}`, {
          chat_id: row.chat_id,
          message_id: row.message_id
        });
      } catch {}
    }
  }

  async function sendReviewBatch() {
    const items = getPendingCandidatesForReviewPush();
    let sentCount = 0;
    for (const candidate of items) {
      await sendReviewCard(candidate, chatId);
      sentCount += 1;
    }
    return { sentCount };
  }

  async function handleAction(data, user = 'unknown') {
    if (!isValidCallbackAction(data)) return { callbackText: 'Invalid action' };

    if (data === 'pause_all') {
      const result = pauseAutomation(db, { actor: `telegram:${user}`, reason: 'inline_pause_all' });
      await bot.sendMessage(chatId, formatRecoverySummary('inlinePause', result));
      return { callbackText: result.changed ? 'Paused' : 'Already paused' };
    }

    const [action, idRaw] = data.split(':');
    const candidateId = Number(idRaw);
    if (!candidateId || !['approve', 'skip'].includes(action)) return { callbackText: 'Invalid action' };

    const decision = action === 'approve' ? 'approved' : 'skipped';

    const applyDecision = db.transaction((candidateIdArg, decisionArg, userArg) => {
      const existingApproval = db.prepare('SELECT id, decision FROM approvals WHERE candidate_id = ?').get(candidateIdArg);
      if (existingApproval) {
        closeOpenReviewCards(candidateIdArg, 'resolved');
        return {
          status: existingApproval.decision === decisionArg ? 'duplicate-decision' : 'conflict',
          existingDecision: existingApproval.decision
        };
      }

      db.prepare('INSERT INTO approvals(candidate_id, decision, decided_by) VALUES (?, ?, ?)').run(candidateIdArg, decisionArg, userArg);
      closeOpenReviewCards(candidateIdArg, 'resolved');

      if (decisionArg === 'approved') {
        const existingActiveJob = db.prepare("SELECT id, status FROM like_jobs WHERE candidate_id = ? AND status IN ('queued','running') LIMIT 1").get(candidateIdArg);
        if (existingActiveJob) {
          return {
            status: 'already-queued',
            existingDecision: decisionArg,
            jobId: existingActiveJob.id,
            jobStatus: existingActiveJob.status
          };
        }

        const job = db.prepare("INSERT INTO like_jobs(candidate_id, status) VALUES (?, 'queued')").run(candidateIdArg);
        return {
          status: 'approved-and-queued',
          jobId: job.lastInsertRowid
        };
      }

      return { status: 'skipped' };
    });

    const result = applyDecision(candidateId, decision, user);
    const decisionText = result.status === 'conflict' || result.status === 'duplicate-decision'
      ? `Already decided: ${result.existingDecision}.`
      : `Decision recorded: ${decision}.`;
    await refreshReviewCardMessages(candidateId, decisionText);

    if (result.status === 'approved-and-queued') {
      await bot.sendMessage(chatId, `Approved candidate ${candidateId} -> queued.`);
      return { callbackText: 'Approved + queued' };
    }
    if (result.status === 'skipped') {
      await bot.sendMessage(chatId, `Skipped candidate ${candidateId}.`);
      return { callbackText: 'Skipped' };
    }
    if (result.status === 'already-queued') {
      await bot.sendMessage(chatId, `Candidate ${candidateId} already has an active job (${result.jobStatus}).`);
      return { callbackText: 'Already queued' };
    }
    if (result.status === 'duplicate-decision') {
      await bot.sendMessage(chatId, `Candidate ${candidateId} was already ${result.existingDecision}.`);
      return { callbackText: `Already ${result.existingDecision}` };
    }
    if (result.status === 'conflict') {
      await bot.sendMessage(chatId, `Candidate ${candidateId} already has decision: ${result.existingDecision}.`);
      return { callbackText: `Already ${result.existingDecision}` };
    }

    return { callbackText: 'Recorded' };
  }

  return {
    closeOpenReviewCards,
    getOpenReviewCards,
    getPendingCandidatesForReviewPush,
    getCandidateForReview,
    handleAction,
    isValidCallbackAction,
    refreshReviewCardMessages,
    resolveAlreadyDecidedCards,
    sendReviewBatch,
    sendReviewCard
  };
}
