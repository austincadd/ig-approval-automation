import crypto from 'node:crypto';

function normalizeToken(value) {
  return String(value || '').trim();
}

function timingSafeTokenEqual(left, right) {
  const a = Buffer.from(normalizeToken(left));
  const b = Buffer.from(normalizeToken(right));
  if (!a.length || !b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createControlPlaneAuth({ chatId, controlToken, bindHost = '127.0.0.1' }) {
  const normalizedBindHost = String(bindHost || '127.0.0.1').trim() || '127.0.0.1';

  function requireAuthorizedChat(chatIdValue) {
    return String(chatIdValue) === String(chatId);
  }

  function requireAuthorizedUser(userIdValue) {
    return userIdValue == null || String(userIdValue) === String(chatId);
  }

  function isAuthorizedActor({ chatIdValue, userIdValue }) {
    return requireAuthorizedChat(chatIdValue) && requireAuthorizedUser(userIdValue);
  }

  function getRemoteAddress(req) {
    return req.socket?.remoteAddress || req.ip || '';
  }

  function isLoopbackAddress(value) {
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
  }

  function isLoopbackBoundServer() {
    return isLoopbackAddress(normalizedBindHost) || normalizedBindHost === 'localhost';
  }

  function hasValidControlToken(req) {
    const configuredToken = normalizeToken(controlToken);
    if (!configuredToken) return false;
    const headerToken = normalizeToken(req.get('x-telegram-control-token'));
    return timingSafeTokenEqual(headerToken, configuredToken);
  }

  function isAuthorizedControlRequest(req) {
    if (isLoopbackBoundServer() && isLoopbackAddress(getRemoteAddress(req))) return true;
    return hasValidControlToken(req);
  }

  function rejectUnauthorizedControlRequest(_req, res) {
    res.status(403).json({ ok: false, error: 'forbidden' });
  }

  return {
    bindHost: normalizedBindHost,
    requireAuthorizedChat,
    requireAuthorizedUser,
    isAuthorizedActor,
    isAuthorizedControlRequest,
    rejectUnauthorizedControlRequest
  };
}
