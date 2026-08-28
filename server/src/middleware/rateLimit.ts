import type { Request, Response, NextFunction } from 'express';

type Window = { count: number; resetAt: number };

/**
 * Fixed-window rate limiter.
 *
 * In-process on purpose: the deployment runs a single instance, and a shared
 * store (Redis) would be the first thing to add if that changes. Documented
 * rather than silently assumed, because a per-instance limiter behind several
 * instances multiplies the real limit by the instance count.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
  message: string;
}) {
  const { windowMs, max, key, message } = options;
  const windows = new Map<string, Window>();

  // Windows are only cleared when their owner comes back, so sweep the
  // stragglers rather than growing the map for every visitor ever seen.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, window] of windows) {
      if (window.resetAt <= now) windows.delete(id);
    }
  }, 60_000);
  sweep.unref();

  return function limit(req: Request, res: Response, next: NextFunction): void {
    const id = key(req);
    const now = Date.now();
    const existing = windows.get(id);

    if (!existing || existing.resetAt <= now) {
      windows.set(id, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (existing.count >= max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message, retryAfter });
      return;
    }

    existing.count++;
    next();
  };
}

/** Rate-limit key for an authenticated route. */
export const byUser = (req: Request): string => req.userId ?? clientIp(req);

/** Rate-limit key for an unauthenticated route. */
export function clientIp(req: Request): string {
  // req.ip honours `trust proxy`, which is enabled in production.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
