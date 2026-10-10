import { isRedisUnavailableError } from './redis-errors';

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe('isRedisUnavailableError', () => {
  it.each([
    new Error("Stream isn't writeable and enableOfflineQueue options is false"),
    new Error('Connection is closed.'),
    new Error('Command timed out'),
    named('MaxRetriesPerRequestError', 'Reached the max retries per request limit (which is 2).'),
    named('ReplyError', "OOM command not allowed when used memory > 'maxmemory'."),
    named('ReplyError', 'LOADING Redis is loading the dataset in memory'),
  ])('recognises %s', (err) => expect(isRedisUnavailableError(err)).toBe(true));

  it.each([
    new Error('connect ECONNREFUSED 10.0.0.5:5432'),
    named('ReplyError', 'WRONGTYPE Operation against a key holding the wrong kind of value'),
    new Error('Something else'),
    'string error',
    null,
  ])('ignores %s', (err) => expect(isRedisUnavailableError(err)).toBe(false));
});
