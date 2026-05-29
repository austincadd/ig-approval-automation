import {
  buildTelegramResultNotificationBatches,
  initializeTelegramResultCursor,
  readTelegramResultCursor,
  readTelegramResultEvents,
  writeTelegramResultCursor
} from '../core/telegram-result-reporting.js';

export function createTelegramResultReporter({ db, safeSendMessage, writeTransportHealth, pollMs = 5000 }) {
  let timer = null;
  let inFlight = false;

  async function pollAndReportJobResults() {
    if (inFlight) return;
    inFlight = true;
    try {
      const existingCursor = readTelegramResultCursor(db);
      if (existingCursor === null) {
        initializeTelegramResultCursor(db);
        return;
      }

      const events = readTelegramResultEvents(db, { afterId: existingCursor, limit: 10 });
      if (!events.length) return;

      const batches = buildTelegramResultNotificationBatches(events);
      if (!batches.length) return;

      for (const batch of batches) {
        const ok = await safeSendMessage(batch.message);
        if (!ok) break;
        writeTelegramResultCursor(db, batch.lastEventId);
      }
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void pollAndReportJobResults().catch((err) => {
        writeTransportHealth({ status: 'degraded', lastError: err?.message || String(err) });
        console.error('[telegram] result_report_failed', err?.message || err);
      });
    }, pollMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    pollAndReportJobResults
  };
}
