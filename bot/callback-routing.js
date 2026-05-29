export function registerCallbackHandlers({
  app,
  bot,
  isAuthorizedActor,
  isAuthorizedControlRequest,
  rejectUnauthorizedControlRequest,
  isValidCallbackAction,
  handleAction
}) {
  bot.on('callback_query', async (query) => {
    try {
      if (!isAuthorizedActor({ chatIdValue: query.message?.chat?.id, userIdValue: query.from?.id })) {
        await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
        return;
      }
      if (!isValidCallbackAction(query.data)) {
        await bot.answerCallbackQuery(query.id, { text: 'Invalid action' });
        return;
      }
      const result = await handleAction(query.data, query.from?.username || 'unknown');
      await bot.answerCallbackQuery(query.id, { text: result?.callbackText || 'Recorded' });
    } catch (error) {
      await bot.answerCallbackQuery(query.id, { text: 'Error' }).catch(() => {});
      console.error('[telegram] callback_query_failed', error?.message || error);
    }
  });

  app.post('/telegram/callback', async (req, res) => {
    if (!isAuthorizedControlRequest(req)) return rejectUnauthorizedControlRequest(req, res);

    const callbackQuery = req.body?.callback_query;
    const data = callbackQuery?.data;
    const user = callbackQuery?.from?.username || 'unknown';
    const userIdValue = callbackQuery?.from?.id;
    const messageChatId = callbackQuery?.message?.chat?.id;

    if (!isAuthorizedActor({ chatIdValue: messageChatId, userIdValue })) {
      return res.status(403).json({ ok: false, error: 'unauthorized_actor' });
    }
    if (!isValidCallbackAction(data)) {
      return res.status(400).json({ ok: false, error: 'invalid_callback_action' });
    }

    const result = await handleAction(data, user);
    res.status(200).json({ ok: true, result });
  });
}
