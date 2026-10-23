import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import { runHermesStep } from "./hermesStep.js";
import { harness, id } from "../testing/testSupport.js";
import type { RunWorkflowDefinition } from "../domain/types.js";

/** 运行级闭环：core.code 用 fileAccess 读出受控根目录里的 SKILL.md，core.llm 通过 skillRef
 *  把它的正文作为 system 消息发给模型。证明「技能文件 → 系统指令」这条链在真实执行器、
 *  真实能力包、真实运行记录下成立，而不只是能力包单测里的假运行时。 */
test("运行级闭环：core.llm 的 skillRef 引用 core.code 读出的 SKILL.md 正文，作为 system 消息发送", async t => {
  const executors = await loadCapabilityPackages({
    hermes: (context, options) => runHermesStep(context.step, context.inputValues, context.stepValues, context.types, context.settings, context.signal, context.feedback, context.captureAgentPrompt, context.captureAgentResponse, options),
    async condition() { return { result: true }; },
    async comfyui() { throw new Error("本测试不调用 ComfyUI"); },
  });
  const h = await harness(t, { executors, getLocalExportRoot: () => h.root });
  // 技能文件放在受控根目录里：与 core.code 的 localExport/fileAccess 同一授权边界。
  await mkdir(path.join(h.root, "skills", "enhancer"), { recursive: true });
  const skillBody = "---\nname: enhancer\ndescription: 提示词增强\n---\n\n# 规则\n\n把用户要求改写成最终提示词。";
  await writeFile(path.join(h.root, "skills", "enhancer", "SKILL.md"), skillBody, "utf8");

  const definition: RunWorkflowDefinition = {
    sceneId: "skill-scene", name: "技能文本闭环",
    inputs: [{ key: "idea", type: "textarea", required: true }],
    steps: [
      {
        id: "load_skill", name: "读取技能文件", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        promptTemplate: "",
        capabilityConfig: {
          code: "const skill = await zane.fs.readText(\"skills/enhancer/SKILL.md\");\nreturn { text: skill };",
          timeoutMs: 5000,
          fileAccess: { enabled: true },
        },
        inputs: [],
        outputs: [{ key: "text", type: "text" }],
      },
      {
        id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
        hermesProfile: "default",
        promptTemplate: "改写这条指令：{{input.idea}}",
        capabilityConfig: { skillRef: "step.load_skill.outputs.text", outputMode: "text" },
        inputs: [{ key: "idea", sourceRef: "input.idea", valueSource: "reference" }],
        outputs: [{ key: "text", type: "text" }],
      },
    ],
    outputs: [{ key: "result", type: "text", sourceRef: "step.enhance.outputs.text" }],
  };

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERMES_API_KEY;
  const originalBase = process.env.HERMES_API_BASE_URL;
  const bodies: Array<Record<string, unknown>> = [];
  process.env.HERMES_API_KEY = "test-key";
  process.env.HERMES_API_BASE_URL = "http://127.0.0.1:8642";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ run_id: "run_skill", status: "started" }), { status: 202, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ run_id: "run_skill", status: "completed", output: "最终提示词" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const runId = id("skill-ref-run");
    await h.service.start();
    await h.service.submit({ runId, workflow: structuredClone(definition), inputValues: { idea: "把背景换成夜景" } });
    const completed = await h.service.wait(h.settings.projectDirectory, runId);
    assert.equal(completed.status, "completed", JSON.stringify(completed.steps.map(step => [step.stepId, step.status, step.message])));
    assert.equal(bodies.length, 1);
    const messages = bodies[0]!.input as Array<{ role: string; content: string }>;
    assert.equal(messages[0]!.role, "system");
    assert.equal(messages[0]!.content, skillBody, "技能正文必须原样进入 system 消息（含 frontmatter）");
    assert.equal(messages[1]!.role, "user");
    assert.match(messages[1]!.content, /把背景换成夜景/);
    assert.equal(completed.outputs.find(output => output.key === "result")?.value, "最终提示词");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.HERMES_API_KEY; else process.env.HERMES_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.HERMES_API_BASE_URL; else process.env.HERMES_API_BASE_URL = originalBase;
  }
});
