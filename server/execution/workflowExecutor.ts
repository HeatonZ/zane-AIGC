import { createRuntimeMediaValue, isRuntimeMediaValue, mediaKindFromWorkflowType, selectRuntimeMedia } from "../runtimeValue.js";
import { asRecord, canonicalWorkflowType, externalizeRuntimeValue, splitWorkflowReference, parseWorkflowJsonPath, resolveWorkflowReference, resolveStepInputs } from "../domain/workflowValues.js";
import { artifactPublicPaths, archiveOutputMedia } from "../artifacts/runArtifacts.js";
import type { JsonValue, RunArtifactPaths, RunStep, RunStepRecord, RunStepItemRecord, RunItemResult, RunWorkflowDefinition, RunRecord, SavedSettings, RunInputField } from "../domain/types.js";

export interface PreparedRun {
  runId: string;
  executionWorkflow: RunWorkflowDefinition;
  inputValues: Record<string, JsonValue>;
  settings: SavedSettings;
  artifacts: RunArtifactPaths;
  createdAt: string;
  runTitle?: string;
  resumedFromRunId?: string;
  resumeSource?: RunRecord;
}
export interface StepExecutionContext {
  /** Original inputs before a for_each source is replaced by the current item. */
  runInputValues: Readonly<Record<string, JsonValue>>;
  /** Immutable complete iteration source, for adapters that must reject invalid plans before generation. */
  iterationItems?: readonly JsonValue[];
  runId: string;
  artifacts: RunArtifactPaths;
  step: RunStep;
  inputValues: Record<string, JsonValue>;
  stepValues: Map<string, Record<string, JsonValue>>;
  types: Map<string, string>;
  settings: SavedSettings;
  inputFields: RunInputField[];
  signal: AbortSignal;
}
export type ExecutionResult = Pick<RunRecord, "runId" | "status" | "steps" | "outputs" | "startedAt" | "finishedAt" | "durationMs" | "error" | "cancellationReason" | "archiveWarnings" | "resumedFromRunId" | "artifacts">;
export interface ExecutionContext {
  controller: AbortController;
  executeStep(context: StepExecutionContext): Promise<Record<string, JsonValue>>;
  checkpoint(patch: Partial<RunRecord>): Promise<void>;
}
export async function executeWorkflow(prepared: PreparedRun, context: ExecutionContext): Promise<ExecutionResult> {
  const { runId, executionWorkflow, inputValues, settings, artifacts, resumeSource } = prepared;
  const requestedResumeFromRunId = prepared.resumedFromRunId;
  const runController = context.controller;
  const startedAt = new Date().toISOString();
  const steps: RunStepRecord[] = [];
  const resumeSourceSteps = new Map<string, Record<string, unknown>>();
  const mediaCache = new Map<string, JsonValue>();
  const archiveWarnings: string[] = [];
  let failure = "";
  function syncSteps(activeSteps: RunStepRecord[] = []) {
    steps.splice(0, steps.length, ...activeSteps);
  }

  let checkpointTail: Promise<void> = Promise.resolve();
  async function persistRuntime(status: "running" | "completed" | "failed" | "cancelled", finishedAt?: string, cancellationReason?: string) {
    const patch = { status, startedAt, steps: externalizeRuntimeValue(steps) as unknown as RunStepRecord[], ...(finishedAt ? { finishedAt, durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime() } : {}), ...(archiveWarnings.length ? { archiveWarnings: [...archiveWarnings] } : {}), ...(cancellationReason ? { cancellationReason } : {}) };
    const current = checkpointTail.then(() => context.checkpoint(patch));
    checkpointTail = current.catch(() => undefined);
    await current;
  }

  async function archiveStepRecords(records: RunStepRecord[]) {
    return Promise.all(records.map(async (step) => {
      const outputs = step.outputs
        ? Object.fromEntries(await Promise.all(Object.entries(step.outputs).map(async ([key, value]) => [
          key,
          await archiveOutputMedia(value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
        ] as const)))
        : undefined;
      const items = step.items
        ? await Promise.all(step.items.map(async (item) => ({
          ...item,
          value: externalizeRuntimeValue(item.value),
          ...(item.inputs ? { inputs: externalizeRuntimeValue(item.inputs) as Record<string, JsonValue> } : {}),
          ...(item.outputs ? {
            outputs: Object.fromEntries(await Promise.all(Object.entries(item.outputs).map(async ([key, value]) => [
              key,
              await archiveOutputMedia(value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
            ] as const))),
          } : {}),
        })))
        : undefined;
      return {
        ...step,
        ...(step.inputs ? { inputs: externalizeRuntimeValue(step.inputs) as Record<string, JsonValue> } : {}),
        ...(outputs ? { outputs } : {}),
        ...(items ? { items } : {}),
      };
    }));
  }

  function iterationSourceInfo(sourceRef: string) {
    const parsed = splitWorkflowReference(sourceRef);
    if (!parsed) return undefined;
    const path = parsed.path ? parseWorkflowJsonPath(parsed.path) : [];
    const inputMatch = /^input\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
    if (inputMatch) {
      const field = executionWorkflow.inputs.find((candidate) => candidate.key === inputMatch[1]);
      return { kind: "input" as const, key: inputMatch[1], type: field?.type, path };
    }
    const outputMatch = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
    if (outputMatch) {
      const step = executionWorkflow.steps.find((candidate) => candidate.id === outputMatch[1]);
      const output = step?.outputs?.find((candidate) => candidate.key === outputMatch[2]);
      return { kind: "step" as const, stepId: outputMatch[1], key: outputMatch[2], type: output?.type, path };
    }
    return undefined;
  }

  function replaceIterationPath(value: JsonValue, segments: Array<string | number>, item: JsonValue): JsonValue {
    if (!segments.length) return item;
    const [segment, ...remaining] = segments;
    if (typeof segment === "number" && Array.isArray(value) && segment < value.length) {
      const next = [...value];
      next[segment] = replaceIterationPath(next[segment], remaining, item);
      return next;
    }
    if (typeof segment === "string" && value !== null && typeof value === "object" && !Array.isArray(value) && !isRuntimeMediaValue(value)
      && Object.prototype.hasOwnProperty.call(value, segment)) {
      const recordValue = value as { [key: string]: JsonValue };
      return { ...recordValue, [segment]: replaceIterationPath(recordValue[segment], remaining, item) };
    }
    throw new Error(`逐项执行来源路径不存在：${segments.join(".")}`);
  }

  function iterationContext(sourceRef: string, itemValue: JsonValue, baseInputs: Record<string, JsonValue>, baseValues: Map<string, Record<string, JsonValue>>, sourceType?: string) {
    const info = iterationSourceInfo(sourceRef);
    if (!info) throw new Error(`逐项执行来源无效：${sourceRef || "（空）"}`);
    const mediaKind = mediaKindFromWorkflowType(info.type ?? sourceType);
    const sourceItem = info.path.length
      ? itemValue
      : mediaKind ? createRuntimeMediaValue(mediaKind, itemValue) : itemValue;
    if (info.kind === "input") {
      return {
        inputs: {
          ...baseInputs,
          [info.key]: info.path.length ? replaceIterationPath(baseInputs[info.key], info.path, sourceItem) : sourceItem,
          "iteration.item": mediaKind ? sourceItem : itemValue,
        },
        values: baseValues,
      };
    }
    const sourceOutputs = baseValues.get(info.stepId);
    if (!sourceOutputs || !Object.prototype.hasOwnProperty.call(sourceOutputs, info.key)) {
      throw new Error(`逐项执行来源 ${sourceRef} 没有可用数组`);
    }
    const values = new Map(baseValues);
    values.set(info.stepId, {
      ...sourceOutputs,
      [info.key]: info.path.length ? replaceIterationPath(sourceOutputs[info.key], info.path, sourceItem) : sourceItem,
    });
    return { inputs: { ...baseInputs, "iteration.item": mediaKind ? sourceItem : itemValue }, values };
  }

  async function executeStep(step: RunStep, stepInputValues: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>, iterationItems?: readonly JsonValue[]) {
    return context.executeStep({ runId, artifacts, runInputValues: inputValues, iterationItems, step, inputValues: stepInputValues, stepValues, types, settings, inputFields: executionWorkflow.inputs, signal: runController.signal });
  }

  async function executeWorkflowItem(itemIndex: number, itemInputValues: Record<string, JsonValue>, resumeState?: { steps: RunStepRecord[]; values: Map<string, Record<string, JsonValue>>; types: Map<string, string>; startIndex: number }): Promise<RunItemResult> {
    const values = resumeState?.values ?? new Map<string, Record<string, JsonValue>>();
    const types = resumeState?.types ?? new Map<string, string>();
    if (!resumeState) {
      for (const field of executionWorkflow.inputs) types.set(`input.${field.key}`, field.type === "textarea" || field.type === "select" ? "text" : canonicalWorkflowType(field.type));
    }
    const itemSteps: RunStepRecord[] = resumeState?.steps ? [...resumeState.steps] : [];
    let itemFailure = "";
    let itemCancelled = false;
    const startIndex = resumeState?.startIndex ?? 0;

    for (let index = startIndex; index < executionWorkflow.steps.length; index += 1) {
      if (runController.signal.aborted) {
        itemCancelled = true;
        break;
      }
      const step = executionWorkflow.steps[index];
      if (!step || typeof step.id !== "string" || typeof step.name !== "string") {
        itemFailure = `第 ${index + 1} 步配置无效`;
        break;
      }
      const stepInputs = resolveStepInputs(step, itemInputValues, values) as Record<string, JsonValue>;
      const inputLabels = Object.fromEntries((step.inputs ?? []).map((input) => [input.key, input.label ?? input.key])) as Record<string, string>;
      const outputLabels = Object.fromEntries((step.outputs ?? []).map((output) => [output.key, output.label ?? output.key])) as Record<string, string>;
      const outputTypes = Object.fromEntries((step.outputs ?? []).map((output) => [output.key, output.type])) as Record<string, string>;
      if (step.runCondition) {
        const condition = values.get(step.runCondition.conditionStepId)?.result;
        if (typeof condition !== "boolean") {
          itemFailure = `${step.name} 引用的条件节点没有布尔结果`;
          itemSteps.push({ stepId: step.id, name: step.name, status: "failed", message: itemFailure, inputs: stepInputs, inputLabels, outputLabels, outputTypes });
          break;
        }
        if (condition !== step.runCondition.expectedResult) {
          itemSteps.push({ stepId: step.id, name: step.name, status: "skipped", message: "执行条件未满足", inputs: stepInputs, inputLabels, outputLabels, outputTypes });
          syncSteps(itemSteps);
          await persistRuntime("running");
          continue;
        }
      }

      if (step.execution?.mode === "for_each") {
        const sourceRef = step.execution.sourceRef?.trim() ?? "";
        let sourceItems: JsonValue[] = [];
        let sourceType: string | undefined;
        const parent: RunStepRecord = { stepId: step.id, name: step.name, status: "running", inputs: stepInputs, inputLabels, outputLabels, outputTypes, items: [] };
        itemSteps.push(parent);
        syncSteps(itemSteps);
        try {
          const info = iterationSourceInfo(sourceRef);
          if (!info) throw new Error(`逐项执行来源无效：${sourceRef || "（空）"}`);
          sourceType = info.type;
          const sourceValue = resolveWorkflowReference(sourceRef, itemInputValues, values);
          const externalSourceValue = externalizeRuntimeValue(sourceValue);
          if (!Array.isArray(externalSourceValue)) throw new Error(`逐项执行来源 ${sourceRef} 必须是数组`);
          sourceItems = externalSourceValue as JsonValue[];
        } catch (error) {
          itemFailure = error instanceof Error ? error.message : `${step.name} 的逐项来源无效`;
          parent.status = "failed";
          parent.message = itemFailure;
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }

        const resumableItems = new Map<number, RunStepItemRecord>();
        const savedItems = resumeSourceSteps.get(step.id)?.items;
        if (Array.isArray(savedItems)) {
          for (const candidate of savedItems) {
            const saved = asRecord(candidate);
            if (!saved || !Number.isSafeInteger(saved.index) || (saved.index as number) < 0 || (saved.index as number) >= sourceItems.length || saved.status !== "completed") continue;
            const savedOutputs = asRecord(saved.outputs);
            if ((step.outputs?.length ?? 0) > 0 && !savedOutputs) continue;
            resumableItems.set(saved.index as number, {
              ...(saved as unknown as RunStepItemRecord),
              index: saved.index as number,
              value: sourceItems[saved.index as number]!,
              outputs: savedOutputs as Record<string, JsonValue> | undefined,
            });
          }
        }
        parent.items = [...resumableItems.values()].sort((left, right) => left.index - right.index);
        syncSteps(itemSteps);
        await persistRuntime("running");

        const aggregatedOutputs: Record<string, JsonValue> = Object.fromEntries((step.outputs ?? []).map((output) => {
          const mediaKind = mediaKindFromWorkflowType(output.type);
          return [output.key, mediaKind ? createRuntimeMediaValue(mediaKind, []) : [] as JsonValue[]];
        }));
        const iterationOutputs = new Array<Record<string, JsonValue> | undefined>(sourceItems.length);
        const iterationSucceeded = new Array<boolean>(sourceItems.length).fill(false);
        const iterationProcessed = new Array<boolean>(sourceItems.length).fill(false);
        const iterationErrors = new Map<number, string>();
        for (const [index, saved] of resumableItems) {
          iterationOutputs[index] = saved.outputs;
          iterationSucceeded[index] = true;
          iterationProcessed[index] = true;
        }
        function collectIterationOutputs(outputs: Record<string, JsonValue> | undefined, succeeded: boolean) {
          for (const output of step.outputs ?? []) {
            const collected = aggregatedOutputs[output.key];
            const mediaKind = mediaKindFromWorkflowType(output.type);
            if (mediaKind) {
              if (succeeded) aggregatedOutputs[output.key] = createRuntimeMediaValue(mediaKind, [collected, outputs?.[output.key] ?? null]);
            } else if (Array.isArray(collected)) collected.push(succeeded ? outputs?.[output.key] ?? null : null);
          }
        }
        function setIterationItem(item: RunStepItemRecord) {
          const records = parent.items ?? (parent.items = []);
          const existingIndex = records.findIndex((record) => record.index === item.index);
          if (existingIndex >= 0) records[existingIndex] = item;
          else records.push(item);
          records.sort((left, right) => left.index - right.index);
        }
        let iterationFailed = false;
        let nextItemIndex = 0;
        let stopScheduling = false;
        const configuredConcurrency = step.execution?.maxConcurrency;
        const maxConcurrency = typeof configuredConcurrency === "number" && Number.isSafeInteger(configuredConcurrency)
          ? Math.min(32, Math.max(1, configuredConcurrency))
          : 1;

        async function executeIteration(itemIndex: number) {
          if (runController.signal.aborted) {
            itemCancelled = true;
            return;
          }
          const sourceItem = sourceItems[itemIndex]!;
          if (resumableItems.has(itemIndex)) return;
          let currentInputs: Record<string, JsonValue>;
          let currentValues: Map<string, Record<string, JsonValue>>;
          let currentStepInputs: Record<string, JsonValue>;
          try {
            const context = iterationContext(sourceRef, sourceItem, itemInputValues, values, sourceType);
            currentInputs = context.inputs;
            currentValues = context.values;
            currentStepInputs = resolveStepInputs(step, currentInputs, currentValues) as Record<string, JsonValue>;
          } catch (error) {
            const message = error instanceof Error ? error.message : `${step.name} 的第 ${itemIndex + 1} 项输入无效`;
            setIterationItem({ index: itemIndex, value: sourceItem, status: "failed", error: message });
            iterationProcessed[itemIndex] = true;
            iterationErrors.set(itemIndex, message);
            iterationFailed = true;
            if (step.execution?.onError === "stop") stopScheduling = true;
            syncSteps(itemSteps);
            await persistRuntime("running");
            return;
          }
          const currentTypes = new Map(types);
          const iterationInfo = iterationSourceInfo(sourceRef);
          const iterationItemType = iterationInfo?.path.length
            ? "json"
            : mediaKindFromWorkflowType(iterationInfo?.type) === "image" ? "image"
              : mediaKindFromWorkflowType(iterationInfo?.type) === "video" ? "video"
                : iterationInfo?.type ?? "json";
          currentTypes.set("iteration.item", iterationItemType);
          const itemRecord: RunStepItemRecord = { index: itemIndex, value: sourceItem, status: "running", inputs: currentStepInputs };
          setIterationItem(itemRecord);
          syncSteps(itemSteps);
          await persistRuntime("running");
          try {
            const outputs = await executeStep(step, currentInputs, currentValues, currentTypes, sourceItems);
            itemRecord.status = "completed";
            itemRecord.outputs = outputs;
            iterationProcessed[itemIndex] = true;
            iterationOutputs[itemIndex] = outputs;
            iterationSucceeded[itemIndex] = true;
          } catch (error) {
            if (runController.signal.aborted) {
              itemCancelled = true;
              stopScheduling = true;
              itemRecord.status = "cancelled";
              iterationProcessed[itemIndex] = true;
              itemRecord.error = String(runController.signal.reason ?? "运行已取消") || "运行已取消";
            } else {
              const message = error instanceof Error ? error.message : `${step.name} 的第 ${itemIndex + 1} 项执行失败`;
              itemRecord.status = "failed";
              iterationProcessed[itemIndex] = true;
              itemRecord.error = message;
              iterationErrors.set(itemIndex, message);
              iterationFailed = true;
              if (step.execution?.onError === "stop") stopScheduling = true;
            }
          }
          syncSteps(itemSteps);
          await persistRuntime("running");
        }

        async function worker() {
          while (true) {
            if (runController.signal.aborted) {
              itemCancelled = true;
              return;
            }
            if (stopScheduling) return;
            const itemIndex = nextItemIndex;
            nextItemIndex += 1;
            if (itemIndex >= sourceItems.length) return;
            await executeIteration(itemIndex);
          }
        }

        await Promise.all(Array.from({ length: Math.min(maxConcurrency, sourceItems.length) }, () => worker()));
        for (let itemIndex = 0; itemIndex < sourceItems.length; itemIndex += 1) {
          if (iterationProcessed[itemIndex]) collectIterationOutputs(iterationOutputs[itemIndex], iterationSucceeded[itemIndex]);
        }
        if (iterationErrors.size) {
          const firstFailure = [...iterationErrors.entries()].sort(([left], [right]) => left - right)[0];
          if (firstFailure) itemFailure = firstFailure[1];
        }
        if (itemCancelled) {
          parent.status = "cancelled";
          parent.message = String(runController.signal.reason ?? "运行已取消") || "运行已取消";
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }
        parent.outputs = aggregatedOutputs;
        values.set(step.id, aggregatedOutputs);
        for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, canonicalWorkflowType(output.type));
        if (iterationFailed) {
          parent.status = "failed";
          parent.message = itemFailure || `${step.name} 有逐项执行失败`;
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }
        parent.status = "completed";
        syncSteps(itemSteps);
        await persistRuntime("running");
        continue;
      }

      try {
        itemSteps.push({ stepId: step.id, name: step.name, status: "running", inputs: stepInputs, inputLabels, outputLabels, outputTypes });
        syncSteps(itemSteps);
        await persistRuntime("running");
        const outputs = await executeStep(step, itemInputValues, values, types);
        values.set(step.id, outputs);
        for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, output.type);
        itemSteps[itemSteps.length - 1] = { stepId: step.id, name: step.name, status: "completed", inputs: stepInputs, inputLabels, outputs, outputLabels, outputTypes };
        syncSteps(itemSteps);
        await persistRuntime("running");
      } catch (error) {
        if (runController.signal.aborted) {
          itemCancelled = true;
          const activeStep = itemSteps[itemSteps.length - 1];
          if (activeStep?.status === "running") {
            activeStep.status = "cancelled";
            activeStep.message = String(runController.signal.reason ?? "运行已取消") || "运行已取消";
          }
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }
        itemFailure = error instanceof Error ? error.message : `${step.name} 执行失败`;
        itemSteps[itemSteps.length - 1] = { stepId: step.id, name: step.name, status: "failed", message: itemFailure, inputs: stepInputs, inputLabels, outputLabels, outputTypes };
        syncSteps(itemSteps);
        await persistRuntime("running");
        break;
      }
    }

    const itemOutputs = executionWorkflow.outputs.map((output) => {
      try {
        const resolved = resolveWorkflowReference(output.sourceRef, itemInputValues, values);
        const mediaKind = mediaKindFromWorkflowType(output.type);
        const normalized = mediaKind && !isRuntimeMediaValue(resolved) ? createRuntimeMediaValue(mediaKind, resolved) : resolved;
        const selected = output.selection ? selectRuntimeMedia(normalized, output.selection) : normalized;
        return { key: output.key, label: output.label ?? output.key, type: output.type, value: (selected ?? null) as JsonValue };
      } catch {
        return { key: output.key, label: output.label ?? output.key, type: output.type, value: null };
      }
    });
    const archivedOutputs = await Promise.all(itemOutputs.map(async (output) => ({
      ...output,
      value: await archiveOutputMedia(output.value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
    })));
    const archivedSteps = await archiveStepRecords(itemSteps);
    itemSteps.splice(0, itemSteps.length, ...archivedSteps);
    const status = itemCancelled ? "cancelled" as const : itemFailure ? "failed" as const : "completed" as const;
    return {
      index: itemIndex,
      value: null,
      status,
      steps: itemSteps,
      outputs: archivedOutputs,
      ...(itemFailure ? { error: itemFailure } : {}),
    };
  }

  let resumeState: { steps: RunStepRecord[]; values: Map<string, Record<string, JsonValue>>; types: Map<string, string>; startIndex: number } | undefined;
  if (resumeSource) {
    const values = new Map<string, Record<string, JsonValue>>();
    const types = new Map<string, string>();
    for (const field of executionWorkflow.inputs) types.set(`input.${field.key}`, field.type === "textarea" || field.type === "select" ? "text" : canonicalWorkflowType(field.type));
    const sourceSteps = new Map(resumeSource.steps.flatMap((savedStep) => {
      const recorded = asRecord(savedStep);
      return typeof recorded?.stepId === "string" ? [[recorded.stepId, recorded] as const] : [];
    }));
    for (const [stepId, recorded] of sourceSteps) resumeSourceSteps.set(stepId, recorded);
    const savedSteps: RunStepRecord[] = [];
    let startIndex = 0;
    for (let index = 0; index < executionWorkflow.steps.length; index += 1) {
      const step = executionWorkflow.steps[index];
      const recorded = sourceSteps.get(step.id);
      const status = recorded?.status;
      if (!recorded || (status !== "completed" && status !== "skipped")) break;
      savedSteps.push(recorded as unknown as RunStepRecord);
      const recordedOutputs = asRecord(recorded.outputs) as Record<string, JsonValue> | undefined;
      if (status === "completed" && recordedOutputs) {
        const hydratedOutputs = { ...recordedOutputs };
        for (const output of step.outputs ?? []) {
          const mediaKind = mediaKindFromWorkflowType(output.type);
          if (mediaKind && Object.prototype.hasOwnProperty.call(hydratedOutputs, output.key)) {
            hydratedOutputs[output.key] = createRuntimeMediaValue(mediaKind, hydratedOutputs[output.key]);
          }
        }
        values.set(step.id, hydratedOutputs);
      }
      for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, output.type);
      startIndex = index + 1;
    }
    resumeState = { steps: savedSteps, values, types, startIndex };
    syncSteps(savedSteps);
  }

  await persistRuntime("running");
  const singleItemResult = await executeWorkflowItem(0, inputValues, resumeState);
  steps.splice(0, steps.length, ...singleItemResult.steps);
  if (singleItemResult.status === "failed") failure = singleItemResult.error ?? "流程执行失败";

  if (runController.signal.aborted) {
    const finishedAt = new Date().toISOString();
    const reason = String(runController.signal.reason ?? "运行已取消") || "运行已中断，无法确认具体原因";
    const activeStep = steps[steps.length - 1];
    if (activeStep?.status === "running") {
      activeStep.status = "cancelled";
      activeStep.message = reason;
    }
    await persistRuntime("cancelled", finishedAt, reason);
    return { runId, status: "cancelled" as const, startedAt, finishedAt, durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(), steps: externalizeRuntimeValue(steps) as unknown as RunStepRecord[], outputs: [], error: reason, cancellationReason: reason, artifacts: artifactPublicPaths(artifacts), ...(requestedResumeFromRunId ? { resumedFromRunId: requestedResumeFromRunId } : {}) };
  }

  const finalOutputs = singleItemResult.outputs;
  const archivedOutputs = await Promise.all(finalOutputs.map(async (output) => ({
    ...output,
    value: await archiveOutputMedia(output.value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
  })));

  const finishedAt = new Date().toISOString();
  const status = failure ? "failed" as const : "completed" as const;
  const result = {
    runId,
    status,
    steps: externalizeRuntimeValue(steps),
    outputs: archivedOutputs,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    ...(failure ? { error: failure } : {}),
    ...(typeof requestedResumeFromRunId === "string" ? { resumedFromRunId: requestedResumeFromRunId } : {}),
    ...(archiveWarnings.length ? { archiveWarnings } : {}),
    artifacts: artifactPublicPaths(artifacts),
  };
  return { ...result, steps: result.steps as unknown as RunStepRecord[] };
}
