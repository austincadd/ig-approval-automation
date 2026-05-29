import { ingestTelegramPostLinks } from '../core/telegram-intake.js';

export function registerTelegramMessageIntake({
  bot,
  db,
  chatId,
  isAuthorizedActor,
  getCandidateForReview,
  sendReviewCard,
  ingestPostLinks = ingestTelegramPostLinks
}) {
  bot.on('message', async (msg) => {
    try {
      if (!isAuthorizedActor({ chatIdValue: msg.chat?.id, userIdValue: msg.from?.id })) return;

      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (text.startsWith('/')) return;

      const intake = ingestPostLinks(db, msg, {
        actor: `telegram:${msg.from?.username || msg.from?.id || 'unknown'}`,
        source: 'telegram'
      });
      if (intake.status !== 'ok' || !intake.items.length) return;

      const summaryLines = [];
      let sentCards = 0;

      for (const item of intake.items) {
        if (item.decision) {
          summaryLines.push(`${item.created ? 'Captured' : 'Known'} candidate ${item.candidateId}: already ${item.decision}.`);
          continue;
        }
        if (item.hasOpenReviewCard) {
          summaryLines.push(`${item.created ? 'Captured' : 'Known'} candidate ${item.candidateId}: already pending review.`);
          continue;
        }

        const candidate = getCandidateForReview(item.candidateId);
        if (!candidate) {
          summaryLines.push(`Captured ${item.postUrl}, but candidate lookup failed.`);
          continue;
        }

        await sendReviewCard(candidate, msg.chat.id);
        sentCards += 1;
        summaryLines.push(`${item.created ? 'Captured' : 'Reused'} candidate ${item.candidateId}: review card sent.`);
      }

      if (summaryLines.length !== 1 || sentCards === 0) {
        await bot.sendMessage(chatId, summaryLines.join('\n'));
      }
    } catch (err) {
      console.error('[telegram] raw_link_intake_failed', err?.message || err);
      await bot.sendMessage(chatId, `Raw-link intake failed: ${err?.message || err}`).catch(() => {});
    }
  });
}
