import { copyFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonValue, RunArtifactPaths } from "../domain/types.js";
import { asRecord, normalizeMediaList } from "../domain/workflowValues.js";
import { mediaKindFromWorkflowType } from "../runtimeValue.js";
import type { PlannedRerun } from "../services/rerunPlanner.js";
import { HttpError } from "../errors.js";

/** Keep selected local replacement media in the new version before accepting it. */
export async function archiveRerunMedia(planned: PlannedRerun, artifacts: RunArtifactPaths) {
  for (const edit of planned.request.outputOverrides ?? []) {
    const step = planned.workflow.steps.find((step) => step.id === edit.stepId)!;
    const record = (planned.reusedSteps.find((record) => record.stepId === edit.stepId) ?? planned.itemSources.find((record) => record.stepId === edit.stepId))!;
    const target = edit.itemIndex === undefined ? record : record.items!.find((item) => item.index === edit.itemIndex)!;
    for (const key of Object.keys(edit.outputs)) {
      if (!mediaKindFromWorkflowType(step.outputs?.find((output) => output.key === key)?.type)) continue;
      const values = normalizeMediaList(target.outputs?.[key]);
      const archived: JsonValue[] = [];
      for (const [index, value] of values.entries()) {
        const item = asRecord(value);
        const locator = typeof value === "string" ? value : typeof item?.path === "string" ? item.path : undefined;
        if (!locator || /^(?:https?:|data:|\/api\/)/i.test(locator)) { archived.push(value); continue; }
        const source = path.resolve(locator.trim());
        try { if (!(await stat(source)).isFile()) throw new Error("不是文件"); }
        catch { throw new HttpError(400, "无法读取替换媒体，请重新选择文件：" + locator, "INVALID_REPLACEMENT_MEDIA"); }
        const suffix = createHash("sha256").update(edit.stepId + ":" + (edit.itemIndex ?? "all") + ":" + key + ":" + index + ":" + source).digest("hex").slice(0, 16);
        const extension = path.extname(source).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12);
        const destination = path.join(artifacts.directory, "outputs", "media", "replacement-" + suffix + extension);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
        archived.push(destination);
      }
      target.outputs = { ...target.outputs, [key]: archived };
      if (edit.itemIndex !== undefined) record.outputs = { ...record.outputs, [key]: record.items!.filter((item) => item.status === "completed").sort((a, b) => a.index - b.index).flatMap((item) => normalizeMediaList(item.outputs?.[key])) };
    }
  }
}
