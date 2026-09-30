import { runH3LongVideo } from "./h3LongVideo.js";
import { readH3ReferenceImage } from "./h3ReferenceImage.js";
import { createRuntimeMediaValue } from "./runtimeValue.js";
import { externalizeRuntimeValue, normalizeMediaList, resolveWorkflowReference } from "./domain/workflowValues.js";
import { delayWithAbort } from "./execution/cancellation.js";
import type { JsonValue, RunStep } from "./domain/types.js";

/** Only submit ancestors of the video output; canvas labels and group controls have no backend. */
export function h3ExecutionGraph(graph: Record<string, Record<string, unknown>>, videoId: string) {
  const selected = new Set<string>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    const node = graph[id];
    if (!node) throw new Error("H3 视频依赖了不存在的节点：" + id);
    selected.add(id);
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return;
    for (const value of Object.values(inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) visit(value[0]);
    }
  };
  visit(videoId);
  return Object.fromEntries(Object.entries(graph).filter(([id]) => selected.has(id)));
}

export async function runH3SceneAdapter(
  step: RunStep,
  graph: Record<string, Record<string, unknown>>,
  workflow: unknown,
  inputs: Record<string, JsonValue>,
  stepValues: Map<string, Record<string, JsonValue>>,
  baseUrl: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  request: (route: string, init?: RequestInit, signal?: AbortSignal) => Promise<unknown>,
): Promise<Record<string, JsonValue>> {
  const config = step.comfyui?.h3LongVideo;
  if (!config?.planRef || !config.promptRowsRef || !config.referenceImagesRef) throw new Error(step.name + " 缺少 H3 分段、提示词或参考图引用");
  const resolve = (reference: string) => resolveWorkflowReference(reference, inputs, stepValues);
  const plan = resolve(config.planRef);
  const promptRows = resolve(config.promptRowsRef);
  const images = normalizeMediaList(externalizeRuntimeValue(resolve(config.referenceImagesRef)));
  const note = config.materialNoteRef ? resolve(config.materialNoteRef) : "";
  if (note !== undefined && note !== null && typeof note !== "string") throw new Error("H3 素材说明需要文本");
  const bindings = step.comfyui?.bindings?.filter((item) => item.direction === "output") ?? [];
  if (!bindings.length) throw new Error("H3 长视频步骤没有配置最终视频输出");
  const videoNodes = Object.entries(graph).filter(([, node]) => node.class_type === "VHS_VideoCombine");
  for (const binding of bindings) {
    if (videoNodes.length !== 1 || binding.nodeId !== videoNodes[0][0] || !["gifs", "Filenames", "video"].includes(binding.property) || !["video", "video_list"].includes(binding.type)) {
      throw new Error("H3 最终视频输出需要绑定到 VHS_VideoCombine，类型为视频列表");
    }
  }
  const executionGraph = h3ExecutionGraph(graph, videoNodes[0][0]);
  const result = await runH3LongVideo(executionGraph, workflow, {
    plan, promptRows, images, materialNote: typeof note === "string" ? note : "",
  }, {
    request,
    readImage: (value) => readH3ReferenceImage(value, baseUrl, signal),
    delay: delayWithAbort,
    progress: async (message) => { console.info("[H3] " + message); },
  }, timeoutMs, signal);
  const video = createRuntimeMediaValue("video", {
    ...result.video,
    url: "/api/comfyui/view?" + new URLSearchParams({ filename: result.video.filename, subfolder: result.video.subfolder, type: result.video.type }),
  });
  const outputs: Record<string, JsonValue> = { applied_prompts: result.prompts };
  for (const binding of bindings) outputs[binding.key] = video;
  return outputs;
}
