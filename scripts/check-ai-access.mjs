import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist-server", "mcp", "index.js");
const base = process.env.ZANE_BASE_URL ?? "http://127.0.0.1:8799";
const client = new Client({ name: "zane-ai-doctor", version: "1.0.0" });
let logs = "";
try {
  await access(entry).catch(() => { throw new Error("MCP尚未构建，先运行 npm run build:server"); });
  const { aiOperations, AI_CONTRACT_VERSION } = await import("../dist-server/ai/operations.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" });
  transport.stderr?.on("data", chunk => { logs += chunk; });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(tool => tool.name));
  if (aiOperations.some(operation => !names.has(operation.name))) throw new Error("MCP工具目录不完整");
  const read = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError || !result.structuredContent?.ok) throw new Error(name + ": " + JSON.stringify(result.structuredContent ?? result));
    return result.structuredContent.data;
  };
  const workbench = await read("get_workbench");
  if (workbench.contractVersion !== AI_CONTRACT_VERSION) throw new Error("MCP与后台契约版本不同；安排升级后台后再接管");
  if (workbench.mode === "user") {
    const identity = await read("get_current_user");
    let page = await read("list_available_scenes"); const all = [...page.items]; const revision = page.revision; const seen = new Set();
    while (page.hasMore) {
      if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("用户场景分页回执无效");
      seen.add(page.nextCursor); page = await read("list_available_scenes", {cursor:page.nextCursor});
      if (page.revision !== revision) throw new Error("用户授权目录在诊断期间变化，请重新运行只读诊断");
      all.push(...page.items);
    }
    const ready = Boolean(workbench.worker?.ready && workbench.worker?.accepting && all.length);
    console.log(JSON.stringify({ready,mode:"user",baseUrl:base,contractVersion:workbench.contractVersion,userId:identity.user.id,sceneCount:all.length,toolCount:tools.tools.length,generationExecuted:false,next:ready ? "读取get_available_scene，预检后在授权范围内提交。" : "联系管理员授权并发布场景，或检查worker就绪状态。"},null,2));
    if (!ready) process.exitCode = 1;
  } else {
  const status = await read("get_workspace_status");
  const scenes = await read("list_scenes"); const seen = new Set();
  let page = scenes;
  while (page.hasMore) {
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("场景目录分页回执无效");
    seen.add(page.nextCursor);
    page = await read("list_scenes", { cursor: page.nextCursor });
    if (page.workspaceRevision !== scenes.workspaceRevision) throw new Error("场景目录在分页期间变化，请重新运行只读诊断");
    scenes.scenes.push(...page.scenes);
  }
  if (scenes.total !== scenes.scenes.length || status.workspaceRevision !== scenes.workspaceRevision) throw new Error("权威工作区在诊断期间变化，请重新运行只读诊断");
  const capabilities = await read("list_capabilities");
  // 伞式目录：只读诊断先确认默认资源只是目录，并按节读取一篇正文（不生成、不写场景）。
  const resources = await client.listResources(); const guideIndex = await client.readResource({ uri: "zane://guide" }); const guideSection = await client.readResource({ uri: "zane://guide/9" });
  const guideIndexBytes = Buffer.byteLength(String(guideIndex.contents[0].text), "utf8"); const guideSectionBytes = Buffer.byteLength(String(guideSection.contents[0].text), "utf8");
  if (!String(guideIndex.contents[0].text).includes("伞式目录")) throw new Error("zane://guide 未返回伞式目录：后台需要升级到 1.5.43 或更新");
  const published = scenes.scenes.filter(scene => scene.publishedVersionId);
  const ready = workbench.worker?.ready && workbench.worker?.accepting && workbench.projectConfigured && published.length > 0;
  console.log(JSON.stringify({ ready: Boolean(ready), baseUrl: base, contractVersion: workbench.contractVersion, workspaceRevision: scenes.workspaceRevision, authority: status.authority, worker: workbench.worker, projectConfigured: workbench.projectConfigured, projectDirectory: workbench.projectDirectory, toolCount: tools.tools.length, resourceCount: resources.resources.length, guideIndexBytes, guideSectionBytes, sceneCount: scenes.scenes.length, publishedSceneCount: published.length, capabilityCount: capabilities.capabilities.length, generationExecuted: false, next: ready ? "读取目标场景、预检，再在用户授权范围内执行。" : "后台必须就绪、配置项目目录并至少发布一个场景。" }, null, 2));
  if (!ready) process.exitCode = 1;
  }
} catch (error) { console.error("AI access check failed: " + (error instanceof Error ? error.message : String(error))); if (logs) console.error(logs.slice(-4000)); process.exitCode = 1; }
finally { await client.close().catch(() => undefined); }
