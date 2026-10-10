import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { JsonValue, RunWorkflowDefinition, SavedSettings } from "../domain/types.js";
import { ExecutorRegistry, type StepExecutor } from "../execution/executorRegistry.js";
import type { ExecutionContext, ExecutionResult, PreparedRun } from "../execution/workflowExecutor.js";
import { RunService } from "../services/runService.js";
import { SqliteStore } from "../storage/sqliteStore.js";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function temporaryDirectory(t: TestContext, cleanup?: () => void | Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zane-infra-test-"));
  t.after(async () => {
    await cleanup?.();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}zane-infra-test-`));
    await rm(resolved, { recursive: true, force: true });
  });
  return root;
}
export async function harness(t: TestContext, options: { executor?: StepExecutor; executors?: ExecutorRegistry; maxActiveRuns?: number; getMaxActiveRuns?(): number; execute?(prepared: PreparedRun, context: ExecutionContext): Promise<ExecutionResult> } = {}) {
  let service: RunService | undefined;
  let store: SqliteStore | undefined;
  const root = await temporaryDirectory(t, async () => { await service?.shutdown(100); store?.close(); });
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  const settings: SavedSettings = { projectDirectory, comfyuiBaseUrl: "http://127.0.0.1:1", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] };
  store = new SqliteStore(path.join(root, "metadata.db"));
  const executors = options.executors ?? new ExecutorRegistry().register(options.executor ?? { kind: "fake", async execute() { return { value: "ok" }; } });
  service = new RunService({ store, executors, loadSettings: async () => settings, maxActiveRuns: options.maxActiveRuns ?? 1, getMaxActiveRuns: options.getMaxActiveRuns, execute: options.execute });
  return { root, settings, store, executors, service };
}
export function workflow(steps: RunWorkflowDefinition["steps"] = [{ id: "first", name: "第一步", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }] }]): RunWorkflowDefinition {
  return { sceneId: "test-scene", name: "基础测试", inputs: [], steps, outputs: [{ key: "result", type: "text", sourceRef: `step.${steps.at(-1)!.id}.outputs.value` }] };
}
export async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("测试等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export function submission(runId: string, definition = workflow(), inputValues: Record<string, JsonValue> = {}) { return { runId, workflow: definition, inputValues }; }

export function id(name: string) {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
