import assert from "node:assert/strict";
import type { ComfyUIWorkflowNode, RunWorkflowDefinition } from "./types.js";
import { validateWorkflowShape } from "./workflowValidation.js";

/** Director-console workflow (ComfyUI-Easy-Media multi-track project) driving the whole film in one run. */
export const DIRECTOR_CONSOLE_WORKFLOW_FILE = "Zane/MiniMaxH3-极简导演台+.json";
const LEGACY_GENERATE_WORKFLOW_FILE = "Zane/MiniMax+H3+真·上下文无缝无色差长视频，SelfLift双采(简易版)+.json";
const DIRECTOR_EDITOR_NODE_ID = "14";
const DIRECTOR_PROJECT_NODE_ID = "15";
const DIRECTOR_SAVE_NODE_ID = "63";
const FRAME_RATE = 24;

/**
 * core.code sandbox source for the director-console plan. It turns the aligned
 * per-shot records (Writer shot + final local-marker prompt + selected media)
 * into the console TRACK_DATA, an isolated project name and a plan manifest.
 * Media reaches the console as local asset files, so no upload or extra graph
 * node is needed; the task prompt keeps the references step's local markers.
 */
export const DIRECTOR_CONSOLE_PLAN_CODE = [
  "// 导演台（Easy-Media 多轨工程）时间线构建。输入：records 行（序列化后带本地资产路径）。",
  "const FRAME_RATE = 24;",
  "const fail = (message) => { throw new Error(message); };",
  "const raw = typeof inputs.rows === \"string\" ? inputs.rows : \"\";",
  "let rows;",
  "try { rows = JSON.parse(raw); } catch (error) { fail(\"分镜记录不是有效 JSON\"); }",
  "if (!Array.isArray(rows) || !rows.length) fail(\"制作分镜记录不能为空\");",
  "if (rows.length > 360) fail(\"导演台单次运行最多 360 个分镜，请拆成多集\");",
  "const record = (value) => (value && typeof value === \"object\" && !Array.isArray(value) ? value : null);",
  "const localPath = (item, label) => {",
  "  const entry = record(item);",
  "  if (typeof item === \"string\" && item.trim()) return item;",
  "  if (entry && typeof entry.path === \"string\" && entry.path.trim()) return entry.path;",
  "  if (entry && entry.locator && entry.locator.type === \"path\" && typeof entry.locator.value === \"string\" && entry.locator.value.trim()) return entry.locator.value;",
  "  fail(label + \" 必须是资产库中的文件；运行输出媒体请先归档为资产再作为参考\");",
  "};",
  "const fileName = (item, fallback) => {",
  "  const entry = record(item);",
  "  if (entry && typeof entry.filename === \"string\" && entry.filename) return entry.filename;",
  "  if (entry && typeof entry.name === \"string\" && entry.name) return entry.name;",
  "  if (typeof item === \"string\") { const parts = item.split(/[\\\\/]/); return parts[parts.length - 1] || fallback; }",
  "  return fallback;",
  "};",
  "const integerList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === \"number\" && Number.isSafeInteger(item)) : []);",
  "// Live runs carry runtime media wrappers ({items:[...]}); resumed runs carry the externalized array.",
  "const mediaItems = (value) => Array.isArray(value) ? value : (record(value) && Array.isArray(value.items) ? value.items : []);",
  "let cursor = 0;",
  "const taskSegments = [];",
  "const audioTracks = new Map();",
  "const planSegments = [];",
  "for (let position = 0; position < rows.length; position += 1) {",
  "  const row = record(rows[position]) || fail(\"第 \" + (position + 1) + \" 条分镜记录无效\");",
  "  const shot = record(row.shot) || fail(\"第 \" + (position + 1) + \" 条分镜缺少 shot\");",
  "  const index = shot.index;",
  "  if (index !== position + 1) fail(\"分镜 index 必须从 1 开始连续递增，第 \" + (position + 1) + \" 条为 \" + index);",
  "  const seconds = shot.seconds;",
  "  if (typeof seconds !== \"number\" || !(seconds >= 5 && seconds <= 15)) fail(\"分镜 \" + index + \" 的时长需要在 5 到 15 秒之间\");",
  "  const selection = record(shot.selection) || {};",
  "  const characters = integerList(selection.characters);",
  "  const scenes = integerList(selection.scenes);",
  "  const props = integerList(selection.props);",
  "  const voices = integerList(selection.voices);",
  "  const pictures = characters.length + scenes.length + props.length;",
  "  if (pictures > 9) fail(\"分镜 \" + index + \" 最多引用 9 张人物/场景/道具图，请拆镜头\");",
  "  if (voices.length > 3) fail(\"分镜 \" + index + \" 最多引用 3 个参考音色，请拆分多人对白\");",
  "  if (new Set([...characters, ...scenes, ...props]).size !== pictures) fail(\"分镜 \" + index + \" 的图片引用重复\");",
  "  const references = record(row.references) || {};",
  "  const images = mediaItems(references.images);",
  "  const audios = mediaItems(references.audios);",
  "  if (images.length !== pictures) fail(\"分镜 \" + index + \" 的图片引用与素材映射结果数量不一致\");",
  "  if (audios.length !== voices.length) fail(\"分镜 \" + index + \" 的音色引用与素材映射结果数量不一致\");",
  "  const prompt = typeof row.prompt === \"string\" ? row.prompt : \"\";",
  "  if (!prompt.trim()) fail(\"分镜 \" + index + \" 缺少最终提示词\");",
  "  for (const match of prompt.matchAll(/<Picture\\s+(\\d+)>/g)) if (Number(match[1]) > pictures) fail(\"分镜 \" + index + \" 引用了不存在的图片 <Picture \" + match[1] + \">\");",
  "  for (const match of prompt.matchAll(/<Audio\\s+(\\d+)>/g)) if (Number(match[1]) > voices.length) fail(\"分镜 \" + index + \" 引用了不存在的音色 <Audio \" + match[1] + \">\");",
  "  const frames = Math.max(1, Math.round(seconds * FRAME_RATE));",
  "  const startFrame = cursor;",
  "  const endFrame = cursor + frames;",
  "  cursor = endFrame;",
  "  const imageItems = images.map((item, imageIndex) => ({",
  "    id: \"shot-\" + index + \"-image-\" + (imageIndex + 1),",
  "    source_type: \"local\",",
  "    local_path: localPath(item, \"分镜 \" + index + \" 的第 \" + (imageIndex + 1) + \" 张参考图\"),",
  "    file_name: fileName(item, \"image-\" + (imageIndex + 1)),",
  "  }));",
  "  const taskType = imageItems.length || audios.length ? \"r2v\" : \"t2v\";",
  "  taskSegments.push({",
  "    id: \"shot-\" + index,",
  "    start_frame: startFrame,",
  "    end_frame: endFrame,",
  "    color: \"var(--multitrack-task-bg)\",",
  "    content: {",
  "      media_type: \"none\",",
  "      task_mode: taskType === \"r2v\" ? \"ref\" : \"default\",",
  "      task_type: taskType,",
  "      continuity_mode: position === 0 ? \"shot\" : \"context\",",
  "      ref_image_size: \"match\",",
  "      images: imageItems,",
  "      user_prompt: prompt,",
  "      system_prompt: \"\",",
  "      user_prompt_variant: \"a\",",
  "      user_prompt_b: \"\",",
  "      muted: false,",
  "      volume_db: 0,",
  "    },",
  "  });",
  "  voices.forEach((voiceIndex, audioPosition) => {",
  "    const audio = audios[audioPosition];",
  "    const label = \"分镜 \" + index + \" 的第 \" + (audioPosition + 1) + \" 个参考音色\";",
  "    const track = audioTracks.get(voiceIndex) || { name: \"Voice \" + voiceIndex, path: localPath(audio, label), file_name: fileName(audio, \"voice-\" + voiceIndex + \".wav\"), ranges: [] };",
  "    track.ranges.push([startFrame, endFrame]);",
  "    audioTracks.set(voiceIndex, track);",
  "  });",
  "  planSegments.push({ index, seconds, frames, start_frame: startFrame, end_frame: endFrame, continuity_mode: position === 0 ? \"shot\" : \"context\", characters, scenes, props, voices });",
  "}",
  "const tracks = [{ id: \"task-track\", name: \"Tasks\", type: \"task\", color: \"var(--multitrack-task-bg)\", muted: false, locked: false, segments: taskSegments }];",
  "for (const [voiceIndex, track] of [...audioTracks.entries()].sort((left, right) => left[0] - right[0])) {",
  "  tracks.push({",
  "    id: \"audio-track-\" + voiceIndex,",
  "    name: track.name,",
  "    type: \"audio\",",
  "    color: \"var(--highlight)\",",
  "    muted: false,",
  "    solo: false,",
  "    volume_db: 0,",
  "    locked: false,",
  "    segments: track.ranges.map((range, rangeIndex) => ({",
  "      id: \"audio-\" + voiceIndex + \"-\" + (rangeIndex + 1),",
  "      start_frame: range[0],",
  "      end_frame: range[1],",
  "      origin_start_frame: range[0],",
  "      color: \"var(--highlight)\",",
  "      content: { media_type: \"audio\", source_type: \"local\", local_path: track.path, file_name: track.file_name, shared_reference: true, muted: false, volume_db: 0 },",
  "    })),",
  "  });",
  "}",
  "const trackData = { muted: false, volume_db: 0, task_markers: [], task_overview: false, tracks, total_length: cursor, frame_rate: FRAME_RATE };",
  "const projectName = \"zane-ltv-\" + Date.now().toString(36) + \"-\" + Math.random().toString(36).slice(2, 8);",
  "const manifest = {",
  "  format: \"zane.director-console-plan/v1\",",
  "  frame_rate: FRAME_RATE,",
  "  segment_count: rows.length,",
  "  total_frames: cursor,",
  "  total_seconds: cursor / FRAME_RATE,",
  "  music_added: false,",
  "  native_audio: true,",
  "  segments: planSegments,",
  "};",
  "return { track_data: JSON.stringify(trackData), project_name: projectName, manifest };",
].join("\n");

function buildConsoleInputStep(): RunWorkflowDefinition["steps"][number] {
  return {
    id: "console_input",
    name: "数据 · 导演台输入序列化（分镜与本地资产路径）",
    kind: "capability",
    capabilityId: "text.template",
    capabilityVersion: "1",
    inputs: [{ key: "rows", label: "制作分镜记录", sourceRef: "step.records.outputs.rows", valueSource: "reference" }],
    capabilityConfig: { template: "{{rows}}" },
    outputs: [{ key: "rows_json", label: "分镜与资产路径 JSON", type: "text", description: "records 行的 JSON 序列化；本地资产路径只在本运行内供导演台时间线使用" }],
  };
}

function buildConsolePlanStep(): RunWorkflowDefinition["steps"][number] {
  return {
    id: "console_plan",
    name: "导演台 · 生成多轨时间线与工程参数",
    kind: "capability",
    capabilityId: "core.code",
    capabilityVersion: "1",
    inputs: [{ key: "rows", label: "分镜与资产路径 JSON", sourceRef: "step.console_input.outputs.rows_json", valueSource: "reference" }],
    capabilityConfig: { code: DIRECTOR_CONSOLE_PLAN_CODE, timeoutMs: 10000 },
    outputs: [
      { key: "track_data", label: "导演台时间线 TRACK_DATA", type: "text", description: "任务轨按分镜时长连续排布，首镜 shot、其余 context；图片走本地资产路径，音色按全局序号建共享音轨" },
      { key: "project_name", label: "ComfyUI 工程名", type: "text", description: "按运行隔离，避免并发或重跑相互覆盖" },
      { key: "manifest", label: "生成计划", type: "json", description: "分段帧数与素材引用计划；非探测值" },
    ],
  };
}

function buildConsoleStep(): RunWorkflowDefinition["steps"][number] {
  return {
    id: "console",
    name: "导演台 · 单工作流整片顺序续接（原生有声）",
    kind: "comfyui",
    capabilityId: "core.comfyui",
    capabilityVersion: "1",
    inputs: [
      { key: "track_data", label: "导演台时间线", sourceRef: "step.console_plan.outputs.track_data", valueSource: "reference" },
      { key: "ratio", label: "画幅", sourceRef: "input.ratio", valueSource: "reference" },
      { key: "mp", label: "生成像素（百万像素）", sourceRef: "input.mp", valueSource: "reference" },
      { key: "project_name", label: "工程名", sourceRef: "step.console_plan.outputs.project_name", valueSource: "reference" },
    ],
    capabilityConfig: { outputMediaCounts: { result: 1 } },
    comfyui: {
      workflowFile: DIRECTOR_CONSOLE_WORKFLOW_FILE,
      bindings: [
        { key: "track_data", label: "导演台时间线", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "track_data", type: "text", required: true, sourceRef: "step.console_plan.outputs.track_data", valueSource: "reference" },
        { key: "ratio", label: "画幅", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "resolution.aspect_ratio", type: "text", required: true, sourceRef: "input.ratio", valueSource: "reference" },
        { key: "mp", label: "生成像素（百万像素）", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "resolution.megapixels", type: "number", required: true, sourceRef: "input.mp", valueSource: "reference" },
        { key: "project_name", label: "工程名（按运行隔离）", direction: "input", nodeId: DIRECTOR_PROJECT_NODE_ID, property: "project_name", type: "text", required: true, sourceRef: "step.console_plan.outputs.project_name", valueSource: "reference" },
        { key: "segment_start_number", label: "起始分镜号", direction: "input", nodeId: DIRECTOR_PROJECT_NODE_ID, property: "segment_start_number", type: "number", required: true, valueSource: "literal", literalValue: "1", literalType: "number" },
        { key: "segment_count", label: "生成分镜数（-1 为全部）", direction: "input", nodeId: DIRECTOR_PROJECT_NODE_ID, property: "segment_count", type: "number", required: true, valueSource: "literal", literalValue: "-1", literalType: "number" },
        { key: "result", label: "完整成片（原生有声）", direction: "output", nodeId: DIRECTOR_SAVE_NODE_ID, property: "video", type: "video_list" },
      ],
    },
    outputs: [{ key: "result", label: "完整成片（原生有声）", type: "video_list", description: "导演台按分镜顺序生成并自动拼接的整片；上下文续接与帧网格由工程节点内部处理" }],
    review: { enabled: false },
  };
}

export const DIRECTOR_CONSOLE_OUTPUTS = [
  { key: "video", label: "完整成片", type: "video_list" as const, sourceRef: "step.console.outputs.result" },
  { key: "storyboard", label: "制作级分镜脚本", type: "text" as const, sourceRef: "step.writer.outputs.storyboard" },
  { key: "shots", label: "实际分镜、最终提示词与参考素材映射", type: "json" as const, sourceRef: "step.records.outputs.rows" },
  { key: "manifest", label: "生成计划", type: "json" as const, sourceRef: "step.console_plan.outputs.manifest" },
];

/** Configuration-only migration: per-shot SelfLift run becomes one director-console project run. */
export function migrateLongTextToDirectorConsole(workflow: RunWorkflowDefinition, nodes: ComfyUIWorkflowNode[]) {
  assert.equal(workflow.sceneId, "scene_long_text_to_video", "Only the long-text-to-video scene is migrated");
  const editor = nodes.find(node => node.type === "easy multiTrackEditor");
  assert.ok(editor && editor.id === DIRECTOR_EDITOR_NODE_ID, "导演台工作流必须只有一个 id 为 14 的 easy multiTrackEditor");
  const project = nodes.find(node => node.type === "easy multitrackProject");
  assert.ok(project && project.id === DIRECTOR_PROJECT_NODE_ID, "导演台工作流必须只有一个 id 为 15 的 easy multitrackProject");
  const save = nodes.find(node => node.type === "SaveVideo");
  assert.ok(save && save.id === DIRECTOR_SAVE_NODE_ID, "导演台工作流必须只有一个 id 为 63 的 SaveVideo");
  for (const [label, property] of [["track_data", "track_data"], ["aspect_ratio", "resolution.aspect_ratio"], ["megapixels", "resolution.megapixels"]] as const) {
    assert.ok(editor.inputProperties.includes(property), `导演台编辑器缺少 ${label} 输入属性`);
  }
  for (const property of ["project_name", "segment_start_number", "segment_count"] as const) {
    assert.ok(project.inputProperties.includes(property), `导演台工程节点缺少 ${property} 输入属性`);
  }
  assert.ok(save.outputProperties.includes("video"), "导演台 SaveVideo 缺少 video 输出属性");

  const next = structuredClone(workflow);
  const stepIds = next.steps.map(step => step.id);
  assert.deepEqual(stepIds, ["writer", "aixg", "align", "references", "records", "generate", "assemble"], "长文出视频步骤结构已变化，请先核对再迁移");
  const generate = next.steps.find(step => step.id === "generate")!;
  assert.equal(generate.kind, "comfyui", "generate 步骤类型已变化");
  assert.equal(generate.capabilityId, "core.comfyui", "generate 步骤能力已变化");
  assert.equal(generate.comfyui?.workflowFile, LEGACY_GENERATE_WORKFLOW_FILE, "generate 步骤已切换到其他 ComfyUI 工作流，不覆盖自定义配置");
  assert.equal(generate.execution?.mode, "for_each", "generate 必须仍是逐镜执行才会被迁移");
  assert.equal(generate.execution?.sourceRef, "step.records.outputs.rows", "generate 遍历来源已变化");
  const assemble = next.steps.find(step => step.id === "assemble")!;
  assert.equal(assemble.capabilityId, "media.video_concat", "assemble 步骤已变化");
  const legacyOutputs = new Map((next.outputs ?? []).map(output => [output.key, output.sourceRef]));
  assert.deepEqual([...legacyOutputs.keys()].sort(), ["clips", "download", "manifest", "shots", "storyboard", "video"], "场景输出已变化，请先核对再迁移");
  assert.equal(legacyOutputs.get("video"), "step.assemble.outputs.video", "video 输出来源已变化");
  assert.equal(legacyOutputs.get("clips"), "step.generate.outputs.result", "clips 输出来源已变化");
  assert.equal(legacyOutputs.get("manifest"), "step.assemble.outputs.manifest", "manifest 输出来源已变化");
  assert.equal(legacyOutputs.get("storyboard"), "step.writer.outputs.storyboard", "storyboard 输出来源已变化");
  assert.equal(legacyOutputs.get("shots"), "step.records.outputs.rows", "shots 输出来源已变化");

  const consoleStep = buildConsoleStep();
  const index = next.steps.findIndex(step => step.id === "generate");
  next.steps.splice(index, 1, consoleStep);
  next.steps.splice(index, 0, buildConsolePlanStep(), buildConsoleInputStep());
  next.steps = next.steps.filter(step => step.id !== "assemble");
  next.outputs = DIRECTOR_CONSOLE_OUTPUTS.map(output => ({ ...output, description: (next.outputs ?? []).find(item => item.key === output.key)?.description ?? "" }));
  validateWorkflowShape(next as unknown as Record<string, unknown>);
  return next;
}
