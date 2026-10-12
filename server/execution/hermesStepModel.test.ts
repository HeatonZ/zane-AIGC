import assert from "node:assert/strict";
import test from "node:test";
import { runHermesStep } from "./hermesStep.js";
import type { RunStep, SavedSettings } from "../domain/types.js";

const settings: SavedSettings = { enabledHermesProfiles: ["default"], comfyuiBaseUrl: "", projectDirectory: "", workflowTimeoutMinutes: 1 };

function step(extra: Partial<RunStep> = {}): RunStep {
  return { id: "writer", name: "编剧", kind: "hermes", hermesProfile: "default", promptTemplate: "写一句台词", inputs: [], outputs: [{ key: "text", label: "文本", type: "text" }], ...extra };
}

/** Capture the exact request bodies the step runner sends, then complete the run. */
async function captureBodies(run: () => Promise<unknown>) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERMES_API_KEY;
  const originalBase = process.env.HERMES_API_BASE_URL;
  const bodies: Array<Record<string, unknown>> = [];
  process.env.HERMES_API_KEY = "test-key";
  process.env.HERMES_API_BASE_URL = "http://127.0.0.1:8642";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ run_id: "run_test", status: "started" }), { status: 202, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ run_id: "run_test", status: "completed", output: "{\"text\":\"台词\"}" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return { result: await run(), bodies };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.HERMES_API_KEY; else process.env.HERMES_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.HERMES_API_BASE_URL; else process.env.HERMES_API_BASE_URL = originalBase;
  }
}

test("Hermes 步骤未选择 provider/model 时请求体与历史一致", async () => {
  const { result, bodies } = await captureBodies(() => runHermesStep(step(), {}, new Map(), new Map(), settings));
  assert.deepEqual(result, { text: "台词" });
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], { model: "hermes-agent", input: [{ role: "user", content: bodies[0].input instanceof Array ? (bodies[0].input[0] as { content: unknown }).content : undefined }] });
  assert.equal("provider" in bodies[0], false);
});

test("Hermes 步骤的 provider/model 覆盖进入请求体，且只影响本次调用", async () => {
  const both = await captureBodies(() => runHermesStep(step({ hermesProvider: "custom:my-chat", hermesModel: "anthropic/claude-opus-5" }), {}, new Map(), new Map(), settings));
  assert.equal(both.bodies[0].model, "anthropic/claude-opus-5");
  assert.equal(both.bodies[0].provider, "custom:my-chat");

  const providerOnly = await captureBodies(() => runHermesStep(step({ hermesProvider: "opencode-zen" }), {}, new Map(), new Map(), settings));
  assert.equal(providerOnly.bodies[0].model, "hermes-agent");
  assert.equal(providerOnly.bodies[0].provider, "opencode-zen");

  const modelOnly = await captureBodies(() => runHermesStep(step({ hermesModel: "gpt-5.6-terra" }), {}, new Map(), new Map(), settings));
  assert.equal(modelOnly.bodies[0].model, "gpt-5.6-terra");
  assert.equal("provider" in modelOnly.bodies[0], false);
});

test("无效 provider/model 在执行前失败且不发出请求", async () => {
  for (const invalid of [{ hermesProvider: "has space" }, { hermesModel: "bad\nmodel" }, { hermesProvider: "a".repeat(81) }]) {
    const { bodies } = await captureBodies(async () => {
      await assert.rejects(() => runHermesStep(step(invalid), {}, new Map(), new Map(), settings), /Provider|模型/);
    });
    assert.equal(bodies.length, 0);
  }
});
