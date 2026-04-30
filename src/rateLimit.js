export function rateLimitDecision(state, key, now = Date.now(), { windowMs = 60_000, max = 60 } = {}) {
  const safeKey = String(key || 'unknown');
  const current = Number(now) || Date.now();
  const windowSize = Math.max(Number(windowMs) || 60_000, 1);
  const limit = Math.max(Number(max) || 60, 1);
  const existing = state.get(safeKey);

  if (!existing || current >= existing.resetAt) {
    const bucket = { count: 1, resetAt: current + windowSize };
    state.set(safeKey, bucket);
    return { allowed: true, remaining: limit - 1, resetAt: bucket.resetAt, count: bucket.count };
  }

  existing.count += 1;
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(limit - existing.count, 0),
    resetAt: existing.resetAt,
    count: existing.count
  };
}

export function createIpRateLimiter({ windowMs = 60_000, max = 60, keyPrefix = 'ip' } = {}) {
  const state = new Map();

  return function ipRateLimiter(req, res, next) {
    const key = `${keyPrefix}:${req.ip || req.get?.('cf-connecting-ip') || req.get?.('x-forwarded-for') || 'unknown'}`;
    const decision = rateLimitDecision(state, key, Date.now(), { windowMs, max });
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));

    if (!decision.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Too many upload log events, please retry later',
        retryAfterMs: Math.max(decision.resetAt - Date.now(), 0)
      });
    }

    return next();
  };
}
