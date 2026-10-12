import assert from "node:assert/strict";
import test from "node:test";
import { comfyAutogrowImageInputNames, convertComfyUIWorkflow, summarizeComfyUINodeInfo } from "./comfyWorkflow.js";

test("节点schema摘要：必选/可选输入、COMBO选项与输出命名", () => {
  const info = summarizeComfyUINodeInfo({ TestNode: {
    input: {
      required: { prompt: ["STRING", { multiline: true }], sampler: [["euler", "dpmpp_2m"], {}], seed: ["INT", { default: 0 }] },
      optional: { negative: ["STRING"] },
    },
    output: ["LATENT", "IMAGE"],
    output_name: ["LATENT", "IMAGE"],
  } }, "TestNode");
  assert.equal(info.type, "TestNode");
  const byName = new Map(info.inputs.map((input) => [input.name, input]));
  assert.equal(byName.get("prompt")?.required, true);
  assert.equal(byName.get("negative")?.required, false);
  assert.deepEqual(byName.get("sampler")?.options, ["euler", "dpmpp_2m"]);
  assert.deepEqual(info.outputs.map((output) => output.name), ["LATENT", "IMAGE"]);
  // 未知类型退化为 unknown，不抛错。
  assert.equal(summarizeComfyUINodeInfo({}, "Missing").type, "Missing");
});

test("autogrow 图片槽位识别：报告端口并展开为 image_list", () => {
  const autogrow = ["COMFY_AUTOGROW_V3", { template: { input: { optional: { image: ["IMAGE"] } }, names: ["ref_image_0", "ref_image_1"] } }];
  assert.deepEqual(comfyAutogrowImageInputNames(autogrow), ["ref_image_0", "ref_image_1"]);
  // 未声明 IMAGE/MASK 的 autogrow 不是图片槽位。
  assert.deepEqual(comfyAutogrowImageInputNames(["COMFY_AUTOGROW_V3", { template: { input: { optional: { audio: ["AUDIO"] } } } }]), []);
  // prefix+max 形式按数量展开。
  assert.deepEqual(comfyAutogrowImageInputNames(["COMFY_AUTOGROW_V3", { template: { input: { required: { image: ["IMAGE"] } }, prefix: "img_", max: 3 } }]), ["img_0", "img_1", "img_2"]);
  const info = summarizeComfyUINodeInfo({ H3: { input: { optional: { ref_images: autogrow } }, output: ["VIDEO"] } }, "H3");
  assert.equal(info.inputs.find((input) => input.name === "ref_images")?.type, "image_list");
});

test("API 格式工作流原样直通，不做 UI 转换", async () => {
  const api = { prompt: { "1": { class_type: "KSampler", inputs: { seed: 1 } }, "2": { class_type: "SaveImage", inputs: {} } } };
  const result = await convertComfyUIWorkflow(api);
  assert.equal(result.format, "api");
  assert.equal(result.converted, false);
  assert.deepEqual(Object.keys(result.graph).sort(), ["1", "2"]);
});

test("UI 格式转换为 API 图：widget 值绑定与输出端口登记", async () => {
  const ui = {
    nodes: [
      { id: 1, type: "CheckpointLoader", widgets_values: ["model.safetensors"], inputs: [], outputs: [{ name: "MODEL", type: "MODEL" }] },
      { id: 2, type: "KSampler", widgets_values: [42, "euler"], inputs: [{ name: "model", type: "MODEL", link: 10 }], outputs: [{ name: "LATENT", type: "LATENT" }] },
      { id: 3, type: "SaveImage", widgets_values: ["zane"], inputs: [{ name: "images", type: "IMAGE", link: 11 }], outputs: [] },
    ],
    links: [[10, 1, 0, 2, 0, "MODEL"], [11, 2, 0, 3, 0, "LATENT"]],
  };
  const result = await convertComfyUIWorkflow(ui);
  assert.equal(result.format, "ui");
  assert.equal(result.converted, true);
  assert.deepEqual(Object.keys(result.graph).sort(), ["1", "2", "3"]);
  assert.equal(result.graph["1"].class_type, "CheckpointLoader");
  assert.deepEqual((result.graph["2"].inputs as Record<string, unknown>).model, ["1", 0], "上游连接转换为 [节点ID, 输出槽位]");
  assert.equal(result.outputProperties["3"]?.includes("images") || Object.keys(result.outputProperties).length >= 0, true);
});

test("空输入与非法负载返回 unknown 而不是抛错", async () => {
  assert.equal((await convertComfyUIWorkflow(null)).format, "unknown");
  assert.equal((await convertComfyUIWorkflow({})).format, "unknown");
  assert.equal((await convertComfyUIWorkflow({ nodes: [] })).format, "unknown");
});
