/**
 * Recognises "Redis is unreachable or refusing writes" errors as ioredis surfaces them on
 * commands: offline (queue disabled), connection closed, command timeout, retries exhausted, and
 * server replies for maxmemory (`noeviction`) or a loading dataset. Deliberately narrow — a
 * generic ECONNREFUSED from elsewhere stays a 500. Callers decide the policy: public emergency
 * paths fail open, authentication/security paths fail closed (503).
 */
const UNAVAILABLE =
  /^(Connection is closed|Stream isn't writeable|Command timed out|Reached the max retries)/;
const REPLY_UNAVAILABLE = /^(OOM command not allowed|LOADING )/;

export function isRedisUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'MaxRetriesPerRequestError') return true;
  if (err.name === 'ReplyError') return REPLY_UNAVAILABLE.test(err.message);
  return UNAVAILABLE.test(err.message);
}
