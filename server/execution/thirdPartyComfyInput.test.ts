import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { productionHarness } from "../testing/productionSupport.js";
import { id } from "../testing/testSupport.js";
import { createThirdPartyJsonRequester } from "../execution/thirdPartyJsonRequest.js";
import type { RunWorkflowDefinition } from "../domain/types.js";

/** End-to-end reproduction of the recorded failing run 63f3e4ba.
 *
 * The admin studio form stores an uploaded image as a ComfyUI attachment
 * ({filename, subfolder, type:"input", url:"/api/comfyui/view?..."}). Passing that straight
 * into a third-party multipart step used to fail before any request was sent, because the
 * multipart authorizer only accepted run-archived path/url locators — yet a ComfyUI
 * attachment has no run-local copy at all. This test drives the real RunService, the real
 * capability package and the real authorizer, and asserts the attachment's bytes reach the
 * third party in reference order.
 */
test("第三方multipart：场景输入是ComfyUI已上传附件时端到端取回原字节并出图", async t => {
  const source = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#3355ff" } }).png().toBuffer();
  const generated = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#33ff55" } }).png().toBuffer();

  // Stand in for the machine's ComfyUI /view route that holds the uploaded attachment.
  const viewed: string[] = [];
  const comfy = createServer((request, response) => {
    viewed.push(request.url ?? "");
    response.writeHead(200, { "content-type": "image/jpeg" });
    response.end(source);
  });
  comfy.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => comfy.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { comfy.close(() => resolve()); comfy.closeAllConnections(); }));

  const sent: Array<Record<string, unknown>> = [];
  const h = await productionHarness(t, undefined, undefined, createThirdPartyJsonRequester({
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async send(request) {
      const form = await new Response(new Uint8Array(request.body!), { headers: { "content-type": request.headers["content-type"]! } }).formData();
      const upload = form.get("image[]") as File;
      sent.push({ model: form.get("model"), prompt: form.get("prompt"), bytes: Buffer.from(await upload.arrayBuffer()), filename: upload.name });
      return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ data: [{ b64_json: generated.toString("base64") }] })) };
    },
  }));
  h.settings.comfyuiBaseUrl = "http://127.0.0.1:" + (comfy.address() as AddressInfo).port;

  // The exact shape the admin studio stores for an uploaded image.
  const attachment = {
    id: "e388feb4-b41b-4b0d-bd20-db4e11e3ac19",
    filename: "ヘスティア(ダンまち).jpg",
    subfolder: "zane-studio",
    type: "input",
    url: "/api/comfyui/view?filename=%E3%83%98%E3%82%B9%E3%83%86%E3%82%A3%E3%82%A2%28%E3%83%80%E3%83%B3%E3%81%BE%E3%81%A1%29.jpg&subfolder=zane-studio&type=input",
  };
  const workflow: RunWorkflowDefinition = {
    sceneId: "comfy-input-third-party", name: "gpt image流程",
    inputs: [{ key: "prompt", type: "textarea", required: true }, { key: "images", type: "image_list", required: false }, { key: "model", type: "select", required: true }],
    steps: [{
      id: "generate", name: "图编辑", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2",
      capabilityConfig: {
        method: "POST", url: "https://images.example.net/v1/images/edits", bodyFormat: "multipart",
        bodyTemplate: { model: "{{model}}", prompt: "{{prompt}}", n: 1 },
        multipartImages: [{ inputKey: "input_images", fieldName: "image[]" }],
        responseImages: { path: "data", base64Field: "b64_json", expectedCount: 1 },
      },
      inputs: [{ key: "input_images", sourceRef: "input.images", selection: { mode: "all" } }, { key: "prompt", sourceRef: "input.prompt" }, { key: "model", sourceRef: "input.model" }],
      outputs: [{ key: "images", type: "image_list" }],
    }],
    outputs: [{ key: "result", type: "image_list", sourceRef: "step.generate.outputs.images", selection: { mode: "all" } }],
  };

  await h.service.start();
  const submitted = await h.service.submit({ runId: id("comfy-attachment-input"), workflow, inputValues: { prompt: "紧身衣全身照", images: [attachment], model: "gpt-image-2.5-sunburst" } as never });
  const run = await h.service.wait(h.settings.projectDirectory, submitted.runId);
  assert.equal(run.status, "completed", run.error);
  // The attachment bytes came from ComfyUI's own view route, not from a run archive.
  assert.equal(viewed.length, 1);
  assert.match(viewed[0]!, /filename=%E3%83%98%E3%82%B9%E3%83%86%E3%82%A3%E3%82%A2/);
  assert.match(viewed[0]!, /subfolder=zane-studio/); assert.match(viewed[0]!, /type=input/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.bytes, source);
  assert.equal(sent[0]!.model, "gpt-image-2.5-sunburst"); assert.equal(sent[0]!.prompt, "紧身衣全身照");
  // The returned image is archived under this run and readable by name downstream.
  const images = run.outputs[0]!.value as string[];
  assert.equal(images.length, 1);
  assert.match(images[0]!, new RegExp("^/api/v1/runs/" + run.runId + "/media/[A-Za-z0-9._-]+\\.png$"));
  const archived = path.join(run.artifacts.directory, "outputs", "media", path.basename(images[0]!));
  assert.deepEqual(await sharp(archived).metadata().then(meta => [meta.width, meta.height]), [20, 20]);
});
