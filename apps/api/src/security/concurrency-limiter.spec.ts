import { ConcurrencyLimitExceeded, ConcurrencyLimiter } from './concurrency-limiter';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('ConcurrencyLimiter', () => {
  it('caps concurrency and runs waiting work in FIFO order', async () => {
    const limiter = new ConcurrencyLimiter(1, 10);
    const order: number[] = [];
    const gate = deferred();
    const first = limiter.run(
      async () => {
        await gate.promise;
        order.push(1);
      },
      { bounded: true },
    );
    const second = limiter.run(async () => void order.push(2), { bounded: true });
    const third = limiter.run(async () => void order.push(3), { bounded: true });
    expect(limiter.running).toBe(1);
    expect(limiter.queued).toBe(2);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
    expect(limiter.running).toBe(0);
  });

  it('refuses bounded callers when the queue is full; background callers still wait', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    const gate = deferred();
    const busy = limiter.run(() => gate.promise, { bounded: true });
    const queued = limiter.run(async () => 'queued', { bounded: true });
    await expect(limiter.run(async () => 'x', { bounded: true })).rejects.toBeInstanceOf(
      ConcurrencyLimitExceeded,
    );
    const background = limiter.run(async () => 'background', { bounded: false });
    gate.resolve();
    await expect(Promise.all([busy, queued, background])).resolves.toEqual([
      undefined,
      'queued',
      'background',
    ]);
  });

  it('releases the slot when the work throws', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    await expect(
      limiter.run(() => Promise.reject(new Error('boom')), { bounded: true }),
    ).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'ok', { bounded: true })).resolves.toBe('ok');
    expect(limiter.running).toBe(0);
  });
});
