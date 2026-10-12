/** 进程内滚动统计：记录终态运行的时长与成败，供 /api/v1/maintenance/metrics 观察趋势。
 *  只保留最近 N 条样本，重启即清零；不落库、不暴露业务内容。 */
const MAX_SAMPLES = 200;

export interface RunSample {
  at: string;
  status: "completed" | "failed" | "cancelled" | "stale";
  durationMs?: number;
  sceneId?: string;
}

export class RunMetricsTracker {
  private readonly samples: RunSample[] = [];
  record(sample: RunSample) {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }
  snapshot() {
    if (!this.samples.length) return { samples: 0, windowMs: 0, byStatus: {}, durationMs: {} };
    const windowStart = Date.parse(this.samples[0].at);
    const windowEnd = Date.parse(this.samples[this.samples.length - 1].at);
    const byStatus: Record<string, number> = {};
    for (const sample of this.samples) byStatus[sample.status] = (byStatus[sample.status] ?? 0) + 1;
    const durations = this.samples.map((sample) => sample.durationMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
    const percentile = (fraction: number) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))]! : undefined;
    return {
      samples: this.samples.length,
      windowMs: Number.isFinite(windowStart) && Number.isFinite(windowEnd) ? Math.max(0, windowEnd - windowStart) : 0,
      byStatus,
      durationMs: { ...(durations.length ? { min: durations[0]! } : {}), ...(percentile(0.5) !== undefined ? { p50: percentile(0.5)! } : {}), ...(percentile(0.95) !== undefined ? { p95: percentile(0.95)! } : {}), ...(durations.length ? { max: durations[durations.length - 1]! } : {}) },
      latest: this.samples.slice(-20).reverse(),
    };
  }
}
