const BASE_DELAY_MS = 3000;
const MAX_DELAY_MS = 60_000;

export const isRateLimited = status => status === 429 || status === 503;

export function retryDelayMs(attempt, retryAfter, now = Date.now(), random = Math.random) {
  const header = String(retryAfter ?? '').trim();
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(ms) && ms >= 0) return Math.min(MAX_DELAY_MS, Math.round(ms));
  }
  const backoff = BASE_DELAY_MS * 2 ** attempt;
  return Math.min(MAX_DELAY_MS, Math.round(backoff + random() * 1000));
}
