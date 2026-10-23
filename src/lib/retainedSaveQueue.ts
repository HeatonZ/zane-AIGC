export interface PendingSave<T> { base: T; desired: T }
interface SaveQueueOptions<T> {
  send(base: T, desired: T): Promise<T>;
  saved(value: T, remaining: number): void;
  failed(error: Error): void;
  /**
   * 在途请求的看门狗阈值。请求挂起（网络半开、服务端卡住、上传被中间设备吞掉）时，
   * 队列既不失败也不完成，界面只能一直显示「待同步」。超过阈值就转成明确失败，
   * 让用户拿到重试出口，而不是对着一个永远不动的状态等。
   */
  stallTimeoutMs?: number;
  /** 看门狗触发时用于中断在途请求；省略则只是把队列转为可重试状态。 */
  abortInFlight?(): void;
}

/**
 * Serializes workspace edits to the server and never skips a failed base.
 *
 * 编辑只保存在内存里并立即提交服务端：浏览器不再保存待提交副本。工作区快照可达数 MB，
 * 一条待提交记录同时带 base 与 desired，任何本地副本都会撞上浏览器配额；一旦副本写入
 * 失败就当成暂停，管理端会永久卡在“请处理待确认编辑”，创作页也保存不了草稿。
 * 刷新页面后未确认的编辑确实会丢失，界面用待同步计数与错误提示如实告知。
 */
export class RetainedSaveQueue<T> {
  private readonly entries: PendingSave<T>[];
  private running?: Promise<void>;
  private inFlight?: PendingSave<T>;
  /** 每次发送的世代号：看门狗判死后，旧发送的迟到结果不再影响队列。 */
  private generation = 0;
  /** 发送失败/冲突后暂停：必须显式 retry 才继续，避免越过失败基线。 */
  private paused = false;
  constructor(private readonly options: SaveQueueOptions<T>) {
    this.entries = [];
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
    if (!this.paused) void this.drain();
  }
  /**
   * 用户显式重试：必须真的重发，而不是复用可能已经卡死的在途请求。
   *
   * 真实故障：上传被中间设备吞掉后 send() 永不返回，flush() 一直阻塞，
   * running 始终是同一个 Promise；旧 retry() 只是把 paused 置回 false 再调 drain()，
   * drain() 看到 running 存在就直接返回它——「配置待同步 · 重试」点了毫无反应。
   * 重试是用户主动要求，所以这里一贯地中断在途上传并重新开始。
   */
  retry() {
    this.paused = false;
    if (this.inFlight !== undefined) {
      this.options.abortInFlight?.();
      this.generation++;
      this.inFlight = undefined;
      // 旧 flush 仍阻塞在那个永不返回的 send() 上，不能让它继续占用 running。
      this.running = undefined;
    }
    return this.drain();
  }
  /** 放弃待提交内容（例如显式读取服务端权威配置）；在途请求不受影响。 */
  discard() {
    if (this.inFlight) return false;
    this.entries.length = 0;
    this.paused = false;
    return true;
  }
  private fail(reason: unknown) {
    this.paused = true;
    this.options.failed(reason instanceof Error ? reason : new Error("工作区同步失败"));
  }
  private stallMessage(stallTimeoutMs: number) {
    return `保存超过 ${Math.round(stallTimeoutMs / 1000)} 秒仍未取得回执；请重试或读取服务端配置核对`;
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
      const generation = ++this.generation;
      this.inFlight = entry;
      const stallTimeoutMs = this.options.stallTimeoutMs ?? 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 超时必须参与竞速：只改标志位的话，flush 仍卡在永不返回的 send() 上，
      // running 一直是同一个 Promise，retry() 拿到的还是它——按钮点了毫无反应。
      const stall = stallTimeoutMs > 0
        ? new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              this.options.abortInFlight?.();
              reject(new Error(this.stallMessage(stallTimeoutMs)));
            }, stallTimeoutMs);
            if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
          })
        : undefined;
      try {
        const send = this.options.send(entry.base, entry.desired);
        const saved = await (stall ? Promise.race([send, stall]) : send);
        // 看门狗已判死并推进了世代：这条迟到结果不能再改动队列。
        if (this.generation !== generation) continue;
        this.entries.shift();
        this.options.saved(saved, this.entries.length);
      } catch (error) {
        if (this.generation === generation) this.fail(error);
      }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        if (this.generation === generation) this.inFlight = undefined;
      }
    }
  }
}
