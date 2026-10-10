import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { migrateLongTextToDirectorConsole } from "../server/domain/directorConsoleMigration.ts";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = path.resolve(os.tmpdir());
const FILM_ORDER_CODE = [
  "// 按分镜顺序整理成片：只做确定性数据整理，不生成新媒体文件，也不调用生成服务。",
  "const fail = (message) => { throw new Error(message); };",
  "const record = (value) => (value && typeof value === \"object\" && !Array.isArray(value) ? value : null);",
  "const clips = Array.isArray(inputs.clips) ? inputs.clips : [];",
  "const shots = Array.isArray(inputs.shots) ? inputs.shots : [];",
  "if (clips.length < 1 || clips.length > 360) fail(\"成片整理需要 1 到 360 个视频片段\");",
  "if (shots.length !== clips.length) fail(\"分镜数量（\" + shots.length + \"）与片段数量（\" + clips.length + \"）不一致，不能静默漏掉片段或乱序\");",
  "const rows = [];",
  "for (let position = 0; position < shots.length; position += 1) {",
  "  const shot = record(shots[position]);",
  "  if (!shot) fail(\"第 \" + (position + 1) + \" 条分镜无效\");",
  "  if (shot.index !== position + 1) fail(\"分镜 index 必须从 1 开始连续递增，第 \" + (position + 1) + \" 条为 \" + shot.index);",
  "  rows.push({ index: shot.index, seconds: typeof shot.seconds === \"number\" ? shot.seconds : null });",
  "}",
  "return { video: clips, manifest: { format: \"zane.film-order/v1\", count: clips.length, shots: rows } };",
].join("\n");
const temporary = path.resolve(await mkdtemp(path.join(parent, "zane-director-console-smoke-")));
const data = path.join(temporary, "data"), project = path.join(temporary, "project"), hermes = path.join(temporary, "hermes");
const directorWorkflow = path.resolve("D:/project/comfyui/new/ComfyUI/user/default/workflows/Zane/MiniMaxH3-极简导演台+.json");
const workflowFile = "Zane/MiniMaxH3-极简导演台+.json";
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg", ffprobe = process.env.FFPROBE_BIN || "ffprobe";
let child, exited, logs = "", writerCalls = 0, aixgCalls = 0;
const uploads = [];
const captured = [];

const shots = [
  { index: 1, seconds: 5, selection: { characters: [2], scenes: [1], props: [1], voices: [2] }, purpose: "确认收到信", visual_description: "人物看向桌上的信后抬眼", continuity_in: "人物右手放在信封旁", continuity_out: "人物抬眼，右手保持在桌上", dialogue: [{ speaker: "人物2", text: "信到了。", delivery: "克制", start: 1, end: 3 }] },
  { index: 2, seconds: 10, selection: { characters: [1], scenes: [1], props: [], voices: [1, 2] }, purpose: "把信递过去", visual_description: "近景，人物把信推向画面左侧", continuity_in: "人物抬眼，右手保持在桌上", continuity_out: "人物收手，信已递出", dialogue: [{ speaker: "人物1", text: "收到了就好。", delivery: "平稳", start: 1, end: 4 }] },
];
const h3Prompt = (character, voice, prop) => [
  "subject_definitions:",
  `<Character ${character}> 位于 <Scene 1>${prop ? "，手持 <Prop 1>" : ""}，声音参考 <Voice ${voice}>。`,
  "summary:",
  "人物确认收到信件。",
  "retention_analysis:",
  "保留参考人物外观、服装和场景光线。",
  "detailed_description:",
  "0-5秒，中近景，人物看向门口，正常说话：信到了。",
  "overall_soundscape:",
  `<Voice ${voice}> 对应人物的音色说：信到了。必要的纸张摩擦声。`,
  "non_diegetic_music:",
  "N/A",
].join("\n");
const prompts = [h3Prompt(2, 2, true), h3Prompt(1, 1, false)];


// Faithful node schemas for the nodes the director workflow uses, so the smoke also runs without ComfyUI.
const nodeSchemas = {
  "easy multiTrackEditor": {
    "required": {
      "resolution": [
        "COMFY_DYNAMICCOMBO_V3",
        {}
      ],
      "format": [
        "COMBO",
        {
          "options": [
            "None",
            "MiniMax"
          ]
        }
      ],
      "track_data": [
        "TRACK_DATA",
        {}
      ]
    },
    "optional": {
      "prompt_override": [
        "*",
        {}
      ],
      "image": [
        "IMAGE",
        {
          "lazy": true
        }
      ],
      "audio": [
        "AUDIO",
        {
          "lazy": true
        }
      ],
      "video": [
        "VIDEO",
        {
          "lazy": true
        }
      ]
    }
  },
  "easy makeAudioList": {
    "required": {
      "skip_empty": [
        "BOOLEAN",
        {}
      ]
    },
    "optional": {
      "audio1": [
        "AUDIO",
        {}
      ],
      "audio2": [
        "AUDIO",
        {}
      ],
      "audio3": [
        "AUDIO",
        {}
      ],
      "audio4": [
        "AUDIO",
        {}
      ],
      "audio5": [
        "AUDIO",
        {}
      ],
      "audio6": [
        "AUDIO",
        {}
      ],
      "audio7": [
        "AUDIO",
        {}
      ],
      "audio8": [
        "AUDIO",
        {}
      ],
      "audio9": [
        "AUDIO",
        {}
      ],
      "audio10": [
        "AUDIO",
        {}
      ]
    }
  },
  "easy multitrackProject": {
    "required": {
      "tracks_info": [
        "TRACKS_INFO",
        {}
      ],
      "model_loader": [
        "FAST_MODEL_LOADER",
        {}
      ],
      "project_name": [
        "STRING",
        {}
      ],
      "project_save": [
        "COMBO",
        {
          "options": [
            "new",
            "override"
          ]
        }
      ],
      "segment_start_number": [
        "INT",
        {}
      ],
      "segment_count": [
        "INT",
        {}
      ],
      "seed": [
        "INT",
        {}
      ],
      "sampling_plan": [
        "COMBO",
        {
          "options": [
            "fast",
            "medium"
          ]
        }
      ],
      "sampling_mode": [
        "COMFY_DYNAMICCOMBO_V3",
        {}
      ],
      "1st_pass_only": [
        "BOOLEAN",
        {}
      ],
      "disable_2nd_noise": [
        "BOOLEAN",
        {}
      ],
      "upscale_by": [
        "FLOAT",
        {}
      ],
      "upscale_model": [
        "COMBO",
        {
          "options": [
            "None"
          ]
        }
      ],
      "enabled_tiling": [
        "COMFY_DYNAMICCOMBO_V3",
        {}
      ]
    }
  },
  "easy modelLoaderPack": {
    "required": {
      "model": [
        "MODEL",
        {}
      ],
      "clip": [
        "CLIP",
        {}
      ],
      "vae": [
        "VAE",
        {}
      ],
      "audio_vae": [
        "VAE",
        {}
      ]
    }
  },
  "VAELoader": {
    "required": {
      "vae_name": [
        "COMBO",
        {
          "options": [
            "synthetic-vae.safetensors"
          ]
        }
      ]
    }
  },
  "CLIPLoader": {
    "required": {
      "clip_name": [
        "COMBO",
        {
          "options": [
            "synthetic-clip.safetensors"
          ]
        }
      ],
      "type": [
        "COMBO",
        {
          "options": [
            "minimax"
          ]
        }
      ],
      "device": [
        "COMBO",
        {
          "options": [
            "default"
          ]
        }
      ]
    }
  },
  "UNETLoader": {
    "required": {
      "unet_name": [
        "COMBO",
        {
          "options": [
            "synthetic-unet.safetensors"
          ]
        }
      ],
      "weight_dtype": [
        "COMBO",
        {
          "options": [
            "default"
          ]
        }
      ]
    }
  },
  "ModelAttentionBackend": {
    "required": {
      "model": [
        "MODEL",
        {}
      ],
      "attention": [
        "COMBO",
        {
          "options": [
            "comfy kitchen attention"
          ]
        }
      ]
    }
  },
  "LoraLoaderModelOnly": {
    "required": {
      "model": [
        "MODEL",
        {}
      ],
      "lora_name": [
        "COMBO",
        {
          "options": [
            "None"
          ]
        }
      ],
      "strength_model": [
        "FLOAT",
        {}
      ]
    }
  },
  "easy multitrackProjectVideoCombine": {
    "required": {
      "project_name": [
        "STRING",
        {}
      ],
      "project_data": [
        "PROJECT_DATA",
        {}
      ]
    }
  },
  "SaveVideo": {
    "required": {
      "video": [
        "VIDEO",
        {}
      ],
      "filename_prefix": [
        "STRING",
        {}
      ]
    }
  },
  "Fast Groups Bypasser (rgthree)": {
    "required": {}
  }
};
const objectInfoSchema = (type) => (nodeSchemas[type] ? { [type]: { input: nodeSchemas[type] } } : null);

async function body(request) { const parts = []; for await (const chunk of request) parts.push(chunk); return Buffer.concat(parts); }
function resolveImage(graph, reference) {
  let node = graph[reference[0]];
  const names = [];
  while (node) {
    if (node.class_type === "LoadImage") { names.push(node.inputs.image); node = undefined; continue; }
    if (node.class_type === "ImageBatch") { names.push(...resolveImage(graph, node.inputs.image1), ...resolveImage(graph, node.inputs.image2)); node = undefined; continue; }
    node = undefined;
  }
  return names;
}

const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = (payload, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(payload)); };
  try {
    if (url.pathname.endsWith("/chat/completions")) {
      const text = JSON.parse((await body(request)).toString("utf8")).messages[0].content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text.includes("你是 AIXG 模型提示词转换师")) {
        aixgCalls += 1;
        assert.equal(text.includes("一次批量转换"), true, "AIXG 必须一次批量转换全部分镜");
        assert.match(text, /不重新改编/);
        return json({ choices: [{ message: { content: JSON.stringify({ prompts }) } }] });
      }
      writerCalls += 1;
      assert.match(text, /禁止音乐|禁止任何音乐/);
      return json({ choices: [{ message: { content: JSON.stringify({ storyboard: "隔离测试：两镜制作分镜。", shots }) } }] });
    }
    if (url.pathname.startsWith("/api/userdata/") || url.pathname.startsWith("/userdata/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(await readFile(directorWorkflow));
    }
    if (url.pathname.startsWith("/object_info/")) {
      // Prefer the real instance; fall back to a faithful schema so the smoke also runs without ComfyUI.
      try {
        const upstream = await fetch("http://127.0.0.1:8188" + url.pathname, { signal: AbortSignal.timeout(8000) });
        if (upstream.ok) {
          response.writeHead(200, { "Content-Type": "application/json" });
          return response.end(Buffer.from(await upstream.arrayBuffer()));
        }
      } catch { /* ComfyUI is not running locally */ }
      const type = decodeURIComponent(url.pathname.slice("/object_info/".length));
      const schema = objectInfoSchema(type);
      assert.ok(schema, `object_info 缺少 ${type} 的节点 schema`);
      return json(schema);
    }
    if (url.pathname === "/upload/image") {
      const filename = /filename="([^"]+)"/.exec((await body(request)).toString("latin1"))?.[1] ?? "";
      assert.ok(filename, "上传请求缺少文件名");
      uploads.push(filename);
      return json({ name: filename, subfolder: "zane-studio", type: "input" });
    }
    if (url.pathname === "/prompt") {
      const applied = (await body(request)).toString("utf8");
      const { prompt: graph } = JSON.parse(applied);
      captured.push(graph);
      return json({ prompt_id: `clip-${captured.length}` });
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/").at(-1);
      return json({ [id]: { outputs: { "63": { video: [{ filename: "clip.mp4", type: "output", subfolder: "" }] } }, status: { status_str: "success", completed: true } } });
    }
    if (url.pathname === "/view") {
      const filename = url.searchParams.get("filename");
      if (filename?.endsWith(".mp4")) {
        response.writeHead(200, { "Content-Type": "video/mp4" });
        return response.end(await readFile(path.join(temporary, "clip.mp4")));
      }
      response.writeHead(200, { "Content-Type": "image/png" });
      return response.end(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#aaddcc" } }).png().toBuffer());
    }
    return json({ error: `unexpected fixture route ${url.pathname}` }, 404);
  } catch (error) { return json({ error: error.message, stack: error.stack }, 500); }
});

async function bounded(promise, milliseconds = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Director-console smoke timeout\n${logs.slice(-3000)}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function json(base, route, body) {
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const payload = await response.json();
  assert.ok(response.ok, `${route}: HTTP ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}
async function finished(base, id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const run = await json(base, `/api/v1/runs/${id}`); if (["completed", "failed", "cancelled"].includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Workflow timeout\n${logs.slice(-3000)}`);
}

try {
  await mkdir(project); await mkdir(data); await rm(path.join(temporary, "clip.mp4"), { force: true });
  await mkdir(path.join(hermes, "profiles", "writer"), { recursive: true }); await mkdir(path.join(hermes, "profiles", "aixg"), { recursive: true });
  await writeFile(path.join(hermes, "profiles", "writer", "config.yaml"), "name: writer\n");
  await writeFile(path.join(hermes, "profiles", "aixg", "config.yaml"), "name: aixg\n");
  await exec(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(temporary, "clip.mp4")], { windowsHide: true, timeout: 30000 });
  fixture.listen(0, "127.0.0.1"); await bounded(new Promise(resolve => fixture.once("listening", resolve)));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  await writeFile(path.join(data, "connections.json"), JSON.stringify({ enabledHermesProfiles: ["writer", "aixg"], comfyuiBaseUrl: fixtureUrl, projectDirectory: project, workflowTimeoutMinutes: 2 }));
  child = spawn(process.execPath, [path.join(root, "dist-server", "index.js"), "--production"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: data, ZANE_PROJECT_DIR: project, HERMES_HOME: hermes, HERMES_API_BASE_URL: fixtureUrl, HERMES_API_KEY: "synthetic-not-real-key", COMFYUI_BASE_URL: fixtureUrl, ZANE_SHUTDOWN_TIMEOUT_MS: "1000" },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stderr.on("data", chunk => { logs += chunk; });
    child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); });
    child.once("exit", code => reject(new Error(`Server exited (${code})\n${logs}`)));
  }));
  await json(base, "/api/ready");
  await json(base, "/api/workspace/initialize", { format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });

  const summary = await json(base, `/api/comfyui/workflow?filename=${encodeURIComponent(workflowFile)}`);
  const audioBridges = summary.nodes.filter(node => node.type === "easy makeAudioList");
  assert.equal(audioBridges.length, 1, "导演台工作流必须含且只含一个通用音频列表节点");
  const editor = summary.nodes.find(node => node.type === "easy multiTrackEditor");
  assert.ok(editor.inputProperties.includes("audio"), "编辑器 audio 输入必须已连接音频列表节点");

  const step = (id, kind, capabilityId, extra = {}) => ({ id, name: id, kind, capabilityId, capabilityVersion: "1", inputs: [], outputs: [], ...extra });
  const legacy = {
    sceneId: "scene_long_text_to_video", name: "长文出视频 · 隔离测试",
    inputs: [
      { key: "content", label: "长文 / 剧情", type: "textarea", required: true },
      { key: "character_assets", label: "人物资产", type: "image_list", required: true, mediaRole: "character" },
      { key: "scene_assets", label: "场景资产", type: "image_list", required: false, mediaRole: "scene" },
      { key: "prop_assets", label: "道具资产", type: "image_list", required: false, mediaRole: "prop" },
      { key: "voice_reference_audio", label: "参考音色", type: "audio_list", required: false, mediaRole: "voice_reference" },
      { key: "asset_notes", label: "资产说明", type: "textarea", required: false },
      { key: "production_notes", label: "制作要求", type: "textarea", required: false, defaultValue: "禁止任何音乐" },
      { key: "target_seconds", label: "目标时长", type: "number", required: true, defaultValue: 15 },
      { key: "ratio", label: "画幅", type: "select", required: true, options: ["16:9 (Widescreen)", "9:16 (Portrait Widescreen)"], defaultValue: "16:9 (Widescreen)" },
      { key: "mp", label: "生成像素", type: "select", required: true, options: ["0.4", "0.7", "0.98"], defaultValue: "0.7" },
    ],
    steps: [
      step("writer", "hermes", "core.hermes", {
        hermesProfile: "writer",
        inputs: [{ key: "content", sourceRef: "input.content" }, { key: "characters", sourceRef: "input.character_assets" }, { key: "scenes", sourceRef: "input.scene_assets" }, { key: "props", sourceRef: "input.prop_assets" }],
        outputs: [{ key: "storyboard", type: "text" }, { key: "shots", type: "json" }],
        promptTemplate: "你是长文/剧情视频的制作导演、编剧和分镜师。禁止任何音乐。\n{{input.content}}\n资产说明：{{input.asset_notes}}",
      }),
      step("aixg", "hermes", "core.hermes", {
        hermesProfile: "aixg",
        inputs: [{ key: "shots", sourceRef: "step.writer.outputs.shots" }, { key: "characters", sourceRef: "input.character_assets" }, { key: "scenes", sourceRef: "input.scene_assets" }, { key: "props", sourceRef: "input.prop_assets" }],
        outputs: [{ key: "prompts", type: "json" }],
        promptTemplate: "你是 AIXG 模型提示词转换师，一次批量转换全部分镜，不重新改编。\n分镜：{{step.writer.outputs.shots}}",
      }),
      step("align", "capability", "data.zip", { inputs: [{ key: "items", sourceRef: "step.writer.outputs.shots" }, { key: "prompt", sourceRef: "step.aixg.outputs.prompts" }], outputs: [{ key: "rows", type: "json" }] }),
      step("references", "capability", "media.select_references", { inputs: [{ key: "selection", sourceRef: "iteration.item.shot.selection" }, { key: "characters", sourceRef: "input.character_assets" }, { key: "scenes", sourceRef: "input.scene_assets" }, { key: "props", sourceRef: "input.prop_assets" }, { key: "voices", sourceRef: "input.voice_reference_audio" }], outputs: [{ key: "prompt", type: "text" }, { key: "bundle", type: "json" }], capabilityConfig: { groups: [{ key: "characters", kind: "image", tag: "Character" }, { key: "scenes", kind: "image", tag: "Scene" }, { key: "props", kind: "image", tag: "Prop" }, { key: "voices", kind: "audio", tag: "Voice" }] }, execution: { mode: "for_each", sourceRef: "step.align.outputs.rows", onError: "stop", maxConcurrency: 1 } }),
      step("records", "capability", "data.zip", { inputs: [{ key: "items", sourceRef: "step.writer.outputs.shots" }, { key: "prompt", sourceRef: "step.references.outputs.prompt" }, { key: "references", sourceRef: "step.references.outputs.bundle" }], outputs: [{ key: "rows", type: "json" }], capabilityConfig: { itemKey: "shot", ordinalField: "index" } }),
      step("generate", "comfyui", "core.comfyui", { inputs: [{ key: "prompt", sourceRef: "iteration.item.prompt" }], outputs: [{ key: "result", type: "video_list" }], comfyui: { workflowFile, bindings: [] }, execution: { mode: "for_each", sourceRef: "step.records.outputs.rows", onError: "stop", maxConcurrency: 1, carry: { outputKey: "result" } } }),
      step("assemble", "capability", "core.code", { inputs: [{ key: "clips", sourceRef: "step.generate.outputs.result" }, { key: "shots", sourceRef: "step.writer.outputs.shots" }], outputs: [{ key: "video", type: "video_list" }, { key: "manifest", type: "json" }], capabilityConfig: { code: FILM_ORDER_CODE, timeoutMs: 5000 } }),
    ],
    outputs: [
      { key: "video", label: "完整成片", type: "video_list", sourceRef: "step.assemble.outputs.video" },
      { key: "storyboard", label: "制作级分镜脚本", type: "text", sourceRef: "step.writer.outputs.storyboard" },
      { key: "shots", label: "执行分镜", type: "json", sourceRef: "step.records.outputs.rows" },
      { key: "clips", label: "片段", type: "video_list", sourceRef: "step.generate.outputs.result" },
      { key: "manifest", label: "拼接记录", type: "json", sourceRef: "step.assemble.outputs.manifest" },
    ],
  };
  const migrated = migrateLongTextToDirectorConsole(legacy, summary.nodes);
  assert.deepEqual(migrated.steps.map(item => item.id), ["writer", "aixg", "prepare_console", "console"]);
  const created = await json(base, "/api/v1/scenes", { scene: { id: legacy.sceneId, title: "长文出视频（隔离测试）", description: "隔离测试", stages: ["剧情与素材", "导演台单工程续接成片"] }, workflow: migrated });
  await json(base, `/api/v1/scenes/${legacy.sceneId}/validate`, { revision: created.revision });
  const publicationId = randomUUID();
  const published = await json(base, `/api/v1/scenes/${legacy.sceneId}/publish`, { revision: created.revision, publicationId });
  assert.equal(published.versionId, publicationId);

  const attachment = (filename) => ({ filename, type: "input", subfolder: "assets", url: `/api/comfyui/view?filename=${filename}&type=input` });
  const values = {
    content: "林舟把信交给苏晴。苏晴确认信到了。",
    character_assets: [attachment("char-1.png"), attachment("char-2.png")],
    scene_assets: [attachment("scene-1.png")],
    prop_assets: [attachment("prop-1.png")],
    voice_reference_audio: [attachment("voice-1.wav"), attachment("voice-2.wav")],
    asset_notes: "人物1=林舟，人物2=苏晴；场景1=房间；道具1=信封；音色1=林舟，音色2=苏晴",
    production_notes: "禁止任何音乐，只保留对白和必要现场声",
    target_seconds: 15, ratio: "16:9 (Widescreen)", mp: "0.7",
  };
  assert.equal((await json(base, `/api/v1/scenes/${legacy.sceneId}/prepare`, { versionId: publicationId, inputValues: values })).valid, true);
  const runId = randomUUID();
  await json(base, `/api/v1/scenes/${legacy.sceneId}/runs`, { versionId: publicationId, runId, inputValues: values });
  const run = await finished(base, runId);
  assert.equal(run.status, "completed", run.error);
  assert.equal(writerCalls, 1, "Writer 只调用一次");
  assert.equal(aixgCalls, 1, "AIXG 一次批量转换");
  assert.deepEqual(run.steps.map(item => item.stepId), ["writer", "aixg", "prepare_console", "console"]);
  assert.equal(run.steps[2].status, "completed", run.steps[2].message);

  const graph = captured[0];
  assert.ok(graph, "ComfyUI 未收到任务");
  assert.equal(Object.values(graph).some(node => node.class_type === "Reroute"), false);
  assert.equal(captured.length, 1, "导演台一次运行整片，不再逐镜提交");
  // 图片：人物→场景→道具按绑定顺序合并进编辑器 image 输入。
  assert.deepEqual(resolveImage(graph, graph["14"].inputs.image), ["assets/char-1.png", "assets/char-2.png", "assets/scene-1.png", "assets/prop-1.png"], "人物→场景→道具必须按绑定顺序合并进一个图片列表");
  assert.deepEqual(uploads, [], "已授权媒体附件不再重复上传");
  // 音色：按上传序号占用 audio1..audio10，再汇入编辑器 audio 输入。
  const bridgeId = String(audioBridges[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(graph["14"].inputs.audio)), [bridgeId, 0], "编辑器 audio 输入必须接到音频列表节点");
  const audioNames = ["audio1", "audio2"].map(name => graph[bridgeId].inputs[name]);
  assert.deepEqual(audioNames.every(Boolean), true, "两条参考音色必须各占一个槽位");
  for (const [index, slot] of audioNames.entries()) {
    const loader = graph[slot[0]];
    assert.equal(loader.class_type, "LoadAudio");
    assert.equal(loader.inputs.audio, `assets/voice-${index + 1}.wav`);
  }
  assert.equal(graph[bridgeId].inputs.audio3, undefined, "没有第三条参考音色时不得填充占位音频");
  // 时间线与工程参数。
  const trackData = JSON.parse(graph["14"].inputs.track_data);
  assert.equal(trackData.frame_rate, 24);
  assert.equal(trackData.total_length, 120 + 240);
  const tasks = trackData.tracks.find(track => track.type === "task").segments;
  assert.deepEqual(tasks.map(item => [item.start_frame, item.end_frame, item.content.continuity_mode]), [[0, 120, "shot"], [120, 360, "context"]]);
  assert.deepEqual(tasks[0].content.images.map(item => item.slot_name), ["image2", "image3", "image4"], "图片槽位 = 人物→场景→道具 的全局合并顺序");
  assert.deepEqual(tasks[1].content.images.map(item => item.slot_name), ["image1", "image3"]);
  assert.equal(Object.values(tasks[0].content).some(value => value === "local"), false);
  assert.match(tasks[0].content.user_prompt, /<Picture 1>[\s\S]*<Picture 3>/);
  assert.match(tasks[0].content.user_prompt, /<Audio 2>/);
  assert.doesNotMatch(tasks[0].content.user_prompt, /<Character|<Scene|<Prop|<Voice/);
  assert.deepEqual(trackData.tracks.slice(1).map(track => [track.name, track.segments[0].content.slot_name]), [["Voice 1", "audio1"], ["Voice 2", "audio2"]]);
  assert.equal(trackData.tracks[1].segments[0].content.media_type, "audio");
  assert.equal(trackData.tracks[1].segments[0].content.shared_reference, true);
  assert.equal(graph["15"].inputs.segment_count, -1);
  assert.equal(graph["15"].inputs.segment_start_number, 1);
  assert.match(graph["15"].inputs.project_name, /^zane-ltv-/);
  assert.equal(graph["14"].inputs["resolution.megapixels"], 0.7);
  assert.equal(graph["14"].inputs["resolution.aspect_ratio"], "16:9 (Widescreen)");
  assert.equal(graph["63"].class_type, "SaveVideo");

  const manifest = run.outputs.find(item => item.key === "manifest").value;
  assert.equal(manifest.segment_count, 2);
  assert.equal(manifest.total_frames, 360);
  assert.equal(manifest.image_slot_count, 4);
  assert.equal(manifest.audio_slot_count, 2);
  assert.equal(manifest.music_added, false);
  assert.deepEqual(manifest.segments.map(item => item.picture_slots), [["image2", "image3", "image4"], ["image1", "image3"]]);
  assert.deepEqual(manifest.segments.map(item => item.audio_slots), [["audio2"], ["audio1", "audio2"]]);
  assert.match(run.outputs.find(item => item.key === "storyboard").value, /制作分镜/);

  const output = run.outputs.find(item => item.key === "video").value;
  const media = Array.isArray(output) ? output[0] : output;
  const response = await fetch(base + (typeof media === "string" ? media : media.url));
  assert.equal(response.status, 200);
  const final = path.join(temporary, "final.mp4");
  await writeFile(final, Buffer.from(await response.arrayBuffer()));
  const { stdout } = await exec(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", final], { windowsHide: true, timeout: 20000 });
  const info = JSON.parse(stdout);
  assert.equal(info.streams.find(stream => stream.codec_type === "video").r_frame_rate, "24/1");
  assert.ok(info.streams.some(stream => stream.codec_type === "audio"), "成片必须保留原生音频");
  assert.ok(Number(info.format.duration) > 0.9);
  console.log("PASS: isolated director console / Writer once / AIXG one batch / merged core.code step builds slot-based timeline / character-scene-prop images appended in binding order / voice references occupy easy makeAudioList slots and feed the editor / 17k+5 aligned 24fps timeline / real FFmpeg MP4 with audio (no actual model generation)");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); try { await bounded(exited); } catch { child.kill("SIGKILL"); await exited; } }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  assert.equal(path.dirname(temporary), parent); assert.ok(path.basename(temporary).startsWith("zane-director-console-smoke-"));
  await rm(temporary, { recursive: true, force: true });
}
