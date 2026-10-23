import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { productionHarness } from "../testing/productionSupport.js";
import { id } from "../testing/testSupport.js";
import { runComfyUIStep } from "./comfyStep.js";
import type { RunWorkflowDefinition } from "../domain/types.js";

/** End-to-end coverage for binding a scene image to the workflow's LoadImage entry.
 *
 * LoadImage.image is a filename selector (a COMBO of uploaded names), not an IMAGE
 * socket. Before this was handled, a binding to LoadImage.image threw
 * "不支持图片列表", so scenes had to bind some downstream IMAGE node instead — and
 * when the author deleted that node, the stale binding silently migrated onto
 * SaveImage.images and overwrote the generated image with the input image. This
 * drives the real RunService and the real ComfyUI step against a stand-in server.
 */
test("场景图片可直接绑定LoadImage.image，并覆盖其保存的默认文件名", async t => {
  const source = await sharp({ create: { width: 24, height: 32, channels: 3, background: "#cc3344" } }).png().toBuffer();
  const generated = await sharp({ create: { width: 40, height: 56, channels: 3, background: "#33cc55" } }).png().toBuffer();

  const uploads: string[] = [];
  let submitted: Record<string, unknown> | undefined;
  const comfy = createServer((request, response) => {
    const url = request.url ?? "";
    if (url.startsWith("/upload/image")) {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => {
        uploads.push(Buffer.concat(chunks).toString("latin1"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "scene-character.png", subfolder: "zane-studio", type: "input" }));
      });
      return;
    }
    if (url.startsWith("/api/userdata/") || url.startsWith("/userdata/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(workflowPayload()));
      return;
    }
    if (url.startsWith("/object_info")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(objectInfo()));
      return;
    }
    if (url.startsWith("/prompt")) {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => {
        submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ prompt_id: "prompt-1" }));
      });
      return;
    }
    if (url.startsWith("/history/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ "prompt-1": { status: { completed: true, status_str: "success" }, outputs: { "461": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }));
      return;
    }
    if (url.startsWith("/view")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(generated);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  comfy.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => comfy.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { comfy.close(() => resolve()); comfy.closeAllConnections(); }));

  const h = await productionHarness(t, undefined, undefined, undefined, undefined, context =>
    runComfyUIStep(context.step, context.inputValues, context.stepValues, context.settings.comfyuiBaseUrl, context.signal, context.inputFields, context.types, 60_000, context));
  h.settings.comfyuiBaseUrl = "http://127.0.0.1:" + (comfy.address() as AddressInfo).port;

  const workflow: RunWorkflowDefinition = {
    sceneId: "comfy-loadimage-entry", name: "角色图入口绑定",
    inputs: [{ key: "character", type: "image_list", required: true }],
    steps: [{
      id: "swap", name: "换装", kind: "comfyui",
      inputs: [{ key: "character", sourceRef: "input.character" }],
      outputs: [{ key: "result", type: "image_list" }],
      comfyui: {
        workflowFile: "Zane/loadimage-entry.json",
        bindings: [
          { key: "character", label: "角色图", direction: "input", nodeId: "482", property: "image", type: "image_list", sourceRef: "input.character", required: true },
          { key: "result", direction: "output", nodeId: "461", property: "images", type: "image_list" },
        ],
      },
    }],
    outputs: [{ key: "result", type: "image_list", sourceRef: "step.swap.outputs.result", selection: { mode: "all" } }],
  };

  // The production shape: the scan step returns a real local file path, so the
  // step must upload it and then assign the resulting input name to the widget.
  const characterPath = path.join(h.settings.projectDirectory, "character.png");
  await writeFile(characterPath, source);

  await h.service.start();
  const run = await h.service.submit({
    runId: id("comfy-loadimage"),
    workflow,
    inputValues: { character: [characterPath] } as never,
  }).then(submittedRun => h.service.wait(h.settings.projectDirectory, submittedRun.runId));

  assert.equal(run.status, "completed", run.error);
  // The image was uploaded and assigned to the existing LoadImage widget.
  assert.equal(uploads.length, 1, "角色图应上传到 ComfyUI");
  const graph = (submitted as { prompt: Record<string, Record<string, unknown>> }).prompt;
  const entry = graph["482"] as { class_type: string; inputs: Record<string, unknown> };
  assert.equal(entry.class_type, "LoadImage");
  assert.match(String(entry.inputs.image), /zane-studio\/scene-character\.png/);
  // Crucially the generated image stays wired to SaveImage.
  assert.deepEqual((graph["461"] as { inputs: Record<string, unknown> }).inputs.images, ["475", 0]);
  // No extra LoadImage node was inserted to shadow the entry.
  assert.equal(Object.values(graph).filter(node => (node as { class_type?: string }).class_type === "LoadImage").length, 1);
});

function workflowPayload() {
  return {
    id: "loadimage-entry",
    revision: 0,
    nodes: [
      { id: 482, type: "LoadImage", pos: [0, 0], size: [100, 100], flags: {}, order: 0, mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }, { name: "MASK", type: "MASK", links: null }], widgets_values: ["default.png", "image"] },
      { id: 471, type: "TextEncodeQwenImage21", pos: [0, 0], size: [100, 100], flags: {}, order: 1, mode: 0, inputs: [{ name: "images.image_1", type: "IMAGE", link: 1 }, { name: "prompt", type: "STRING", link: null, widget: { name: "prompt" } }], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [2] }], widgets_values: [""] },
      { id: 475, type: "VAEDecode", pos: [0, 0], size: [100, 100], flags: {}, order: 2, mode: 0, inputs: [{ name: "samples", type: "LATENT", link: null }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [3] }], widgets_values: [] },
      { id: 461, type: "SaveImage", pos: [0, 0], size: [100, 100], flags: {}, order: 3, mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 3 }], outputs: [], widgets_values: ["Zane/out"] },
    ],
    links: [
      [1, 482, 0, 471, 0, "IMAGE"],
      [2, 471, 0, 475, 0, "CONDITIONING"],
      [3, 475, 0, 461, 0, "IMAGE"],
    ],
    groups: [], config: {}, extra: {}, version: 0.4,
  };
}

function objectInfo() {
  return {
    LoadImage: { input: { required: { image: [["default.png", "scene-character.png"], { image_upload: true }] } }, output: ["IMAGE", "MASK"], output_name: ["IMAGE", "MASK"] },
    TextEncodeQwenImage21: { input: { required: { clip: ["CLIP"], prompt: ["STRING", { multiline: true }] }, optional: { images: ["COMFY_AUTOGROW_V3", { template: { input: { required: { image: ["IMAGE", {}] } }, prefix: "image_", min: 0, max: 16 } }] } }, output: ["CONDITIONING"], output_name: ["CONDITIONING"] },
    VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } }, output: ["IMAGE"], output_name: ["IMAGE"] },
    SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] } }, output: [], output_name: [] },
  };
}
