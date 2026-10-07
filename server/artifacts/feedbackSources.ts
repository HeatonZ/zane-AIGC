import path from "node:path";
import type { StepFeedbackRecord } from "../domain/feedbackContracts.js";
import { asRecord } from "../domain/workflowValues.js";
import { readJsonFile } from "../storage/jsonFileStore.js";
import { isRunId, runArtifactPaths } from "./runArtifacts.js";

/** Match unchanged media across durable input copies without treating a newly selected file as the old one. */
export async function readFeedbackSourceAliases(project: string, currentRunId: string, history: readonly StepFeedbackRecord[]): Promise<Record<string, string>> {
  const runsRoot = path.resolve(project, ".zane", "runs");
  const aliases: Record<string, string> = {};
  const pending = [currentRunId, ...history.map(feedback => feedback.sourceRunId)];
  const visited = new Set<string>();
  while (pending.length) {
    const runId = pending.pop()!;
    if (!isRunId(runId) || visited.has(runId)) continue;
    visited.add(runId);
    const paths = runArtifactPaths(project, runId);
    const archive = await readJsonFile(paths.inputs);
    for (const raw of Array.isArray(archive?.files) ? archive.files : []) {
      const file = asRecord(raw);
      if (typeof file?.path !== "string" || typeof file.originalPath !== "string") continue;
      const original = path.resolve(file.originalPath);
      const parts = path.relative(runsRoot, original).split(path.sep);
      // Only an app-owned archived input is an identity-preserving copy. Never alias to user paths.
      if (!isRunId(parts[0]) || parts[1] !== "inputs" || parts[2] !== "files" || parts.length !== 4) continue;
      const destination = path.resolve(paths.directory, ...file.path.split(/[\\/]/));
      if (!destination.startsWith(path.resolve(paths.directory, "inputs", "files") + path.sep)) continue;
      aliases[destination] = original;
      pending.push(parts[0]);
    }
  }
  return aliases;
}
