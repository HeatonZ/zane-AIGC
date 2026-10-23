import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { aiOperations, AI_CONTRACT_VERSION } from "../ai/operations.js";
import { AI_GUIDE_SECTIONS, AI_OPERATOR_GUIDE_INDEX, PUBLIC_USER_OPERATOR_GUIDE } from "../ai/guide.js";
import { AI_OPERATOR_CHANGELOG } from "../ai/guideChangelog.js";
import { createAiOpenApi } from "../ai/openapi.js";
import { WorkbenchHttpClient } from "./httpClient.js";

export function createWorkbenchMcp(client: WorkbenchHttpClient) {
  const server = new McpServer({ name: "zane-workbench", version: AI_CONTRACT_VERSION }, { instructions: "先读取 zane://guide 伞式目录（正文按 zane://guide/<节号> 读取，只读与目标相关的节，不整本拉取）和 get_workbench，确认后台就绪；HTTP契约导航用 zane://openapi/index（完整OpenAPI约0.6MB，不要整份载入会话）。配置业务用单场景draft/create/update/validate/publish，不搬整工作区；发布先保存publicationId。使用已发布场景；先get_scene(inputSchema)/prepare_scene，再提交固定versionId及预先保存的UUID runId。wait_run有界摘要，结果按get_run_outputs/get_step_result分页读取；waiting只处理当前reviewId；局部重做先preview_rerun。执行可能付费，必须遵守用户授权范围。写入/提交响应丢失只查同一ID/对象，不自动重放或换ID。素材固定assetId+assetVersion；更新使用当前revision。审核运行质量用get_run_audit读有界证据包、submit_run_critique留结论；直连Hermes的第三方评审用audit_run_with_hermes（可能计费，先保存critiqueId，响应丢失查同一ID）。本MCP不直接访问数据库或重启正式后台。" });
  // openWorldHint：只有真正会离开本机、访问外部服务的操作才标记。
  // execute 类步骤必然如此；save_asset/update_task_concurrency 会接触上游或后续付费链路；
  // query_direct_llm_models 虽然契约上是 write（它会写模型缓存），但它确实向管理员配置的
  // 上游提供商发一次 GET /models；request_step_agent_feedback 虽然不重做、不写运行，但它
  // 真实调用该步骤原本使用的模型；test_notification_webhook 会真实向配置的 Webhook 发一条
  // 测试消息（一次、不重试），同样必须如实声明为接触外部世界。
  const openWorldNames = new Set(["save_asset", "update_task_concurrency", "query_direct_llm_models", "request_step_agent_feedback", "test_notification_webhook"]);
  for (const operation of aiOperations) {
    server.registerTool(operation.name, { title: operation.name, description: (operation.access === "authenticated" ? "当前身份操作。" : "仅管理员。") + operation.description, inputSchema: operation.schema, annotations: { readOnlyHint: operation.effect === "read", destructiveHint: operation.effect !== "read", idempotentHint: operation.effect === "read", openWorldHint: operation.effect === "execute" || openWorldNames.has(operation.name) } }, async (args, extra) => {
      const result = await client.call(operation, args as Record<string, unknown>, extra.mcpReq.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(!result.ok ? { isError: true } : {}) };
    });
  }
  async function documentation(signal?: AbortSignal) {
    const discovery = await client.call(aiOperations.find(operation => operation.name === "get_workbench")!, {}, signal);
    const data = discovery.data as { security?: { entryMode?: string } } | undefined;
    return { discovery, userOnly: data?.security?.entryMode === "user-only" };
  }
  // 伞式目录：会话级只下发 zane://guide（目录），正文按 zane://guide/<节号> 读取；
  // 普通用户入口与 zane://guide 一致，只返回用户手册（分节资源不泄露管理员手册）。
  const guideText = async (text: string, signal?: AbortSignal) => { const { discovery, userOnly } = await documentation(signal); return !discovery.ok ? JSON.stringify(discovery) : userOnly ? PUBLIC_USER_OPERATOR_GUIDE : text; };
  const guideContents = async (uri: URL, signal: AbortSignal | undefined, text: string) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await guideText(text, signal) }] });
  server.registerResource("operator-guide", "zane://guide", { description: "AI操作手册的伞式目录：节号/标题/子节/字节数与最小铁律（正文按节读取 zane://guide/<节号>，整本用 HTTP detail=full）；历史版本小节见 zane://guide/changelog", mimeType: "text/markdown" }, (uri, extra) => guideContents(uri, extra.mcpReq.signal, AI_OPERATOR_GUIDE_INDEX));
  server.registerResource("operator-changelog", "zane://guide/changelog", { description: "按版本倒序的历史功能/行为变更小节；已从 zane://guide 拆出，仅需核对历史行为时读取", mimeType: "text/markdown" }, (uri, extra) => guideContents(uri, extra.mcpReq.signal, AI_OPERATOR_CHANGELOG));
  for (const section of AI_GUIDE_SECTIONS) server.registerResource("guide-section-" + section.id.replace(/\./g, "-"), section.uri, { description: section.title + "（AI操作手册第 " + section.id + " 节，" + section.bytes + " 字节；目录见 zane://guide）", mimeType: "text/markdown" }, (uri, extra) => guideContents(uri, extra.mcpReq.signal, section.text));
  server.registerResource("openapi", "zane://openapi", { description: "与工具目录同源的完整OpenAPI 3.1契约（约0.6MB）；只要导航先读 zane://openapi/index", mimeType: "application/json" }, async (uri, extra) => { const { discovery, userOnly } = await documentation(extra.mcpReq.signal); return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(discovery.ok ? createAiOpenApi({ userOnly }) : discovery) }] }; });
  // 完整契约有 0.6MB，整份读入会话上下文是纯浪费：索引只给契约版本、x-* 机器契约键与逐路径的
  // 操作事实（方法/operationId/副作用/权限/是否MCP工具），细节按需取完整文档或对应工具schema。
  server.registerResource("openapi-index", "zane://openapi/index", { description: "OpenAPI契约的导航索引：契约版本、x-*机器契约键与逐路径操作事实；完整文档读 zane://openapi", mimeType: "application/json" }, async (uri, extra) => {
    const { discovery, userOnly } = await documentation(extra.mcpReq.signal);
    if (!discovery.ok) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(discovery) }] };
    const api = createAiOpenApi({ userOnly }) as Record<string, unknown>;
    const paths = api.paths as Record<string, Record<string, { operationId?: string; "x-ai-effect"?: string; "x-access-role"?: string; "x-mcp-tool"?: string }>>;
    const index = {
      openapi: api.openapi,
      info: api.info,
      contractKeys: Object.keys(api).filter(key => key.startsWith("x-")),
      full: { resource: "zane://openapi", http: "/api/v1/ai/openapi.json", note: "完整文档另含逐操作请求/响应schema与错误矩阵组件；按需读取，不要整份载入会话" },
      operations: Object.entries(paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, document]) => ({ method: method.toUpperCase(), path, operationId: document.operationId, effect: document["x-ai-effect"], access: document["x-access-role"], ...(document["x-mcp-tool"] ? { mcpTool: document["x-mcp-tool"] } : {}) }))),
    };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(index) }] };
  });
  for (const [name, tool] of [["scenes", "list_scenes"], ["capabilities", "list_capabilities"]]) {
    server.registerResource(name, "zane://" + name, { description: "后台实时" + name + "目录", mimeType: "application/json" }, async (uri, extra) => {
      let selectedTool = tool;
      if (name === "scenes") {
        const discovery = await client.call(aiOperations.find(operation => operation.name === "get_workbench")!, {}, extra.mcpReq.signal);
        const data = discovery.data as { mode?: string } | undefined;
        if (data?.mode === "user") selectedTool = "list_available_scenes";
      }
      const result = await client.call(aiOperations.find(operation => operation.name === selectedTool)!, {}, extra.mcpReq.signal);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result) }] };
    });
  }
  server.registerPrompt("operate-workbench", { description: "将用户目标转为工作台可执行步骤，不擅自付费或绕过审核", argsSchema: z.object({ goal: z.string().min(1) }) }, ({ goal }) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: "任务目标：" + goal + "\n先读zane://guide伞式目录和get_workbench，正文只读与目标相关的节（zane://guide/<节号>）。列出场景并读取发布版输入，准备后解释外部生成和审核节点；仅在用户授权范围内执行。持久保存runId、versionId和素材版本。等待期间不要重复提交，失败先检查步骤/事件，局部重做先预览，完整选片后仅本地合成。" } }] }));
  return server;
}
