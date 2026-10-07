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
  constructor(private readonly options: SaveQueueOptions<T>) {
    this.entries = options.initial ?? [];
    // Reloaded intent is not authority and must never be sent without an explicit retry.
    this.paused = this.entries.length > 0;
  }
  async waitForSaved() {
    await this.running;
    if (this.entries.length) throw new Error("服务端保存尚未确认，请读取原对象对账或处理冲突");
  }
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
  /** Discard failed local saves after an explicit user choice. */
  discard() {
    if (this.inFlight) return false;
    const retained = this.entries.splice(0, this.entries.length);
    this.paused = false;
    if (this.persist()) return true;
    this.entries.push(...retained);
    return false;
  }
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
