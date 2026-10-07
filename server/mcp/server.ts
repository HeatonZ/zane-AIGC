import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { aiOperations, AI_CONTRACT_VERSION } from "../ai/operations.js";
import { AI_OPERATOR_GUIDE, PUBLIC_USER_OPERATOR_GUIDE } from "../ai/guide.js";
import { createAiOpenApi } from "../ai/openapi.js";
import { WorkbenchHttpClient } from "./httpClient.js";

export function createWorkbenchMcp(client: WorkbenchHttpClient) {
  const server = new McpServer({ name: "zane-workbench", version: AI_CONTRACT_VERSION }, { instructions: "先读取 zane://guide 和 get_workbench，确认后台就绪。配置业务用单场景draft/create/update/validate/publish，不搬整工作区；发布先保存publicationId。使用已发布场景；先get_scene(inputSchema)/prepare_scene，再提交固定versionId及预先保存的UUID runId。wait_run有界摘要，结果按get_run_outputs/get_step_result分页读取；waiting只处理当前reviewId；局部重做先preview_rerun。执行可能付费，必须遵守用户授权范围。写入/提交响应丢失只查同一ID/对象，不自动重放或换ID。素材固定assetId+assetVersion；更新使用当前revision。本MCP不直接访问数据库或重启正式后台。" });
  for (const operation of aiOperations) {
    server.registerTool(operation.name, { title: operation.name, description: (operation.access === "authenticated" ? "当前身份操作。" : "仅管理员。") + operation.description, inputSchema: operation.schema, annotations: { readOnlyHint: operation.effect === "read", destructiveHint: operation.effect !== "read", idempotentHint: operation.effect === "read", openWorldHint: operation.effect === "execute" || operation.name === "save_asset" || operation.name === "update_task_concurrency" } }, async (args, extra) => {
      const result = await client.call(operation, args as Record<string, unknown>, extra.mcpReq.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(!result.ok ? { isError: true } : {}) };
    });
  }
  async function documentation(signal?: AbortSignal) {
    const discovery = await client.call(aiOperations.find(operation => operation.name === "get_workbench")!, {}, signal);
    const data = discovery.data as { security?: { entryMode?: string } } | undefined;
    return { discovery, userOnly: data?.security?.entryMode === "user-only" };
  }
  server.registerResource("operator-guide", "zane://guide", { description: "AI操作手册、状态机、故障恢复与费用边界", mimeType: "text/markdown" }, async (uri, extra) => { const { discovery, userOnly } = await documentation(extra.mcpReq.signal); return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: !discovery.ok ? JSON.stringify(discovery) : userOnly ? PUBLIC_USER_OPERATOR_GUIDE : AI_OPERATOR_GUIDE }] }; });
  server.registerResource("openapi", "zane://openapi", { description: "与工具目录同源的OpenAPI 3.1契约", mimeType: "application/json" }, async (uri, extra) => { const { discovery, userOnly } = await documentation(extra.mcpReq.signal); return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(discovery.ok ? createAiOpenApi({ userOnly }) : discovery) }] }; });
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
  server.registerPrompt("operate-workbench", { description: "将用户目标转为工作台可执行步骤，不擅自付费或绕过审核", argsSchema: z.object({ goal: z.string().min(1) }) }, ({ goal }) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: "任务目标：" + goal + "\n先读zane://guide和get_workbench。列出场景并读取发布版输入，准备后解释外部生成和审核节点；仅在用户授权范围内执行。持久保存runId、versionId和素材版本。等待期间不要重复提交，失败先检查步骤/事件，局部重做先预览，完整选片后仅本地合成。" } }] }));
  return server;
}
