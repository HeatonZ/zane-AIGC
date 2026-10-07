import { readFile } from "node:fs/promises";
import path from "node:path";
import { upgradeRecordSchema, upgradeId, type UpgradeRecord } from "../domain/workbenchUpdateContracts.js";
import { HttpError } from "../errors.js";

/** Operational receipts only. Never a task/workspace database, and never runs a command. */
export async function readUpgradeStatus(dataDirectory: string, operationId?: string) {
  const directory = path.join(dataDirectory, "maintenance", "upgrades");
  let id = operationId;
  if (!id) {
    try { id = upgradeId.parse(JSON.parse(await readFile(path.join(directory, "latest.json"), "utf8")).operationId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HttpError(503, "升级指针不可读取；不执行或重放升级", "UPGRADE_RECEIPT_INVALID"); }
  }
  let operation: UpgradeRecord | null = null;
  if (id) {
    if (!upgradeId.safeParse(id).success) throw new HttpError(400, "升级 operationId 必须是 UUID", "INVALID_AI_REQUEST");
    try {
      operation = upgradeRecordSchema.parse(JSON.parse(await readFile(path.join(directory, id + ".json"), "utf8")));
      if (operation.operationId !== id) throw new Error("Mismatched operation ID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "没有找到此升级；先按原 ID 对账，不自动换 ID", "UPGRADE_NOT_FOUND");
      throw new HttpError(503, "升级回执不可读取；不执行或重放升级", "UPGRADE_RECEIPT_INVALID");
    }
  }
  return { supported: true as const, operation, execution: "local_supervisor_only" as const, nextAction: operation?.nextAction ?? "request_local_upgrade" };
}
