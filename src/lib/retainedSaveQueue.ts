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
  /** 暂停是否由本地存储写入失败造成：存储恢复正常后可以自动继续发送剩余编辑。 */
  private pausedByStorage = false;
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
  retry() { this.paused = false; this.pausedByStorage = false; if (!this.persist()) return Promise.resolve(); return this.drain(); }
  /** Discard failed local saves after an explicit user choice. */
  discard() {
    if (this.inFlight) return false;
    const retained = this.entries.splice(0, this.entries.length);
    this.paused = false;
    this.pausedByStorage = false;
    if (this.persist()) return true;
    this.entries.push(...retained);
    return false;
  }
  /**
   * 每条记录都带完整快照，所以尚未发送的中间记录只保留了更旧的合并基线；
   * 「首条基线 + 末条 desired」与逐条重放等价。outbox 写满时丢掉这些冗余快照，
   * 避免队列因为体积超过 localStorage 配额而永久无法落盘。
   */
  private compact() {
    // 正在发送的记录不能被替换；发送完成后它已经移出 entries，因此按身份判断而不是下标。
    const start = this.entries[0] === this.inFlight ? 1 : 0;
    const kept = this.entries.slice(0, start);
    const tail = this.entries.slice(start);
    const last = tail.at(-1);
    if (!last || tail.length < 2) return false;
    this.entries.length = 0;
    this.entries.push(...kept, { base: tail[0].base, desired: last.desired });
    return true;
  }
  private persist() {
    try { this.options.persist(this.entries); return true; }
    catch (error) {
      if (this.compact()) {
        try { this.options.persist(this.entries); return true; }
        catch { /* 缩容后仍然写不下：按存储失败处理 */ }
      }
      this.fail(error, true);
      return false;
    }
  }
  private fail(reason: unknown, storage = false) {
    this.paused = true;
    this.pausedByStorage = storage;
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
        // 收据已经写回存储：如果之前只是因为存储写满而暂停，此刻已经恢复，
        // 继续发送剩余编辑。发送失败/冲突造成的暂停不受影响，仍需显式 retry。
        if (this.pausedByStorage) { this.pausedByStorage = false; this.paused = false; }
        this.options.saved(saved, this.entries.length);
      } catch (error) { this.fail(error); }
      finally { this.inFlight = undefined; }
    }
  }
}
