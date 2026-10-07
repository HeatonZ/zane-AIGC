import { Router } from "express";
import { runSubmitter } from "../services/accessService.js";
import { ClipSelectionService } from "../services/clipSelectionService.js";
export function createClipSelectionRouter(service: ClipSelectionService) {
  const router = Router();
  router.get("/api/v1/clip-selections",async(req,res) => { const { projectDirectory } = await service.assets.loadSettings(); res.json({ selections: await service.list(projectDirectory,typeof req.query.runId === "string" ? req.query.runId : undefined) }); });
  router.post("/api/v1/clip-selections",async(req,res) => res.status(201).json({ selection:await service.create(req.body) }));
  router.get("/api/v1/clip-selections/:id",async(req,res) => { const { projectDirectory } = await service.assets.loadSettings(); res.json({ selection:service.get(projectDirectory,req.params.id) }); });
  router.get("/api/v1/clip-selections/:id/candidates",async(req,res) => { const { projectDirectory } = await service.assets.loadSettings(); res.json({ shots:await service.candidates(projectDirectory,service.get(projectDirectory,req.params.id)) }); });
  router.patch("/api/v1/clip-selections/:id",async(req,res) => res.json({ selection:await service.update(req.params.id,req.body) }));
  router.post("/api/v1/clip-selections/:id/compose",async(req,res) => { const identity = res.locals.identity; return res.status(202).json(await service.compose(req.params.id,req.body,identity ? { ownerUserId: identity.id, submitter: runSubmitter(identity), authorize: res.locals.authorizeAdmin } : undefined)); });
  return router;
}
