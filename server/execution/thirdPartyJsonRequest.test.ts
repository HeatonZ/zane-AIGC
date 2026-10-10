import { mkdir, readFile, writeFile, symlink, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import sharp from "sharp";
import { temporaryDirectory } from "../testing/testSupport.js";
import { createRuntimeMediaValue, isRuntimeMediaValue } from "../runtimeValue.js";
import type { JsonValue } from "../domain/types.js";
import { HttpError } from "../errors.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createThirdPartyJsonRequester, isRetryableThirdPartyFailure, nodeTransport, thirdPartyRequestOptions, thirdPartyRetryDelayMs, thirdPartyRetryPlan, validateThirdPartyEndpoint, validateThirdPartyRequestStep, type ThirdPartyHttpTransport } from "./thirdPartyJsonRequest.js";
import type { StepExecutionContext } from "./workflowExecutor.js";

const baseContext = (step: StepExecutionContext["step"], inputValues: Record<string, any> = {}, warnings: string[] = []): StepExecutionContext => ({
  runInputValues: inputValues, runId: "test", artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" }, step,
  inputValues, stepValues: new Map(), types: new Map(), settings: { projectDirectory: "", comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] }, inputFields: [], signal: new AbortController().signal,
  warn: async (message: string) => { warnings.push(message); },
});

function transport(response: { status: number; contentType: string; body: string }, seen: { request?: any } = {}): ThirdPartyHttpTransport {
  return {
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async send(request) { seen.request = request; return { ...response, body: Buffer.from(response.body) }; },
  };
}

test("第三方JSON请求：模板、服务端密钥和响应契约", async () => {
  const seen: { request?: any } = {};
  const request = createThirdPartyJsonRequester(transport({ status: 200, contentType: "application/json", body: '{"task_id":"abc","status":"queued"}' }, seen));
  const step: any = { id: "request", name: "提交生图", kind: "capability", capabilityId: "core.http_request", capabilityConfig: { url: "https://api.example.net/v1/images", method: "POST", apiKeyEnv: "TEST_IMAGE_KEY", bodyTemplate: { prompt: "{{prompt}}", count: "{{count}}" }, timeoutSeconds: 10 }, inputs: [{ key: "prompt", sourceRef: "input.prompt" }, { key: "count", sourceRef: "input.count" }], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }] };
  const previousKey = process.env.TEST_IMAGE_KEY;
  process.env.TEST_IMAGE_KEY = "secret-for-test";
  try {
    const result = await request(baseContext(step, { prompt: "a cat", count: 2 }));
    assert.deepEqual(result, { response: { task_id: "abc", status: "queued" }, status: 200 });
    assert.equal(seen.request.method, "POST"); assert.equal(seen.request.url.href, "https://api.example.net/v1/images");
    assert.equal(seen.request.headers.Authorization, "Bearer secret-for-test");
    assert.deepEqual(JSON.parse(seen.request.body.toString()), { prompt: "a cat", count: 2 });
  } finally { if (previousKey === undefined) delete process.env.TEST_IMAGE_KEY; else process.env.TEST_IMAGE_KEY = previousKey; }
});

test("第三方JSON请求：拒绝内网/动态URL、敏感头和媒体引用", async () => {
  for (const url of ["https://127.0.0.1/x", "http://127.0.0.1:3001/x", "http://10.0.0.5:8080/x", "http://192.168.1.5/x", "http://169.254.169.254/latest/meta-data", "http://[::1]:3001/x", "http://[fc00::1]/x", "http://localhost:3001/x", "http://service.internal/x", "ftp://api.example.net/x", "http://user:password@api.example.net/x", "http://api.example.net:0/x", "http://api.example.net/x#fragment", "https://api.example.net/x?api_key=secret"]) assert.throws(() => validateThirdPartyEndpoint(url));
  for (const url of ["https://api.example.net/x", "http://api.example.net/x", "http://api.example.net:3001/v1/images/edits", "http://93.184.216.34:3001/v1/images/edits", "http://[2606:4700:4700::1111]:8080/x", "https://api.example.net:8443/x"]) assert.equal(validateThirdPartyEndpoint(url).href, new URL(url).href);
  const step: any = { id: "request", name: "请求", kind: "capability", capabilityId: "core.http_request", capabilityConfig: { url: "https://api.example.net/x", headers: { Authorization: "bad" }, bodyTemplate: { image: "{{image}}" }, timeoutSeconds: 10 }, inputs: [{ key: "image", sourceRef: "input.image" }], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }] };
  assert.throws(() => validateThirdPartyRequestStep(step), /请求头/);
  const media = { kind: "media", __zaneRuntime: "media", mediaKind: "image", items: [] };
  const requester = createThirdPartyJsonRequester(transport({ status: 200, contentType: "application/json", body: "{}" }));
  await assert.rejects(() => requester(baseContext({ ...step, capabilityConfig: { ...step.capabilityConfig, headers: {} } }, { image: media })), /本地媒体引用/);
});

test("第三方JSON请求：非2xx和非JSON响应保持明确结果/错误", async () => {
  const failed = createThirdPartyJsonRequester(transport({ status: 429, contentType: "application/json", body: '{"error":"busy"}' }));
  await assert.rejects(() => failed(baseContext({ id: "request", name: "请求", kind: "capability", capabilityConfig: { url: "https://api.example.net/x", timeoutSeconds: 10 }, inputs: [], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }] })), /HTTP 429/);
  const text = createThirdPartyJsonRequester(transport({ status: 200, contentType: "text/plain", body: "accepted" }));
  const result = await text(baseContext({ id: "request", name: "请求", kind: "capability", capabilityConfig: { url: "https://api.example.net/x", timeoutSeconds: 10 }, inputs: [], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }] }));
  assert.deepEqual(result, { response: "accepted", status: 200 });
});


function requestContext(config: Record<string, any> = {}): StepExecutionContext {
  return baseContext({ id: "request", name: "请求", kind: "capability", capabilityId: "core.http_request", capabilityConfig: { url: "https://api.example.net/x", ...config }, inputs: [], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }] });
}

const jsonReply = { status: 200, contentType: "application/json", body: "{}" };

test("第三方JSON请求：无效配置在传输前拒绝", () => {
  for (const config of [
    { url: "https://user:password@api.example.net/x" }, { url: "https://[::1]/x" },
    { url: "https://service.internal/x" }, { url: "https://api.example.net/x#fragment" },
    { url: "https://api.example.net/x?access_token=secret" }, { method: "CONNECT" },
    { method: "GET", bodyTemplate: {} }, { headers: [] }, { headers: { Cookie: "secret" } },
    { headers: { "x-note": "first\r\nsecond" } }, { apiKeyEnv: "bad-name" },
    { apiKeyHeader: "Host" }, { apiKeyPrefix: "Bearer\n" },
    { timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { timeoutSeconds: 1.5 },
    { bodyTemplate: "not-an-object" }, { bodyTemplate: { prompt: "{{undeclared}}" } },
    { bodyTemplate: { prompt: "{{broken" } }, { bodyTemplate: { text: "x".repeat(256 * 1024) } },
  ]) assert.throws(() => validateThirdPartyRequestStep(requestContext(config).step), { code: "INVALID_HTTP_REQUEST_CONFIG" });
});

test("第三方JSON请求：拒绝非公网DNS结果和混合地址，不发送请求", async () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "168.63.129.16",
    "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2001:0db8:0:0:0:0:0:1",
    "2001::1", "2002:7f00:1::1", "3fff::1", "2::1", "3::1", "200::1", "300::1",
  ]) {
    const fake = transport(jsonReply);
    fake.resolve = async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }];
    fake.send = async () => assert.fail("non-public DNS must never reach transport");
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext()), { code: "THIRD_PARTY_HOST_NOT_PUBLIC" }, address);
  }
  const fake = transport(jsonReply); fake.resolve = async () => [];
  await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext()), { code: "THIRD_PARTY_HOST_NOT_PUBLIC" });
});

test("第三方JSON请求：公网IPv6固定给传输，默认方法和空响应", async () => {
  const seen: { request?: any } = {};
  const fake = transport({ status: 204, contentType: "", body: "" }, seen);
  const addresses = [{ address: "2606:4700:4700::1111", family: 6 }];
  fake.resolve = async () => addresses;
  assert.deepEqual(await createThirdPartyJsonRequester(fake)(requestContext()), { response: null, status: 204 });
  assert.equal(seen.request.method, "POST"); assert.equal(seen.request.body, undefined);
  assert.deepEqual(seen.request.addresses, addresses);
});

test("第三方JSON请求：嵌入文本和原生JSON类型，拒绝缺失输入及超大渲染正文", async () => {
  const seen: { request?: any } = {}; const requester = createThirdPartyJsonRequester(transport(jsonReply, seen));
  const context = requestContext({ bodyTemplate: { text: "prefix {{value}}", list: "{{list}}" } });
  context.step.inputs = [{ key: "value", sourceRef: "input.value" }, { key: "list", sourceRef: "input.list" }];
  context.inputValues = { value: false, list: [{ n: 1 }, null] };
  await requester(context); assert.deepEqual(JSON.parse(seen.request.body.toString()), { text: "prefix false", list: [{ n: 1 }, null] });
  context.inputValues.value = {};
  await assert.rejects(() => requester(context), { code: "INVALID_HTTP_REQUEST_INPUT" });
  context.inputValues.value = "x".repeat(256 * 1024);
  await assert.rejects(() => requester(context), { code: "HTTP_REQUEST_BODY_TOO_LARGE" });
  context.step.inputs![0]!.sourceRef = undefined;
  await assert.rejects(() => requester(context), { code: "INVALID_HTTP_REQUEST_INPUT" });
});

test("第三方JSON请求：响应大小、无效JSON、重定向和网络失败均不重试", async () => {
  for (const [reply, code] of [
    [{ status: 302, contentType: "text/plain", body: "redirect" }, "THIRD_PARTY_HTTP_ERROR"],
    [{ status: 200, contentType: "application/problem+json; charset=utf-8", body: "broken" }, "INVALID_THIRD_PARTY_JSON"],
    [{ status: 200, contentType: "text/plain", body: "x".repeat(4 * 1024 * 1024 + 1) }, "THIRD_PARTY_RESPONSE_TOO_LARGE"],
  ] as const) {
    const fake = transport(reply); const send = fake.send; let calls = 0;
    fake.send = async request => { calls++; return send(request); };
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext()), { code }); assert.equal(calls, 1);
  }
  const fake = transport(jsonReply); let calls = 0;
  fake.send = async () => { calls++; throw new Error("transport error containing secret-for-test"); };
  await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext()), error => {
    assert.equal((error as any).code, "THIRD_PARTY_REQUEST_FAILED"); assert.doesNotMatch(String(error), /secret-for-test/); return true;
  }); assert.equal(calls, 1);
});

test("第三方JSON请求：缺失/非法密钥不会发起请求", async () => {
  const variable = "TEST_THIRD_PARTY_CREDENTIAL_BOUNDARY"; const previous = process.env[variable];
  const fake = transport(jsonReply); fake.send = async () => assert.fail("invalid credentials must not be sent");
  try {
    delete process.env[variable];
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext({ apiKeyEnv: variable })), { code: "THIRD_PARTY_CREDENTIAL_MISSING" });
    process.env[variable] = "first\nsecond";
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext({ apiKeyEnv: variable })), { code: "THIRD_PARTY_CREDENTIAL_INVALID" });
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});

test("第三方JSON请求：取消涵盖DNS和传输，不发送后续请求", async () => {
  for (const phase of ["before", "dns", "send"]) {
    const fake = transport(jsonReply); const controller = new AbortController(); const reason = new Error("test cancellation");
    let sends = 0;
    if (phase === "dns") fake.resolve = async () => { controller.abort(reason); return [{ address: "93.184.216.34", family: 4 }]; };
    fake.send = async request => { sends++; controller.abort(reason); assert.equal(request.signal.aborted, true); throw request.signal.reason; };
    const context = requestContext(); context.signal = controller.signal;
    if (phase === "before") controller.abort(reason);
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(context), error => error === reason);
    assert.equal(sends, phase === "send" ? 1 : 0);
  }
});

test("第三方JSON请求：超时上限为600秒，边界值逐一校验", () => {
  for (const seconds of [1, 120, 600]) validateThirdPartyRequestStep(requestContext({ timeoutSeconds: seconds }).step);
  for (const seconds of [0, 601, 1200]) assert.throws(() => validateThirdPartyRequestStep(requestContext({ timeoutSeconds: seconds }).step), { code: "INVALID_HTTP_REQUEST_CONFIG" });
});

test("第三方JSON请求：超时覆盖尚未完成的DNS解析", async () => {
  const fake = transport(jsonReply); fake.resolve = () => new Promise(() => {});
  fake.send = async () => assert.fail("timed-out DNS must not send a request");
  const keepAlive = setTimeout(() => {}, 2000);
  try { await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext({ timeoutSeconds: 1 })), { code: "THIRD_PARTY_REQUEST_TIMEOUT" }); }
  finally { clearTimeout(keepAlive); }
});


const noLookup = (() => {}) as unknown as NonNullable<Parameters<typeof thirdPartyRequestOptions>[3]>;

test("第三方传输：HTTP明文地址使用显式端口，HTTPS保持443，默认端口按协议回退", () => {
  const signal = new AbortController().signal;
  const explicit = thirdPartyRequestOptions(new URL("http://93.184.216.34:3001/v1/images/edits"), "POST", {}, noLookup, signal);
  assert.equal(explicit.port, 3001); assert.equal(explicit.path, "/v1/images/edits"); assert.equal(explicit.hostname, "93.184.216.34"); assert.equal(explicit.method, "POST");
  assert.equal(thirdPartyRequestOptions(new URL("https://api.example.net/x"), "GET", {}, noLookup, signal).port, 443);
  assert.equal(thirdPartyRequestOptions(new URL("http://api.example.net/x"), "GET", {}, noLookup, signal).port, 80);
});

test("第三方传输：HTTP明文请求真实送达并按JSON解析响应", async () => {
  const received: Array<{ method: string; url: string; host: string; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      received.push({ method: request.method ?? "", url: request.url ?? "", host: String(request.headers.host ?? ""), body: Buffer.concat(chunks).toString() });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await nodeTransport.send({ url: new URL("http://127.0.0.1:" + port + "/v1/images/edits"), method: "POST", headers: { "content-type": "text/plain" }, body: Buffer.from("payload"), addresses: [{ address: "127.0.0.1", family: 4 }], signal: new AbortController().signal });
    assert.equal(result.status, 200); assert.equal(result.contentType, "application/json");
    assert.deepEqual(Buffer.from(result.body).toString(), JSON.stringify({ ok: true }));
    assert.equal(received.length, 1); assert.equal(received[0]!.method, "POST"); assert.equal(received[0]!.url, "/v1/images/edits");
    assert.equal(received[0]!.host, "127.0.0.1:" + port); assert.equal(received[0]!.body, "payload");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

async function imageContext(t: Parameters<typeof temporaryDirectory>[0]) {
  const root = await temporaryDirectory(t); const directory = path.join(root, "run"); await mkdir(directory);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  const filename = path.join(directory, "product.png"); await writeFile(filename, image);
  const context = requestContext({ bodyFormat: "multipart", bodyTemplate: { model: "fixture-model", prompt: "{{prompt}}", n: 1 }, multipartImages: [{ inputKey: "product_images", fieldName: "image[]" }], responseImages: { path: "data", base64Field: "b64_json", expectedCount: 1 } });
  context.artifacts.directory = directory;
  context.step.inputs = [{ key: "product_images", sourceRef: "input.product_images" }, { key: "prompt", sourceRef: "input.prompt" }];
  context.step.outputs!.push({ key: "images", type: "image_list" });
  context.inputValues = { product_images: createRuntimeMediaValue("image", [filename]), prompt: "preserve the product" };
  return { root, image, filename, context };
}

test("第三方multipart：已授权图片原字节上传、响应归档且base64明确省略", async t => {
  const { image, context } = await imageContext(t); const seen: { request?: any } = {};
  const requester = createThirdPartyJsonRequester(transport({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ b64_json: image.toString("base64"), revised_prompt: "fixture" }] }) }, seen));
  const result = await requester(context);
  const form = await new Response(seen.request.body, { headers: { "content-type": seen.request.headers["content-type"] } }).formData();
  assert.equal(form.get("prompt"), "preserve the product"); assert.equal(form.get("n"), "1");
  const uploaded = form.get("image[]") as File; assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), image);
  assert.equal(seen.request.maxResponseBytes, 64 * 1024 * 1024);
  assert.ok(isRuntimeMediaValue(result.images));
  const item = result.images.items[0]!; assert.equal(item.locator.type, "url");
  const archivedUrl = (item.locator as { value: string }).value;
  assert.match(archivedUrl, /^\/api\/v1\/runs\/test\/media\/[A-Za-z0-9._-]+$/);
  // The published relative archive URL must still expose the file name: media
  // is selected downstream by file name only.
  assert.equal(item.filename, path.basename(archivedUrl));
  const archivedPath = path.join(context.artifacts.directory, "outputs", "media", path.basename(archivedUrl));
  assert.deepEqual(await readFile(archivedPath), image);
  assert.equal((await stat(path.dirname(archivedPath))).isDirectory(), true);
  assert.deepEqual((result.response as any).data[0].b64_json, { omitted: true, reason: "decoded_to_images", outputKey: "images", index: 0 });
  assert.equal((result.response as any).data[0].revised_prompt, "fixture");
});

test("第三方multipart：拒绝当前运行之外路径、目录跳转、远程地址与非图片；不发送", async t => {
  const { root, image, context } = await imageContext(t); const outside = path.join(root, "other-user.png"); await writeFile(outside, image);
  const notImage = path.join(context.artifacts.directory, "fake.png"); await writeFile(notImage, "not a real image");
  const elsewhere = path.join(root, "elsewhere"); await mkdir(elsewhere); await writeFile(path.join(elsewhere, "image.png"), image);
  const link = path.join(context.artifacts.directory, "link"); await symlink(elsewhere, link, "junction");
  const fake = transport(jsonReply); fake.send = async () => assert.fail("unsafe input reached transport");
  for (const input of [outside, path.join(context.artifacts.directory, "..", "other-user.png"), path.join(link, "image.png"), "https://api.example.net/product.png", "data:image/png;base64," + image.toString("base64"), notImage]) {
    context.inputValues.product_images = createRuntimeMediaValue("image", [input]);
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(context), { code: "HTTP_REQUEST_MEDIA_UNSUPPORTED" });
  }
});

test("第三方multipart：映射、输出、GET和标量字段约束在执行前拒绝", async t => {
  const { context } = await imageContext(t);
  const invalidConfigs: Array<Record<string, JsonValue>> = [
    { bodyFormat: "file" }, { bodyFormat: "json" }, { method: "GET" },
    { multipartImages: [{ inputKey: "missing", fieldName: "image[]" }] },
    { multipartImages: [{ inputKey: "product_images", fieldName: 'bad"\r\n' }] },
    { bodyTemplate: { model: { nested: true } } }, { bodyTemplate: { "image[]": "collision" } },
    { responseImages: { path: "data", expectedCount: 0 } }, { responseImages: { path: "__proto__", base64Field: "b64_json" } },
    { responseImages: { unexpected: true } },
  ];
  for (const extra of invalidConfigs) assert.throws(() => validateThirdPartyRequestStep({ ...context.step, capabilityConfig: { ...context.step.capabilityConfig, ...extra } }), { code: "INVALID_HTTP_REQUEST_CONFIG" });
  assert.throws(() => validateThirdPartyRequestStep({ ...context.step, outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }] }), { code: "INVALID_HTTP_REQUEST_CONFIG" });
});

test("第三方图片响应：数量、base64、实际图片及64MB边界，不自动重试", async t => {
  const { image, context } = await imageContext(t);
  for (const data of [[], [{ b64_json: "%%%" }], [{ b64_json: Buffer.from("not-image").toString("base64") }], [{ b64_json: image.toString("base64") }, { b64_json: image.toString("base64") }]]) {
    let sends = 0; const fake = transport({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) }); const send = fake.send;
    fake.send = async input => { sends++; return send(input); };
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(context), { code: "INVALID_THIRD_PARTY_IMAGE" }); assert.equal(sends, 1);
  }
  const huge = transport(jsonReply); huge.send = async () => ({ status: 200, contentType: "application/json", body: Buffer.alloc(64 * 1024 * 1024 + 1) });
  await assert.rejects(() => createThirdPartyJsonRequester(huge)(context), { code: "THIRD_PARTY_RESPONSE_TOO_LARGE" });
});

test("第三方JSON请求：重试次数与间隔的边界值在传输前校验", () => {
  for (const config of [{}, { retries: 0 }, { retries: 1 }, { retries: 5 }, { retries: undefined }, { retryDelaySeconds: 0 }, { retryDelaySeconds: 2 }, { retryDelaySeconds: 30 }, { retryDelaySeconds: undefined }]) validateThirdPartyRequestStep(requestContext(config).step);
  for (const config of [{ retries: -1 }, { retries: 6 }, { retries: 1.5 }, { retries: "2" }, { retries: true }, { retryDelaySeconds: -1 }, { retryDelaySeconds: 31 }, { retryDelaySeconds: 1.5 }, { retryDelaySeconds: "2" }]) assert.throws(() => validateThirdPartyRequestStep(requestContext(config).step), { code: "INVALID_HTTP_REQUEST_CONFIG" });
});

test("第三方JSON请求：可重试失败按配置重发并在成功时返回结果", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const fake = transport(jsonReply); let sends = 0;
    fake.send = async () => { sends += 1; return sends === 1 ? { status, contentType: "application/json", body: Buffer.from("{}") } : { status: 200, contentType: "application/json", body: Buffer.from('{"ok":true}') }; };
    assert.deepEqual(await createThirdPartyJsonRequester(fake)(requestContext({ retries: 1, retryDelaySeconds: 0 })), { response: { ok: true }, status: 200 });
    assert.equal(sends, 2, `status ${status}`);
  }
  const fake = transport(jsonReply); let resolves = 0;
  fake.resolve = async () => { resolves += 1; if (resolves === 1) throw new Error("dns lookup failed"); return [{ address: "93.184.216.34", family: 4 }]; };
  assert.deepEqual(await createThirdPartyJsonRequester(fake)(requestContext({ retries: 2, retryDelaySeconds: 0 })), { response: {}, status: 200 });
  assert.equal(resolves, 2);
});

test("第三方JSON请求：重试用尽后返回最后一次原始错误，不改写为成功", async () => {
  const failed = transport(jsonReply); let sends = 0;
  failed.send = async () => { sends += 1; throw new Error("socket hang up"); };
  await assert.rejects(() => createThirdPartyJsonRequester(failed)(requestContext({ retries: 2, retryDelaySeconds: 0 })), { code: "THIRD_PARTY_REQUEST_FAILED" });
  assert.equal(sends, 3);
  const busy = transport({ status: 503, contentType: "application/json", body: "{}" }); let attempts = 0;
  busy.send = async () => { attempts += 1; return { status: 503, contentType: "application/json", body: Buffer.from("{}") }; };
  await assert.rejects(() => createThirdPartyJsonRequester(busy)(requestContext({ retries: 2, retryDelaySeconds: 0 })), error => {
    assert.equal((error as any).code, "THIRD_PARTY_HTTP_ERROR"); assert.equal((error as any).details.status, 503); return true;
  });
  assert.equal(attempts, 3);
});

test("第三方JSON请求：确定性失败只发一次，即使配置了重试", async () => {
  for (const [reply, code] of [
    [{ status: 400, contentType: "application/json", body: '{"error":"bad request"}' }, "THIRD_PARTY_HTTP_ERROR"],
    [{ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }, "THIRD_PARTY_HTTP_ERROR"],
    [{ status: 404, contentType: "application/json", body: '{"error":"missing"}' }, "THIRD_PARTY_HTTP_ERROR"],
    [{ status: 422, contentType: "application/json", body: '{"error":"invalid"}' }, "THIRD_PARTY_HTTP_ERROR"],
    [{ status: 200, contentType: "application/json", body: "broken" }, "INVALID_THIRD_PARTY_JSON"],
    [{ status: 200, contentType: "text/plain", body: "x".repeat(4 * 1024 * 1024 + 1) }, "THIRD_PARTY_RESPONSE_TOO_LARGE"],
  ] as const) {
    const fake = transport(reply as { status: number; contentType: string; body: string }); let sends = 0; const send = fake.send;
    fake.send = async request => { sends += 1; return send(request); };
    await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext({ retries: 3, retryDelaySeconds: 0 })), { code });
    assert.equal(sends, 1, code);
  }
  const privateDns = transport(jsonReply); let sends = 0;
  privateDns.resolve = async () => [{ address: "10.0.0.5", family: 4 }];
  privateDns.send = async () => { sends += 1; throw new Error("non-public address must never be requested"); };
  await assert.rejects(() => createThirdPartyJsonRequester(privateDns)(requestContext({ retries: 3, retryDelaySeconds: 0 })), { code: "THIRD_PARTY_HOST_NOT_PUBLIC" });
  assert.equal(sends, 0);
});

test("第三方JSON请求：每次重试重发完全相同的请求体与密钥头", async () => {
  const seen: Array<{ method: string; headers: Record<string, string>; body: string | undefined }> = [];
  const fake = transport(jsonReply); let sends = 0;
  fake.send = async request => {
    seen.push({ method: request.method, headers: { ...request.headers }, body: request.body?.toString() }); sends += 1;
    return sends === 1 ? { status: 500, contentType: "application/json", body: Buffer.from("{}") } : { status: 200, contentType: "application/json", body: Buffer.from('{"ok":true}') };
  };
  const variable = "TEST_THIRD_PARTY_RETRY_KEY"; const previous = process.env[variable]; process.env[variable] = "secret-for-test";
  try {
    const step = requestContext({ apiKeyEnv: variable, retries: 1, retryDelaySeconds: 0, bodyTemplate: { prompt: "{{prompt}}", size: "1024x1024" } }).step;
    step.inputs = [{ key: "prompt", sourceRef: "input.prompt" }];
    const result = await createThirdPartyJsonRequester(fake)(baseContext(step, { prompt: "a cat" }));
    assert.deepEqual(result, { response: { ok: true }, status: 200 });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(seen[0]!.headers.Authorization, "Bearer secret-for-test");
    assert.equal(seen[0]!.body, JSON.stringify({ prompt: "a cat", size: "1024x1024" }));
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});

test("第三方JSON请求：重试前写入非阻断提示，成功后仍返回结果", async () => {
  const warnings: string[] = []; const fake = transport(jsonReply); let sends = 0;
  fake.send = async () => { sends += 1; return sends <= 2 ? { status: 503, contentType: "application/json", body: Buffer.from("{}") } : { status: 200, contentType: "application/json", body: Buffer.from('{"ok":true}') }; };
  const step = requestContext({ retries: 3, retryDelaySeconds: 0 }).step;
  assert.deepEqual(await createThirdPartyJsonRequester(fake)(baseContext(step, {}, warnings)), { response: { ok: true }, status: 200 });
  assert.equal(sends, 3); assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /第1次请求失败：第三方接口返回HTTP 503；0秒后重试第2次请求/);
  assert.match(warnings[1]!, /第2次请求失败：第三方接口返回HTTP 503；0秒后重试第3次请求/);
  const exhausted: string[] = []; const failing = transport(jsonReply); failing.send = async () => { throw new Error("connection reset by peer"); };
  await assert.rejects(() => createThirdPartyJsonRequester(failing)(baseContext(requestContext({ retries: 1, retryDelaySeconds: 0 }).step, {}, exhausted)), { code: "THIRD_PARTY_REQUEST_FAILED" });
  assert.equal(exhausted.length, 1);
  assert.match(exhausted[0]!, /第1次请求失败：第三方HTTPS请求失败；0秒后重试第2次请求/);
});

test("第三方JSON请求：重试等待期间取消不再发送后续请求", async () => {
  const controller = new AbortController(); const reason = new Error("test cancellation"); let sends = 0;
  const fake = transport(jsonReply);
  fake.send = async () => { sends += 1; throw new Error("connection reset by peer"); };
  const context = requestContext({ retries: 3, retryDelaySeconds: 30 }); context.signal = controller.signal;
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(() => createThirdPartyJsonRequester(fake)(context), error => error === reason);
  assert.equal(sends, 1);
});

test("第三方JSON请求：请求超时按每次尝试计，重试用尽仍返回超时", async () => {
  const fake = transport(jsonReply); fake.resolve = () => new Promise(() => {});
  fake.send = async () => assert.fail("timed-out DNS must not send a request");
  const keepAlive = setTimeout(() => {}, 5000);
  try { await assert.rejects(() => createThirdPartyJsonRequester(fake)(requestContext({ timeoutSeconds: 1, retries: 1, retryDelaySeconds: 0 })), { code: "THIRD_PARTY_REQUEST_TIMEOUT" }); }
  finally { clearTimeout(keepAlive); }
});

test("第三方重试退避：指数增长且不超过单次上限", () => {
  assert.equal(thirdPartyRetryDelayMs(1, 2000), 2000);
  assert.equal(thirdPartyRetryDelayMs(2, 2000), 4000);
  assert.equal(thirdPartyRetryDelayMs(3, 2000), 8000);
  assert.equal(thirdPartyRetryDelayMs(6, 30000), 60000);
  assert.equal(thirdPartyRetryDelayMs(1, 0), 0);
  assert.deepEqual(thirdPartyRetryPlan({}), { retries: 0, delayMs: 2000 });
  assert.deepEqual(thirdPartyRetryPlan({ retries: 5, retryDelaySeconds: 0 }), { retries: 5, delayMs: 0 });
});

test("第三方重试判定：只有可补偿失败算可重试", () => {
  assert.equal(isRetryableThirdPartyFailure(new HttpError(502, "x", "THIRD_PARTY_REQUEST_FAILED")), true);
  assert.equal(isRetryableThirdPartyFailure(new HttpError(504, "x", "THIRD_PARTY_REQUEST_TIMEOUT")), true);
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableThirdPartyFailure(new HttpError(502, "x", "THIRD_PARTY_HTTP_ERROR", { status })), true, `status ${status}`);
  for (const status of [400, 401, 403, 404, 409, 413, 422, 501]) assert.equal(isRetryableThirdPartyFailure(new HttpError(502, "x", "THIRD_PARTY_HTTP_ERROR", { status })), false, `status ${status}`);
  for (const code of ["INVALID_HTTP_REQUEST_CONFIG", "INVALID_HTTP_REQUEST_INPUT", "HTTP_REQUEST_MEDIA_UNSUPPORTED", "THIRD_PARTY_HOST_NOT_PUBLIC", "THIRD_PARTY_CREDENTIAL_MISSING", "THIRD_PARTY_CREDENTIAL_INVALID", "THIRD_PARTY_RESPONSE_TOO_LARGE", "INVALID_THIRD_PARTY_JSON", "INVALID_THIRD_PARTY_IMAGE"]) assert.equal(isRetryableThirdPartyFailure(new HttpError(400, "x", code)), false, code);
  assert.equal(isRetryableThirdPartyFailure(new Error("plain error")), false);
});
