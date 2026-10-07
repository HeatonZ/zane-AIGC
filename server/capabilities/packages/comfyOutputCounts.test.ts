import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityPackages } from "../loadPackages.js";
import { prepareComfyOutputCounts, validateComfyOutputCounts } from "../../services/comfyOutputContractService.js";
import { createRuntimeMediaValue } from "../../runtimeValue.js";
import type { RunStep } from "../../domain/types.js";
import type { StepExecutionContext } from "../../execution/workflowExecutor.js";
const step: RunStep = { id: "generate", name: "generate", kind: "comfyui", capabilityId: "core.comfyui", inputs: [], outputs: [{ key: "images", type: "image_list" }], capabilityConfig: { outputMediaCounts: { images: 1 } } };
test("基础ComfyUI可选数量契约逐次校验，不截断/补齐且旧快照保持结果", async () => {
  assert.deepEqual(prepareComfyOutputCounts(step), { images: 1 });
  const one = { images: createRuntimeMediaValue("image", ["one.png"]) }; assert.equal(validateComfyOutputCounts(step, one), one);
  for (const images of [[], ["one.png", "two.png"]]) assert.throws(() => validateComfyOutputCounts(step, { images }), /要求1项媒体/);
  const legacy = { ...step, capabilityConfig: undefined }; const two = { images: ["one.png", "two.png"] }; assert.equal(validateComfyOutputCounts(legacy, two), two);
  let called = 0; const registry = await loadCapabilityPackages({ async hermes() { return {}; }, async condition() { return {}; }, async comfyui() { called++; return two; } });
  const context = { step, inputValues: {}, stepValues: new Map() } as unknown as StepExecutionContext;
  await assert.rejects(registry.execute(context), /要求1项媒体/); assert.equal(called, 1);
  assert.deepEqual(await registry.execute({ ...context, step: legacy }), two);
  for (const outputMediaCounts of ([{ images: -1 }, { images: 1.5 }, { images: 145 }, { missing: 1 }] as Array<Record<string, number>>)) { const invalid = { ...step, capabilityConfig: { outputMediaCounts } }; assert.throws(() => registry.prepareStep(invalid), /配置无效|必须引用已声明媒体输出/); }
});
