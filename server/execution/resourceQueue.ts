import { cancellationError, waitForAbortable, throwIfAborted } from "./cancellation.js";

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>, signal?: AbortSignal) {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tail = previous.then(() => current);

    return (async () => {
      try {
        await waitForAbortable(previous, signal);
        throwIfAborted(signal);
        return await task();
      } finally {
        release();
      }
    })();
  }
}

interface PendingTask<T> {
  task: () => Promise<T>;
  signal?: AbortSignal;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  started: boolean;
  onAbort?: () => void;
}

/** A resource queue whose capacity can be raised by a foreach step. */
class ConcurrentTaskQueue {
  private readonly pending: PendingTask<unknown>[] = [];
  private running = 0;
  private maxConcurrency = 1;

  run<T>(task: () => Promise<T>, signal?: AbortSignal, requestedConcurrency = 1) {
    if (signal?.aborted) return Promise.reject(cancellationError());
    const requested = Number.isSafeInteger(requestedConcurrency) ? Math.max(1, requestedConcurrency) : 1;
    this.maxConcurrency = Math.max(this.maxConcurrency, requested);
    return new Promise<T>((resolve, reject) => {
      const entry: PendingTask<T> = { task, signal, resolve, reject, started: false };
      const abort = () => {
        if (entry.started) return;
        const index = this.pending.indexOf(entry as PendingTask<unknown>);
        if (index < 0) return;
        this.pending.splice(index, 1);
        entry.signal?.removeEventListener("abort", abort);
        reject(cancellationError());
        if (this.running === 0 && this.pending.length === 0) this.maxConcurrency = 1;
        this.pump();
      };
      entry.onAbort = abort;
      if (signal?.aborted) {
        reject(cancellationError());
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(entry as PendingTask<unknown>);
      this.pump();
    });
  }

  private pump() {
    while (this.running < this.maxConcurrency && this.pending.length) {
      const entry = this.pending.shift()!;
      if (entry.signal?.aborted) {
        entry.signal.removeEventListener("abort", entry.onAbort!);
        entry.reject(cancellationError());
        continue;
      }
      entry.started = true;
      entry.signal?.removeEventListener("abort", entry.onAbort!);
      this.running += 1;
      void Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.running -= 1;
          if (this.running === 0 && this.pending.length === 0) this.maxConcurrency = 1;
          this.pump();
        });
    }
  }
}

// A separate bounded queue for every upstream address, rather than a process-wide GPU lock.
// The queue starts serial for backwards compatibility and expands when a foreach step
// explicitly requests a larger maxConcurrency.
export class ResourceQueues {
  private readonly queues = new Map<string, ConcurrentTaskQueue>();
  run<T>(resource: string, task: () => Promise<T>, signal?: AbortSignal, maxConcurrency = 1) {
    let key = resource.trim().replace(/\/+$/, "");
    try { key = new URL(key).toString().replace(/\/+$/, ""); } catch { /* Non-URL resource keys remain usable. */ }
    let queue = this.queues.get(key);
    if (!queue) { queue = new ConcurrentTaskQueue(); this.queues.set(key, queue); }
    return queue.run(task, signal, maxConcurrency);
  }
}
