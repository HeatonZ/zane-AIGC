import assert from "node:assert/strict";
import type { ComfyUIWorkflowNode, RunComfyBinding, RunStep, RunWorkflowDefinition } from "./types.js";
import { validateWorkflowShape } from "./workflowValidation.js";

/** Director-console workflow (ComfyUI-Easy-Media multi-track project) drives the whole film in one run. */
export const DIRECTOR_CONSOLE_WORKFLOW_FILE = "Zane/MiniMaxH3-极简导演台+.json";
const DIRECTOR_EDITOR_NODE_ID = "14";
const DIRECTOR_PROJECT_NODE_ID = "15";
const DIRECTOR_SAVE_NODE_ID = "63";
const DIRECTOR_AUDIO_SLOTS = 10;

/**
 * core.code sandbox source for the merged director-console preparation. It consumes the
 * Writer shots, the AIXG prompts and the read-only media projections, and emits the
 * console TRACK_DATA, an isolated project name and a plan manifest.
 *
 * Media files never enter the sandbox: only their count, order and file name do. The step
 * therefore emits slot references (`imageN` / `audioN`) instead of paths, and the final
 * ComfyUI step binds the original asset lists straight into the editor node. Slot order is
 * fixed by the binding order of that step: characters, then scenes, then props for images,
 * and the global voice order for audio.
 */
export const DIRECTOR_CONSOLE_PREPARE_CODE = [
  "// 导演台（Easy-Media 多轨工程）时间线构建。媒体只以 [{filename}] 只读投影进入，",
  "// 因此这里只生成槽位引用；真实文件由最终 ComfyUI 步骤绑定到编辑器的 image/audio 输入。",
  "const FRAME_RATE = 24;",
  "const IMAGE_KEYS = [\"characters\", \"scenes\", \"props\"];",
  "const GROUP_KEYS = [\"characters\", \"scenes\", \"props\", \"voices\"];",
  "const fail = (message) => { throw new Error(message); };",
  "const record = (value) => (value && typeof value === \"object\" && !Array.isArray(value) ? value : null);",
  "const integerList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === \"number\" && Number.isSafeInteger(item)) : []);",
  "const fileNames = (value) => (Array.isArray(value) ? value.map((item) => { const entry = record(item); return entry && typeof entry.filename === \"string\" ? entry.filename : \"\"; }).filter((name) => Boolean(name)) : []);",
  "const shots = inputs.shots;",
  "const prompts = inputs.prompts;",
  "if (!Array.isArray(shots) || !shots.length) fail(\"Writer 分镜不能为空\");",
  "if (!Array.isArray(prompts)) fail(\"AIXG 提示词必须是与分镜等长的数组\");",
  "if (prompts.length !== shots.length) fail(\"AIXG 提示词数量（\" + prompts.length + \"）与 Writer 分镜数量（\" + shots.length + \"）不一致\");",
  "if (shots.length > 360) fail(\"导演台单次运行最多 360 个分镜，请拆成多集\");",
  "const characters = fileNames(inputs.characters);",
  "const scenes = fileNames(inputs.scenes);",
  "const props = fileNames(inputs.props);",
  "const voices = fileNames(inputs.voices);",
  "const bases = { characters: 1, scenes: 1 + characters.length, props: 1 + characters.length + scenes.length };",
  "const labels = { characters: \"人物\", scenes: \"场景\", props: \"道具\", voices: \"参考音色\" };",
  "const limits = { characters: 4, scenes: 1, props: 4, voices: 3 };",
  "const tags = { characters: \"Character\", scenes: \"Scene\", props: \"Prop\", voices: \"Voice\" };",
  "const counts = { characters: characters.length, scenes: scenes.length, props: props.length, voices: voices.length };",
  "const plans = [];",
  "for (let position = 0; position < shots.length; position += 1) {",
  "  const index = position + 1;",
  "  const shot = record(shots[position]);",
  "  if (!shot) fail(\"第 \" + index + \" 条分镜无效\");",
  "  if (shot.index !== index) fail(\"分镜 index 必须从 1 开始连续递增，第 \" + index + \" 条为 \" + shot.index);",
  "  const seconds = shot.seconds;",
  "  if (typeof seconds !== \"number\" || !(seconds >= 5 && seconds <= 15)) fail(\"分镜 \" + index + \" 的时长需要在 5 到 15 秒之间\");",
  "  const selection = record(shot.selection);",
  "  if (!selection) fail(\"分镜 \" + index + \" 缺少素材选择 selection\");",
  "  const chosen = {};",
  "  let pictures = 0;",
  "  for (const key of GROUP_KEYS) {",
  "    const list = [...integerList(selection[key])].sort((left, right) => left - right);",
  "    if (list.length > limits[key]) fail(\"分镜 \" + index + \" 最多引用 \" + limits[key] + \" 项\" + labels[key]);",
  "    if (new Set(list).size !== list.length) fail(\"分镜 \" + index + \" 的\" + labels[key] + \"引用编号重复\");",
  "    for (const ordinal of list) if (ordinal < 1 || ordinal > counts[key]) fail(\"分镜 \" + index + \" 引用了不存在的\" + labels[key] + \"素材 \" + ordinal + \"（共 \" + counts[key] + \" 项）\");",
  "    chosen[key] = list;",
  "    if (key !== \"voices\") pictures += list.length;",
  "  }",
  "  if (pictures > 9) fail(\"分镜 \" + index + \" 最多引用 9 张人物/场景/道具图，请拆镜头\");",
  "  const prompt = prompts[position];",
  "  if (typeof prompt !== \"string\" || !prompt.trim()) fail(\"分镜 \" + index + \" 缺少 AIXG 提示词\");",
  "  if (prompt.length > 32000) fail(\"分镜 \" + index + \" 的提示词超过 32000 字\");",
  "  plans.push({ index, seconds, chosen, pictures, prompt });",
  "}",
  "// 工程节点把全部公用音色一次性交给每个镜头，因此 <Audio n> 按全局使用序号升序编号。",
  "const usedVoices = [...new Set(plans.flatMap((plan) => plan.chosen.voices))].sort((left, right) => left - right);",
  "const audioRank = new Map(usedVoices.map((ordinal, position) => [ordinal, position + 1]));",
  "const audioSlotOf = (ordinal) => \"audio\" + audioRank.get(ordinal);",
  "let cursor = 0;",
  "const taskSegments = [];",
  "const planSegments = [];",
  "const audioRanges = new Map();",
  "for (const plan of plans) {",
  "  const index = plan.index;",
  "  const frames = Math.max(1, Math.round(plan.seconds * FRAME_RATE));",
  "  const startFrame = cursor;",
  "  cursor += frames;",
  "  const pictureSlots = [];",
  "  for (const key of IMAGE_KEYS) plan.chosen[key].forEach((ordinal) => {",
  "    pictureSlots.push({ tag: tags[key], ordinal, slot: \"image\" + (bases[key] + ordinal - 1) });",
  "  });",
  "  const images = pictureSlots.map((entry, pictureIndex) => ({",
  "    id: \"shot-\" + index + \"-image-\" + (pictureIndex + 1),",
  "    source_type: \"slot\",",
  "    slot_name: entry.slot,",
  "    file_name: entry.slot,",
  "  }));",
  "  const audioSlots = [];",
  "  const audioReferences = [];",
  "  for (const ordinal of plan.chosen.voices) {",
  "    const slot = audioSlotOf(ordinal);",
  "    audioSlots.push(slot);",
  "    audioReferences.push(\"<Audio \" + audioRank.get(ordinal) + \">\");",
  "    const ranges = audioRanges.get(slot) ?? [];",
  "    ranges.push([startFrame, cursor]);",
  "    audioRanges.set(slot, ranges);",
  "  }",
  "  // 全局资产标记按本镜头选中顺序编译成局部编号；图片槽位即全局合并顺序。",
  "  const prompt = plan.prompt.replace(/<(Character|Scene|Prop|Voice)\\s+(\\d+)>/g, (match, tag, number) => {",
  "    void match;",
  "    const ordinal = Number(number);",
  "    if (tag === \"Voice\") {",
  "      if (!plan.chosen.voices.includes(ordinal)) fail(\"分镜 \" + index + \" 的提示词引用了未选中的 <Voice \" + ordinal + \">\");",
  "      return \"<Audio \" + audioRank.get(ordinal) + \">\";",
  "    }",
  "    const pictureIndex = pictureSlots.findIndex((entry) => entry.tag === tag && entry.ordinal === ordinal);",
  "    if (pictureIndex < 0) fail(\"分镜 \" + index + \" 的提示词引用了未选中的 <\" + tag + \" \" + ordinal + \">\");",
  "    return \"<Picture \" + (pictureIndex + 1) + \">\";",
  "  });",
  "  for (const match of prompt.matchAll(/<Picture\\s+(\\d+)>/g)) if (Number(match[1]) < 1 || Number(match[1]) > plan.pictures) fail(\"分镜 \" + index + \" 引用了不存在的图片 <Picture \" + match[1] + \">\");",
  "  for (const match of prompt.matchAll(/<Audio\\s+(\\d+)>/g)) {",
  "    const rank = Number(match[1]);",
  "    if (!audioReferences.includes(\"<Audio \" + rank + \">\")) fail(\"分镜 \" + index + \" 引用了不存在的参考音色 <Audio \" + rank + \">\");",
  "  }",
  "  const taskType = images.length || audioSlots.length ? \"r2v\" : \"t2v\";",
  "  const continuityMode = taskSegments.length === 0 ? \"shot\" : \"context\";",
  "  taskSegments.push({",
  "    id: \"shot-\" + index,",
  "    start_frame: startFrame,",
  "    end_frame: cursor,",
  "    color: \"var(--multitrack-task-bg)\",",
  "    content: {",
  "      media_type: \"none\",",
  "      task_mode: taskType === \"r2v\" ? \"ref\" : \"default\",",
  "      task_type: taskType,",
  "      continuity_mode: continuityMode,",
  "      ref_image_size: \"match\",",
  "      images,",
  "      user_prompt: prompt,",
  "      system_prompt: \"\",",
  "      user_prompt_variant: \"a\",",
  "      user_prompt_b: \"\",",
  "      muted: false,",
  "      volume_db: 0,",
  "    },",
  "  });",
  "  planSegments.push({ index, seconds: plan.seconds, frames, start_frame: startFrame, end_frame: cursor, continuity_mode: continuityMode, characters: plan.chosen.characters, scenes: plan.chosen.scenes, props: plan.chosen.props, voices: plan.chosen.voices, picture_slots: pictureSlots.map((entry) => entry.slot), audio_slots: audioSlots });",
  "}",
  "const tracks = [{ id: \"task-track\", name: \"Tasks\", type: \"task\", color: \"var(--multitrack-task-bg)\", muted: false, locked: false, segments: taskSegments }];",
  "for (const ordinal of usedVoices) {",
  "  const slot = audioSlotOf(ordinal);",
  "  tracks.push({",
  "    id: \"audio-track-\" + ordinal,",
  "    name: \"Voice \" + ordinal,",
  "    type: \"audio\",",
  "    color: \"var(--highlight)\",",
  "    muted: false,",
  "    solo: false,",
  "    volume_db: 0,",
  "    locked: false,",
  "    segments: (audioRanges.get(slot) ?? []).map((range, rangeIndex) => ({",
  "      id: \"audio-\" + ordinal + \"-\" + (rangeIndex + 1),",
  "      start_frame: range[0],",
  "      end_frame: range[1],",
  "      origin_start_frame: range[0],",
  "      color: \"var(--highlight)\",",
  "      content: { media_type: \"audio\", source_type: \"slot\", slot_name: slot, file_name: slot, shared_reference: true, muted: false, volume_db: 0 },",
  "    })),",
  "  });",
  "}",
  "const trackData = { muted: false, volume_db: 0, task_markers: [], task_overview: false, tracks, total_length: cursor, frame_rate: FRAME_RATE };",
  "const projectName = \"zane-ltv-\" + Date.now().toString(36) + \"-\" + Math.random().toString(36).slice(2, 8);",
  "const manifest = {",
  "  format: \"zane.director-console-plan/v1\",",
  "  frame_rate: FRAME_RATE,",
  "  segment_count: plans.length,",
  "  total_frames: cursor,",
  "  total_seconds: cursor / FRAME_RATE,",
  "  music_added: false,",
  "  native_audio: true,",
  "  image_slot_count: characters.length + scenes.length + props.length,",
  "  audio_slot_count: usedVoices.length,",
  "  segments: planSegments,",
  "};",
  "return { track_data: JSON.stringify(trackData), project_name: projectName, manifest };",
].join("\n");

/** One custom-code step replaces alignment, reference mapping, record building and the old plan step. */
function buildPrepareConsoleStep(): RunWorkflowDefinition["steps"][number] {
  return {
    id: "prepare_console",
    name: "导演台 · 分镜对齐、素材映射与多轨时间线",
    kind: "capability",
    capabilityId: "core.code",
    capabilityVersion: "1",
    inputs: [
      { key: "shots", label: "Writer 制作分镜", sourceRef: "step.writer.outputs.shots", valueSource: "reference" },
      { key: "prompts", label: "AIXG 逐镜提示词", sourceRef: "step.aixg.outputs.prompts", valueSource: "reference" },
      { key: "characters", label: "人物资产（图片槽位从 1 开始）", sourceRef: "input.character_assets", valueSource: "reference" },
      { key: "scenes", label: "场景资产（紧随人物图片）", sourceRef: "input.scene_assets", valueSource: "reference" },
      { key: "props", label: "道具资产（紧随场景图片）", sourceRef: "input.prop_assets", valueSource: "reference" },
      { key: "voices", label: "参考音色（按上传顺序编号）", sourceRef: "input.voice_reference_audio", valueSource: "reference" },
    ],
    capabilityConfig: { code: DIRECTOR_CONSOLE_PREPARE_CODE, timeoutMs: 20000 },
    outputs: [
      { key: "track_data", label: "导演台时间线 TRACK_DATA", type: "text", description: "任务轨按分镜时长连续排布，首镜 shot、其余 context；图片与音色用槽位引用，实际媒体由最终 ComfyUI 步骤绑定" },
      { key: "project_name", label: "ComfyUI 工程名", type: "text", description: "按运行隔离，避免并发或重跑相互覆盖" },
      { key: "manifest", label: "生成计划", type: "json", description: "分段帧数、衔接模式与素材槽位映射；不含提示词正文" },
    ],
  };
}

function buildConsoleStep(audioListNodeId: string): RunStep {
  const bindings: RunComfyBinding[] = [
    { key: "track_data", label: "导演台时间线", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "track_data", type: "text", required: true, sourceRef: "step.prepare_console.outputs.track_data", valueSource: "reference" },
    { key: "ratio", label: "画幅", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "resolution.aspect_ratio", type: "text", required: true, sourceRef: "input.ratio", valueSource: "reference" },
    { key: "mp", label: "生成像素（百万像素）", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "resolution.megapixels", type: "number", required: true, sourceRef: "input.mp", valueSource: "reference" },
    // Image bindings share one port and are appended in binding order: characters → scenes → props.
    { key: "characters", label: "人物资产图片", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "image", type: "image_list", required: true, sourceRef: "input.character_assets", valueSource: "reference" },
    { key: "scenes", label: "场景资产图片", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "image", type: "image_list", required: false, sourceRef: "input.scene_assets", valueSource: "reference" },
    { key: "props", label: "道具资产图片", direction: "input", nodeId: DIRECTOR_EDITOR_NODE_ID, property: "image", type: "image_list", required: false, sourceRef: "input.prop_assets", valueSource: "reference" },
    ...Array.from({ length: DIRECTOR_AUDIO_SLOTS }, (_unused, index) => ({
      key: `voice_${index + 1}`,
      label: `参考音色 ${index + 1}`,
      direction: "input" as const,
      nodeId: audioListNodeId,
      property: `audio${index + 1}`,
      type: "audio",
      required: false,
      sourceRef: "input.voice_reference_audio",
      valueSource: "reference" as const,
      selection: { mode: "item" as const, index },
    })),
    { key: "project_name", label: "工程名（按运行隔离）", direction: "input", nodeId: DIRECTOR_PROJECT_NODE_ID, property: "project_name", type: "text", required: true, sourceRef: "step.prepare_console.outputs.project_name", valueSource: "reference" },
    { key: "segment_start_number", label: "起始分镜号", direction: "input", nodeId: DIRECTOR_PROJECT_NODE_ID, property: "segment_start_number", type: "number", required: true, valueSource: "literal", literalValue: "1" },
    { key: "segment_count", label: "生成分镜数（-1 为全部）", direction: "input", nodeId: DIRECTOR_PROJECT_NODE_ID, property: "segment_count", type: "number", required: true, valueSource: "literal", literalValue: "-1" },
    { key: "result", label: "完整成片（原生有声）", direction: "output", nodeId: DIRECTOR_SAVE_NODE_ID, property: "video", type: "video_list" },
  ];
  return {
    id: "console",
    name: "导演台 · 单工作流整片顺序续接（原生有声）",
    kind: "comfyui",
    capabilityId: "core.comfyui",
    capabilityVersion: "1",
    inputs: [
      { key: "track_data", label: "导演台时间线", sourceRef: "step.prepare_console.outputs.track_data", valueSource: "reference" },
      { key: "ratio", label: "画幅", sourceRef: "input.ratio", valueSource: "reference" },
      { key: "mp", label: "生成像素（百万像素）", sourceRef: "input.mp", valueSource: "reference" },
      { key: "characters", label: "人物资产图片", sourceRef: "input.character_assets", valueSource: "reference" },
      { key: "scenes", label: "场景资产图片", sourceRef: "input.scene_assets", valueSource: "reference" },
      { key: "props", label: "道具资产图片", sourceRef: "input.prop_assets", valueSource: "reference" },
      { key: "project_name", label: "工程名", sourceRef: "step.prepare_console.outputs.project_name", valueSource: "reference" },
    ],
    capabilityConfig: { outputMediaCounts: { result: 1 } },
    comfyui: { workflowFile: DIRECTOR_CONSOLE_WORKFLOW_FILE, bindings },
    outputs: [{ key: "result", label: "完整成片（原生有声）", type: "video_list", description: "导演台按分镜顺序生成并自动拼接的整片；上下文续接与帧网格由工程节点内部处理" }],
    review: { enabled: false },
  };
}

export const DIRECTOR_CONSOLE_OUTPUTS = [
  { key: "video", label: "完整成片", type: "video_list" as const, sourceRef: "step.console.outputs.result" },
  { key: "storyboard", label: "制作级分镜脚本", type: "text" as const, sourceRef: "step.writer.outputs.storyboard" },
  { key: "manifest", label: "分镜计划与素材槽位映射", type: "json" as const, sourceRef: "step.prepare_console.outputs.manifest" },
];

const KEPT_STEP_IDS = ["writer", "aixg"];
const MIGRATABLE_STEP_IDS = [
  ["writer", "aixg", "align", "references", "records", "generate", "assemble"],
  ["writer", "aixg", "align", "references", "records", "console_input", "console_plan", "console"],
];

/** Configuration-only migration: the five deterministic steps collapse into one custom-code step. */
export function migrateLongTextToDirectorConsole(workflow: RunWorkflowDefinition, nodes: ComfyUIWorkflowNode[]) {
  assert.equal(workflow.sceneId, "scene_long_text_to_video", "Only the long-text-to-video scene is migrated");
  const single = (type: string, label: string) => {
    const matches = nodes.filter(node => node.type === type);
    assert.equal(matches.length, 1, `导演台工作流必须只有一个 ${type} 节点`);
    assert.ok(matches[0], label);
    return matches[0]!;
  };
  const editor = single("easy multiTrackEditor", "导演台工作流必须只有一个 id 为 14 的 easy multiTrackEditor");
  assert.equal(editor.id, DIRECTOR_EDITOR_NODE_ID, "导演台编辑器节点 ID 必须是 14");
  const project = single("easy multitrackProject", "导演台工作流必须只有一个 id 为 15 的 easy multitrackProject");
  assert.equal(project.id, DIRECTOR_PROJECT_NODE_ID, "导演台工程节点 ID 必须是 15");
  const save = single("SaveVideo", "导演台工作流必须只有一个 id 为 63 的 SaveVideo");
  assert.equal(save.id, DIRECTOR_SAVE_NODE_ID, "导演台输出节点 ID 必须是 63");
  const audioList = single("easy makeAudioList", "导演台工作流必须只有一个 easy makeAudioList 音频列表节点；请先按 scripts/patch-director-console-comfyui-workflow.mjs 打补丁");
  for (const [label, property] of [["track_data", "track_data"], ["aspect_ratio", "resolution.aspect_ratio"], ["megapixels", "resolution.megapixels"], ["audio", "audio"]] as const) {
    assert.ok(editor.inputProperties.includes(property), `导演台编辑器缺少 ${label} 输入属性`);
  }
  for (const property of ["project_name", "segment_start_number", "segment_count"] as const) {
    assert.ok(project.inputProperties.includes(property), `导演台工程节点缺少 ${property} 输入属性`);
  }
  assert.ok(save.outputProperties.includes("video"), "导演台 SaveVideo 缺少 video 输出属性");

  const next = structuredClone(workflow);
  const stepIds = next.steps.map(step => step.id);
  assert.ok(MIGRATABLE_STEP_IDS.some(shape => shape.length === stepIds.length && shape.every((id, index) => id === stepIds[index])), "长文出视频步骤结构已变化，请先核对再迁移：" + stepIds.join(" → "));
  for (const id of KEPT_STEP_IDS) {
    const step = next.steps.find(candidate => candidate.id === id)!;
    assert.ok(step, `缺少步骤 ${id}`);
    assert.equal(step.kind, "hermes", `步骤 ${id} 类型已变化`);
    assert.equal(step.capabilityId, "core.hermes", `步骤 ${id} 能力已变化`);
  }
  next.steps = [
    ...next.steps.filter(step => KEPT_STEP_IDS.includes(step.id)),
    buildPrepareConsoleStep(),
    buildConsoleStep(audioList.id),
  ];
  next.name = "长文出视频 · Writer分镜与AIXG提示词 · 导演台单工程续接";
  next.outputs = DIRECTOR_CONSOLE_OUTPUTS;
  validateWorkflowShape(next as unknown as Record<string, unknown>);
  return next;
}
