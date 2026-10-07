import test from "node:test";
import assert from "node:assert/strict";
import { assetReferenceFromMediaUrl, ASSET_MEDIA_EXECUTION_CONTRACT } from "./assetMediaReference.js";
import { HttpError } from "../errors.js";
import { createAiOpenApi } from "../ai/openapi.js";
import { sceneInputContract } from "./inputContract.js";
import type { RunWorkflowDefinition } from "./types.js";

const base = "http://127.0.0.1:4242";
const media = "/api/v1/assets/asset-pinned/versions/1/media";
test("工作台素材URL只认当前后台同源/相对固定版本；loopback别名等价", () => {
  for (const source of [media, base + media, "http://localhost:4242" + media, "http://[::1]:4242" + media, { url: base + media }, { path: base + media }, { url: base + media, path: "spoofed", filename: "output.png", type: "output" }]) assert.deepEqual(assetReferenceFromMediaUrl(source, base), { assetId: "asset-pinned", assetVersion: 1 });
  assert.deepEqual(assetReferenceFromMediaUrl(media), { assetId: "asset-pinned", assetVersion: 1 });
});
test("跨源、跨端口、普通外部URL和本地路径不取得素材内部读取能力", () => {
  for (const source of ["https://127.0.0.1:4242" + media, "http://127.0.0.1:4243" + media, "http://external.invalid:4242" + media, "//external.invalid" + media, base + "/image.png", "F:/input.png", { url: "http://external.invalid/file.png" }]) assert.equal(assetReferenceFromMediaUrl(source, base), undefined);
  assert.equal(assetReferenceFromMediaUrl(base + media), undefined);
});
test("内部媒体无有效固定版本、非法ID或嵌入凭证时预检拒绝，不回退HTTP下载", () => {
  for (const source of [media.replace("/1/", "/0/"), media.replace("/1/", "/-1/"), media.replace("/1/", "/9007199254740992/"), media.replace("/1/", "/latest/"), media.replace("asset-pinned", "%2Fescape"), media.replace("asset-pinned", "%zz"), media + "/extra", "http://user:secret@127.0.0.1:4242" + media]) assert.throws(() => assetReferenceFromMediaUrl(source, base), error => error instanceof HttpError && error.code === "INVALID_ASSET_REFERENCE");
});
test("媒体输入响应与OpenAPI契约同源，发现不生成且不提供任意签名/鉴权代理", () => {
  const flow = { sceneId: "media", name: "素材", inputs: [{ key: "images", type: "image_list", required: true }], steps: [], outputs: [] } as RunWorkflowDefinition;
  const contract = sceneInputContract(flow);
  assert.deepEqual(contract.inputRequirements[0].mediaExecution, ASSET_MEDIA_EXECUTION_CONTRACT);
  const api = createAiOpenApi();
  assert.deepEqual(api["x-asset-media-execution"], ASSET_MEDIA_EXECUTION_CONTRACT);
  assert.deepEqual(api.components.schemas.MediaExecutionAccess.const, ASSET_MEDIA_EXECUTION_CONTRACT);
  assert.deepEqual(ASSET_MEDIA_EXECUTION_CONTRACT.imageConsumers, {
    source: "same_authorized_fixed_version_private_run_copy",
    hermes: "private_image_bytes_to_inline_data_url",
    comfyui: "private_image_bytes_to_upload_in_reference_order",
    hermesSizePolicy: "existing_inline_budget_may_resize_without_reselecting_asset_version",
  });
  assert.equal(ASSET_MEDIA_EXECUTION_CONTRACT.forwardsWorkbenchCredentials, false);
  assert.equal(ASSET_MEDIA_EXECUTION_CONTRACT.preflightExternalCalls, false);
});
