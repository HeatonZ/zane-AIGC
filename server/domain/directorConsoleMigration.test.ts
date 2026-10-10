import assert from "node:assert/strict";
import test from "node:test";
import type { ComfyUIWorkflowNode, JsonValue, RunStep, RunWorkflowDefinition } from "./types.js";
import { DIRECTOR_CONSOLE_PREPARE_CODE, DIRECTOR_CONSOLE_WORKFLOW_FILE, migrateLongTextToDirectorConsole } from "./directorConsoleMigration.js";
import { executeCodeStep } from "../execution/codeSandbox.js";
import type { StepExecutionContext } from "../execution/workflowExecutor.js";

const LEGACY_FILE = "Zane/MiniMax+H3+真·上下文无缝无色差长视频，SelfLift双采(简易版)+.json";
const node = (id: string, type: string, inputs: string[] = [], outputs: string[] = []): ComfyUIWorkflowNode => ({ id, type, inputProperties: inputs, outputProperties: outputs });
const consoleNodes = [
  node("14", "easy multiTrackEditor", ["resolution", "resolution.aspect_ratio", "resolution.megapixels", "audio", "format", "track_data"], ["TRACKS_INFO"]),
  node("15", "easy multitrackProject", ["tracks_info", "model_loader", "project_name", "project_save", "segment_start_number", "segment_count"], ["PROJECT_NAME"]),
  node("17", "easy multitrackProjectVideoCombine", ["project_name", "project_data"], ["VIDEO", "FILENAME_PREFIX"]),
  node("63", "SaveVideo", ["video", "filename_prefix"], ["video"]),
  node("90", "easy makeAudioList", ["skip_empty"], ["AUDIO"]),
];
const consoleNodesAtDefault = consoleNodes.map(item => (item.id === "90" ? node("64", "easy makeAudioList", ["skip_empty"], ["AUDIO"]) : item));

function workflow(): RunWorkflowDefinition {
  const step = (id: string, kind: string, capabilityId: string, extra: Record<string, unknown> = {}) => ({ id, name: id, kind, capabilityId, capabilityVersion: "1", inputs: [], outputs: [], ...extra }) as RunWorkflowDefinition["steps"][number];
  return {
    sceneId: "scene_long_text_to_video",
    name: "长文出视频 · Writer分镜与AIXG提示词 · 单工作流续接",
    inputs: [{ key: "content", type: "textarea", required: true }, { key: "ratio", type: "select", required: true }, { key: "mp", type: "select", required: true }],
    steps: [
      step("writer", "hermes", "core.hermes", { outputs: [{ key: "storyboard", type: "text" }, { key: "shots", type: "json" }] }),
      step("aixg", "hermes", "core.hermes", { outputs: [{ key: "prompts", type: "json" }] }),
      step("align", "capability", "data.zip", { outputs: [{ key: "rows", type: "json" }] }),
      step("references", "capability", "media.select_references", { outputs: [{ key: "prompt", type: "text" }, { key: "bundle", type: "json" }] }),
      step("records", "capability", "data.zip", { outputs: [{ key: "rows", type: "json" }] }),
      step("generate", "comfyui", "core.comfyui", {
        comfyui: { workflowFile: LEGACY_FILE, bindings: [{ key: "prompt", label: "prompt", direction: "input", nodeId: "138", property: "value", type: "text", required: true, sourceRef: "iteration.item.prompt", valueSource: "reference" }] },
        execution: { mode: "for_each", sourceRef: "step.records.outputs.rows", onError: "stop", maxConcurrency: 1, carry: { outputKey: "result" } },
        outputs: [{ key: "result", type: "video_list" }],
      }),
      step("assemble", "capability", "media.video_concat", { inputs: [{ key: "clips", sourceRef: "step.generate.outputs.result" }], outputs: [{ key: "video", type: "video_list" }, { key: "manifest", type: "json" }] }),
    ],
    outputs: [
      { key: "video", type: "video_list", sourceRef: "step.assemble.outputs.video" },
      { key: "storyboard", type: "text", sourceRef: "step.writer.outputs.storyboard" },
      { key: "shots", type: "json", sourceRef: "step.records.outputs.rows" },
      { key: "manifest", type: "json", sourceRef: "step.assemble.outputs.manifest" },
    ],
  } as RunWorkflowDefinition;
}


test("导演台迁移：五个确定性步骤合并为一个自定义代码步骤，AI 两步与输入契约保持", () => {
  const before = workflow();
  const migrated = migrateLongTextToDirectorConsole(before, consoleNodesAtDefault);
  assert.deepEqual(migrated.steps.map(step => step.id), ["writer", "aixg", "prepare_console", "console"]);
  assert.deepEqual(migrated.steps.slice(0, 2), before.steps.slice(0, 2), "Writer 与 AIXG 两步不得改变");
  assert.deepEqual(migrated.inputs, before.inputs, "场景输入契约不得改变");
  assert.equal(migrated.steps.every(step => step.capabilityId !== "text.template"), true, "不得再使用文本模板执行方式");

  const prepare = migrated.steps.find(step => step.id === "prepare_console")!;
  assert.equal(prepare.capabilityId, "core.code");
  assert.ok(Buffer.byteLength(String(prepare.capabilityConfig?.code), "utf8") <= 64 * 1024, "自定义代码不能超过沙箱上限");
  assert.deepEqual(prepare.inputs!.map(input => input.key), ["shots", "prompts", "characters", "scenes", "props", "voices"]);
  assert.deepEqual(prepare.inputs!.map(input => input.sourceRef), ["step.writer.outputs.shots", "step.aixg.outputs.prompts", "input.character_assets", "input.scene_assets", "input.prop_assets", "input.voice_reference_audio"]);
  assert.deepEqual(prepare.outputs!.map(output => output.key), ["track_data", "project_name", "manifest"]);

  const consoleStep = migrated.steps.find(step => step.id === "console")!;
  assert.equal(consoleStep.kind, "comfyui");
  assert.equal(consoleStep.capabilityId, "core.comfyui");
  assert.equal(consoleStep.comfyui!.workflowFile, DIRECTOR_CONSOLE_WORKFLOW_FILE);
  assert.equal(consoleStep.execution, undefined, "导演台一次运行整片，不再逐镜");
  const bindings = consoleStep.comfyui!.bindings!;
  assert.deepEqual(bindings.filter(binding => binding.key === "track_data" || binding.key === "ratio" || binding.key === "mp").map(binding => [binding.nodeId, binding.property, binding.sourceRef]), [["14", "track_data", "step.prepare_console.outputs.track_data"], ["14", "resolution.aspect_ratio", "input.ratio"], ["14", "resolution.megapixels", "input.mp"]]);
  // Image bindings share the editor port and are appended in binding order.
  assert.deepEqual(bindings.filter(binding => binding.property === "image" && binding.direction === "input").map(binding => [binding.key, binding.nodeId, binding.type, binding.sourceRef]), [["characters", "14", "image_list", "input.character_assets"], ["scenes", "14", "image_list", "input.scene_assets"], ["props", "14", "image_list", "input.prop_assets"]]);
  assert.deepEqual(bindings.filter(binding => binding.property.startsWith("audio")).map(binding => [binding.key, binding.nodeId, binding.property, binding.selection?.index]), Array.from({ length: 10 }, (_unused, index) => [`voice_${index + 1}`, "64", `audio${index + 1}`, index]));
  assert.deepEqual(bindings.filter(binding => binding.nodeId === "15").map(binding => [binding.key, binding.property, binding.valueSource, binding.literalValue]), [["project_name", "project_name", "reference", undefined], ["segment_start_number", "segment_start_number", "literal", "1"], ["segment_count", "segment_count", "literal", "-1"]]);
  assert.deepEqual(bindings.filter(binding => binding.direction === "output").map(binding => [binding.nodeId, binding.property]), [["63", "video"]]);
  assert.deepEqual(migrated.outputs, [
    { key: "video", label: "完整成片", type: "video_list", sourceRef: "step.console.outputs.result" },
    { key: "storyboard", label: "制作级分镜脚本", type: "text", sourceRef: "step.writer.outputs.storyboard" },
    { key: "manifest", label: "分镜计划与素材槽位映射", type: "json", sourceRef: "step.prepare_console.outputs.manifest" },
  ]);
  assert.throws(() => migrateLongTextToDirectorConsole(migrated, consoleNodesAtDefault), /步骤结构已变化/, "已迁移流程不得被二次迁移");
});

test("导演台迁移：从当前已发布的八步流程继续合并，同样得到四步", () => {
  const published = workflow();
  published.steps = [
    ...published.steps.slice(0, 5),
    { id: "console_input", name: "序列化", kind: "capability", capabilityId: "text.template", capabilityVersion: "1", inputs: [], outputs: [{ key: "text", type: "text" }], capabilityConfig: { template: "{{rows}}" } },
    { id: "console_plan", name: "计划", kind: "capability", capabilityId: "core.code", capabilityVersion: "1", inputs: [], outputs: [{ key: "track_data", type: "text" }], capabilityConfig: { code: DIRECTOR_CONSOLE_PREPARE_CODE.slice(0, 24), timeoutMs: 10000 } },
    { id: "console", name: "导演台", kind: "comfyui", capabilityId: "core.comfyui", capabilityVersion: "1", inputs: [], outputs: [{ key: "result", type: "video_list" }], comfyui: { workflowFile: DIRECTOR_CONSOLE_WORKFLOW_FILE, bindings: [] } },
  ] as RunWorkflowDefinition["steps"];
  const migrated = migrateLongTextToDirectorConsole(published, consoleNodesAtDefault);
  assert.deepEqual(migrated.steps.map(step => step.id), ["writer", "aixg", "prepare_console", "console"]);
  assert.equal(migrated.steps.some(step => step.id === "console_input" || step.id === "console_plan"), false);
  assert.deepEqual(migrated.steps.slice(0, 2), published.steps.slice(0, 2));
});

test("导演台迁移：图形缺失或步骤被改动时 fail closed", () => {
  for (const mutate of [
    (flow: RunWorkflowDefinition) => { flow.sceneId = "scene_other"; },
    (flow: RunWorkflowDefinition) => { flow.steps = flow.steps.filter(step => step.id !== "assemble"); },
    (flow: RunWorkflowDefinition) => { flow.steps.splice(2, 1); },
  ]) {
    const flow = workflow();
    mutate(flow);
    assert.throws(() => migrateLongTextToDirectorConsole(flow, consoleNodesAtDefault));
  }
  assert.throws(() => migrateLongTextToDirectorConsole(workflow(), consoleNodes.filter(item => item.type !== "SaveVideo")), /SaveVideo/);
  assert.throws(() => migrateLongTextToDirectorConsole(workflow(), [...consoleNodesAtDefault, node("91", "SaveVideo", [], ["video"])]), /SaveVideo/);
  assert.throws(() => migrateLongTextToDirectorConsole(workflow(), consoleNodesAtDefault.filter(item => item.type !== "easy makeAudioList")), /easy makeAudioList/);
  assert.throws(() => migrateLongTextToDirectorConsole(workflow(), consoleNodesAtDefault.map(item => (item.id === "14" ? node("14", "easy multiTrackEditor", ["resolution", "format", "track_data"], ["TRACKS_INFO"]) : item))), /aspect_ratio|megapixels|audio|track_data/);
  assert.throws(() => migrateLongTextToDirectorConsole(workflow(), consoleNodesAtDefault.map(item => (item.id === "15" ? node("15", "easy multitrackProject", ["tracks_info", "model_loader", "project_name"], ["PROJECT_NAME"]) : item))), /segment_start_number/);
});

function prepareStep(): RunStep {
  const migrated = migrateLongTextToDirectorConsole(workflow(), consoleNodesAtDefault);
  const step = migrated.steps.find(candidate => candidate.id === "prepare_console")!;
  return { ...step, inputs: step.inputs!.map(input => ({ ...input, sourceRef: "input." + input.key })) } as RunStep;
}
function codeContext(values: Record<string, JsonValue>): StepExecutionContext {
  return {
    runInputValues: {}, runId: "test", artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" },
    step: prepareStep(), inputValues: values, stepValues: new Map(), types: new Map(),
    settings: { projectDirectory: "", comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] }, inputFields: [],
    signal: AbortSignal.timeout(30000),
  } as StepExecutionContext;
}
const shot = (index: number, seconds: number, selection: Record<string, number[]>) => ({ index, seconds, selection, purpose: "执行任务 " + index, visual_description: "人物看向门口", continuity_in: "人物右手放在桌上", continuity_out: "人物抬眼", dialogue: [] });
const localPrompt = (pictures: number[], audios: number[]) => [
  "subject_definitions:",
  pictures.map(index => `<Picture ${index}>`).join(" ") + " 位于场景中。",
  "detailed_description:",
  "0-5秒，中近景，人物看向门口，正常说话：信到了。",
  "overall_soundscape:",
  audios.map(index => `<Audio ${index}>`).join("") + " 的音色说：信到了。纸张摩擦声。",
  "non_diegetic_music:",
  "N/A",
].join("\n");
const baseValues = (shots: unknown[], prompts: string[], counts = { characters: 3, scenes: 2, props: 2, voices: 3 }) => ({
  shots: shots as JsonValue,
  prompts: prompts as unknown as JsonValue,
  characters: Array.from({ length: counts.characters }, (_unused, index) => ({ filename: `char-${index + 1}.png` })) as unknown as JsonValue,
  scenes: Array.from({ length: counts.scenes }, (_unused, index) => ({ filename: `scene-${index + 1}.png` })) as unknown as JsonValue,
  props: Array.from({ length: counts.props }, (_unused, index) => ({ filename: `prop-${index + 1}.png` })) as unknown as JsonValue,
  voices: Array.from({ length: counts.voices }, (_unused, index) => ({ filename: `voice-${index + 1}.wav` })) as unknown as JsonValue,
});

test("导演台合并计划：分镜变连续任务轨，图片与音色改用全局槽位引用", async () => {
  const shots = [
    shot(1, 5, { characters: [2], scenes: [1], props: [], voices: [2] }),
    shot(2, 10.4, { characters: [1], scenes: [1], props: [1, 2], voices: [1, 3] }),
    shot(3, 15, { characters: [1], scenes: [1], props: [], voices: [] }),
  ];
  // Writer 写全局资产标记，AIXG 保留全局标记；本步骤负责转成本地编号。
  const prompts = [
    localPrompt([1, 2], [1]).replace("<Picture 1>", "<Character 2>").replace("<Picture 2>", "<Scene 1>").replace("<Audio 1>", "<Voice 2>"),
    localPrompt([1, 2, 3, 4], [1, 2]).replace("<Picture 1>", "<Character 1>").replace("<Picture 2>", "<Scene 1>").replace("<Picture 3>", "<Prop 1>").replace("<Picture 4>", "<Prop 2>").replace("<Audio 1>", "<Voice 1>").replace("<Audio 2>", "<Voice 3>"),
    localPrompt([1, 2], []).replace("<Picture 1>", "<Character 1>").replace("<Picture 2>", "<Scene 1>"),
  ];
  const result = await executeCodeStep(codeContext(baseValues(shots, prompts))) as Record<string, JsonValue>;
  const trackData = JSON.parse(String(result.track_data));
  assert.equal(trackData.frame_rate, 24);
  assert.equal(trackData.total_length, 120 + 250 + 360);
  assert.equal(trackData.tracks[0].type, "task");
  const tasks = trackData.tracks[0].segments;
  assert.deepEqual(tasks.map((segment: Record<string, JsonValue>) => [segment.start_frame, segment.end_frame, (segment.content as Record<string, JsonValue>).continuity_mode, (segment.content as Record<string, JsonValue>).task_type]), [[0, 120, "shot", "r2v"], [120, 370, "context", "r2v"], [370, 730, "context", "r2v"]]);
  // 图片槽位 = 人物(1..3) + 场景(4..5) + 道具(6..7) 的全局顺序。
  assert.deepEqual((tasks[0].content as Record<string, JsonValue>).images as Array<Record<string, string>>, [
    { id: "shot-1-image-1", source_type: "slot", slot_name: "image2", file_name: "image2" },
    { id: "shot-1-image-2", source_type: "slot", slot_name: "image4", file_name: "image4" },
  ]);
  assert.deepEqual((tasks[1].content as Record<string, JsonValue>).images as Array<Record<string, string>>, [
    { id: "shot-2-image-1", source_type: "slot", slot_name: "image1", file_name: "image1" },
    { id: "shot-2-image-2", source_type: "slot", slot_name: "image4", file_name: "image4" },
    { id: "shot-2-image-3", source_type: "slot", slot_name: "image6", file_name: "image6" },
    { id: "shot-2-image-4", source_type: "slot", slot_name: "image7", file_name: "image7" },
  ]);
  assert.equal((tasks[0].content as Record<string, JsonValue>).local_path, undefined, "沙箱不得写本地路径");
  // 音色轨按全局使用序号升序；槽位与 <Audio n> 编号一致。
  assert.deepEqual(trackData.tracks.slice(1).map((track: Record<string, JsonValue>) => [track.id, track.type, (track.segments as Array<Record<string, JsonValue>>)[0].content]), [
    ["audio-track-1", "audio", { media_type: "audio", source_type: "slot", slot_name: "audio1", file_name: "audio1", shared_reference: true, muted: false, volume_db: 0 }],
    ["audio-track-2", "audio", { media_type: "audio", source_type: "slot", slot_name: "audio2", file_name: "audio2", shared_reference: true, muted: false, volume_db: 0 }],
    ["audio-track-3", "audio", { media_type: "audio", source_type: "slot", slot_name: "audio3", file_name: "audio3", shared_reference: true, muted: false, volume_db: 0 }],
  ]);
  assert.deepEqual((trackData.tracks[1].segments as Array<Record<string, JsonValue>>).map(segment => [segment.start_frame, segment.end_frame, segment.origin_start_frame]), [[120, 370, 120]]);
  assert.deepEqual((trackData.tracks[2].segments as Array<Record<string, JsonValue>>).map(segment => [segment.start_frame, segment.end_frame]), [[0, 120]]);
  assert.deepEqual((trackData.tracks[3].segments as Array<Record<string, JsonValue>>).map(segment => [segment.start_frame, segment.end_frame]), [[120, 370]]);
  assert.equal((tasks[0].content as Record<string, JsonValue>).user_prompt, localPrompt([1, 2], [2]));
  assert.equal((tasks[1].content as Record<string, JsonValue>).user_prompt, localPrompt([1, 2, 3, 4], [1, 3]));
  const manifest = result.manifest as Record<string, JsonValue>;
  assert.equal(manifest.format, "zane.director-console-plan/v1");
  assert.equal(manifest.segment_count, 3);
  assert.equal(manifest.total_frames, 730);
  assert.equal(manifest.music_added, false);
  assert.equal(manifest.image_slot_count, 7);
  assert.equal(manifest.audio_slot_count, 3);
  assert.deepEqual((manifest.segments as Array<Record<string, JsonValue>>).map(item => [item.index, item.seconds, item.frames, item.continuity_mode, item.picture_slots, item.audio_slots]), [
    [1, 5, 120, "shot", ["image2", "image4"], ["audio2"]],
    [2, 10.4, 250, "context", ["image1", "image4", "image6", "image7"], ["audio1", "audio3"]],
    [3, 15, 360, "context", ["image1", "image4"], []],
  ]);
  assert.match(String(result.project_name), /^zane-ltv-[a-z0-9]+-[a-z0-9]+$/);
  assert.notEqual(result.project_name, (await executeCodeStep(codeContext(baseValues(shots, prompts)))).project_name);
});

test("导演台合并计划：未选中的全局标记、幽灵引用、断号与越界素材都是明确错误", async () => {
  const shots = [shot(1, 5, { characters: [1], scenes: [1], props: [], voices: [] })];
  const prompt = localPrompt([1, 2], []);
  const cases: Array<[string, Record<string, JsonValue>, RegExp]> = [
    ["提示词数量不符", baseValues(shots, [prompt, prompt]), /提示词数量/],
    ["分镜断号", baseValues([shot(2, 5, { characters: [1], scenes: [1], props: [], voices: [] })], [prompt]), /index/],
    ["时长越界", baseValues([shot(1, 4.9, { characters: [1], scenes: [1], props: [], voices: [] })], [prompt]), /5 到 15 秒/],
    ["时长越界上界", baseValues([shot(1, 15.1, { characters: [1], scenes: [1], props: [], voices: [] })], [prompt]), /5 到 15 秒/],
    ["素材不存在", baseValues([shot(1, 5, { characters: [4], scenes: [1], props: [], voices: [] })], [prompt]), /不存在的人物/],
    ["音色不存在", baseValues([shot(1, 5, { characters: [1], scenes: [1], props: [], voices: [4] })], [prompt]), /不存在的参考音色/],
    ["音色超过 3 条", baseValues([shot(1, 5, { characters: [1], scenes: [1], props: [], voices: [1, 2, 3, 4] })], [prompt]), /最多引用 3 项参考音色/],
    ["引用编号重复", baseValues([shot(1, 5, { characters: [1, 1], scenes: [1], props: [], voices: [] })], [prompt]), /引用编号重复/],
    ["未选中的全局标记", baseValues(shots, [prompt.replace("<Picture 1>", "<Character 3>")]), /未选中的 <Character 3>/],
    ["幽灵图片编号", baseValues(shots, [prompt.replace("<Picture 2>", "<Picture 5>")]), /不存在的图片 <Picture 5>/],
    ["幽灵音色编号", baseValues([shot(1, 5, { characters: [1], scenes: [1], props: [], voices: [1] })], [localPrompt([1, 2], [1, 3]).replace("<Picture 1>", "<Character 1>").replace("<Picture 2>", "<Scene 1>").replace("<Audio 1>", "<Voice 1>")]), /不存在的参考音色 <Audio 3>/],
    ["缺少提示词", baseValues(shots, ["   "]), /缺少 AIXG 提示词/],
    ["分镜为空", baseValues([], []), /Writer 分镜不能为空/],
  ];
  for (const [, values, pattern] of cases) await assert.rejects(executeCodeStep(codeContext(values as Record<string, JsonValue>)), pattern);
  const emptyAssets = baseValues(shots, [prompt], { characters: 0, scenes: 0, props: 0, voices: 0 });
  await assert.rejects(executeCodeStep(codeContext(emptyAssets)), /不存在的人物/);
});

test("导演台合并计划：空音色列表时没有音轨，纯图镜头仍可生成", async () => {
  const shots = [shot(1, 6, { characters: [1], scenes: [1], props: [], voices: [] })];
  const prompt = localPrompt([1, 2], []).replace("<Picture 1>", "<Character 1>").replace("<Picture 2>", "<Scene 1>");
  const values = baseValues(shots, [prompt], { characters: 1, scenes: 1, props: 0, voices: 0 });
  const result = await executeCodeStep(codeContext(values)) as Record<string, JsonValue>;
  const trackData = JSON.parse(String(result.track_data));
  assert.equal(trackData.tracks.length, 1);
  assert.equal((result.manifest as Record<string, JsonValue>).audio_slot_count, 0);
  assert.equal((trackData.tracks[0].segments[0].content as Record<string, JsonValue>).user_prompt, localPrompt([1, 2], []));
});
