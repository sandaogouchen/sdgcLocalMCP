/**
 * Simple async semaphore for concurrency limiting.
 *
 * Usage:
 *   const sem = new Semaphore(16);
 *   await sem.acquire();
 *   try { ... } finally { sem.release(); }
 *
 * This implementation is designed for Node.js single-threaded event loop and
 * is NOT safe across worker_threads.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`Semaphore capacity must be a positive integer, got: ${capacity}`);
    }
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Non-blocking acquire. Returns true on success, false when saturated.
   */
  tryAcquire(): boolean {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    return false;
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.available < this.capacity) {
      this.available += 1;
    }
  }

  get inFlight(): number {
    return this.capacity - this.available;
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  get maxConcurrency(): number {
    return this.capacity;
  }
}
