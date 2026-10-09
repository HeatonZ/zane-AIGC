import { prepareComfyOutputCounts, validateComfyOutputCounts } from "../../services/comfyOutputContractService.js";
import { builtinCapabilities } from "../definitions.js";
import type { CapabilityFactory } from "../package.js";
import { resolveStepInputs, toJsonValue } from "../../domain/workflowValues.js";
import { runCommercePackStep } from "../../commerce/adapter.js";
import { runLongTextVideoStep } from "../../execution/longTextVideo.js";
import { runVideoConcatStep } from "../../execution/videoConcat.js";
import { executeThirdPartyJsonRequest, validateThirdPartyRequestStep } from "../../execution/thirdPartyJsonRequest.js";
import { runH3SceneAdapter } from "../../h3SceneAdapter.js";
const factory: CapabilityFactory = (runtime) => {
  const implementations = {
    "core.hermes": runtime.hermes,
    "core.comfyui": async (context: Parameters<typeof runtime.comfyui>[0]) => { prepareComfyOutputCounts(context.step); return validateComfyOutputCounts(context.step, await runtime.comfyui(context)); },
    "core.http_request": runtime.thirdPartyRequest ?? executeThirdPartyJsonRequest,
    "core.condition": runtime.condition,
    "core.manual": async (context: Parameters<typeof runtime.comfyui>[0]) => {
      const inputs = resolveStepInputs(context.step, context.inputValues, context.stepValues);
      return Object.fromEntries((context.step.outputs ?? []).map((output) => [output.key, toJsonValue(inputs[output.key] ?? null)]));
    },
    "comfyui.commerce_pack": (context: Parameters<typeof runtime.comfyui>[0]) => runCommercePackStep(context, (next) => runtime.comfyui(next)),
    "comfyui.long_text_video": (context: Parameters<typeof runtime.comfyui>[0]) => runLongTextVideoStep(context, (next) => runtime.comfyui(next)),
    "media.video_concat": runVideoConcatStep,
    "comfyui.h3_long_video": (context: Parameters<typeof runtime.comfyui>[0]) => runtime.comfyui(context, async ({ graph, workflow, baseUrl, timeoutMs, request }) => ({ outputs: await runH3SceneAdapter(context.step, graph, workflow, context.inputValues, context.stepValues, baseUrl, timeoutMs, context.signal, request) })),
  };
  return builtinCapabilities.map((definition) => ({ definition: { ...definition, dependencyMode: ["comfyui.commerce_pack", "comfyui.long_text_video"].includes(definition.id) ? "all-prior" : "declared" }, ...(definition.id === "core.comfyui" ? { validate: prepareComfyOutputCounts } : {}), ...(definition.id === "core.http_request" ? { validate: validateThirdPartyRequestStep } : {}), execute: implementations[definition.id as keyof typeof implementations] }));
};
export default factory;
