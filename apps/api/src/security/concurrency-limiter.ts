/**
 * Small FIFO semaphore. `run(fn, { bounded: true })` rejects immediately with
 * `ConcurrencyLimitExceeded` when `maxQueue` callers are already waiting; unbounded callers
 * (background work) always wait their turn.
 */
export class ConcurrencyLimitExceeded extends Error {
  constructor() {
    super('Concurrency limit exceeded');
    this.name = 'ConcurrencyLimitExceeded';
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  get queued(): number {
    return this.waiting.length;
  }

  get running(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>, opts: { bounded: boolean }): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (opts.bounded && this.waiting.length >= this.maxQueue)
        throw new ConcurrencyLimitExceeded();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // hand the slot over directly (active count unchanged)
      else this.active--;
    }
  }
}
