import { Router } from "express";
import { runSubmitter } from "../services/accessService.js";
import { TaskService } from "../services/taskService.js";
import { cancelTaskRequest, confirmTaskRequest, createTaskRequest, deleteTaskRequest, rerunTaskItemRequest, taskQuery, updateTaskRequest } from "../domain/taskContracts.js";
import { HttpError } from "../errors.js";
import type * as z from "zod/v4";

function parsed<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_TASK_REQUEST");
  return result.data;
}

/** 任务：批量执行容器。管理端专用；执行复用现有运行服务，不新建调度器。 */
export function createTaskRouter(service: TaskService) {
  const router = Router();
  const access = (response: { locals: Record<string, unknown> }) => {
    const identity = response.locals.identity as { id: string; username: string; displayName: string } | undefined;
    return { ownerUserId: identity?.id, submitter: identity ? runSubmitter(identity) : undefined, authorize: response.locals.authorizeAdmin as () => void };
  };
  router.get("/api/v1/tasks", async (request, response) => {
    const identity = response.locals.identity as { id: string } | undefined;
    response.json(await service.list(parsed(taskQuery, request.query), identity?.id ?? ""));
  });
  router.post("/api/v1/tasks", async (request, response) => {
    const body = parsed(createTaskRequest, request.body);
    response.status(201).json(await service.create(body, access(response)));
  });
  router.get("/api/v1/tasks/:taskId", async (request, response) => {
    response.json(await service.detail(String(request.params.taskId)));
  });
  router.patch("/api/v1/tasks/:taskId", async (request, response) => {
    const body = parsed(updateTaskRequest, { ...(request.body as object), taskId: request.params.taskId });
    response.json(await service.update(String(request.params.taskId), body, access(response)));
  });
  router.post("/api/v1/tasks/:taskId/confirm", async (request, response) => {
    const body = parsed(confirmTaskRequest, { ...(request.body as object), taskId: request.params.taskId });
    response.status(202).json(await service.confirm(String(request.params.taskId), body, access(response)));
  });
  router.post("/api/v1/tasks/:taskId/items/:itemId/rerun", async (request, response) => {
    const body = parsed(rerunTaskItemRequest, { ...(request.body as object), taskId: request.params.taskId, itemId: request.params.itemId });
    response.status(202).json(await service.rerunItem(String(request.params.taskId), body, access(response)));
  });
  router.post("/api/v1/tasks/:taskId/cancel", async (request, response) => {
    const body = parsed(cancelTaskRequest, { ...(request.body as object), taskId: request.params.taskId });
    response.json(await service.cancel(String(request.params.taskId), body, access(response)));
  });
  router.delete("/api/v1/tasks/:taskId", async (request, response) => {
    const body = parsed(deleteTaskRequest, { ...(request.body as object), taskId: request.params.taskId });
    response.json(await service.remove(String(request.params.taskId), body, access(response)));
  });
  return router;
}
