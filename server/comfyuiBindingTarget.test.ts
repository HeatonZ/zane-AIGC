import assert from "node:assert/strict";
import test from "node:test";
import { resolveComfyInputBindingTarget } from "./comfyuiBindingTarget.js";

test("未连线但 schema 声明的图片输入不能被已插入的 LoadImage.image 抢走", () => {
  const graph = {
    "491": { class_type: "ImageScaleToTotalPixels", inputs: { megapixels: 1 } },
    "1000": { class_type: "LoadImage", inputs: { image: "reference.jpg" } },
  };
  const target = resolveComfyInputBindingTarget(graph, { nodeId: "491", property: "image" }, true);
  assert.equal(target.nodeId, "491");
  assert.equal(target.remapped, false);
  assert.equal(target.nodeInputs, graph["491"].inputs);
});

test("动态图片组即使没有连线，也保留其已声明的目标节点", () => {
  const graph = { "471": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "" } } };
  assert.equal(resolveComfyInputBindingTarget(graph, { nodeId: "471", property: "images" }, true).nodeId, "471");
});

test("已有节点属性优先，真正的旧绑定仍可以唯一迁移，但歧义不猜测", () => {
  const graph = { "1": { inputs: { prompt: "one" } }, "2": { inputs: { width: 512 } } };
  assert.equal(resolveComfyInputBindingTarget(graph, { nodeId: "1", property: "prompt" }).nodeId, "1");
  assert.equal(resolveComfyInputBindingTarget(graph, { nodeId: "old", property: "width" }).nodeId, "2");
  assert.equal(resolveComfyInputBindingTarget({ ...graph, "3": { inputs: { width: 1024 } } }, { nodeId: "old", property: "width" }).node, undefined);
});

test("唯一候选已被上游连线时不得迁移，避免顶掉工作流既有数据流", () => {
  // 真实事故：旧绑定 character->#537.images 的节点被作者删除，
  // 而全图只剩 #461 SaveImage.images（已连到 #475 VAEDecode）。
  // 迁移过去会把生成图连线改写成输入图，导致成图被原图覆盖。
  const graph = {
    "475": { class_type: "VAEDecode", inputs: { samples: ["597", 0] } },
    "461": { class_type: "SaveImage", inputs: { images: ["475", 0], filename_prefix: "x" } },
  };
  const target = resolveComfyInputBindingTarget(graph, { nodeId: "537", property: "images" });
  assert.equal(target.remapBlocked, "connected");
  assert.equal(target.remapped, false);
  assert.equal(target.node, undefined);
});

test("同属性既有已连线又有未连线节点时，迁移到未连线的那个", () => {
  const graph = {
    "461": { class_type: "SaveImage", inputs: { images: ["475", 0] } },
    "604": { class_type: "PreviewImage", inputs: { images: ["603", 0] } },
    // 未连线的端口不是 [nodeId, slot] 数组，可以安全承接迁移。
    "605": { class_type: "PreviewImage", inputs: { images: null } },
  };
  // 两个候选都带 images：只有 #605 未连线，可以安全迁移。
  assert.equal(resolveComfyInputBindingTarget(graph, { nodeId: "537", property: "images" }).nodeId, "605");
  // 去掉未连线的那个，只剩已连线的，迁移被阻止。
  delete (graph as Record<string, unknown>)["605"];
  assert.equal(resolveComfyInputBindingTarget(graph, { nodeId: "537", property: "images" }).remapBlocked, "connected");
});
