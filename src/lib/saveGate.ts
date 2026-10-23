/**
 * 保存状态 → 界面语义的唯一判断点。
 *
 * 真实故障：配置编辑后「保存中」会一直停住（请求丢失、排队或服务端忙），而差异弹窗
 * 只在 saving/failed 之间分支、顶栏只在有错误时给重试按钮，于是界面既没有错误也没有
 * 出口，用户只能刷新页面。这里把「等待」和「未确认」分开，并给等待设上限。
 */
export type SaveStatus = "saving" | "saved" | "failed";
/** pending=还在等回执；unconfirmed=不会再自动确认，需要用户对账；ready=可以继续。 */
export type SavePhase = "pending" | "unconfirmed" | "ready";

/** 「保存中」的等待上限：超过就按未确认处理，把决定权交回用户。 */
export const saveWaitTimeoutMs = 30_000;

/**
 * 在途保存请求的看门狗阈值。
 *
 * 工作区写入的请求体约 6MB，本机正常耗时 0.15–0.3 秒，但慢网或本机忙时会明显变长。
 * 超过这个时间还没有回执就当成卡死：中断在途请求并转成明确失败，让「重试」真的能重发
 * （旧实现里 retry 只会返回同一个永不完成的 Promise，按钮点了毫无反应）。
 * 必须明显大于上传正常完成所需时间，否则会把慢但会成功的保存误判为失败。
 */
export const workspaceSaveStallTimeoutMs = 120_000;

export function savePhase(status: SaveStatus, timedOut: boolean): SavePhase {
  if (status === "saved") return "ready";
  if (status === "failed") return "unconfirmed";
  return timedOut ? "unconfirmed" : "pending";
}

/**
 * 发布前的保存闸门。只有明确的失败才拦：`saving` 允许继续，因为发布会在队列里
 * 接在待提交编辑之后并等待回执，失败时抛错而不是宣布发布成功（一次点击发布）。
 */
export function publishBlockedReason(status: SaveStatus): string {
  return status === "failed" ? "配置尚未同步，请先在顶栏重试或读取服务端配置，再发布" : "";
}

/** 差异弹窗顶部的等待/未确认说明；空串表示不显示。 */
export function saveWaitMessage(status: SaveStatus, timedOut: boolean): string {
  switch (savePhase(status, timedOut)) {
    case "ready": return "";
    case "pending": return "正在保存配置，等待服务端确认后自动加载差异…";
    case "unconfirmed": return status === "failed"
      ? "保存尚未确认，暂不预览旧服务端草稿。请先对账并确认保存。"
      : `保存回执超过 ${Math.round(saveWaitTimeoutMs / 1000)} 秒仍未确认，已停止等待。请在顶栏点“配置未同步 · 重试”或“刷新配置”对账后重新预览。`;
  }
}
