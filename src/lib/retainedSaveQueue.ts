export interface PendingSave<T> { base: T; desired: T }
interface SaveQueueOptions<T> {
  initial?: PendingSave<T>[];
  send(base: T, desired: T): Promise<T>;
  persist(pending: PendingSave<T>[]): void;
  saved(value: T, remaining: number): void;
  failed(error: Error): void;
}

/** Retains failed edits and pauses dependent saves; retry never skips the failed base. */
export class RetainedSaveQueue<T> {
  private readonly entries: PendingSave<T>[];
  private running?: Promise<void>;
  private inFlight?: PendingSave<T>;
  private paused = false;
  constructor(private readonly options: SaveQueueOptions<T>) { this.entries = options.initial ?? []; }
  get pendingCount() { return this.entries.length; }
  get latest() { return this.entries.at(-1)?.desired; }
  enqueue(base: T, desired: T) {
    const last = this.entries.at(-1);
    // Coalesce only unsent edits. An in-flight snapshot must remain immutable.
    if (last && last !== this.inFlight) last.desired = desired;
    else this.entries.push({ base, desired });
    if (!this.persist()) return;
    if (!this.paused) void this.drain();
  }
  retry() { this.paused = false; if (!this.persist()) return Promise.resolve(); return this.drain(); }
  private persist() {
    try { this.options.persist(this.entries); return true; }
    catch (error) { this.fail(error); return false; }
  }
  private fail(reason: unknown) {
    this.paused = true;
    this.options.failed(reason instanceof Error ? reason : new Error("本机工作区同步失败"));
  }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    const operation = this.flush();
    this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = undefined; });
    return operation;
  }
  private async flush() {
    while (this.entries.length && !this.paused) {
      const entry = this.entries[0];
      this.inFlight = entry;
      try {
        const saved = await this.options.send(entry.base, entry.desired);
        this.entries.shift();
        if (!this.persist()) return;
        this.options.saved(saved, this.entries.length);
      } catch (error) { this.fail(error); }
      finally { this.inFlight = undefined; }
    }
  }
}
