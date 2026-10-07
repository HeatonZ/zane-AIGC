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
